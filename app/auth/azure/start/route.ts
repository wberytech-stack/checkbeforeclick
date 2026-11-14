/**
 * Azure-native Entra login initiation. This route does not use Supabase auth.
 * It cannot redirect until the one-time state reservation has committed.
 */
import "server-only";
import { runAzureLoginStartRoute } from "../../../../src/server/auth/azureLoginStartRoute";
import { withPgTransaction } from "../../../../src/server/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return runAzureLoginStartRoute(request, {
    env: process.env,
    transaction: withPgTransaction,
  });
}
