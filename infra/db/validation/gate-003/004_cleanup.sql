-- ============================================================================
-- 004_cleanup.sql
-- Gate 003B disposable-DB cleanup script
--
-- RUN ONLY AGAINST: cbc_003_validation
-- NEVER RUN AGAINST: cbc_prod
--
-- Expected precondition:
-- 1. Gate 003B validation scripts have already run.
-- 2. This script is run as the migration/admin user.
--
-- Purpose:
-- Clean up synthetic Gate 003B validation data and the throwaway validation role.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Confirm target database
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 1. Drop objects owned by validation role, then remove role
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cbc_app_validation') THEN
    DROP OWNED BY cbc_app_validation;
    DROP ROLE cbc_app_validation;
  END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Remove synthetic validation data
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

-- ----------------------------------------------------------------------------
-- 3. Confirm validation role is gone
-- ----------------------------------------------------------------------------
SELECT
  'CHECK_VALIDATION_ROLE_REMOVED' AS test,
  count(*) AS matching_roles,
  CASE
    WHEN count(*) = 0 THEN 'PASS'
    ELSE 'FAIL - validation role still exists'
  END AS result
FROM pg_roles
WHERE rolname = 'cbc_app_validation';

-- ----------------------------------------------------------------------------
-- 4. Confirm validation data is gone
-- ----------------------------------------------------------------------------
SELECT
  'CHECK_GATE_003B_VALIDATION_DATA_REMOVED' AS test,
  (SELECT count(*) FROM public.organizations) AS organizations,
  (SELECT count(*) FROM public.users) AS users,
  (SELECT count(*) FROM public.memberships) AS memberships,
  (SELECT count(*) FROM public.scans) AS scans,
  (SELECT count(*) FROM public.vendor_results) AS vendor_results,
  (SELECT count(*) FROM public.evidence_items) AS evidence_items,
  (SELECT count(*) FROM public.scan_feedback) AS scan_feedback,
  (SELECT count(*) FROM public.watchlist) AS watchlist,
  (SELECT count(*) FROM public.alerts) AS alerts,
  (SELECT count(*) FROM public.audit_log) AS audit_log,
  (SELECT count(*) FROM public.scan_cache) AS scan_cache,
  CASE
    WHEN (SELECT count(*) FROM public.organizations) = 0
     AND (SELECT count(*) FROM public.users) = 0
     AND (SELECT count(*) FROM public.memberships) = 0
     AND (SELECT count(*) FROM public.scans) = 0
     AND (SELECT count(*) FROM public.vendor_results) = 0
     AND (SELECT count(*) FROM public.evidence_items) = 0
     AND (SELECT count(*) FROM public.scan_feedback) = 0
     AND (SELECT count(*) FROM public.watchlist) = 0
     AND (SELECT count(*) FROM public.alerts) = 0
     AND (SELECT count(*) FROM public.audit_log) = 0
     AND (SELECT count(*) FROM public.scan_cache) = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS result;

-- ----------------------------------------------------------------------------
-- 5. Completion marker
-- ----------------------------------------------------------------------------
SELECT
  'GATE_003B_004_CLEANUP_COMPLETE' AS test,
  'PASS' AS result;
  
