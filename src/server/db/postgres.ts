import "server-only";

import { Pool } from "pg";
import type { PoolClient } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __cbcPgPool: Pool | undefined;
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.CBC_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "CBC_DATABASE_URL environment variable is not set. " +
      "This server-only module requires a PostgreSQL connection string."
    );
  }
  return databaseUrl;
}

function getPgPool(): Pool {
  if (!globalThis.__cbcPgPool) {
    globalThis.__cbcPgPool = new Pool({
      connectionString: getDatabaseUrl(),
      ssl:
        process.env.CBC_DATABASE_SSL === "false"
          ? false
          : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return globalThis.__cbcPgPool;
}

/**
 * Executes a callback inside a single PostgreSQL transaction.
 * - Acquires one client from the pool.
 * - Issues BEGIN before calling the callback.
 * - Issues COMMIT on success.
 * - Issues ROLLBACK on any error.
 * - Always releases the client back to the pool.
 *
 * All statements inside the callback share one physical connection
 * and one transaction. This is required for transaction-local
 * set_config() calls: both set_config calls and the DB function call
 * must use the same client instance passed to the callback.
 *
 * Future use:
 *   await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
 *   await client.query("SELECT set_config('app.current_organization_id', $1, true)", [orgId]);
 *   await client.query("SELECT public.app_record_fast_scan_result(...)");
 */
export async function withPgTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPgPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
