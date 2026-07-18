-- ============================================================================
-- 004_validate_write_expansion.sql
-- Gate 003N - Disposable local PostgreSQL validation of the expanded
-- app_record_fast_scan_result function (migration 004).
--
-- Run ONLY against a disposable local PostgreSQL database.
-- Never run against cbc_prod, Azure PostgreSQL, or any real database.
--
-- Prerequisites (applied before this script):
--   001_initial_schema.sql
--   002_tenant_isolation.sql
--   CREATE ROLE cbc_app_validation ...
--   GRANT USAGE ON SCHEMA public TO cbc_app_validation
--   003_fast_path_function.sql
--   004_fast_path_function_write_expansion.sql
--   Seed data: organizations, users, memberships, scans
-- ============================================================================

\set ON_ERROR_STOP on

SELECT 'CHECK_DATABASE' AS test,
       current_database() AS database_name,
       CASE WHEN current_database() = 'gate_003n_validation'
            THEN 'PASS' ELSE 'FAIL - wrong database' END AS result;

DO $check_db$
BEGIN
  IF current_database() <> 'gate_003n_validation' THEN
    RAISE EXCEPTION 'CHECK_DATABASE FAILED: connected to wrong database: %', current_database();
  END IF;
END $check_db$;

-- ----------------------------------------------------------------------------
-- T01: Function exists in pg_proc.
-- ----------------------------------------------------------------------------
SELECT 'T01_FUNCTION_EXISTS' AS test,
       COUNT(*) AS n,
       CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS result
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname = 'app_record_fast_scan_result';

DO $t01$
BEGIN
  IF (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'app_record_fast_scan_result') <> 1 THEN
    RAISE EXCEPTION 'T01_FUNCTION_EXISTS FAILED';
  END IF;
END $t01$;

-- ----------------------------------------------------------------------------
-- T02: SECURITY DEFINER confirmed.
-- ----------------------------------------------------------------------------
SELECT 'T02_SECURITY_DEFINER' AS test,
       p.prosecdef AS is_security_definer,
       CASE WHEN p.prosecdef THEN 'PASS' ELSE 'FAIL' END AS result
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'app_record_fast_scan_result';

DO $t02$
BEGIN
  IF NOT (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'app_record_fast_scan_result') THEN
    RAISE EXCEPTION 'T02_SECURITY_DEFINER FAILED';
  END IF;
END $t02$;

-- ----------------------------------------------------------------------------
-- T03: Owner is not cbc_app_validation.
-- ----------------------------------------------------------------------------
SELECT 'T03_OWNER_NOT_CBC_APP_VALIDATION' AS test,
       pg_get_userbyid(p.proowner) AS owner_role,
       CASE WHEN pg_get_userbyid(p.proowner) <> 'cbc_app_validation'
            THEN 'PASS' ELSE 'FAIL' END AS result
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'app_record_fast_scan_result';

DO $t03$
BEGIN
  IF (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'app_record_fast_scan_result') = 'cbc_app_validation' THEN
    RAISE EXCEPTION 'T03_OWNER_NOT_CBC_APP_VALIDATION FAILED';
  END IF;
END $t03$;

-- ----------------------------------------------------------------------------
-- T04: search_path locked to public, pg_temp.
-- ----------------------------------------------------------------------------
SELECT 'T04_SEARCH_PATH_LOCKED' AS test,
       p.proconfig AS proconfig,
       CASE WHEN p.proconfig @> ARRAY['search_path=public, pg_temp']
            THEN 'PASS' ELSE 'FAIL' END AS result
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'app_record_fast_scan_result';

DO $t04$
BEGIN
  IF NOT (SELECT p.proconfig @> ARRAY['search_path=public, pg_temp']
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'app_record_fast_scan_result') THEN
    RAISE EXCEPTION 'T04_SEARCH_PATH_LOCKED FAILED';
  END IF;
END $t04$;

-- ----------------------------------------------------------------------------
-- T05: organization_id absent from argument list.
-- ----------------------------------------------------------------------------
SELECT 'T05_NO_ORG_ID_PARAM' AS test,
       CASE WHEN position('organization_id' in
                  pg_get_function_arguments(p.oid)) = 0
            THEN 'PASS' ELSE 'FAIL' END AS result
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'app_record_fast_scan_result';

