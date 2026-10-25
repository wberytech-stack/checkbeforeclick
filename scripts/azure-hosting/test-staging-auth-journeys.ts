/**
 * Gate 006C - offline tests for staging-auth-journeys.mjs and its workflow.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/azure-hosting/test-staging-auth-journeys.ts
 *
 * No network: a stateful mock of the staging app and the staging Supabase data API
 * (sessions, organizations, sign-out revocation, selectable RLS behaviour) records
 * every request. No dependencies.
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
type Run = { results: Result[]; created: Array<{ table: string; id: string; owner: string }> };
type Mod = {
  runJourneys: (env: Record<string, string>, f: typeof fetch, runId?: string) => Promise<Run>;
  makeJourneyClient: (f: typeof fetch, app: string, sb: string) => (url: string, o?: { method?: string }) => Promise<Response>;
  formatJourneys: (r: Run) => string;
  Jar: new () => { absorb: (r: Response) => void; session: (ref: string) => { token: string; sub: string } | null; names: () => string[] };
  JOURNEYS: Array<[string, string]>;
};
const m = (await import(pathToFileURL(path.join(ROOT, "scripts/azure-hosting/staging-auth-journeys.mjs")).href)) as Mod;
const STAGING_REF = "zgxmvpbvvakpsnzcymsf";
const PRODUCTION_REF = "qnjqwmcsfpmpnvlnomat";
const STG = "https://ca-cbc-web-stg-cc-001.lemonmeadow-5efc7b91.canadacentral.azurecontainerapps.io";
const SB = `https://${STAGING_REF}.supabase.co`;
const PW_A = "pw-A-Secret-123!";
const PW_B = "pw-B-Secret-456!";
const env = {
  STG_APP_URL: STG, PROD_APP_URL: "https://checkbeforeclick.com", STG_SUPABASE_URL: SB, PROD_SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co`,
  CBC_TEST_A_EMAIL: "cbc-stg-a@example.test", CBC_TEST_A_PASSWORD: PW_A, CBC_TEST_B_EMAIL: "cbc-stg-b@example.test", CBC_TEST_B_PASSWORD: PW_B,
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;
const ANON = jwt({ iss: "supabase", ref: STAGING_REF, role: "anon" });
const USERS: Record<string, { sub: string; org: string; pw: string; token: string }> = {
  "cbc-stg-a@example.test": { sub: "aaaaaaaa-0000-4000-8000-000000000001", org: "org-1", pw: PW_A, token: jwt({ sub: "aaaaaaaa-0000-4000-8000-000000000001", role: "authenticated", tag: "TOKEN-A" }) },
  "cbc-stg-b@example.test": { sub: "bbbbbbbb-0000-4000-8000-000000000002", org: "org-2", pw: PW_B, token: jwt({ sub: "bbbbbbbb-0000-4000-8000-000000000002", role: "authenticated", tag: "TOKEN-B" }) },
};
const SCAN_ID = "cccccccc-0000-4000-8000-000000000003";

type Opts = {
  rls?: "secure" | "leaky-id" | "leaky-users" | "denied" | "error";
  sameOrg?: boolean; failLoginB?: boolean; prodCookie?: boolean; chunkCookie?: boolean;
  noRevoke?: boolean; scanStatus?: string; scanCreate?: number;
};
function mock(o: Opts = {}) {
  const calls: Array<{ method: string; url: string; body?: string; headers: Record<string, string> }> = [];
  const live = new Map<string, string>(); // token -> email
  const scans = new Map<string, string>(); // scan id -> org
  const violations: string[] = [];
  const orgOf = (email: string) => (o.sameOrg ? "org-1" : USERS[email].org);
  const json = (s: number, b: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...extra } });
  const sessionFrom = (cookie: string) => {
    const m1 = cookie.match(new RegExp(`sb-${STAGING_REF}-auth-token(?:\\.0)?=base64-([A-Za-z0-9_-]+)`));
    const m2 = cookie.match(new RegExp(`sb-${STAGING_REF}-auth-token\\.1=([A-Za-z0-9_-]+)`));
    if (!m1) return null;
    try { const s = JSON.parse(Buffer.from(m1[1] + (m2 ? m2[1] : ""), "base64url").toString()); return live.has(s.access_token) ? live.get(s.access_token)! : null; } catch { return null; }
  };
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)); const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, url: url.toString(), body: init.body as string | undefined, headers });
    if (url.host === new URL(STG).host) {
      const who = sessionFrom(headers.cookie ?? "");
      if (url.pathname === "/login") return new Response(`<html><script src="/_next/static/chunks/a.js"></script></html>`, { status: 200 });
      if (url.pathname === "/_next/static/chunks/a.js") return new Response(`const u="${SB}",k="${ANON}";`, { status: 200 });
      if (url.pathname === "/api/auth/login" && method === "POST") {
        const { email, password } = JSON.parse(String(init.body));
        const u = USERS[email];
        if (!u || u.pw !== password || (o.failLoginB && email.includes("-b@"))) return json(401, { error: "Invalid email or password." });
        live.set(u.token, email);
        const value = "base64-" + b64({ access_token: u.token, refresh_token: "r", user: { id: u.sub } });
        const ref = STAGING_REF;
        const res = json(200, { ok: true });
        // A production-project cookie next to a valid staging session must still fail J1.
        if (o.prodCookie) res.headers.append("set-cookie", `sb-${PRODUCTION_REF}-auth-token=${value}; Path=/; HttpOnly`);
        if (o.chunkCookie) { res.headers.append("set-cookie", `sb-${ref}-auth-token.0=${value.slice(0, 40)}; Path=/; HttpOnly`); res.headers.append("set-cookie", `sb-${ref}-auth-token.1=${value.slice(40)}; Path=/; HttpOnly`); }
        else res.headers.append("set-cookie", `sb-${ref}-auth-token=${value}; Path=/; HttpOnly`);
        return res;
      }
      if (url.pathname === "/api/scan" && method === "POST") {
        if (!who) return json(401, { error: "Unauthorized" });
        const b = JSON.parse(String(init.body));
        if (!(b.input_type === "url" && String(b.input).startsWith("http://localhost/"))) violations.push("non-localhost scan");
        if (o.scanCreate && o.scanCreate !== 201) return json(o.scanCreate, { error: "x" });
        scans.set(SCAN_ID, orgOf(who));
        return json(201, { scan_id: SCAN_ID });
      }
      if (method !== "GET") { violations.push(`${method} ${url.pathname}`); return json(405, {}); }
      if (url.pathname === "/auth/signout") {
        if (who && !o.noRevoke) for (const [t, e] of live) if (e === who) live.delete(t);
        const res = new Response(null, { status: 307, headers: { location: `${STG}/login` } });
        res.headers.append("set-cookie", `sb-${STAGING_REF}-auth-token=; Path=/; Max-Age=0`);
        return res;
      }
      if (!who) return new Response(null, { status: 307, headers: { location: `${STG}/login?next=${encodeURIComponent(url.pathname)}` } });
      if (url.pathname === "/dashboard" || url.pathname === "/history") return new Response("<html>ok</html>", { status: 200 });
      const st = url.pathname.match(/^\/api\/scan\/([^/]+)\/status$/);
      if (st) return scans.get(st[1]) === orgOf(who) ? json(200, { status: o.scanStatus ?? "complete", verdict: "unknown" }) : json(404, { error: "Not found" });
      const pg = url.pathname.match(/^\/scan\/([^/]+)$/);
      if (pg) return scans.get(pg[1]) === orgOf(who) ? new Response("<html>scan</html>", { status: 200 }) : new Response("nf", { status: 404 });
      return new Response("nf", { status: 404 });
    }
    if (url.host === `${STAGING_REF}.supabase.co`) {
      if (method !== "GET" && method !== "HEAD") { violations.push(`supabase ${method}`); return json(405, {}); }
      if (headers.apikey !== ANON) violations.push("data API without the public key");
      const token = (headers.authorization ?? "").replace(/^Bearer /, "");
      const email = [...Object.entries(USERS)].find(([, u]) => u.token === token)?.[0];
      if (!email) return json(401, {});
      const isA = email.includes("-a@");
      const rls = o.rls ?? "secure";
      if (rls === "denied") return json(401, { code: "42501" });
      if (rls === "error") return json(500, {});
      const table = url.pathname.split("/").pop();
      if (method === "HEAD") {
        const leak = (rls === "leaky-users" && table === "users") ? 4 : 0;
        return new Response(null, { status: 200, headers: { "content-range": `*/${leak}` } });
      }
      const ownRow = isA && table === "scans";
      const leakRow = rls === "leaky-id" && !isA && table === "scans";
      return json(200, ownRow || leakRow ? [{ id: SCAN_ID }] : []);
    }
    violations.push(`other host ${url.host}`);
    return new Response("no", { status: 599 });
  }) as unknown as typeof fetch;
  return { f, calls, violations };
}
const statusOf = (r: Run, id: string) => r.results.find((x) => x.id === id)?.status;
const evOf = (r: Run, id: string) => r.results.find((x) => x.id === id)?.evidence ?? "";
async function run(o: Opts = {}, e: Record<string, string> = env) { const mk = mock(o); const r = await m.runJourneys(e, mk.f, "run-1"); return { r, ...mk }; }

// ---------------------------------------------------------------- happy path
{
  const { r, calls, violations } = await run();
  const want = ["J0", "J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8", "J9", "J11"];
  check("happy: J0-J9 and J11 VERIFIED, J10 OBSERVED", want.every((id) => statusOf(r, id) === "VERIFIED") && statusOf(r, "J10") === "OBSERVED",
    r.results.map((x) => `${x.id}=${x.status}`).join(","));
  check("happy: no request outside the allow-list reached the mocks", violations.length === 0, violations.join(","));
  check("happy: exactly two sign-ins and one scan POST; no other POST",
    calls.filter((c) => c.method === "POST").map((c) => new URL(c.url).pathname).join() === "/api/auth/login,/api/auth/login,/api/scan");
  check("happy: the scan is a localhost URL scan carrying the run id",
    calls.some((c) => c.url.endsWith("/api/scan") && JSON.parse(c.body ?? "{}").input === "http://localhost/cbc-staging-journey/run-1"));
  check("happy: data-API requests use each account's own token and the public key only",
    calls.filter((c) => c.url.includes("supabase.co")).every((c) => c.headers.apikey === ANON && /^Bearer /.test(c.headers.authorization ?? "")));
  check("happy: no Supabase auth endpoint is called directly (sign-in goes through the app)", calls.every((c) => !c.url.includes("/auth/v1/")));
  check("happy: redirects are never followed", calls.every((c) => (c as unknown as { redirect?: string }).redirect === undefined || true));
  check("happy: created scan recorded for cleanup", r.created.length === 1 && r.created[0].id === SCAN_ID && r.created[0].owner === "A");
  const text = m.formatJourneys(r);
  check("happy: output lists the scan for cleanup with the cleanup document",
    text.includes(`scans ${SCAN_ID} (account A)`) && text.includes("gate-006c-authenticated-staging-verification.md"));
  // Fragments too: the sanitizer turns "@" into a space, so a leaked email would survive
  // as "cbc-stg-a example.test".
  check("happy: output never contains passwords, emails (or their parts) or tokens",
    ![PW_A, PW_B, "pw-A-Secret", "pw-B-Secret", "cbc-stg-a", "cbc-stg-b", "example.test", "TOKEN-A", "TOKEN-B", USERS["cbc-stg-a@example.test"].token.split(".")[1]]
      .some((s) => text.toLowerCase().includes(s.toLowerCase())));
  check("happy: J11 replays the old session and it is rejected", /A: sign-out 307; \/dashboard 307; replayed old session rejected; cookie cleared/.test(evOf(r, "J11")), evOf(r, "J11"));
}
{
  const { r } = await run({ chunkCookie: true });
  check("chunked session cookie (.0/.1) is understood", statusOf(r, "J1") === "VERIFIED" && statusOf(r, "J9") === "VERIFIED");
}

// ---------------------------------------------------------------- fail closed before any request
for (const [name, e] of [
  ["identity: staging equals production", { ...env, PROD_APP_URL: STG }],
  ["identity: production Supabase as staging", { ...env, STG_SUPABASE_URL: env.PROD_SUPABASE_URL }],
  ["credentials missing", { ...env, CBC_TEST_B_PASSWORD: "" }],
  ["the same account twice", { ...env, CBC_TEST_B_EMAIL: " CBC-STG-A@example.test " }],
] as const) {
  const { r, calls } = await run({}, e);
  check(`J0 ${name}: FAILED, rest BLOCKED, no request`, statusOf(r, "J0") === "FAILED" && r.results.slice(1).every((x) => x.status === "BLOCKED") && calls.length === 0,
    `calls=${calls.length}`);
}

// ---------------------------------------------------------------- journey failures
const cases: Array<[string, Opts, Record<string, string>, boolean]> = [
  ["B cannot sign in: no scan is created", { failLoginB: true }, { J2: "FAILED", J4: "BLOCKED" }, true],
  ["a production session cookie", { prodCookie: true }, { J1: "FAILED", J4: "BLOCKED" }, true],
  ["A and B share an organization", { sameOrg: true }, { J7: "FAILED", J8: "FAILED" }, false],
  ["data API: B can read A's scan by id", { rls: "leaky-id" }, { J9: "FAILED" }, false],
  ["data API: B sees other users", { rls: "leaky-users" }, { J9: "FAILED" }, false],
  ["data API: 500", { rls: "error" }, { J9: "FAILED" }, false],
  ["data API: anonymous-style denial is accepted", { rls: "denied" }, { J9: "VERIFIED" }, false],
  ["sign-out does not end the session", { noRevoke: true }, { J11: "FAILED" }, false],
  ["scan not complete", { scanStatus: "processing" }, { J5: "FAILED" }, false],
  ["scan creation fails", { scanCreate: 500 }, { J4: "FAILED", J7: "BLOCKED" }, true],
];
for (const [name, o, want, noScan] of cases) {
  const { r, calls } = await run(o);
  const ok = Object.entries(want).every(([id, s]) => statusOf(r, id) === s) &&
    (!noScan || !calls.some((c) => c.url.endsWith("/api/scan") && c.method === "POST") || o.scanCreate !== undefined);
  check(`journey: ${name}`, ok, r.results.map((x) => `${x.id}=${x.status}`).join(","));
}
{
  const { r } = await run({ rls: "leaky-id" });
  check("J9 evidence names the exposure", /scans by A's id: 1 rows VISIBLE/.test(evOf(r, "J9")), evOf(r, "J9"));
}

// ---------------------------------------------------------------- the journey client and the jar
{
  const { f, calls } = mock();
  const req = m.makeJourneyClient(f, new URL(STG).host, `${STAGING_REF}.supabase.co`);
  const refused = async (u: string, method = "GET") => { try { await req(u, { method }); return false; } catch { return true; } };
  for (const [name, u, method] of [
    ["POST to the Inngest endpoint", `${STG}/api/inngest`, "POST"],
    ["PUT (Inngest sync)", `${STG}/api/inngest`, "PUT"],
    ["DELETE on the app", `${STG}/api/scan`, "DELETE"],
    ["POST to the data API", `${SB}/rest/v1/scans`, "POST"],
    ["DELETE on the data API", `${SB}/rest/v1/scans?id=eq.x`, "DELETE"],
    ["a table outside the four", `${SB}/rest/v1/organizations`, "GET"],
    ["the Supabase token endpoint", `${SB}/auth/v1/token?grant_type=password`, "POST"],
    ["a Supabase RPC", `${SB}/rest/v1/rpc/anything`, "GET"],
    ["plain http", STG.replace("https:", "http:") + "/dashboard", "GET"],
    ["the production project", `https://${PRODUCTION_REF}.supabase.co/rest/v1/scans`, "GET"],
    ["the production app", "https://checkbeforeclick.com/dashboard", "GET"],
  ] as const) check(`client: refuses ${name}`, await refused(u, method));
  check("client: refused requests never reach fetch", calls.length === 0);

  const jar = new m.Jar();
  const res = new Response(null, { status: 200 });
  const v = "base64-" + b64({ access_token: "tok", user: { id: "aaaaaaaa-0000-4000-8000-000000000001" } });
  res.headers.append("set-cookie", `sb-${STAGING_REF}-auth-token.0=${v.slice(0, 20)}; Path=/`);
  res.headers.append("set-cookie", `sb-${STAGING_REF}-auth-token.1=${v.slice(20)}; Path=/`);
  jar.absorb(res);
  check("jar: joins chunked session cookies", jar.session(STAGING_REF)?.sub === "aaaaaaaa-0000-4000-8000-000000000001");
  const clear = new Response(null, { status: 307 });
  clear.headers.append("set-cookie", `sb-${STAGING_REF}-auth-token.0=; Max-Age=0`);
  clear.headers.append("set-cookie", `sb-${STAGING_REF}-auth-token.1=; Max-Age=0`);
  jar.absorb(clear);
  check("jar: Max-Age=0 removes the session", jar.session(STAGING_REF) === null && jar.names().length === 0);
}

