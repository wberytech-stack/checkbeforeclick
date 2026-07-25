/**
 * Gate 003P - Pure mapping functions for the fast-path scan result payload.
 *
 * These functions perform camelCase -> snake_case transformation only.
 * They do NOT filter, drop, or validate entries. Malformed input
 * (empty vendor_name, empty signal_type, empty title, invalid severity)
 * is passed through unchanged. Migration 004's app_record_fast_scan_result
 * is the sole authority that rejects malformed payloads via RAISE
 * EXCEPTION before any write occurs. Silently dropping entries here
 * would hide caller bugs and silently lose evidence, so this layer
 * intentionally does not do that.
 *
 * These functions perform no database access and have no side effects.
 *
 * Input types are intentionally stable and independent of any particular
 * caller shape (e.g. Promise.allSettled results). The route-wiring gate
 * decides how to adapt actual provider call results into these input
 * types; that adapter is out of scope for this gate.
 */

/**
 * Stable internal input shape for one provider/vendor result.
 * Independent of any specific HTTP client or Promise.allSettled shape.
 */
export interface FastScanVendorResultInput {
  vendorName: string;
  verdict?: "safe" | "suspicious" | "dangerous" | "unknown" | null;
  rawResponse?: Record<string, unknown> | null;
  errorMessage?: string | null;
  responseTimeMs?: number | null;
}

/**
 * Stable internal input shape for one evidence item.
 */
export interface FastScanEvidenceItemInput {
  signalType: string;
  severity: "critical" | "high" | "medium" | "low" | "info" | "good";
  title: string;
  detail?: string | null;
  scoreImpact?: number | null;
}

/**
 * JSONB-ready vendor result object matching migration 004's expected
 * p_vendor_results element shape.
 */
export interface FastScanVendorResultPayload {
  vendor_name: string;
  verdict?: string | null;
  raw_response?: Record<string, unknown> | null;
  error_message?: string | null;
  response_time_ms?: number | null;
}

/**
 * JSONB-ready evidence item object matching migration 004's expected
 * p_evidence_items element shape.
 */
export interface FastScanEvidenceItemPayload {
  signal_type: string;
  severity: string;
  title: string;
  detail?: string | null;
  score_impact?: number | null;
}

/**
 * Maps an array of stable vendor result inputs into the JSONB-ready
 * shape expected by p_vendor_results. Transformation only - no
 * filtering. Optional fields that are undefined or null are simply
 * omitted from the output object; this is key omission, not entry
 * filtering, and every input entry produces exactly one output entry.
 */
export function mapVendorResults(
  inputs: FastScanVendorResultInput[]
): FastScanVendorResultPayload[] {
  return inputs.map((v) => {
    const payload: FastScanVendorResultPayload = {
      vendor_name: v.vendorName,
    };

    if (v.verdict !== undefined && v.verdict !== null) {
      payload.verdict = v.verdict;
    }

    if (v.rawResponse !== undefined && v.rawResponse !== null) {
      payload.raw_response = v.rawResponse;
    }

    if (v.errorMessage !== undefined && v.errorMessage !== null) {
      payload.error_message = v.errorMessage;
    }

    if (v.responseTimeMs !== undefined && v.responseTimeMs !== null) {
      payload.response_time_ms = v.responseTimeMs;
    }

    return payload;
  });
}

/**
 * Maps an array of stable evidence item inputs into the JSONB-ready
 * shape expected by p_evidence_items. Transformation only - no
 * filtering. Same guarantee as mapVendorResults: every input entry
 * produces exactly one output entry.
 */
export function mapEvidenceItems(
  inputs: FastScanEvidenceItemInput[]
): FastScanEvidenceItemPayload[] {
  return inputs.map((e) => {
    const payload: FastScanEvidenceItemPayload = {
      signal_type: e.signalType,
      severity: e.severity,
      title: e.title,
    };

    if (e.detail !== undefined && e.detail !== null) {
      payload.detail = e.detail;
    }

    if (e.scoreImpact !== undefined && e.scoreImpact !== null) {
      payload.score_impact = e.scoreImpact;
    }

    return payload;
  });
}
