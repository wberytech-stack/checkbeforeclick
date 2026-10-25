// Gate 006C - read-only integration checks of the deployed Azure STAGING app.
//
//   node scripts/azure-hosting/staging-integration.mjs
//   env: STG_APP_URL, STG_SUPABASE_URL, PROD_APP_URL, PROD_SUPABASE_URL (repository
//        variables; URLs only, no keys)
//
// Complements smoke.ts (healthz, signed-out redirects, API guards, callback, sign-out).
// Fails closed unless staging and production can be told apart, then checks:
//   I1-I2  the configured staging app and Supabase project are staging, not production
//   I3-I4  the DEPLOYED client build points at the staging Supabase project only and
//          carries only a public (anon / publishable) key, never a service-role key
//   I5-I6  Supabase Auth health and settings (public endpoints; no account, no session)
//   I7     Supabase database reachability as the anon role, zero rows requested
//   I8     Inngest serve endpoint is in cloud mode and rejects unsigned requests
// Every request is GET or HEAD, to the staging app or the staging Supabase host only,
// without following redirects, with a timeout and no retries. The public key is taken
// from the deployed bundle, held in memory and never printed; no body or header value
// other than the evidence fields below is logged. Plain JavaScript, no dependencies.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// docs/ENVIRONMENTS.md: staging and production Supabase projects.
export const STAGING_REF = "zgxmvpbvvakpsnzcymsf";
export const PRODUCTION_REF = "qnjqwmcsfpmpnvlnomat";
const STAGING_APP_HOST = /^ca-cbc-web-stg-cc-001\.[a-z0-9-]+\.canadacentral\.azurecontainerapps\.io$/;
const TIMEOUT_MS = 15000;
const MAX_ASSETS = 80;
const MAX_BYTES = 8 * 1024 * 1024;
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const PUBLISHABLE = /sb_publishable_[A-Za-z0-9_-]{10,}/g;
const SECRET_KEY = /sb_secret_[A-Za-z0-9_-]{10,}/;

const redact = (s) => String(s).replace(JWT, "<jwt>").replace(PUBLISHABLE, "<publishable-key>").replace(/sb_secret_[A-Za-z0-9_-]+/g, "<secret-key>");
const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };
const isHttpsOrigin = (u) => typeof u === "string" && /^https:\/\/[a-z0-9.-]+$/.test(u);

function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); } catch { return null; }
}

