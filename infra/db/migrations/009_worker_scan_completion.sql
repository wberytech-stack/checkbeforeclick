-- Gate 008A / 009: atomic, lease-bound worker completion. DRAFT: founder approval
-- required before applying to any persistent database. Requires migrations 001-008.
-- A worker can only write results for a scan it currently leases; it cannot
-- choose a tenant or use browser-supplied session context to authorize writes.
BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'cbc_worker' AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolbypassrls AND NOT rolinherit
  ) OR pg_catalog.pg_has_role('cbc_app', 'cbc_worker', 'MEMBER') THEN
    RAISE EXCEPTION '009: isolated least-privilege cbc_worker required';
  END IF;
END;
$guard$;

CREATE FUNCTION public.app_complete_scan_job(
  p_scan_id uuid, p_lease_token uuid, p_status text, p_verdict text,
  p_risk_score integer, p_confidence_score integer, p_ai_explanation text,
  p_recommended_action text, p_scan_duration_ms integer,
  p_vendor_results jsonb, p_evidence_items jsonb
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_org uuid;
  v_scan_status text;
  v_item jsonb;
  v_key text;
  v_int integer;
BEGIN
  -- Lock the job first (same lock ordering as the claim function). A stale,
  -- expired or foreign token is indistinguishable from a missing job.
  IF p_scan_id IS NULL OR p_lease_token IS NULL THEN RETURN false; END IF;
  SELECT j.organization_id INTO v_org
    FROM public.scan_job_outbox j
   WHERE j.scan_id = p_scan_id AND j.lease_token = p_lease_token
     AND j.state = 'leased' AND j.leased_until > pg_catalog.clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  -- Recheck the lease after waiting for a concurrent transaction's lock.
  IF NOT EXISTS (
    SELECT 1 FROM public.scan_job_outbox j
    WHERE j.scan_id = p_scan_id AND j.lease_token = p_lease_token
      AND j.state = 'leased' AND j.leased_until > pg_catalog.clock_timestamp()
  ) THEN RETURN false; END IF;

  SELECT s.status INTO v_scan_status FROM public.scans s
   WHERE s.id = p_scan_id AND s.organization_id = v_org FOR UPDATE;
  IF NOT FOUND OR v_scan_status NOT IN ('pending', 'processing') THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.scan_job_outbox j
    WHERE j.scan_id = p_scan_id AND j.lease_token = p_lease_token
      AND j.state = 'leased' AND j.leased_until > pg_catalog.clock_timestamp()
  ) THEN RETURN false; END IF;

  IF p_status IS NULL OR p_status NOT IN ('complete', 'failed') OR
     (p_verdict IS NOT NULL AND p_verdict NOT IN ('safe', 'suspicious', 'dangerous', 'unknown')) OR
     (p_risk_score IS NOT NULL AND p_risk_score NOT BETWEEN 0 AND 100) OR
     (p_confidence_score IS NOT NULL AND p_confidence_score NOT BETWEEN 0 AND 100) OR
     (p_scan_duration_ms IS NOT NULL AND p_scan_duration_ms NOT BETWEEN 0 AND 3600000) OR
     pg_catalog.length(COALESCE(p_ai_explanation, '')) > 20000 OR
     pg_catalog.length(COALESCE(p_recommended_action, '')) > 20000 THEN
    RAISE EXCEPTION 'invalid scan completion payload' USING ERRCODE = '22023';
  END IF;
  IF p_vendor_results IS NULL OR p_evidence_items IS NULL OR
     pg_catalog.jsonb_typeof(p_vendor_results) <> 'array' OR
     pg_catalog.jsonb_typeof(p_evidence_items) <> 'array' OR
     pg_catalog.jsonb_array_length(p_vendor_results) > 100 OR
     pg_catalog.jsonb_array_length(p_evidence_items) > 100 OR
     pg_catalog.octet_length(p_vendor_results::text) > 262144 OR
     pg_catalog.octet_length(p_evidence_items::text) > 262144 THEN
    RAISE EXCEPTION 'invalid scan completion arrays' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'complete' AND
     pg_catalog.jsonb_array_length(p_vendor_results) = 0 AND
     pg_catalog.jsonb_array_length(p_evidence_items) = 0 THEN
    RAISE EXCEPTION 'complete scan requires findings' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT x.item FROM pg_catalog.jsonb_array_elements(p_vendor_results) AS x(item) LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object' OR
       pg_catalog.jsonb_typeof(v_item -> 'vendor_name') IS DISTINCT FROM 'string' OR
       pg_catalog.length(pg_catalog.btrim(v_item ->> 'vendor_name')) NOT BETWEEN 1 AND 128 OR
       (v_item ? 'verdict' AND pg_catalog.jsonb_typeof(v_item -> 'verdict') NOT IN ('string', 'null')) OR
       pg_catalog.length(COALESCE(v_item ->> 'verdict', '')) > 32 OR
       (v_item ? 'error_message' AND pg_catalog.jsonb_typeof(v_item -> 'error_message') NOT IN ('string', 'null')) OR
       pg_catalog.length(COALESCE(v_item ->> 'error_message', '')) > 2048 OR
       pg_catalog.octet_length(COALESCE((v_item -> 'raw_response')::text, '')) > 65536 THEN
      RAISE EXCEPTION 'invalid provider result' USING ERRCODE = '22023';
    END IF;
    FOR v_key IN SELECT pg_catalog.jsonb_object_keys(v_item) LOOP
      IF v_key NOT IN ('vendor_name','verdict','raw_response','error_message','response_time_ms') THEN
        RAISE EXCEPTION 'unexpected provider field' USING ERRCODE = '22023';
      END IF;
    END LOOP;
    IF v_item ? 'response_time_ms' AND pg_catalog.jsonb_typeof(v_item -> 'response_time_ms') <> 'null' THEN
      IF pg_catalog.jsonb_typeof(v_item -> 'response_time_ms') <> 'number' OR
         (v_item ->> 'response_time_ms') !~ '^[0-9]{1,7}$' THEN
        RAISE EXCEPTION 'invalid provider duration' USING ERRCODE = '22023';
      END IF;
      v_int := (v_item ->> 'response_time_ms')::integer;
      IF v_int > 3600000 THEN RAISE EXCEPTION 'invalid provider duration' USING ERRCODE = '22023'; END IF;
    END IF;
  END LOOP;

  FOR v_item IN SELECT x.item FROM pg_catalog.jsonb_array_elements(p_evidence_items) AS x(item) LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object' OR
       pg_catalog.jsonb_typeof(v_item -> 'signal_type') IS DISTINCT FROM 'string' OR
       pg_catalog.length(pg_catalog.btrim(v_item ->> 'signal_type')) NOT BETWEEN 1 AND 128 OR
       pg_catalog.jsonb_typeof(v_item -> 'title') IS DISTINCT FROM 'string' OR
       pg_catalog.length(pg_catalog.btrim(v_item ->> 'title')) NOT BETWEEN 1 AND 300 OR
       pg_catalog.jsonb_typeof(v_item -> 'severity') IS DISTINCT FROM 'string' OR
       (v_item ->> 'severity') NOT IN ('critical','high','medium','low','info','good') OR
       (v_item ? 'detail' AND pg_catalog.jsonb_typeof(v_item -> 'detail') NOT IN ('string','null')) OR
       pg_catalog.length(COALESCE(v_item ->> 'detail', '')) > 4000 THEN
      RAISE EXCEPTION 'invalid evidence item' USING ERRCODE = '22023';
    END IF;
    FOR v_key IN SELECT pg_catalog.jsonb_object_keys(v_item) LOOP
      IF v_key NOT IN ('signal_type','severity','title','detail','score_impact') THEN
        RAISE EXCEPTION 'unexpected evidence field' USING ERRCODE = '22023';
      END IF;
    END LOOP;
    IF v_item ? 'score_impact' AND pg_catalog.jsonb_typeof(v_item -> 'score_impact') <> 'null' THEN
      IF pg_catalog.jsonb_typeof(v_item -> 'score_impact') <> 'number' OR
         (v_item ->> 'score_impact') !~ '^[-]?[0-9]{1,3}$' THEN
        RAISE EXCEPTION 'invalid evidence impact' USING ERRCODE = '22023';
      END IF;
      v_int := (v_item ->> 'score_impact')::integer;
      IF v_int NOT BETWEEN -100 AND 100 THEN
        RAISE EXCEPTION 'invalid evidence impact' USING ERRCODE = '22023';
      END IF;
    END IF;
  END LOOP;

  -- One transaction and one tenant derived solely from the locked outbox row.
  UPDATE public.scans s SET
    status = p_status, verdict = p_verdict, risk_score = p_risk_score,
    confidence_score = p_confidence_score, ai_explanation = p_ai_explanation,
    recommended_action = p_recommended_action,
    scan_duration_ms = p_scan_duration_ms, completed_at = pg_catalog.clock_timestamp()
  WHERE s.id = p_scan_id AND s.organization_id = v_org;

  INSERT INTO public.vendor_results
    (scan_id, organization_id, vendor_name, verdict, raw_response, error_message, response_time_ms)
  SELECT p_scan_id, v_org, item ->> 'vendor_name', item ->> 'verdict',
         CASE WHEN item -> 'raw_response' = 'null'::jsonb THEN NULL ELSE item -> 'raw_response' END,
         item ->> 'error_message', (item ->> 'response_time_ms')::integer
    FROM pg_catalog.jsonb_array_elements(p_vendor_results) AS x(item);
  INSERT INTO public.evidence_items
    (scan_id, organization_id, signal_type, severity, title, detail, score_impact)
  SELECT p_scan_id, v_org, item ->> 'signal_type', item ->> 'severity',
         item ->> 'title', item ->> 'detail',
         COALESCE((item ->> 'score_impact')::integer, 0)
    FROM pg_catalog.jsonb_array_elements(p_evidence_items) AS x(item);

  UPDATE public.scan_job_outbox j SET
    state = 'done', lease_token = NULL, leased_until = NULL,
    completed_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
  WHERE j.scan_id = p_scan_id AND j.organization_id = v_org
    AND j.state = 'leased' AND j.lease_token = p_lease_token
    AND j.leased_until > pg_catalog.clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scan lease expired during completion' USING ERRCODE = '55000';
  END IF;
  RETURN true;
