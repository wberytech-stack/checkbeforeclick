// Gate 006C - read-only integration checks of the deployed Azure STAGING app.
//
//   node scripts/azure-hosting/staging-integration.mjs
//   env: STG_APP_URL, STG_SUPABASE_URL, PROD_APP_URL, PROD_SUPABASE_URL (repository
//        variables; URLs only, no keys)
//
// Complements smoke.ts (healthz, signed-out redirects, API guards, callback, sign-out).
// Fails closed unless staging and production can be told apart, then checks:
//   I1-I2  the configured staging app and Supabase project are staging, not production
//   I3-I4  the INSPECTED client assets (the /login HTML and the same-origin scripts it
//          references directly) point at the staging Supabase project only and carry
//          exactly one public (anon / publishable) key; any credential found in them
//          fails the run. Lazily loaded chunks and other pages are not inspected (U6).
//   I5-I6  Supabase Auth health and settings (public endpoints; no account, no session)
//   I7     Supabase data API reachable as the anon role with zero rows requested; the
//          outcome is reported as observed and is NOT evidence of RLS correctness (U5)
//   I8     Inngest serve endpoint is in cloud mode and rejects unsigned requests
// This verifier sends GET or HEAD only, to the staging app or the staging Supabase host
// only, without following redirects, with a timeout and no retries. The public key is
// taken from the inspected assets, held in memory and never printed. Evidence is built
// from fixed text, numbers and allow-listed values only, then sanitized and bounded;
// response bodies, header values and request URLs are never echoed. No dependencies.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// docs/ENVIRONMENTS.md: staging and production Supabase projects.
export const STAGING_REF = "zgxmvpbvvakpsnzcymsf";
export const PRODUCTION_REF = "qnjqwmcsfpmpnvlnomat";
const STAGING_APP_HOST = /^ca-cbc-web-stg-cc-001\.[a-z0-9-]+\.canadacentral\.azurecontainerapps\.io$/;
const TIMEOUT_MS = 15000;
const MAX_ASSETS = 80;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE = 200;
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const PUBLISHABLE = /sb_publishable_[A-Za-z0-9_-]{10,}/g;
const SECRET_KEY = /sb_secret_[A-Za-z0-9_-]{10,}/;

// Evidence and error text: secrets redacted, then only a plain character set (no
// newlines, markup, pipes, percent or workflow-command sequences), then bounded.
export function clean(s) {
  const t = String(s)
    .replace(JWT, "REDACTED_JWT").replace(PUBLISHABLE, "REDACTED_KEY").replace(/sb_secret_[A-Za-z0-9_-]+/g, "REDACTED_KEY")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "REDACTED_URL")
    .replace(/[^A-Za-z0-9 .,;:()=+\-_/'*]/g, " ").replace(/::+/g, ":")
    .replace(/\s+/g, " ").trim();
  return t.length > MAX_EVIDENCE ? `${t.slice(0, MAX_EVIDENCE - 3)}...` : t;
}
// A value taken from a response is shown only if it is short and plain.
const plain = (v, re = /^[A-Za-z0-9 ._-]{1,40}$/) => (typeof v === "string" && re.test(v) ? v : null);
// Exceptions become one of a few fixed descriptions; their messages are not echoed.
class VerifierError extends Error {}
function describeError(e) {
  if (e instanceof VerifierError) return e.message;
  if (e && (e.name === "TimeoutError" || e.name === "AbortError")) return `timed out after ${TIMEOUT_MS / 1000}s`;
  if (e instanceof SyntaxError) return "response was not valid JSON";
  return "network error";
}

const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };
const isHttpsOrigin = (u) => typeof u === "string" && /^https:\/\/[a-z0-9.-]+$/.test(u);

function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); } catch { return null; }
}

