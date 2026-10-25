/**
 * Gate 006C - offline tests for staging-integration.mjs and the staging-verify workflow.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/azure-hosting/test-staging-integration.ts
 *
 * No network: every request goes to a mock fetch that records it. No dependencies, so
 * the staging-verify workflow can run it before the live checks.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n?/g, "\n");
let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passes++; console.log(`ok   ${name}`); } else { failures++; console.log(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

type Result = { id: string; status: string; evidence: string };
type Mod = {
  runChecks: (env: Record<string, string>, f: typeof fetch) => Promise<Result[]>;
  makeClient: (f: typeof fetch, hosts: Set<string>) => (url: string, o?: { method?: string }) => Promise<Response>;
  formatMatrix: (r: Result[]) => string;
  STAGING_REF: string;
  PRODUCTION_REF: string;
};
const m = (await import(pathToFileURL(path.join(ROOT, "scripts/azure-hosting/staging-integration.mjs")).href)) as Mod;

const STG = "https://ca-cbc-web-stg-cc-001.lemonmeadow-5efc7b91.canadacentral.azurecontainerapps.io";
const env = {
  STG_APP_URL: STG, PROD_APP_URL: "https://checkbeforeclick.com",
  STG_SUPABASE_URL: `https://${m.STAGING_REF}.supabase.co`, PROD_SUPABASE_URL: `https://${m.PRODUCTION_REF}.supabase.co`,
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;
const ANON = jwt({ iss: "supabase", ref: m.STAGING_REF, role: "anon" });

type Scenario = {
  html?: string; chunk?: string; health?: [number, unknown]; settings?: [number, unknown];
  scans?: [number, string | null]; inngest?: [number, unknown];
};
const goodChunk = () => `const u="https://${m.STAGING_REF}.supabase.co",k="${ANON}";`;
function makeFetch(sc: Scenario) {
  const calls: Array<{ url: string; method: string; redirect?: string; headers: Record<string, string> }> = [];
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", redirect: init.redirect, headers: (init.headers ?? {}) as Record<string, string> });
    const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (url === `${STG}/login`) return new Response(sc.html ?? `<html><script src="/_next/static/chunks/a.js"></script><script src="/_next/static/chunks/b.js"></script></html>`, { status: 200 });
    if (url === `${STG}/_next/static/chunks/a.js`) return new Response(sc.chunk ?? goodChunk(), { status: 200 });
    if (url === `${STG}/_next/static/chunks/b.js`) return new Response("console.log(1)", { status: 200 });
    if (url.endsWith("/auth/v1/health")) return json(...(sc.health ?? [200, { name: "GoTrue", version: "v2.170.0" }]));
    if (url.endsWith("/auth/v1/settings")) return json(...(sc.settings ?? [200, { external: { email: true }, disable_signup: false, mailer_autoconfirm: false }]));
    if (url.includes("/rest/v1/scans")) { const [s, cr] = sc.scans ?? [200, "*/0"]; return new Response(null, { status: s, headers: cr ? { "content-range": cr } : {} }); }
    if (url === `${STG}/api/inngest`) return json(...(sc.inngest ?? [401, { message: "Unauthorized" }]));
    return new Response("not mocked", { status: 599 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const statusOf = (r: Result[], id: string) => r.find((x) => x.id === id)?.status;
async function run(sc: Scenario, e: Record<string, string> = env) { const { f, calls } = makeFetch(sc); const r = await m.runChecks(e, f); return { r, calls }; }

// ---------------------------------------------------------------- happy path
{
  const { r, calls } = await run({});
  check("good staging: I1-I8 all VERIFIED", r.length === 8 && r.every((x) => x.status === "VERIFIED"), r.map((x) => `${x.id}=${x.status}`).join(","));
  check("good staging: only GET/HEAD requests", calls.every((c) => c.method === "GET" || c.method === "HEAD"));
  check("good staging: only the staging app and staging Supabase hosts",
    calls.every((c) => [new URL(STG).host, `${m.STAGING_REF}.supabase.co`].includes(new URL(c.url).host)));
  check("good staging: redirects are never followed", calls.every((c) => c.redirect === "manual"));
  check("good staging: no POST/PUT to Inngest (no sync, no event)", calls.filter((c) => c.url.endsWith("/api/inngest")).every((c) => c.method === "GET"));
  check("good staging: database check is a HEAD with zero rows requested",
    calls.some((c) => c.method === "HEAD" && c.url.endsWith("/rest/v1/scans?select=id&limit=0") && c.headers.prefer === "count=exact"));
  check("good staging: Supabase calls use the public key from the build", calls.filter((c) => c.url.includes("supabase.co")).every((c) => c.headers.apikey === ANON));
  const matrix = m.formatMatrix(r);
  check("evidence matrix: never contains the key", !matrix.includes(ANON) && !matrix.includes(ANON.split(".")[1]));
  check("evidence matrix: lists the uncovered checks as UNVERIFIED / BLOCKED",
    /\| U1 \|[^\n]*\| UNVERIFIED \|/.test(matrix) && /\| U2 \|[^\n]*\| UNVERIFIED \|/.test(matrix) && /\| U3 \|[^\n]*\| BLOCKED \|/.test(matrix) && /\| U4 \|[^\n]*\| BLOCKED \|/.test(matrix));
}

// ---------------------------------------------------------------- fail closed on identity
for (const [name, e] of [
  ["staging app equals production app", { ...env, PROD_APP_URL: STG }],
  ["staging app is not the staging Container App", { ...env, STG_APP_URL: "https://checkbeforeclick.com" }],
  ["staging app URL missing", { ...env, STG_APP_URL: "" }],
  ["staging Supabase is the production project", { ...env, STG_SUPABASE_URL: env.PROD_SUPABASE_URL }],
  ["production Supabase URL missing", { ...env, PROD_SUPABASE_URL: "" }],
] as const) {
  const { r, calls } = await run({}, e);
  check(`identity: ${name} -> FAILED, rest BLOCKED, no request sent`,
    r.some((x) => x.status === "FAILED") && r.filter((x) => !["I1", "I2"].includes(x.id)).every((x) => x.status === "BLOCKED") && calls.length === 0,
    `calls=${calls.length} ${r.map((x) => `${x.id}=${x.status}`).join(",")}`);
}

// ---------------------------------------------------------------- deployed build
const cases: Array<[string, Scenario, Record<string, string>]> = [
  ["production ref anywhere in the build", { chunk: goodChunk() + `/*${m.PRODUCTION_REF}*/` }, { I3: "FAILED" }],
  ["two Supabase projects in the build", { chunk: goodChunk() + `const v="https://abcdefghijklmnopqrst.supabase.co";` }, { I3: "FAILED" }],
  ["no Supabase URL in the build", { chunk: `const k="${ANON}";` }, { I3: "FAILED" }],
  ["service-role JWT in the build", { chunk: goodChunk() + `const s="${jwt({ iss: "supabase", ref: m.STAGING_REF, role: "service_role" })}";` }, { I4: "FAILED", I5: "BLOCKED", I7: "BLOCKED" }],
  ["anon JWT of the production project", { chunk: `const u="https://${m.STAGING_REF}.supabase.co",k="${jwt({ iss: "supabase", ref: m.PRODUCTION_REF, role: "anon" })}";` }, { I4: "FAILED" }],
  ["a Supabase secret key in the build", { chunk: goodChunk() + `const x="sb_secret_abcdefghijklmnop";` }, { I4: "FAILED" }],
  ["no public key in the build", { chunk: `const u="https://${m.STAGING_REF}.supabase.co";` }, { I4: "FAILED", I6: "BLOCKED" }],
  ["/login not 200", { html: "" }, { I3: "FAILED" }],
];
for (const [name, sc, want] of cases) {
  const { r, calls } = await run(sc);
  const ok = Object.entries(want).every(([id, s]) => statusOf(r, id) === s);
  const noSupabaseIfBlocked = want.I5 !== "BLOCKED" || calls.every((c) => !c.url.includes("supabase.co"));
  check(`build: ${name}`, ok && noSupabaseIfBlocked, r.map((x) => `${x.id}=${x.status}`).join(","));
}
{
  const { r } = await run({ chunk: `const u="https://${m.STAGING_REF}.supabase.co",k="sb_publishable_abcdefghijklmnopqrst";` });
  check("build: a single publishable key is accepted", statusOf(r, "I4") === "VERIFIED" && statusOf(r, "I7") === "VERIFIED");
}
{
  const { calls } = await run({ html: `<html><script src="https://cdn.example.test/x.js"></script><script src="/_next/static/chunks/a.js"></script></html>` });
  check("build: cross-origin scripts are never fetched", calls.every((c) => !c.url.includes("example.test")));
}

// ---------------------------------------------------------------- Supabase and Inngest
for (const [name, sc, id, want] of [
  ["Auth health 503", { health: [503, {}] }, "I5", "FAILED"],
  ["Auth settings not JSON", { settings: [200, "oops"] }, "I6", "FAILED"],
  ["anon sees 3 scans (row-level security gap)", { scans: [200, "*/3"] }, "I7", "FAILED"],
  ["anon denied on scans (no grant) is accepted", { scans: [401, null] }, "I7", "VERIFIED"],
  ["scans table missing", { scans: [404, null] }, "I7", "FAILED"],
  ["count header missing", { scans: [200, null] }, "I7", "FAILED"],
  ["Inngest answers unsigned GET with 200 (dev mode / exposed introspection)", { inngest: [200, { function_count: 1, mode: "dev" }] }, "I8", "FAILED"],
  ["Inngest 404", { inngest: [404, {}] }, "I8", "FAILED"],
] as Array<[string, Scenario, string, string]>) {
  const { r } = await run(sc);
  check(`service: ${name} -> ${want}`, statusOf(r, id) === want, `${id}=${statusOf(r, id)}`);
}

// ---------------------------------------------------------------- the guarded client itself
{
  const { f, calls } = makeFetch({});
  const req = m.makeClient(f, new Set([new URL(STG).host]));
  const refused = async (u: string, o?: { method?: string }) => { try { await req(u, o); return false; } catch { return true; } };
  check("client: refuses POST", await refused(`${STG}/api/inngest`, { method: "POST" }));
  check("client: refuses PUT (Inngest sync)", await refused(`${STG}/api/inngest`, { method: "PUT" }));
  check("client: refuses a non-allow-listed host", await refused(`https://${m.PRODUCTION_REF}.supabase.co/auth/v1/health`));
  check("client: refuses plain http", await refused(STG.replace("https:", "http:") + "/login"));
  check("client: refused requests never reach fetch", calls.length === 0);
}

// ---------------------------------------------------------------- workflows (static)
{
  const wf = read(".github/workflows/staging-verify.yml");
  const on = wf.match(/^on:\n((?: {2}.*\n)+)/m)?.[1] ?? "";
  check("staging-verify: triggers are only workflow_dispatch and workflow_call",
    JSON.stringify([...on.matchAll(/^ {2}(\w+):/gm)].map((x) => x[1]).sort()) === JSON.stringify(["workflow_call", "workflow_dispatch"]));
  check("staging-verify: top-level and job permissions are contents: read only",
    /^permissions:\n {2}contents: read\n/m.test(wf) && !/write/.test(wf));
  check("staging-verify: no secrets, no Azure sign-in, no OIDC token", !/secrets\.|azure\/login|id-token|az /.test(wf));
  check("staging-verify: runs only from master", /if: github\.ref == 'refs\/heads\/master'/.test(wf));
  check("staging-verify: passes URLs only (no key variables)",
    !/ANON_KEY|SERVICE_ROLE|SIGNING_KEY|EVENT_KEY/.test(wf) &&
    ["CBC_STG_NEXT_PUBLIC_APP_URL", "CBC_STG_NEXT_PUBLIC_SUPABASE_URL", "CBC_PROD_NEXT_PUBLIC_APP_URL", "CBC_PROD_NEXT_PUBLIC_SUPABASE_URL"].every((v) => wf.includes(`vars.${v}`)));
  check("staging-verify: offline self-test runs before the live checks",
    (() => {
      // Positions of the commands that run each script (comments mention the names too).
      const at = ["scripts/azure-hosting/test-staging-integration.ts", "scripts/azure-hosting/smoke.ts", "scripts/azure-hosting/staging-integration.mjs"]
        .map((p) => wf.search(new RegExp(`^ +(run: )?node [^\\n]*${p.replace(/[./]/g, "\\$&")}`, "m")));
      return at.every((i, k) => i > 0 && (k === 0 || i > at[k - 1]));
    })());
  check("staging-verify: pins Node 24.14.0 and does not install dependencies", wf.includes('node-version: "24.14.0"') && !/npm (ci|install)/.test(wf));
  check("staging-verify: no retries or continue-on-error", !/retry|continue-on-error/i.test(wf));
  const dep = read(".github/workflows/azure-deploy.yml");
  const job = dep.match(/\n {2}verify-staging:\n((?: {4}.*\n?)+)/)?.[1] ?? "";
  check("azure-deploy: verify-staging runs after the staging job via the reusable workflow, staging only",
    /needs: staging/.test(job) && /uses: \.\/\.github\/workflows\/staging-verify\.yml/.test(job) &&
    job.includes("inputs.environment == 'staging'") && job.includes("vars.CBC_AZURE_DEPLOY_ENABLED == 'enabled'") && !/environment:/.test(job));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
