-- Gate 007A - rollback for 002_users_identity_guard.sql (founder-only on any real database).
-- After this rollback, whether a signed-in user can change public.users.organization_id or role depends only on
-- the RLS policies and grants on public.users again.
DROP TRIGGER IF EXISTS cbc_guard_users_identity ON public.users;
DROP FUNCTION IF EXISTS public.cbc_guard_users_identity();