// One guarded request: GET/HEAD only, allow-listed hosts only, no redirects, timeout.
export function makeClient(fetchImpl, allowedHosts) {
  return async function request(url, { method = "GET", headers = {} } = {}) {
    if (method !== "GET" && method !== "HEAD") throw new VerifierError(`refused ${method}: read-only verifier`);
    const host = hostOf(url);
    if (!allowedHosts.has(host) || !url.startsWith("https://")) throw new VerifierError("refused request to a non-staging host");
    return fetchImpl(url, { method, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  };
}

export async function runChecks(env, fetchImpl = globalThis.fetch) {
  const results = [];
  const add = (id, name, status, evidence) => results.push({ id, name, status, evidence: clean(evidence) });
  const stg = (env.STG_APP_URL ?? "").replace(/\/$/, "");
  const sb = (env.STG_SUPABASE_URL ?? "").replace(/\/$/, "");
  const prodApp = (env.PROD_APP_URL ?? "").replace(/\/$/, "");
  const prodSb = (env.PROD_SUPABASE_URL ?? "").replace(/\/$/, "");

  // I1-I2: fail closed unless staging and production are distinguishable.
  const i1 = isHttpsOrigin(stg) && STAGING_APP_HOST.test(hostOf(stg)) && isHttpsOrigin(prodApp) && hostOf(prodApp) !== hostOf(stg);
  add("I1", "Staging app origin is the staging Container App and differs from production", i1 ? "VERIFIED" : "FAILED",
    i1 ? `staging host ${hostOf(stg)}; production host ${hostOf(prodApp)}` : "STG_APP_URL / PROD_APP_URL missing, not https, not the staging app, or equal");
  const i2 = sb === `https://${STAGING_REF}.supabase.co` && prodSb === `https://${PRODUCTION_REF}.supabase.co`;
  add("I2", "Configured Supabase project is staging; production project is distinct", i2 ? "VERIFIED" : "FAILED",
    i2 ? `staging ref ${STAGING_REF}; production ref ${PRODUCTION_REF}` : "STG_SUPABASE_URL / PROD_SUPABASE_URL are not the documented staging / production projects");
  if (!i1 || !i2) {
    for (const [id, name] of [["I3", "Inspected client assets target staging Supabase only"], ["I4", "Inspected client assets carry only a public key"],
      ["I5", "Supabase Auth health"], ["I6", "Supabase Auth settings"], ["I7", "Supabase data API as anon, zero rows requested"], ["I8", "Inngest rejects unsigned requests"]])
      add(id, name, "BLOCKED", "not run: staging and production could not be distinguished");
    return results;
  }
  const request = makeClient(fetchImpl, new Set([hostOf(stg), hostOf(sb)]));
  const I3 = "Inspected client assets (/login HTML and its directly referenced same-origin scripts) target staging Supabase only";
  const I4 = "Inspected client assets carry exactly one public key (anon or publishable); no credential found in them";

  // I3-I4: the /login HTML and the same-origin scripts it references directly.
  let key = null;
  try {
    const page = await request(`${stg}/login`);
    if (page.status !== 200) throw new VerifierError(`/login returned status ${page.status}`);
    const html = await page.text();
    const srcs = [...new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]))]
      .map((s) => { try { return new URL(s, `${stg}/`).toString(); } catch { return ""; } })
      .filter((u) => hostOf(u) === hostOf(stg)).slice(0, MAX_ASSETS);
    let bundle = html;
    for (const u of srcs) {
      const r = await request(u);
      if (r.status !== 200) throw new VerifierError(`a referenced script returned status ${r.status}`);
      bundle += "\n" + (await r.text());
      if (bundle.length > MAX_BYTES) throw new VerifierError("inspected assets exceed the verifier size limit");
    }
    const scope = `/login HTML plus ${srcs.length} directly referenced script(s)`;
    const refs = [...new Set([...bundle.matchAll(/https:\/\/([a-z0-9]{20})\.supabase\.co/g)].map((m) => m[1]))];
    const prodPresent = bundle.includes(PRODUCTION_REF);
    const i3 = refs.length === 1 && refs[0] === STAGING_REF && !prodPresent;
    add("I3", I3, i3 ? "VERIFIED" : "FAILED",
      i3 ? `${scope}: only ${STAGING_REF}.supabase.co; production ref absent`
         : `${scope}: ${refs.length} Supabase project ref(s)${refs.includes(STAGING_REF) ? " incl. staging" : ""}${prodPresent ? "; production ref present" : ""}`);

    const jwts = [...new Set(bundle.match(JWT) ?? [])].map((t) => ({ t, c: jwtClaims(t) })).filter((x) => x.c && (x.c.role || x.c.ref));
    const publishable = [...new Set(bundle.match(PUBLISHABLE) ?? [])];
    const anon = jwts.filter((x) => x.c.role === "anon" && x.c.ref === STAGING_REF);
    const bad = jwts.filter((x) => !(x.c.role === "anon" && x.c.ref === STAGING_REF));
    const secret = SECRET_KEY.test(bundle);
    const keys = [...anon.map((x) => x.t), ...publishable];
    const i4 = !secret && bad.length === 0 && keys.length === 1;
    key = i4 ? keys[0] : null;
    const roles = [...new Set(bad.map((x) => plain(x.c.role, /^[a-z_]{1,20}$/) ?? "other"))].slice(0, 5).join(",");
    add("I4", I4, i4 ? "VERIFIED" : "FAILED",
      i4 ? `${scope}: ${anon.length ? `one anon JWT for ref ${STAGING_REF}` : "one publishable key (project binding checked by I5-I7)"}; no other credential found`
         : `${scope}: public keys ${keys.length}; other JWTs ${bad.length}${roles ? ` (roles ${roles})` : ""}; secret key ${secret ? "FOUND" : "not found"}`);
  } catch (e) {
    add("I3", I3, "FAILED", describeError(e));
    add("I4", I4, "BLOCKED", "inspected assets could not be read");
  }

  // I5-I7: Supabase, with the public key from the inspected assets only.
  const I7 = "Supabase data API reachable as anon, zero rows requested (not an RLS verification)";
  if (!key) {
    for (const [id, name] of [["I5", "Supabase Auth health"], ["I6", "Supabase Auth settings"], ["I7", I7]])
      add(id, name, "BLOCKED", "no single verified public key in the inspected assets");
  } else {
    const h = { apikey: key, accept: "application/json" };
    try {
      const r = await request(`${sb}/auth/v1/health`, { headers: h });
      const j = r.status === 200 ? await r.json() : null;
      const ok = j && typeof j === "object" && ("version" in j || "name" in j);
      const label = ok ? [plain(j.name), plain(j.version)].filter(Boolean).join(" ") : "";
      add("I5", "Supabase Auth health (public endpoint)", ok ? "VERIFIED" : "FAILED", ok ? `status 200${label ? `; ${label}` : ""}` : `status ${r.status}`);
    } catch (e) { add("I5", "Supabase Auth health (public endpoint)", "FAILED", describeError(e)); }
    try {
      const r = await request(`${sb}/auth/v1/settings`, { headers: h });
      const j = r.status === 200 ? await r.json() : null;
      const ok = j && typeof j === "object" && typeof j.external === "object" && j.external !== null;
      add("I6", "Supabase Auth settings (public endpoint; no account or session)", ok ? "VERIFIED" : "FAILED",
        ok ? `email provider ${j.external.email === true ? "enabled" : "disabled"}; signup ${j.disable_signup === true ? "disabled" : "enabled"}; email autoconfirm ${j.mailer_autoconfirm === true ? "on" : "off"}` : `status ${r.status}`);
    } catch (e) { add("I6", "Supabase Auth settings (public endpoint; no account or session)", "FAILED", describeError(e)); }
    try {
      // Anon role, zero rows requested; only the status and the Content-Range total are
      // read. Either observed outcome shows the data API answered; neither proves that
      // row-level security is correct (U5).
      const r = await request(`${sb}/rest/v1/scans?select=id&limit=0`, { method: "HEAD", headers: { ...h, prefer: "count=exact" } });
      const totalRaw = (r.headers.get("content-range") ?? "").split("/")[1] ?? "";
      const total = /^\d{1,12}$/.test(totalRaw) ? Number(totalRaw) : null;
      if (r.status === 401 || r.status === 403) {
        add("I7", I7, "VERIFIED", `anonymous request denied (status ${r.status}); data API reachable; RLS policy not verified`);
      } else if ((r.status === 200 || r.status === 206) && total === 0) {
        add("I7", I7, "VERIFIED", `zero-row metadata query succeeded (status ${r.status}); anon-visible count 0; RLS policy not verified`);
      } else if ((r.status === 200 || r.status === 206) && total !== null) {
        add("I7", I7, "FAILED", `zero-row metadata query succeeded but anon-visible count is ${total}`);
      } else {
        add("I7", I7, "FAILED", `status ${r.status}; count ${total === null ? "not reported" : total}`);
      }
    } catch (e) { add("I7", I7, "FAILED", describeError(e)); }
  }

  // I8: unsigned GET; cloud mode answers 401 and serves introspection only when signed.
  try {
    const r = await request(`${stg}/api/inngest`);
    const j = r.status === 401 ? await r.json().catch(() => null) : null;
    const ok = r.status === 401 && j && j.message === "Unauthorized";
    add("I8", "Inngest endpoint in cloud mode rejects unsigned requests (no sync, no event)", ok ? "VERIFIED" : "FAILED",
      ok ? "unsigned GET returned status 401 Unauthorized" : `unsigned GET returned status ${r.status}${r.status === 200 ? " (dev mode or unsigned introspection exposed)" : ""}`);
  } catch (e) { add("I8", "Inngest endpoint in cloud mode rejects unsigned requests (no sync, no event)", "FAILED", describeError(e)); }
  return results;
}

