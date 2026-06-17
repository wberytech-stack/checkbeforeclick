-- ============================================================================
-- 001_create_cbc_app_validation_role.sql
-- Gate 003B disposable-DB validation script
--------------------------------------------

-- RUN ONLY AGAINST: cbc_003_validation
-- NEVER RUN AGAINST: cbc_prod
------------------------------

-- Expected precondition:
-- 1. 001_initial_schema.sql has already been applied to cbc_003_validation.
-- 2. 002_tenant_isolation.sql has already been applied to cbc_003_validation.
-- 3. This script is run as the migration/admin user.
-----------------------------------------------------

-- Purpose:
-- Create a throwaway NOBYPASSRLS non-owner runtime-like role for validating
-- the cbc_app user/API access model.
-------------------------------------

-- This script intentionally does NOT create cbc_worker.
-- Worker role/function validation is deferred to the worker migration gate.
-- ============================================================================

---

-- 0. Confirm target database

---

SELECT
'CHECK_DATABASE' AS test,
current_database() AS database_name,
CASE
WHEN current_database() = 'cbc_003_validation' THEN 'PASS'
ELSE 'FAIL - wrong database, stop immediately'
END AS result;

---

-- 1. Create throwaway validation runtime role

---

DO $$
DECLARE
v_admin text := current_user;
BEGIN
IF current_database() <> 'cbc_003_validation' THEN
RAISE EXCEPTION 'Refusing to run outside cbc_003_validation. Current database: %', current_database();
END IF;

IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cbc_app_validation') THEN
CREATE ROLE cbc_app_validation
LOGIN
NOSUPERUSER
NOCREATEDB
NOCREATEROLE
NOBYPASSRLS;
END IF;

EXECUTE format('GRANT cbc_app_validation TO %I', v_admin);
END;
$$;

---

-- 2. Confirm validation role safety properties

---

SELECT
'CHECK_VALIDATION_ROLE_SECURITY' AS test,
rolname,
rolsuper,
rolcreatedb,
rolcreaterole,
rolbypassrls,
CASE
WHEN rolname = 'cbc_app_validation'
AND rolsuper = false
AND rolcreatedb = false
AND rolcreaterole = false
AND rolbypassrls = false
THEN 'PASS'
ELSE 'FAIL'
END AS result
FROM pg_roles
WHERE rolname = 'cbc_app_validation';

---

-- 3. Grant schema usage

---

GRANT USAGE ON SCHEMA public TO cbc_app_validation;

---

-- 4. Grant cbc_app-style table privileges

-- This is intentionally narrower than the older Gate 002 broad RLS stress test.

-- cbc_app should support:
-- - dashboard-style reads
-- - scan result/status reads
-- - scan creation
-- - user/org/membership reads
-- - feedback/watchlist/alert user-facing behavior
-- - append-only audit logging
------------------------------

-- cbc_app should not own tables.
-- cbc_app should not bypass RLS.
-- cbc_app should not receive broad DDL.

---

-- Read access for user/API pages and status/result views.
GRANT SELECT ON
public.organizations,
public.users,
public.memberships,
public.scans,
public.vendor_results,
public.evidence_items,
public.scan_feedback,
public.watchlist,
public.alerts,
public.audit_log
TO cbc_app_validation;

-- User/API writes.
GRANT INSERT ON
public.scans,
public.scan_feedback,
public.watchlist,
public.audit_log
TO cbc_app_validation;

-- Limited user/API updates.
GRANT UPDATE ON
public.users,
public.watchlist,
public.alerts
TO cbc_app_validation;

-- No tenant-table DELETE grants in Gate 003B cbc_app validation.
-- No vendor_results/evidence_items INSERT grants here.
-- Provider result and evidence writes belong to the worker path later.

-- scan_cache is intentionally not tenant-RLS scoped.
-- Gate 003B does not grant cbc_app_validation access to scan_cache.

---

-- 5. Grant required function execution

---

GRANT EXECUTE ON FUNCTION
public.app_current_user_id(),
public.app_current_org_id(),
public.app_is_member(uuid),
public.app_is_org_admin(uuid),
public.app_tenant_check(uuid),
public.app_tenant_admin_check(uuid),
public.generate_org_slug(text, uuid),
public.bootstrap_new_organization(uuid, text, text, text)
TO cbc_app_validation;

---

-- 6. Confirm cbc_app_validation owns no tenant tables

---

SELECT
'CHECK_VALIDATION_ROLE_OWNS_NO_TENANT_TABLES' AS test,
count(*) AS owned_tenant_tables,
CASE
WHEN count(*) = 0 THEN 'PASS'
ELSE 'FAIL - validation role owns tenant tables'
END AS result
FROM pg_class c
JOIN pg_namespace n
ON n.oid = c.relnamespace
JOIN pg_roles r
ON r.oid = c.relowner
WHERE n.nspname = 'public'
AND c.relkind IN ('r', 'p')
AND r.rolname = 'cbc_app_validation'
AND c.relname IN (
'organizations',
'users',
'memberships',
'scans',
'vendor_results',
'evidence_items',
'scan_feedback',
'watchlist',
'alerts',
'audit_log'
);

---

-- 7. Confirm granted table privileges snapshot

---

SELECT
'CHECK_VALIDATION_ROLE_TABLE_PRIVILEGES' AS test,
table_schema,
table_name,
privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'cbc_app_validation'
AND table_schema = 'public'
ORDER BY table_name, privilege_type;

---

-- 8. Confirm scan_cache is not granted to cbc_app_validation

---

SELECT
'CHECK_SCAN_CACHE_NOT_GRANTED_TO_CBC_APP_VALIDATION' AS test,
count(*) AS granted_scan_cache_privileges,
CASE
WHEN count(*) = 0 THEN 'PASS'
ELSE 'FAIL - cbc_app_validation should not have scan_cache privileges in Gate 003B'
END AS result
FROM information_schema.role_table_grants
WHERE grantee = 'cbc_app_validation'
AND table_schema = 'public'
AND table_name = 'scan_cache';

---

-- 9. Confirm RLS remains enabled on tenant tables

---

SELECT
'CHECK_RLS_ENABLED_TABLES' AS test,
c.relname,
c.relrowsecurity,
CASE
WHEN c.relrowsecurity = true THEN 'PASS'
ELSE 'FAIL - RLS not enabled'
END AS result
FROM pg_class c
JOIN pg_namespace n
ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
AND c.relname IN (
'organizations',
'users',
'memberships',
'scans',
'vendor_results',
'evidence_items',
'scan_feedback',
'audit_log',
'watchlist',
'alerts'
)
ORDER BY c.relname;

---

-- 10. Completion marker

---

SELECT
'GATE_003B_001_CREATE_CBC_APP_VALIDATION_ROLE_COMPLETE' AS test,
'PASS' AS result;
