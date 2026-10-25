/**
 * Gate 006C - offline tests for staging-auth-journeys.mjs, its workflow and the
 * founder cleanup SQL.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/azure-hosting/test-staging-auth-journeys.ts
 *
 * No network: a stateful mock of the staging app and the staging Supabase data API
 * (sessions, organizations, sign-out revocation, selectable RLS behaviour) records
 * every request. No dependencies.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
type Created = { table: string; id: string | null; owner: string };
type Run = { results: Result[]; created: Created[]; runId: string };
type Mod = {
  runJourneys: (env: Record<string, string>, f: typeof fetch, runId?: string, created?: Created[]) => Promise<Run>;
  makeJourneyClient: (f: typeof fetch, app: string, sb: string) => (url: string, o?: { method?: string }) => Promise<Response>;
  formatJourneys: (r: Run) => string;
  Jar: new () => { absorb: (r: Response) => void; session: (ref: string) => { token: string; sub: string } | null; names: () => string[] };
  PASSING: Set<string>;
};
const m = (await import(pathToFileURL(path.join(ROOT, "scripts/azure-hosting/staging-auth-journeys.mjs")).href)) as Mod;
const STAGING_REF = "zgxmvpbvvakpsnzcymsf";
const PRODUCTION_REF = "qnjqwmcsfpmpnvlnomat";
const STG = "https://ca-cbc-web-stg-cc-001.lemonmeadow-5efc7b91.canadacentral.azurecontainerapps.io";
const SB = `https://${STAGING_REF}.supabase.co`;
const PW_A = "pw-A-Secret-123!";
const PW_B = "pw-B-Secret-456!";
const ORG_1 = "11111111-1111-4111-8111-111111111111";
const ORG_2 = "22222222-2222-4222-8222-222222222222";
const RUN = "dddddddd-0000-4000-8000-000000000004";
const env = {
  STG_APP_URL: STG, PROD_APP_URL: "https://checkbeforeclick.com", STG_SUPABASE_URL: SB, PROD_SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co`,
  CBC_TEST_A_EMAIL: "cbc-stg-a@example.test", CBC_TEST_A_PASSWORD: PW_A, CBC_TEST_B_EMAIL: "cbc-stg-b@example.test", CBC_TEST_B_PASSWORD: PW_B,
  CBC_TEST_A_ORG_ID: ORG_1, CBC_TEST_B_ORG_ID: ORG_2,
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;
const ANON = jwt({ iss: "supabase", ref: STAGING_REF, role: "anon" });
const USERS: Record<string, { sub: string; org: string; pw: string; token: string }> = {
  "cbc-stg-a@example.test": { sub: "aaaaaaaa-0000-4000-8000-000000000001", org: ORG_1, pw: PW_A, token: jwt({ sub: "aaaaaaaa-0000-4000-8000-000000000001", role: "authenticated", tag: "TOKEN-A" }) },
  "cbc-stg-b@example.test": { sub: "bbbbbbbb-0000-4000-8000-000000000002", org: ORG_2, pw: PW_B, token: jwt({ sub: "bbbbbbbb-0000-4000-8000-000000000002", role: "authenticated", tag: "TOKEN-B" }) },
};
const SCAN_ID = "cccccccc-0000-4000-8000-000000000003";

type Opts = {
  rls?: "secure" | "leaky-id" | "leaky-users" | "denied" | "error";
  ownUsersRow?: "readable" | "hidden";
  sameOrg?: boolean; failLoginB?: boolean; prodCookie?: boolean; chunkCookie?: boolean; dashFailB?: boolean;
  noRevoke?: boolean; scanStatus?: string; scanCreate?: number; scanCreateWithId?: boolean;
};
function mock(o: Opts = {}) {
  const calls: Array<{ method: string; url: string; body?: string; headers: Record<string, string> }> = [];
  const live = new Map<string, string>(); // token -> email
  const scans = new Map<string, string>(); // scan id -> org
  const violations: string[] = [];
  const orgOf = (email: string) => (o.sameOrg ? ORG_1 : USERS[email].org);
  const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
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
        const res = json(200, { ok: true });
        if (o.prodCookie) res.headers.append("set-cookie", `sb-${PRODUCTION_REF}-auth-token=${value}; Path=/; HttpOnly`);
        if (o.chunkCookie) { res.headers.append("set-cookie", `sb-${STAGING_REF}-auth-token.0=${value.slice(0, 40)}; Path=/; HttpOnly`); res.headers.append("set-cookie", `sb-${STAGING_REF}-auth-token.1=${value.slice(40)}; Path=/; HttpOnly`); }
        else res.headers.append("set-cookie", `sb-${STAGING_REF}-auth-token=${value}; Path=/; HttpOnly`);
        return res;
      }
      if (url.pathname === "/api/scan" && method === "POST") {
        if (!who) return json(401, { error: "Unauthorized" });
        const b = JSON.parse(String(init.body));
        if (!(b.input_type === "url" && String(b.input).startsWith("http://localhost/"))) violations.push("non-localhost scan");
        if (o.scanCreate && o.scanCreate !== 201) {
          if (o.scanCreateWithId) { scans.set(SCAN_ID, orgOf(who)); return json(o.scanCreate, { error: "x", scan_id: SCAN_ID }); }
          return json(o.scanCreate, { error: "x" });
        }
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
      if (url.pathname === "/dashboard") return o.dashFailB && who.includes("-b@") ? new Response("err", { status: 500 }) : new Response("<html>ok</html>", { status: 200 });
      if (url.pathname === "/history") return new Response("<html>ok</html>", { status: 200 });
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
      const email = Object.entries(USERS).find(([, u]) => u.token === token)?.[0];
      if (!email) return json(401, {});
      const table = url.pathname.split("/").pop();
      // Own users row (J4): readable or hidden independently of the cross-tenant RLS mode.
      const own = url.searchParams.get("id") === `eq.${USERS[email].sub}` && table === "users" && method === "GET";
      if (own) return json(200, (o.ownUsersRow ?? "readable") === "readable" ? [{ organization_id: orgOf(email) }] : []);
      const isA = email.includes("-a@");
      const rls = o.rls ?? "secure";
      if (rls === "denied") return json(401, { code: "42501" });
      if (rls === "error") return json(500, {});
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
const scanPosts = (calls: Array<{ method: string; url: string }>) => calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/scan")).length;
async function run(o: Opts = {}, e: Record<string, string> = env) { const mk = mock(o); const sink: Created[] = []; const r = await m.runJourneys(e, mk.f, RUN, sink); return { r, sink, ...mk }; }

// ---------------------------------------------------------------- happy path
{
  const { r, calls, violations, sink } = await run();
  const want = ["J0", "J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8", "J9", "J10", "J12"];
  check("happy: J0-J10 and J12 VERIFIED (J4 observed), J11 OBSERVED", want.every((id) => statusOf(r, id) === "VERIFIED") && statusOf(r, "J11") === "OBSERVED",
    r.results.map((x) => `${x.id}=${x.status}`).join(","));
  check("happy: no request outside the allow-list reached the mocks", violations.length === 0, violations.join(","));
  check("happy: exactly two sign-ins and one scan POST; no other POST",
    calls.filter((c) => c.method === "POST").map((c) => new URL(c.url).pathname).join() === "/api/auth/login,/api/auth/login,/api/scan");
  const firstScan = calls.findIndex((c) => c.method === "POST" && c.url.endsWith("/api/scan"));
  const dashB = calls.findIndex((c) => c.url.endsWith("/dashboard") && (c.headers.cookie ?? "").length > 0 && calls.indexOf(c) > 1);
  const ownRows = calls.filter((c) => c.url.includes("/rest/v1/users?select=organization_id&id=eq."));
  check("happy: both dashboards and both own-organization reads happen before the scan",
    ownRows.length === 2 && calls.indexOf(ownRows[1]) < firstScan &&
    calls.filter((c, i) => i < firstScan && c.url.endsWith("/dashboard")).length === 2 && dashB < firstScan);
  check("happy: the scan is a localhost URL scan carrying the run id",
    calls.some((c) => c.url.endsWith("/api/scan") && JSON.parse(c.body ?? "{}").input === `http://localhost/cbc-staging-journey/${RUN}`));
  check("happy: data-API requests use each account's own token and the public key only",
    calls.filter((c) => c.url.includes("supabase.co")).every((c) => c.headers.apikey === ANON && /^Bearer /.test(c.headers.authorization ?? "")));
  check("happy: no Supabase auth endpoint is called directly (sign-in goes through the app)", calls.every((c) => !c.url.includes("/auth/v1/")));
  check("happy: created scan recorded in the caller's sink for cleanup", sink.length === 1 && sink[0].id === SCAN_ID && r.created === sink);
  const text = m.formatJourneys(r);
  check("happy: output lists the scan, the run id and the cleanup SQL",
    text.includes(`scans ${SCAN_ID} (account A), run ${RUN}`) && text.includes("docs/gates/sql/gate-006c-staging-test-scan-cleanup.sql"));
  // Fragments too: the sanitizer turns "@" into a space.
  check("happy: output never contains passwords, emails (or their parts), tokens or organization ids",
    ![PW_A, PW_B, "pw-A-Secret", "pw-B-Secret", "cbc-stg-a", "cbc-stg-b", "example.test", "TOKEN-A", "TOKEN-B", ORG_1, ORG_2, USERS["cbc-stg-a@example.test"].token.split(".")[1]]
      .some((s) => text.toLowerCase().includes(s.toLowerCase())));
  check("happy: J4 reports observation, not just attestation", /observed from each account's own users row; distinct and equal to founder evidence/.test(evOf(r, "J4")), evOf(r, "J4"));
  check("happy: J12 replays the old session and it is rejected", /A: sign-out 307; \/dashboard 307; replayed old session rejected; cookie cleared/.test(evOf(r, "J12")), evOf(r, "J12"));
}
{
  const { r } = await run({ chunkCookie: true });
  check("chunked session cookie (.0/.1) is understood", statusOf(r, "J1") === "VERIFIED" && statusOf(r, "J10") === "VERIFIED");
}

// ---------------------------------------------------------------- J0: fail closed before any request
for (const [name, e] of [
  ["identity: staging equals production", { ...env, PROD_APP_URL: STG }],
  ["identity: production Supabase as staging", { ...env, STG_SUPABASE_URL: env.PROD_SUPABASE_URL }],
  ["credentials missing", { ...env, CBC_TEST_B_PASSWORD: "" }],
  ["the same account twice", { ...env, CBC_TEST_B_EMAIL: " CBC-STG-A@example.test " }],
  ["organization evidence missing", { ...env, CBC_TEST_B_ORG_ID: "" }],
  ["organization evidence not a UUID", { ...env, CBC_TEST_A_ORG_ID: "org-1" }],
  ["the same organization attested for both", { ...env, CBC_TEST_B_ORG_ID: ORG_1.toUpperCase() }],
] as const) {
  const { r, calls } = await run({}, e);
  check(`J0 ${name}: FAILED, rest BLOCKED, no request`, statusOf(r, "J0") === "FAILED" && r.results.slice(1).every((x) => x.status === "BLOCKED") && calls.length === 0,
    `calls=${calls.length}`);
}

// ---------------------------------------------------------------- prerequisites: no scan unless all pass
for (const [name, o, e, want] of [
  ["B cannot sign in", { failLoginB: true }, env, { J2: "FAILED", J5: "BLOCKED" }],
  ["a production cookie next to a valid staging session", { prodCookie: true }, env, { J1: "FAILED", J5: "BLOCKED" }],
  ["B cannot reach /dashboard", { dashFailB: true }, env, { J3: "FAILED", J5: "BLOCKED" }],
  ["observed: A and B in the same organization", { sameOrg: true }, { ...env }, { J4: "FAILED", J5: "BLOCKED" }],
  ["observed organization differs from the founder evidence", {}, { ...env, CBC_TEST_A_ORG_ID: ORG_2, CBC_TEST_B_ORG_ID: ORG_1 }, { J4: "FAILED", J5: "BLOCKED" }],
] as Array<[string, Opts, Record<string, string>, Record<string, string>]>) {
  const { r, calls, sink } = await run(o, e);
  check(`prerequisite: ${name} -> no scan created`,
    Object.entries(want).every(([id, s]) => statusOf(r, id) === s) && scanPosts(calls) === 0 && sink.length === 0,
    r.results.map((x) => `${x.id}=${x.status}`).join(","));
}
{
  const { r, calls } = await run({ ownUsersRow: "hidden" });
  check("prerequisite: own users rows not readable -> J4 ATTESTED (not VERIFIED) and the run continues",
    statusOf(r, "J4") === "ATTESTED" && /not proven by this run/.test(evOf(r, "J4")) && scanPosts(calls) === 1 && statusOf(r, "J10") === "VERIFIED", evOf(r, "J4"));
  check("ATTESTED does not fail a run; OBSERVED does not either", m.PASSING.has("ATTESTED") && m.PASSING.has("OBSERVED") && !m.PASSING.has("BLOCKED"));
}
{
  // A false attestation is still caught by the app-level checks when rows are hidden.
  const { r } = await run({ sameOrg: true, ownUsersRow: "hidden" });
  check("false attestation with hidden rows: J4 ATTESTED, then J8/J9 FAILED", statusOf(r, "J4") === "ATTESTED" && statusOf(r, "J8") === "FAILED" && statusOf(r, "J9") === "FAILED");
}

// ---------------------------------------------------------------- after a scan exists: evidence is kept
for (const [name, o, want, sinkWant] of [
  // The row exists, so it is recorded and the cross-tenant checks still run against it.
  ["scan POST 502 carrying a scan id", { scanCreate: 502, scanCreateWithId: true }, { J5: "FAILED", J8: "VERIFIED", J10: "VERIFIED" }, [SCAN_ID]],
  ["scan POST 500 without an id (row may exist)", { scanCreate: 500 }, { J5: "FAILED", J6: "BLOCKED" }, [null]],
  ["scan POST 400 (rejected, nothing written)", { scanCreate: 400 }, { J5: "FAILED" }, []],
  ["later assertions fail (status not complete)", { scanStatus: "processing" }, { J6: "FAILED" }, [SCAN_ID]],
  ["cross-tenant exposure found", { rls: "leaky-id" }, { J10: "FAILED" }, [SCAN_ID]],
] as Array<[string, Opts, Record<string, string>, Array<string | null>]>) {
  const { r, sink } = await run(o);
  check(`cleanup evidence: ${name}`,
    Object.entries(want).every(([id, s]) => statusOf(r, id) === s) && JSON.stringify(sink.map((c) => c.id)) === JSON.stringify(sinkWant),
    `${r.results.map((x) => `${x.id}=${x.status}`).join(",")} sink=${JSON.stringify(sink.map((c) => c.id))}`);
}
{
  const { r } = await run({ scanCreate: 500 });
  check("cleanup evidence: an unknown id points to the read-only lookup with the run id",
    m.formatJourneys(r).includes(`scans of unknown id (account A), run ${RUN}: find it with the read-only query`));
}
{
  // The script's own entry point prints the cleanup section even when J0 fails (no network).
  const res = spawnSync(process.execPath, ["scripts/azure-hosting/staging-auth-journeys.mjs"], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  check("entry point: with no configuration, exits 1, prints the cleanup section and sends nothing",
    res.status === 1 && /Test data created by this run \(cleanup required\):\n- none/.test(res.stdout) && /staging journeys: FAIL/.test(res.stdout), `${res.status} ${res.stdout.slice(-200)}`);
}

// ---------------------------------------------------------------- other journey failures
for (const [name, o, want] of [
  ["data API: B sees other users", { rls: "leaky-users" }, { J10: "FAILED" }],
  ["data API: 500", { rls: "error" }, { J10: "FAILED" }],
  ["data API: denial is accepted", { rls: "denied" }, { J10: "VERIFIED" }],
  ["sign-out does not end the session", { noRevoke: true }, { J12: "FAILED" }],
] as Array<[string, Opts, Record<string, string>]>) {
  const { r } = await run(o);
  check(`journey: ${name}`, Object.entries(want).every(([id, s]) => statusOf(r, id) === s), r.results.map((x) => `${x.id}=${x.status}`).join(","));
}
{
  const { r } = await run({ rls: "leaky-id" });
  check("J10 evidence names the exposure", /scans by A's id: 1 rows VISIBLE/.test(evOf(r, "J10")), evOf(r, "J10"));
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

// ---------------------------------------------------------------- founder cleanup SQL (static)
{
  const sql = read("docs/gates/sql/gate-006c-staging-test-scan-cleanup.sql");
  const body = sql.replace(/--[^\n]*/g, "");
  const firstDelete = body.search(/\bdelete\b/i);
  const checks = ["s.user_id = v_user", "s.organization_id = v_org", "s.input_type = 'url'", "s.raw_input = v_input"];
  check("cleanup SQL: staging-only and one transaction (begin ... commit around one DO block)",
    sql.includes("zgxmvpbvvakpsnzcymsf") && /^begin;\n[\s\S]*\ndo \$\$[\s\S]*\n\$\$;\n\ncommit;\n?$/m.test(body.trim() + "\n"));
  check("cleanup SQL: run id must be a UUID and raw_input must equal the exact localhost prefix plus it",
    body.includes("v_run !~ '^[0-9a-f]{8}-") && body.includes("v_input := 'http://localhost/cbc-staging-journey/' || v_run;"));
  check("cleanup SQL: the scan is verified (id, account A, A's organization, url, exact input) before any delete",
    (() => { const pre = body.slice(0, firstDelete); return checks.every((c) => pre.includes(c)) && /if n <> 1 then\s+raise exception 'expected exactly 1 matching test scan/.test(pre); })());
  check("cleanup SQL: exactly 1 evidence row in A's organization and 0 vendor rows are verified before any delete",
    (() => {
      const pre = body.slice(0, firstDelete);
      return /where e\.scan_id = v_scan;\s+if n <> 1 then\s+raise exception 'expected exactly 1 evidence_items row/.test(pre) &&
        /e\.scan_id = v_scan and e\.organization_id = v_org;\s+if n <> 1 then\s+raise exception 'evidence_items row is not in account A''s organization/.test(pre) &&
        /where v\.scan_id = v_scan;\s+if n <> 0 then\s+raise exception 'expected 0 vendor_results rows/.test(pre);
    })());
  const deletes = [...body.matchAll(/delete from ([a-z_.]+)[^;]*;/gi)].map((x) => x[0]);
  check("cleanup SQL: exactly two deletes, each bound to the verified ids, each followed by a row-count check",
    deletes.length === 2 && deletes[0].includes("e.scan_id = v_scan and e.organization_id = v_org") &&
    checks.every((c) => deletes[1].includes(c)) && deletes[1].includes("s.id = v_scan") &&
    (body.match(/get diagnostics n = row_count;\s+if n <> 1 then raise exception/g) ?? []).length === 2);
  check("cleanup SQL: no vendor_results delete, no truncate/drop/update, no literal-id deletes",
    !/delete from public\.vendor_results|truncate|drop |update /i.test(body) && !/where [a-z_.]+ = '<scan id>'/.test(body));
  check("cleanup SQL: any mismatch raises (aborting the transaction) and says nothing was deleted",
    (body.match(/raise exception/g) ?? []).length >= 7 && (body.match(/nothing deleted|rolled back/g) ?? []).length >= 7);
  const doc = read("docs/gates/gate-006c-authenticated-staging-verification.md");
  check("gate doc: cleanup step points to the SQL file and keeps no unchecked delete",
    doc.includes("sql/gate-006c-staging-test-scan-cleanup.sql") && !/delete from public\./i.test(doc));
  check("gate doc: U1 says configuration-guarded, not proof of Inngest Cloud registration or execution",
    /\| U1 \|[^\n]*Configuration-guarded at every staging deploy[^\n]*\*\*not\*\* that the app is registered in Inngest Cloud, synced, or that functions execute there/.test(doc));
  check("gate doc: organization evidence is founder-supplied and J4 may be ATTESTED",
    doc.includes("`CBC_TEST_A_ORG_ID`, `CBC_TEST_B_ORG_ID`") && /reports J4 as \*\*ATTESTED\*\* and does not claim to have proven it/.test(doc));
}

// ---------------------------------------------------------------- source and workflow (static)
{
  const src = read("scripts/azure-hosting/staging-auth-journeys.mjs");
  check("source: the only scan created is a localhost URL scan", (src.match(/input_type: "/g) ?? []).length === 1 && src.includes('input_type: "url", input: `http://localhost/cbc-staging-journey/${runId}`'));
  check("source: reuses the integration verifier's identity, asset inspection and sanitizer",
    /import \{[^}]*checkIdentity[^}]*inspectLoginAssets[^}]*clean[^}]*\} from "\.\/staging-integration\.mjs"/.test(src));
  check("source: the entry point prints the cleanup section in a finally block", /finally \{\n\s+\/\/ Printed in every case[^\n]*\n\s+const text = formatJourneys/.test(src));
  const integ = read("scripts/azure-hosting/staging-integration.mjs");
  check("staging-verify U1: configuration-guarded, not proof of Inngest Cloud registration",
    /\["U1", "Inngest Cloud registration and branch-environment use, live", "UNVERIFIED", "INNGEST_ENV and INNGEST_SERVE_ORIGIN are configuration-guarded at every deploy \(staging-guard\); that is not proof of Inngest Cloud registration, sync or function execution/.test(integ));
  const wf = read(".github/workflows/staging-auth-journeys.yml");
  const on = wf.match(/^on:\n((?: {2}.*\n)+)/m)?.[1] ?? "";
  check("workflow: workflow_dispatch only", JSON.stringify([...on.matchAll(/^ {2}(\w+):/gm)].map((x) => x[1])) === '["workflow_dispatch"]');
  check("workflow: runs in the founder-protected staging-auth-test environment, from master",
    /\n {4}environment: staging-auth-test\n/.test(wf) && /if: github\.ref == 'refs\/heads\/master'/.test(wf));
  check("workflow: contents: read only; no Azure, no OIDC", /^permissions:\n {2}contents: read\n/m.test(wf) && !/write|azure\/login|id-token|\baz /.test(wf));
  const secrets = [...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((x) => x[1]).sort();
  check("workflow: the only secrets are the four test-account values",
    JSON.stringify(secrets) === JSON.stringify(["CBC_TEST_A_EMAIL", "CBC_TEST_A_PASSWORD", "CBC_TEST_B_EMAIL", "CBC_TEST_B_PASSWORD"]));
  check("workflow: organization evidence comes from environment variables",
    wf.includes("CBC_TEST_A_ORG_ID: ${{ vars.CBC_TEST_A_ORG_ID }}") && wf.includes("CBC_TEST_B_ORG_ID: ${{ vars.CBC_TEST_B_ORG_ID }}"));
  check("workflow: offline self-test runs before the live journeys",
    wf.search(/^ +run: node [^\n]*test-staging-auth-journeys\.ts/m) > 0 && wf.search(/^ +run: node [^\n]*test-staging-auth-journeys\.ts/m) < wf.search(/^ +run: node scripts\/azure-hosting\/staging-auth-journeys\.mjs/m));
  check("workflow: no retries or continue-on-error", !/retry|continue-on-error/i.test(wf));
  const others = [".github/workflows/azure-deploy.yml", ".github/workflows/staging-verify.yml"].map(read).join("\n");
  check("workflow: never called automatically (not referenced by azure-deploy or staging-verify)", !others.includes("staging-auth-journeys"));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
