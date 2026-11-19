/** Offline Azure identity provisioning tests: fake PostgreSQL, no network/secrets. */
import { strict as assert } from "node:assert";
import { createPostgresIdentityProvisioner, type CommittedIdentityQuery } from "../../src/server/auth/postgresIdentityProvisioner.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const identity = {
  issuer: "https://tenant.ciamlogin.com/tenant/v2.0",
  subject: "verified-subject",
  email: "display@example.test",
  displayName: "Test User",
};
const validRow = { o_user_id: USER, o_organization_id: ORG, o_role: "owner", o_created: true };
type Call = { sql: string; values: unknown[] };
function fixture(rows: Record<string, unknown>[] = [validRow]) {
  const calls: Call[] = [];
  const query: CommittedIdentityQuery = {
    async query(sql, values) { calls.push({ sql, values }); return { rows }; },
  };
  return { store: createPostgresIdentityProvisioner(query), calls };
}
let passed = 0;
let failed = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + ": " + String(error)); }
}

await check("P01 provision binds verified issuer and subject without tenant inputs", async () => {
  const f = fixture();
  assert.deepEqual(await f.store.provision(identity), { userId: USER, organizationId: ORG, role: "owner", created: true });
  assert.equal(f.calls[0].sql, "SELECT o_user_id, o_organization_id, o_role, o_created FROM public.app_sign_in($1,$2,$3,$4)");
  assert.deepEqual(f.calls[0].values, [identity.issuer, identity.subject, identity.email, identity.displayName]);
});
await check("P02 SQL text contains no identity data", async () => {
  const f = fixture(); await f.store.provision(identity);
  assert.ok(!f.calls[0].sql.includes(identity.subject));
  assert.ok(!f.calls[0].sql.includes(identity.email));
});
await check("P03 existing account reports created=false", async () => {
  const f = fixture([{ ...validRow, o_created: false }]);
  assert.equal((await f.store.provision(identity))?.created, false);
});
await check("P04 nullable display claims are accepted", async () => {
  const f = fixture(); await f.store.provision({ ...identity, email: null, displayName: null });
  assert.deepEqual(f.calls[0].values.slice(2), [null, null]);
});
await check("P05 no result fails closed", async () => {
  await assert.rejects(fixture([]).store.provision(identity), /identity provisioning unavailable/);
});
await check("P06 duplicate results fail closed", async () => {
  await assert.rejects(fixture([validRow, validRow]).store.provision(identity), /identity provisioning unavailable/);
});
await check("P07 forged created string fails closed", async () => {
  await assert.rejects(fixture([{ ...validRow, o_created: "true" }]).store.provision(identity), /identity provisioning unavailable/);
});
await check("P08 missing role fails closed", async () => {
  await assert.rejects(fixture([{ ...validRow, o_role: null }]).store.provision(identity), /identity provisioning unavailable/);
});
await check("P09 malformed role fails closed", async () => {
  await assert.rejects(fixture([{ ...validRow, o_role: "owner;DROP" }]).store.provision(identity), /identity provisioning unavailable/);
});
await check("P10 malformed user UUID fails closed", async () => {
  await assert.rejects(fixture([{ ...validRow, o_user_id: "bad" }]).store.provision(identity), /identity provisioning unavailable/);
});
await check("P11 malformed organization UUID fails closed", async () => {
  await assert.rejects(fixture([{ ...validRow, o_organization_id: "bad" }]).store.provision(identity), /identity provisioning unavailable/);
});
await check("P12 invalid issuer rejected without SQL", async () => {
  for (const issuer of ["http://tenant.test/", "https://u:p@tenant.test/", "https://tenant.test/#fragment", "https://tenant.test/?q=1", "https://tenant.test/\n"]) {
    const f = fixture(); assert.equal(await f.store.provision({ ...identity, issuer }), null); assert.equal(f.calls.length, 0);
  }
});
await check("P13 empty subject rejected without SQL", async () => {
  const f = fixture(); assert.equal(await f.store.provision({ ...identity, subject: "" }), null); assert.equal(f.calls.length, 0);
});
await check("P14 subject control characters rejected", async () => {
  const f = fixture(); assert.equal(await f.store.provision({ ...identity, subject: "x\ny" }), null); assert.equal(f.calls.length, 0);
});
await check("P15 oversized subject rejected", async () => {
  const f = fixture(); assert.equal(await f.store.provision({ ...identity, subject: "a".repeat(256) }), null); assert.equal(f.calls.length, 0);
});
await check("P16 oversized email rejected", async () => {
  const f = fixture(); assert.equal(await f.store.provision({ ...identity, email: "a".repeat(321) }), null); assert.equal(f.calls.length, 0);
});
await check("P17 oversized display name rejected", async () => {
  const f = fixture(); assert.equal(await f.store.provision({ ...identity, displayName: "a".repeat(201) }), null); assert.equal(f.calls.length, 0);
});
await check("P18 malformed runtime identity rejected", async () => {
  const f = fixture(); assert.equal(await f.store.provision(null as never), null); assert.equal(f.calls.length, 0);
});
await check("P19 driver errors sanitized", async () => {
  const query: CommittedIdentityQuery = { query: async () => { throw new Error("password=secret"); } };
  await assert.rejects(createPostgresIdentityProvisioner(query).provision(identity),
    (error: unknown) => error instanceof Error && error.message === "Azure identity provisioning unavailable");
});
await check("P20 invalid executor rejected", () => {
  assert.throws(() => createPostgresIdentityProvisioner(null as never), /identity provisioning unavailable/);
});
await check("P21 malformed result envelope fails closed", async () => {
  const query: CommittedIdentityQuery = { query: async () => ({ rows: null as never }) };
  await assert.rejects(createPostgresIdentityProvisioner(query).provision(identity), /identity provisioning unavailable/);
});
console.log("\n=== Azure identity provisioning: " + passed + " passed, " + failed + " failed ===");
process.exitCode = failed ? 1 : 0;
