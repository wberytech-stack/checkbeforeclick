-- ============================================================================
-- 006_oidc_login_state.sql — Gate 008A/008B Azure OIDC one-time login state.
--
-- DRAFT: apply only to a disposable PostgreSQL database during validation.
-- Requires 001-005 and the least-privileged cbc_app role. This is a global,
-- opaque pre-authentication replay ledger, NOT a tenant data table. No user
-- identities, cookies, code verifiers, provider tokens or secrets are stored.
-- ============================================================================
BEGIN;

DO $guard$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname = 'cbc_app'
          AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls
    ) THEN
        RAISE EXCEPTION '006: cbc_app must exist without admin or BYPASSRLS privileges';
    END IF;
END;
$guard$;

CREATE TABLE public.oidc_login_states (
    state_digest text PRIMARY KEY
        CONSTRAINT oidc_login_states_digest_format CHECK (state_digest ~ '^[0-9a-f]{64}$'),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE INDEX oidc_login_states_expiry_idx ON public.oidc_login_states (expires_at);
ALTER TABLE public.oidc_login_states ENABLE ROW LEVEL SECURITY;
-- No RLS policies: the runtime cannot directly inspect or mutate this table.
REVOKE ALL ON TABLE public.oidc_login_states FROM PUBLIC, cbc_app;

-- Reserve a 256-bit random-state SHA-256 digest once. Expiry is checked against
-- the DATABASE clock (not a browser-provided timestamp), with <=60s clock-skew
-- tolerance on the five-minute application TTL. The unique key makes concurrent
-- reservations race-safe. Cleanup is bounded, lock-skipping and opportunistic;
-- it requires no extra queue, cron job or paid service.
CREATE FUNCTION public.app_reserve_oidc_login_state(
    p_digest text, p_expires_at_seconds bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_epoch bigint;
    v_inserted boolean;
BEGIN
    IF p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'invalid login-state digest' USING ERRCODE = '22023';
    END IF;
    v_epoch := pg_catalog.floor(EXTRACT(EPOCH FROM v_now))::bigint;
    IF p_expires_at_seconds IS NULL OR p_expires_at_seconds <= v_epoch
       OR p_expires_at_seconds > v_epoch + 360 THEN
        RAISE EXCEPTION 'invalid login-state expiry' USING ERRCODE = '22023';
    END IF;

    WITH expired AS (
        SELECT state_digest
        FROM public.oidc_login_states
        WHERE expires_at <= v_now
        ORDER BY expires_at
        LIMIT 128
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.oidc_login_states s
    USING expired e
    WHERE s.state_digest = e.state_digest;

    INSERT INTO public.oidc_login_states (state_digest, expires_at)
    VALUES (p_digest, pg_catalog.to_timestamp(p_expires_at_seconds))
    ON CONFLICT (state_digest) DO NOTHING
    RETURNING true INTO v_inserted;
    RETURN COALESCE(v_inserted, false);
END;
$function$;

-- One atomic DELETE is the only successful redemption. A concurrent callback
-- cannot consume the same digest twice. The DB clock, not caller-supplied time,
-- decides expiry. Expired rows remain unavailable even before lazy cleanup.
CREATE FUNCTION public.app_consume_oidc_login_state(p_digest text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_consumed boolean;
BEGIN
    IF p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'invalid login-state digest' USING ERRCODE = '22023';
    END IF;
    DELETE FROM public.oidc_login_states
    WHERE state_digest = p_digest AND expires_at > pg_catalog.clock_timestamp()
    RETURNING true INTO v_consumed;
    RETURN COALESCE(v_consumed, false);
END;
$function$;

REVOKE ALL ON FUNCTION public.app_reserve_oidc_login_state(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_consume_oidc_login_state(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_reserve_oidc_login_state(text, bigint) TO cbc_app;
GRANT EXECUTE ON FUNCTION public.app_consume_oidc_login_state(text) TO cbc_app;

COMMIT;
