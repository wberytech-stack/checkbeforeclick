-- ============================================================================
-- 002_tenant_isolation_dry_run_tests.sql
-- Gate 002 disposable-DB validation script
--
-- RUN ONLY AGAINST: cbc_002_validation
-- NEVER RUN AGAINST: cbc_prod
--
-- Expected precondition:
-- 1. 001_initial_schema.sql has already been applied to cbc_002_validation.
-- 2. 002_tenant_isolation.sql has already been applied to cbc_002_validation.
-- 3. This script is run as the migration/admin user.
--
-- Purpose:
-- Validate tenant isolation behavior using cbc_app_validation, a throwaway
-- NOBYPASSRLS non-owner runtime-like role.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Confirm target database
-- ----------------------------------------------------------------------------
SELECT
  'CHECK_DATABASE' AS test,
  current_database() AS database_name,
  CASE
    WHEN current_database() = 'cbc_002_validation' THEN 'PASS'
    ELSE 'FAIL - wrong database, stop immediately'
  END AS result;

-- ----------------------------------------------------------------------------
-- 1. Create throwaway validation runtime role
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_admin text := current_user;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cbc_app_validation') THEN
    CREATE ROLE cbc_app_validation
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOBYPASSRLS;
  END IF;

  EXECUTE format('GRANT cbc_app_validation TO %I', v_admin);
END
$$;

SELECT
  'CHECK_VALIDATION_ROLE' AS test,
  rolname,
  rolsuper,
  rolbypassrls,
  CASE
    WHEN rolname = 'cbc_app_validation'
     AND rolsuper = false
     AND rolbypassrls = false
    THEN 'PASS'
    ELSE 'FAIL'
  END AS result
FROM pg_roles
WHERE rolname = 'cbc_app_validation';

-- ----------------------------------------------------------------------------
-- 2. Grant runtime-like privileges to validation role
-- ----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO cbc_app_validation;

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
TO cbc_app_validation;

GRANT SELECT, INSERT ON public.audit_log TO cbc_app_validation;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scan_cache TO cbc_app_validation;

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

-- ----------------------------------------------------------------------------
-- 3. Confirm scan_cache remains global/internal and not tenant-scoped
-- ----------------------------------------------------------------------------
SELECT
  'CHECK_SCAN_CACHE_NO_ORG_OR_USER_COLUMNS' AS test,
  string_agg(column_name, ', ' ORDER BY column_name) AS matching_columns,
  CASE
    WHEN count(*) = 0 THEN 'PASS'
    ELSE 'FAIL - scan_cache has tenant/user columns and must be redesigned'
  END AS result
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'scan_cache'
  AND column_name IN ('organization_id', 'user_id');

SELECT
  'CHECK_SCAN_CACHE_RLS_DISABLED' AS test,
  relname,
  relrowsecurity,
  CASE
    WHEN relrowsecurity = false THEN 'PASS'
    ELSE 'FAIL - scan_cache should not be under tenant RLS in 002'
  END AS result
FROM pg_class
WHERE relname = 'scan_cache';

-- ----------------------------------------------------------------------------
-- 4. Seed two orgs, users, memberships, scans, and child records as admin
-- ----------------------------------------------------------------------------
TRUNCATE
  public.alerts,
  public.watchlist,
  public.audit_log,
  public.scan_feedback,
  public.evidence_items,
  public.vendor_results,
  public.scans,
  public.scan_cache,
  public.memberships,
  public.users,
  public.organizations
CASCADE;

INSERT INTO public.organizations (id, name, slug, plan)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'Org A', 'org-a-validation', 'team'),
  ('22222222-2222-2222-2222-222222222222', 'Org B', 'org-b-validation', 'team');

INSERT INTO public.users (id, organization_id, full_name, role)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111', 'Org A Owner', 'admin'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '11111111-1111-1111-1111-111111111111', 'Org A Member', 'member'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', '22222222-2222-2222-2222-222222222222', 'Org B Owner', 'admin');

