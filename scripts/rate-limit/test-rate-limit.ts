// Gate 007A - offline tests for scanner and login rate limiting. No network, no database, no new dependency.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/rate-limit/test-rate-limit.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  admitScan,
  checkLoginAllowed,
  clientIpFromForwardedFor,
  createSlidingWindowLimiter,
  interpretAdmission,
  rateLimitHeaders,
  ADMISSION_LIMITS_24H,
  LOGIN_LIMITS,
  SCAN_BURST_PER_USER_PER_MINUTE,
} from "../../lib/security/rateLimit.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, info = ""): void {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}${info ? `  [${info}]` : ""}`); }
}
const root = path.resolve(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

// ---- approved limits -------------------------------------------------------------------------------
check("L01 burst limit is 5 per user per minute", SCAN_BURST_PER_USER_PER_MINUTE === 5);
check("L02 login limits are 10 per IP and 5 per email per 15 minutes",
  LOGIN_LIMITS.perIpPerWindow === 10 && LOGIN_LIMITS.perEmailPerWindow === 5 && LOGIN_LIMITS.windowMs === 15 * 60 * 1000);
check("L03 informational admission limits are 500 / 200 / 50, Web Risk bound 1000",
  ADMISSION_LIMITS_24H.global === 500 && ADMISSION_LIMITS_24H.perOrganization === 200 && ADMISSION_LIMITS_24H.perUser === 50 && ADMISSION_LIMITS_24H.maxWebRiskCalls === 1000);

// ---- sliding window ----------------------------------------------------------------------------------
let t = 1_000_000;
const clock = () => t;
const burst = createSlidingWindowLimiter({ limit: 5, windowMs: 60_000, reason: "user_burst_limit", now: clock });
const first5 = [1, 2, 3, 4, 5].map(() => burst.hit("u1"));
check("W01 first 5 hits in a minute are allowed", first5.every((d) => d.allowed));
const sixth = burst.hit("u1");
check("W02 6th hit is 429 user_burst_limit", !sixth.allowed && sixth.status === 429 && sixth.reason === "user_burst_limit");
check("W03 Retry-After is between 1 and 60 seconds", !sixth.allowed && sixth.retryAfterSeconds >= 1 && sixth.retryAfterSeconds <= 60);
check("W04 another user is unaffected", burst.hit("u2").allowed);
t += 30_000;
check("W05 rejected attempts still count (hammering keeps the key limited)", !burst.hit("u1").allowed);
t += 61_000;
check("W06 allowed again after the window passes", burst.hit("u1").allowed);
const big = createSlidingWindowLimiter({ limit: 1, windowMs: 1000, reason: "x", now: clock });
for (let i = 0; i < 12_000; i++) big.hit(`k${i}`);
t += 5000; big.hit("trigger-prune");
check("W07 memory is pruned (old keys forgotten, limiter still works)", big.hit("k1").allowed);

// ---- memory bounds and capacity (Codex review P2: unbounded timestamps / tracked keys) -----------------
{
  t = 20_000_000;
  const lim = createSlidingWindowLimiter({ limit: 5, windowMs: 60_000, reason: "login_email_limit", now: clock });
  let allRejected = true;
  for (let i = 0; i < 100_000; i++) { const d = lim.hit("victim@example.com"); if (i >= 5 && d.allowed) allRejected = false; }
  check("M01 100,000 sustained attempts on one key: all after the 5th rejected", allRejected);
  check("M02 ...and at most `limit` (5) timestamps retained for that key", lim.retainedTimestamps() === 5 && lim.trackedKeys() === 1, String(lim.retainedTimestamps()));
  for (let i = 0; i < 10; i++) { t += 1000; lim.hit("victim@example.com"); }   // hammering across time
  check("M03 rejected attempts spread over time stay bounded (5) and keep the key limited", lim.retainedTimestamps() === 5 && !lim.hit("victim@example.com").allowed);
  const last = t;
  t = last + 60_000 - 4000;   // the 5 most recent attempts were at last-3000 .. last (1 s apart) plus the probe at last
  check("M04 still limited while 5 recent attempts are inside the window", !lim.hit("victim@example.com").allowed);
  t += 70_000;
  check("M05 allowed again once the retained attempts have expired", lim.hit("victim@example.com").allowed);
}
{
  t = 30_000_000;
  const cap = createSlidingWindowLimiter({ limit: 5, windowMs: 15 * 60_000, reason: "login_email_limit", now: clock, maxTrackedKeys: 100 });
  for (let i = 0; i < 4; i++) cap.hit("target@example.com");
  let firstAllowed = 0;
  for (let i = 0; i < 99; i++) if (cap.hit(`rotating${i}@example.com`).allowed) firstAllowed++;
  check("K01 unique emails are tracked up to the genuine maximum (100 keys)", cap.trackedKeys() === 100 && firstAllowed === 99);
  const over = cap.hit("brand-new@example.com");
  check("K02 at capacity a NEW key fails closed (429 rate_limiter_at_capacity)", !over.allowed && over.status === 429 && over.reason === "rate_limiter_at_capacity" && over.retryAfterSeconds >= 1);
  let flood = 0;
  for (let i = 0; i < 50_000; i++) if (!cap.hit(`flood${i}@example.com`).allowed) flood++;
  check("K03 50,000 more unique emails: all refused, tracked keys stay at 100", flood === 50_000 && cap.trackedKeys() === 100);
  check("K04 memory stays bounded at capacity (<= keys x limit timestamps)", cap.retainedTimestamps() <= 100 * 5, String(cap.retainedTimestamps()));
  const tgt5 = cap.hit("target@example.com"); const tgt6 = cap.hit("target@example.com");
  check("K05 an already-tracked key is still enforced at capacity (5th allowed, 6th limited) - flooding cannot evict it", tgt5.allowed && !tgt6.allowed && tgt6.reason === "login_email_limit");
  t += 15 * 60_000 + 1000;
  const after = cap.hit("brand-new@example.com");
  check("K06 after the window, expired keys are swept and new keys are tracked again", after.allowed && cap.trackedKeys() === 1);
}
{
  t = 40_000_000;
  const def = createSlidingWindowLimiter({ limit: 10, windowMs: 15 * 60_000, reason: "login_ip_limit", now: clock });
  for (let i = 0; i < 10_000; i++) def.hit(`198.51.${i >> 8}.${i & 255}`);
  const d = def.hit("203.0.113.250");
  check("K07 default limiter tracks at most 10,000 keys, then fails closed for new keys", def.trackedKeys() === 10_000 && !d.allowed && d.reason === "rate_limiter_at_capacity");
  const longA = "a".repeat(400) + "x"; const longB = "a".repeat(400) + "y";
  const small = createSlidingWindowLimiter({ limit: 1, windowMs: 60_000, reason: "x", now: clock });
  check("K08 keys are truncated to 320 characters (long keys can only merge, i.e. limit more strictly)", small.hit(longA).allowed && !small.hit(longB).allowed && small.trackedKeys() === 1);
}
{
  t = 50_000_000;
  const byIp = createSlidingWindowLimiter({ limit: 10, windowMs: LOGIN_LIMITS.windowMs, reason: "login_ip_limit", now: clock, maxTrackedKeys: 1000 });
  const byEmail = createSlidingWindowLimiter({ limit: 5, windowMs: LOGIN_LIMITS.windowMs, reason: "login_email_limit", now: clock, maxTrackedKeys: 20 });
  for (let i = 0; i < 20; i++) checkLoginAllowed({ ip: `192.0.2.${i}`, email: `filler${i}@example.com`, byIp, byEmail });
  const blocked = checkLoginAllowed({ ip: "198.51.100.77", email: "fresh@example.com", byIp, byEmail });
  check("K09 login with the email limiter at capacity is refused (fail closed), not silently allowed", !blocked.allowed && blocked.reason === "rate_limiter_at_capacity");
}

// ---- Cycle 2 P1: IP-rejected login attempts must never touch the email limiter --------------------
{
  t = 60_000_000;
  const byIp = createSlidingWindowLimiter({ limit: 10, windowMs: LOGIN_LIMITS.windowMs, reason: "login_ip_limit", now: clock });
  const byEmail = createSlidingWindowLimiter({ limit: 5, windowMs: LOGIN_LIMITS.windowMs, reason: "login_email_limit", now: clock });
  const attacker = "203.0.113.66";
  for (let i = 0; i < 10; i++) checkLoginAllowed({ ip: attacker, email: `seed${i}@example.com`, byIp, byEmail });
  const keysAfterAllowed = byEmail.trackedKeys(); const tsAfterAllowed = byEmail.retainedTimestamps();
  check("P1-01 one IP's 10 allowed attempts reach the email limiter (10 buckets)", keysAfterAllowed === 10 && tsAfterAllowed === 10);
  let ipRejected = 0;
  for (let i = 0; i < 50_000; i++) { const d = checkLoginAllowed({ ip: attacker, email: `spray${i}@example.com`, byIp, byEmail }); if (!d.allowed && d.reason === "login_ip_limit") ipRejected++; }
  check("P1-02 50,000 further attempts from the blocked IP are all rejected by the IP limit", ipRejected === 50_000);
  check("P1-03 ...and create NO email buckets and add NO timestamps (email capacity untouched)", byEmail.trackedKeys() === keysAfterAllowed && byEmail.retainedTimestamps() === tsAfterAllowed, `${byEmail.trackedKeys()} keys, ${byEmail.retainedTimestamps()} timestamps`);
  const fresh = checkLoginAllowed({ ip: "198.51.100.10", email: "never-seen-before@example.com", byIp, byEmail });
  check("P1-04 a previously unseen legitimate email from another IP still signs in", fresh.allowed);
}
{
  t = 70_000_000;
  const byIp = createSlidingWindowLimiter({ limit: 10, windowMs: LOGIN_LIMITS.windowMs, reason: "login_ip_limit", now: clock });
  const byEmail = createSlidingWindowLimiter({ limit: 5, windowMs: LOGIN_LIMITS.windowMs, reason: "login_email_limit", now: clock });
  const victim = "victim@example.com";
  for (let i = 0; i < 5; i++) checkLoginAllowed({ ip: "192.0.2.1", email: victim, byIp, byEmail });   // victim locked out
  const lockedAt = t;
  check("P1-05 the targeted email is locked after 5 attempts", !checkLoginAllowed({ ip: "192.0.2.2", email: victim, byIp, byEmail }).allowed);
  const attacker = "203.0.113.77";
  for (let i = 0; i < 10; i++) checkLoginAllowed({ ip: attacker, email: `burn${i}@example.com`, byIp, byEmail });   // burn the attacker's IP quota
  const victimTsBefore = byEmail.retainedTimestamps();
  for (let i = 0; i < 1000; i++) { t += 1000; checkLoginAllowed({ ip: attacker, email: victim, byIp, byEmail }); }   // keep hammering the victim from the blocked IP
  check("P1-06 a blocked IP hammering the victim's email adds no timestamps to the email limiter", byEmail.retainedTimestamps() === victimTsBefore);
  t = lockedAt + LOGIN_LIMITS.windowMs + 2000;
  check("P1-07 the victim's lockout is NOT extended: it ends on schedule despite the hammering", checkLoginAllowed({ ip: "198.51.100.99", email: victim, byIp, byEmail }).allowed);
}
{
  t = 80_000_000;
  // Even with a small email capacity, a single blocked IP cannot fill it.
  const byIp = createSlidingWindowLimiter({ limit: 10, windowMs: LOGIN_LIMITS.windowMs, reason: "login_ip_limit", now: clock });
  const byEmail = createSlidingWindowLimiter({ limit: 5, windowMs: LOGIN_LIMITS.windowMs, reason: "login_email_limit", now: clock, maxTrackedKeys: 20 });
  for (let i = 0; i < 20_000; i++) checkLoginAllowed({ ip: "203.0.113.88", email: `fill${i}@example.com`, byIp, byEmail });
  check("P1-08 one IP can occupy at most 10 of 20 email buckets, however many attempts it makes", byEmail.trackedKeys() === 10);
  check("P1-09 so the email limiter is not at capacity for other users", checkLoginAllowed({ ip: "198.51.100.5", email: "legit@example.com", byIp, byEmail }).allowed);
}
check("P1-10 static: checkLoginAllowed returns the IP rejection before calling byEmail.hit", (() => {
  const src = read("lib/security/rateLimit.ts");
  const body = src.slice(src.indexOf("export function checkLoginAllowed"), src.indexOf("// Process-wide limiters"));
  return body.indexOf("if (!ipDecision.allowed) return ipDecision") > 0 && body.indexOf("if (!ipDecision.allowed) return ipDecision") < body.indexOf("args.byEmail.hit(");
})());

// ---- admission interpretation (fail closed) ----------------------------------------------------------
const ok = interpretAdmission([{ admitted: true, reason: "admitted", retry_after_seconds: 0, provider_calls_reserved: 1, admission_id: 7 }], null);
check("A01 admitted row allows the scan", ok.allowed);
const userLim = interpretAdmission([{ admitted: false, reason: "user_daily_limit", retry_after_seconds: 1234, provider_calls_reserved: 0, admission_id: null }], null);
check("A02 user_daily_limit -> 429 with Retry-After from the database", !userLim.allowed && userLim.status === 429 && userLim.retryAfterSeconds === 1234);
const orgLim = interpretAdmission({ admitted: false, reason: "organization_daily_limit", retry_after_seconds: 50, provider_calls_reserved: 0, admission_id: null }, null);
check("A03 organization_daily_limit -> 429 (single-object RPC result accepted)", !orgLim.allowed && orgLim.status === 429 && orgLim.reason === "organization_daily_limit");
const glob = interpretAdmission([{ admitted: false, reason: "global_scan_capacity_reached", retry_after_seconds: 99, provider_calls_reserved: 0, admission_id: null }], null);
check("A04 global cap -> 503 global_scan_capacity_reached", !glob.allowed && glob.status === 503 && glob.reason === "global_scan_capacity_reached");
const closed = (label: string, data: unknown, error: unknown = null) => {
  const d = interpretAdmission(data, error);
  check(label, !d.allowed && d.status === 503 && d.reason === "admission_unavailable");
};
closed("A05 RPC error (e.g. function not deployed) fails closed", null, { message: "function public.cbc_admit_scan does not exist" });
closed("A06 null data fails closed", null);
closed("A07 empty array fails closed", []);
closed("A08 non-object fails closed", "yes");
closed("A09 admitted:true without admission_id fails closed", [{ admitted: true, reason: "admitted", retry_after_seconds: 0, provider_calls_reserved: 1, admission_id: null }]);
closed("A10 admitted:true with a different reason fails closed", [{ admitted: true, reason: "maybe", admission_id: 3 }]);
closed("A11 admitted as a string fails closed", [{ admitted: "true", reason: "admitted", admission_id: 3 }]);
closed("A12 unauthenticated -> fails closed", [{ admitted: false, reason: "unauthenticated", retry_after_seconds: 0 }]);
closed("A13 no_organization -> fails closed", [{ admitted: false, reason: "no_organization", retry_after_seconds: 0 }]);
closed("A14 invalid_input_type -> fails closed", [{ admitted: false, reason: "invalid_input_type", retry_after_seconds: 0 }]);
closed("A15 unknown reason -> fails closed", [{ admitted: false, reason: "something_new", retry_after_seconds: 5 }]);
const noRetry = interpretAdmission([{ admitted: false, reason: "user_daily_limit", retry_after_seconds: 0 }], null);
check("A16 missing/zero retry falls back to 60 seconds", !noRetry.allowed && noRetry.retryAfterSeconds === 60);

// ---- admitScan ordering -----------------------------------------------------------------------------
{
  t = 5_000_000;
  const b = createSlidingWindowLimiter({ limit: 5, windowMs: 60_000, reason: "user_burst_limit", now: clock });
  let calls = 0; let seenType = "";
  const call = async (inputType: string) => { calls++; seenType = inputType; return { data: [{ admitted: true, reason: "admitted", retry_after_seconds: 0, provider_calls_reserved: 1, admission_id: calls }], error: null }; };
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await admitScan({ userId: "u", inputType: "url", burst: b, callAdmission: call }));
  check("S01 first 5 admitted through the database call", results.slice(0, 5).every((r) => r.allowed) && seenType === "url");
  check("S02 burst rejection does NOT call the database (no admission consumed)", !results[5].allowed && results[5].reason === "user_burst_limit" && calls === 5);
  const thrown = await admitScan({ userId: "v", inputType: "email", burst: b, callAdmission: async () => { throw new Error("network down"); } });
  check("S03 a throwing admission call fails closed (503)", !thrown.allowed && thrown.status === 503 && thrown.reason === "admission_unavailable");
}

