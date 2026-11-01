-- Gate 007A - atomic, shared scan admission (Supabase Postgres).
--
-- DRAFT MIGRATION. Target: the Supabase projects (staging zgxmvpbvvakpsnzcymsf, production qnjqwmcsfpmpnvlnomat),
-- NOT the Azure cbc_prod database (infra/db/migrations). Applying it to any real database is founder-only
-- (AGENTS.md sections 6.3 and 9); it has been validated only on a disposable local Postgres.
--
-- Why: counting existing scan rows is not a hard cap under concurrency, and the app's data layer uses the legacy
-- service-role key (AGENTS.md section 12). Both functions below are called by the signed-in user's own session
-- (role "authenticated"); they derive identity server-side, serialize with transaction-scoped advisory locks,
-- and enforce their caps against their own ledgers.
--
-- Part 1 - scan admission (rolling 24 hours; founder-approved 2026-10-22):
--   global admissions 500, per organization 200, per user 50.
--   scan_admissions.provider_calls_reserved is informational only (worst-case estimate); it is NOT the provider
--   budget (Codex cycle 3 P2: admission-time reservations can age out before a delayed call executes).
-- Part 2 - Web Risk provider budget, counted at EXECUTION time (founder-approved 2026-10-22):
--   at most 1000 google_web_risk reservations per rolling 24 hours, one per admission, only for the caller's own
--   admission and only within 10 minutes of it. The application reserves immediately before the one request it
--   makes, inside the signed-in scan request; the background worker never calls paid providers.
-- The per-user 5/minute burst limit and the login limits live in the application (lib/security/rateLimit.ts).

CREATE TABLE IF NOT EXISTS public.scan_admissions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    input_type text NOT NULL,
    provider_calls_reserved smallint NOT NULL,
    admitted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scan_admissions_provider_calls_check CHECK (provider_calls_reserved BETWEEN 0 AND 2)
);

CREATE INDEX IF NOT EXISTS scan_admissions_admitted_at_idx ON public.scan_admissions (admitted_at);
CREATE INDEX IF NOT EXISTS scan_admissions_user_admitted_idx ON public.scan_admissions (user_id, admitted_at);
CREATE INDEX IF NOT EXISTS scan_admissions_org_admitted_idx ON public.scan_admissions (organization_id, admitted_at);

-- The ledger is reachable only through the function below: RLS on, no policies, no direct grants
-- (not even to service_role, so the legacy service-role client cannot read or alter it either).
ALTER TABLE public.scan_admissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.scan_admissions FROM PUBLIC;
REVOKE ALL ON TABLE public.scan_admissions FROM anon, authenticated, service_role;   -- Supabase default grants; the function runs as its owner

