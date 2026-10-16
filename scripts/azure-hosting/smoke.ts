/**
 * Gate 006B - signed-out smoke checks against a running CheckBeforeClick web
 * container (Gate 006A smoke matrix S1-S3 plus signed-out API guards).
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/azure-hosting/smoke.ts http://127.0.0.1:3000 [public-origin]
 *
 * public-origin (optional, e.g. the staging https://<fqdn>): also assert that the
 * auth callback redirects to that origin, i.e. NEXT_PUBLIC_APP_URL was built in.
 *
 * Read-only: GET requests plus one unauthenticated POST that the API rejects
 * before touching any data. Sends no cookies or credentials. Signed-in checks
 * (S4-S12) are manual and founder-run against staging.
 */
export {};
const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\/[^/]+$/.test(base)) {
  console.error("usage: smoke.ts <base-url, e.g. http://127.0.0.1:3000> [public-origin]");
  process.exit(2);
}
const publicOrigin = (process.argv[3] ?? "").replace(/\/$/, "");
if (publicOrigin && !/^https:\/\/[^/]+$/.test(publicOrigin)) {
  console.error("public-origin must be an https origin without a path");
  process.exit(2);
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Expect = { status: number | number[]; location?: RegExp; body?: RegExp };
const cases: Array<[string, string, RequestInit, Expect]> = [
  ["S1 healthz", "/api/healthz", {}, { status: 200, body: /"status":"ok"/ }],
  ["S2 / redirects signed-out user to login", "/", {}, { status: [307, 308], location: /\/login/ }],
  ["S2 /login renders", "/login", {}, { status: 200, body: /<html/i }],
  ["S2 /register renders", "/register", {}, { status: 200, body: /<html/i }],
  ["S3 /dashboard redirects to login", "/dashboard", {}, { status: 307, location: /\/login\?next=%2Fdashboard|\/login\?next=\/dashboard/ }],
  ["S3 /history redirects to login", "/history", {}, { status: 307, location: /\/login\?next=/ }],
  ["API POST /api/scan signed-out -> 401", "/api/scan", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "url", target: "https://example.com" }),
  }, { status: 401 }],
  ["API GET /api/scan -> 405", "/api/scan", {}, { status: 405 }],
  ["API scan status signed-out -> 401", "/api/scan/00000000-0000-0000-0000-000000000000/status", {}, { status: 401 }],
  // No code: redirects to login without calling Supabase. A 500 here means an empty
  // NEXT_PUBLIC_APP_URL was inlined (PR #32 review regression).
  ["Auth callback without code -> login", "/auth/callback", {}, {
    status: 307,
    location: publicOrigin ? new RegExp(`^${escapeRe(publicOrigin)}/login$`) : /\/login$/,
  }],
];

let failed = 0;
for (const [name, p, init, exp] of cases) {
  try {
    const res = await fetch(base + p, { ...init, redirect: "manual" });
    const want = Array.isArray(exp.status) ? exp.status : [exp.status];
    const loc = res.headers.get("location") ?? "";
    const body = exp.body ? await res.text() : "";
    const ok = want.includes(res.status) &&
      (!exp.location || exp.location.test(loc)) &&
      (!exp.body || exp.body.test(body));
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${res.status}${loc ? ` -> ${loc}` : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${(e as Error).message}`);
  }
}
console.log(`\n${cases.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
