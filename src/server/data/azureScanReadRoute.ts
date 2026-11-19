/**
 * Read-only Azure scan + evidence HTTP boundary.
 *
 * A browser cookie is never a tenant selector. The session is resolved from
 * PostgreSQL inside the same transaction as both RLS-protected queries.
 * Explicit organization predicates provide defense in depth against accidental
 * policy changes; production MUST use the non-BYPASSRLS cbc_app role.
 */
import "server-only";
import {
  withAzureTenantSession,
  type AzureTenantSessionDependencies,
} from "../auth/azureTenantSession";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_EVIDENCE = 500;
const HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "vary": "Cookie",
  "x-content-type-options": "nosniff",
};

const SCAN_SQL = `SELECT id, input_type, raw_input, status, verdict, risk_score,
  confidence_score, created_at, completed_at
  FROM public.scans
  WHERE id = $1::uuid AND organization_id = $2::uuid`;

const EVIDENCE_SQL = `SELECT e.signal_type, e.severity, e.title, e.detail, e.score_impact
  FROM public.evidence_items AS e
  INNER JOIN public.scans AS s ON s.id = e.scan_id
  WHERE e.scan_id = $1::uuid AND e.organization_id = $2::uuid
    AND s.organization_id = $2::uuid
  ORDER BY e.created_at, e.id LIMIT 501`;

function respond(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: HEADERS });
}

function optionalNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function optionalText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isoDate(value: unknown, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) throw new Error("Invalid scan date");
  return date.toISOString();
}

function scanRecord(row: Record<string, unknown>, id: string) {
  if (row.id !== id || row.input_type !== "url" ||
      typeof row.raw_input !== "string" || row.raw_input.length > 2048 ||
      !["pending", "processing", "complete", "failed"].includes(String(row.status)) ||
      !(row.verdict === null || ["safe", "suspicious", "dangerous", "unknown"].includes(row.verdict as string)) ||
      !optionalNumber(row.risk_score) || !optionalNumber(row.confidence_score) ||
      (row.risk_score !== null && (row.risk_score < 0 || row.risk_score > 100)) ||
      (row.confidence_score !== null && (row.confidence_score < 0 || row.confidence_score > 100))) {
    throw new Error("Invalid scan record");
  }
  return {
    id: row.id,
    input_type: row.input_type,
    raw_input: row.raw_input,
    status: row.status,
    verdict: row.verdict,
    risk_score: row.risk_score,
    confidence_score: row.confidence_score,
    created_at: isoDate(row.created_at, false),
    completed_at: isoDate(row.completed_at, true),
  };
}

function evidenceRecord(row: Record<string, unknown>) {
  if (typeof row.signal_type !== "string" || row.signal_type.length > 128 ||
      !["critical", "high", "medium", "low", "info", "good"].includes(String(row.severity)) ||
      typeof row.title !== "string" || row.title.length > 300 ||
      !optionalText(row.detail) || (typeof row.detail === "string" && row.detail.length > 4000) ||
      typeof row.score_impact !== "number" || !Number.isInteger(row.score_impact) ||
      row.score_impact < -100 || row.score_impact > 100) {
    throw new Error("Invalid evidence record");
  }
  return {
    signal_type: row.signal_type,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    score_impact: row.score_impact,
  };
}

export async function runAzureScanReadRoute(
  request: Request,
  scanId: unknown,
  deps: AzureTenantSessionDependencies,
): Promise<Response> {
  if (request.method !== "GET") return respond(405, { error: "Method not allowed" });
  // Reject ambiguous or noncanonical identifiers before opening a connection.
  if (typeof scanId !== "string" || !UUID.test(scanId)) {
    return respond(400, { error: "Invalid scan ID" });
  }
  // Do not silently accept query-string tenant hints or alternate paths. The
  // scan ID in the route must match the canonical URL before touching SQL.
  try {
    const url = new URL(request.url);
    if (url.pathname !== `/api/azure/scans/${scanId}` || url.search || url.hash) {
      return respond(400, { error: "Invalid scan request" });
    }
  } catch {
    return respond(400, { error: "Invalid scan request" });
  }
  try {
    const result = await withAzureTenantSession(
      request.headers.get("cookie"),
      deps,
      async (client, session) => {
        const args = [scanId, session.organizationId];
        const scan = await client.query(SCAN_SQL, args);
        if (scan.rows.length === 0) return null;
        if (scan.rows.length !== 1) throw new Error("Ambiguous scan");
        const safeScan = scanRecord(scan.rows[0], scanId);
        const evidence = await client.query(EVIDENCE_SQL, args);
        // Never silently truncate integrity-relevant evidence.
        if (evidence.rows.length > MAX_EVIDENCE) throw new Error("Evidence limit exceeded");
        return { scan: safeScan, evidence: evidence.rows.map(evidenceRecord) };
      },
    );
    if (!result.authenticated) return respond(401, { error: "Unauthorized" });
    if (result.value === null) return respond(404, { error: "Scan not found" });
    return respond(200, result.value);
  } catch {
    // No SQL, cookie, tenant ID, scan input or database details escape.
    return respond(503, { error: "Scan temporarily unavailable" });
  }
}