DO $t05$
BEGIN
  IF (SELECT position('organization_id' in pg_get_function_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'app_record_fast_scan_result') <> 0 THEN
    RAISE EXCEPTION 'T05_NO_ORG_ID_PARAM FAILED';
  END IF;
END $t05$;

-- ----------------------------------------------------------------------------
-- T06: EXECUTE revoked from PUBLIC.
-- ----------------------------------------------------------------------------
SELECT 'T06_EXECUTE_REVOKED_FROM_PUBLIC' AS test,
       has_function_privilege('public',
         'public.app_record_fast_scan_result(uuid,text,text,integer,integer,text,text,integer,jsonb,jsonb,text)',
         'EXECUTE') AS public_can_execute,
       CASE WHEN NOT has_function_privilege('public',
         'public.app_record_fast_scan_result(uuid,text,text,integer,integer,text,text,integer,jsonb,jsonb,text)',
         'EXECUTE')
            THEN 'PASS' ELSE 'FAIL' END AS result;

DO $t06$
BEGIN
  IF has_function_privilege('public',
       'public.app_record_fast_scan_result(uuid,text,text,integer,integer,text,text,integer,jsonb,jsonb,text)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'T06_EXECUTE_REVOKED_FROM_PUBLIC FAILED';
  END IF;
END $t06$;

-- ----------------------------------------------------------------------------
-- T07: EXECUTE granted to cbc_app_validation.
-- ----------------------------------------------------------------------------
SELECT 'T07_EXECUTE_GRANTED_TO_VALIDATION_ROLE' AS test,
       has_function_privilege('cbc_app_validation',
         'public.app_record_fast_scan_result(uuid,text,text,integer,integer,text,text,integer,jsonb,jsonb,text)',
         'EXECUTE') AS validation_can_execute,
       CASE WHEN has_function_privilege('cbc_app_validation',
         'public.app_record_fast_scan_result(uuid,text,text,integer,integer,text,text,integer,jsonb,jsonb,text)',
         'EXECUTE')
            THEN 'PASS' ELSE 'FAIL' END AS result;

DO $t07$
BEGIN
  IF NOT has_function_privilege('cbc_app_validation',
       'public.app_record_fast_scan_result(uuid,text,text,integer,integer,text,text,integer,jsonb,jsonb,text)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'T07_EXECUTE_GRANTED_TO_VALIDATION_ROLE FAILED';
  END IF;
END $t07$;
-- ----------------------------------------------------------------------------
-- T08: Missing app.current_user_id fails closed before any write.
-- ----------------------------------------------------------------------------
DO $t08$
DECLARE v_raised boolean := false; v_msg text;
BEGIN
  PERFORM set_config('app.current_user_id', '', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90,
      'No threats.', 'Safe to proceed.', 250,
      '[{"vendor_name":"vt","verdict":"safe"}]'::jsonb,
      '[{"signal_type":"domain_age","severity":"low","title":"Young domain"}]'::jsonb,
      NULL
    );
  EXCEPTION WHEN others THEN
    v_raised := true; v_msg := SQLERRM;
  END;
  RESET ROLE;
  RAISE NOTICE 'T08_MISSING_USER_GUC result: % (msg: %)',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(v_msg, '<no exception>');
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T08_MISSING_USER_GUC FAILED: function did not refuse missing user context';
  END IF;
END $t08$;

-- ----------------------------------------------------------------------------
-- T09: Missing app.current_organization_id fails closed before any write.
-- ----------------------------------------------------------------------------
DO $t09$
DECLARE v_raised boolean := false; v_msg text;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id', '', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90,
      'No threats.', 'Safe to proceed.', 250,
      '[{"vendor_name":"vt","verdict":"safe"}]'::jsonb,
      '[{"signal_type":"domain_age","severity":"low","title":"Young domain"}]'::jsonb,
      NULL
    );
  EXCEPTION WHEN others THEN
    v_raised := true; v_msg := SQLERRM;
  END;
  RESET ROLE;
  RAISE NOTICE 'T09_MISSING_ORG_GUC result: % (msg: %)',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(v_msg, '<no exception>');
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T09_MISSING_ORG_GUC FAILED: function did not refuse missing org context';
  END IF;
END $t09$;

-- ----------------------------------------------------------------------------
-- T10: Cross-tenant scan id refused (Org B scan with Org A context).
-- ----------------------------------------------------------------------------
DO $t10$
DECLARE v_raised boolean := false; v_msg text;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5cb22222-0000-0000-0000-000000000002',
      'complete', 'safe', 10, 90,
      'No threats.', 'Safe to proceed.', 250,
      '[{"vendor_name":"vt","verdict":"safe"}]'::jsonb,
      '[{"signal_type":"domain_age","severity":"low","title":"Young domain"}]'::jsonb,
      NULL
    );
  EXCEPTION WHEN others THEN
    v_raised := true; v_msg := SQLERRM;
  END;
  RESET ROLE;
  RAISE NOTICE 'T10_CROSS_TENANT_REFUSED result: % (msg: %)',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(v_msg, '<no exception>');
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T10_CROSS_TENANT_REFUSED FAILED';
  END IF;
END $t10$;

-- ----------------------------------------------------------------------------
-- T11: Non-member access refused.
-- ----------------------------------------------------------------------------
DO $t11$
DECLARE v_raised boolean := false; v_msg text;
BEGIN
  -- Use a user UUID that has no membership row.
  PERFORM set_config('app.current_user_id',
    'ffffffff-0000-0000-0000-000000000099', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90,
      'No threats.', 'Safe to proceed.', 250,
      '[{"vendor_name":"vt","verdict":"safe"}]'::jsonb,
      '[{"signal_type":"domain_age","severity":"low","title":"Young domain"}]'::jsonb,
      NULL
    );
  EXCEPTION WHEN others THEN
    v_raised := true; v_msg := SQLERRM;
  END;
  RESET ROLE;
  RAISE NOTICE 'T11_NON_MEMBER_REFUSED result: % (msg: %)',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(v_msg, '<no exception>');
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T11_NON_MEMBER_REFUSED FAILED';
  END IF;
END $t11$;
-- ----------------------------------------------------------------------------
-- T12: p_status complete accepted.
-- T13: p_status failed accepted.
-- Both use separate fresh scan rows inserted and rolled back so the main
-- seed scan remains pending for later write tests.
-- ----------------------------------------------------------------------------
DO $t12$
DECLARE v_result uuid;
BEGIN
  INSERT INTO public.scans (id, organization_id, user_id, input_type, raw_input, status)
  VALUES ('01200000-0000-0000-0000-000000000012',
    'aaaaaaaa-0000-0000-0000-000000000001',
    'a1111111-0000-0000-0000-000000000001',
    'url', 'http://t12.example', 'pending');
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  SELECT public.app_record_fast_scan_result(
    '01200000-0000-0000-0000-000000000012',
    'complete', 'safe', 10, 90,
    'No threats.', 'Safe to proceed.', NULL,
    '[]'::jsonb, '[]'::jsonb, NULL
  ) INTO v_result;
  RESET ROLE;
  RAISE NOTICE 'T12_STATUS_COMPLETE_ACCEPTED result: %',
    CASE WHEN v_result = '01200000-0000-0000-0000-000000000012'
         THEN 'PASS' ELSE 'FAIL' END;
  IF v_result <> '01200000-0000-0000-0000-000000000012' THEN
    RAISE EXCEPTION 'T12_STATUS_COMPLETE_ACCEPTED FAILED';
  END IF;
END $t12$;

DO $t13$
DECLARE v_result uuid;
BEGIN
  INSERT INTO public.scans (id, organization_id, user_id, input_type, raw_input, status)
  VALUES ('01300000-0000-0000-0000-000000000013',
    'aaaaaaaa-0000-0000-0000-000000000001',
    'a1111111-0000-0000-0000-000000000001',
    'url', 'http://t13.example', 'pending');
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  SELECT public.app_record_fast_scan_result(
    '01300000-0000-0000-0000-000000000013',
    'failed', NULL, NULL, NULL,
    NULL, NULL, NULL,
    '[]'::jsonb, '[]'::jsonb, 'scan failed'
  ) INTO v_result;
  RESET ROLE;
  RAISE NOTICE 'T13_STATUS_FAILED_ACCEPTED result: %',
    CASE WHEN v_result = '01300000-0000-0000-0000-000000000013'
         THEN 'PASS' ELSE 'FAIL' END;
  IF v_result <> '01300000-0000-0000-0000-000000000013' THEN
    RAISE EXCEPTION 'T13_STATUS_FAILED_ACCEPTED FAILED';
  END IF;
END $t13$;

-- ----------------------------------------------------------------------------
-- T14?T31: Payload validation ? all must fail before any write.
-- Each uses a BEGIN/EXCEPTION block to catch the expected exception.
-- ----------------------------------------------------------------------------

DO $t14$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'pending', 'safe', 10, 90,
      'x', 'x', NULL, '[]'::jsonb, '[]'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T14_STATUS_PENDING_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T14_STATUS_PENDING_REJECTED FAILED';
  END IF;
END $t14$;

DO $t15$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'processing', 'safe', 10, 90,
      'x', 'x', NULL, '[]'::jsonb, '[]'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T15_STATUS_PROCESSING_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T15_STATUS_PROCESSING_REJECTED FAILED';
  END IF;
END $t15$;

DO $t16$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'INVALID_VERDICT', 10, 90,
      'x', 'x', NULL, '[]'::jsonb, '[]'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T16_INVALID_VERDICT_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T16_INVALID_VERDICT_REJECTED FAILED';
  END IF;
END $t16$;

DO $t17$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 999, 90,
      'x', 'x', NULL, '[]'::jsonb, '[]'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T17_RISK_SCORE_OUT_OF_RANGE result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T17_RISK_SCORE_OUT_OF_RANGE FAILED';
  END IF;
END $t17$;

DO $t18$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, -5,
      'x', 'x', NULL, '[]'::jsonb, '[]'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T18_CONFIDENCE_SCORE_OUT_OF_RANGE result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T18_CONFIDENCE_SCORE_OUT_OF_RANGE FAILED';
  END IF;
END $t18$;

DO $t19$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90,
      'x', 'x', -1, '[]'::jsonb, '[]'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T19_NEGATIVE_DURATION_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T19_NEGATIVE_DURATION_REJECTED FAILED';
  END IF;
END $t19$;

DO $t20$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90,
      'x', 'x', NULL, NULL, '[]'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T20_VENDOR_RESULTS_NULL_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T20_VENDOR_RESULTS_NULL_REJECTED FAILED';
  END IF;
END $t20$;

DO $t21$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90,
      'x', 'x', NULL, '[]'::jsonb, NULL, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T21_EVIDENCE_ITEMS_NULL_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T21_EVIDENCE_ITEMS_NULL_REJECTED FAILED';
  END IF;
END $t21$;

DO $t22$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90,
      'x', 'x', NULL, '{"not":"an array"}'::jsonb, '[]'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T22_VENDOR_RESULTS_NOT_ARRAY_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T22_VENDOR_RESULTS_NOT_ARRAY_REJECTED FAILED';
  END IF;
END $t22$;

DO $t23$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90,
      'x', 'x', NULL, '[]'::jsonb, '"not_an_array"'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T23_EVIDENCE_ITEMS_NOT_ARRAY_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T23_EVIDENCE_ITEMS_NOT_ARRAY_REJECTED FAILED';
  END IF;
END $t23$;

DO $t24$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90,
      'x', 'x', NULL, '["not_an_object"]'::jsonb, '[]'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T24_VENDOR_ENTRY_NOT_OBJECT_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T24_VENDOR_ENTRY_NOT_OBJECT_REJECTED FAILED';
  END IF;
END $t24$;

DO $t25$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90,
      'x', 'x', NULL, '[]'::jsonb, '[42]'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T25_EVIDENCE_ENTRY_NOT_OBJECT_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T25_EVIDENCE_ENTRY_NOT_OBJECT_REJECTED FAILED';
  END IF;
END $t25$;

DO $t26$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90, 'x', 'x', NULL,
      '[{"verdict":"safe"}]'::jsonb, '[]'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T26_MISSING_VENDOR_NAME_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T26_MISSING_VENDOR_NAME_REJECTED FAILED';
  END IF;
END $t26$;

DO $t27$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90, 'x', 'x', NULL,
      '[]'::jsonb,
      '[{"severity":"low","title":"t"}]'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T27_MISSING_SIGNAL_TYPE_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T27_MISSING_SIGNAL_TYPE_REJECTED FAILED';
  END IF;
END $t27$;

DO $t28$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90, 'x', 'x', NULL,
      '[]'::jsonb,
      '[{"signal_type":"domain_age","severity":"low"}]'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T28_MISSING_TITLE_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T28_MISSING_TITLE_REJECTED FAILED';
  END IF;
END $t28$;

DO $t29$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90, 'x', 'x', NULL,
      '[]'::jsonb,
      '[{"signal_type":"s","severity":"INVALID","title":"t"}]'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T29_INVALID_SEVERITY_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T29_INVALID_SEVERITY_REJECTED FAILED';
  END IF;
END $t29$;

DO $t30$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90, 'x', 'x', NULL,
      '[{"vendor_name":"vt","response_time_ms":"not_a_number"}]'::jsonb,
      '[]'::jsonb, NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T30_NON_INTEGER_RESPONSE_TIME_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T30_NON_INTEGER_RESPONSE_TIME_REJECTED FAILED';
  END IF;
END $t30$;

DO $t31$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90, 'x', 'x', NULL,
      '[]'::jsonb,
      '[{"signal_type":"s","severity":"low","title":"t","score_impact":"bad"}]'::jsonb,
      NULL);
  EXCEPTION WHEN others THEN v_raised := true;
  END;
  RESET ROLE;
  RAISE NOTICE 'T31_NON_INTEGER_SCORE_IMPACT_REJECTED result: %',
    CASE WHEN v_raised THEN 'PASS' ELSE 'FAIL' END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T31_NON_INTEGER_SCORE_IMPACT_REJECTED FAILED';
  END IF;
