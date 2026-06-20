-- ============================================================================
-- 002_tenant_isolation.sql  (revised v3)
-- Gate 002 - Tenant Isolation (database-enforced defense-in-depth)
--
-- WHAT THIS DOES
-- - Adds a memberships table (user-to-organization, with role).
-- - Backfills one membership per existing user (preserves one-user-one-org).
-- - Adds helper functions reading transaction-local session variables
--   (app.current_user_id, app.current_organization_id) - NO auth.uid(), NO
--   Supabase dependency.
-- - Adds a hardened SECURITY DEFINER bootstrap function (first org/user/
--   membership), created BEFORE it is granted.
-- - Enables Row-Level Security (ENABLE, not FORCE) on tenant tables, with
--   policies requiring BOTH (row.organization_id = current org) AND membership;
--   membership mutation additionally requires owner/admin.
-- - Grants least privilege to the runtime role cbc_app (if it exists).
--
-- WHY ENABLE (NOT FORCE) ROW LEVEL SECURITY
-- - The helper functions (app_is_member, etc.) and bootstrap are SECURITY
--   DEFINER and run as the function owner so they can read memberships / create
--   the first rows WITHOUT being blocked by RLS (this is what prevents infinite
--   recursion in the membership policy and the bootstrap chicken-and-egg).
-- - FORCE ROW LEVEL SECURITY would subject the table OWNER to RLS too, which
--   would break those owner-run definer functions. So we use ENABLE (owner
--   bypasses; cbc_app, which is NOT an owner and NOT BYPASSRLS, is fully subject
--   to RLS). A future hardening gate may revisit FORCE RLS with a dedicated
--   BYPASSRLS / function-owner model.
--
-- WHAT THIS DOES NOT DO
-- - Does NOT weaken the existing app-layer isolation (lib/data chokepoint);
--   RLS is an INDEPENDENT second wall.
-- - Does NOT remove users.organization_id (kept as primary/active-org pointer).
-- - Does NOT create the runtime login role cbc_app (CREATE ROLE is cluster-
--   level; handled in a SEPARATE reviewed server-role gate). This file only
--   GRANTs to cbc_app if present.
-- - Does NOT change app traffic, hosting, or auth (later gates).
-- - Does NOT migrate/import data beyond the membership backfill.
--
-- scan_cache: intentionally NOT under tenant RLS in 002. Confirmed treated as a
--   GLOBAL/INTERNAL cache. Validation note (verify in dry-run against 001):
--     * scan_cache has NO organization_id column,
--     * scan_cache has NO user_id column,
--     * scan_cache holds NO tenant/customer-specific evidence (only
--       input-hash-keyed reusable lookup results),
--     * scan_cache is NOT directly exposed to users,
--     * a future per-tenant cache redesign, if ever needed, is a SEPARATE gate.
--   If any of the above is false in 001, revisit before applying to cbc_prod.
--
-- audit_log: tenant rows REQUIRE a non-null organization_id under 002 (RLS keys
--   on it). The app role is granted SELECT, INSERT only (append-only); no
--   UPDATE/DELETE (audit history must not be alterable by the app). System/
--   global (org-less) audit is a future design if needed.
--
-- ROLES
-- - cbcpgadmin: migration/admin role (runs this; owns objects). App must NOT
--   connect as cbcpgadmin (would bypass RLS).
-- - cbc_app: least-privileged runtime role (created in the separate server-role
--   gate: LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS).
--
-- DRY-RUN: validate RLS as a NOBYPASSRLS, non-owner role (cbc_app or a throwaway
--   cbc_app_validation), never cbcpgadmin. Drop any throwaway role afterward.
--
-- SAFETY: single transaction (BEGIN/COMMIT); definer functions pin search_path;
--   least-privilege grants.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. memberships table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.memberships (
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL,
    organization_id uuid NOT NULL,
    role            text NOT NULL DEFAULT 'member',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memberships_pkey PRIMARY KEY (id),
    CONSTRAINT memberships_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
    CONSTRAINT memberships_organization_id_fkey
        FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT,
    CONSTRAINT memberships_user_org_unique UNIQUE (user_id, organization_id),
    CONSTRAINT memberships_role_check CHECK (role IN ('owner','admin','member','viewer'))
);

CREATE INDEX IF NOT EXISTS memberships_user_id_idx
    ON public.memberships (user_id);
CREATE INDEX IF NOT EXISTS memberships_organization_id_idx
    ON public.memberships (organization_id);

-- ----------------------------------------------------------------------------
-- 2. Backfill one membership per existing user (idempotent).
-- ----------------------------------------------------------------------------
INSERT INTO public.memberships (user_id, organization_id, role)
SELECT
    u.id,
    u.organization_id,
    CASE
        WHEN u.role IN ('owner','admin','member','viewer') THEN u.role
        ELSE 'member'
    END
