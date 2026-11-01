/** Offline Gate 008B PostgreSQL session adapter checks; no database/network. */
import { strict as assert } from "node:assert";
import { createPostgresAuthSessionStore, type CommittedSessionQuery } from "../../src/server/auth/postgresAuthSessionStore.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const identity = { issuer: "https://tenant.ciamlogin.com/tenant/v2.0", subject: "oidc-subject", email: null, displayName: null };
const row = { o_user_id: USER, o_organization_id: ORG, o_role: "owner" };
type Call = { sql: string; values: unknown[] };
function fixture(rows: Record<string, unknown>[] = [{ ok: true }]) {
  const calls: Call[] = [];
  const query: CommittedSessionQuery = {
    async query(sql, values) { calls.push({ sql, values }); return { rows }; },
  };
  return { store: createPostgresAuthSessionStore(query), calls };
}
let passed = 0;
let failed = 0;
async function check(name: string, test: () => unknown | Promise<unknown>) {
  try { await test(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${String(error)}`); }
}
const EXPIRY = 1800000000;
await check("S01 create binds issuer, subject, digest and expiry", async () => {
  const f = fixture(); assert.equal(await f.store.create(identity, A, EXPIRY), true);
  assert.equal(f.calls[0].sql, "SELECT public.app_create_auth_session($1,$2,$3,$4::bigint) AS ok");
  assert.deepEqual(f.calls[0].values, [identity.issuer, identity.subject, A, EXPIRY]);
});
await check("S02 SQL text never contains identity or digest", async () => {
  const f = fixture(); await f.store.create(identity, A, EXPIRY);
  assert.ok(!f.calls[0].sql.includes(A)); assert.ok(!f.calls[0].sql.includes(identity.subject));
});
await check("S03 false creation denies cookie issuance", async () => assert.equal(await fixture([{ ok: false }]).store.create(identity, A, EXPIRY), false));
await check("S04 string truthiness cannot authorize creation", async () => assert.equal(await fixture([{ ok: "true" }]).store.create(identity, A, EXPIRY), false));
await check("S05 empty create result fails closed", async () => assert.equal(await fixture([]).store.create(identity, A, EXPIRY), false));
await check("S06 multiple create rows fail closed", async () => assert.equal(await fixture([{ ok: true }, { ok: true }]).store.create(identity, A, EXPIRY), false));
await check("S07 malformed digest never reaches SQL", async () => {
  const f = fixture(); assert.equal(await f.store.create(identity, "x'); DROP TABLE users;--", EXPIRY), false); assert.equal(f.calls.length, 0);
});
await check("S08 uppercase digest never reaches SQL", async () => {
  const f = fixture(); assert.equal(await f.store.create(identity, A.toUpperCase(), EXPIRY), false); assert.equal(f.calls.length, 0);
});
await check("S09 invalid issuer rejected before SQL", async () => {
  for (const issuer of ["http://example.com", "javascript:evil", "https://u:p@example.com", "https://example.com/#x", "https://example.com/?q=1", "https://example.com/\n"]) {
    const f = fixture(); assert.equal(await f.store.create({ ...identity, issuer }, A, EXPIRY), false); assert.equal(f.calls.length, 0);
  }
});
await check("S10 missing subject rejected before SQL", async () => {
  const f = fixture(); assert.equal(await f.store.create({ ...identity, subject: "" }, A, EXPIRY), false); assert.equal(f.calls.length, 0);
});
await check("S11 control-character subject rejected", async () => {
  const f = fixture(); assert.equal(await f.store.create({ ...identity, subject: "bad\nsub" }, A, EXPIRY), false); assert.equal(f.calls.length, 0);
});
await check("S12 invalid expiry rejected", async () => {
  for (const expiry of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture(); assert.equal(await f.store.create(identity, A, expiry), false); assert.equal(f.calls.length, 0);
  }
});
await check("S13 resolve passes only digest", async () => {
  const f = fixture([row]); assert.deepEqual(await f.store.resolve(A), { userId: USER, organizationId: ORG, role: "owner" });
  assert.equal(f.calls[0].sql, "SELECT o_user_id, o_organization_id, o_role FROM public.app_resolve_auth_session($1)");
  assert.deepEqual(f.calls[0].values, [A]);
});
await check("S14 unknown session returns null", async () => assert.equal(await fixture([]).store.resolve(A), null));
await check("S15 malformed digest cannot query", async () => {
  const f = fixture([row]); assert.equal(await f.store.resolve("invalid"), null); assert.equal(f.calls.length, 0);
});
await check("S16 duplicate session rows denied", async () => {
  await assert.rejects(fixture([row, row]).store.resolve(A), /session storage unavailable/);
});
await check("S17 malformed user UUID denied", async () => {
  await assert.rejects(fixture([{ ...row, o_user_id: "bad" }]).store.resolve(A), /session storage unavailable/);
});
await check("S18 malformed organization UUID denied", async () => {
  await assert.rejects(fixture([{ ...row, o_organization_id: "bad" }]).store.resolve(A), /session storage unavailable/);
});
await check("S19 invalid membership role denied", async () => {
  await assert.rejects(fixture([{ ...row, o_role: "owner; DROP TABLE" }]).store.resolve(A), /session storage unavailable/);
});
await check("S20 missing role denied", async () => {
  await assert.rejects(fixture([{ ...row, o_role: null }]).store.resolve(A), /session storage unavailable/);
});
await check("S21 rotation binds only two digests", async () => {
  const f = fixture(); assert.equal(await f.store.rotate(A, B), true);
  assert.equal(f.calls[0].sql, "SELECT public.app_rotate_auth_session($1,$2) AS ok");
  assert.deepEqual(f.calls[0].values, [A, B]);
});
await check("S22 rotation replay false", async () => assert.equal(await fixture([{ ok: false }]).store.rotate(A, B), false));
await check("S23 rotation to same digest denied before SQL", async () => {
  const f = fixture(); assert.equal(await f.store.rotate(A, A), false); assert.equal(f.calls.length, 0);
});
await check("S24 invalid rotation digest denied", async () => {
  const f = fixture(); assert.equal(await f.store.rotate(A, "bad"), false); assert.equal(f.calls.length, 0);
});
await check("S25 revoke is parameterized and idempotent", async () => {
  const f = fixture([{ ok: false }]); assert.equal(await f.store.revoke(A), false);
  assert.equal(f.calls[0].sql, "SELECT public.app_revoke_auth_session($1) AS ok"); assert.deepEqual(f.calls[0].values, [A]);
});
await check("S26 malformed revoke digest denied", async () => {
  const f = fixture(); assert.equal(await f.store.revoke("bad"), false); assert.equal(f.calls.length, 0);
});
await check("S27 database exceptions sanitized for all methods", async () => {
  const db: CommittedSessionQuery = { query: async () => { throw new Error("password=supersecret"); } };
  const s = createPostgresAuthSessionStore(db);
  for (const p of [s.create(identity, A, EXPIRY), s.resolve(A), s.rotate(A, B), s.revoke(A)]) {
    await assert.rejects(p, e => e instanceof Error && e.message === "Azure authentication session storage unavailable");
  }
});
await check("S28 invalid query executor rejected", () => assert.throws(() => createPostgresAuthSessionStore(null as never), /session storage unavailable/));
await check("S29 no raw cookie is accepted as a digest", async () => {
  const f = fixture(); const raw = "e".repeat(43);
  assert.equal(await f.store.resolve(raw), null); assert.equal(f.calls.length, 0);
});
await check("S30 invalid SQL shape fails closed", async () => {
  const db: CommittedSessionQuery = { query: async () => ({ rows: null as never }) };
  await assert.rejects(createPostgresAuthSessionStore(db).resolve(A), /session storage unavailable/);
});
console.log(`\n=== Gate 008B PostgreSQL session adapter: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed ? 1 : 0;
