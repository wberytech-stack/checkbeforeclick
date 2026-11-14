/**
 * Azure-native Entra authorization-code callback. Legacy Supabase account
 * preservation is intentionally not required for the clean-room migration.
 * This route does not issue a browser credential until PostgreSQL commits.
 */
import "server-only";
import { runAzureCallbackRoute } from "../../../src/server/auth/azureCallbackRoute";
import { withPgTransaction } from "../../../src/server/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return runAzureCallbackRoute(request, {
    env: process.env,
    transaction: withPgTransaction,
  });
}