// One guarded request: GET/HEAD only, allow-listed hosts only, no redirects, timeout.
export function makeClient(fetchImpl, allowedHosts) {
  return async function request(url, { method = "GET", headers = {} } = {}) {
    if (method !== "GET" && method !== "HEAD") throw new Error(`refused ${method}: read-only verifier`);
    const host = hostOf(url);
    if (!allowedHosts.has(host) || !url.startsWith("https://")) throw new Error(`refused request to a non-staging host`);
    return fetchImpl(url, { method, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  };
}

export async function runChecks(env, fetchImpl = globalThis.fetch) {
  const results = [];
  const add = (id, name, status, evidence) => results.push({ id, name, status, evidence: redact(evidence) });
  const stg = (env.STG_APP_URL ?? "").replace(/\/$/, "");
  const sb = (env.STG_SUPABASE_URL ?? "").replace(/\/$/, "");
  const prodApp = (env.PROD_APP_URL ?? "").replace(/\/$/, "");
  const prodSb = (env.PROD_SUPABASE_URL ?? "").replace(/\/$/, "");

  // I1-I2: fail closed unless staging and production are distinguishable.
  const i1 = isHttpsOrigin(stg) && STAGING_APP_HOST.test(hostOf(stg)) && isHttpsOrigin(prodApp) && hostOf(prodApp) !== hostOf(stg);
  add("I1", "Staging app origin is the staging Container App and differs from production", i1 ? "VERIFIED" : "FAILED",
    i1 ? `staging ${hostOf(stg)}; production ${hostOf(prodApp)}` : "STG_APP_URL / PROD_APP_URL missing, not https, not the staging app, or equal");
  const i2 = sb === `https://${STAGING_REF}.supabase.co` && prodSb === `https://${PRODUCTION_REF}.supabase.co`;
  add("I2", "Configured Supabase project is staging; production project is distinct", i2 ? "VERIFIED" : "FAILED",
    i2 ? `staging ref ${STAGING_REF}; production ref ${PRODUCTION_REF}` : "STG_SUPABASE_URL / PROD_SUPABASE_URL are not the documented staging / production projects");
  if (!i1 || !i2) {
    for (const [id, name] of [["I3", "Deployed build targets staging Supabase only"], ["I4", "Deployed build carries only a public key"],
      ["I5", "Supabase Auth health"], ["I6", "Supabase Auth settings"], ["I7", "Supabase database as anon, zero rows"], ["I8", "Inngest rejects unsigned requests"]])
      add(id, name, "BLOCKED", "not run: staging and production could not be distinguished");
    return results;
  }
  const request = makeClient(fetchImpl, new Set([hostOf(stg), hostOf(sb)]));

  // I3-I4: the deployed client build (HTML of /login and its same-origin scripts).
  let bundle = "";
  let key = null;
  try {
    const page = await request(`${stg}/login`);
    const html = await page.text();
    if (page.status !== 200) throw new Error(`/login returned ${page.status}`);
    const srcs = [...new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]))]
      .map((s) => new URL(s, `${stg}/`).toString()).filter((u) => hostOf(u) === hostOf(stg)).slice(0, MAX_ASSETS);
    bundle = html;
    for (const u of srcs) {
      const r = await request(u);
      if (r.status !== 200) throw new Error(`a script asset returned ${r.status}`);
      bundle += "\n" + (await r.text());
      if (bundle.length > MAX_BYTES) throw new Error("bundle larger than the verifier limit");
    }
    const supabaseHosts = [...new Set([...bundle.matchAll(/https:\/\/([a-z0-9]{20})\.supabase\.co/g)].map((m) => m[1]))];
    const i3 = supabaseHosts.length === 1 && supabaseHosts[0] === STAGING_REF && !bundle.includes(PRODUCTION_REF);
    add("I3", "Deployed build targets staging Supabase only", i3 ? "VERIFIED" : "FAILED",
      i3 ? `${srcs.length} scripts; only ${STAGING_REF}.supabase.co; production ref absent`
         : `Supabase project refs in build: ${supabaseHosts.join(", ") || "none"}${bundle.includes(PRODUCTION_REF) ? "; production ref present" : ""}`);

    const jwts = [...new Set(bundle.match(JWT) ?? [])].map((t) => ({ t, c: jwtClaims(t) })).filter((x) => x.c && (x.c.role || x.c.ref));
    const publishable = [...new Set(bundle.match(PUBLISHABLE) ?? [])];
    const anon = jwts.filter((x) => x.c.role === "anon" && x.c.ref === STAGING_REF);
    const bad = jwts.filter((x) => !(x.c.role === "anon" && x.c.ref === STAGING_REF));
    const secret = SECRET_KEY.test(bundle);
    const keys = [...anon.map((x) => x.t), ...publishable];
    const i4 = !secret && bad.length === 0 && keys.length === 1;
    key = i4 ? keys[0] : null;
    add("I4", "Deployed build carries only a public key (anon or publishable), never a service-role key", i4 ? "VERIFIED" : "FAILED",
      i4 ? (anon.length ? `one anon JWT, ref ${STAGING_REF}` : "one publishable key (project binding checked by I5-I7)")
         : `public keys ${keys.length}; non-anon or non-staging JWTs ${bad.length} (roles: ${bad.map((x) => x.c.role ?? "?").join(",") || "none"}); secret key ${secret ? "PRESENT" : "absent"}`);
  } catch (e) {
    add("I3", "Deployed build targets staging Supabase only", "FAILED", e.message);
    add("I4", "Deployed build carries only a public key", "BLOCKED", "build could not be read");
  }

  // I5-I7: Supabase, as the public key from the deployed build only.
  if (!key) {
    for (const [id, name] of [["I5", "Supabase Auth health"], ["I6", "Supabase Auth settings"], ["I7", "Supabase database as anon, zero rows"]])
      add(id, name, "BLOCKED", "no single verified public key from the deployed build");
  } else {
    const h = { apikey: key, accept: "application/json" };
    try {
      const r = await request(`${sb}/auth/v1/health`, { headers: h });
      const j = await r.json().catch(() => null);
      const ok = r.status === 200 && j && typeof j === "object" && ("version" in j || "name" in j);
      add("I5", "Supabase Auth health (public endpoint)", ok ? "VERIFIED" : "FAILED", ok ? `200; ${j.name ?? "auth"} ${j.version ?? ""}`.trim() : `status ${r.status}`);
    } catch (e) { add("I5", "Supabase Auth health (public endpoint)", "FAILED", e.message); }
    try {
      const r = await request(`${sb}/auth/v1/settings`, { headers: h });
      const j = await r.json().catch(() => null);
      const ok = r.status === 200 && j && typeof j.external === "object" && j.external !== null;
      add("I6", "Supabase Auth settings (public endpoint; no account or session)", ok ? "VERIFIED" : "FAILED",
        ok ? `email provider ${j.external.email === true ? "enabled" : "disabled"}; signup ${j.disable_signup ? "disabled" : "enabled"}; email autoconfirm ${j.mailer_autoconfirm ? "on" : "off"}` : `status ${r.status}`);
    } catch (e) { add("I6", "Supabase Auth settings (public endpoint; no account or session)", "FAILED", e.message); }
    try {
      // Anon role, zero rows requested; only the visible-row COUNT is read. Row-level
      // security must leave anon with 0 visible scans, or anon must lack the grant.
      const r = await request(`${sb}/rest/v1/scans?select=id&limit=0`, { method: "HEAD", headers: { ...h, prefer: "count=exact" } });
      const total = (r.headers.get("content-range") ?? "").split("/")[1];
      const denied = r.status === 401 || r.status === 403;
      const zero = (r.status === 200 || r.status === 206) && total === "0";
      add("I7", "Supabase database reachable as anon; anon sees no scans (zero rows requested)", denied || zero ? "VERIFIED" : "FAILED",
        denied ? `status ${r.status}: anon has no access to scans` : zero ? "status 200; anon-visible scans 0" : `status ${r.status}; anon-visible scans ${total ?? "unknown"}`);
    } catch (e) { add("I7", "Supabase database reachable as anon; anon sees no scans (zero rows requested)", "FAILED", e.message); }
  }

  // I8: unsigned GET; cloud mode answers 401 and serves introspection only when signed.
  try {
    const r = await request(`${stg}/api/inngest`);
    const j = await r.json().catch(() => null);
    const ok = r.status === 401 && j && j.message === "Unauthorized";
    add("I8", "Inngest endpoint in cloud mode rejects unsigned requests (no sync, no event)", ok ? "VERIFIED" : "FAILED",
      ok ? "unsigned GET -> 401 Unauthorized" : `unsigned GET -> ${r.status}${r.status === 200 ? " (dev mode or unsigned introspection exposed)" : ""}`);
  } catch (e) { add("I8", "Inngest endpoint in cloud mode rejects unsigned requests (no sync, no event)", "FAILED", e.message); }
  return results;
}