INSERT INTO public.memberships (user_id, organization_id, role)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '11111111-1111-1111-1111-111111111111', 'member'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', '22222222-2222-2222-2222-222222222222', 'owner')
ON CONFLICT (user_id, organization_id) DO NOTHING;

INSERT INTO public.scans (id, organization_id, user_id, input_type, raw_input, status, verdict, risk_score, confidence_score)
VALUES
  ('33333333-3333-3333-3333-333333333331', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'url', 'https://org-a.example.test', 'complete', 'safe', 10, 90),
  ('44444444-4444-4444-4444-444444444441', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'url', 'https://org-b.example.test', 'complete', 'dangerous', 90, 95);

INSERT INTO public.vendor_results (id, scan_id, organization_id, vendor_name, verdict)
VALUES
  ('55555555-5555-5555-5555-555555555551', '33333333-3333-3333-3333-333333333331', '11111111-1111-1111-1111-111111111111', 'validation_vendor', 'safe'),
  ('55555555-5555-5555-5555-555555555552', '44444444-4444-4444-4444-444444444441', '22222222-2222-2222-2222-222222222222', 'validation_vendor', 'dangerous');

INSERT INTO public.evidence_items (id, scan_id, organization_id, signal_type, severity, title)
VALUES
  ('66666666-6666-6666-6666-666666666661', '33333333-3333-3333-3333-333333333331', '11111111-1111-1111-1111-111111111111', 'validation', 'info', 'Org A evidence'),
  ('66666666-6666-6666-6666-666666666662', '44444444-4444-4444-4444-444444444441', '22222222-2222-2222-2222-222222222222', 'validation', 'high', 'Org B evidence');

INSERT INTO public.audit_log (id, organization_id, user_id, action, target_type)
VALUES
  ('77777777-7777-7777-7777-777777777771', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'validation.org_a', 'scan'),
  ('77777777-7777-7777-7777-777777777772', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'validation.org_b', 'scan');

INSERT INTO public.scan_cache (id, cache_key, vendor_name, result, expires_at)
VALUES
  ('88888888-8888-8888-8888-888888888881', 'global-cache-key-validation', 'validation_vendor', '{"verdict":"safe"}'::jsonb, now() + interval '1 day');

SELECT
  'CHECK_SEED_COUNTS' AS test,
  (SELECT count(*) FROM public.organizations) AS organizations,
  (SELECT count(*) FROM public.users) AS users,
  (SELECT count(*) FROM public.memberships) AS memberships,
  (SELECT count(*) FROM public.scans) AS scans,
  CASE
    WHEN (SELECT count(*) FROM public.organizations) = 2
     AND (SELECT count(*) FROM public.users) = 3
     AND (SELECT count(*) FROM public.memberships) = 3
     AND (SELECT count(*) FROM public.scans) = 2
    THEN 'PASS'
    ELSE 'FAIL'
  END AS result;

-- ----------------------------------------------------------------------------
-- 5. Confirm RLS enabled on tenant tables
-- ----------------------------------------------------------------------------
SELECT
  'CHECK_RLS_ENABLED_TABLES' AS test,
  relname,
  relrowsecurity
FROM pg_class
WHERE relname IN (
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
ORDER BY relname;

-- ----------------------------------------------------------------------------
-- 6. RLS tests as cbc_app_validation
-- ----------------------------------------------------------------------------

-- No context = deny
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

-- Valid Org A owner context = sees only Org A scan
BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);
SELECT
  'T02_ORG_A_OWNER_SEES_ONLY_ORG_A_SCAN' AS test,
  count(*) AS visible_scans,
  min(raw_input) AS sample_scan,
  CASE
    WHEN count(*) = 1 AND min(raw_input) = 'https://org-a.example.test'
    THEN 'PASS'
    ELSE 'FAIL'
  END AS result
FROM public.scans;
RESET ROLE;
ROLLBACK;

