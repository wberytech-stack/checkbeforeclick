-- ============================================================================
-- 004_fast_path_function_write_expansion.sql
-- Gate 003M - Expand app_record_fast_scan_result to persist fast-path results
--
-- DRAFT ONLY. Do not apply to cbc_prod or any Azure PostgreSQL server.
-- Validate against a disposable local PostgreSQL database only (Gate 003N).
--
-- Purpose:
--   Replace the Gate 003D Slice 1 boundary-only stub with a full write
--   implementation. After tenant-boundary checks pass, the function now
--   atomically:
--     1. Updates the scans row to its final completed state.
--     2. Inserts one vendor_results row per provider entry in p_vendor_results.
--     3. Inserts one evidence_items row per entry in p_evidence_items.
--   No audit_log writes in this migration (deferred to a later gate).
--
-- SIGNATURE CHANGE:
--   The old signature used per-provider parallel arrays (p_provider,
--   p_provider_status, p_evidence_signal_type[], etc.). The new signature
--   replaces those with two JSONB arrays (p_vendor_results, p_evidence_items)
--   so the function can accept multiple providers/evidence items atomically
--   and validate shape before any writes occur.
--
--   The old function must be dropped explicitly because the signature changes.
--   The old signature has 15 parameters.
--
-- IDEMPOTENCY / ONE-SHOT COMPLETION RULE:
--   After locking the scan row with FOR UPDATE, the function reads the current
--   locked status. Writes are only permitted when the locked status is
--   'pending' or 'processing'. If the locked status is already 'complete' or
--   'failed', the function raises an exception before any writes. This is the
--   Gate 003M idempotency decision: the function is one-shot. Repeated or
--   concurrent calls after the scan is already in a final state are rejected,
--   preventing duplicate vendor_results and evidence_items rows.
--
-- SECURITY INVARIANTS (unchanged from Slice 1):
--   - SECURITY DEFINER with locked search_path.
--   - Tenant context comes ONLY from transaction-local GUCs via
--     app_current_user_id() and app_current_org_id(). Never from arguments.
--   - organization_id is NOT a function argument.
--   - Fails closed for missing context, missing scan, cross-tenant access,
--     non-member access, scan already in final state, and invalid payload -
--     all before any writes.
--
-- LOCK ORDER:
--   1. Read transaction-local context.
--   2. Load scan organization WITHOUT a lock (auth check only).
--   3. Reject missing scan, cross-tenant access, non-member access.
--   4. Lock the authorized scan row FOR UPDATE and read current status.
--   5. Reject if locked status is already complete or failed (one-shot rule).
--   6. Validate payload (p_status, p_verdict, scores, JSONB shapes, fields).
--   7. Perform writes (scans update, vendor_results inserts, evidence_items
--      inserts).
--
-- JSONB SCHEMAS:
--
--   p_vendor_results (array of objects):
--     {
--       "vendor_name":      text    (required, NOT NULL in vendor_results),
--       "verdict":          text    (optional, nullable in table),
--       "raw_response":     object  (optional, nullable jsonb in table),
--       "error_message":    text    (optional, nullable in table),
--       "response_time_ms": integer (optional, nullable in table;
--                                   validated as integer before insert)
--     }
--
--   p_evidence_items (array of objects):
--     {
--       "signal_type":  text    (required, NOT NULL in evidence_items),
--       "severity":     text    (required, NOT NULL; must be one of:
--                               critical|high|medium|low|info|good),
--       "title":        text    (required, NOT NULL in evidence_items),
--       "detail":       text    (optional, nullable in table),
--       "score_impact": integer (optional, defaults to 0;
--                               validated as integer before insert)
--     }
--
-- SCANS TABLE ALLOWED VALUES (from schema constraints):
--   status:  pending | processing | complete | failed
--   verdict: safe | suspicious | dangerous | unknown
--
-- p_status RESTRICTED IN THIS FUNCTION:
--   Only 'complete' or 'failed' are accepted. This function is for fast-path
--   terminal completion only. Setting 'pending' or 'processing' while also
--   setting completed_at = now() is nonsensical and rejected.
--
-- NEVER run against cbc_prod.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Step 1: Drop the old signature (Slice 1 boundary-only stub).
--
-- The old signature has 15 parameters. It must be dropped explicitly because
-- the parameter list is changing.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.app_record_fast_scan_result(
    uuid,      -- p_scan_id
    text,      -- p_provider
    text,      -- p_provider_status
    text,      -- p_verdict
    integer,   -- p_risk_score
    integer,   -- p_confidence_score
    text,      -- p_ai_explanation
    text,      -- p_recommended_action
    integer,   -- p_scan_duration_ms
    text[],    -- p_evidence_signal_type
    text[],    -- p_evidence_severity
    text[],    -- p_evidence_title
    text[],    -- p_evidence_detail
    integer[], -- p_evidence_score_impact
    text       -- p_error_message
);
-- ---------------------------------------------------------------------------
-- Step 2: Create the expanded function with JSONB provider/evidence arrays.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.app_record_fast_scan_result(
    -- Scan identity. Never accept organization_id as an argument.
    p_scan_id               uuid,

    -- Final scan-level result fields.
    -- p_status is restricted to 'complete' or 'failed' only.
    p_status                text,
    p_verdict               text,
    p_risk_score            integer,
    p_confidence_score      integer,
    p_ai_explanation        text,
    p_recommended_action    text,
    p_scan_duration_ms      integer  DEFAULT NULL,

    -- Provider results: JSON array of vendor result objects.
    -- Must be a non-null JSON array. Each element must be a JSON object
    -- containing at minimum vendor_name (text). Optional fields: verdict,
    -- raw_response, error_message, response_time_ms (integer).
    p_vendor_results        jsonb    DEFAULT '[]'::jsonb,

    -- Evidence items: JSON array of evidence objects.
    -- Must be a non-null JSON array. Each element must be a JSON object
    -- containing signal_type, severity, and title (all text). Optional
    -- fields: detail (text), score_impact (integer, defaults to 0).
    p_evidence_items        jsonb    DEFAULT '[]'::jsonb,

    -- Error message for overall scan failure context (not per-provider).
    -- Kept in the signature for future compatibility and failed-scan context.
    -- This migration does NOT write p_error_message to the scans table
    -- because the current scans schema has no overall error_message column.
    -- Per-provider errors are persisted through vendor_results.error_message.
    p_error_message         text     DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
    v_user           uuid;
    v_org            uuid;
    v_scan_org       uuid;
    v_locked_status  text;
    v_vendor         jsonb;
    v_evidence       jsonb;
    v_severity       text;
    v_signal_type    text;
    v_title          text;
    v_vendor_name    text;
    v_rtime          text;
    v_sco            text;
    v_i              integer;
    v_count          integer;
BEGIN
    -- -----------------------------------------------------------------------
    -- (1) Read transaction-local app context. Never trust function arguments
    --     for tenant identity.
    -- -----------------------------------------------------------------------
    v_user := public.app_current_user_id();
    v_org  := public.app_current_org_id();

    -- -----------------------------------------------------------------------
    -- (2) Fail closed if either context value is missing.
    -- -----------------------------------------------------------------------
    IF v_user IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: missing session context (user or organization)';
    END IF;

    -- -----------------------------------------------------------------------
    -- (3) Load the scan organization WITHOUT a lock (authorization check only).
    --     We read organization_id here to verify tenant ownership before
    --     taking any lock.
    -- -----------------------------------------------------------------------
    SELECT s.organization_id
      INTO v_scan_org
      FROM public.scans s
     WHERE s.id = p_scan_id;

    -- -----------------------------------------------------------------------
    -- (4) Fail closed if the scan does not exist.
    -- -----------------------------------------------------------------------
    IF NOT FOUND THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: scan not found';
    END IF;

    -- -----------------------------------------------------------------------
    -- (5) Fail closed for cross-tenant scan access.
    -- -----------------------------------------------------------------------
    IF v_scan_org IS NULL OR v_scan_org <> v_org THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: cross-tenant scan access refused';
    END IF;

    -- -----------------------------------------------------------------------
    -- (6) Fail closed if the caller is not a member of the scan organization.
    -- -----------------------------------------------------------------------
    IF NOT public.app_is_member(v_org) THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: caller is not a member of the scan organization';
    END IF;

    -- -----------------------------------------------------------------------
    -- (7) All authorization checks passed. Lock the scan row FOR UPDATE and
    --     read the current status from the locked row in one statement.
    --     The WHERE clause includes both id and organization_id for tenant
    --     anchoring. If the row is not found under this tenant after locking,
    --     fail closed.
    -- -----------------------------------------------------------------------
    SELECT s.status
      INTO v_locked_status
      FROM public.scans s
     WHERE s.id = p_scan_id
       AND s.organization_id = v_scan_org
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: scan not found under authorized organization at lock time';
    END IF;

    -- -----------------------------------------------------------------------
    -- (8) One-shot completion rule: only allow writes if the locked scan is
    --     still in a non-final state. Reject calls on already-completed or
    --     already-failed scans to prevent duplicate child rows on repeated or
    --     concurrent calls.
    -- -----------------------------------------------------------------------
    IF v_locked_status NOT IN ('pending', 'processing') THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: scan is already in final state % and cannot be updated', v_locked_status;
    END IF;

    -- -----------------------------------------------------------------------
    -- (9) Validate p_status: this function is for fast-path terminal
    --     completion only. Only 'complete' or 'failed' are accepted.
    --     Setting 'pending' or 'processing' while also writing completed_at
    --     is not permitted.
    -- -----------------------------------------------------------------------
    IF p_status NOT IN ('complete', 'failed') THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: p_status must be complete or failed, got: %', p_status;
    END IF;
    -- -----------------------------------------------------------------------
    -- (10) Validate remaining scan-level payload before writes.
    -- -----------------------------------------------------------------------

    -- Validate verdict value against schema constraint (nullable is allowed).
    IF p_verdict IS NOT NULL AND p_verdict NOT IN ('safe', 'suspicious', 'dangerous', 'unknown') THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: invalid verdict value: %', p_verdict;
    END IF;

    -- Validate risk_score range against schema constraint.
    IF p_risk_score IS NOT NULL AND (p_risk_score < 0 OR p_risk_score > 100) THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: risk_score out of range (0-100): %', p_risk_score;
    END IF;

    -- Validate confidence_score range against schema constraint.
    IF p_confidence_score IS NOT NULL AND (p_confidence_score < 0 OR p_confidence_score > 100) THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: confidence_score out of range (0-100): %', p_confidence_score;
    END IF;

    -- Validate p_scan_duration_ms: NULL is allowed; if present must be >= 0.
    IF p_scan_duration_ms IS NOT NULL AND p_scan_duration_ms < 0 THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: p_scan_duration_ms must be >= 0, got: %', p_scan_duration_ms;
    END IF;

    -- -----------------------------------------------------------------------
    -- (11) Validate p_vendor_results: must be a non-null JSON array. Each
    --      element must be a JSON object. Required field vendor_name must be
    --      present and non-empty. Optional response_time_ms must be an integer
    --      if present. All validation happens before any write.
    -- -----------------------------------------------------------------------
    IF p_vendor_results IS NULL THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: p_vendor_results must not be null';
    END IF;

    IF jsonb_typeof(p_vendor_results) <> 'array' THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: p_vendor_results must be a JSON array';
    END IF;

    v_count := jsonb_array_length(p_vendor_results);
    FOR v_i IN 0 .. v_count - 1 LOOP
        v_vendor := p_vendor_results -> v_i;

        IF jsonb_typeof(v_vendor) <> 'object' THEN
            RAISE EXCEPTION 'app_record_fast_scan_result: vendor_results[%] must be a JSON object', v_i;
        END IF;

        v_vendor_name := v_vendor ->> 'vendor_name';
        IF v_vendor_name IS NULL OR v_vendor_name = '' THEN
            RAISE EXCEPTION 'app_record_fast_scan_result: vendor_results[%] missing required field vendor_name', v_i;
        END IF;

        -- Validate response_time_ms is an integer if present and non-null.
        IF (v_vendor -> 'response_time_ms') IS NOT NULL
           AND jsonb_typeof(v_vendor -> 'response_time_ms') <> 'null' THEN
            v_rtime := v_vendor ->> 'response_time_ms';
            BEGIN
                PERFORM v_rtime::integer;
            EXCEPTION WHEN others THEN
                RAISE EXCEPTION 'app_record_fast_scan_result: vendor_results[%] response_time_ms is not a valid integer: %', v_i, v_rtime;
            END;
        END IF;
    END LOOP;

    -- -----------------------------------------------------------------------
    -- (12) Validate p_evidence_items: must be a non-null JSON array. Each
    --      element must be a JSON object. Required fields signal_type, severity,
    --      and title must be present and non-empty. Severity must be one of the
    --      allowed values from the evidence_items schema constraint. Optional
    --      score_impact must be an integer if present. All validation happens
    --      before any write.
    -- -----------------------------------------------------------------------
    IF p_evidence_items IS NULL THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: p_evidence_items must not be null';
    END IF;

    IF jsonb_typeof(p_evidence_items) <> 'array' THEN
        RAISE EXCEPTION 'app_record_fast_scan_result: p_evidence_items must be a JSON array';
    END IF;

    v_count := jsonb_array_length(p_evidence_items);
    FOR v_i IN 0 .. v_count - 1 LOOP
        v_evidence    := p_evidence_items -> v_i;

        IF jsonb_typeof(v_evidence) <> 'object' THEN
            RAISE EXCEPTION 'app_record_fast_scan_result: evidence_items[%] must be a JSON object', v_i;
        END IF;

        v_signal_type := v_evidence ->> 'signal_type';
        v_severity    := v_evidence ->> 'severity';
        v_title       := v_evidence ->> 'title';

        IF v_signal_type IS NULL OR v_signal_type = '' THEN
            RAISE EXCEPTION 'app_record_fast_scan_result: evidence_items[%] missing required field signal_type', v_i;
        END IF;

        IF v_title IS NULL OR v_title = '' THEN
            RAISE EXCEPTION 'app_record_fast_scan_result: evidence_items[%] missing required field title', v_i;
        END IF;

        IF v_severity IS NULL OR v_severity NOT IN ('critical', 'high', 'medium', 'low', 'info', 'good') THEN
            RAISE EXCEPTION 'app_record_fast_scan_result: evidence_items[%] invalid severity: %', v_i, v_severity;
        END IF;

        -- Validate score_impact is an integer if present and non-null.
        IF (v_evidence -> 'score_impact') IS NOT NULL
           AND jsonb_typeof(v_evidence -> 'score_impact') <> 'null' THEN
            v_sco := v_evidence ->> 'score_impact';
            BEGIN
                PERFORM v_sco::integer;
            EXCEPTION WHEN others THEN
                RAISE EXCEPTION 'app_record_fast_scan_result: evidence_items[%] score_impact is not a valid integer: %', v_i, v_sco;
            END;
        END IF;
    END LOOP;
    -- -----------------------------------------------------------------------
    -- (13) All validation passed. Begin writes.
    --
    --      Write order: scans -> vendor_results -> evidence_items.
    --      If any write fails, the caller transaction rolls back entirely.
    --      No partial state is possible because all writes share one
    --      transaction. The scan UPDATE includes organization_id = v_scan_org
    --      in the WHERE clause for tenant anchoring.
    -- -----------------------------------------------------------------------

    -- Update the scans row to its final completed state.
    -- WHERE clause anchors on both id and organization_id for tenant safety.
    -- organization_id comes from v_scan_org (loaded by the function from the
    -- locked row), not from any function argument.
    -- p_error_message is NOT written here: scans has no error_message column.
    UPDATE public.scans
       SET status             = p_status,
           verdict            = p_verdict,
           risk_score         = p_risk_score,
           confidence_score   = p_confidence_score,
           ai_explanation     = p_ai_explanation,
           recommended_action = p_recommended_action,
           scan_duration_ms   = p_scan_duration_ms,
           completed_at       = now()
     WHERE id              = p_scan_id
       AND organization_id = v_scan_org;

    -- Insert vendor_results rows. organization_id is stamped from v_scan_org
    -- (the authorized scan organization loaded at lock time), never from a
    -- function argument.
    v_count := jsonb_array_length(p_vendor_results);
    FOR v_i IN 0 .. v_count - 1 LOOP
        v_vendor := p_vendor_results -> v_i;
        INSERT INTO public.vendor_results (
            scan_id,
            organization_id,
            vendor_name,
            verdict,
            raw_response,
            error_message,
            response_time_ms,
            checked_at
        ) VALUES (
            p_scan_id,
            v_scan_org,
            v_vendor ->> 'vendor_name',
            v_vendor ->> 'verdict',
            CASE
                WHEN (v_vendor -> 'raw_response') IS NOT NULL
                     AND jsonb_typeof(v_vendor -> 'raw_response') <> 'null'
                THEN v_vendor -> 'raw_response'
                ELSE NULL
            END,
            v_vendor ->> 'error_message',
            (v_vendor ->> 'response_time_ms')::integer,
            now()
        );
    END LOOP;

    -- Insert evidence_items rows. organization_id is stamped from v_scan_org,
    -- never from a function argument.
    v_count := jsonb_array_length(p_evidence_items);
    FOR v_i IN 0 .. v_count - 1 LOOP
        v_evidence := p_evidence_items -> v_i;
        INSERT INTO public.evidence_items (
            scan_id,
            organization_id,
            signal_type,
            severity,
            title,
            detail,
            score_impact,
            created_at
        ) VALUES (
            p_scan_id,
            v_scan_org,
            v_evidence ->> 'signal_type',
            v_evidence ->> 'severity',
            v_evidence ->> 'title',
            v_evidence ->> 'detail',
            COALESCE((v_evidence ->> 'score_impact')::integer, 0),
            now()
        );
    END LOOP;

    -- -----------------------------------------------------------------------
    -- (14) No audit_log writes in this migration.
    --      Audit writes are deferred to a future gate after the audit event
    --      shape, action names, metadata schema, and IP handling are decided.
    -- -----------------------------------------------------------------------

    RETURN p_scan_id;
END;
$func$;

-- ---------------------------------------------------------------------------
-- Step 3: Revoke EXECUTE from PUBLIC and conditionally grant to cbc_app and
-- cbc_app_validation.
--
-- cbc_app is the production runtime role.
-- cbc_app_validation is the Gate 003N disposable validation role, matching
-- the pattern used in Gate 003D validation (T07).
-- Both grants are conditional on the role existing, so this migration is
-- safe to run on disposable databases that may have only one or neither role.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.app_record_fast_scan_result(
    uuid, text, text, integer, integer, text, text, integer, jsonb, jsonb, text
) FROM PUBLIC;

DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cbc_app') THEN
        GRANT EXECUTE ON FUNCTION public.app_record_fast_scan_result(
            uuid, text, text, integer, integer, text, text, integer, jsonb, jsonb, text
        ) TO cbc_app;
    ELSE
        RAISE NOTICE 'Role cbc_app not present; skipping EXECUTE grant to cbc_app (expected on disposable DB).';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cbc_app_validation') THEN
        GRANT EXECUTE ON FUNCTION public.app_record_fast_scan_result(
            uuid, text, text, integer, integer, text, text, integer, jsonb, jsonb, text
        ) TO cbc_app_validation;
    ELSE
        RAISE NOTICE 'Role cbc_app_validation not present; skipping EXECUTE grant to cbc_app_validation.';
    END IF;
END;
$grant$;

COMMIT;