// Checks this verifier cannot perform without credentials or cloud access.
export const NOT_COVERED = [
  ["U1", "Inngest branch environment (INNGEST_ENV) and serve origin, live", "UNVERIFIED", "needs a signed introspection (signing key); configured in main.parameters.json and checked by test-hosting-safety P6"],
  ["U2", "WEB_RISK_PROVIDER_ENABLED=false and no Web Risk key, live", "UNVERIFIED", "needs Azure read; enforced at deploy by the template check and the post-deploy config check in azure-deploy"],
  ["U3", "Supabase Auth redirect URL allow-list", "BLOCKED", "not exposed publicly; needs the Supabase dashboard or a management token"],
  ["U4", "Signed-in flows S4-S12 (session, scans, sign-out)", "BLOCKED", "authenticated tests need a founder-approved staging test account"],
  ["U5", "Supabase row-level security policies (scans and other tables)", "UNVERIFIED", "an anon probe cannot prove policy correctness; needs a policy review and an authenticated cross-tenant test"],
  ["U6", "Client assets beyond /login and its directly referenced scripts", "UNVERIFIED", "lazily loaded chunks and other pages are not inspected for credentials"],
];

export function formatMatrix(results) {
  const rows = [...results.map((r) => [r.id, r.name, r.status, r.evidence]), ...NOT_COVERED];
  return ["| ID | Check | Status | Evidence |", "| --- | --- | --- | --- |", ...rows.map((r) => `| ${r.map((c) => clean(c)).join(" | ")} |`)].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await runChecks(process.env);
  const matrix = formatMatrix(results);
  console.log(matrix);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Staging integration verification\n\n${matrix}\n`);
  const failed = results.filter((r) => r.status !== "VERIFIED");
  for (const f of failed) console.log(`::error::${f.id} ${f.status}: ${clean(f.evidence)}`);
  console.log(failed.length === 0 ? "staging integration: PASS" : `staging integration: FAIL (${failed.length})`);
  process.exit(failed.length === 0 ? 0 : 1);
}