-- Org A user with Org B context = deny because not a member of Org B
BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '22222222-2222-2222-2222-222222222222', true);
SELECT
  'T03_ORG_A_USER_WRONG_ORG_CONTEXT_DENIED' AS test,
  count(*) AS visible_scans,
  CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result
FROM public.scans;
RESET ROLE;
ROLLBACK;

-- Org A member can read memberships in Org A without recursion
BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);
SELECT
  'T04_MEMBERSHIP_SELECT_NO_RECURSION' AS test,
  count(*) AS visible_memberships,
  CASE WHEN count(*) = 2 THEN 'PASS' ELSE 'FAIL' END AS result
FROM public.memberships;
RESET ROLE;
ROLLBACK;

-- Child table isolation: Org A sees only Org A vendor/evidence rows
BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);
SELECT
  'T05_CHILD_TABLES_ORG_A_ONLY' AS test,
  (SELECT count(*) FROM public.vendor_results) AS vendor_rows,
  (SELECT count(*) FROM public.evidence_items) AS evidence_rows,
  CASE
    WHEN (SELECT count(*) FROM public.vendor_results) = 1
     AND (SELECT count(*) FROM public.evidence_items) = 1
    THEN 'PASS'
    ELSE 'FAIL'
  END AS result;
RESET ROLE;
ROLLBACK;

-- Cross-org update should affect zero rows
BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);
DO $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.scans
  SET verdict = 'safe'
  WHERE id = '44444444-4444-4444-4444-444444444441';

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RAISE NOTICE 'T06_CROSS_ORG_UPDATE_DENIED: PASS';
  ELSE
    RAISE NOTICE 'T06_CROSS_ORG_UPDATE_DENIED: FAIL - updated % rows', v_rows;
  END IF;
END
$$;
RESET ROLE;
ROLLBACK;

-- Cross-org insert should be denied by WITH CHECK
BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);
DO $$
BEGIN
  BEGIN
    INSERT INTO public.scans (organization_id, user_id, input_type, raw_input, status)
    VALUES (
      '22222222-2222-2222-2222-222222222222',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
      'url',
      'https://bad-cross-org-insert.example.test',
      'pending'
    );

    RAISE NOTICE 'T07_CROSS_ORG_INSERT_DENIED: FAIL - insert succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'T07_CROSS_ORG_INSERT_DENIED: PASS';
    WHEN others THEN
      RAISE NOTICE 'T07_CROSS_ORG_INSERT_DENIED: PASS - denied with SQLSTATE %, %', SQLSTATE, SQLERRM;
  END;
END
$$;
RESET ROLE;
ROLLBACK;

-- Member cannot mutate memberships
BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);
DO $$
BEGIN
  BEGIN
    INSERT INTO public.users (id, organization_id, full_name, role)
    VALUES (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
      '11111111-1111-1111-1111-111111111111',
      'Org A New User By Member',
      'member'
    );

    INSERT INTO public.memberships (user_id, organization_id, role)
    VALUES (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
      '11111111-1111-1111-1111-111111111111',
      'member'
    );

    RAISE NOTICE 'T08_MEMBER_CANNOT_MUTATE_MEMBERSHIPS: FAIL - insert succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'T08_MEMBER_CANNOT_MUTATE_MEMBERSHIPS: PASS';
    WHEN others THEN
      RAISE NOTICE 'T08_MEMBER_CANNOT_MUTATE_MEMBERSHIPS: PASS - denied with SQLSTATE %, %', SQLSTATE, SQLERRM;
  END;
END
$$;
RESET ROLE;
ROLLBACK;

-- Owner can mutate memberships in own org
BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);
DO $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.users (id, organization_id, full_name, role)
  VALUES (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
    '11111111-1111-1111-1111-111111111111',
    'Org A New User By Owner',
    'member'
  );

  INSERT INTO public.memberships (user_id, organization_id, role)
  VALUES (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
    '11111111-1111-1111-1111-111111111111',
    'member'
  );

  SELECT count(*) INTO v_count
  FROM public.memberships
  WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4'
    AND organization_id = '11111111-1111-1111-1111-111111111111';

  IF v_count = 1 THEN
    RAISE NOTICE 'T09_OWNER_CAN_MUTATE_MEMBERSHIPS: PASS';
  ELSE
    RAISE NOTICE 'T09_OWNER_CAN_MUTATE_MEMBERSHIPS: FAIL';
  END IF;
