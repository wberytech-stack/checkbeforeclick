/**
 * Tenant-scoped recent Azure scan history for the Security Center.
 *
 * No browser-supplied tenant selector or pagination SQL. The DB-derived
 * organization and RLS GUCs are installed in the same transaction as SELECT.
 * Deliberately bounded to 50 rows; this is recent history, not all-time metrics.
 */
import "server-only";
import {
  withAzureTenantSession,
  type AzureTenantSessionDependencies,
} from "../auth/azureTenantSession";

const MAX_ROWS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "vary": "Cookie",
  "x-content-type-options": "nosniff",
};
const HISTORY_SQL = `SELECT id, raw_input, status, verdict, created_at
  FROM public.scans
  WHERE organization_id = $1::uuid AND input_type = 'url'
  ORDER BY created_at DESC, id DESC
  LIMIT 51`;

function respond(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: HEADERS });
}

export function parseAzureHistoryRow(row: Record<string, unknown>) {
  if (typeof row.id !== "string" || !UUID.test(row.id) ||
      typeof row.raw_input !== "string" || row.raw_input.length > 10000 ||
      !["pending", "processing", "complete", "failed"].includes(String(row.status)) ||
      !(row.verdict === null || typeof row.verdict === "string")) {
    throw new Error("Invalid history record");
  }
  const date = row.created_at instanceof Date ? row.created_at :
    typeof row.created_at === "string" ? new Date(row.created_at) : null;
  if (!date || !Number.isFinite(date.getTime())) throw new Error("Invalid history date");
  return {
    id: row.id,
    raw_input: row.raw_input,
    status: row.status,
    verdict: row.verdict,
    created_at: date.toISOString(),
  };
}

export async function runAzureScanHistoryRoute(
  request: Request,
  deps: AzureTenantSessionDependencies,
): Promise<Response> {
  if (request.method !== "GET") return respond(405, { error: "Method not allowed" });
  // History takes no query parameters, including organization or role hints.
  const url = new URL(request.url);
  if (url.pathname !== "/api/azure/history" || url.search || url.hash) {
    return respond(400, { error: "Invalid history request" });
  }
  try {
    const result = await withAzureTenantSession(
      request.headers.get("cookie"),
      deps,
      async (client, session) => {
        const rows = (await client.query(HISTORY_SQL, [session.organizationId])).rows;
        if (rows.length > MAX_ROWS + 1) throw new Error("Unbounded history result");
        return {
          scans: rows.slice(0, MAX_ROWS).map(parseAzureHistoryRow),
          has_more: rows.length > MAX_ROWS,
        };
      },
    );
    if (!result.authenticated) return respond(401, { error: "Unauthorized" });
    return respond(200, result.value);
  } catch {
    return respond(503, { error: "Scan history temporarily unavailable" });
  }
}
