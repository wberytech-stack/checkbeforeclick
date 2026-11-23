-- ============================================================================
-- 005_identity_and_scan_integrity.sql
-- Gate 008A - Azure data plane: external identity binding and scan/evidence
-- integrity for a fresh Azure PostgreSQL deployment (no Supabase users are
-- migrated; founder directive 2026-11-01).
--
-- DRAFT. Validated only on a disposable loopback PostgreSQL 16 cluster
-- (scripts/azure-data/validate-data-plane-db.ts). Applying it to any real
-- database is a separate founder approval (AGENTS.md section 9).
--
-- Prerequisites: 001-004 applied; role cbc_app exists
--   (LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS) before 002 so 002's
--   conditional grants ran. Run as the schema owner (never as cbc_app).
--
-- WHAT THIS DOES
-- 1. trusted_identity_issuers: allow-list of OIDC issuers (Microsoft Entra
--    External ID tenant issuer). Not readable or writable by cbc_app; rows are
--    inserted by the operator. A misconfigured or compromised token validator
--    still cannot introduce a new issuer.
-- 2. user_identities: binds (issuer, subject) of a VERIFIED ID token to one CBC
--    user. Accounts are linked ONLY by (issuer, subject), never by email.
-- 3. app_sign_in(): SECURITY DEFINER find-or-provision. A first sign-in creates
--    user + personal organization + owner membership + identity + audit row in
--    one transaction. Requires an EMPTY tenant context; organization_id is never
--    an argument (AGENTS.md section 10).
-- 4. Scan lifecycle only through definer functions: app_create_scan(),
--    app_mark_scan_processing() and (from 004) app_record_fast_scan_result().
--    cbc_app loses direct INSERT/UPDATE/DELETE on scans, vendor_results,
--    evidence_items, audit_log and organizations, and keeps SELECT under RLS.
-- 5. Integrity triggers that bind every role, including the owner:
--    - scans: identity columns immutable; terminal scans (complete/failed)
--      immutable; only forward status transitions.
--    - vendor_results, evidence_items: never updated.
--    - audit_log: append-only (updates/deletes only as FK cascades).
-- 6. EXECUTE on every definer function revoked from PUBLIC (PostgreSQL grants
--    EXECUTE to PUBLIC by default; 002 did not revoke it). bootstrap_new_
--    organization() is superseded by app_sign_in() and no longer granted.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Trusted issuers (operator-managed allow-list)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trusted_identity_issuers (
    issuer      text PRIMARY KEY,
    description text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT trusted_identity_issuers_https CHECK (
        length(issuer) <= 512 AND issuer ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~%/-]*)?$'
    )
);
ALTER TABLE public.trusted_identity_issuers ENABLE ROW LEVEL SECURITY;
-- No policy and no grant: cbc_app can neither read nor change the allow-list.

-- ----------------------------------------------------------------------------
-- 2. External identities
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_identities (
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL,
    issuer          text NOT NULL,
    subject         text NOT NULL,
    email           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_sign_in_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_identities_pkey PRIMARY KEY (id),
    CONSTRAINT user_identities_user_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
    CONSTRAINT user_identities_issuer_fkey FOREIGN KEY (issuer) REFERENCES public.trusted_identity_issuers(issuer) ON DELETE RESTRICT,
    CONSTRAINT user_identities_issuer_subject_key UNIQUE (issuer, subject),
    CONSTRAINT user_identities_subject_len CHECK (length(subject) BETWEEN 1 AND 255),
    CONSTRAINT user_identities_email_len CHECK (email IS NULL OR length(email) <= 320)
);
CREATE INDEX IF NOT EXISTS user_identities_user_id_idx ON public.user_identities (user_id);

ALTER TABLE public.user_identities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_identities_self_select ON public.user_identities;
CREATE POLICY user_identities_self_select ON public.user_identities
    FOR SELECT
    USING (user_id = public.app_current_user_id());

