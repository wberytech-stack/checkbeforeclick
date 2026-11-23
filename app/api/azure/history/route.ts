/** Azure-only tenant-scoped recent history; no Supabase access. */
import "server-only";
import { runAzureScanHistoryRoute } from "../../../../src/server/data/azureScanHistoryRoute";
import { withPgTransaction } from "../../../../src/server/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return runAzureScanHistoryRoute(request, { transaction: withPgTransaction });
}
