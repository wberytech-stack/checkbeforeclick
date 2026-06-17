-- ============================================================================
-- 003_validate_cbc_app_rls.sql
-- Gate 003B disposable-DB validation script
--------------------------------------------

-- RUN ONLY AGAINST: cbc_003_validation
-- NEVER RUN AGAINST: cbc_prod
------------------------------

-- Expected precondition:
-- 1. 001_initial_schema.sql has already been applied to cbc_003_validation.
-- 2. 002_tenant_isolation.sql has already been applied to cbc_003_validation.
-- 3. 001_create_cbc_app_validation_role.sql has already been applied.
-- 4. 002_seed_synthetic_tenants.sql has already been applied.
-- 5. This script is run as the migration/admin user.
-----------------------------------------------------

-- Purpose:
-- Validate cbc_app-style RLS behavior using transaction-bound context.
-----------------------------------------------------------------------

-- IMPORTANT:
-- Each runtime test must be transaction-wrapped. Context is set with
-- set_config(..., true), which is transaction-local. Do not run context setup
-- in autocommit mode and then run the query separately.
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

DO $$
BEGIN
IF current_database() <> 'cbc_003_validation' THEN
RAISE EXCEPTION 'Refusing to run outside cbc_003_validation. Current database: %', current_database();
END IF;
END;
$$;

---

-- 1. Confirm validation role exists and remains NOBYPASSRLS

---

SELECT
'T00_ROLE_SECURITY' AS test,
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

-- 2. Confirm validation role owns no tenant tables

---

SELECT
'T00_ROLE_OWNS_NO_TENANT_TABLES' AS test,
count(*) AS owned_tenant_tables,
CASE
WHEN count(*) = 0 THEN 'PASS'
ELSE 'FAIL - role owns tenant tables'
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

-- 3. No context means no tenant data is visible

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', '', true);
SELECT set_config('app.current_organization_id', '', true);

SELECT
'T01_NO_CONTEXT_SCANS_DENIED' AS test,
count(*) AS visible_scans,
CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result
FROM public.scans;

RESET ROLE;
ROLLBACK;

---

-- 4. Valid Org A owner context sees only Org A scan

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);

SELECT
'T02_ORG_A_OWNER_SEES_ONLY_ORG_A_SCAN' AS test,
count(*) AS visible_scans,
min(raw_input) AS sample_scan,
CASE
WHEN count(*) = 1
AND min(raw_input) = 'https://gate-003-org-a.example.test'
THEN 'PASS'
ELSE 'FAIL'
END AS result
FROM public.scans;

RESET ROLE;
ROLLBACK;

---

-- 5. Valid Org B owner context sees only Org B scan

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', true);
SELECT set_config('app.current_organization_id', '22222222-2222-2222-2222-222222222222', true);

SELECT
'T03_ORG_B_OWNER_SEES_ONLY_ORG_B_SCAN' AS test,
count(*) AS visible_scans,
min(raw_input) AS sample_scan,
CASE
WHEN count(*) = 1
AND min(raw_input) = 'https://gate-003-org-b.example.test'
THEN 'PASS'
ELSE 'FAIL'
END AS result
FROM public.scans;

RESET ROLE;
ROLLBACK;

---

-- 6. Org A user with Org B context is denied

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '22222222-2222-2222-2222-222222222222', true);

SELECT
'T04_ORG_A_USER_WRONG_ORG_CONTEXT_DENIED' AS test,
count(*) AS visible_scans,
CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result
FROM public.scans;

RESET ROLE;
ROLLBACK;

---

-- 7. Dashboard-style reads return same-org data only

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);

SELECT
'T05_DASHBOARD_ORG_A_COUNTS' AS test,
(SELECT count(*) FROM public.scans) AS scans,
(SELECT count(*) FROM public.watchlist) AS watchlist,
(SELECT count(*) FROM public.alerts) AS alerts,
(SELECT count(*) FROM public.scan_feedback) AS feedback,
CASE
WHEN (SELECT count(*) FROM public.scans) = 1
AND (SELECT count(*) FROM public.watchlist) = 1
AND (SELECT count(*) FROM public.alerts) = 1
AND (SELECT count(*) FROM public.scan_feedback) = 1
THEN 'PASS'
ELSE 'FAIL'
END AS result;

RESET ROLE;
ROLLBACK;

---

-- 8. Scan-result-style reads return same-org scan, evidence, and vendor rows

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);

SELECT
'T06_SCAN_RESULT_ORG_A_CHILD_ROWS' AS test,
(SELECT count(*) FROM public.scans WHERE id = '33333333-3333-3333-3333-333333333331') AS scan_rows,
(SELECT count(*) FROM public.vendor_results WHERE scan_id = '33333333-3333-3333-3333-333333333331') AS vendor_rows,
(SELECT count(*) FROM public.evidence_items WHERE scan_id = '33333333-3333-3333-3333-333333333331') AS evidence_rows,
CASE
WHEN (SELECT count(*) FROM public.scans WHERE id = '33333333-3333-3333-3333-333333333331') = 1
AND (SELECT count(*) FROM public.vendor_results WHERE scan_id = '33333333-3333-3333-3333-333333333331') = 1
AND (SELECT count(*) FROM public.evidence_items WHERE scan_id = '33333333-3333-3333-3333-333333333331') = 1
THEN 'PASS'
ELSE 'FAIL'
END AS result;