END;
$function$;

-- Explicitly retire browser-triggered result mutation and the separate ACK
-- (which could previously acknowledge an owner-written terminal result).
REVOKE ALL ON FUNCTION public.app_complete_scan_job(
  uuid,uuid,text,text,integer,integer,text,text,integer,jsonb,jsonb
) FROM PUBLIC, cbc_app, cbc_worker;
GRANT EXECUTE ON FUNCTION public.app_complete_scan_job(
  uuid,uuid,text,text,integer,integer,text,text,integer,jsonb,jsonb
) TO cbc_worker;
REVOKE EXECUTE ON FUNCTION public.app_record_fast_scan_result(
  uuid,text,text,integer,integer,text,text,integer,jsonb,jsonb,text
) FROM PUBLIC, cbc_app, cbc_worker;
REVOKE EXECUTE ON FUNCTION public.app_mark_scan_processing(uuid)
  FROM PUBLIC, cbc_app, cbc_worker;
REVOKE EXECUTE ON FUNCTION public.app_ack_scan_job(uuid,uuid)
  FROM PUBLIC, cbc_app, cbc_worker;
DO $legacy$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='cbc_app_validation') THEN
    REVOKE EXECUTE ON FUNCTION public.app_record_fast_scan_result(
      uuid,text,text,integer,integer,text,text,integer,jsonb,jsonb,text
    ) FROM cbc_app_validation;
  END IF;
END;
$legacy$;
COMMIT;
