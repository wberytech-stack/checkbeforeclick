-- ============================================================================
-- 003_fast_path_function.sql
-- Gate 003D - Controlled fast-path function (STUB SLICE 1: boundary only)
--
-- This SLICE implements ONLY the security boundary: the internal tenant
-- ownership checks (design Section 8, steps 1-7) plus SECURITY DEFINER
-- hardening (Section 9). It performs NO result/evidence/audit writes. After the
-- authorization checks pass it takes a row lock and returns a stub value.
--
-- LOCK ORDERING: the scan is read WITHOUT a lock for the authorization checks
-- (exists / org-match / membership). Only AFTER all checks pass does the
-- function take FOR UPDATE on the row. This avoids locking a row the caller is
-- not authorized to touch.
--
-- BOUNDARIES: does NOT write to scans/vendor_results/evidence_items/audit_log;
-- does NOT broaden cbc_app privileges; does NOT create cbc_app. REVOKEs EXECUTE
-- from PUBLIC, then conditionally GRANTs EXECUTE to cbc_app IF that role exists.
-- NEVER run against cbc_prod.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.app_record_fast_scan_result(
    p_scan_id               uuid,
    p_provider              text,
    p_provider_status       text,
    p_verdict               text,
    p_risk_score            integer,
    p_confidence_score      integer,
    p_ai_explanation        text,
    p_recommended_action    text,
    p_scan_duration_ms      integer    DEFAULT NULL,
    p_evidence_signal_type  text[]     DEFAULT '{}',
    p_evidence_severity     text[]     DEFAULT '{}',
    p_evidence_title        text[]     DEFAULT '{}',
    p_evidence_detail       text[]     DEFAULT '{}',
    p_evidence_score_impact integer[]  DEFAULT '{}',
    p_error_message         text       DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
    v_user     uuid;
    v_org      uuid;
    v_scan_org uuid;
BEGIN
    -- (1) Read transaction-local app context.
    v_user := public.app_current_user_id();
    v_org  := public.app_current_org_id();

    -- (2) Refuse if either context value is missing (fail closed).
    IF v_user IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: missing session context (user or organization)';
    END IF;

    -- (3) Load the scan row by id WITHOUT a lock (authorization checks first).
    SELECT s.organization_id
      INTO v_scan_org
      FROM public.scans s
     WHERE s.id = p_scan_id;

    -- (4) Refuse if the scan does not exist.
    IF NOT FOUND THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: scan not found';
    END IF;

    -- (5) Refuse if scan organization does not match context organization.
    IF v_scan_org IS NULL OR v_scan_org <> v_org THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: cross-tenant scan access refused';
    END IF;

    -- (6) Refuse if the actor is not a member of the scan organization.
    IF NOT public.app_is_member(v_org) THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: caller is not a member of the scan organization';
    END IF;

    -- (7) Only now, after all authorization checks pass, lock the scan row.
    PERFORM 1 FROM public.scans s WHERE s.id = p_scan_id FOR UPDATE;

    -- SLICE 1 BOUNDARY STOPS HERE. No writes. Return stub (validated scan id).
    RETURN p_scan_id;
END;
$func$;

REVOKE ALL ON FUNCTION public.app_record_fast_scan_result(
    uuid, text, text, text, integer, integer, text, text, integer,
    text[], text[], text[], text[], integer[], text
) FROM PUBLIC;

DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cbc_app') THEN
        GRANT EXECUTE ON FUNCTION public.app_record_fast_scan_result(
            uuid, text, text, text, integer, integer, text, text, integer,
            text[], text[], text[], text[], integer[], text
        ) TO cbc_app;
    ELSE
        RAISE NOTICE 'Role cbc_app not present; skipping EXECUTE grant (expected on disposable DB).';
    END IF;
END
$grant$;

COMMIT;
