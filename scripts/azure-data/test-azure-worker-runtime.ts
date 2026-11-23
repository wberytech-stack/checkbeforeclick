// Offline security tests: fake pool, fake identity, fake provider. No Azure/DB/API calls.
import assert from "node:assert/strict";
import { ATTEST_WORKER_ROLE, WorkerRuntimeError, runAzureWorkerRuntime, type WorkerRuntimeDeps, type WorkerPoolSettings } from "../../src/server/workers/azureWorkerRuntime.ts";
import type { DatabaseConfig } from "../../src/server/db/config";
const config: DatabaseConfig = {
  host: "cbc.postgres.database.azure.com", port: 5432, database: "cbc", user: "cbc_worker",
  auth: "entra", password: undefined,
  ssl: { rejectUnauthorized: true, servername: "cbc.postgres.database.azure.com" },
};
const role = { role: "cbc_worker", rolsuper: false, rolcreatedb: false, rolcreaterole: false,
  rolbypassrls: false, rolinherit: false, web_member: false, scan_write: false,
  evidence_write: false, vendor_write: false, outbox_access: false };
const ID = "11111111-1111-4111-8111-111111111111";
function harness(overrides: Partial<WorkerRuntimeDeps> = {}, row: Record<string, unknown> = role) {
  let created = 0, closed = 0, ran = 0, queries = 0;
  let settings: WorkerPoolSettings | undefined;
  const deps: WorkerRuntimeDeps = {
    config, identityClientId: ID, tokenProvider: async () => "private-identity-token",
    createPool: s => { created++; settings = s; return {
      query: async (sql, args) => { queries++; assert.equal(sql, ATTEST_WORKER_ROLE); assert.deepEqual(args, []); return { rows: [row] }; },
      end: async () => { closed++; },
    }; },
    process: async () => { throw Error("provider should be injected"); },
    runBatch: async (_db, _processor, opts) => { ran++; assert.deepEqual([opts.batchSize, opts.leaseSeconds, opts.maxWorkMs], [1, 120, 60000]); return { claimed: 0, completed: 0, leaseLost: 0, failed: 0 }; },
    ...overrides,
  };
  return { deps, get: () => ({ created, closed, ran, queries, settings }) };
}
let passed = 0;
async function check(label: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log("PASS " + label); }
  catch (e) { console.error("FAIL " + label, e); process.exitCode = 1; }
}
await check("R01 attested worker runs one bounded batch and closes pool", async () => {
  const h = harness();
  assert.equal((await runAzureWorkerRuntime(h.deps)).claimed, 0);
  assert.deepEqual([h.get().created, h.get().queries, h.get().ran, h.get().closed], [1, 1, 1, 1]);
  assert.equal(h.get().settings?.user, "cbc_worker");
  assert.equal(h.get().settings?.max, 1);
  assert.equal(h.get().settings?.ssl.rejectUnauthorized, true);
  assert.equal(await h.get().settings?.password(), "private-identity-token");
});
await check("R02 rejects web role, password, loopback, unverified TLS, identity reuse before pool", async () => {
  const bad: Partial<WorkerRuntimeDeps>[] = [
    { config: { ...config, user: "cbc_app" } },
    { config: { ...config, auth: "password", password: "secret" } },
    { config: { ...config, host: "localhost", ssl: false } },
    { config: { ...config, ssl: { rejectUnauthorized: true, servername: "evil.example" } } },
    { identityClientId: undefined },
    { identityClientId: "invalid" },
    { webIdentityClientId: ID.toUpperCase() },
  ];
  for (const item of bad) {
    const h = harness(item);
    await assert.rejects(() => runAzureWorkerRuntime(h.deps), WorkerRuntimeError);
    assert.equal(h.get().created, 0);
  }
});
await check("R03 role privilege drift blocks all work", async () => {
  for (const field of ["rolsuper", "rolcreatedb", "rolcreaterole", "rolbypassrls", "rolinherit",
    "web_member", "scan_write", "evidence_write", "vendor_write", "outbox_access"]) {
    const h = harness({}, { ...role, [field]: true });
    await assert.rejects(() => runAzureWorkerRuntime(h.deps), WorkerRuntimeError);
    assert.deepEqual([h.get().ran, h.get().closed], [0, 1]);
  }
});
await check("R04 malformed attestation and unexpected role fail closed", async () => {
  for (const row of [{ ...role, role: "postgres" }, { ...role, rolsuper: "false" }, {}]) {
    const h = harness({}, row);
    await assert.rejects(() => runAzureWorkerRuntime(h.deps), WorkerRuntimeError);
    assert.equal(h.get().ran, 0); assert.equal(h.get().closed, 1);
  }
});
await check("R05 SQL failure sanitized, pool closed", async () => {
  const h = harness({ createPool: () => ({ query: async () => { throw Error("password=secret rawInput=private"); }, end: async () => {} }) });
  await assert.rejects(() => runAzureWorkerRuntime(h.deps), e => e instanceof WorkerRuntimeError && !e.message.includes("secret"));
});
await check("R06 batch failure sanitized, pool closed", async () => {
  const h = harness({ runBatch: async () => { throw Error("lease token=private"); } });
  await assert.rejects(() => runAzureWorkerRuntime(h.deps), e => e instanceof WorkerRuntimeError && !e.message.includes("private"));
  assert.equal(h.get().closed, 1);
});
await check("R07 pool factory error sanitized", async () => {
  const h = harness({ createPool: () => { throw Error("db password=private"); } });
  await assert.rejects(() => runAzureWorkerRuntime(h.deps), e => e instanceof WorkerRuntimeError && !e.message.includes("private"));
});
await check("R08 close failure does not leak credentials or falsely fail completed batch", async () => {
  const h = harness({ createPool: () => ({ query: async () => ({ rows: [role] }), end: async () => { throw Error("secret"); } }) });
  assert.equal((await runAzureWorkerRuntime(h.deps)).completed, 0);
});
console.log(`\n=== Azure worker runtime offline: ${passed} passed ===`);
if (passed !== 8) process.exitCode = 1;
