-- Gate 008A migration 008: transactional scan outbox for an Azure-native worker.
-- DRAFT ONLY: do not apply to shared/cloud databases without founder approval.
-- Requires 001-007 and a separately provisioned cbc_worker role:
-- LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS.
-- The web role cbc_app must NOT inherit cbc_worker. Never put worker
-- credentials or managed identity permissions in the web application's config.
BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'cbc_worker'
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls
      AND NOT rolinherit
  ) OR pg_catalog.pg_has_role('cbc_app', 'cbc_worker', 'MEMBER') THEN
    RAISE EXCEPTION '008: isolated least-privilege cbc_worker role required';
  END IF;
END;
$guard$;

CREATE TABLE public.scan_job_outbox (
  scan_id uuid PRIMARY KEY REFERENCES public.scans(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'leased', 'done')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  lease_token uuid,
  leased_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT scan_job_lease_consistency CHECK (
    (state = 'leased' AND lease_token IS NOT NULL AND leased_until IS NOT NULL AND completed_at IS NULL)
    OR (state = 'ready' AND lease_token IS NULL AND leased_until IS NULL AND completed_at IS NULL)
    OR (state = 'done' AND lease_token IS NULL AND leased_until IS NULL AND completed_at IS NOT NULL)
  )
);
CREATE INDEX scan_job_claim_idx ON public.scan_job_outbox (state, created_at, scan_id)
  WHERE attempt_count < 8;
-- Keep terminal recovery bounded even with a large backlog of expired leases.
CREATE INDEX scan_job_exhausted_idx ON public.scan_job_outbox (leased_until, scan_id)
  WHERE state = 'leased' AND attempt_count = 8;
ALTER TABLE public.scan_job_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.scan_job_outbox FROM PUBLIC, cbc_app, cbc_worker;
-- Zero RLS policies; only the narrowly granted SECURITY DEFINER functions
-- below can read/change jobs. Neither runtime role owns the table.

-- AFTER INSERT runs in the scan-creation transaction, so there is no window
-- where a scan commits but its work item is missing. No external queue send.
CREATE FUNCTION public.app_enqueue_scan_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.status <> 'pending' OR NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'scan outbox requires pending tenant-bound scan' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.scan_job_outbox (scan_id, organization_id)
  VALUES (NEW.id, NEW.organization_id);
  RETURN NEW;
END;
$function$;
CREATE TRIGGER scan_enqueue_job AFTER INSERT ON public.scans
  FOR EACH ROW EXECUTE FUNCTION public.app_enqueue_scan_job();

-- Existing pending scans (if any) become visible to the worker on migration.
-- Do not enqueue terminal scans or overwrite a previously claimed job.
INSERT INTO public.scan_job_outbox (scan_id, organization_id)
SELECT s.id, s.organization_id FROM public.scans s WHERE s.status = 'pending'
ON CONFLICT (scan_id) DO NOTHING;

