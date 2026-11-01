-- Gate 006C / 007A: read-only privilege regression checks for draft migration 003.
-- Run on a disposable Supabase-compatible database AFTER applying migrations
-- 001_scan_admission, 002_users_identity_guard and 003_browser_role_privilege_hardening.
-- Every row must be PASS. No writes or role impersonation; this does NOT prove
-- RLS row isolation, profile-update behavior, or auth-trigger correctness.
-- Separately test real role-scoped positive/negative operations on disposable DB.
-- Safe for read-only baseline inspection of staging; never apply 003 there
-- without a new, explicit founder decision.
WITH required(name) AS (
  VALUES ('users'), ('organizations'), ('scans'), ('scan_cache'),
         ('evidence_items'), ('vendor_results')
), roles(name) AS (
  VALUES ('anon'), ('authenticated')
), checks AS (
  SELECT 'required_tables_exist'::text AS check_id,
         (SELECT count(*) FROM required r
          WHERE to_regclass('public.' || r.name) IS NOT NULL) = 6 AS passes
  UNION ALL
  SELECT 'no_browser_truncate_on_any_public_table',
         NOT EXISTS (
           SELECT 1 FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN roles r
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
             AND has_table_privilege(r.name, c.oid, 'TRUNCATE')
         )
  UNION ALL
  SELECT 'no_browser_scan_or_org_writes',
         NOT EXISTS (
           SELECT 1 FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN roles r
           WHERE n.nspname = 'public' AND c.relname IN ('scans', 'organizations')
             AND c.relkind IN ('r', 'p')
             AND (has_table_privilege(r.name, c.oid, 'INSERT')
                  OR has_table_privilege(r.name, c.oid, 'UPDATE')
                  OR has_table_privilege(r.name, c.oid, 'DELETE')
                  OR EXISTS (
                    SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                      AND (has_column_privilege(r.name, c.oid, a.attnum, 'INSERT')
                           OR has_column_privilege(r.name, c.oid, a.attnum, 'UPDATE'))
                  ))
         )
  UNION ALL
  SELECT 'no_browser_evidence_or_vendor_writes',
         NOT EXISTS (
           SELECT 1 FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN roles r
           WHERE n.nspname = 'public'
             AND c.relname IN ('evidence_items', 'vendor_results')
             AND c.relkind IN ('r', 'p')
             AND (has_table_privilege(r.name, c.oid, 'INSERT')
                  OR has_table_privilege(r.name, c.oid, 'UPDATE')
                  OR has_table_privilege(r.name, c.oid, 'DELETE')
                  OR EXISTS (
                    SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                      AND (has_column_privilege(r.name, c.oid, a.attnum, 'INSERT')
                           OR has_column_privilege(r.name, c.oid, a.attnum, 'UPDATE'))
                  ))
         )
  UNION ALL
  SELECT 'no_browser_users_identity_or_row_writes',
         NOT EXISTS (
           SELECT 1 FROM roles r
           WHERE has_table_privilege(r.name, 'public.users', 'INSERT')
              OR has_table_privilege(r.name, 'public.users', 'DELETE')
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_attribute a CROSS JOIN roles r
           WHERE a.attrelid = to_regclass('public.users')
             AND a.attnum > 0 AND NOT a.attisdropped
             AND has_column_privilege(r.name, a.attrelid, a.attnum, 'INSERT')
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_attribute a CROSS JOIN roles r
           WHERE a.attrelid = to_regclass('public.users')
             AND a.attnum > 0 AND NOT a.attisdropped
             AND (r.name = 'anon' OR a.attname <> 'full_name')
             AND has_column_privilege(r.name, a.attrelid, a.attnum, 'UPDATE')
         )
  UNION ALL
  SELECT 'authenticated_profile_name_edit_preserved',
         coalesce(has_column_privilege('authenticated', to_regclass('public.users'),
                                      'full_name', 'UPDATE'), false)
         AND NOT coalesce(has_column_privilege('anon', to_regclass('public.users'),
                                               'full_name', 'UPDATE'), true)
  UNION ALL
  SELECT 'shared_scan_cache_closed_to_browser_roles',
         NOT EXISTS (
           SELECT 1 FROM roles r
           WHERE has_table_privilege(r.name, 'public.scan_cache', 'SELECT')
              OR has_table_privilege(r.name, 'public.scan_cache', 'INSERT')
              OR has_table_privilege(r.name, 'public.scan_cache', 'UPDATE')
              OR has_table_privilege(r.name, 'public.scan_cache', 'DELETE')
              OR has_table_privilege(r.name, 'public.scan_cache', 'TRUNCATE')
              OR has_table_privilege(r.name, 'public.scan_cache', 'REFERENCES')
              OR has_table_privilege(r.name, 'public.scan_cache', 'TRIGGER')
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_attribute a CROSS JOIN roles r
           WHERE a.attrelid = to_regclass('public.scan_cache')
             AND a.attnum > 0 AND NOT a.attisdropped
             AND (has_column_privilege(r.name, a.attrelid, a.attnum, 'SELECT')
                  OR has_column_privilege(r.name, a.attrelid, a.attnum, 'INSERT')
                  OR has_column_privilege(r.name, a.attrelid, a.attnum, 'UPDATE')
                  OR has_column_privilege(r.name, a.attrelid, a.attnum, 'REFERENCES'))
         )
  UNION ALL
  SELECT 'service_role_data_writes_preserved',
         coalesce((
           SELECT bool_and(
             has_table_privilege('service_role', to_regclass('public.' || r.name), 'SELECT')
             AND has_table_privilege('service_role', to_regclass('public.' || r.name), 'INSERT')
             AND has_table_privilege('service_role', to_regclass('public.' || r.name), 'UPDATE')
             AND has_table_privilege('service_role', to_regclass('public.' || r.name), 'DELETE')
           ) FROM required r
         ), false)
  UNION ALL
  SELECT 'authenticated_scan_rpcs_preserved',
         coalesce(has_function_privilege('authenticated',
                  to_regprocedure('public.cbc_admit_scan(text)'), 'EXECUTE'), false)
         AND coalesce(has_function_privilege('authenticated',
                  to_regprocedure('public.cbc_reserve_provider_call(text,bigint)'), 'EXECUTE'), false)
)
SELECT check_id, CASE WHEN coalesce(passes, false) THEN 'PASS' ELSE 'BLOCK' END AS status
FROM checks ORDER BY check_id;