END $t31$;
-- ----------------------------------------------------------------------------
-- T32: scans row updated to expected final state.
-- T33: vendor_results row inserted with correct fields.
-- T34: evidence_items row inserted with correct fields.
-- These commit the main seed scan to complete. T35-T37 use fresh scan rows.
-- ----------------------------------------------------------------------------
DO $t32_34$
DECLARE
  v_result      uuid;
  v_status      text;
  v_verdict     text;
  v_risk        integer;
  v_conf        integer;
  v_completed   timestamptz;
  v_vcount      integer;
  v_ecount      integer;
  v_vendor_name text;
  v_vverdict    text;
  v_sig_type    text;
  v_severity    text;
  v_title       text;
  v_org_v       uuid;
  v_org_e       uuid;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;

  SELECT public.app_record_fast_scan_result(
    '5ca11111-0000-0000-0000-000000000001',
    'complete', 'safe', 15, 85,
    'No threats detected.', 'Safe to proceed.', 300,
    '[{"vendor_name":"virustotal","verdict":"safe","response_time_ms":250}]'::jsonb,
    '[{"signal_type":"domain_age","severity":"low","title":"Young domain","score_impact":5}]'::jsonb,
    NULL
  ) INTO v_result;
  RESET ROLE;

  -- T32: scans row updated correctly.
  SELECT status, verdict, risk_score, confidence_score, completed_at
    INTO v_status, v_verdict, v_risk, v_conf, v_completed
    FROM public.scans
   WHERE id = '5ca11111-0000-0000-0000-000000000001';

  RAISE NOTICE 'T32_SCANS_ROW_UPDATED result: %',
    CASE WHEN v_status = 'complete'
          AND v_verdict = 'safe'
          AND v_risk = 15
          AND v_conf = 85
          AND v_completed IS NOT NULL
         THEN 'PASS' ELSE 'FAIL' END;
  IF NOT (v_status = 'complete' AND v_verdict = 'safe'
          AND v_risk = 15 AND v_conf = 85 AND v_completed IS NOT NULL) THEN
    RAISE EXCEPTION 'T32_SCANS_ROW_UPDATED FAILED: status=% verdict=% risk=% conf=% completed=%',
      v_status, v_verdict, v_risk, v_conf, v_completed;
  END IF;

  -- T33: vendor_results row inserted correctly.
  SELECT COUNT(*), MAX(vendor_name), MAX(verdict), MAX(organization_id)
    INTO v_vcount, v_vendor_name, v_vverdict, v_org_v
    FROM public.vendor_results
   WHERE scan_id = '5ca11111-0000-0000-0000-000000000001';

  RAISE NOTICE 'T33_VENDOR_RESULTS_INSERTED result: %',
    CASE WHEN v_vcount = 1
          AND v_vendor_name = 'virustotal'
          AND v_vverdict = 'safe'
          AND v_org_v = 'aaaaaaaa-0000-0000-0000-000000000001'
         THEN 'PASS' ELSE 'FAIL' END;
  IF NOT (v_vcount = 1 AND v_vendor_name = 'virustotal'
          AND v_vverdict = 'safe'
          AND v_org_v = 'aaaaaaaa-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'T33_VENDOR_RESULTS_INSERTED FAILED: count=% name=% verdict=% org=%',
      v_vcount, v_vendor_name, v_vverdict, v_org_v;
  END IF;

  -- T34: evidence_items row inserted correctly.
  SELECT COUNT(*), MAX(signal_type), MAX(severity), MAX(title), MAX(organization_id)
    INTO v_ecount, v_sig_type, v_severity, v_title, v_org_e
    FROM public.evidence_items
   WHERE scan_id = '5ca11111-0000-0000-0000-000000000001';

  RAISE NOTICE 'T34_EVIDENCE_ITEMS_INSERTED result: %',
    CASE WHEN v_ecount = 1
          AND v_sig_type = 'domain_age'
          AND v_severity = 'low'
          AND v_title = 'Young domain'
          AND v_org_e = 'aaaaaaaa-0000-0000-0000-000000000001'
         THEN 'PASS' ELSE 'FAIL' END;
  IF NOT (v_ecount = 1 AND v_sig_type = 'domain_age'
          AND v_severity = 'low' AND v_title = 'Young domain'
          AND v_org_e = 'aaaaaaaa-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'T34_EVIDENCE_ITEMS_INSERTED FAILED: count=% sig=% sev=% title=% org=%',
      v_ecount, v_sig_type, v_severity, v_title, v_org_e;
  END IF;
END $t32_34$;

-- ----------------------------------------------------------------------------
-- T35: Multiple providers/evidence items in one call.
-- ----------------------------------------------------------------------------
DO $t35$
DECLARE v_vcount integer; v_ecount integer;
BEGIN
  INSERT INTO public.scans (id, organization_id, user_id, input_type, raw_input, status)
  VALUES ('03500000-0000-0000-0000-000000000035',
    'aaaaaaaa-0000-0000-0000-000000000001',
    'a1111111-0000-0000-0000-000000000001',
    'url', 'http://t35.example', 'pending');

  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;

  PERFORM public.app_record_fast_scan_result(
    '03500000-0000-0000-0000-000000000035',
    'complete', 'suspicious', 60, 70,
    'Some signals.', 'Use caution.', NULL,
    '[{"vendor_name":"vt","verdict":"safe"},{"vendor_name":"gsc","verdict":"suspicious"}]'::jsonb,
    '[{"signal_type":"domain_age","severity":"low","title":"Young"},{"signal_type":"redirect","severity":"medium","title":"Redirect chain"}]'::jsonb,
    NULL
  );
  RESET ROLE;

  SELECT COUNT(*) INTO v_vcount FROM public.vendor_results
   WHERE scan_id = '03500000-0000-0000-0000-000000000035';
  SELECT COUNT(*) INTO v_ecount FROM public.evidence_items
   WHERE scan_id = '03500000-0000-0000-0000-000000000035';

  RAISE NOTICE 'T35_MULTIPLE_PROVIDERS result: %',
    CASE WHEN v_vcount = 2 AND v_ecount = 2 THEN 'PASS' ELSE 'FAIL' END;
  IF NOT (v_vcount = 2 AND v_ecount = 2) THEN
    RAISE EXCEPTION 'T35_MULTIPLE_PROVIDERS FAILED: vendors=% evidence=%', v_vcount, v_ecount;
  END IF;
END $t35$;

-- ----------------------------------------------------------------------------
-- T36: Empty p_vendor_results - no vendor rows, scan still updated.
-- ----------------------------------------------------------------------------
DO $t36$
DECLARE v_vcount integer; v_status text;
BEGIN
  INSERT INTO public.scans (id, organization_id, user_id, input_type, raw_input, status)
  VALUES ('03600000-0000-0000-0000-000000000036',
    'aaaaaaaa-0000-0000-0000-000000000001',
    'a1111111-0000-0000-0000-000000000001',
    'url', 'http://t36.example', 'pending');

  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;

  PERFORM public.app_record_fast_scan_result(
    '03600000-0000-0000-0000-000000000036',
    'complete', 'unknown', 0, 0,
    'No vendors checked.', 'Use caution.', NULL,
    '[]'::jsonb,
    '[{"signal_type":"domain_age","severity":"low","title":"Young"}]'::jsonb,
    NULL
  );
  RESET ROLE;

  SELECT COUNT(*) INTO v_vcount FROM public.vendor_results
   WHERE scan_id = '03600000-0000-0000-0000-000000000036';
  SELECT status INTO v_status FROM public.scans
   WHERE id = '03600000-0000-0000-0000-000000000036';

  RAISE NOTICE 'T36_EMPTY_VENDOR_RESULTS result: %',
    CASE WHEN v_vcount = 0 AND v_status = 'complete' THEN 'PASS' ELSE 'FAIL' END;
  IF NOT (v_vcount = 0 AND v_status = 'complete') THEN
    RAISE EXCEPTION 'T36_EMPTY_VENDOR_RESULTS FAILED: vendors=% status=%', v_vcount, v_status;
  END IF;
END $t36$;

-- ----------------------------------------------------------------------------
-- T37: Empty p_evidence_items - no evidence rows, scan still updated.
-- ----------------------------------------------------------------------------
DO $t37$
DECLARE v_ecount integer; v_status text;
BEGIN
  INSERT INTO public.scans (id, organization_id, user_id, input_type, raw_input, status)
  VALUES ('03700000-0000-0000-0000-000000000037',
    'aaaaaaaa-0000-0000-0000-000000000001',
    'a1111111-0000-0000-0000-000000000001',
    'url', 'http://t37.example', 'pending');

  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;

  PERFORM public.app_record_fast_scan_result(
    '03700000-0000-0000-0000-000000000037',
    'complete', 'safe', 5, 95,
    'Clean.', 'Safe to proceed.', NULL,
    '[{"vendor_name":"vt","verdict":"safe"}]'::jsonb,
    '[]'::jsonb,
    NULL
  );
  RESET ROLE;

  SELECT COUNT(*) INTO v_ecount FROM public.evidence_items
   WHERE scan_id = '03700000-0000-0000-0000-000000000037';
  SELECT status INTO v_status FROM public.scans
   WHERE id = '03700000-0000-0000-0000-000000000037';

  RAISE NOTICE 'T37_EMPTY_EVIDENCE_ITEMS result: %',
    CASE WHEN v_ecount = 0 AND v_status = 'complete' THEN 'PASS' ELSE 'FAIL' END;
  IF NOT (v_ecount = 0 AND v_status = 'complete') THEN
    RAISE EXCEPTION 'T37_EMPTY_EVIDENCE_ITEMS FAILED: evidence=% status=%', v_ecount, v_status;
  END IF;
END $t37$;
-- ----------------------------------------------------------------------------
-- T38: Rollback after forced post-UPDATE failure.
--
-- Method: install a sabotage trigger on vendor_results that raises an
-- exception on INSERT. The function will update scans first, then attempt
-- the vendor_results insert, hit the trigger, and the entire caller
-- transaction rolls back - including the scans UPDATE.
--
-- Structure: three separate transactions.
--   Tx1: insert T38 scan + create sabotage trigger/function (committed).
--   Tx2: call app_record_fast_scan_result (expected to roll back).
--   Tx3: verify scan still pending, no child rows, then clean up.
-- ----------------------------------------------------------------------------

-- Tx1: setup
BEGIN;
INSERT INTO public.scans (id, organization_id, user_id, input_type, raw_input, status)
VALUES ('03800000-0000-0000-0000-000000000038',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'a1111111-0000-0000-0000-000000000001',
  'url', 'http://t38.example', 'pending');

CREATE OR REPLACE FUNCTION public._t38_sabotage_vendor_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 't38_sabotage: deliberate vendor_results insert failure';
END;
$$;

CREATE TRIGGER t38_sabotage_trigger
BEFORE INSERT ON public.vendor_results
FOR EACH ROW EXECUTE FUNCTION public._t38_sabotage_vendor_insert();
COMMIT;

-- Tx2: the test call - expected to roll back entirely
DO $t38_call$
DECLARE v_raised boolean := false; v_msg text;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '03800000-0000-0000-0000-000000000038',
      'complete', 'safe', 10, 90,
      'No threats.', 'Safe.', NULL,
      '[{"vendor_name":"vt","verdict":"safe"}]'::jsonb,
      '[{"signal_type":"domain_age","severity":"low","title":"Young"}]'::jsonb,
      NULL
    );
  EXCEPTION WHEN others THEN
    v_raised := true; v_msg := SQLERRM;
  END;
  RESET ROLE;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T38 setup error: expected sabotage exception was not raised';
  END IF;
  IF v_msg NOT LIKE '%t38_sabotage%' THEN
    RAISE EXCEPTION 'T38 setup error: wrong exception raised: %', v_msg;
  END IF;
END $t38_call$;

-- Tx3: verify rollback and clean up
DO $t38_verify$
DECLARE
  v_status    text;
  v_completed timestamptz;
  v_vcount    integer;
  v_ecount    integer;
BEGIN
  SELECT status, completed_at INTO v_status, v_completed
    FROM public.scans
   WHERE id = '03800000-0000-0000-0000-000000000038';

  SELECT COUNT(*) INTO v_vcount FROM public.vendor_results
   WHERE scan_id = '03800000-0000-0000-0000-000000000038';

  SELECT COUNT(*) INTO v_ecount FROM public.evidence_items
   WHERE scan_id = '03800000-0000-0000-0000-000000000038';

  RAISE NOTICE 'T38_ROLLBACK_AFTER_POST_UPDATE_FAILURE result: %',
    CASE WHEN v_status = 'pending'
          AND v_completed IS NULL
          AND v_vcount = 0
          AND v_ecount = 0
         THEN 'PASS' ELSE 'FAIL' END;

  IF NOT (v_status = 'pending' AND v_completed IS NULL
          AND v_vcount = 0 AND v_ecount = 0) THEN
    RAISE EXCEPTION 'T38_ROLLBACK FAILED: status=% completed=% vendors=% evidence=%',
      v_status, v_completed, v_vcount, v_ecount;
  END IF;

  -- Clean up T38 scan and sabotage objects.
  DROP TRIGGER IF EXISTS t38_sabotage_trigger ON public.vendor_results;
  DROP FUNCTION IF EXISTS public._t38_sabotage_vendor_insert();
  DELETE FROM public.scans WHERE id = '03800000-0000-0000-0000-000000000038';
END $t38_verify$;

-- ----------------------------------------------------------------------------
-- T39: Repeated call after scan is complete - rejected, no duplicates.
-- Uses the main seed scan which T32-T34 already committed to complete.
-- ----------------------------------------------------------------------------
DO $t39$
DECLARE
  v_raised  boolean := false;
  v_msg     text;
  v_vcount  integer;
  v_ecount  integer;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'complete', 'safe', 10, 90,
      'No threats.', 'Safe.', NULL,
      '[{"vendor_name":"vt2","verdict":"safe"}]'::jsonb,
      '[{"signal_type":"redirect","severity":"low","title":"Redirect"}]'::jsonb,
      NULL
    );
  EXCEPTION WHEN others THEN
    v_raised := true; v_msg := SQLERRM;
  END;
  RESET ROLE;

  -- Confirm no duplicate child rows were inserted.
  SELECT COUNT(*) INTO v_vcount FROM public.vendor_results
   WHERE scan_id = '5ca11111-0000-0000-0000-000000000001'
     AND vendor_name = 'vt2';
  SELECT COUNT(*) INTO v_ecount FROM public.evidence_items
   WHERE scan_id = '5ca11111-0000-0000-0000-000000000001'
     AND signal_type = 'redirect';

  RAISE NOTICE 'T39_REPEATED_COMPLETE_REJECTED result: % (msg: %)',
    CASE WHEN v_raised AND v_vcount = 0 AND v_ecount = 0
         THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(v_msg, '<no exception>');

  IF NOT (v_raised AND v_vcount = 0 AND v_ecount = 0) THEN
    RAISE EXCEPTION 'T39_REPEATED_COMPLETE_REJECTED FAILED: raised=% dup_vendors=% dup_evidence=%',
      v_raised, v_vcount, v_ecount;
  END IF;
