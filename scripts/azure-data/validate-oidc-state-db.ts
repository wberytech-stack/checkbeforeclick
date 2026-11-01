// Gate 008A/008B: disposable PostgreSQL tests for one-time OIDC login state.
// The runner sets loopback-only test URLs and applies migrations 001-006.
// No Azure calls, no live accounts, no application secrets.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import pg from "pg";

for (const name of ["CBC_DATABASE_URL", "CBC_TEST_OWNER_URL"]) {
  const value = process.env[name];
  if (!value || new URL(value).hostname !== "127.0.0.1") {
    throw new Error("OIDC state tests require disposable loopback PostgreSQL");
  }
}

const app = new pg.Pool({ connectionString: process.env.CBC_DATABASE_URL, max: 8 });
const owner = new pg.Client({ connectionString: process.env.CBC_TEST_OWNER_URL });
let passed = 0;
let failed = 0;
function check(name: string, ok: unknown): void {
  if (ok === true) { passed++; console.log("PASS " + name); }
  else { failed++; console.error("FAIL " + name); }
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function expires(): number {
  return Math.floor(Date.now() / 1000) + 300;
}
async function reserve(hash: string, expiry = expires()): Promise<boolean> {
  const result = await app.query(
    "SELECT public.app_reserve_oidc_login_state($1, $2::bigint) AS accepted",
    [hash, expiry]
  );
  return result.rows.length === 1 && result.rows[0].accepted === true;
}
async function consume(hash: string): Promise<boolean> {
  const result = await app.query(
    "SELECT public.app_consume_oidc_login_state($1) AS consumed",
    [hash]
  );
  return result.rows.length === 1 && result.rows[0].consumed === true;
}
async function errorCode(action: () => Promise<unknown>): Promise<string | null> {
  try { await action(); return null; }
  catch (error) { return (error as { code?: string }).code ?? "unexpected-error"; }
}
async function count(hash: string): Promise<number> {
  const r = await owner.query(
    "SELECT count(*)::int AS n FROM public.oidc_login_states WHERE state_digest = $1", [hash]
  );
  return r.rows[0].n;
}

try {
  await owner.connect();
  const role = (await owner.query(
    "SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = 'cbc_app'"
  )).rows[0];
  check("L01 runtime role remains non-admin and NOBYPASSRLS",
    !!role && !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole && !role.rolbypassrls);

  const rel = (await owner.query(
    "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.oidc_login_states'::regclass"
  )).rows[0];
  check("L02 replay ledger has RLS enabled", rel?.relrowsecurity === true);
  const policies = (await owner.query(
    "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'oidc_login_states'"
  )).rows[0].n;
  check("L03 no browser/runtime RLS policy exposes replay ledger", policies === 0);

  const privileges = (await owner.query(
    "SELECT has_table_privilege('cbc_app', 'public.oidc_login_states', 'SELECT') AS sel, " +
    "has_table_privilege('cbc_app', 'public.oidc_login_states', 'INSERT') AS ins, " +
    "has_table_privilege('cbc_app', 'public.oidc_login_states', 'UPDATE') AS upd, " +
    "has_table_privilege('cbc_app', 'public.oidc_login_states', 'DELETE') AS del, " +
    "has_table_privilege('cbc_app', 'public.oidc_login_states', 'TRUNCATE') AS trunc"
  )).rows[0];
  check("L04 runtime has no direct table privileges",
    Object.values(privileges).every((value) => value === false));
  const grants = (await owner.query(
    "SELECT has_function_privilege('cbc_app', 'public.app_reserve_oidc_login_state(text,bigint)', 'EXECUTE') AS reserve, " +
    "has_function_privilege('cbc_app', 'public.app_consume_oidc_login_state(text)', 'EXECUTE') AS consume"
  )).rows[0];
  check("L05 only the narrow callable interface is granted to runtime", grants.reserve && grants.consume);
  const publicGrants = (await owner.query(
    "SELECT count(*)::int AS n FROM pg_proc p WHERE p.oid IN " +
    "('public.app_reserve_oidc_login_state(text,bigint)'::regprocedure, " +
    "'public.app_consume_oidc_login_state(text)'::regprocedure) " +
    "AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE')"
  )).rows[0].n;
  check("L06 PUBLIC cannot execute either SECURITY DEFINER function", publicGrants === 0);
  check("L07 direct runtime read is rejected",
    await errorCode(() => app.query("SELECT * FROM public.oidc_login_states")) === "42501");

  const a = digest("replay-a");
  check("L08 first reservation succeeds", await reserve(a));
  check("L09 duplicate reservation fails", !(await reserve(a)));
  check("L10 successful consume removes the reservation", await consume(a) && await count(a) === 0);
  check("L11 second consume fails", !(await consume(a)));
  check("L12 unknown state cannot be consumed", !(await consume(digest("unknown"))));

  const concurrent = digest("concurrent");
  await reserve(concurrent);
  const results = await Promise.all(Array.from({ length: 8 }, () => consume(concurrent)));
  check("L13 eight concurrent callbacks have exactly one winner",
    results.filter(Boolean).length === 1 && await count(concurrent) === 0);

  check("L14 malformed digest rejected on reservation",
    await errorCode(() => reserve("not-a-digest")) === "22023");
  check("L15 SQL injection-shaped digest rejected",
    await errorCode(() => consume("x'); DROP TABLE public.users;--")) === "22023");
  check("L16 expired reservation timestamp rejected",
    await errorCode(() => reserve(digest("past"), Math.floor(Date.now() / 1000) - 1)) === "22023");
  check("L17 far-future reservation timestamp rejected",
    await errorCode(() => reserve(digest("future"), Math.floor(Date.now() / 1000) + 86400)) === "22023");
  check("L18 malformed null digest rejected",
    await errorCode(() => app.query("SELECT public.app_consume_oidc_login_state(NULL)")) === "22023");

  const expired = digest("expired");
  await reserve(expired);
  await owner.query(
    "UPDATE public.oidc_login_states SET expires_at = clock_timestamp() - interval '1 second' WHERE state_digest = $1",
    [expired]
  );
  check("L19 DB clock rejects expired state even before cleanup", !(await consume(expired)));
  check("L20 expired record remains until opportunistic cleanup", await count(expired) === 1);
  const cleanup = digest("cleanup");
  check("L21 next reservation succeeds and removes expired records",
    await reserve(cleanup) && await count(expired) === 0);
  check("L22 newly reserved state still consumes successfully", await consume(cleanup));
  check("L23 ledger stores only digest, expiry and creation time",
    (await owner.query(
      "SELECT array_agg(column_name ORDER BY ordinal_position) AS names " +
      "FROM information_schema.columns WHERE table_schema='public' AND table_name='oidc_login_states'"
    )).rows[0].names.join(",") === "state_digest,expires_at,created_at");
  assert.equal((await owner.query("SELECT to_regclass('public.users') IS NOT NULL AS exists")).rows[0].exists, true);
  check("L24 SQL injection did not alter the existing users table", true);
} catch (error) {
  failed++;
  console.error("FAIL OIDC replay ledger unexpected error: " + String(error));
} finally {
  await app.end();
  await owner.end().catch(() => {});
}
console.log("\n=== Gate 008A OIDC replay ledger (disposable DB): " + passed + " passed, " + failed + " failed ===");
process.exitCode = failed ? 1 : 0;