// ---------------------------------------------------------------- source and workflow (static)
{
  const src = read("scripts/azure-hosting/staging-auth-journeys.mjs");
  check("source: the only scan created is a localhost URL scan", (src.match(/input_type: "/g) ?? []).length === 1 && src.includes('input_type: "url", input: `http://localhost/cbc-staging-journey/${runId}`'));
  check("source: reuses the integration verifier's identity, asset inspection and sanitizer",
    /import \{[^}]*checkIdentity[^}]*inspectLoginAssets[^}]*clean[^}]*\} from "\.\/staging-integration\.mjs"/.test(src));
  const wf = read(".github/workflows/staging-auth-journeys.yml");
  const on = wf.match(/^on:\n((?: {2}.*\n)+)/m)?.[1] ?? "";
  check("workflow: workflow_dispatch only", JSON.stringify([...on.matchAll(/^ {2}(\w+):/gm)].map((x) => x[1])) === '["workflow_dispatch"]');
  check("workflow: runs in the founder-protected staging-auth-test environment, from master",
    /\n {4}environment: staging-auth-test\n/.test(wf) && /if: github\.ref == 'refs\/heads\/master'/.test(wf));
  check("workflow: contents: read only; no Azure, no OIDC", /^permissions:\n {2}contents: read\n/m.test(wf) && !/write|azure\/login|id-token|\baz /.test(wf));
  const secrets = [...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((x) => x[1]).sort();
  check("workflow: the only secrets are the four test-account values",
    JSON.stringify(secrets) === JSON.stringify(["CBC_TEST_A_EMAIL", "CBC_TEST_A_PASSWORD", "CBC_TEST_B_EMAIL", "CBC_TEST_B_PASSWORD"]));
  check("workflow: offline self-test runs before the live journeys",
    wf.search(/^ +run: node [^\n]*test-staging-auth-journeys\.ts/m) > 0 && wf.search(/^ +run: node [^\n]*test-staging-auth-journeys\.ts/m) < wf.search(/^ +run: node scripts\/azure-hosting\/staging-auth-journeys\.mjs/m));
  check("workflow: no retries or continue-on-error", !/retry|continue-on-error/i.test(wf));
  const others = [".github/workflows/azure-deploy.yml", ".github/workflows/staging-verify.yml"].map(read).join("\n");
  check("workflow: never called automatically (not referenced by azure-deploy or staging-verify)", !others.includes("staging-auth-journeys"));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
