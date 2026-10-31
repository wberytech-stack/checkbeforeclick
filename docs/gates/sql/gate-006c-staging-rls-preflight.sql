-- Gate 006C: staging-only, read-only RLS/identity safety preflight.
-- Target: checkbeforeclick-staging Supabase SQL editor (verify project ref
-- zgxmvpbvvakpsnzcymsf before running). Never run against production.
--
-- Catalog metadata only: no user rows, tokens, secrets, network requests,
-- data mutations, schema changes, or migrations. Every row must say PASS
-- before considering authenticated staging verification.
--
-- A PASS is only a conservative precondition, NOT proof of tenant isolation:
-- review the trigger function body, RLS policies, RPC/SECURITY DEFINER paths,
-- and live authenticated tests under separate founder authorization.
--
-- A BLOCK requires review and a founder-authorized, human-applied staging
-- remediation. Do not fix it by editing existing migration files.

WITH expected(table_name, column_name) AS (
  VALUES
    ('organizations', 'plan'),
    ('organizations', 'scan_count_this_month'),
    ('scans', 'status'),
    ('scans', 'verdict'),
    ('scans', 'risk_score')
),
columns_checked AS (
  SELECT e.table_name, e.column_name,
         EXISTS (
           SELECT 1 FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid
           WHERE n.nspname = 'public' AND c.relname = e.table_name
             AND a.attname = e.column_name AND a.attnum > 0 AND NOT a.attisdropped
         ) AS column_exists,
         EXISTS (
           SELECT 1 FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid
           WHERE n.nspname = 'public' AND c.relname = e.table_name
             AND a.attname = e.column_name AND a.attnum > 0 AND NOT a.attisdropped
             AND has_column_privilege('authenticated', c.oid, a.attnum, 'UPDATE')
         ) AS authenticated_can_update
  FROM expected e
),
checks AS (
  SELECT 'users_identity_guard_trigger' AS check_id,
         EXISTS (
           SELECT 1 FROM pg_trigger t
           JOIN pg_proc f ON f.oid = t.tgfoid
           WHERE t.tgrelid = to_regclass('public.users')
             AND t.tgname = 'cbc_guard_users_identity'
             AND t.tgfoid = to_regprocedure('public.cbc_guard_users_identity()')
             AND t.tgenabled IN ('O', 'A')
             AND NOT t.tgisinternal AND NOT f.prosecdef
             AND (t.tgtype & 31) = 31
         ) AS passes
  UNION ALL
  SELECT 'organizations_server_owned_columns',
         count(*) = 2 AND bool_and(column_exists AND NOT authenticated_can_update)
  FROM columns_checked WHERE table_name = 'organizations'
  UNION ALL
  SELECT 'scans_server_owned_columns',
         count(*) = 3 AND bool_and(column_exists AND NOT authenticated_can_update)
  FROM columns_checked WHERE table_name = 'scans'
)
SELECT check_id, CASE WHEN coalesce(passes, false) THEN 'PASS' ELSE 'BLOCK' END AS status
FROM checks ORDER BY check_id;