-- ----------------------------------------------------------------------------
-- 3. Sign-in: find or provision. Called only after the application verified
--    the ID token (signature, issuer, audience, expiry, nonce).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_sign_in(
    p_issuer       text,
    p_subject      text,
    p_email        text,
    p_display_name text
)
RETURNS TABLE (o_user_id uuid, o_organization_id uuid, o_role text, o_created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
    v_user  uuid;
    v_org   uuid;
    v_role  text;
    v_email text;
    v_name  text;
BEGIN
    -- Sign-in happens before any tenant context exists. A pre-set context means
    -- the caller is mixing an authenticated request with sign-in: refuse.
    IF public.app_current_user_id() IS NOT NULL OR public.app_current_org_id() IS NOT NULL THEN
        RAISE EXCEPTION 'app_sign_in: tenant context must be empty' USING ERRCODE = '28000';
    END IF;
    IF p_issuer IS NULL OR NOT EXISTS (SELECT 1 FROM public.trusted_identity_issuers t WHERE t.issuer = p_issuer) THEN
        RAISE EXCEPTION 'app_sign_in: untrusted issuer' USING ERRCODE = '28000';
    END IF;
    IF p_subject IS NULL OR length(p_subject) < 1 OR length(p_subject) > 255 OR p_subject ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'app_sign_in: invalid subject' USING ERRCODE = '22023';
    END IF;

    v_email := NULLIF(lower(btrim(p_email)), '');
    IF v_email IS NOT NULL AND (length(v_email) > 320 OR v_email !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$') THEN
        v_email := NULL;   -- informational only; never used for linking
    END IF;
    v_name := left(btrim(regexp_replace(COALESCE(p_display_name, ''), '[[:cntrl:]]', '', 'g')), 200);

    -- Serialize concurrent first sign-ins of the same identity.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_issuer || chr(10) || p_subject, 8008));

    SELECT i.user_id INTO v_user
      FROM public.user_identities i
     WHERE i.issuer = p_issuer AND i.subject = p_subject;

    IF FOUND THEN
        UPDATE public.user_identities i
           SET last_sign_in_at = now(), email = COALESCE(v_email, i.email)
         WHERE i.issuer = p_issuer AND i.subject = p_subject;

        SELECT u.organization_id INTO v_org FROM public.users u WHERE u.id = v_user;
        SELECT m.role INTO v_role
          FROM public.memberships m
         WHERE m.user_id = v_user AND m.organization_id = v_org;
        IF v_org IS NULL OR v_role IS NULL THEN
            RAISE EXCEPTION 'app_sign_in: no active membership' USING ERRCODE = '28000';
        END IF;

        INSERT INTO public.audit_log (organization_id, user_id, action, target_type, target_id)
        VALUES (v_org, v_user, 'user.signed_in', 'user', v_user);

        RETURN QUERY SELECT v_user, v_org, v_role, false;
        RETURN;
    END IF;

    v_user := gen_random_uuid();
    INSERT INTO public.organizations (name, slug)
    VALUES (
        COALESCE(NULLIF(v_name, ''), NULLIF(split_part(COALESCE(v_email, ''), '@', 1), ''), 'My') || ' workspace',
        public.generate_org_slug(COALESCE(NULLIF(v_name, ''), 'workspace'), v_user)
    )
    RETURNING id INTO v_org;

    INSERT INTO public.users (id, organization_id, full_name, role)
    VALUES (v_user, v_org, v_name, 'admin');

    INSERT INTO public.memberships (user_id, organization_id, role)
    VALUES (v_user, v_org, 'owner');

    INSERT INTO public.user_identities (user_id, issuer, subject, email)
    VALUES (v_user, p_issuer, p_subject, v_email);

    INSERT INTO public.audit_log (organization_id, user_id, action, target_type, target_id)
    VALUES (v_org, v_user, 'user.provisioned', 'user', v_user);

    RETURN QUERY SELECT v_user, v_org, 'owner'::text, true;
END;
$func$;