FROM public.users u
WHERE u.organization_id IS NOT NULL
ON CONFLICT (user_id, organization_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. Helper functions (SECURITY DEFINER, pinned search_path, no auth.* refs).
--    current_setting(..., true) -> NULL when unset => fail closed (deny).
--    app_is_member / app_is_org_admin are DEFINER so they read memberships as
--    owner, bypassing RLS - avoids recursion with the membership policies.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION public.app_current_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT NULLIF(current_setting('app.current_organization_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION public.app_is_member(target_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.memberships m
        WHERE m.user_id = public.app_current_user_id()
          AND m.organization_id = target_org
    );
$$;

CREATE OR REPLACE FUNCTION public.app_is_org_admin(target_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.memberships m
        WHERE m.user_id = public.app_current_user_id()
          AND m.organization_id = target_org
          AND m.role IN ('owner','admin')
    );
$$;

CREATE OR REPLACE FUNCTION public.app_tenant_check(row_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT row_org IS NOT NULL
       AND row_org = public.app_current_org_id()
       AND public.app_is_member(row_org);
$$;

CREATE OR REPLACE FUNCTION public.app_tenant_admin_check(row_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT row_org IS NOT NULL
       AND row_org = public.app_current_org_id()
       AND public.app_is_org_admin(row_org);
$$;

-- ----------------------------------------------------------------------------
-- 4. Bootstrap function (SECURITY DEFINER) - created BEFORE grants.
--    HARDENED: can only act for the authenticated session user (requires
--    p_user_id = app_current_user_id(); fails closed if missing/mismatched).
--    Runs as owner (bypasses RLS) to create the initial rows. Pinned
--    search_path. Only makes the FIRST org + the caller's own owner-membership.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bootstrap_new_organization(
    p_user_id        uuid,
    p_user_email     text,
    p_user_full_name text,
    p_org_name       text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_org_id    uuid;
    v_slug      text;
    v_existing  uuid;
    v_session   uuid;
BEGIN
    v_session := public.app_current_user_id();
    IF v_session IS NULL THEN
        RAISE EXCEPTION 'bootstrap_new_organization: no authenticated session user';
    END IF;
    IF p_user_id IS NULL OR p_user_id <> v_session THEN
        RAISE EXCEPTION 'bootstrap_new_organization: p_user_id must equal the session user';
    END IF;
    IF p_org_name IS NULL OR btrim(p_org_name) = '' THEN
        RAISE EXCEPTION 'bootstrap_new_organization: org name is required';
    END IF;

    SELECT organization_id INTO v_existing FROM public.users WHERE id = p_user_id;
    IF v_existing IS NOT NULL THEN
        RAISE EXCEPTION 'bootstrap_new_organization: user already has an organization';
    END IF;

    v_slug := public.generate_org_slug(p_org_name, p_user_id);

    INSERT INTO public.organizations (name, slug)
    VALUES (p_org_name, v_slug)
    RETURNING id INTO v_org_id;

    INSERT INTO public.users (id, organization_id, full_name, role)
    VALUES (p_user_id, v_org_id, COALESCE(p_user_full_name, ''), 'admin')
    ON CONFLICT (id) DO UPDATE
        SET organization_id = EXCLUDED.organization_id,
            full_name       = COALESCE(EXCLUDED.full_name, public.users.full_name);

    INSERT INTO public.memberships (user_id, organization_id, role)
    VALUES (p_user_id, v_org_id, 'owner')
    ON CONFLICT (user_id, organization_id) DO NOTHING;

    RETURN v_org_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Privilege grants to runtime role cbc_app (if it exists).
--    Conditional so the migration does not fail where cbc_app is not yet
--    present (e.g. a disposable dry-run DB using a validation role). All granted
--    functions/objects are created above, so grant order is safe.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cbc_app') THEN
        GRANT USAGE ON SCHEMA public TO cbc_app;

        -- Tenant tables: full DML EXCEPT audit_log (append-only).
        GRANT SELECT, INSERT, UPDATE, DELETE ON
            public.organizations,
            public.users,
            public.memberships,
            public.scans,
            public.vendor_results,
            public.evidence_items,
            public.scan_feedback,
            public.watchlist,
            public.alerts
        TO cbc_app;

        -- audit_log: append-only (no UPDATE/DELETE).
        GRANT SELECT, INSERT ON public.audit_log TO cbc_app;

        -- scan_cache: global/internal cache (no tenant RLS). App may read/write.
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.scan_cache TO cbc_app;

        -- Approved functions only.
        GRANT EXECUTE ON FUNCTION
            public.app_current_user_id(),
            public.app_current_org_id(),
            public.app_is_member(uuid),
            public.app_is_org_admin(uuid),
            public.app_tenant_check(uuid),
            public.app_tenant_admin_check(uuid),
            public.generate_org_slug(text, uuid),
            public.bootstrap_new_organization(uuid, text, text, text)
        TO cbc_app;
    ELSE
        RAISE NOTICE 'Role cbc_app not present; skipping grants. Create it in the server-role gate, then re-run grants.';
    END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 6. Enable RLS (ENABLE, not FORCE) and add policies on tenant tables.
--    scan_cache intentionally excluded (global/internal cache).
-- ----------------------------------------------------------------------------

-- organizations (keyed on id)
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_tenant_isolation ON public.organizations;
CREATE POLICY org_tenant_isolation ON public.organizations
    USING (public.app_tenant_check(id))
    WITH CHECK (public.app_tenant_check(id));

-- users (keyed on organization_id)
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_tenant_isolation ON public.users;
CREATE POLICY users_tenant_isolation ON public.users
    USING (public.app_tenant_check(organization_id))
    WITH CHECK (public.app_tenant_check(organization_id));

-- memberships: members may SELECT; only owner/admin may mutate.
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memberships_select ON public.memberships;
DROP POLICY IF EXISTS memberships_insert ON public.memberships;
DROP POLICY IF EXISTS memberships_update ON public.memberships;
DROP POLICY IF EXISTS memberships_delete ON public.memberships;
CREATE POLICY memberships_select ON public.memberships
    FOR SELECT
    USING (public.app_tenant_check(organization_id));
CREATE POLICY memberships_insert ON public.memberships
    FOR INSERT
    WITH CHECK (public.app_tenant_admin_check(organization_id));
CREATE POLICY memberships_update ON public.memberships
    FOR UPDATE
    USING (public.app_tenant_admin_check(organization_id))
    WITH CHECK (public.app_tenant_admin_check(organization_id));
CREATE POLICY memberships_delete ON public.memberships
    FOR DELETE
    USING (public.app_tenant_admin_check(organization_id));

-- scans
ALTER TABLE public.scans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scans_tenant_isolation ON public.scans;
CREATE POLICY scans_tenant_isolation ON public.scans
    USING (public.app_tenant_check(organization_id))
    WITH CHECK (public.app_tenant_check(organization_id));

-- vendor_results
ALTER TABLE public.vendor_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendor_results_tenant_isolation ON public.vendor_results;
CREATE POLICY vendor_results_tenant_isolation ON public.vendor_results
    USING (public.app_tenant_check(organization_id))
    WITH CHECK (public.app_tenant_check(organization_id));

-- evidence_items
ALTER TABLE public.evidence_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS evidence_items_tenant_isolation ON public.evidence_items;
CREATE POLICY evidence_items_tenant_isolation ON public.evidence_items
    USING (public.app_tenant_check(organization_id))
    WITH CHECK (public.app_tenant_check(organization_id));

-- scan_feedback
ALTER TABLE public.scan_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scan_feedback_tenant_isolation ON public.scan_feedback;
CREATE POLICY scan_feedback_tenant_isolation ON public.scan_feedback
    USING (public.app_tenant_check(organization_id))
    WITH CHECK (public.app_tenant_check(organization_id));

-- audit_log (tenant rows require non-null organization_id)
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_log_tenant_isolation ON public.audit_log;
CREATE POLICY audit_log_tenant_isolation ON public.audit_log
    USING (public.app_tenant_check(organization_id))
    WITH CHECK (public.app_tenant_check(organization_id));

-- watchlist
ALTER TABLE public.watchlist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS watchlist_tenant_isolation ON public.watchlist;
CREATE POLICY watchlist_tenant_isolation ON public.watchlist
    USING (public.app_tenant_check(organization_id))
    WITH CHECK (public.app_tenant_check(organization_id));

-- alerts
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alerts_tenant_isolation ON public.alerts;
CREATE POLICY alerts_tenant_isolation ON public.alerts
    USING (public.app_tenant_check(organization_id))
    WITH CHECK (public.app_tenant_check(organization_id));

COMMIT;

-- ============================================================================
-- RUNTIME ROLE - SEPARATE GATE (documentation; NOT executed here)
--   CREATE ROLE cbc_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
--   (password out-of-band, in Key Vault). Then run Section 5 grants. App
--   connection string switches to cbc_app in a later runtime gate.
--
-- POST-APPLY VALIDATION (separate; run as a NOBYPASSRLS non-owner role, never
-- cbcpgadmin): cross-tenant read/write denied; missing/wrong session vars deny;
-- membership SELECT works for a member WITHOUT RLS recursion; membership
-- INSERT/UPDATE/DELETE denied for plain member, allowed for owner/admin;
-- bootstrap only works for the session user. See the disposable-DB dry-run gate.
-- ============================================================================
