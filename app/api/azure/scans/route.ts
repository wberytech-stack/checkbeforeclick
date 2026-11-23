/** Azure-only scan creation; no Supabase session or Inngest dispatch. */
import "server-only";
import { runAzureScanCreateRoute } from "../../../../src/server/data/azureScanCreateRoute";
import { withPgTransaction } from "../../../../src/server/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return runAzureScanCreateRoute(request, { env: process.env, transaction: withPgTransaction });
}
