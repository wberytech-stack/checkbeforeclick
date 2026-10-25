// Gate 006C - signed-in journeys and cross-tenant isolation on the Azure STAGING app.
//
//   node scripts/azure-hosting/staging-auth-journeys.mjs
//   env: STG_APP_URL, STG_SUPABASE_URL, PROD_APP_URL, PROD_SUPABASE_URL (repository
//        variables) and, from the founder-protected GitHub environment
//        staging-auth-test: CBC_TEST_A_EMAIL, CBC_TEST_A_PASSWORD, CBC_TEST_B_EMAIL,
//        CBC_TEST_B_PASSWORD (two pre-created staging accounts in DIFFERENT
//        organizations; never created by this script).
//
// Extends staging-integration.mjs (same identity check, asset inspection, sanitizer).
// Journeys: A and B sign in through the app (POST /api/auth/login); A loads the
// dashboard, creates ONE scan of http://localhost/... (rejected as an unsafe target and
// completed "unknown" before any provider runs: no Web Risk, no RDAP, no Inngest event),
// reads its status and history; B must not see A's scan through the app (status API
// and scan page) or through the Supabase data API with B's own session token (scans,
// evidence_items, vendor_results by id; scans and users of other owners by count with
// zero rows requested); both sign out and protected routes redirect again.
// Writes: two sign-ins, one scan with its evidence row. Sign-out revokes the sessions.
// The created scan id is printed for the founder-run cleanup (docs/gates). Passwords,
// cookies and tokens are never printed. No retries. No dependencies.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { STAGING_REF, PRODUCTION_REF, checkIdentity, inspectLoginAssets, makeClient, clean, describeError, hostOf, VerifierError } from "./staging-integration.mjs";

const TIMEOUT_MS = 20000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATA_TABLES = /^\/rest\/v1\/(scans|evidence_items|vendor_results|users)$/;

