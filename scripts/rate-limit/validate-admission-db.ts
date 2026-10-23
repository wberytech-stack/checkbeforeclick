// Gate 007A - disposable-database validation of infra/supabase/migrations/001_scan_admission.sql.
// LOCAL DISPOSABLE POSTGRES ONLY (AGENTS.md section 15): a Supabase Postgres image bound to 127.0.0.1.
// The code under test runs as the least-privileged path Supabase itself uses: login role "authenticator",
// then SET LOCAL ROLE authenticated with request.jwt.claim.sub (as PostgREST does). Setup uses "postgres".
//
// Run (PowerShell), after starting the container and applying the migration as "postgres":
//   $env:CBC_007A_ADMIN_URL = "postgresql://postgres:<local-test-password>@127.0.0.1:55471/postgres"
//   $env:CBC_007A_APP_URL   = "postgresql://authenticator:<local-test-password>@127.0.0.1:55471/postgres"
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/rate-limit/validate-admission-db.ts
//   Remove-Item Env:CBC_007A_ADMIN_URL, Env:CBC_007A_APP_URL
import { randomUUID } from "node:crypto";
import pg from "pg";

const adminUrl = process.env.CBC_007A_ADMIN_URL ?? "";
const appUrl = process.env.CBC_007A_APP_URL ?? "";
for (const u of [adminUrl, appUrl]) {
  if (!/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\//.test(u)) {
    console.error("FAIL: both URLs must point at a disposable database on 127.0.0.1");
    process.exit(2);
  }
}

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, info = ""): void {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}${info ? `  [${info}]` : ""}`); }
}

const admin = new pg.Client({ connectionString: adminUrl, ssl: false });
type Row = { admitted: boolean; reason: string; retry_after_seconds: number; provider_calls_reserved: number; admission_id: string | null };

async function asUser(client: pg.Client, sub: string | null, sqlText: string, params: unknown[] = []) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE authenticated");
    if (sub) {
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [sub, JSON.stringify({ sub, role: "authenticated" })]);
    }
    const r = await client.query(sqlText, params);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}
async function admit(client: pg.Client, sub: string | null, inputType = "url"): Promise<Row> {
  const r = await asUser(client, sub, "SELECT * FROM public.cbc_admit_scan($1)", [inputType]);
  return r.rows[0] as Row;
}
async function newApp(): Promise<pg.Client> { const c = new pg.Client({ connectionString: appUrl, ssl: false }); await c.connect(); return c; }
async function reset() { await admin.query("TRUNCATE public.scan_admissions"); }
async function count(where = "true"): Promise<number> { return Number((await admin.query(`SELECT count(*)::int AS n FROM public.scan_admissions WHERE ${where}`)).rows[0].n); }
async function addUsers(org: string, n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, () => randomUUID());
  for (const id of ids) await admin.query("INSERT INTO public.users (id, organization_id) VALUES ($1, $2)", [id, org]);
  return ids;
}
async function preload(org: string, user: string, n: number, ageSql = "now()") {
  await admin.query(`INSERT INTO public.scan_admissions (user_id, organization_id, input_type, provider_calls_reserved, admitted_at)
    SELECT $1, $2, 'url', 1, ${ageSql} FROM generate_series(1, $3)`, [user, org, n]);
}

await admin.connect();
const app = await newApp();
try {
  // ---- function and table properties --------------------------------------------------------------
  const f = (await admin.query(`SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
      FROM pg_proc p WHERE p.oid = 'public.cbc_admit_scan(text)'::regprocedure`)).rows[0];
  check("P01 function is SECURITY DEFINER with search_path pinned", f.prosecdef === true && JSON.stringify(f.proconfig).includes("search_path=pg_catalog, public"), JSON.stringify(f.proconfig));
  check("P02 authenticated may execute; anon may not", f.auth_exec === true && f.anon_exec === false);
  const t = (await admin.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.scan_admissions'::regclass`)).rows[0];
  check("P03 ledger has row-level security enabled", t.relrowsecurity === true);

  const orgA = randomUUID(); const orgB = randomUUID();
  const [u1, u2] = await addUsers(orgA, 2);

  // ---- basic behaviour ---------------------------------------------------------------------------
  await reset();
  const a1 = await admit(app, u1, "url");
  check("B01 first url scan admitted, 1 Web Risk call reserved", a1.admitted === true && a1.reason === "admitted" && Number(a1.provider_calls_reserved) === 1 && a1.admission_id !== null, JSON.stringify(a1));
  const a2 = await admit(app, u1, "email");
  check("B02 email scan admitted (informational worst-case estimate 2; the real budget is cbc_reserve_provider_call)", a2.admitted === true && Number(a2.provider_calls_reserved) === 2);
  const ledger = (await admin.query("SELECT user_id::text, organization_id::text FROM public.scan_admissions ORDER BY id")).rows;
  check("B03 ledger rows carry the server-derived user and organization", ledger.length === 2 && ledger.every((r) => r.user_id === u1 && r.organization_id === orgA));
  const anonRow = await admit(app, null, "url");
  check("B04 no JWT subject -> unauthenticated, nothing recorded", anonRow.admitted === false && anonRow.reason === "unauthenticated" && (await count()) === 2);
  const stranger = await admit(app, randomUUID(), "url");
  check("B05 user without a profile -> no_organization, nothing recorded", stranger.admitted === false && stranger.reason === "no_organization" && (await count()) === 2);
  const bad = await admit(app, u1, "ftp");
  check("B06 unknown input type -> invalid_input_type, nothing recorded", bad.admitted === false && bad.reason === "invalid_input_type" && (await count()) === 2);

  // ---- direct access is impossible ---------------------------------------------------------------
  let denied = 0;
  for (const q of ["SELECT count(*) FROM public.scan_admissions", "DELETE FROM public.scan_admissions WHERE true", "INSERT INTO public.scan_admissions (user_id, organization_id, input_type, provider_calls_reserved) VALUES (gen_random_uuid(), gen_random_uuid(), 'url', 0)"]) {
    try { await asUser(app, u1, q); } catch (e) { if (/permission denied/i.test(String((e as Error).message))) denied++; }
  }
  check("X01 authenticated cannot read, delete or insert ledger rows directly", denied === 3, `denied ${denied}/3`);
  let srDenied = false;
  try {
    await app.query("BEGIN"); await app.query("SET LOCAL ROLE service_role"); await app.query("SELECT count(*) FROM public.scan_admissions");
  } catch (e) { srDenied = /permission denied/i.test(String((e as Error).message)); } finally { await app.query("ROLLBACK"); }
  check("X03 even service_role cannot read the ledger directly (reachable only through the function)", srDenied);
  let anonDenied = false;
  try {
    await app.query("BEGIN"); await app.query("SET LOCAL ROLE anon"); await app.query("SELECT * FROM public.cbc_admit_scan('url')");
  } catch (e) { anonDenied = /permission denied/i.test(String((e as Error).message)); } finally { await app.query("ROLLBACK"); }
  check("X02 anon cannot execute the admission function", anonDenied);

  // ---- per-user limit (50) ------------------------------------------------------------------------
  await reset();
  await preload(orgA, u1, 49);
  const u50 = await admit(app, u1); const u51 = await admit(app, u1);
  check("U01 50th user admission allowed, 51st rejected user_daily_limit", u50.admitted === true && u51.admitted === false && u51.reason === "user_daily_limit");
  check("U02 Retry-After is positive and at most 24 hours", Number(u51.retry_after_seconds) >= 1 && Number(u51.retry_after_seconds) <= 86400, String(u51.retry_after_seconds));
  check("U03 the rejection recorded nothing (still 50)", (await count(`user_id = '${u1}'`)) === 50);
  check("U04 another user in the same organization is unaffected", (await admit(app, u2)).admitted === true);

  // ---- rolling window and pruning ---------------------------------------------------------------
  await reset();
  await preload(orgA, u1, 50, "now() - interval '25 hours'");
  check("W01 admissions older than 24 hours do not count", (await admit(app, u1)).admitted === true);
  await preload(orgA, u1, 10, "now() - interval '49 hours'");
  await admit(app, u1);
  check("W02 rows older than 48 hours are pruned on admission", (await count("admitted_at < now() - interval '48 hours'")) === 0);

  // ---- per-organization limit (200) -------------------------------------------------------------
  await reset();
  const orgUsers = await addUsers(orgB, 5);
  for (const u of orgUsers.slice(0, 4)) await preload(orgB, u, 49);
  await preload(orgB, orgUsers[4], 3);   // org total 199
  const o200 = await admit(app, orgUsers[4]); const o201 = await admit(app, orgUsers[4]);
  check("O01 200th organization admission allowed, 201st rejected organization_daily_limit", o200.admitted === true && o201.admitted === false && o201.reason === "organization_daily_limit");
  check("O02 the organization limit does not affect another organization", (await admit(app, u1)).admitted === true);

  // ---- global limit (500) and the Web Risk bound -------------------------------------------------
  await reset();
  const orgs = Array.from({ length: 4 }, () => randomUUID());
  const gUsers: string[] = [];
  for (const o of orgs) gUsers.push(...(await addUsers(o, 3)));
  for (let i = 0; i < 10; i++) await preload(orgs[i % 4], gUsers[i], 49);   // 490
  await preload(orgs[0], gUsers[10], 9);                                      // 499
  const g500 = await admit(app, gUsers[11], "email"); const g501 = await admit(app, gUsers[11], "url");
  check("G01 500th global admission allowed, 501st rejected global_scan_capacity_reached", g500.admitted === true && g501.admitted === false && g501.reason === "global_scan_capacity_reached");
  const sumCalls = Number((await admin.query("SELECT COALESCE(sum(provider_calls_reserved), 0)::int AS s FROM public.scan_admissions WHERE admitted_at > now() - interval '24 hours'")).rows[0].s);
  check("G02 informational admission estimates stay <= 2 x 500 (the enforced budget is tested in R10-R16)", sumCalls <= 1000, String(sumCalls));

  // ---- concurrency: exact caps under parallel requests --------------------------------------------
  await reset();
  await preload(orgA, u1, 45);
  const conns = await Promise.all(Array.from({ length: 20 }, () => newApp()));
  const par = await Promise.all(conns.map((c) => admit(c, u1)));
  check("C01 20 parallel requests for one user at 45/50 -> exactly 5 admitted", par.filter((r) => r.admitted).length === 5 && (await count(`user_id = '${u1}'`)) === 50, `admitted ${par.filter((r) => r.admitted).length}`);
  await reset();
  const cUsers = await addUsers(orgB, 30);
  for (let i = 0; i < 9; i++) await preload(randomUUID(), randomUUID(), 55);   // 495 from other orgs/users
  const par2 = await Promise.all(conns.map((c, i) => admit(c, cUsers[i])));
  check("C02 20 parallel requests from different users at 495/500 -> exactly 5 admitted", par2.filter((r) => r.admitted).length === 5 && (await count()) === 500, `admitted ${par2.filter((r) => r.admitted).length}`);

  // ==== Part 2: execution-time Web Risk budget (cbc_reserve_provider_call) ====
  type Res = { granted: boolean; reason: string; retry_after_seconds: number; reservation_id: string | null };
  async function reserveAs(client: pg.Client, sub: string | null, admissionId: string | number, provider = "google_web_risk"): Promise<Res> {
    const r = await asUser(client, sub, "SELECT * FROM public.cbc_reserve_provider_call($1, $2)", [provider, admissionId]);
    return r.rows[0] as Res;
  }
  async function resetBudget() { await admin.query("TRUNCATE public.provider_call_reservations"); await reset(); }
  let syntheticAdmission = 1000000000;   // synthetic admission ids for preloaded rows; never reused (one-per-admission constraint)
  async function preloadReservations(n: number, ageSql = "now()") {
    await admin.query(`INSERT INTO public.provider_call_reservations (provider, admission_id, user_id, organization_id, reserved_at)
      SELECT 'google_web_risk', $2::bigint + g, gen_random_uuid(), gen_random_uuid(), ${ageSql} FROM generate_series(1, $1) g`, [n, syntheticAdmission]);
    syntheticAdmission += n;
  }
  async function resCount(where = "true"): Promise<number> { return Number((await admin.query(`SELECT count(*)::int AS n FROM public.provider_call_reservations WHERE ${where}`)).rows[0].n); }
  const rf = (await admin.query(`SELECT p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
      FROM pg_proc p WHERE p.oid = 'public.cbc_reserve_provider_call(text, bigint)'::regprocedure`)).rows[0];
  check("R01 reservation function: SECURITY DEFINER, pinned search_path, authenticated may execute, anon may not",
    rf.prosecdef === true && JSON.stringify(rf.proconfig).includes("search_path=pg_catalog, public") && rf.auth_exec === true && rf.anon_exec === false);
  check("R02 reservation ledger has RLS enabled", (await admin.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.provider_call_reservations'::regclass`)).rows[0].relrowsecurity === true);
  let rDenied = 0;
  for (const role of ["authenticated", "service_role"]) {
    try { await app.query("BEGIN"); await app.query(`SET LOCAL ROLE ${role}`); await app.query("SELECT count(*) FROM public.provider_call_reservations"); }
    catch (e) { if (/permission denied/i.test(String((e as Error).message))) rDenied++; } finally { await app.query("ROLLBACK"); }
  }
  check("R03 neither authenticated nor service_role can read the reservation ledger directly", rDenied === 2);

  await resetBudget();
  const [ru1, ru2] = await addUsers(orgA, 2);
  const adm = await admit(app, ru1, "url");
  const g1 = await reserveAs(app, ru1, adm.admission_id as string);
  check("R04 the caller's fresh admission gets one reservation", g1.granted === true && g1.reason === "granted" && g1.reservation_id !== null, JSON.stringify(g1));
  const g2 = await reserveAs(app, ru1, adm.admission_id as string);
  check("R05 a second reservation for the same admission is refused (already_reserved)", g2.granted === false && g2.reason === "already_reserved" && (await resCount()) === 1);
  const foreign = await reserveAs(app, ru2, adm.admission_id as string);
  check("R06 another user cannot use someone else's admission (admission_not_valid)", foreign.granted === false && foreign.reason === "admission_not_valid");
  const adm2 = await admit(app, ru1, "email");
  await admin.query("UPDATE public.scan_admissions SET admitted_at = now() - interval '11 minutes' WHERE id = $1", [adm2.admission_id]);
  const stale = await reserveAs(app, ru1, adm2.admission_id as string);
  check("R07 an admission older than 10 minutes cannot fund a call", stale.granted === false && stale.reason === "admission_not_valid");
  check("R08 no JWT subject -> unauthenticated; other provider -> unknown_provider",
    (await reserveAs(app, null, 1)).reason === "unauthenticated" && (await reserveAs(app, ru1, adm.admission_id as string, "other")).reason === "unknown_provider");
  check("R09 a nonexistent admission id is refused", (await reserveAs(app, ru1, 987654321)).reason === "admission_not_valid");

  await resetBudget();
  await preloadReservations(999);
  const b1000 = await reserveAs(app, ru1, (await admit(app, ru1)).admission_id as string);
  const b1001 = await reserveAs(app, ru1, (await admit(app, ru1)).admission_id as string);
  check("R10 the 1000th Web Risk reservation in 24 h is granted, the 1001st refused (provider_budget_exhausted)", b1000.granted === true && b1001.granted === false && b1001.reason === "provider_budget_exhausted");
  check("R11 Retry-After for an exhausted budget is positive and at most 24 hours", Number(b1001.retry_after_seconds) >= 1 && Number(b1001.retry_after_seconds) <= 86400);
  check("R12 the refusal recorded nothing (still 1000)", (await resCount()) === 1000);

  await resetBudget();
  await preloadReservations(1000, "now() - interval '25 hours'");
  check("R13 reservations older than 24 hours do not count", (await reserveAs(app, ru1, (await admit(app, ru1)).admission_id as string)).granted === true);
  await preloadReservations(5, "now() - interval '49 hours'");
  await reserveAs(app, ru1, (await admit(app, ru1)).admission_id as string);
  check("R14 reservations older than 48 hours are pruned on reservation", (await resCount("reserved_at < now() - interval '48 hours'")) === 0);

  // concurrency: exact cap and one-per-admission under parallel requests
  await resetBudget();
  await preloadReservations(995);
  const rUsers = await addUsers(orgB, 20);
  const rAdms: string[] = [];
  for (const u of rUsers) rAdms.push((await admit(app, u)).admission_id as string);
  const rPar = await Promise.all(conns.map((c, i) => reserveAs(c, rUsers[i], rAdms[i])));
  check("R15 20 parallel reservations at 995/1000 -> exactly 5 granted", rPar.filter((r) => r.granted).length === 5 && (await resCount()) === 1000, `granted ${rPar.filter((r) => r.granted).length}`);
  await resetBudget();
  const oneAdm = (await admit(app, ru1)).admission_id as string;
  const rDup = await Promise.all(conns.map((c) => reserveAs(c, ru1, oneAdm)));
  check("R16 20 parallel reservations for ONE admission -> exactly 1 granted", rDup.filter((r) => r.granted).length === 1 && (await resCount()) === 1, `granted ${rDup.filter((r) => r.granted).length}`);
  await Promise.all(conns.map((c) => c.end()));
} catch (e) {
  check("harness completed without an unexpected error", false, String((e as Error).message));
} finally {
  await app.end();
  await admin.end();
}
console.log(`\n=== Gate 007A admission DB validation: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
