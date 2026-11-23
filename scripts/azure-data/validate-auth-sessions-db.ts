// Disposable loopback PostgreSQL validation for Azure auth sessions (migration 007).
// Never run against cloud or shared databases.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import pg from "pg";

for (const key of ["CBC_DATABASE_URL", "CBC_TEST_OWNER_URL"]) {
  if (!process.env[key] || new URL(process.env[key]).hostname !== "127.0.0.1") {
    throw new Error("Auth session tests require a disposable loopback database");
  }
}
const issuer = process.env.CBC_TEST_ISSUER;
if (!issuer) throw new Error("Missing disposable issuer");
const app = new pg.Pool({ connectionString: process.env.CBC_DATABASE_URL, max: 8 });
const owner = new pg.Client({ connectionString: process.env.CBC_TEST_OWNER_URL });
let passed = 0;
let failed = 0;
async function check(label: string, test: () => Promise<boolean>) {
  try {
    if (!(await test())) throw new Error("assertion failed");
    passed++;
    console.log("PASS " + label);
  } catch (error) {
    failed++;
    console.error("FAIL " + label + ": " + String(error));
  }
}
function digest(s: string): string {
  return createHash("sha256").update("session-test:" + s).digest("hex");
}
function expiry() { return Math.floor(Date.now() / 1000) + 43200; }
async function create(subject: string, token: string, seconds = expiry()) {
  const r = await app.query("SELECT public.app_create_auth_session($1,$2,$3,$4::bigint) AS ok",
    [issuer, subject, token, seconds]);
  return r.rows[0]?.ok === true;
}
async function resolve(token: string) {
  const r = await app.query("SELECT * FROM public.app_resolve_auth_session($1)", [token]);
  return r.rows;
}
async function rotate(oldToken: string, newToken: string) {
  const r = await app.query("SELECT public.app_rotate_auth_session($1,$2) AS ok", [oldToken, newToken]);
  return r.rows[0]?.ok === true;
}
async function revoke(token: string) {
  const r = await app.query("SELECT public.app_revoke_auth_session($1) AS ok", [token]);
  return r.rows[0]?.ok === true;
}
async function errorCode(action: () => Promise<unknown>): Promise<string | null> {
  try { await action(); return null; }
  catch (error) { return (error as { code?: string }).code ?? "unexpected-error"; }
}
try {
  await owner.connect();
  const signed = await app.query(
    "SELECT * FROM public.app_sign_in($1,$2,$3,$4)",
    [issuer, "session-user", "session@example.test", "Session Test"]
  );
  const userId = signed.rows[0]?.o_user_id;
  const orgId = signed.rows[0]?.o_organization_id;
  assert.ok(userId && orgId);
  await check("S01 runtime role has no admin or BYPASSRLS", async () => {
    const r = await owner.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname='cbc_app'");
    return !!r.rows[0] && Object.values(r.rows[0]).every(v => v === false);
  });
  await check("S02 session ledger RLS enabled with zero policies", async () => {
    const r = await owner.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.auth_sessions'::regclass");
    const p = await owner.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND tablename='auth_sessions'");
    return r.rows[0]?.relrowsecurity === true && p.rows[0]?.n === 0;
  });
  await check("S03 runtime cannot SELECT, INSERT, UPDATE or DELETE ledger", async () => {
    const r = await owner.query(
      "SELECT has_table_privilege('cbc_app','public.auth_sessions','SELECT') AS sel," +
      "has_table_privilege('cbc_app','public.auth_sessions','INSERT') AS ins," +
      "has_table_privilege('cbc_app','public.auth_sessions','UPDATE') AS upd," +
      "has_table_privilege('cbc_app','public.auth_sessions','DELETE') AS del");
    return Object.values(r.rows[0]).every(v => v === false);
  });
  await check("S04 direct session read rejected", async () =>
    await errorCode(() => app.query("SELECT * FROM public.auth_sessions")) === "42501");
  await check("S05 public cannot execute session functions", async () => {
    const r = await owner.query(
      "SELECT count(*)::int AS n FROM pg_proc p WHERE p.oid IN (" +
      "'public.app_create_auth_session(text,text,text,bigint)'::regprocedure," +
      "'public.app_resolve_auth_session(text)'::regprocedure," +
      "'public.app_rotate_auth_session(text,text)'::regprocedure," +
      "'public.app_revoke_auth_session(text)'::regprocedure) AND EXISTS (" +
      "SELECT 1 FROM aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')");
    return r.rows[0].n === 0;
  });
  await check("S06 unknown identity cannot create a session", async () => !(await create("unknown", digest("unknown"))));
  await check("S07 malformed digest rejected", async () =>
    await errorCode(() => create("session-user", "not-hex")) === "22023");
  await check("S08 expired timestamp rejected", async () =>
    await errorCode(() => create("session-user", digest("past"), Math.floor(Date.now()/1000)-1)) === "22023");
  await check("S09 overlong expiry rejected", async () =>
    await errorCode(() => create("session-user", digest("future"), expiry()+86400)) === "22023");
  const first = digest("first");
  await check("S10 verified identity can create session", async () => await create("session-user", first));
  await check("S11 duplicate digest cannot be reused", async () => !(await create("session-user", first)));
  await check("S12 session resolves to bound user, organization and role", async () => {
    const rows = await resolve(first);
    return rows.length === 1 && rows[0].o_user_id === userId &&
      rows[0].o_organization_id === orgId && rows[0].o_role === "owner";
  });
  await check("S13 no user or tenant IDs supplied by browser", async () =>
    (await resolve(digest("nonexistent"))).length === 0);
  await check("S14 malformed cookie digest cannot resolve", async () =>
    (await resolve("x' OR TRUE --")).length === 0);
  const replacement = digest("replacement");
  await check("S15 rotation succeeds atomically", async () => await rotate(first, replacement));
  await check("S16 old digest rejected immediately", async () => (await resolve(first)).length === 0);
  await check("S17 new digest retains original identity", async () =>
    (await resolve(replacement))[0]?.o_user_id === userId);
  await check("S18 rotated credential cannot extend original expiry", async () => {
    const r = await owner.query(
      "SELECT (SELECT expires_at FROM public.auth_sessions WHERE token_digest=$1) = " +
      "(SELECT expires_at FROM public.auth_sessions WHERE token_digest=$2) AS same",
      [first, replacement]);
    return r.rows[0].same === true;
  });
  await check("S19 replay rotation fails", async () => !(await rotate(first, digest("replay"))));
  await check("S20 rotation to same digest rejected", async () =>
    await errorCode(() => rotate(replacement, replacement)) === "22023");
  await check("S21 collision rollback keeps old credential valid", async () => {
    const code = await errorCode(() => rotate(replacement, first));
    return code === "23505" && (await resolve(replacement)).length === 1;
  });
  await check("S22 logout revokes active session", async () =>
    await revoke(replacement) && (await resolve(replacement)).length === 0);
  await check("S23 logout is idempotent", async () => !(await revoke(replacement)));
  await check("S24 revoked digest cannot be reused", async () => !(await create("session-user", replacement)));
  const concurrent = digest("concurrent");
  await create("session-user", concurrent);
  const successors = Array.from({length: 8}, (_,i) => digest("concurrent-" + i));
  const winners = await Promise.all(successors.map(s => rotate(concurrent, s)));
  await check("S25 eight concurrent rotations have exactly one winner", async () =>
    winners.filter(Boolean).length === 1 && (await resolve(concurrent)).length === 0);
  await check("S26 only winning rotated credential resolves", async () => {
    const matches = await Promise.all(successors.map(s => resolve(s)));
    return matches.filter(rows => rows.length === 1).length === 1;
  });
  const expired = digest("expired");
  await create("session-user", expired);
  await owner.query(
    "UPDATE public.auth_sessions SET created_at=clock_timestamp()-interval '2 hours'," +
    "expires_at=clock_timestamp()-interval '1 hour' WHERE token_digest=$1", [expired]);
  await check("S27 DB clock rejects expired session", async () => (await resolve(expired)).length === 0);
  await check("S28 expired session cannot rotate", async () => !(await rotate(expired, digest("expired-rotate"))));
  const removed = digest("membership-removed");
  await create("session-user", removed);
  await owner.query("DELETE FROM public.memberships WHERE user_id=$1 AND organization_id=$2", [userId, orgId]);
  await check("S29 removed membership invalidates live session", async () => (await resolve(removed)).length === 0);
  await check("S30 removed membership cannot rotate session", async () =>
    !(await rotate(removed, digest("membership-rotate"))));
  await check("S31 removed membership cannot create new session", async () =>
    !(await create("session-user", digest("membership-new"))));
  await check("S32 SQL injection input cannot alter users", async () => {
    assert.equal(await errorCode(() => create("session-user", "x'); DROP TABLE public.users;--")), "22023");
    const r = await owner.query("SELECT to_regclass('public.users') IS NOT NULL AS exists");
    return r.rows[0].exists === true;
  });
} catch (error) {
  failed++;
  console.error("FAIL session test setup: " + String(error));
} finally {
  await app.end();
  await owner.end().catch(() => {});
}
console.log("\n=== Gate 008A durable sessions: " + passed + " passed, " + failed + " failed ===");
process.exitCode = failed ? 1 : 0;
