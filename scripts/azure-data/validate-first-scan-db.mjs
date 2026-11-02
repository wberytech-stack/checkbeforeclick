// Real Azure HTTP handler -> tenant session -> disposable PostgreSQL outbox ->
// provider-neutral worker -> persisted evidence -> HTTP result -> UI contract.
// NO Azure, Google, or external network calls. Only the loopback cluster created
// by run-disposable-db.sh may be used. Fake threat intelligence is deterministic.
import assert from "node:assert/strict";
import pg from "pg";
import { createUnpersistedAzureSessionToken, AZURE_SESSION_COOKIE_NAME } from "../../src/security/azureSession.ts";
import { runAzureScanCreateRoute } from "../../src/server/data/azureScanCreateRoute.ts";
import { runAzureScanReadRoute } from "../../src/server/data/azureScanReadRoute.ts";
import { runAzureScanWorkerBatch } from "../../src/server/workers/azureScanWorker.ts";
import { createUrlReputationProcessor } from "../../src/server/workers/azureUrlProcessor.ts";
import { parseScanCreated, parseScanRead, scanPresentation } from "../../src/client/azureScanUi.ts";

for (const key of ["CBC_DATABASE_URL", "CBC_TEST_OWNER_URL", "CBC_TEST_WORKER_URL"]) {
  const value = process.env[key];
  if (!value || new URL(value).hostname !== "127.0.0.1") {
    throw new Error("First-scan test requires disposable loopback PostgreSQL: " + key);
  }
}
if (!process.env.CBC_TEST_ISSUER) throw new Error("Missing disposable test issuer");
const ORIGIN = "https://cbc.example";
const env = {
  CBC_AZURE_PUBLIC_ORIGIN: ORIGIN,
  CBC_AZURE_OIDC_ISSUER: process.env.CBC_TEST_ISSUER,
  CBC_AZURE_OIDC_CLIENT_ID: "cbc-test-client",
  CBC_AZURE_OIDC_STATE_ACTIVE_KID: "test",
  CBC_AZURE_OIDC_STATE_KEYS: "test:" + Buffer.alloc(32, 7).toString("base64url"),
};
const app = new pg.Pool({ connectionString: process.env.CBC_DATABASE_URL, max: 2 });
const worker = new pg.Pool({ connectionString: process.env.CBC_TEST_WORKER_URL, max: 2 });
const owner = new pg.Client({ connectionString: process.env.CBC_TEST_OWNER_URL });
const url = "https://example.org/first-scan";
let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log("PASS " + label); };

// The same committed-transaction contract used by the production route wiring.
// All session resolution, RLS context, and protected SQL use ONE pg client.
async function transaction(fn) {
  const c = await app.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
async function signIn(subject) {
  const result = await app.query("SELECT * FROM public.app_sign_in($1,$2,$3,$4)",
    [process.env.CBC_TEST_ISSUER, subject, null, "First scan test"]);
  assert.equal(result.rows.length, 1);
  return { user: result.rows[0].o_user_id, org: result.rows[0].o_organization_id };
}
async function sessionCookie(subject) {
  const { token, digest } = createUnpersistedAzureSessionToken();
  const result = await app.query(
    "SELECT public.app_create_auth_session($1,$2,$3,$4::bigint) AS ok",
    [process.env.CBC_TEST_ISSUER, subject, digest, Math.floor(Date.now() / 1000) + 3600]);
  assert.equal(result.rows[0]?.ok, true);
  return { cookie: AZURE_SESSION_COOKIE_NAME + "=" + token, digest };
}
async function submit(cookie, target) {
  return runAzureScanCreateRoute(new Request(ORIGIN + "/api/azure/scans", {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ input_type: "url", raw_input: target }),
  }), { env, transaction });
}
async function read(cookie, id) {
  return runAzureScanReadRoute(new Request(ORIGIN + "/api/azure/scans/" + id, {
    headers: cookie ? { cookie } : {},
  }), id, { transaction });
}
async function oneWorker(processor) {
  return runAzureScanWorkerBatch(worker, processor, {
    batchSize: 1, leaseSeconds: 120, maxWorkMs: 30000,
  });
}

