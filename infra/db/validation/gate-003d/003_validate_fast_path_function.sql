-- ============================================================================
-- gate-003d/003_validate_fast_path_function.sql  (SLICE 1: boundary only)
-- Run INSIDE psql against the DISPOSABLE DB cbc_003d_validation ONLY.
-- NEVER run against cbc_prod.
-- T08 and T10 assert the SPECIFIC refusal message via SQLERRM.
-- ============================================================================

SELECT 'CHECK_DATABASE' AS test, current_database() AS database_name,
  CASE WHEN current_database() = 'cbc_003d_validation'
       THEN 'PASS' ELSE 'FAIL - wrong database, stop immediately' END AS result;

DO $guard$
BEGIN
  IF current_database() <> 'cbc_003d_validation' THEN
    RAISE EXCEPTION 'Refusing to run outside cbc_003d_validation. Current: %', current_database();
  END IF;
END $guard$;

SELECT 'T01_FUNCTION_EXISTS' AS test, count(*) AS n,
  CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS result
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'app_record_fast_scan_result';

SELECT 'T02_SECURITY_DEFINER' AS test, p.prosecdef AS is_security_definer,
  CASE WHEN p.prosecdef THEN 'PASS' ELSE 'FAIL' END AS result
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'app_record_fast_scan_result';

SELECT 'T03_OWNER_NOT_CBC_APP' AS test, pg_get_userbyid(p.proowner) AS owner_role,
  CASE WHEN pg_get_userbyid(p.proowner) <> 'cbc_app' THEN 'PASS' ELSE 'FAIL' END AS result
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'app_record_fast_scan_result';

SELECT 'T04_SEARCH_PATH_LOCKED' AS test, p.proconfig AS proconfig,
  CASE WHEN p.proconfig @> ARRAY['search_path=public, pg_temp'] THEN 'PASS'
       ELSE 'FAIL - search_path not locked' END AS result
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'app_record_fast_scan_result';

SELECT 'T05_NO_ORG_ID_PARAM' AS test, pg_get_function_arguments(p.oid) AS signature,
  CASE WHEN position('organization_id' in pg_get_function_arguments(p.oid)) = 0
       THEN 'PASS' ELSE 'FAIL - signature contains organization_id' END AS result
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'app_record_fast_scan_result';

SELECT 'T06_EXECUTE_REVOKED_FROM_PUBLIC' AS test,
  has_function_privilege('public',
    'public.app_record_fast_scan_result(uuid, text, text, text, integer, integer, text, text, integer, text[], text[], text[], text[], integer[], text)',
    'EXECUTE') AS public_can_execute,
  CASE WHEN has_function_privilege('public',
    'public.app_record_fast_scan_result(uuid, text, text, text, integer, integer, text, text, integer, text[], text[], text[], text[], integer[], text)',
    'EXECUTE') = false
       THEN 'PASS' ELSE 'FAIL - PUBLIC can still execute' END AS result;

GRANT EXECUTE ON FUNCTION public.app_record_fast_scan_result(
    uuid, text, text, text, integer, integer, text, text, integer,
    text[], text[], text[], text[], integer[], text
) TO cbc_app_validation;

SELECT 'T07_EXECUTE_GRANTED_TO_VALIDATION_ROLE' AS test,
  has_function_privilege('cbc_app_validation',
    'public.app_record_fast_scan_result(uuid, text, text, text, integer, integer, text, text, integer, text[], text[], text[], text[], integer[], text)',
    'EXECUTE') AS validation_can_execute,
  CASE WHEN has_function_privilege('cbc_app_validation',
    'public.app_record_fast_scan_result(uuid, text, text, text, integer, integer, text, text, integer, text[], text[], text[], text[], integer[], text)',
    'EXECUTE') = true
       THEN 'PASS' ELSE 'FAIL - validation role cannot execute' END AS result;

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Org A', 'org-a-003d'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Org B', 'org-b-003d')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (id, organization_id, full_name, role) VALUES
  ('a1111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'User A', 'admin')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.memberships (user_id, organization_id, role) VALUES
  ('a1111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'owner')
ON CONFLICT (user_id, organization_id) DO NOTHING;

INSERT INTO public.scans (id, organization_id, user_id, input_type, raw_input, status) VALUES
  ('5ca11111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'a1111111-0000-0000-0000-000000000001', 'url', 'http://a.example', 'pending'),
  ('5cb22222-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', NULL, 'url', 'http://b.example', 'pending')
ON CONFLICT (id) DO NOTHING;

DO $t08$
DECLARE v_msg text := NULL; v_pass boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id', 'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id', 'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5cb22222-0000-0000-0000-000000000002',
      'internal_fast_path', 'success', 'unknown', 0, 0, 'x', 'x');
    v_pass := false;
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    v_pass := (position('cross-tenant scan access refused' in v_msg) > 0);
  END;
  RESET ROLE;
  RAISE NOTICE 'T08_WRONG_ORG_SCANID_REFUSED result: % (msg: %)',
    CASE WHEN v_pass THEN 'PASS' ELSE 'FAIL - not refused by cross-tenant check' END,
    COALESCE(v_msg, '<no exception>');
END $t08$;

DO $t09$
DECLARE v_ret uuid; v_ok boolean := false;
BEGIN
  PERFORM set_config('app.current_user_id', 'a1111111-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.current_organization_id', 'aaaaaaaa-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    v_ret := public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'internal_fast_path', 'success', 'unknown', 0, 0, 'x', 'x');
    v_ok := (v_ret = '5ca11111-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN v_ok := false;
  END;
  RESET ROLE;
  RAISE NOTICE 'T09_SAME_ORG_BOUNDARY_PASS result: %',
    CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL - same-org boundary call did not return stub' END;
END $t09$;

DO $t10$
DECLARE v_msg text := NULL; v_pass boolean := false;
BEGIN
  SET LOCAL ROLE cbc_app_validation;
  BEGIN
    PERFORM public.app_record_fast_scan_result(
      '5ca11111-0000-0000-0000-000000000001',
      'internal_fast_path', 'success', 'unknown', 0, 0, 'x', 'x');
    v_pass := false;
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    v_pass := (position('missing session context' in v_msg) > 0);
  END;
  RESET ROLE;
  RAISE NOTICE 'T10_MISSING_CONTEXT_REFUSED result: % (msg: %)',
    CASE WHEN v_pass THEN 'PASS' ELSE 'FAIL - not refused by missing-context check' END,
    COALESCE(v_msg, '<no exception>');
END $t10$;

SELECT 'GATE_003D_SLICE1_BOUNDARY_VALIDATION_COMPLETE' AS test, 'DONE' AS result;
