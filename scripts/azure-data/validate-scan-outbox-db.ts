// Disposable PostgreSQL 16 outbox security tests. No cloud/network calls.
// run-disposable-db.sh supplies fresh loopback databases and ephemeral credentials.
import { strict as assert } from "node:assert";
import pg from "pg";

for (const key of ["CBC_DATABASE_URL", "CBC_TEST_OWNER_URL", "CBC_TEST_WORKER_URL"]) {
  const value = process.env[key];
  if (!value || new URL(value).hostname !== "127.0.0.1") {
    throw new Error("Outbox tests require a disposable loopback PostgreSQL database");
  }
}
const issuer = process.env.CBC_TEST_ISSUER;
if (!issuer) throw new Error("Missing disposable issuer");
const app = new pg.Pool({ connectionString: process.env.CBC_DATABASE_URL, max: 6 });
const worker = new pg.Pool({ connectionString: process.env.CBC_TEST_WORKER_URL, max: 8 });
const owner = new pg.Client({ connectionString: process.env.CBC_TEST_OWNER_URL });
type Job = {
  o_scan_id: string; o_organization_id: string; o_input_type: string;
  o_raw_input: string; o_lease_token: string; o_attempt_count: number;
};
let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + ": " + String(error)); }
}
async function errorCode(fn: () => Promise<unknown>) {
  try { await fn(); return null; }
  catch (e) { return (e as { code?: string }).code ?? "unexpected"; }
}
async function signIn(subject: string) {
  const r = await app.query("SELECT * FROM public.app_sign_in($1,$2,$3,$4)",
    [issuer, subject, "worker@example.test", "Worker test"]);
  assert.equal(r.rows.length, 1);
  return { user: r.rows[0].o_user_id as string, org: r.rows[0].o_organization_id as string };
}
async function create(user: string, org: string, raw: string, rollback = false) {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id',$1,true), set_config('app.current_organization_id',$2,true)", [user, org]);
    const r = await client.query("SELECT public.app_create_scan($1,$2) AS id", ["url", raw]);
    if (rollback) await client.query("ROLLBACK");
    else await client.query("COMMIT");
    return r.rows[0].id as string;
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}
async function claim(limit = 1, seconds = 120): Promise<Job[]> {
  return (await worker.query("SELECT * FROM public.app_claim_scan_jobs($1,$2)", [limit, seconds])).rows;
}
async function ack(id: string, token: string): Promise<boolean> {
  const r = await worker.query("SELECT public.app_ack_scan_job($1,$2) AS ok", [id, token]);
  return r.rows[0]?.ok === true;
}
async function expire(id: string) {
  await owner.query("UPDATE public.scan_job_outbox SET leased_until=clock_timestamp()-interval '1 second' WHERE scan_id=$1", [id]);
}
try {
  await owner.connect();
  // Earlier disposable data-plane suites intentionally leave pending scans.
  // Isolate this suite's claim ordering; this owner-only cleanup affects ONLY
  // the ephemeral 127.0.0.1 cluster created by run-disposable-db.sh.
  await owner.query("DELETE FROM public.scan_job_outbox");
  const a = await signIn("outbox-tenant-a");
  const b = await signIn("outbox-tenant-b");
  await check("W01 worker is separate, non-inheriting and NOBYPASSRLS", async () => {
    const r = await owner.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls FROM pg_roles WHERE rolname='cbc_worker'");
    assert.deepEqual(Object.values(r.rows[0]), [false, false, false, false, false]);
    const inherited = await owner.query("SELECT pg_has_role('cbc_app','cbc_worker','MEMBER') AS member");
    assert.equal(inherited.rows[0].member, false);
  });
  await check("W02 outbox has RLS and no policies", async () => {
    const r = await owner.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.scan_job_outbox'::regclass");
    const p = await owner.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename='scan_job_outbox'");
    assert.equal(r.rows[0].relrowsecurity, true); assert.equal(p.rows[0].n, 0);
  });
  await check("W03 neither app nor worker has table DML grants", async () => {
    const r = await owner.query("SELECT role_name, has_table_privilege(role_name,'public.scan_job_outbox','SELECT') AS s, has_table_privilege(role_name,'public.scan_job_outbox','INSERT') AS i, has_table_privilege(role_name,'public.scan_job_outbox','UPDATE') AS u, has_table_privilege(role_name,'public.scan_job_outbox','DELETE') AS d FROM (VALUES ('cbc_app'),('cbc_worker')) v(role_name)");
    assert.equal(r.rows.length, 2);
    for (const row of r.rows) assert.deepEqual([row.s,row.i,row.u,row.d],[false,false,false,false]);
  });
  await check("W04 web role cannot claim or acknowledge jobs", async () => {
    assert.equal(await errorCode(() => app.query("SELECT * FROM public.app_claim_scan_jobs(1,120)")), "42501");
    assert.equal(await errorCode(() => app.query("SELECT public.app_ack_scan_job(gen_random_uuid(),gen_random_uuid())")), "42501");
  });
  await check("W05 worker cannot read outbox directly", async () => {
    assert.equal(await errorCode(() => worker.query("SELECT * FROM public.scan_job_outbox")), "42501");
  });
  await check("W06 worker cannot create scans or forge tenant context into creation", async () => {
    assert.equal(await errorCode(() => worker.query("SELECT public.app_create_scan('url','x')")), "42501");
  });
  const rolled = await create(a.user, a.org, "https://rollback.example", true);
  await check("W07 rolled-back scan never enqueues", async () => {
    const r = await owner.query("SELECT count(*)::int AS n FROM public.scan_job_outbox WHERE scan_id=$1", [rolled]);
    assert.equal(r.rows[0].n, 0);
  });
  const raw = "https://example.test/a?q='; DROP TABLE scans;--";
  const first = await create(a.user, a.org, raw);
  await check("W08 committed scan enqueues exactly one tenant-bound job", async () => {
    const r = await owner.query("SELECT organization_id,state,attempt_count FROM public.scan_job_outbox WHERE scan_id=$1", [first]);
    assert.equal(r.rows.length, 1); assert.equal(r.rows[0].organization_id, a.org);
    assert.equal(r.rows[0].state, "ready"); assert.equal(r.rows[0].attempt_count, 0);
  });
  let lease: Job | undefined;
  await check("W09 worker receives exact input and server-stamped tenant", async () => {
    const jobs = await claim(); assert.equal(jobs.length, 1);
    lease = jobs[0]; assert.equal(lease.o_scan_id, first);
    assert.equal(lease.o_organization_id, a.org); assert.equal(lease.o_raw_input, raw);
    assert.equal(lease.o_input_type, "url"); assert.equal(lease.o_attempt_count, 1);
    assert.match(lease.o_lease_token, /^[0-9a-f-]{36}$/);
  });
  await check("W10 concurrent claims cannot duplicate an active lease", async () => {
    const all = await Promise.all(Array.from({ length: 8 }, () => claim()));
    assert.equal(all.flat().length, 0);
  });
  await check("W11 nonterminal scan cannot be acknowledged", async () => {
    assert.equal(await ack(first, lease!.o_lease_token), false);
  });
  await check("W12 wrong lease token cannot acknowledge", async () => {
    assert.equal(await ack(first, "11111111-1111-4111-8111-111111111111"), false);
  });
  await check("W13 invalid claim limits and lease durations are rejected", async () => {
    for (const [n, seconds] of [[0,120],[11,120],[1,29],[1,601]]) {
      assert.equal(await errorCode(() => claim(n,seconds)), "22023");
    }
  });
  await expire(first);
  let renewed: Job | undefined;
  await check("W14 expired lease reclaims with a rotated token", async () => {
    const jobs = await claim(); assert.equal(jobs.length, 1);
    renewed = jobs[0]; assert.equal(renewed.o_scan_id, first);
    assert.notEqual(renewed.o_lease_token, lease!.o_lease_token);
    assert.equal(renewed.o_attempt_count, 2);
  });
  await check("W15 stale lease cannot acknowledge after redelivery", async () => {
    assert.equal(await ack(first, lease!.o_lease_token), false);
  });
  await owner.query("UPDATE public.scans SET status='complete',completed_at=clock_timestamp() WHERE id=$1", [first]);
  await check("W16 current lease acknowledges terminal scan", async () => {
    assert.equal(await ack(first, renewed!.o_lease_token), true);
  });
  await check("W17 acknowledgment replay fails and leaves job done", async () => {
    assert.equal(await ack(first, renewed!.o_lease_token), false);
    const r = await owner.query("SELECT state,lease_token,completed_at FROM public.scan_job_outbox WHERE scan_id=$1", [first]);
    assert.equal(r.rows[0].state, "done"); assert.equal(r.rows[0].lease_token, null);
    assert.ok(r.rows[0].completed_at);
  });
  await check("W18 terminal job is never reclaimed", async () => {
    assert.equal((await claim()).length, 0);
  });
  const second = await create(b.user, b.org, "https://tenant-b.example");
  await check("W19 worker claims tenant B without tenant A data", async () => {
    const jobs = await claim(); assert.equal(jobs.length, 1);
    assert.equal(jobs[0].o_scan_id, second); assert.equal(jobs[0].o_organization_id, b.org);
    assert.equal(jobs[0].o_raw_input, "https://tenant-b.example");
  });
  const third = await create(a.user, a.org, "https://claim-rollback.example");
  await check("W20 rollback of claim leaves job available", async () => {
    const c = await worker.connect();
    try {
      await c.query("BEGIN");
      const jobs = await c.query("SELECT * FROM public.app_claim_scan_jobs(1,120)");
      assert.equal(jobs.rows[0]?.o_scan_id, third);
      await c.query("ROLLBACK");
    } finally { c.release(); }
    const jobs = await claim(); assert.equal(jobs[0]?.o_scan_id, third);
    assert.equal(jobs[0]?.o_attempt_count, 1);
  });
  await check("W21 cbc_app cannot read even its own outbox metadata", async () => {
    assert.equal(await errorCode(() => app.query("SELECT * FROM public.scan_job_outbox")), "42501");
  });
  await check("W22 worker cannot modify scan or evidence directly", async () => {
    assert.equal(await errorCode(() => worker.query("UPDATE public.scans SET status='complete' WHERE id=$1", [third])), "42501");
    assert.equal(await errorCode(() => worker.query("INSERT INTO public.evidence_items (scan_id,organization_id,signal_type,severity,title) VALUES ($1,$2,'x','good','forged')", [third,a.org])), "42501");
  });
  await check("W23 exhaustion stops redelivery after eight attempts", async () => {
    for (let i = 1; i < 8; i++) {
      await expire(third);
      const jobs = await claim(); assert.equal(jobs.length, 1);
      assert.equal(jobs[0].o_scan_id, third);
      assert.equal(jobs[0].o_attempt_count, i + 1);
    }
    await expire(third);
    assert.equal((await claim()).length, 0);
  });
} catch (e) {
  failed++; console.error("FAIL outbox setup: " + String(e));
} finally {
  await Promise.all([app.end(), worker.end(), owner.end().catch(() => {})]);
}
console.log("\n=== Azure scan outbox: " + passed + " passed, " + failed + " failed ===");
process.exitCode = failed ? 1 : 0;