// ---- login ------------------------------------------------------------------------------------------
{
  t = 9_000_000;
  const byIp = createSlidingWindowLimiter({ limit: 10, windowMs: LOGIN_LIMITS.windowMs, reason: "login_ip_limit", now: clock });
  const byEmail = createSlidingWindowLimiter({ limit: 5, windowMs: LOGIN_LIMITS.windowMs, reason: "login_email_limit", now: clock });
  const r = [];
  for (let i = 0; i < 6; i++) r.push(checkLoginAllowed({ ip: "203.0.113.9", email: i % 2 ? "User@Example.com" : " user@example.com ", byIp, byEmail }));
  check("G01 5 attempts per email allowed, the 6th is 429 (email normalized)", r.slice(0, 5).every((d) => d.allowed) && !r[5].allowed && r[5].reason === "login_email_limit");
  let last;
  for (let i = 0; i < 5; i++) last = checkLoginAllowed({ ip: "203.0.113.9", email: `other${i}@example.com`, byIp, byEmail });
  check("G02 11th attempt from one IP (different emails) is 429 login_ip_limit", !!last && !last.allowed && last.reason === "login_ip_limit");
  check("G03 another IP and email is unaffected", checkLoginAllowed({ ip: "198.51.100.1", email: "z@example.com", byIp, byEmail }).allowed);
  t += LOGIN_LIMITS.windowMs + 1000;
  check("G04 allowed again after 15 minutes", checkLoginAllowed({ ip: "203.0.113.9", email: "user@example.com", byIp, byEmail }).allowed);
}
check("G05 client IP is the LAST X-Forwarded-For entry (forged leading entries ignored)", clientIpFromForwardedFor("1.2.3.4, 10.0.0.1, 203.0.113.9") === "203.0.113.9");
check("G06 single X-Forwarded-For value", clientIpFromForwardedFor("203.0.113.9") === "203.0.113.9");
check("G07 missing header -> shared 'unknown' bucket", clientIpFromForwardedFor(null) === "unknown" && clientIpFromForwardedFor(" , ") === "unknown");
const h = rateLimitHeaders({ allowed: false, status: 429, reason: "x", retryAfterSeconds: 42 });
check("G08 rejection headers carry Retry-After and no-store", h["Retry-After"] === "42" && h["Cache-Control"] === "no-store" && Object.keys(rateLimitHeaders({ allowed: true })).length === 0);

