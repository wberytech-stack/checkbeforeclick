/**
 * Gate 008B: PostgreSQL-backed, one-time OIDC login-state ledger.
 *
 * Backed by Gate 008A migration 006. The database functions own the unique
 * reservation and atomic DELETE/RETURNING. The runtime has no direct table
 * grants. Callers MUST supply a pool/autocommit query executor (or an executor
 * that commits before resolving); never wrap redemption in a long transaction
 * that might roll back after a provider token exchange.
 *
 * The callback MUST call consumeLoginState before exchanging an auth code.
 * The caller, not this module, owns the verified-TLS Entra database pool.
 */
import "server-only";
import type { LoginStateStore } from "../../security/azureAuthState";

export type CommittedStateQuery = {
  query(sql: string, values: readonly unknown[]): Promise<{
    rows: ReadonlyArray<Record<string, unknown>>;
  }>;
};

const DIGEST = /^[0-9a-f]{64}$/;
const RESERVE_SQL =
  "SELECT public.app_reserve_oidc_login_state($1, $2::bigint) AS accepted";
const CONSUME_SQL =
  "SELECT public.app_consume_oidc_login_state($1) AS consumed";

function validDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}
function validSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
async function accepted(
  query: CommittedStateQuery,
  sql: string,
  params: readonly unknown[],
  column: "accepted" | "consumed"
): Promise<boolean> {
  try {
    const result = await query.query(sql, params);
    return result.rows.length === 1 && result.rows[0]?.[column] === true;
  } catch {
    // Fail closed; never surface SQL, digests, or connection details to the browser.
    throw new Error("OIDC login-state storage unavailable");
  }
}

export function createPostgresLoginStateStore(query: CommittedStateQuery): LoginStateStore {
  if (!query || typeof query.query !== "function") {
    throw new Error("OIDC login-state storage unavailable");
  }
  return {
    async reserve(stateDigest, expiresAtSeconds) {
      if (!validDigest(stateDigest) || !validSeconds(expiresAtSeconds)) return false;
      return accepted(query, RESERVE_SQL, [stateDigest, expiresAtSeconds], "accepted");
    },
    async consume(stateDigest, nowSeconds) {
      if (!validDigest(stateDigest) || !validSeconds(nowSeconds)) return false;
      // Database clock is authoritative. Do not pass caller time to SQL.
      return accepted(query, CONSUME_SQL, [stateDigest], "consumed");
    },
  };
}
