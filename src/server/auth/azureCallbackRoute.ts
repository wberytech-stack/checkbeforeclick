/**
 * Azure callback route: one-time PostgreSQL state redemption, issuer-pinned
 * Entra token verification, identity provisioning, then committed session.
 *
 * Each database statement has its OWN short transaction. In particular, the
 * state DELETE commits before the outbound token request; provisioning and
 * session creation also commit before the browser receives a session cookie.
 * Never accept identity, organization, issuer or redirect from request headers.
 */
import "server-only";
import { handleAzureCallbackHttp } from "../../security/azureCallbackHttp";
import { TrustedOidcTransport } from "../../security/azureOidcTransport";
import { completeAzureLogin } from "./completeAzureLogin";
import { parseAzureRuntimeConfig, type AzureRuntimeEnvironment } from "./azureRuntimeConfig";
import { createPostgresLoginStateStore, type CommittedStateQuery } from "./postgresLoginStateStore";
import { createPostgresIdentityProvisioner } from "./postgresIdentityProvisioner";
import { createPostgresAuthSessionStore } from "./postgresAuthSessionStore";

export type AzureCallbackRouteDependencies = {
  env: AzureRuntimeEnvironment;
  /** Resolves only after COMMIT; rejects if commit or rollback fails. */
  transaction<T>(fn: (client: CommittedStateQuery) => Promise<T>): Promise<T>;
  /** Test-only injection; production constructs the issuer-pinned transport. */
  transportFactory?: (issuer: string) => TrustedOidcTransport;
};

export async function runAzureCallbackRoute(
  request: Request,
  deps: AzureCallbackRouteDependencies,
): Promise<Response> {
  let config;
  try {
    config = parseAzureRuntimeConfig(deps.env);
  } catch {
    // The HTTP boundary sends a sanitized, no-store 503 and clears OIDC state.
    return handleAzureCallbackHttp(request, {
      publicOrigin: "", issuer: "",
      complete: async () => { throw new Error("Azure login unavailable"); },
    });
  }

  const { publicOrigin, binding, keys } = config;
  // Autocommit/short transaction per operation. Never enclose the OIDC
  // network exchange in a database transaction.
  const committedQuery: CommittedStateQuery = {
    query: (sql, values) => deps.transaction((client) => client.query(sql, values)),
  };
  return handleAzureCallbackHttp(request, {
    publicOrigin,
    issuer: binding.issuer,
    complete: (fields) => completeAzureLogin({
      callback: {
        ...fields,
        binding,
        redirectUri: publicOrigin + "/auth/callback",
        keys,
        store: createPostgresLoginStateStore(committedQuery),
        transport: deps.transportFactory
          ? deps.transportFactory(binding.issuer)
          : new TrustedOidcTransport(binding.issuer),
      },
      provisioner: createPostgresIdentityProvisioner(committedQuery),
      sessions: createPostgresAuthSessionStore(committedQuery),
    }),
  });
}