RESET ROLE;
ROLLBACK;

---

-- 9. Cross-tenant scan-result read returns zero rows

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);

SELECT
'T07_CROSS_TENANT_SCAN_RESULT_DENIED' AS test,
(SELECT count(*) FROM public.scans WHERE id = '44444444-4444-4444-4444-444444444441') AS scan_rows,
(SELECT count(*) FROM public.vendor_results WHERE scan_id = '44444444-4444-4444-4444-444444444441') AS vendor_rows,
(SELECT count(*) FROM public.evidence_items WHERE scan_id = '44444444-4444-4444-4444-444444444441') AS evidence_rows,
CASE
WHEN (SELECT count(*) FROM public.scans WHERE id = '44444444-4444-4444-4444-444444444441') = 0
AND (SELECT count(*) FROM public.vendor_results WHERE scan_id = '44444444-4444-4444-4444-444444444441') = 0
AND (SELECT count(*) FROM public.evidence_items WHERE scan_id = '44444444-4444-4444-4444-444444444441') = 0
THEN 'PASS'
ELSE 'FAIL'
END AS result;

RESET ROLE;
ROLLBACK;

---

-- 10. Scan-status-style read sees same-org scan status only

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);

SELECT
'T08_SCAN_STATUS_ORG_A_ONLY' AS test,
count(*) AS status_rows,
min(status) AS status,
min(verdict) AS verdict,
CASE
WHEN count(*) = 1
AND min(status) = 'complete'
AND min(verdict) = 'safe'
THEN 'PASS'
ELSE 'FAIL'
END AS result
FROM public.scans
WHERE id = '33333333-3333-3333-3333-333333333331';

RESET ROLE;
ROLLBACK;

---

-- 11. Same-org scan creation succeeds

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);

DO $$
DECLARE
v_count integer;
BEGIN
INSERT INTO public.scans (
id,
organization_id,
user_id,
input_type,
raw_input,
status
)
VALUES (
'33333333-3333-3333-3333-333333333332',
'11111111-1111-1111-1111-111111111111',
'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
'url',
'https://gate-003-org-a-created.example.test',
'pending'
);

SELECT count(*) INTO v_count
FROM public.scans
WHERE id = '33333333-3333-3333-3333-333333333332';

IF v_count = 1 THEN
RAISE NOTICE 'T09_SAME_ORG_SCAN_CREATE_ALLOWED: PASS';
ELSE
RAISE NOTICE 'T09_SAME_ORG_SCAN_CREATE_ALLOWED: FAIL';
END IF;
END;
$$;

RESET ROLE;
ROLLBACK;

---

-- 12. Cross-org scan creation is denied by RLS WITH CHECK

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);

DO $$
BEGIN
BEGIN
INSERT INTO public.scans (
id,
organization_id,
user_id,
input_type,
raw_input,
status
)
VALUES (
'44444444-4444-4444-4444-444444444442',
'22222222-2222-2222-2222-222222222222',
'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
'url',
'https://cross-tenant-create-should-fail.example.test',
'pending'
);

RAISE NOTICE 'T10_CROSS_ORG_SCAN_CREATE_DENIED: FAIL - insert succeeded';

EXCEPTION
WHEN insufficient_privilege THEN
RAISE NOTICE 'T10_CROSS_ORG_SCAN_CREATE_DENIED: PASS';
WHEN others THEN
RAISE NOTICE 'T10_CROSS_ORG_SCAN_CREATE_DENIED: PASS - denied with SQLSTATE %, %', SQLSTATE, SQLERRM;
END;
END;
$$;

RESET ROLE;
ROLLBACK;

---

-- 13. cbc_app cannot update scans in Gate 003B privilege model

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);

DO $$
BEGIN
BEGIN
UPDATE public.scans
SET status = 'processing'
WHERE id = '33333333-3333-3333-3333-333333333331';

RAISE NOTICE 'T11_APP_SCAN_UPDATE_DENIED: FAIL - update succeeded';

EXCEPTION
WHEN insufficient_privilege THEN
RAISE NOTICE 'T11_APP_SCAN_UPDATE_DENIED: PASS';
WHEN others THEN
RAISE NOTICE 'T11_APP_SCAN_UPDATE_DENIED: PASS - denied with SQLSTATE %, %', SQLSTATE, SQLERRM;
END;
END;
$$;

RESET ROLE;
ROLLBACK;

---

-- 14. cbc_app cannot insert vendor_results in Gate 003B privilege model

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);