// ---- static wiring checks (the flow lives in lib/scan/scanFlow.ts; the route only wires effects) ----------
const scanRoute = read("app/api/scan/route.ts");
const scanFlow = read("lib/scan/scanFlow.ts");
const iAdmit = scanFlow.indexOf("await deps.admit(");
const iCreate = scanFlow.indexOf("await deps.createScan(");
const iValidate = scanFlow.indexOf("cleanInput.length > MAX_INPUT_LENGTH");
check("R01 scan flow: admission runs after input validation and before the scan row is created", iAdmit > 0 && iCreate > iAdmit && iValidate > 0 && iValidate < iAdmit);
check("R02 scan route: admission uses the user's session client RPC cbc_admit_scan through admitScan with the burst limiter",
  /await \(await session\(\)\)\.rpc\("cbc_admit_scan", \{ p_input_type: t \}\)/.test(scanRoute) && /admitScan\(\{\s*userId,\s*inputType,\s*burst: scanBurstLimiter,/.test(scanRoute));
check("R03 scan flow: rejection returns admission.status with rate-limit headers", /return \{ status: admission\.status, body: \{ error: message, reason: admission\.reason \}, headers: deps\.retryHeaders\(admission\) \}/.test(scanFlow) && /retryHeaders: rateLimitHeaders/.test(scanRoute));
check("R04 only one createScan call (no path around the admission); the route never calls it directly",
  scanFlow.split("deps.createScan(").length === 2 && !/createScan\(/.test(scanRoute));
const rl = read("lib/security/rateLimit.ts");
check("R05 rate-limit module has no imports, env access, or service-role use", !/^\s*import\s/m.test(rl) && !rl.includes("process.env") && !/service.?role|createPrivilegedClient/i.test(rl));
check("R06 admission path never touches the service-role client", !/createPrivilegedClient|SUPABASE_SERVICE_ROLE_KEY/.test(scanRoute + scanFlow));
const login = read("app/api/auth/login/route.ts");
const loginFlow = read("lib/security/loginFlow.ts");
check("R07 login: limits checked before Supabase sign-in", loginFlow.indexOf("deps.checkAllowed(") > 0 && loginFlow.indexOf("deps.checkAllowed(") < loginFlow.indexOf("deps.signIn(") && /checkAllowed: \(email\) =>\s*checkLoginAllowed\(/.test(login));
check("R08 login: 429 with rate-limit headers", /status: 429,/.test(loginFlow) && /headers: \{ \.\.\.NO_STORE, \.\.\.deps\.retryHeaders\(limit\) \}/.test(loginFlow) && /retryHeaders: rateLimitHeaders/.test(login));
const sql = read("infra/supabase/migrations/001_scan_admission.sql");
check("D01 migration: SECURITY DEFINER with pinned search_path", /SECURITY DEFINER\s+SET search_path = pg_catalog, public/.test(sql));
check("D02 migration: execute granted to authenticated only (revoked from PUBLIC and anon)",
  /REVOKE ALL ON FUNCTION public\.cbc_admit_scan\(text\) FROM PUBLIC;/.test(sql) && /REVOKE ALL ON FUNCTION public\.cbc_admit_scan\(text\) FROM anon;/.test(sql) && /GRANT EXECUTE ON FUNCTION public\.cbc_admit_scan\(text\) TO authenticated;/.test(sql) && (sql.match(/^GRANT .*$/gm) || []).every((g) => /^GRANT EXECUTE ON FUNCTION public\.\w+\([a-z, ]*\) TO authenticated;$/.test(g)) && (sql.match(/^GRANT /gm) || []).length === 2);
check("D03 migration: ledger has RLS on, no policies, no direct grants", /ENABLE ROW LEVEL SECURITY/.test(sql) && !/CREATE POLICY/i.test(sql) && /REVOKE ALL ON TABLE public\.scan_admissions FROM anon, authenticated, service_role;/.test(sql));
check("D04 migration: admissions serialized with a transaction-scoped advisory lock", /pg_advisory_xact_lock\(hashtext\('cbc_scan_admission'\)\)/.test(sql));
check("D05 migration: limits 500 / 200 / 50 per rolling 24 hours",
  /c_global_limit constant integer := 500;/.test(sql) && /c_org_limit\s+constant integer := 200;/.test(sql) && /c_user_limit\s+constant integer := 50;/.test(sql) && /interval '24 hours'/.test(sql));
check("D06 migration: user derived from auth.uid(), never a parameter", /v_user\s+uuid := auth\.uid\(\);/.test(sql) && /cbc_admit_scan\(p_input_type text\)/.test(sql));

console.log(`\n=== Gate 007A rate limit: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
