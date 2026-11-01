import "server-only";

import { Pool } from "pg";
import type { PoolClient } from "pg";
import { parseDatabaseConfig, describeDatabaseConfig } from "./config";
import { createManagedIdentityTokenProvider } from "./entraToken";
import { runTransaction, runTenantTransaction, type PoolLike, type Queryable, type TenantContext } from "./transaction";

// Gate 008A: one pool per process, configured by src/server/db/config.ts.
//   - Cloud (Azure Database for PostgreSQL): verified TLS (chain and hostname) and a Microsoft Entra token
//     from the Container App's managed identity as the password, refreshed before expiry. No stored secret.
//   - Loopback disposable databases: password from the URL, TLS optional.
// Before Gate 008A this pool used { rejectUnauthorized: false } (unverified TLS), which AGENTS.md
// section 14 forbids for any non-loopback database.

declare global {
  // eslint-disable-next-line no-var
  var __cbcPgPool: Pool | undefined;
}

function getPgPool(): Pool {
  if (!globalThis.__cbcPgPool) {
    const config = parseDatabaseConfig(process.env);
    const password =
      config.auth === "entra"
        ? createManagedIdentityTokenProvider({
            env: process.env,
            fetch: (url, init) => fetch(url, init),
            now: () => Date.now(),
          })
        : config.password;
    const pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password,
      ssl: config.ssl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
      application_name: "cbc-web",
    });
    // An idle client error must not crash the process; log only the safe description.
    pool.on("error", () => console.error(`postgres pool client error (${describeDatabaseConfig(config)})`));
    globalThis.__cbcPgPool = pool;
  }
  return globalThis.__cbcPgPool;
}

/**
 * Executes a callback inside a single PostgreSQL transaction on one client (BEGIN/COMMIT, ROLLBACK on
 * error; a connection whose rollback fails is destroyed). Transaction-local set_config() calls and the
 * statements they authorize must use the client passed to the callback.
 */
export async function withPgTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  return runTransaction(getPgPool() as unknown as PoolLike, (client) => callback(client as unknown as PoolClient));
}

/** A transaction that runs as `ctx.userId` in `ctx.organizationId` (row-level security applies). */
export async function withTenantTransaction<T>(ctx: TenantContext, callback: (client: Queryable) => Promise<T>): Promise<T> {
  return runTenantTransaction(getPgPool() as unknown as PoolLike, ctx, callback);
}
