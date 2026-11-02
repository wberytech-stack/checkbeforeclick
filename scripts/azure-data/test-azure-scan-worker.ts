// Offline worker adapter regressions: no Azure, database, providers or paid calls.
import assert from "node:assert/strict";
import { runAzureScanWorkerBatch, WorkerStorageError, type ScanCompletion, type WorkerQuery } from "../../src/server/workers/azureScanWorker.ts";
const SCAN = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const UNTIL = new Date(Date.now() + 120000);
const job = (overrides: Record<string, unknown> = {}) => ({
  o_scan_id: SCAN, o_lease_token: TOKEN, o_input_type: "url", o_raw_input: "https://private.example/a?token=secret",
  o_attempt_count: 1, o_leased_until: UNTIL, ...overrides,
});
const result: ScanCompletion = {
  status: "complete", verdict: "suspicious", riskScore: 50, confidenceScore: 70,
  explanation: null, recommendedAction: null, durationMs: 12,
  vendorResults: [{ vendor_name: "test", verdict: "suspicious" }], evidenceItems: [],
};
function harness(claims: Record<string, unknown>[] = [job()], ok: unknown = true) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db: WorkerQuery = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: sql.includes("app_claim_scan_jobs") ? claims : [{ ok }] };
  } };
  const events: string[] = [];
  return { db, calls, events, options: { onEvent: (event: string) => { events.push(event); } } };
}
let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (e) { console.error("FAIL " + name, e); process.exitCode = 1; }
}
await check("W01 claim and completion are parameterized, lease token never reaches provider", async () => {
  const h = harness(); let received: unknown;
  const s = await runAzureScanWorkerBatch(h.db, async j => { received = j; return result; }, h.options);
  assert.deepEqual(s, { claimed: 1, completed: 1, leaseLost: 0, failed: 0 });
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0].params, [1, 120]);
  assert.match(h.calls[1].sql, /app_complete_scan_job\(\$1,\$2/);
  assert.deepEqual(h.calls[1].params.slice(0, 4), [SCAN, TOKEN, "complete", "suspicious"]);
  assert.equal((received as Record<string, unknown>).rawInput, job().o_raw_input);
  assert.equal("leaseToken" in (received as Record<string, unknown>), false);
  assert.deepEqual(h.events, ["completed"]);
});
await check("W02 replayed completion false is never counted successful", async () => {
  const h = harness([job()], false);
  const s = await runAzureScanWorkerBatch(h.db, async () => result, h.options);
  assert.deepEqual(s, { claimed: 1, completed: 0, leaseLost: 1, failed: 0 });
  assert.deepEqual(h.events, ["lease_lost"]);
});
await check("W03 malformed completion result fails closed", async () => {
  for (const value of ["false", null, 1]) {
    const h = harness([job()], value);
    const s = await runAzureScanWorkerBatch(h.db, async () => result, h.options);
    assert.equal(s.failed, 1); assert.deepEqual(h.events, ["storage_error"]);
  }
});
await check("W04 claim failure sanitized; no provider call", async () => {
  let called = false; const h = harness();
  h.db.query = async () => { throw new Error("secret-password=123 raw scan payload"); };
  await assert.rejects(() => runAzureScanWorkerBatch(h.db, async () => { called = true; return result; }, h.options),
    e => e instanceof WorkerStorageError && !e.message.includes("secret"));
  assert.equal(called, false); assert.deepEqual(h.events, ["storage_error"]);
});
await check("W05 malformed lease, input or count rejected before provider", async () => {
  for (const change of [
    { o_scan_id: "x' OR true--" }, { o_lease_token: "invalid" }, { o_input_type: "sql" },
    { o_raw_input: null }, { o_attempt_count: 9 }, { o_leased_until: "not-a-date" },
  ]) {
    const h = harness([job(change)]); let called = false;
    await assert.rejects(() => runAzureScanWorkerBatch(h.db, async () => { called = true; return result; }, h.options), WorkerStorageError);
    assert.equal(called, false); assert.equal(h.calls.length, 1);
  }
});
await check("W06 no work returns no processing", async () => {
  const h = harness([]);
  assert.deepEqual(await runAzureScanWorkerBatch(h.db, async () => { throw Error("unexpected"); }, h.options),
    { claimed: 0, completed: 0, leaseLost: 0, failed: 0 });
});
await check("W07 expired lease skips provider and completion", async () => {
  const h = harness([job({ o_leased_until: new Date(Date.now() + 1000) })]);
  const s = await runAzureScanWorkerBatch(h.db, async () => { throw Error("must not run"); }, h.options);
  assert.equal(s.failed, 1); assert.equal(h.calls.length, 1); assert.deepEqual(h.events, ["lease_lost"]);
});
await check("W08 provider exception never logged or acknowledged", async () => {
  const h = harness(); const secret = "credential-DO-NOT-LOG";
  const s = await runAzureScanWorkerBatch(h.db, async () => { throw Error(secret); }, h.options);
  assert.equal(s.failed, 1); assert.equal(h.calls.length, 1);
  assert.equal(JSON.stringify(h.events).includes(secret), false); assert.deepEqual(h.events, ["provider_error"]);
});
await check("W09 provider timeout aborts and leaves lease for retry", async () => {
  const h = harness(); let aborted = false;
  const s = await runAzureScanWorkerBatch(h.db, async ({ signal }) => new Promise<ScanCompletion>(resolve => {
    signal.addEventListener("abort", () => { aborted = true; resolve(result); });
  }), { ...h.options, maxWorkMs: 1000 });
  assert.equal(s.failed, 1); assert.equal(aborted, true); assert.equal(h.calls.length, 1);
  assert.deepEqual(h.events, ["timeout"]);
});
await check("W10 invalid processor result does not write", async () => {
  for (const bad of [{ ...result, vendorResults: [], evidenceItems: [] },
    { ...result, riskScore: 101 }, { ...result, vendorResults: Array(101).fill({}) },
    { ...result, vendorResults: [{ blob: "x".repeat(262145) }] }]) {
    const h = harness(); const s = await runAzureScanWorkerBatch(h.db, async () => bad, h.options);
    assert.equal(s.failed, 1); assert.equal(h.calls.length, 1);
  }
});
await check("W11 completion SQL error sanitized and lease left open", async () => {
  const h = harness(); const q = h.db.query;
  h.db.query = async (sql, params) => {
    if (sql.includes("app_complete_scan_job")) throw Error("secret lease token " + TOKEN);
    return q(sql, params);
  };
  const s = await runAzureScanWorkerBatch(h.db, async () => result, h.options);
  assert.equal(s.failed, 1); assert.deepEqual(h.events, ["storage_error"]);
});
await check("W12 invalid batch limits fail before claim", async () => {
  for (const options of [{ batchSize: 11 }, { batchSize: 0 }, { leaseSeconds: 20 },
    { leaseSeconds: 601 }, { maxWorkMs: 200000 }, { maxWorkMs: 999 }]) {
    const h = harness();
    await assert.rejects(() => runAzureScanWorkerBatch(h.db, async () => result, options));
    assert.equal(h.calls.length, 0);
  }
});
await check("W13 callback logging errors do not prevent completion", async () => {
  const h = harness();
  const s = await runAzureScanWorkerBatch(h.db, async () => result,
    { onEvent: () => { throw Error("telemetry offline"); } });
  assert.equal(s.completed, 1);
});
await check("W14 duplicate claimed lease cannot cause duplicate provider work in one batch", async () => {
  const h = harness([job(), job()]);
  let calls = 0;
  await assert.rejects(() => runAzureScanWorkerBatch(h.db, async () => { calls++; return result; }, { ...h.options, batchSize: 2 }), WorkerStorageError);
  assert.equal(calls, 0); assert.equal(h.calls.length, 1);
});
console.log(`\n=== Azure scan worker offline: ${passed} passed ===`);
if (passed !== 14) process.exitCode = 1;