// The only requests this verifier may send. GET anywhere on the staging app; POST only
// to the login and scan APIs; GET/HEAD only on four data-API tables of staging Supabase.
export function makeJourneyClient(fetchImpl, appHost, supabaseHost) {
  return async function request(url, { method = "GET", headers = {}, body } = {}) {
    let u;
    try { u = new URL(url); } catch { throw new VerifierError("refused malformed URL"); }
    const allowed = u.protocol === "https:" && (
      (u.host === appHost && (method === "GET" || (method === "POST" && ["/api/auth/login", "/api/scan"].includes(u.pathname)))) ||
      (u.host === supabaseHost && (method === "GET" || method === "HEAD") && DATA_TABLES.test(u.pathname)));
    if (!allowed) throw new VerifierError(`refused ${method} outside the journey allow-list`);
    return fetchImpl(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  };
}

// Minimal cookie jar per account; Set-Cookie with an empty value or Max-Age=0 deletes.
export class Jar {
  #c = new Map();
  absorb(res) {
    const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const [pair, ...attrs] = line.split(";");
      const i = pair.indexOf("=");
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim(); const value = pair.slice(i + 1).trim();
      const expired = !value || attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a) || /^\s*expires\s*=.*1970/i.test(a));
      if (expired) this.#c.delete(name); else this.#c.set(name, value);
    }
  }
  header() { return [...this.#c].map(([k, v]) => `${k}=${v}`).join("; "); }
  names() { return [...this.#c.keys()]; }
  // The @supabase/ssr session cookie (sb-<ref>-auth-token, possibly chunked .0 .1 ...),
  // value "base64-" + base64url(JSON). Returns { token, sub } or null.
  session(ref) {
    const base = `sb-${ref}-auth-token`;
    let raw = this.#c.get(base);
    if (raw === undefined) {
      const parts = []; for (let i = 0; this.#c.has(`${base}.${i}`); i++) parts.push(this.#c.get(`${base}.${i}`));
      raw = parts.length ? parts.join("") : undefined;
    }
    if (!raw) return null;
    try {
      const text = raw.startsWith("base64-") ? Buffer.from(raw.slice(7), "base64url").toString("utf8") : decodeURIComponent(raw);
      const s = JSON.parse(text);
      const token = typeof s.access_token === "string" ? s.access_token : null;
      const sub = typeof s.user?.id === "string" && UUID.test(s.user.id) ? s.user.id : null;
      return token && sub ? { token, sub } : null;
    } catch { return null; }
  }
}

export async function runJourneys(env, fetchImpl = globalThis.fetch, runId = randomUUID()) {
  const results = [];
  const created = [];
  const add = (id, name, status, evidence) => results.push({ id, name, status, evidence: clean(evidence) });
  const blockRest = (from, why) => { for (const [id, name] of JOURNEYS.slice(from)) add(id, name, "BLOCKED", why); };
  const out = () => ({ results, created });

  // J0: identity (fail closed), credentials present and distinct accounts.
  const identity = checkIdentity(env);
  const creds = ["CBC_TEST_A_EMAIL", "CBC_TEST_A_PASSWORD", "CBC_TEST_B_EMAIL", "CBC_TEST_B_PASSWORD"].every((k) => typeof env[k] === "string" && env[k].length > 0);
  const distinct = creds && env.CBC_TEST_A_EMAIL.trim().toLowerCase() !== env.CBC_TEST_B_EMAIL.trim().toLowerCase();
  const j0 = identity.ok && creds && distinct;
  add("J0", JOURNEYS[0][1], j0 ? "VERIFIED" : "FAILED",
    !identity.ok ? "staging and production could not be distinguished (I1/I2)" : !creds ? "test account credentials missing from the staging-auth-test environment" : !distinct ? "accounts A and B are the same" : "staging identity confirmed; two distinct test accounts configured");
  if (!j0) { blockRest(1, "not run: J0 failed"); return out(); }
  const { stg, sb } = identity;
  const app = makeClient(fetchImpl, new Set([hostOf(stg)]));
  const request = makeJourneyClient(fetchImpl, hostOf(stg), hostOf(sb));
  let anonKey;
  try {
    const assets = await inspectLoginAssets(app, stg);
    if (!assets.key || assets.prodPresent || assets.refs.join() !== STAGING_REF) throw new VerifierError("login assets are not the verified staging build (see I3/I4)");
    anonKey = assets.key;
  } catch (e) { add("J1", JOURNEYS[1][1], "FAILED", describeError(e)); blockRest(2, "not run: no verified staging public key"); return out(); }

  const jars = { A: new Jar(), B: new Jar() };
  const get = async (who, path) => { const r = await request(`${stg}${path}`, { headers: { cookie: jars[who].header() } }); jars[who].absorb(r); return r; };
  const sessions = {};

  // J1-J2: sign in through the app; the session cookie must be for the staging project.
  // Any sign-in failure (including a production cookie) stops before data is written.
  const signedIn = { A: false, B: false };
  for (const [id, who] of [["J1", "A"], ["J2", "B"]]) {
    try {
      const r = await request(`${stg}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: env[`CBC_TEST_${who}_EMAIL`], password: env[`CBC_TEST_${who}_PASSWORD`] }) });
      jars[who].absorb(r);
      const prodCookie = jars[who].names().some((n) => n.includes(PRODUCTION_REF));
      sessions[who] = jars[who].session(STAGING_REF);
      const ok = r.status === 200 && !prodCookie && sessions[who] !== null;
      signedIn[who] = ok;
      add(id, JOURNEYS[id === "J1" ? 1 : 2][1], ok ? "VERIFIED" : "FAILED",
        ok ? `account ${who}: status 200; staging session cookie set` : `account ${who}: status ${r.status}${prodCookie ? "; production cookie present" : ""}${sessions[who] ? "" : "; no staging session"}`);
    } catch (e) { add(id, JOURNEYS[id === "J1" ? 1 : 2][1], "FAILED", describeError(e)); }
  }
  if (!signedIn.A || !signedIn.B) { blockRest(3, "not run: both accounts must sign in to staging only"); return out(); }
  if (sessions.A.sub === sessions.B.sub) { add("J3", JOURNEYS[3][1], "FAILED", "A and B resolved to the same user"); blockRest(4, "not run: accounts not distinct"); return out(); }

  // J3: authenticated session reaches a protected page.
  try {
    const r = await get("A", "/dashboard");
    add("J3", JOURNEYS[3][1], r.status === 200 ? "VERIFIED" : "FAILED", `GET /dashboard as A: status ${r.status}`);
  } catch (e) { add("J3", JOURNEYS[3][1], "FAILED", describeError(e)); }

  // J4: one scan of an unsafe target, completed before any provider runs.
  let scanId = null;
  try {
    const r = await request(`${stg}/api/scan`, { method: "POST", headers: { "content-type": "application/json", cookie: jars.A.header() },
      body: JSON.stringify({ input_type: "url", input: `http://localhost/cbc-staging-journey/${runId}` }) });
    jars.A.absorb(r);
    const j = await r.json().catch(() => null);
    scanId = j && typeof j.scan_id === "string" && UUID.test(j.scan_id) ? j.scan_id : null;
    if (scanId) created.push({ table: "scans", id: scanId, owner: "A" });
    add("J4", JOURNEYS[4][1], r.status === 201 && scanId ? "VERIFIED" : "FAILED", `POST /api/scan as A (localhost target): status ${r.status}${scanId ? `; scan ${scanId}` : ""}`);
  } catch (e) { add("J4", JOURNEYS[4][1], "FAILED", describeError(e)); }
  if (!scanId) { blockRest(5, "not run: no scan was created"); return out(); }

  // J5-J6: status and history as the owner.
  try {
    const r = await get("A", `/api/scan/${scanId}/status`);
    const j = r.status === 200 ? await r.json().catch(() => null) : null;
    const ok = j && j.status === "complete" && j.verdict === "unknown";
    add("J5", JOURNEYS[5][1], ok ? "VERIFIED" : "FAILED", ok ? "status 200; complete; verdict unknown (no provider ran)" : `status ${r.status}`);
  } catch (e) { add("J5", JOURNEYS[5][1], "FAILED", describeError(e)); }
  try {
    const r = await get("A", "/history");
    add("J6", JOURNEYS[6][1], r.status === 200 ? "VERIFIED" : "FAILED", `GET /history as A: status ${r.status}`);
  } catch (e) { add("J6", JOURNEYS[6][1], "FAILED", describeError(e)); }

  // J7-J8: B through the app (application-level organization scoping).
  try {
    const r = await get("B", `/api/scan/${scanId}/status`);
    add("J7", JOURNEYS[7][1], r.status === 404 ? "VERIFIED" : "FAILED",
      r.status === 404 ? "status 404 for A's scan" : `status ${r.status}${r.status === 200 ? ": B can read A's scan (accounts may share an organization)" : ""}`);
  } catch (e) { add("J7", JOURNEYS[7][1], "FAILED", describeError(e)); }
  try {
    const r = await get("B", `/scan/${scanId}`);
    add("J8", JOURNEYS[8][1], r.status === 404 ? "VERIFIED" : "FAILED", `GET /scan/<A's id> as B: status ${r.status}`);
  } catch (e) { add("J8", JOURNEYS[8][1], "FAILED", describeError(e)); }

  // J9-J10: B through the Supabase data API with B's own token (row-level security).
  // Denied (401/403) or zero rows pass; any row of another owner fails.
  const asB = { apikey: anonKey, authorization: `Bearer ${sessions.B.token}`, accept: "application/json" };
  const probes = [
    ["scans by A's id", `/rest/v1/scans?select=id&id=eq.${scanId}`, "GET"],
    ["evidence_items of A's scan", `/rest/v1/evidence_items?select=id&scan_id=eq.${scanId}`, "GET"],
    ["vendor_results of A's scan", `/rest/v1/vendor_results?select=id&scan_id=eq.${scanId}`, "GET"],
    ["scans of other users (count only)", `/rest/v1/scans?select=id&user_id=neq.${sessions.B.sub}&limit=0`, "HEAD"],
    ["users other than B (count only)", `/rest/v1/users?select=id&id=neq.${sessions.B.sub}&limit=0`, "HEAD"],
  ];
  // Each probe passes only if denied (401/403) or it observed exactly zero rows.
  const findings = [];
  for (const [label, path, method] of probes) {
    let pass = false; let text;
    try {
      const r = await request(`${sb}${path}`, { method, headers: method === "HEAD" ? { ...asB, prefer: "count=exact" } : asB });
      if (r.status === 401 || r.status === 403) { pass = true; text = "denied"; }
      else if (method === "HEAD") {
        const total = (r.headers.get("content-range") ?? "").split("/")[1] ?? "";
        const ok = r.status === 200 || r.status === 206;
        pass = ok && total === "0";
        text = !ok ? `status ${r.status}` : pass ? "0 rows" : `${/^\d+$/.test(total) ? total : "unknown"} rows VISIBLE`;
      } else {
        const rows = r.status === 200 ? await r.json().catch(() => null) : null;
        pass = Array.isArray(rows) && rows.length === 0;
        text = !Array.isArray(rows) ? `status ${r.status}` : pass ? "0 rows" : `${rows.length} rows VISIBLE`;
      }
    } catch (e) { text = describeError(e); }
    findings.push({ pass, text: `${label}: ${text}` });
  }
  const allPass = findings.every((f) => f.pass);
  add("J9", JOURNEYS[9][1], allPass ? "VERIFIED" : "FAILED",
    `${allPass ? "no cross-tenant row visible" : "cross-tenant exposure or probe failure"}: ${findings.map((f) => f.text).join("; ")}`);

  // J10: B's own data API access to A's scan is covered above; A's own access is only
  // observed (the app reads through the service role, so RLS for owners is informational).
  try {
    const r = await request(`${sb}/rest/v1/scans?select=id&id=eq.${scanId}`, { headers: { apikey: anonKey, authorization: `Bearer ${sessions.A.token}`, accept: "application/json" } });
    const rows = r.status === 200 ? await r.json().catch(() => null) : null;
    add("J10", JOURNEYS[10][1], "OBSERVED", Array.isArray(rows) ? `owner can read own scan through the data API: ${rows.length === 1 ? "yes" : "no"}` : `owner request status ${r.status}`);
  } catch (e) { add("J10", JOURNEYS[10][1], "OBSERVED", describeError(e)); }

  // J11: sign-out ends both sessions. Pass condition: after sign-out, the session cookie
  // captured BEFORE sign-out is replayed and must be rejected (server-side revocation),
  // and /dashboard redirects to /login. Whether the cookie was cleared is evidence only.
  try {
    const states = []; let pass = true;
    for (const who of ["A", "B"]) {
      const before = jars[who].header();
      const so = await get(who, "/auth/signout");
      const after = await get(who, "/dashboard");
      const replay = await request(`${stg}/dashboard`, { headers: { cookie: before } });
      const toLogin = (r) => r.status === 307 && /\/login/.test(r.headers.get("location") ?? "");
      const ok = so.status === 307 && toLogin(after) && toLogin(replay);
      pass = pass && ok;
      states.push(`${who}: sign-out ${so.status}; /dashboard ${after.status}; replayed old session ${toLogin(replay) ? "rejected" : `ACCEPTED (status ${replay.status})`}; cookie ${jars[who].session(STAGING_REF) === null ? "cleared" : "still present"}`);
    }
    add("J11", JOURNEYS[11][1], pass ? "VERIFIED" : "FAILED", states.join("; "));
  } catch (e) { add("J11", JOURNEYS[11][1], "FAILED", describeError(e)); }
  return out();
}

export const JOURNEYS = [
  ["J0", "Staging identity confirmed and two distinct test accounts configured"],
  ["J1", "Account A signs in through the app; staging session cookie"],
  ["J2", "Account B signs in through the app; staging session cookie"],
  ["J3", "Authenticated session reaches /dashboard"],
  ["J4", "A creates one localhost scan (no provider, no Web Risk, no Inngest event)"],
  ["J5", "A reads the scan status (complete, unknown)"],
  ["J6", "A loads /history"],
  ["J7", "B cannot read A's scan through the status API (organization scoping)"],
  ["J8", "B cannot open A's scan page"],
  ["J9", "B sees no cross-tenant rows through the Supabase data API (RLS, B's own token)"],
  ["J10", "A's own data API access to the scan (observed only)"],
  ["J11", "Sign-out ends both sessions; protected routes redirect again"],
];

export function formatJourneys({ results, created }) {
  const rows = results.map((r) => `| ${[r.id, r.name, r.status, r.evidence].map((c) => clean(c)).join(" | ")} |`);
  const cleanup = created.length
    ? created.map((c) => `- ${c.table} ${clean(c.id)} (account ${c.owner}): delete with the founder cleanup SQL in docs/gates/gate-006c-authenticated-staging-verification.md`)
    : ["- none"];
  return ["| ID | Journey | Status | Evidence |", "| --- | --- | --- | --- |", ...rows, "", "Test data created by this run (cleanup required):", ...cleanup].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = await runJourneys(process.env);
  const text = formatJourneys(run);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Staging signed-in journeys\n\n${text}\n`);
  const failed = run.results.filter((r) => r.status !== "VERIFIED" && r.status !== "OBSERVED");
  for (const f of failed) console.log(`::error::${f.id} ${f.status}: ${clean(f.evidence)}`);
  console.log(failed.length === 0 ? "staging journeys: PASS" : `staging journeys: FAIL (${failed.length})`);
  process.exit(failed.length === 0 ? 0 : 1);
}
