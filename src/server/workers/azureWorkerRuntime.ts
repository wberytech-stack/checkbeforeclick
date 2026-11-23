// Azure worker runtime boundary. Pure dependency-injected module so the role
// attestation and fail-closed behavior can be exercised without cloud access.
import type { DatabaseConfig } from "../db/config";
import type { ScanProcessor, WorkerOptions, WorkerQuery, WorkerSummary } from "./azureScanWorker";

export type WorkerPoolSettings = {
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: { rejectUnauthorized: true; servername?: string };
  password: () => Promise<string>;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statement_timeout: number;
  application_name: string;
};
export type WorkerPool = WorkerQuery & { end(): Promise<void> };
export type WorkerRuntimeDeps = {
  config: DatabaseConfig;
  identityClientId: string | undefined;
  webIdentityClientId?: string;
  tokenProvider: () => Promise<string>;
  createPool: (settings: WorkerPoolSettings) => WorkerPool;
  process: ScanProcessor;
  runBatch: (db: WorkerQuery, process: ScanProcessor, options: WorkerOptions) => Promise<WorkerSummary>;
  onEvent?: WorkerOptions["onEvent"];
};

export class WorkerRuntimeError extends Error {
  constructor() { super("Azure worker runtime unavailable"); this.name = "WorkerRuntimeError"; }
}

// Role check runs before any lease claim. A compromised database grant must
// never turn a worker into a schema owner or a direct scan/evidence writer.
export const ATTEST_WORKER_ROLE = `SELECT current_user AS role,
  r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls, r.rolinherit,
  pg_has_role(current_user, 'cbc_app', 'MEMBER') AS web_member,
  has_table_privilege(current_user, 'public.scans', 'INSERT,UPDATE,DELETE') AS scan_write,
  has_table_privilege(current_user, 'public.evidence_items', 'INSERT,UPDATE,DELETE') AS evidence_write,
  has_table_privilege(current_user, 'public.vendor_results', 'INSERT,UPDATE,DELETE') AS vendor_write,
  has_table_privilege(current_user, 'public.scan_job_outbox', 'SELECT,INSERT,UPDATE,DELETE') AS outbox_access
FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function safeConfig(config: DatabaseConfig, clientId: string | undefined, webClientId?: string): boolean {
  return config.user === "cbc_worker" && config.auth === "entra" && config.password === undefined &&
    config.ssl !== false && config.ssl.rejectUnauthorized === true &&
    typeof config.ssl.servername === "string" && config.ssl.servername === config.host &&
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(config.host.toLowerCase()) &&
    typeof clientId === "string" && UUID.test(clientId) &&
    (webClientId === undefined || clientId.toLowerCase() !== webClientId.toLowerCase());
}
function attested(rows: Record<string, unknown>[]): boolean {
  if (rows.length !== 1) return false;
  const r = rows[0];
  return r?.role === "cbc_worker" &&
    ["rolsuper", "rolcreatedb", "rolcreaterole", "rolbypassrls", "rolinherit", "web_member",
      "scan_write", "evidence_write", "vendor_write", "outbox_access"].every(k => r[k] === false);
}

/** One invocation, one bounded claim, one isolated worker pool. No timers or
 * deployment side effects. A platform scheduler invokes this explicitly. */
export async function runAzureWorkerRuntime(deps: WorkerRuntimeDeps): Promise<WorkerSummary> {
  if (!safeConfig(deps.config, deps.identityClientId, deps.webIdentityClientId)) throw new WorkerRuntimeError();
  let pool: WorkerPool;
  try {
    pool = deps.createPool({
      host: deps.config.host, port: deps.config.port, database: deps.config.database,
      user: "cbc_worker", ssl: deps.config.ssl as WorkerPoolSettings["ssl"],
      password: deps.tokenProvider, max: 1, idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 5000, statement_timeout: 15000,
      application_name: "cbc-azure-worker",
    });
  } catch { throw new WorkerRuntimeError(); }
  try {
    const result = await pool.query(ATTEST_WORKER_ROLE, []);
    if (!result || !Array.isArray(result.rows) || !attested(result.rows)) throw new WorkerRuntimeError();
    return await deps.runBatch(pool, deps.process, {
      batchSize: 1, leaseSeconds: 120, maxWorkMs: 60000, onEvent: deps.onEvent,
    });
  } catch {
    // No SQL, credentials, raw inputs, evidence or provider errors cross this boundary.
    throw new WorkerRuntimeError();
  } finally {
    try { await pool.end(); } catch { /* Connection shutdown errors are sanitized. */ }
  }
}
