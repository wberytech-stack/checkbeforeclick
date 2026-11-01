/** Azure-only protected scan read; legacy Supabase routes remain separate. */
import "server-only";
import { runAzureScanReadRoute } from "../../../../../../src/server/data/azureScanReadRoute";
import { withPgTransaction } from "../../../../../../src/server/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return runAzureScanReadRoute(request, id, { transaction: withPgTransaction });
}
