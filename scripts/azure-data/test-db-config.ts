// Gate 008A - offline tests: database configuration, managed identity tokens, transactions and tenant
// context. Fakes only: no database, no network, no Azure.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/azure-data/test-db-config.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseDatabaseConfig, describeDatabaseConfig, DatabaseConfigError } from "../../src/server/db/config.ts";
import { createManagedIdentityTokenProvider, POSTGRES_ENTRA_RESOURCE } from "../../src/server/db/entraToken.ts";
import { runTransaction, runTenantTransaction, TenantContextError, type PooledClient } from "../../src/server/db/transaction.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, info = ""): void {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}${info ? `  [${info}]` : ""}`); }
}
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CLOUD = "postgres://cbc_app_mi@psql-cbc-prod-cc-001.postgres.database.azure.com:5432/cbc";
function throwsConfig(env: Record<string, string | undefined>): string | null {
  try { parseDatabaseConfig(env); return null; } catch (e) { return e instanceof DatabaseConfigError ? e.message : `other:${String(e)}`; }
}

// ---------------------------------------------------------------- configuration
{
  const c = parseDatabaseConfig({ CBC_DATABASE_URL: CLOUD });
  check("C01 cloud host defaults to entra auth, verified TLS with hostname", c.auth === "entra" && c.password === undefined &&
    c.ssl !== false && c.ssl.rejectUnauthorized === true && c.ssl.servername === "psql-cbc-prod-cc-001.postgres.database.azure.com", JSON.stringify(c));
  check("C02 cloud fields parsed", c.host === "psql-cbc-prod-cc-001.postgres.database.azure.com" && c.port === 5432 && c.database === "cbc" && c.user === "cbc_app_mi");
}
for (const [label, env] of [
  ["C03 cloud URL with sslmode=no-verify", { CBC_DATABASE_URL: CLOUD + "?sslmode=no-verify" }],
  ["C04 cloud URL with ssl=false", { CBC_DATABASE_URL: CLOUD + "?ssl=false" }],
  ["C05 cloud URL with sslrootcert", { CBC_DATABASE_URL: CLOUD + "?sslrootcert=/tmp/x" }],
  ["C06 cloud with CBC_DATABASE_SSL=false", { CBC_DATABASE_URL: CLOUD, CBC_DATABASE_SSL: "false" }],
  ["C07 cloud with password auth", { CBC_DATABASE_URL: CLOUD, CBC_DATABASE_AUTH: "password" }],
  ["C08 cloud URL with an embedded password", { CBC_DATABASE_URL: "postgres://cbc_app:pw@db.example.com/cbc" }],
  ["C09 admin role postgres", { CBC_DATABASE_URL: "postgres://postgres:pw@127.0.0.1:5432/cbc" }],
  ["C10 admin role cbcpgadmin", { CBC_DATABASE_URL: "postgres://cbcpgadmin@db.example.com/cbc" }],
  ["C11 non-postgres scheme", { CBC_DATABASE_URL: "http://cbc_app@db.example.com/cbc" }],
  ["C12 missing URL", {}],
  ["C13 missing database name", { CBC_DATABASE_URL: "postgres://cbc_app@db.example.com/" }],
  ["C14 fragment", { CBC_DATABASE_URL: CLOUD + "#x" }],
  ["C15 entra auth on loopback", { CBC_DATABASE_URL: "postgres://cbc_app:pw@127.0.0.1/cbc", CBC_DATABASE_AUTH: "entra" }],
  ["C16 loopback without a password", { CBC_DATABASE_URL: "postgres://cbc_app@127.0.0.1/cbc" }],
  ["C17 CBC_DATABASE_SSL other than false", { CBC_DATABASE_URL: "postgres://cbc_app:pw@127.0.0.1/cbc", CBC_DATABASE_SSL: "no-verify" }],
  ["C18 unknown auth mode", { CBC_DATABASE_URL: CLOUD, CBC_DATABASE_AUTH: "msi" }],
] as const) {
  const m = throwsConfig(env as Record<string, string>);
  check(`${label} -> rejected`, m !== null && !m.startsWith("other:"), String(m));
}
{
  const m = throwsConfig({ CBC_DATABASE_URL: "postgres://cbc_app:SuperSecret%21@db.example.com/cbc" }) ?? "";
  check("C19 rejection messages never echo the password", !m.includes("SuperSecret"), m);
  const bad = throwsConfig({ CBC_DATABASE_URL: "postgres://cbc_app:SuperSecret@[bad" }) ?? "";
  check("C20 an unparsable URL is not echoed", !bad.includes("SuperSecret"), bad);
}
{
  const c = parseDatabaseConfig({ CBC_DATABASE_URL: "postgres://cbc_app:pw@127.0.0.1:55432/cbc_test", CBC_DATABASE_SSL: "false" });
  check("C21 loopback disposable DB: password auth, TLS may be off", c.auth === "password" && c.password === "pw" && c.ssl === false && c.port === 55432);
  const t = parseDatabaseConfig({ CBC_DATABASE_URL: "postgres://cbc_app:pw@127.0.0.1/cbc" });
  check("C22 loopback without CBC_DATABASE_SSL still verifies TLS (no servername for an IP)", t.ssl !== false && t.ssl.rejectUnauthorized === true && t.ssl.servername === undefined);
  check("C23 describeDatabaseConfig never includes the password", !describeDatabaseConfig(c).includes("pw@") && !describeDatabaseConfig(c).includes(":pw"), describeDatabaseConfig(c));
}