-- At-least-once delivery: a lease expiry permits redelivery. A worker must
-- be idempotent and use a separate lease-bound completion transaction before
-- acknowledging. Max eight claims prevents an unbounded retry storm; exhausted
-- jobs require explicit operator review, never silent deletion.
CREATE FUNCTION public.app_claim_scan_jobs(p_limit integer DEFAULT 1, p_lease_seconds integer DEFAULT 120)
RETURNS TABLE (
  o_scan_id uuid, o_organization_id uuid, o_input_type text, o_raw_input text,
  o_lease_token uuid, o_attempt_count integer, o_leased_until timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 OR
     p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'invalid worker lease request' USING ERRCODE = '22023';
  END IF;
  -- An exhausted, expired lease must not leave a customer-facing scan
  -- "pending" forever. Reconcile at most ten abandoned jobs per invocation,
  -- even when there is no new work to claim. The worker role cannot directly
  -- mutate either table; this remains inside the restricted definer function.
  -- Never classify a provider failure as safe or fabricate threat evidence.
  WITH exhausted AS (
    SELECT j.scan_id, j.organization_id
      FROM public.scan_job_outbox j
      JOIN public.scans s ON s.id = j.scan_id AND s.organization_id = j.organization_id
     WHERE j.state = 'leased' AND j.attempt_count = 8
       AND j.leased_until <= pg_catalog.clock_timestamp()
       AND s.status = 'pending'
     ORDER BY j.leased_until, j.scan_id
     FOR UPDATE OF j SKIP LOCKED
     LIMIT 10
  ), failed_scans AS (
    UPDATE public.scans s
       SET status = 'failed', verdict = 'unknown',
           risk_score = NULL, confidence_score = NULL,
           ai_explanation = 'The reputation check could not finish after repeated attempts.',
           recommended_action = 'Do not assume this URL is safe. Try again later or verify independently.',
           completed_at = pg_catalog.clock_timestamp()
      FROM exhausted e
     WHERE s.id = e.scan_id AND s.organization_id = e.organization_id
       AND s.status = 'pending'
    RETURNING s.id
  )
  UPDATE public.scan_job_outbox j
     SET state = 'done', lease_token = NULL, leased_until = NULL,
         completed_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
    FROM failed_scans f
   WHERE j.scan_id = f.id;

  RETURN QUERY
  WITH candidates AS (
    SELECT j.scan_id
    FROM public.scan_job_outbox j
    JOIN public.scans s ON s.id = j.scan_id AND s.organization_id = j.organization_id
    WHERE (j.state = 'ready' OR
          (j.state = 'leased' AND j.leased_until <= pg_catalog.clock_timestamp()))
      AND j.attempt_count < 8 AND s.status = 'pending'
    ORDER BY j.created_at, j.scan_id
    FOR UPDATE OF j SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public.scan_job_outbox j
       SET state = 'leased', lease_token = pg_catalog.gen_random_uuid(),
           leased_until = pg_catalog.clock_timestamp() +
             pg_catalog.make_interval(secs => p_lease_seconds),
           attempt_count = j.attempt_count + 1,
           updated_at = pg_catalog.clock_timestamp()
      FROM candidates c WHERE j.scan_id = c.scan_id
    RETURNING j.scan_id, j.organization_id, j.lease_token, j.attempt_count, j.leased_until
  )
  SELECT c.scan_id, c.organization_id, s.input_type, s.raw_input,
         c.lease_token, c.attempt_count, c.leased_until
  FROM claimed c
  JOIN public.scans s ON s.id = c.scan_id AND s.organization_id = c.organization_id;
END;
$function$;

-- Acknowledgment cannot change scan/evidence contents. It only closes an
-- active lease AFTER the scan is terminal. A stale/replayed token returns
-- false; no other tenant/job ID can be used to acknowledge the lease.
CREATE FUNCTION public.app_ack_scan_job(p_scan_id uuid, p_lease_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_scan_id IS NULL OR p_lease_token IS NULL THEN RETURN false; END IF;
  UPDATE public.scan_job_outbox j
     SET state = 'done', lease_token = NULL, leased_until = NULL,
         updated_at = pg_catalog.clock_timestamp(),
         completed_at = pg_catalog.clock_timestamp()
   WHERE j.scan_id = p_scan_id AND j.lease_token = p_lease_token
     AND j.state = 'leased' AND j.leased_until > pg_catalog.clock_timestamp()
     AND EXISTS (
       SELECT 1 FROM public.scans s
       WHERE s.id = j.scan_id AND s.organization_id = j.organization_id
         AND s.status IN ('complete', 'failed')
     );
  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.app_enqueue_scan_job() FROM PUBLIC, cbc_app, cbc_worker;
REVOKE ALL ON FUNCTION public.app_claim_scan_jobs(integer, integer) FROM PUBLIC, cbc_app;
REVOKE ALL ON FUNCTION public.app_ack_scan_job(uuid, uuid) FROM PUBLIC, cbc_app;
GRANT USAGE ON SCHEMA public TO cbc_worker;
GRANT EXECUTE ON FUNCTION public.app_claim_scan_jobs(integer, integer) TO cbc_worker;
GRANT EXECUTE ON FUNCTION public.app_ack_scan_job(uuid, uuid) TO cbc_worker;
COMMIT;