try {
  await owner.connect();
  // Only this fresh, disposable cluster. Earlier suites leave pending jobs.
  await owner.query("DELETE FROM public.scan_job_outbox");
  const a = await signIn("first-scan-integration-a");
  const b = await signIn("first-scan-integration-b");
  assert.notEqual(a.org, b.org);
  const aSession = await sessionCookie("first-scan-integration-a");
  const bSession = await sessionCookie("first-scan-integration-b");

  const createdResponse = await submit(aSession.cookie, url);
  check("I01 authenticated HTTP POST commits a pending scan", () => {
    assert.equal(createdResponse.status, 201);
    assert.match(createdResponse.headers.get("cache-control") ?? "", /no-store/);
  });
  const id = parseScanCreated(await createdResponse.json());
  const queued = await owner.query(
    "SELECT organization_id,state,attempt_count FROM public.scan_job_outbox WHERE scan_id=$1", [id]);
  check("I02 HTTP submission atomically enqueues one tenant-bound job", () => {
    assert.equal(queued.rows.length, 1);
    assert.equal(queued.rows[0].organization_id, a.org);
    assert.equal(queued.rows[0].state, "ready");
    assert.equal(queued.rows[0].attempt_count, 0);
  });
  const pendingResponse = await read(aSession.cookie, id);
  check("I03 authenticated HTTP GET returns pending state", () => {
    assert.equal(pendingResponse.status, 200);
    assert.match(pendingResponse.headers.get("cache-control") ?? "", /no-store/);
  });
  const pendingView = parseScanRead(await pendingResponse.json(), id);
  check("I04 pending state renders as checking, never safe", () => {
    assert.equal(pendingView.scan.status, "pending");
    assert.match(scanPresentation(pendingView.scan).label, /Checking/);
  });

  let lookups = 0;
  const unknownProcessor = createUrlReputationProcessor(async (candidate, signal) => {
    assert.equal(candidate, url);
    assert.equal(signal.aborted, false);
    lookups++;
    return { threatTypes: [] };
  });
  const summary = await oneWorker(unknownProcessor);
  check("I05 real worker claims and completes one job with fake provider", () => {
    assert.deepEqual(summary, { claimed: 1, completed: 1, leaseLost: 0, failed: 0 });
    assert.equal(lookups, 1);
  });
  const completedResponse = await read(aSession.cookie, id);
  check("I06 HTTP result returns persisted verdict and evidence", () => {
    assert.equal(completedResponse.status, 200);
  });
  const completedView = parseScanRead(await completedResponse.json(), id);
  check("I07 UI does not interpret a threat-list miss as safe", () => {
    assert.equal(completedView.scan.status, "complete");
    assert.equal(completedView.scan.verdict, "unknown");
    assert.equal(completedView.evidence.length, 1);
    assert.equal(completedView.evidence[0].title, "No known threat-list match");
    assert.match(scanPresentation(completedView.scan).label, /not confirmed/i);
  });

  const foreignResponse = await read(bSession.cookie, id);
  check("I08 tenant B receives 404 for tenant A scan and evidence", () => {
    assert.equal(foreignResponse.status, 404);
  });
  const completedJob = await owner.query(
    "SELECT state,lease_token FROM public.scan_job_outbox WHERE scan_id=$1", [id]);
  check("I09 completion atomically closes the outbox lease", () => {
    assert.equal(completedJob.rows[0].state, "done");
    assert.equal(completedJob.rows[0].lease_token, null);
  });
  const replay = await oneWorker(unknownProcessor);
  check("I10 terminal scan cannot be claimed or billed twice", () => {
    assert.equal(replay.claimed, 0);
    assert.equal(lookups, 1);
  });

  const dangerousUrl = "https://example.net/malicious";
  const createdB = await submit(bSession.cookie, dangerousUrl);
  assert.equal(createdB.status, 201);
  const dangerousId = parseScanCreated(await createdB.json());
  let dangerCalls = 0;
  const dangerousSummary = await oneWorker(createUrlReputationProcessor(async (candidate) => {
    assert.equal(candidate, dangerousUrl);
    dangerCalls++;
    return { threatTypes: ["MALWARE"] };
  }));
  check("I11 tenant B malicious URL completes through real worker", () => {
    assert.equal(dangerousSummary.completed, 1);
    assert.equal(dangerCalls, 1);
  });
  const dangerousResponse = await read(bSession.cookie, dangerousId);
  assert.equal(dangerousResponse.status, 200);
  const dangerousView = parseScanRead(await dangerousResponse.json(), dangerousId);
  check("I12 dangerous finding survives database and HTTP serialization", () => {
    assert.equal(dangerousView.scan.verdict, "dangerous");
    assert.equal(dangerousView.evidence.length, 1);
    assert.match(dangerousView.evidence[0].title, /Known threat-list match/);
    assert.match(scanPresentation(dangerousView.scan).label, /Dangerous/);
  });
  const reverseForeign = await read(aSession.cookie, dangerousId);
  check("I13 reverse cross-tenant scan read is indistinguishable from missing", () => {
    assert.equal(reverseForeign.status, 404);
  });

  const failedResponse = await submit(aSession.cookie, "https://example.org/provider-outage");
  assert.equal(failedResponse.status, 201);
  const failedId = parseScanCreated(await failedResponse.json());
  const failedSummary = await oneWorker(createUrlReputationProcessor(async () => {
    throw new Error("SECRET fake provider outage");
  }));
  check("I14 provider outage leaves scan pending and retriable", () => {
    assert.deepEqual(failedSummary, { claimed: 1, completed: 0, leaseLost: 0, failed: 1 });
  });
  const failedScanResponse = await read(aSession.cookie, failedId);
  assert.equal(failedScanResponse.status, 200);
  const failedView = parseScanRead(await failedScanResponse.json(), failedId);
  check("I15 provider exception never creates a false safe result or evidence", () => {
    assert.equal(failedView.scan.status, "pending");
    assert.equal(failedView.scan.verdict, null);
    assert.equal(failedView.evidence.length, 0);
    assert.ok(!JSON.stringify(failedView).includes("SECRET"));
  });
  const noImmediateRetry = await oneWorker(createUrlReputationProcessor(async () => {
    throw new Error("Should not be called before lease expires");
  }));
  check("I16 unexpired failed lease prevents duplicate provider calls", () => {
    assert.equal(noImmediateRetry.claimed, 0);
  });

  const missingSession = await read("", id);
  check("I17 missing browser session is rejected", () => {
    assert.equal(missingSession.status, 401);
  });
  const revoke = await app.query("SELECT public.app_revoke_auth_session($1) AS ok", [aSession.digest]);
  assert.equal(revoke.rows[0]?.ok, true);
  const revokedResponse = await read(aSession.cookie, id);
  check("I18 revoked session cannot retrieve its former scan", () => {
    assert.equal(revokedResponse.status, 401);
  });
  console.log("\n=== Azure authenticated HTTP-to-worker-to-UI integration: " + passed + " passed ===");
} finally {
  await Promise.all([app.end(), worker.end(), owner.end().catch(() => {})]);
}