// ---------------------------------------------------------------- source invariants
{
  const pg = readFileSync(path.join(ROOT, "src/server/db/postgres.ts"), "utf8");
  const code = pg.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  check("S01 postgres.ts never disables certificate verification", !/rejectUnauthorized:\s*false/.test(code));
  check("S02 postgres.ts does not pass a connectionString to pg (URL parameters could override TLS)", !/connectionString/.test(code));
  check("S03 postgres.ts keeps import \"server-only\"", /^import "server-only";/m.test(pg));
  const repoFiles = ["src/server/db/config.ts", "src/server/db/entraToken.ts", "src/server/db/transaction.ts", "src/server/data/azureStore.ts"];
  check("S04 new data-plane modules never reference the Supabase service role",
    repoFiles.every((f) => !/SUPABASE_SERVICE_ROLE_KEY|createPrivilegedClient|@supabase/.test(readFileSync(path.join(ROOT, f), "utf8"))));
  const store = readFileSync(path.join(ROOT, "src/server/data/azureStore.ts"), "utf8");
  check("S05 azureStore never sends an organization id to SQL and never writes tables directly",
    !/organization_id\s*=|INSERT INTO|UPDATE public\.|DELETE FROM/i.test(store.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")));
  check("S06 azureStore SQL uses bound parameters only (no template interpolation besides the column list)",
    [...store.matchAll(/\$\{([^}]+)\}/g)].every((m) => m[1] === "SCAN_COLUMNS"));
}

// ---------------------------------------------------------------- managed identity token
type Req = { url: string; headers: Record<string, string>; redirect: string };
async function tokenTests() {
  const reqs: Req[] = [];
  let clock = 1_800_000_000_000;
  let reply: () => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> =
    async () => ({ ok: true, status: 200, json: async () => ({ access_token: "eyJ0eXAiOiJKV1Qi.fake.token-0001", expires_on: String(clock / 1000 + 3600) }) });
  const env = { IDENTITY_ENDPOINT: "http://localhost:42356/msi/token", IDENTITY_HEADER: "hdr-secret-123", AZURE_CLIENT_ID: "11111111-2222-3333-4444-555555555555" };
  const fetchFake = async (url: string, init: { headers: Record<string, string>; redirect: "error" }) => { reqs.push({ url, headers: init.headers, redirect: init.redirect }); return reply(); };
  const get = createManagedIdentityTokenProvider({ env, fetch: fetchFake, now: () => clock });
  const t1 = await get();
  const u = new URL(reqs[0].url);
  check("T01 requests the PostgreSQL resource for the user-assigned identity with the identity header",
    u.searchParams.get("resource") === POSTGRES_ENTRA_RESOURCE && u.searchParams.get("client_id") === env.AZURE_CLIENT_ID &&
    u.searchParams.get("api-version") === "2019-08-01" && reqs[0].headers["X-IDENTITY-HEADER"] === "hdr-secret-123" && reqs[0].redirect === "error");
  const t2 = await get();
  check("T02 token is cached while valid (one request)", t1 === t2 && reqs.length === 1);
  clock += 56 * 60 * 1000;   // within 5 minutes of expiry
  await get();
  check("T03 token refreshed 5 minutes before expiry", reqs.length === 2);
  const [a, b] = await Promise.all([(clock += 60 * 60 * 1000, get()), get()]);
  check("T04 concurrent callers share one refresh", a === b && reqs.length === 3);

  for (const [label, r] of [
    ["T05 HTTP 500", async () => ({ ok: false, status: 500, json: async () => ({}) })],
    ["T06 missing token", async () => ({ ok: true, status: 200, json: async () => ({ expires_on: String(clock / 1000 + 3600) }) })],
    ["T07 already-expired token", async () => ({ ok: true, status: 200, json: async () => ({ access_token: "eyJ0eXAiOiJKV1Qi.fake.token-0002", expires_on: String(clock / 1000) }) })],
    ["T08 network error", async () => { throw new Error("connect ECONNREFUSED hdr-secret-123"); }],
  ] as const) {
    reply = r as typeof reply;
    const fresh = createManagedIdentityTokenProvider({ env, fetch: fetchFake, now: () => clock });
    let msg = "";
    try { await fresh(); } catch (e) { msg = (e as Error).message; }
    check(`${label} -> fails closed, error never contains the identity header`, msg !== "" && !msg.includes("hdr-secret-123"), msg);
  }
  // The platform may include metadata alongside the token. A wrong principal,
  // audience or token type must never enter the shared connection-pool cache.
  for (const [label, metadata, accepted] of [
    ["T19 matching token metadata", { client_id: env.AZURE_CLIENT_ID.toUpperCase(), resource: POSTGRES_ENTRA_RESOURCE, token_type: "Bearer" }, true],
    ["T20 wrong managed identity", { client_id: "99999999-2222-3333-4444-555555555555" }, false],
    ["T21 wrong PostgreSQL audience", { resource: "https://management.azure.com/" }, false],
    ["T22 non-bearer token", { token_type: "Basic" }, false],
    ["T23 invalid client identity metadata", { client_id: 42 }, false],
    ["T24 invalid resource metadata", { resource: null }, false],
  ] as const) {
    reply = async () => ({ ok: true, status: 200, json: async () => ({
      access_token: "eyJ0eXAiOiJKV1Qi.fake.token-0003",
      expires_on: String(clock / 1000 + 3600),
      ...metadata,
    }) });
    const fresh = createManagedIdentityTokenProvider({ env, fetch: fetchFake, now: () => clock });
    let success = false;
    let error = "";
    try { await fresh(); success = true; } catch (e) { error = (e as Error).message; }
    check(label, success === accepted && (accepted || (error !== "" && !error.includes("hdr-secret-123"))), error);
  }
  for (const [label, e] of [
    ["T09 non-loopback endpoint", { ...env, IDENTITY_ENDPOINT: "http://169.254.169.254.attacker.example/token" }],
    ["T10 https remote endpoint", { ...env, IDENTITY_ENDPOINT: "https://evil.example/token" }],
    ["T11 missing identity header", { ...env, IDENTITY_HEADER: undefined }],
    ["T12 client id not a GUID", { ...env, AZURE_CLIENT_ID: "x&resource=other" }],
    ["T13 absent user-assigned client ID", { ...env, AZURE_CLIENT_ID: undefined }],
    ["T14 malformed GUID with 36 characters", { ...env, AZURE_CLIENT_ID: "------------------------------------" }],
    ["T15 endpoint with query injection", { ...env, IDENTITY_ENDPOINT: env.IDENTITY_ENDPOINT + "?principal_id=other" }],
    ["T16 endpoint with fragment", { ...env, IDENTITY_ENDPOINT: env.IDENTITY_ENDPOINT + "#secret" }],
    ["T17 endpoint with credentials", { ...env, IDENTITY_ENDPOINT: "http://user:password@localhost:42356/msi/token" }],
    ["T18 identity header with newline", { ...env, IDENTITY_HEADER: "header\r\nInjected: value" }],
  ] as const) {
    const before = reqs.length;
    let threw = false;
    try { createManagedIdentityTokenProvider({ env: e, fetch: fetchFake, now: () => clock }); } catch { threw = true; }
    check(`${label} -> refused before any request`, threw && reqs.length === before);
  }
}

// ---------------------------------------------------------------- transactions and tenant context
function fakePool(opts: { failOn?: string; rollbackFails?: boolean } = {}) {
  const log: string[] = [];
  const released: unknown[] = [];
  let connects = 0;
  const client: PooledClient = {
    query: async (text: string, values?: unknown[]) => {
      log.push(values ? `${text} ${JSON.stringify(values)}` : text);
      if (text === "ROLLBACK" && opts.rollbackFails) throw new Error("connection lost");
      if (opts.failOn && text.includes(opts.failOn)) throw new Error("boom");
      return { rows: [], rowCount: 0 };
    },
    release: (d?: boolean | Error) => { released.push(d); },
  };
  return { pool: { connect: async () => { connects++; return client; } }, log, released, connects: () => connects };
}
const CTX = { userId: "0b9e3a40-1111-4222-8333-944444444444", organizationId: "7c1d2e3f-5555-4666-8777-988888888888" };

async function txTests() {
  {
    const f = fakePool();
    await runTenantTransaction(f.pool, CTX, async (c) => { await c.query("SELECT 1"); });
    check("X01 BEGIN, transaction-local set_config of both settings on the same client, statement, COMMIT",
      f.log[0] === "BEGIN" &&
      f.log[1] === `SELECT set_config('app.current_user_id', $1, true), set_config('app.current_organization_id', $2, true) ${JSON.stringify([CTX.userId, CTX.organizationId])}` &&
      f.log[2] === "SELECT 1" && f.log[3] === "COMMIT" && f.released.length === 1 && f.released[0] === undefined, f.log.join(" | "));
  }
  {
    const f = fakePool({ failOn: "SELECT 2" });
    let err = "";
    try { await runTenantTransaction(f.pool, CTX, async (c) => { await c.query("SELECT 2"); }); } catch (e) { err = (e as Error).message; }
    check("X02 an error rolls back, rethrows the original error and returns the healthy client", err === "boom" && f.log.at(-1) === "ROLLBACK" && !f.log.includes("COMMIT") && f.released[0] === undefined);
  }
  {
    const f = fakePool({ failOn: "SELECT 3", rollbackFails: true });
    let err = "";
    try { await runTransaction(f.pool, async (c) => { await c.query("SELECT 3"); }); } catch (e) { err = (e as Error).message; }
    check("X03 a failed rollback destroys the connection and still surfaces the original error", err === "boom" && f.released[0] instanceof Error);
  }
  for (const [label, ctx] of [
    ["X04 non-UUID user id", { ...CTX, userId: "1; RESET ALL" }],
    ["X05 empty organization id", { ...CTX, organizationId: "" }],
    ["X06 uppercase UUID (not canonical)", { ...CTX, userId: CTX.userId.toUpperCase() }],
    ["X07 missing context", null],
  ] as const) {
    const f = fakePool();
    let typed = false;
    try { await runTenantTransaction(f.pool, ctx as never, async () => {}); } catch (e) { typed = e instanceof TenantContextError; }
    check(`${label} -> rejected before a connection is taken`, typed && f.connects() === 0);
  }
}

async function main() {
  await tokenTests();
  await txTests();
  console.log(`\n=== Gate 008A db config: ${passed} passed, ${failed} failed ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}
let finished = false;
process.on("beforeExit", () => { if (!finished) { console.log("FAIL: run did not finish"); process.exitCode = 1; } });
main().then(() => { finished = true; }, (e) => { finished = true; console.log(`FAIL: unexpected error ${String(e)}`); process.exitCode = 1; });
