-- Gate 007A - guard the tenant pointer on public.users (Supabase Postgres).
--
-- DRAFT MIGRATION. NOT applied to any database and NOT yet validated on a disposable database
-- (scripts/rate-limit/validate-users-guard-db.ts is ready but has not been run). Target: the Supabase projects
-- (staging zgxmvpbvvakpsnzcymsf, production qnjqwmcsfpmpnvlnomat), NOT the Azure database (infra/db/migrations).
-- Applying it to any real database is founder-only (AGENTS.md sections 6.3 and 9).
--
-- Why: public.users.organization_id is the ONLY tenant pointer in the Supabase schema. The application reads it
-- with the service-role client (lib/data/index.ts getUserOrgContext) and then reads and writes that
-- organization's scans; cbc_admit_scan uses it for the per-organization quota. The production RLS policies on
-- public.users are not in this repository (docs/audit/phase-0-current-state.md lists "users may be able to update
-- sensitive profile fields such as role or organization" as an open risk). If an UPDATE policy lets a signed-in
-- user change their own row through PostgREST, that user could move into another organization.
--
-- What it does, independent of whatever RLS policies exist:
--   Requests running as the PostgREST roles "anon" or "authenticated" can no longer INSERT or DELETE rows in
--   public.users, and can no longer change id, organization_id or role on UPDATE. Other columns (for example
--   full_name) are unaffected, as are the service role (the app's data layer), the auth trigger
--   handle_new_user (runs as its owner or as supabase_auth_admin) and the dashboard/SQL editor (postgres).
-- It does NOT replace a review of the RLS policies on public.users and public.organizations (see the gate doc).

CREATE OR REPLACE FUNCTION public.cbc_guard_users_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    -- current_user is the role the request runs as: PostgREST switches to anon/authenticated per request.
    -- Deliberately NOT SECURITY DEFINER, so current_user is the caller and not the function owner.
    IF current_user IN ('anon', 'authenticated') THEN
        IF TG_OP = 'INSERT' OR TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'cbc: % on public.users is not allowed for %', TG_OP, current_user
                USING ERRCODE = '42501';
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
           OR NEW.role IS DISTINCT FROM OLD.role THEN
            RAISE EXCEPTION 'cbc: id, organization_id and role on public.users cannot be changed by %', current_user
                USING ERRCODE = '42501';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.cbc_guard_users_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cbc_guard_users_identity() FROM anon, authenticated;

DROP TRIGGER IF EXISTS cbc_guard_users_identity ON public.users;
CREATE TRIGGER cbc_guard_users_identity
    BEFORE INSERT OR UPDATE OR DELETE ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.cbc_guard_users_identity();
