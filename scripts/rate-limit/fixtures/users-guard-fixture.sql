-- Gate 007A - DISPOSABLE-DATABASE FIXTURE for validate-users-guard-db.ts. Never run against a real database.
-- Run as supabase_admin on a local Supabase Postgres image BEFORE applying 002_users_identity_guard.sql as postgres.
--
-- Models the production shape documented in the repository (the production DDL itself is not in the repository):
--   - public.organizations / public.users with users.id referencing auth.users ON DELETE CASCADE;
--   - handle_new_user() on auth.users AFTER INSERT (docs/audit/phase-0-current-state.md: trigger on_auth_user_created;
--     docs/azure/FOUNDATION.md section 13: creates the organization and the users row, role admin, organization
--     name from metadata), owned by postgres and SECURITY DEFINER as in the Supabase template;
--   - Supabase's default table grants to anon, authenticated and service_role;
--   - a deliberately PERMISSIVE self-service policy (worst case the guard must survive);
--   - a user-callable SECURITY DEFINER function that rewrites organization_id (the documented limitation).

CREATE TABLE IF NOT EXISTS public.organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text
);
CREATE TABLE IF NOT EXISTS public.users (
    id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
    organization_id uuid REFERENCES public.organizations (id),
    role text DEFAULT 'admin',
    full_name text
);
ALTER TABLE public.organizations OWNER TO postgres;
ALTER TABLE public.users OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations, public.users TO anon, authenticated, service_role;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cbc_fixture_permissive ON public.users;
CREATE POLICY cbc_fixture_permissive ON public.users FOR ALL TO authenticated USING (id = auth.uid()) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_org uuid;
BEGIN
    INSERT INTO public.organizations (name)
    VALUES (coalesce(NEW.raw_user_meta_data ->> 'organization_name', 'My organization'))
    RETURNING id INTO v_org;
    INSERT INTO public.users (id, organization_id, role, full_name)
    VALUES (NEW.id, v_org, 'admin', NEW.raw_user_meta_data ->> 'full_name');
    RETURN NEW;
END;
$$;
ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.cbc_fixture_definer_move_org(p_org uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$ UPDATE public.users SET organization_id = p_org WHERE id = auth.uid(); $$;
ALTER FUNCTION public.cbc_fixture_definer_move_org(uuid) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.cbc_fixture_definer_move_org(uuid) TO authenticated;
