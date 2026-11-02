// First complete Azure scan data-flow contract, using ONLY the disposable
// PostgreSQL cluster created by run-disposable-db.sh. No Azure/provider calls.
import assert from "node:assert/strict";
import pg from "pg";
import { parseScanCreated, parseScanRead, scanPresentation } from "../../src/client/azureScanUi.ts";

for (const key of ["CBC_DATABASE_URL", "CBC_TEST_OWNER_URL", "CBC_TEST_WORKER_URL"]) {
  const value = process.env[key];
  if (!value || new URL(value).hostname !== "127.0.0.1") {
    throw new Error("First-scan test requires disposable loopback PostgreSQL: " + key);
  }
}
if (!process.env.CBC_TEST_ISSUER) throw new Error("Missing disposable test issuer");
const app = new pg.Pool({ connectionString: process.env.CBC_DATABASE_URL, max: 2 });
const worker = new pg.Pool({ connectionString: process.env.CBC_TEST_WORKER_URL, max: 2 });
const owner = new pg.Client({ connectionString: process.env.CBC_TEST_OWNER_URL });
const url = "https://example.org/first-scan";
let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log("PASS " + label); };
async function tenantQuery(who, sql, args) {
  const c = await app.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_user_id',$1,true), set_config('app.current_organization_id',$2,true)", [who.user, who.org]);
    const result = await c.query(sql, args);
    await c.query("COMMIT");
    return result.rows;
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
const scanSql = `SELECT id,input_type,raw_input,status,verdict,risk_score,confidence_score,created_at,completed_at
  FROM public.scans WHERE id=$1::uuid AND organization_id=$2::uuid`;
const evidenceSql = `SELECT e.signal_type,e.severity,e.title,e.detail,e.score_impact
  FROM public.evidence_items e JOIN public.scans s ON s.id=e.scan_id
  WHERE e.scan_id=$1::uuid AND e.organization_id=$2::uuid AND s.organization_id=$2::uuid
  ORDER BY e.created_at,e.id LIMIT 501`;
try {
  await owner.connect();
  // This affects only the fresh, loopback test cluster; other suites are done.
  await owner.query("DELETE FROM public.scan_job_outbox");
  const a = await signIn("first-scan-integration-a");
  const b = await signIn("first-scan-integration-b");
  assert.notEqual(a.org, b.org);
  const created = await tenantQuery(a,
    "SELECT public.app_create_scan($1::text,$2::text) AS id", ["url", url]);
  const id = parseScanCreated({ id: created[0].id, status: "pending" });
  check("I01 authenticated create returns UI-compatible pending scan", () => {
    assert.match(id, /^[0-9a-f-]{36}$/);
  });
  const queued = await owner.query(
    "SELECT organization_id,state,attempt_count FROM public.scan_job_outbox WHERE scan_id=$1", [id]);
  check("I02 create atomically enqueues exactly one tenant-bound job", () => {
    assert.equal(queued.rows.length, 1);
    assert.equal(queued.rows[0].organization_id, a.org);
    assert.equal(queued.rows[0].state, "ready");
    assert.equal(queued.rows[0].attempt_count, 0);
  });
  const before = await tenantQuery(a, scanSql, [id, a.org]);
  check("I03 UI can read pending scan under tenant RLS", () => {
    const view = parseScanRead({ scan: before[0], evidence: [] }, id);
    assert.equal(view.scan.status, "pending");
    assert.match(scanPresentation(view.scan).label, /Checking/);
  });
  const claimed = await worker.query("SELECT * FROM public.app_claim_scan_jobs(1,120)");
  const lease = claimed.rows[0];
  check("I04 isolated worker claims only its leased scan", () => {
    assert.equal(claimed.rows.length, 1);
    assert.equal(lease.o_scan_id, id);
    assert.equal(lease.o_organization_id, a.org);
    assert.equal(lease.o_raw_input, url);
  });
  const vendor = [{ vendor_name: "web_risk", verdict: "unknown",
    raw_response: { threat_types: [] }, response_time_ms: 5 }];
  const evidence = [{ signal_type: "reputation", severity: "info",
    title: "No known threat match", detail: "Safety not confirmed", score_impact: 0 }];
  const completed = await worker.query(
    "SELECT public.app_complete_scan_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) AS ok",
    [id, lease.o_lease_token, "complete", "unknown", null, null,
      "No known threat match does not prove safety", "Use caution", 12,
      JSON.stringify(vendor), JSON.stringify(evidence)]);
  check("I05 lease-bound completion commits terminal result and evidence", () => {
    assert.equal(completed.rows[0].ok, true);
  });
  const rows = await tenantQuery(a, scanSql, [id, a.org]);
  const findings = await tenantQuery(a, evidenceSql, [id, a.org]);
  check("I06 actual PostgreSQL result/evidence parses into safe UI verdict", () => {
    const view = parseScanRead({ scan: rows[0], evidence: findings }, id);
    assert.equal(view.scan.status, "complete");
    assert.equal(view.scan.verdict, "unknown");
    assert.equal(view.evidence.length, 1);
    assert.equal(view.evidence[0].title, "No known threat match");
    assert.match(scanPresentation(view.scan).label, /not confirmed/i);
  });
  const foreign = await tenantQuery(b, "SELECT id FROM public.scans WHERE id=$1::uuid", [id]);
  const foreignEvidence = await tenantQuery(b, evidenceSql, [id, b.org]);
  check("I07 different tenant cannot read scan or evidence even by known ID", () => {
    assert.equal(foreign.length, 0);
    assert.equal(foreignEvidence.length, 0);
  });
  const job = await owner.query("SELECT state,lease_token FROM public.scan_job_outbox WHERE scan_id=$1", [id]);
  check("I08 outbox is terminal and lease is invalidated", () => {
    assert.equal(job.rows[0].state, "done");
    assert.equal(job.rows[0].lease_token, null);
  });
  console.log("\n=== Azure first scan DB-to-UI integration: " + passed + " passed ===");
} finally {
  await Promise.all([app.end(), worker.end(), owner.end().catch(() => {})]);
}