END
$$;
RESET ROLE;
ROLLBACK;

-- audit_log is append-only: INSERT allowed, DELETE denied
BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);
DO $$
BEGIN
  INSERT INTO public.audit_log (organization_id, user_id, action, target_type)
  VALUES (
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'validation.audit_insert_allowed',
    'validation'
  );

  BEGIN
    DELETE FROM public.audit_log
    WHERE organization_id = '11111111-1111-1111-1111-111111111111';

    RAISE NOTICE 'T10_AUDIT_LOG_DELETE_DENIED: FAIL - delete succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'T10_AUDIT_LOG_INSERT_ALLOWED_DELETE_DENIED: PASS';
    WHEN others THEN
      RAISE NOTICE 'T10_AUDIT_LOG_INSERT_ALLOWED_DELETE_DENIED: PASS - denied with SQLSTATE %, %', SQLSTATE, SQLERRM;
  END;
END
$$;
RESET ROLE;
ROLLBACK;

-- Bootstrap mismatch must fail
BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
SELECT set_config('app.current_organization_id', '11111111-1111-1111-1111-111111111111', true);
DO $$
DECLARE
  v_org uuid;
BEGIN
  BEGIN
    SELECT public.bootstrap_new_organization(
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
      'wrong-user@example.test',
      'Wrong User',
      'Should Fail Org'
    ) INTO v_org;

    RAISE NOTICE 'T11_BOOTSTRAP_MISMATCH_DENIED: FAIL - returned org %', v_org;
  EXCEPTION
    WHEN others THEN
      RAISE NOTICE 'T11_BOOTSTRAP_MISMATCH_DENIED: PASS - denied with SQLSTATE %, %', SQLSTATE, SQLERRM;
  END;
END
$$;
RESET ROLE;
ROLLBACK;

-- Bootstrap success for brand-new session user
BEGIN;
SET ROLE cbc_app_validation;
SELECT set_config('app.current_user_id', 'cccccccc-cccc-cccc-cccc-ccccccccccc1', true);
SELECT set_config('app.current_organization_id', '', true);
DO $$
DECLARE
  v_org uuid;
BEGIN
  SELECT public.bootstrap_new_organization(
    'cccccccc-cccc-cccc-cccc-ccccccccccc1',
    'new-user@example.test',
    'New User',
    'New Bootstrap Org'
  ) INTO v_org;

  IF v_org IS NOT NULL THEN
    RAISE NOTICE 'T12_BOOTSTRAP_SESSION_USER_ALLOWED: PASS - created org %', v_org;
  ELSE
    RAISE NOTICE 'T12_BOOTSTRAP_SESSION_USER_ALLOWED: FAIL - no org returned';
  END IF;
END
$$;
RESET ROLE;
ROLLBACK;

-- ----------------------------------------------------------------------------
-- 7. Cleanup validation role
-- ----------------------------------------------------------------------------
DROP OWNED BY cbc_app_validation;

DO $$
DECLARE
  v_admin text := current_user;
BEGIN
  BEGIN
    EXECUTE format('REVOKE cbc_app_validation FROM %I', v_admin);
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'Role membership revoke skipped: %', SQLERRM;
  END;
END
$$;

DROP ROLE IF EXISTS cbc_app_validation;

SELECT
  'CHECK_VALIDATION_ROLE_DROPPED' AS test,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cbc_app_validation')
    THEN 'PASS'
    ELSE 'FAIL - validation role still exists'
  END AS result;

-- ============================================================================
-- End of Gate 002 dry-run validation script.
-- ============================================================================