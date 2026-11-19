/**
 * Server-only Azure login-start route wiring. The HTTP boundary validates the
 * request before any Entra metadata fetch or database reservation.
 *
 * The OIDC state reservation runs in its own short PostgreSQL transaction:
 * COMMIT must complete before the browser receives the state cookie or 303.
 * Never hold a transaction open while fetching OIDC metadata.
 */
import "server-only";
import { handleAzureLoginStartHttp } from "../../security/azureLoginStartHttp";
import { TrustedOidcTransport } from "../../security/azureOidcTransport";
import { parseAzureRuntimeConfig, type AzureRuntimeEnvironment } from "./azureRuntimeConfig";
import { createPostgresLoginStateStore, type CommittedStateQuery } from "./postgresLoginStateStore";
import { startAzureLogin } from "./startAzureLogin";

export type AzureLoginStartRouteDependencies = {
  env: AzureRuntimeEnvironment;
  /** Resolves only after COMMIT; rejects if the transaction cannot commit. */
  transaction<T>(fn: (client: CommittedStateQuery) => Promise<T>): Promise<T>;
  /** Injectable for offline tests; production always uses issuer-pinned transport. */
  transportFactory?: (issuer: string) => Pick<TrustedOidcTransport, "metadata">;
};

export async function runAzureLoginStartRoute(
  request: Request,
  deps: AzureLoginStartRouteDependencies
): Promise<Response> {
  let config;
  try {
    config = parseAzureRuntimeConfig(deps.env);
  } catch {
    // No environment values, SQL errors, or key material in HTTP responses.
    return handleAzureLoginStartHttp(request, {
      publicOrigin: "", issuer: "", clientId: "",
      start: async () => { throw new Error("Azure login unavailable"); },
    });
  }

  const { publicOrigin, binding, keys } = config;
  return handleAzureLoginStartHttp(request, {
    publicOrigin, issuer: binding.issuer, clientId: binding.clientId,
    start: async () => {
      const transport = deps.transportFactory
        ? deps.transportFactory(binding.issuer)
        : new TrustedOidcTransport(binding.issuer);
      const store = createPostgresLoginStateStore({
        // Each call commits independently. Never return an uncommitted result.
        query: (sql, values) => deps.transaction((client) => client.query(sql, values)),
      });
      return startAzureLogin({ publicOrigin, binding, keys, store, transport });
    },
  });
}
