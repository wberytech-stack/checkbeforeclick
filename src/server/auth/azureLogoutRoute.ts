/**
 * Route-level Azure logout orchestration. Server configuration is the sole
 * redirect authority; the database transaction must COMMIT before a 303.
 * No request Host, forwarded headers, user IDs or organization IDs are trusted.
 */
import "server-only";
import { handleAzureLogoutHttp } from "../../security/azureLogoutHttp";
import { parseAzureRuntimeConfig, type AzureRuntimeEnvironment } from "./azureRuntimeConfig";
import { createPostgresAuthSessionStore, type CommittedSessionQuery } from "./postgresAuthSessionStore";

export type AzureLogoutRouteDependencies = {
  env: AzureRuntimeEnvironment;
  /** Must commit or reject before resolving. Never issue a response inside the transaction. */
  transaction<T>(fn: (client: CommittedSessionQuery) => Promise<T>): Promise<T>;
};

export async function runAzureLogoutRoute(
  request: Request,
  deps: AzureLogoutRouteDependencies
): Promise<Response> {
  let publicOrigin = "";
  try {
    publicOrigin = parseAzureRuntimeConfig(deps.env).publicOrigin;
  } catch {
    // The HTTP boundary returns a no-store 503 without revealing configuration.
  }
  return handleAzureLogoutHttp(request, {
    publicOrigin,
    revoke: (digest) => deps.transaction((client) =>
      createPostgresAuthSessionStore(client).revoke(digest)),
  });
}