END $t39$;

-- ----------------------------------------------------------------------------
-- T40: Repeated call after scan is failed - rejected, no duplicates.
-- Uses the t13 scan which T13 committed to failed status.
-- ----------------------------------------------------------------------------
DO $t40$
DECLARE
  v_raised  boolean := false;
  v_msg     text;
  v_vcount  integer;
BEGIN
  PERFORM set_config('app.current_user_id',
    'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id',
    'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '01300000-0000-0000-0000-000000000013',
      'complete', 'safe', 10, 90,
      'No threats.', 'Safe.', NULL,
      '[{"vendor_name":"vt","verdict":"safe"}]'::jsonb,
      '[]'::jsonb,
      NULL
    );
  EXCEPTION WHEN others THEN
    v_raised := true; v_msg := SQLERRM;
  END;
  RESET ROLE;

  SELECT COUNT(*) INTO v_vcount FROM public.vendor_results
   WHERE scan_id = '01300000-0000-0000-0000-000000000013';

  RAISE NOTICE 'T40_REPEATED_FAILED_REJECTED result: % (msg: %)',
    CASE WHEN v_raised AND v_vcount = 0
         THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(v_msg, '<no exception>');

  IF NOT (v_raised AND v_vcount = 0) THEN
    RAISE EXCEPTION 'T40_REPEATED_FAILED_REJECTED FAILED: raised=% dup_vendors=%',
      v_raised, v_vcount;
  END IF;
END $t40$;

-- ----------------------------------------------------------------------------
-- T41: Transaction-local GUCs do not leak across transactions.
-- ----------------------------------------------------------------------------
DO $t41$
DECLARE v_leaked text;
BEGIN
  -- current_setting with missing_ok=true returns '' if not set.
  v_leaked := current_setting('app.current_user_id', true);
  RAISE NOTICE 'T41_GUC_NO_LEAK result: % (value: [%])',
    CASE WHEN v_leaked IS NULL OR v_leaked = ''
         THEN 'PASS' ELSE 'FAIL - GUC leaked' END,
    COALESCE(v_leaked, 'NULL');
  IF v_leaked IS NOT NULL AND v_leaked <> '' THEN
    RAISE EXCEPTION 'T41_GUC_NO_LEAK FAILED: app.current_user_id leaked value: %', v_leaked;
  END IF;
END $t41$;
-- ----------------------------------------------------------------------------
-- All tests complete.
-- ----------------------------------------------------------------------------
SELECT 'GATE_003N_WRITE_EXPANSION_VALIDATION_COMPLETE' AS test,
       'DONE' AS result;

\unset ON_ERROR_STOP