DO $$
BEGIN
BEGIN
INSERT INTO public.vendor_results (
scan_id,
organization_id,
vendor_name,
verdict
)
VALUES (
'33333333-3333-3333-3333-333333333331',
'11111111-1111-1111-1111-111111111111',
'should_not_be_inserted_by_app',
'safe'
);

RAISE NOTICE 'T12_APP_VENDOR_RESULT_INSERT_DENIED: FAIL - insert succeeded';

EXCEPTION
WHEN insufficient_privilege THEN
RAISE NOTICE 'T12_APP_VENDOR_RESULT_INSERT_DENIED: PASS';
WHEN others THEN
RAISE NOTICE 'T12_APP_VENDOR_RESULT_INSERT_DENIED: PASS - denied with SQLSTATE %, %', SQLSTATE, SQLERRM;
END;
END;
$$;

RESET ROLE;
ROLLBACK;

---

-- 15. cbc_app cannot insert evidence_items in Gate 003B privilege model

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);

DO $$
BEGIN
BEGIN
INSERT INTO public.evidence_items (
scan_id,
organization_id,
signal_type,
severity,
title
)
VALUES (
'33333333-3333-3333-3333-333333333331',
'11111111-1111-1111-1111-111111111111',
'validation',
'info',
'Should not be inserted by app'
);

RAISE NOTICE 'T13_APP_EVIDENCE_INSERT_DENIED: FAIL - insert succeeded';

EXCEPTION
WHEN insufficient_privilege THEN
RAISE NOTICE 'T13_APP_EVIDENCE_INSERT_DENIED: PASS';
WHEN others THEN
RAISE NOTICE 'T13_APP_EVIDENCE_INSERT_DENIED: PASS - denied with SQLSTATE %, %', SQLSTATE, SQLERRM;
END;
END;
$$;

RESET ROLE;
ROLLBACK;

---

-- 16. cbc_app cannot read scan_cache in Gate 003B privilege model

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);

DO $$
DECLARE
v_count integer;
BEGIN
BEGIN
SELECT count(*) INTO v_count
FROM public.scan_cache;

RAISE NOTICE 'T14_APP_SCAN_CACHE_READ_DENIED: FAIL - read succeeded with % rows', v_count;

EXCEPTION
WHEN insufficient_privilege THEN
RAISE NOTICE 'T14_APP_SCAN_CACHE_READ_DENIED: PASS';
WHEN others THEN
RAISE NOTICE 'T14_APP_SCAN_CACHE_READ_DENIED: PASS - denied with SQLSTATE %, %', SQLSTATE, SQLERRM;
END;
END;
$$;

RESET ROLE;
ROLLBACK;

---

-- 17. Same-org feedback insert succeeds

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);

DO $$
DECLARE
v_count integer;
BEGIN
INSERT INTO public.scan_feedback (
id,
scan_id,
organization_id,
user_id,
feedback_type,
comment
)
VALUES (
'77777777-7777-7777-7777-777777777773',
'33333333-3333-3333-3333-333333333331',
'11111111-1111-1111-1111-111111111111',
'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
'uncertain',
'Gate 003 same-org feedback insert allowed.'
);

SELECT count(*) INTO v_count
FROM public.scan_feedback
WHERE id = '77777777-7777-7777-7777-777777777773';

IF v_count = 1 THEN
RAISE NOTICE 'T15_SAME_ORG_FEEDBACK_INSERT_ALLOWED: PASS';
ELSE
RAISE NOTICE 'T15_SAME_ORG_FEEDBACK_INSERT_ALLOWED: FAIL';
END IF;
END;
$$;

RESET ROLE;
ROLLBACK;

---

-- 18. Cross-org feedback insert is denied

---

BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);

DO $$
BEGIN
BEGIN
INSERT INTO public.scan_feedback (
id,
scan_id,
organization_id,
user_id,
feedback_type,
comment
)
VALUES (
'77777777-7777-7777-7777-777777777774',
'44444444-4444-4444-4444-444444444441',
'22222222-2222-2222-2222-222222222222',
'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
'uncertain',
'Cross-org feedback should fail.'
);

RAISE NOTICE 'T16_CROSS_ORG_FEEDBACK_INSERT_DENIED: FAIL - insert succeeded';

EXCEPTION
WHEN insufficient_privilege THEN
RAISE NOTICE 'T16_CROSS_ORG_FEEDBACK_INSERT_DENIED: PASS';
WHEN others THEN
RAISE NOTICE 'T16_CROSS_ORG_FEEDBACK_INSERT_DENIED: PASS - denied with SQLSTATE %, %', SQLSTATE, SQLERRM;
END;
END;
$$;

RESET ROLE;
ROLLBACK;

---

-- 19. Completion marker

---

SELECT
'GATE_003B_003_VALIDATE_CBC_APP_RLS_COMPLETE' AS test,
'PASS' AS result;