CREATE OR REPLACE FUNCTION public.cbc_admit_scan(p_input_type text)
RETURNS TABLE (
    admitted boolean,
    reason text,
    retry_after_seconds integer,
    provider_calls_reserved smallint,
    admission_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    c_global_limit constant integer := 500;
    c_org_limit    constant integer := 200;
    c_user_limit   constant integer := 50;
    v_user  uuid := auth.uid();
    v_org   uuid;
    v_calls smallint;
    v_since timestamptz := now() - interval '24 hours';
    n_user   integer;
    n_org    integer;
    n_global integer;
    v_oldest timestamptz;
    v_id     bigint;
BEGIN
    IF v_user IS NULL THEN
        RETURN QUERY SELECT false, 'unauthenticated'::text, 0, 0::smallint, NULL::bigint;
        RETURN;
    END IF;

    IF p_input_type IN ('url', 'domain') THEN
        v_calls := 1;
    ELSIF p_input_type IN ('email', 'header', 'signature', 'batch') THEN
        v_calls := 2;
    ELSE
        RETURN QUERY SELECT false, 'invalid_input_type'::text, 0, 0::smallint, NULL::bigint;
        RETURN;
    END IF;

    SELECT u.organization_id INTO v_org FROM public.users u WHERE u.id = v_user;
    IF v_org IS NULL THEN
        RETURN QUERY SELECT false, 'no_organization'::text, 0, 0::smallint, NULL::bigint;
        RETURN;
    END IF;

    -- One admission at a time, across every app instance; released at transaction end.
    PERFORM pg_advisory_xact_lock(hashtext('cbc_scan_admission'));

    SELECT count(*) FILTER (WHERE a.user_id = v_user),
           count(*) FILTER (WHERE a.organization_id = v_org),
           count(*)
      INTO n_user, n_org, n_global
      FROM public.scan_admissions a
     WHERE a.admitted_at > v_since;

    IF n_global >= c_global_limit THEN
        SELECT min(a.admitted_at) INTO v_oldest FROM public.scan_admissions a WHERE a.admitted_at > v_since;
        RETURN QUERY SELECT false, 'global_scan_capacity_reached'::text,
            GREATEST(1, ceil(extract(epoch FROM (v_oldest + interval '24 hours' - now())))::integer), 0::smallint, NULL::bigint;
        RETURN;
    END IF;
    IF n_org >= c_org_limit THEN
        SELECT min(a.admitted_at) INTO v_oldest FROM public.scan_admissions a WHERE a.admitted_at > v_since AND a.organization_id = v_org;
        RETURN QUERY SELECT false, 'organization_daily_limit'::text,
            GREATEST(1, ceil(extract(epoch FROM (v_oldest + interval '24 hours' - now())))::integer), 0::smallint, NULL::bigint;
        RETURN;
    END IF;
    IF n_user >= c_user_limit THEN
        SELECT min(a.admitted_at) INTO v_oldest FROM public.scan_admissions a WHERE a.admitted_at > v_since AND a.user_id = v_user;
        RETURN QUERY SELECT false, 'user_daily_limit'::text,
            GREATEST(1, ceil(extract(epoch FROM (v_oldest + interval '24 hours' - now())))::integer), 0::smallint, NULL::bigint;
        RETURN;
    END IF;

    INSERT INTO public.scan_admissions (user_id, organization_id, input_type, provider_calls_reserved)
    VALUES (v_user, v_org, p_input_type, v_calls)
    RETURNING id INTO v_id;

    -- Keep the ledger small: rows older than 48 hours no longer affect any window.
    DELETE FROM public.scan_admissions a WHERE a.admitted_at < now() - interval '48 hours';

    RETURN QUERY SELECT true, 'admitted'::text, 0, v_calls, v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cbc_admit_scan(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cbc_admit_scan(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.cbc_admit_scan(text) TO authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- Part 2 - execution-time Web Risk provider budget (Codex cycle 3 P2 fix)
-- ---------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.provider_call_reservations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider text NOT NULL,
    admission_id bigint NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    reserved_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_call_reservations_provider_check CHECK (provider = 'google_web_risk'),
    CONSTRAINT provider_call_reservations_one_per_admission UNIQUE (provider, admission_id)
);

CREATE INDEX IF NOT EXISTS provider_call_reservations_provider_time_idx ON public.provider_call_reservations (provider, reserved_at);

-- Reachable only through cbc_reserve_provider_call: RLS on, no policies, no direct grants (not even service_role).
ALTER TABLE public.provider_call_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_call_reservations FROM PUBLIC;
REVOKE ALL ON TABLE public.provider_call_reservations FROM anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cbc_reserve_provider_call(p_provider text, p_admission_id bigint)
RETURNS TABLE (
    granted boolean,
    reason text,
    retry_after_seconds integer,
    reservation_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    c_daily_budget      constant integer := 1000;
    c_admission_max_age constant interval := interval '10 minutes';
    v_user   uuid := auth.uid();
    v_org    uuid;
    v_since  timestamptz := now() - interval '24 hours';
    n_used   integer;
    v_oldest timestamptz;
    v_id     bigint;
BEGIN
    IF v_user IS NULL THEN
        RETURN QUERY SELECT false, 'unauthenticated'::text, 0, NULL::bigint;
        RETURN;
    END IF;
    IF p_provider IS DISTINCT FROM 'google_web_risk' THEN
        RETURN QUERY SELECT false, 'unknown_provider'::text, 0, NULL::bigint;
        RETURN;
    END IF;

    -- The admission must exist, belong to the caller, and be recent: an old or foreign admission cannot fund a call.
    SELECT a.organization_id INTO v_org
      FROM public.scan_admissions a
     WHERE a.id = p_admission_id AND a.user_id = v_user AND a.admitted_at > now() - c_admission_max_age;
    IF v_org IS NULL THEN
        RETURN QUERY SELECT false, 'admission_not_valid'::text, 0, NULL::bigint;
        RETURN;
    END IF;

    -- One reservation at a time per provider, across every app instance; released at transaction end.
    PERFORM pg_advisory_xact_lock(hashtext('cbc_provider_budget:google_web_risk'));

    IF EXISTS (SELECT 1 FROM public.provider_call_reservations r WHERE r.provider = p_provider AND r.admission_id = p_admission_id) THEN
        RETURN QUERY SELECT false, 'already_reserved'::text, 0, NULL::bigint;
        RETURN;
    END IF;

    SELECT count(*) INTO n_used FROM public.provider_call_reservations r WHERE r.provider = p_provider AND r.reserved_at > v_since;
    IF n_used >= c_daily_budget THEN
        SELECT min(r.reserved_at) INTO v_oldest FROM public.provider_call_reservations r WHERE r.provider = p_provider AND r.reserved_at > v_since;
        RETURN QUERY SELECT false, 'provider_budget_exhausted'::text,
            GREATEST(1, ceil(extract(epoch FROM (v_oldest + interval '24 hours' - now())))::integer), NULL::bigint;
        RETURN;
    END IF;

    INSERT INTO public.provider_call_reservations (provider, admission_id, user_id, organization_id)
    VALUES (p_provider, p_admission_id, v_user, v_org)
    RETURNING id INTO v_id;

    DELETE FROM public.provider_call_reservations r WHERE r.reserved_at < now() - interval '48 hours';

    RETURN QUERY SELECT true, 'granted'::text, 0, v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cbc_reserve_provider_call(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cbc_reserve_provider_call(text, bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.cbc_reserve_provider_call(text, bigint) TO authenticated;
