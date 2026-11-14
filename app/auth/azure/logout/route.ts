/**
 * Azure-native logout endpoint. Deliberately separate from legacy Supabase
 * signout; no GET logout and no database operation without same-origin POST.
 */
import "server-only";
import { runAzureLogoutRoute } from "../../../../src/server/auth/azureLogoutRoute";
import { withPgTransaction } from "../../../../src/server/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return runAzureLogoutRoute(request, {
    env: process.env,
    transaction: withPgTransaction,
  });
}