-- ----------------------------------------------------------------------------
-- 4. Scan lifecycle functions (tenant context from transaction-local GUCs only)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_create_scan(p_input_type text, p_raw_input text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
    v_user uuid := public.app_current_user_id();
    v_org  uuid := public.app_current_org_id();
    v_role text;
    v_id   uuid;
BEGIN
    IF v_user IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'app_create_scan: missing session context' USING ERRCODE = '28000';
    END IF;
    SELECT m.role INTO v_role FROM public.memberships m WHERE m.user_id = v_user AND m.organization_id = v_org;
    IF v_role IS NULL THEN
        RAISE EXCEPTION 'app_create_scan: caller is not a member of the organization' USING ERRCODE = '42501';
    END IF;
    IF v_role = 'viewer' THEN
        RAISE EXCEPTION 'app_create_scan: viewers cannot create scans' USING ERRCODE = '42501';
    END IF;
    IF p_input_type IS NULL OR p_input_type NOT IN ('url', 'domain', 'email', 'header', 'signature', 'batch') THEN
        RAISE EXCEPTION 'app_create_scan: invalid input_type' USING ERRCODE = '22023';
    END IF;
    IF p_raw_input IS NULL OR length(btrim(p_raw_input)) = 0 OR length(p_raw_input) > 10000 THEN
        RAISE EXCEPTION 'app_create_scan: invalid raw_input' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.scans (organization_id, user_id, input_type, raw_input, status)
    VALUES (v_org, v_user, p_input_type, p_raw_input, 'pending')
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$func$;

-- Returns true when the scan moved pending -> processing, false when it was
-- already processing (idempotent replay). Terminal scans raise.
CREATE OR REPLACE FUNCTION public.app_mark_scan_processing(p_scan_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
    v_user   uuid := public.app_current_user_id();
    v_org    uuid := public.app_current_org_id();
    v_status text;
BEGIN
    IF v_user IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'app_mark_scan_processing: missing session context' USING ERRCODE = '28000';
    END IF;
    IF NOT public.app_is_member(v_org) THEN
        RAISE EXCEPTION 'app_mark_scan_processing: caller is not a member of the organization' USING ERRCODE = '42501';
    END IF;
    SELECT s.status INTO v_status
      FROM public.scans s
     WHERE s.id = p_scan_id AND s.organization_id = v_org
       FOR UPDATE;
    IF NOT FOUND THEN
        -- Same error for "missing" and "other tenant": no existence oracle.
        RAISE EXCEPTION 'app_mark_scan_processing: scan not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_status = 'processing' THEN
        RETURN false;
    END IF;
    IF v_status <> 'pending' THEN
        RAISE EXCEPTION 'app_mark_scan_processing: scan is in final state %', v_status USING ERRCODE = '55000';
    END IF;
    UPDATE public.scans SET status = 'processing' WHERE id = p_scan_id AND organization_id = v_org;
    RETURN true;
END;
$func$;

-- ----------------------------------------------------------------------------
-- 5. Integrity triggers (bind every role, including the table owner)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_scans_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.input_type IS DISTINCT FROM OLD.input_type
       OR NEW.raw_input IS DISTINCT FROM OLD.raw_input
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL) THEN
        RAISE EXCEPTION 'scans: identity columns are immutable' USING ERRCODE = '55000';
    END IF;

    IF OLD.status IN ('complete', 'failed') THEN
        -- The only permitted change to a terminal scan is the FK cascade
        -- ON DELETE SET NULL of user_id (user deletion).
        IF (to_jsonb(NEW) - 'user_id') IS DISTINCT FROM (to_jsonb(OLD) - 'user_id') THEN
            RAISE EXCEPTION 'scans: scan % is final (%) and immutable', OLD.id, OLD.status USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF NOT (
        NEW.status = OLD.status
        OR (OLD.status = 'pending' AND NEW.status IN ('processing', 'complete', 'failed'))
        OR (OLD.status = 'processing' AND NEW.status IN ('complete', 'failed'))
    ) THEN
        RAISE EXCEPTION 'scans: invalid status transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS scans_integrity ON public.scans;
CREATE TRIGGER scans_integrity BEFORE UPDATE ON public.scans
    FOR EACH ROW EXECUTE FUNCTION public.app_scans_integrity();

CREATE OR REPLACE FUNCTION public.app_reject_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
BEGIN
    RAISE EXCEPTION '%: rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$func$;

DROP TRIGGER IF EXISTS vendor_results_immutable ON public.vendor_results;
CREATE TRIGGER vendor_results_immutable BEFORE UPDATE ON public.vendor_results
    FOR EACH ROW EXECUTE FUNCTION public.app_reject_update();
DROP TRIGGER IF EXISTS evidence_items_immutable ON public.evidence_items;
CREATE TRIGGER evidence_items_immutable BEFORE UPDATE ON public.evidence_items
    FOR EACH ROW EXECUTE FUNCTION public.app_reject_update();

-- audit_log: append-only. Updates: only the FK cascade that nulls user_id.
-- Deletes: only the FK cascade of an organization deletion (the parent row is
-- already gone and the delete runs inside the RI trigger).
CREATE OR REPLACE FUNCTION public.app_audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.user_id IS NULL AND (to_jsonb(NEW) - 'user_id') = (to_jsonb(OLD) - 'user_id') THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'audit_log: append-only' USING ERRCODE = '55000';
    END IF;
    IF pg_trigger_depth() > 1
       AND OLD.organization_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = OLD.organization_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'audit_log: append-only' USING ERRCODE = '55000';
END;
$func$;

DROP TRIGGER IF EXISTS audit_log_append_only ON public.audit_log;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON public.audit_log
    FOR EACH ROW EXECUTE FUNCTION public.app_audit_log_append_only();

-- ----------------------------------------------------------------------------
-- 6. Function EXECUTE: never PUBLIC; only what cbc_app needs
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
    public.app_current_user_id(),
    public.app_current_org_id(),
    public.app_is_member(uuid),
    public.app_is_org_admin(uuid),
    public.app_tenant_check(uuid),
    public.app_tenant_admin_check(uuid),
    public.generate_org_slug(text, uuid),
    public.bootstrap_new_organization(uuid, text, text, text),
    public.app_sign_in(text, text, text, text),
    public.app_create_scan(text, text),
    public.app_mark_scan_processing(uuid),
    public.app_scans_integrity(),
    public.app_reject_update(),
    public.app_audit_log_append_only()
FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- 7. cbc_app privileges: read under RLS; writes only through functions
-- ----------------------------------------------------------------------------
DO $grants$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cbc_app') THEN
        RAISE EXCEPTION '005: role cbc_app must exist (create it before 002, see header)';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cbc_app'
               AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)) THEN
        RAISE EXCEPTION '005: cbc_app must be NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS';
    END IF;

    REVOKE INSERT, UPDATE, DELETE ON
        public.scans, public.vendor_results, public.evidence_items,
        public.audit_log, public.organizations, public.users
    FROM cbc_app;
    -- Display name only; organization_id and role stay function-controlled.
    GRANT UPDATE (full_name) ON public.users TO cbc_app;

    GRANT SELECT ON public.user_identities TO cbc_app;

    REVOKE EXECUTE ON FUNCTION public.bootstrap_new_organization(uuid, text, text, text) FROM cbc_app;
    GRANT EXECUTE ON FUNCTION
        public.app_current_user_id(),
        public.app_current_org_id(),
        public.app_is_member(uuid),
        public.app_is_org_admin(uuid),
        public.app_tenant_check(uuid),
        public.app_tenant_admin_check(uuid),
        public.app_sign_in(text, text, text, text),
        public.app_create_scan(text, text),
        public.app_mark_scan_processing(uuid)
    TO cbc_app;
END;
$grants$;

COMMIT;
