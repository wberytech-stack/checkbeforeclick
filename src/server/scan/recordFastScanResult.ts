import "server-only";

import { withPgTransaction } from "../db/postgres";
import {
  mapVendorResults,
  mapEvidenceItems,
  type FastScanVendorResultInput,
  type FastScanEvidenceItemInput,
} from "./mapFastScanResultPayload";

/**
 * Gate 003P - Server-only helper that atomically persists a fast-path
 * scan's final result via public.app_record_fast_scan_result.
 *
 * This helper does NOT wire into any route in this gate. It is isolated,
 * server-only, and exists so it can be validated against a disposable
 * local PostgreSQL database (Gate 003P validation) before any route
 * wiring gate touches app/api/scan/route.ts.
 *
 * Security invariants:
 * - organization_id is never passed as a function argument. It reaches
 *   the DB function only through the transaction-local GUC
 *   app.current_organization_id, set via set_config(..., true) on the
 *   same PoolClient used for the function call.
 * - user_id follows the same pattern via app.current_user_id.
 * - The DB function (migration 004) is the authoritative tenant-boundary
 *   and payload validator. This helper does not attempt to duplicate
 *   that authority; it only prepares and delivers the call correctly.
 * - Raw DB exception text (RAISE EXCEPTION messages) is never returned
 *   directly to any client-facing surface. Callers of this helper must
 *   catch RecordFastScanResultError and map it to an appropriate
 *   response themselves; this helper only distinguishes error categories
 *   where it can safely determine them without parsing DB error text
 *   for anything beyond internal logging.
 */

export type FastScanFinalStatus = "complete" | "failed";

export type FastScanVerdict =
  | "safe"
  | "suspicious"
  | "dangerous"
  | "unknown"
  | null;

export interface RecordFastScanResultInput {
  /** Server-resolved user id. Never accept this from client input directly
   * without having verified it against the authenticated session. */
  userId: string;
  /** Server-resolved organization id. Same trust requirement as userId. */
  organizationId: string;
  scanId: string;
  status: FastScanFinalStatus;
  verdict: FastScanVerdict;
  riskScore: number | null;
  confidenceScore: number | null;
  aiExplanation: string | null;
  recommendedAction: string | null;
  scanDurationMs: number | null;
  vendorResults: FastScanVendorResultInput[];
  evidenceItems: FastScanEvidenceItemInput[];
  errorMessage?: string | null;
}

export interface RecordFastScanResultOutput {
  scanId: string;
}

/**
 * Error thrown when the underlying DB call fails for any reason,
 * including tenant-boundary refusals, payload validation failures, and
 * one-shot completion rejections. The `category` field gives callers a
 * coarse, safe-to-expose classification without leaking raw DB text.
 */
export class RecordFastScanResultError extends Error {
  public readonly category:
    | "context_missing"
    | "tenant_refused"
    | "already_final"
    | "validation_failed"
    | "unknown";

  constructor(
    category: RecordFastScanResultError["category"],
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "RecordFastScanResultError";
    this.category = category;
  }
}

/**
 * Classifies a raw error from the DB call into a safe category based on
 * known exception message prefixes from migration 004. This is done
 * only for internal logging/handling clarity, not to reconstruct or
 * expose the raw text to any client-facing surface.
 */
function classifyError(err: unknown): RecordFastScanResultError["category"] {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("missing session context")) return "context_missing";
  if (
    msg.includes("cross-tenant scan access refused") ||
    msg.includes("caller is not a member")
  ) {
    return "tenant_refused";
  }
  if (msg.includes("already in final state")) return "already_final";
  if (
    msg.includes("must be complete or failed") ||
    msg.includes("invalid verdict") ||
    msg.includes("out of range") ||
    msg.includes("must not be null") ||
    msg.includes("must be a JSON array") ||
    msg.includes("must be a JSON object") ||
    msg.includes("missing required field") ||
    msg.includes("invalid severity") ||
    msg.includes("not a valid integer") ||
    msg.includes("scan not found")
  ) {
    return "validation_failed";
  }
  return "unknown";
}

/**
 * Atomically persists a fast-path scan's final result.
 *
 * Sequence, all on the same PoolClient within one transaction:
 *   1. SELECT set_config('app.current_user_id', $1, true)
 *   2. SELECT set_config('app.current_organization_id', $1, true)
 *   3. SELECT public.app_record_fast_scan_result(...) AS scan_id
 *
 * withPgTransaction issues COMMIT on success or ROLLBACK on any thrown
 * error, including errors raised by the DB function itself.
 */
export async function recordFastScanResult(
  input: RecordFastScanResultInput
): Promise<RecordFastScanResultOutput> {
  const vendorResultsPayload = mapVendorResults(input.vendorResults);
  const evidenceItemsPayload = mapEvidenceItems(input.evidenceItems);

  try {
    const scanId = await withPgTransaction(async (client) => {
      await client.query(
        "SELECT set_config('app.current_user_id', $1, true)",
        [input.userId]
      );
      await client.query(
        "SELECT set_config('app.current_organization_id', $1, true)",
        [input.organizationId]
      );

      const result = await client.query<{ scan_id: string }>(
        `SELECT public.app_record_fast_scan_result(
           $1::uuid,
           $2::text,
           $3::text,
           $4::integer,
           $5::integer,
           $6::text,
           $7::text,
           $8::integer,
           $9::jsonb,
           $10::jsonb,
           $11::text
         ) AS scan_id`,
        [
          input.scanId,
          input.status,
          input.verdict,
          input.riskScore,
          input.confidenceScore,
          input.aiExplanation,
          input.recommendedAction,
          input.scanDurationMs,
          JSON.stringify(vendorResultsPayload),
          JSON.stringify(evidenceItemsPayload),
          input.errorMessage ?? null,
        ]
      );

      return result.rows[0]?.scan_id;
    });

    if (!scanId) {
      throw new RecordFastScanResultError(
        "unknown",
        "app_record_fast_scan_result returned no scan_id"
      );
    }

    return { scanId };
  } catch (err) {
    if (err instanceof RecordFastScanResultError) {
      throw err;
    }
    const category = classifyError(err);
    throw new RecordFastScanResultError(
      category,
      "Failed to record fast scan result",
      err
    );
  }
}
