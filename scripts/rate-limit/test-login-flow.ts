// Gate 007A - offline tests for login protection: the POST /api/auth/login flow (lib/security/loginFlow.ts) with the
// real limiters, the post-login redirect guard, and static checks that the UI signs in only through that route.
// No network, no database, no new dependency.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/rate-limit/test-login-flow.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { handleLoginRequest, safeNextPath, MAX_LOGIN_PASSWORD_LENGTH, type LoginResponse } from "../../lib/security/loginFlow.ts";
import { checkLoginAllowed, createSlidingWindowLimiter, rateLimitHeaders, LOGIN_LIMITS } from "../../lib/security/rateLimit.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, info = ""): void {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}${info ? `  [${info}]` : ""}`); }
}
const root = path.resolve(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

let t = 5_000_000;
const clock = () => t;

function makeLogin(opts: { goodPassword?: string; signInThrows?: boolean } = {}) {
  const byIp = createSlidingWindowLimiter({ limit: LOGIN_LIMITS.perIpPerWindow, windowMs: LOGIN_LIMITS.windowMs, reason: "login_ip_limit", now: clock });
  const byEmail = createSlidingWindowLimiter({ limit: LOGIN_LIMITS.perEmailPerWindow, windowMs: LOGIN_LIMITS.windowMs, reason: "login_email_limit", now: clock });
  const n = { signIn: 0 };
  const attempt = (body: unknown, ip = "203.0.113.7", bodyThrows = false): Promise<LoginResponse> =>
    handleLoginRequest({
      readBody: async () => { if (bodyThrows) throw new SyntaxError("bad"); return body; },
      checkAllowed: (email) => checkLoginAllowed({ ip, email, byIp, byEmail }),
      signIn: async (_e, p) => { n.signIn++; if (opts.signInThrows) throw new Error("auth down"); return p === (opts.goodPassword ?? "correct horse"); },
      retryHeaders: rateLimitHeaders,
    });
  return { attempt, n, byIp, byEmail };
}

async function main() {
  // ---- request validation ------------------------------------------------------------------------------------
  {
    const L = makeLogin();
    const cases: Array<[string, unknown, boolean]> = [
      ["malformed JSON", null, true],
      ["null body", null, false],
      ["missing password", { email: "a@example.com" }, false],
      ["missing email", { password: "x" }, false],
      ["non-string email", { email: ["a@example.com"], password: "x" }, false],
      ["whitespace email", { email: "   ", password: "x" }, false],
      ["email over 320 characters", { email: "a".repeat(321) + "@x.com", password: "x" }, false],
      ["password over the length cap", { email: "a@example.com", password: "p".repeat(MAX_LOGIN_PASSWORD_LENGTH + 1) }, false],
    ];
    for (const [label, body, throws] of cases) {
      const r = await L.attempt(body, "203.0.113.1", throws);
      check(`L-V ${label} -> 400, Supabase not called, no-store`, r.status === 400 && r.headers["Cache-Control"]?.includes("no-store") === true);
    }
    check("L-V00 no invalid request reached Supabase or a limiter", L.n.signIn === 0 && L.byIp.trackedKeys() === 0 && L.byEmail.trackedKeys() === 0);
  }

  // ---- outcomes ---------------------------------------------------------------------------------------------------
  {
    const L = makeLogin();
    const ok = await L.attempt({ email: "  User@Example.com ", password: "correct horse" });
    check("L01 correct credentials -> 200 {ok:true}, no-store", ok.status === 200 && ok.body.ok === true && ok.headers["Cache-Control"] === "no-store, private");
    const bad = await L.attempt({ email: "user@example.com", password: "wrong" });
    check("L02 wrong password -> 401 with a generic message (no account enumeration)", bad.status === 401 && bad.body.error === "Invalid email or password.");
    const L2 = makeLogin({ signInThrows: true });
    const err = await L2.attempt({ email: "user@example.com", password: "x" });
    check("L03 Supabase throwing -> JSON 500, no detail leaked", err.status === 500 && !JSON.stringify(err.body).includes("auth down"));
  }

  // ---- per-email limit ---------------------------------------------------------------------------------------------
  {
    t += 10 * LOGIN_LIMITS.windowMs;
    const L = makeLogin();
    const rs: LoginResponse[] = [];
    for (let i = 0; i < 6; i++) rs.push(await L.attempt({ email: i % 2 ? "VICTIM@example.com" : "victim@example.com ", password: "guess" + i }, `198.51.100.${i}`));
    check("L04 5 attempts per email (any case/whitespace, any IP) reach Supabase; the 6th is 429 login_email_limit",
      rs.slice(0, 5).every((r) => r.status === 401) && rs[5].status === 429 && L.n.signIn === 5);
    check("L05 429 carries Retry-After, no-store and retry_after_seconds", Number(rs[5].headers["Retry-After"]) > 0 && rs[5].headers["Cache-Control"]?.includes("no-store") === true && Number(rs[5].body.retry_after_seconds) > 0);
    const right = await L.attempt({ email: "victim@example.com", password: "correct horse" }, "198.51.100.200");
    check("L06 while locked, even the correct password is refused before Supabase (no oracle)", right.status === 429 && L.n.signIn === 5);
    t += LOGIN_LIMITS.windowMs + 1000;
    const later = await L.attempt({ email: "victim@example.com", password: "correct horse" }, "198.51.100.201");
    check("L07 allowed again after 15 minutes", later.status === 200);
  }

  // ---- per-IP limit -------------------------------------------------------------------------------------------------
  {
    t += 10 * LOGIN_LIMITS.windowMs;
    const L = makeLogin();
    const rs: LoginResponse[] = [];
    for (let i = 0; i < 11; i++) rs.push(await L.attempt({ email: `spray${i}@example.com`, password: "Winter2026!" }, "192.0.2.9"));
    check("L08 password spraying: 10 different emails from one IP reach Supabase, the 11th is 429 login_ip_limit",
      rs.slice(0, 10).every((r) => r.status === 401) && rs[10].status === 429 && L.n.signIn === 10);
    const other = await L.attempt({ email: "someone@example.com", password: "correct horse" }, "192.0.2.10");
    check("L09 another IP is unaffected", other.status === 200);
  }

  // ---- redirect guard ------------------------------------------------------------------------------------------------
  const goodPaths = ["/dashboard", "/scan/123?tab=evidence", "/history#top"];
  const badPaths = [null, undefined, "", "https://evil.example", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "dashboard", "/ok\n//evil", "/a\\b", "\t/x", "/" + "a".repeat(2050)];
  check("N01 same-site paths are kept", goodPaths.every((p) => safeNextPath(p) === p));
  const leaked = badPaths.filter((p) => safeNextPath(p as string | null | undefined) !== "/dashboard");
  check("N02 other origins, protocol-relative, backslash, schemes, control characters and oversize -> /dashboard", leaked.length === 0, JSON.stringify(leaked));

  // ---- static: the UI signs in only through the throttled route ------------------------------------------------------
  const page = read("app/(auth)/login/[[...rest]]/page.tsx");
  check("S01 login page posts to /api/auth/login", /fetch\("\/api\/auth\/login", \{\s*method: "POST"/.test(page));
  check("S02 login page no longer calls Supabase Auth from the browser", !/signInWithPassword|createClient/.test(page));
  check("S03 login page sanitizes ?next= with safeNextPath", /safeNextPath\(searchParams\.get\("next"\)\)/.test(page));
  check("S04 login page shows a distinct message for 429", /response\.status === 429/.test(page));

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) files.push(full);
    }
  };
  for (const d of ["app", "lib", "components", "src", "inngest"]) walk(path.join(root, d));
  const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
  const signInCallers = files.filter((f) => /\.signInWithPassword\(/.test(readFileSync(f, "utf8"))).map(rel);
  check("S05 signInWithPassword is called only by the server login route", signInCallers.join(",") === "app/api/auth/login/route.ts", signInCallers.join(","));

  const route = read("app/api/auth/login/route.ts");
  check("S06 login route delegates to handleLoginRequest with the shared IP and email limiters",
    /handleLoginRequest\(\{/.test(route) && /byIp: loginIpLimiter/.test(route) && /byEmail: loginEmailLimiter/.test(route) && /clientIpFromForwardedFor\(request\.headers\.get\("x-forwarded-for"\)\)/.test(route));
  check("S07 login route copies session cookies onto the response only on success",
    /if \(result\.status === 200\) \{\s*sessionCookies\.forEach/.test(route));
  const flow = read("lib/security/loginFlow.ts");
  check("S08 login flow checks the limits before calling Supabase", flow.indexOf("deps.checkAllowed(") > 0 && flow.indexOf("deps.checkAllowed(") < flow.indexOf("deps.signIn("));
  check("S09 login flow is pure (type-only imports, no env, no fetch)", !/^import (?!type )/m.test(flow) && !/process\.env|fetch\(/.test(flow));
  check("S10 middleware does not gate /api/auth/login behind a session", !/"\/api/.test(read("proxy.ts").split("const protectedRoutes")[1].split("]")[0]));

  console.log(`\n=== Gate 007A login flow: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.log(`FAIL: harness error ${(e as Error).stack}`); process.exit(1); });
