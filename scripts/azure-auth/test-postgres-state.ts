/** Offline Gate 008B PostgreSQL OIDC state adapter checks; no network/database. */
import { strict as assert } from "node:assert";
import { createPostgresLoginStateStore, type CommittedStateQuery } from "../../src/server/auth/postgresLoginStateStore.ts";

type Call = { sql: string; values: unknown[] };
const hash = "a".repeat(64);
const NOW = 1_800_000_000;
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); passed++; console.log("PASS " + label); }
  catch (e) { failed++; console.error("FAIL " + label + ": " + String(e)); }
}
function fixture(value: unknown = true) {
  const calls: Call[] = [];
  const db: CommittedStateQuery = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ accepted: value, consumed: value }] };
    },
  };
  return { store: createPostgresLoginStateStore(db), calls };
}
await check("P01 reserve uses bound digest and expiry", async () => {
  const f = fixture();
  assert.equal(await f.store.reserve(hash, NOW), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].sql, "SELECT public.app_reserve_oidc_login_state($1, $2::bigint) AS accepted");
  assert.deepEqual(f.calls[0].values, [hash, NOW]);
  assert.ok(!f.calls[0].sql.includes(hash));
});
await check("P02 consume uses DB clock, not caller-supplied time", async () => {
  const f = fixture();
  assert.equal(await f.store.consume(hash, NOW), true);
  assert.equal(f.calls[0].sql, "SELECT public.app_consume_oidc_login_state($1) AS consumed");
  assert.deepEqual(f.calls[0].values, [hash]);
});
await check("P03 false result denies reservation", async () => {
  assert.equal(await fixture(false).store.reserve(hash, NOW), false);
});
await check("P04 false result denies redemption", async () => {
  assert.equal(await fixture(false).store.consume(hash, NOW), false);
});
await check("P05 string truthiness is not accepted", async () => {
  assert.equal(await fixture("true").store.consume(hash, NOW), false);
});
await check("P06 empty result fails closed", async () => {
  const db: CommittedStateQuery = { query: async () => ({ rows: [] }) };
  assert.equal(await createPostgresLoginStateStore(db).consume(hash, NOW), false);
});
await check("P07 duplicate result fails closed", async () => {
  const db: CommittedStateQuery = { query: async () => ({ rows: [{ consumed: true }, { consumed: true }] }) };
  assert.equal(await createPostgresLoginStateStore(db).consume(hash, NOW), false);
});
await check("P08 malformed digest cannot reach database", async () => {
  const f = fixture(); assert.equal(await f.store.reserve("bad", NOW), false); assert.equal(f.calls.length, 0);
});
await check("P09 uppercase digest cannot reach database", async () => {
  const f = fixture(); assert.equal(await f.store.consume(hash.toUpperCase(), NOW), false); assert.equal(f.calls.length, 0);
});
await check("P10 injection-shaped digest cannot reach database", async () => {
  const f = fixture(); assert.equal(await f.store.consume("x'); DROP TABLE users;--", NOW), false); assert.equal(f.calls.length, 0);
});
await check("P11 negative expiry cannot reach database", async () => {
  const f = fixture(); assert.equal(await f.store.reserve(hash, -1), false); assert.equal(f.calls.length, 0);
});
await check("P12 fractional expiry cannot reach database", async () => {
  const f = fixture(); assert.equal(await f.store.reserve(hash, 1.5), false); assert.equal(f.calls.length, 0);
});
await check("P13 NaN expiry cannot reach database", async () => {
  const f = fixture(); assert.equal(await f.store.reserve(hash, NaN), false); assert.equal(f.calls.length, 0);
});
await check("P14 unsafe caller time cannot reach database", async () => {
  const f = fixture(); assert.equal(await f.store.consume(hash, Number.MAX_SAFE_INTEGER + 1), false); assert.equal(f.calls.length, 0);
});
await check("P15 query failure denies login and hides SQL details", async () => {
  const db: CommittedStateQuery = { query: async () => { throw new Error("password=secret"); } };
  await assert.rejects(createPostgresLoginStateStore(db).reserve(hash, NOW),
    (e: unknown) => e instanceof Error && e.message === "OIDC login-state storage unavailable");
});
await check("P16 consume query failure also fails closed", async () => {
  const db: CommittedStateQuery = { query: async () => { throw new Error("connection string"); } };
  await assert.rejects(createPostgresLoginStateStore(db).consume(hash, NOW),
    (e: unknown) => e instanceof Error && e.message === "OIDC login-state storage unavailable");
});
await check("P17 invalid executor rejected", () => {
  assert.throws(() => createPostgresLoginStateStore(null as never), /storage unavailable/);
});
await check("P18 reservation and redemption are separate committed operations", async () => {
  const f = fixture(); await f.store.reserve(hash, NOW); await f.store.consume(hash, NOW);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].sql.includes("app_reserve_oidc_login_state"));
  assert.ok(f.calls[1].sql.includes("app_consume_oidc_login_state"));
});
console.log("\n=== Gate 008B PostgreSQL OIDC state adapter: " + passed + " passed, " + failed + " failed ===");
process.exitCode = failed ? 1 : 0;