// Checks this verifier cannot perform without credentials or cloud access.
export const NOT_COVERED = [
  ["U1", "Inngest branch environment (INNGEST_ENV) and serve origin, live", "UNVERIFIED", "needs a signed introspection (signing key); configured in main.parameters.json and checked by test-hosting-safety P6"],
  ["U2", "WEB_RISK_PROVIDER_ENABLED=false and no Web Risk key, live", "UNVERIFIED", "needs Azure read; enforced at deploy by the template check and the post-deploy config check in azure-deploy"],
  ["U3", "Supabase Auth redirect URL allow-list", "BLOCKED", "not exposed publicly; needs the Supabase dashboard or a management token"],
  ["U4", "Signed-in flows S4-S12 (session, scans, sign-out)", "BLOCKED", "authenticated tests need a founder-approved staging test account"],
];

export function formatMatrix(results) {
  const rows = [...results.map((r) => [r.id, r.name, r.status, r.evidence]), ...NOT_COVERED];
  return ["| ID | Check | Status | Evidence |", "| --- | --- | --- | --- |", ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, "/")).join(" | ")} |`)].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await runChecks(process.env);
  const matrix = formatMatrix(results);
  console.log(matrix);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Staging integration verification\n\n${matrix}\n`);
  const failed = results.filter((r) => r.status !== "VERIFIED");
  for (const f of failed) console.log(`::error::${f.id} ${f.status}: ${f.evidence}`);
  console.log(failed.length === 0 ? "staging integration: PASS" : `staging integration: FAIL (${failed.length})`);
  process.exit(failed.length === 0 ? 0 : 1);
}
