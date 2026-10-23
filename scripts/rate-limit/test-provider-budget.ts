// Gate 007A - offline tests for the execution-time Web Risk budget (Codex cycle 3 P2 fix).
// No network, no database, no new dependency. Behaviour is tested on the pure guard with counting mocks; the
// "only one guarded path reaches Web Risk" property is tested statically over the application source.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/rate-limit/test-provider-budget.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { guardedPaidCall, interpretReservation, PROVIDER_BUDGET_24H, WEB_RISK_PROVIDER } from "../../lib/security/providerBudget.ts";
import { interpretAdmission } from "../../lib/security/rateLimit.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, info = ""): void {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}${info ? `  [${info}]` : ""}`); }
}
const root = path.resolve(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

// counting mocks
function mocks(reserveResult: () => Promise<{ data: unknown; error: unknown }>) {
  const n = { reserve: 0, call: 0 };
  return {
    n,
    reserve: async (_p: string, _a: string) => { n.reserve++; return reserveResult(); },
    call: async () => { n.call++; return "RESULT"; },
  };
}
const grant = (id: number | string = 41) => async () => ({ data: [{ granted: true, reason: "granted", retry_after_seconds: 0, reservation_id: id }], error: null });
const refuse = (reason: string, retry = 0) => async () => ({ data: [{ granted: false, reason, retry_after_seconds: retry, reservation_id: null }], error: null });

// ---- one reservation -> at most one request ----------------------------------------------------------------
{
  const m = mocks(grant());
  const o = await guardedPaidCall({ provider: WEB_RISK_PROVIDER, admissionId: "7", reserve: m.reserve, call: m.call });
  check("B01 granted reservation -> exactly one reservation and exactly one request", o.called && m.n.reserve === 1 && m.n.call === 1 && o.called === true && o.result === "RESULT" && o.reservationId === "41");
}
{
  const m = mocks(refuse("provider_budget_exhausted", 4321));
  const o = await guardedPaidCall({ provider: WEB_RISK_PROVIDER, admissionId: "7", reserve: m.reserve, call: m.call });
  check("B02 budget exhausted -> NO request, 503 provider_budget_exhausted with Retry-After from the database",
    !o.called && m.n.call === 0 && o.decision.status === 503 && o.decision.reason === "provider_budget_exhausted" && o.decision.retryAfterSeconds === 4321);
}
for (const [label, fn] of [
  ["B03 reservation RPC error (e.g. function not deployed)", async () => ({ data: null, error: { message: "function does not exist" } })],
  ["B04 reservation call throws", async () => { throw new Error("network down"); }],
  ["B05 null data", async () => ({ data: null, error: null })],
  ["B06 empty array", async () => ({ data: [], error: null })],
  ["B07 granted:true without reservation_id", async () => ({ data: [{ granted: true, reason: "granted", reservation_id: null }], error: null })],
  ["B08 granted:true with an unexpected reason", async () => ({ data: [{ granted: true, reason: "ok", reservation_id: 5 }], error: null })],
  ["B09 granted as a string", async () => ({ data: [{ granted: "true", reason: "granted", reservation_id: 5 }], error: null })],
  ["B10 already_reserved (duplicate for this admission)", refuse("already_reserved")],
  ["B11 admission_not_valid (foreign or older than 10 minutes)", refuse("admission_not_valid")],
  ["B12 unauthenticated", refuse("unauthenticated")],
  ["B13 unknown_provider", refuse("unknown_provider")],
  ["B14 unknown future reason", refuse("something_new", 9)],
] as Array<[string, () => Promise<{ data: unknown; error: unknown }>]>) {
  const m = mocks(fn);
  const o = await guardedPaidCall({ provider: WEB_RISK_PROVIDER, admissionId: "7", reserve: m.reserve, call: m.call });
  check(`${label} -> NO request, fail closed with 503`, !o.called && m.n.call === 0 && o.decision.status === 503);
}
for (const bad of [undefined, "", "abc", "1; drop table x", "-5", "12345678901234567890123"]) {
  const m = mocks(grant());
  const o = await guardedPaidCall({ provider: WEB_RISK_PROVIDER, admissionId: bad as string | undefined, reserve: m.reserve, call: m.call });
  check(`B15 invalid admission id ${JSON.stringify(bad)} -> no reservation attempt and no request`, !o.called && m.n.reserve === 0 && m.n.call === 0);
}
{
  const m = mocks(grant());
  let threw = false;
  try { await guardedPaidCall({ provider: WEB_RISK_PROVIDER, admissionId: "7", reserve: m.reserve, call: async () => { m.n.call++; throw new Error("aborted"); } }); } catch { threw = true; }
  check("B16 a failing/aborted request is NOT retried (1 reservation, 1 request)", threw && m.n.reserve === 1 && m.n.call === 1);
}
{
  // Duplicate execution inside one request: a fake ledger enforcing one reservation per admission.
  const used = new Set<string>(); let requests = 0;
  const reserve = async (_p: string, a: string) => (used.has(a) ? { data: [{ granted: false, reason: "already_reserved" }], error: null } : (used.add(a), { data: [{ granted: true, reason: "granted", reservation_id: used.size }], error: null }));
  const call = async () => { requests++; return "R"; };
  const o1 = await guardedPaidCall({ provider: WEB_RISK_PROVIDER, admissionId: "99", reserve, call });
  const o2 = await guardedPaidCall({ provider: WEB_RISK_PROVIDER, admissionId: "99", reserve, call });
  check("B17 a second guarded call for the same admission makes NO second request", o1.called && !o2.called && requests === 1);
}
{
  // Atomic budget under concurrency: a fake ledger with the 1000 cap; 1300 parallel guarded calls.
  let reserved = 0; let requests = 0;
  const reserve = async () => { await Promise.resolve(); if (reserved >= PROVIDER_BUDGET_24H) return { data: [{ granted: false, reason: "provider_budget_exhausted", retry_after_seconds: 60 }], error: null }; reserved++; return { data: [{ granted: true, reason: "granted", reservation_id: reserved }], error: null }; };
  const call = async () => { requests++; return "R"; };
  const all = await Promise.all(Array.from({ length: 1300 }, (_, i) => guardedPaidCall({ provider: WEB_RISK_PROVIDER, admissionId: String(i + 1), reserve, call })));
  check("B18 1300 parallel calls against a 1000 budget -> exactly 1000 requests, 300 refused with 503", requests === 1000 && all.filter((o) => !o.called).length === 300);
}
check("B19 interpretReservation: granted row -> reservation id", (() => { const d = interpretReservation({ granted: true, reason: "granted", reservation_id: 8 }, null); return d.granted && d.reservationId === "8"; })());
check("B20 admission decision now carries the admission id that funds the reservation", (() => { const d = interpretAdmission([{ admitted: true, reason: "admitted", retry_after_seconds: 0, provider_calls_reserved: 1, admission_id: 123 }], null); return d.allowed && d.admissionId === "123"; })());

// ---- static: the only path to Google Web Risk is the guarded one ------------------------------------------
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const appFiles = ["app", "lib", "src", "inngest", "components"].flatMap((d) => walk(path.join(root, d))).concat([path.join(root, "proxy.ts")]);
const rel = (p: string) => path.relative(root, p).split(path.sep).join("/");
const withHost = appFiles.filter((f) => readFileSync(f, "utf8").includes("webrisk.googleapis.com")).map(rel);
check("S01 'webrisk.googleapis.com' appears only in lib/scan/providers/googleWebRisk.ts", withHost.length === 1 && withHost[0] === "lib/scan/providers/googleWebRisk.ts", withHost.join(", "));
const wr = read("lib/scan/providers/googleWebRisk.ts");
const fetchCalls = wr.match(/\bfetch\(/g) ?? [];
const fnStart = wr.indexOf("async function fetchWebRisk(");
const fnEnd = wr.indexOf("export type WebRiskReserve");
check("S02 the module makes exactly one fetch, inside fetchWebRisk", fetchCalls.length === 1 && wr.indexOf("fetch(") > fnStart && wr.indexOf("fetch(") < fnEnd);
check("S03 fetchWebRisk is not exported", !/export\s+(async\s+)?function\s+fetchWebRisk/.test(wr) && !/export\s*\{[^}]*fetchWebRisk/.test(wr));
const exportsWr = [...wr.matchAll(/^export\s+(?:async\s+)?(?:function|const|type)\s+(\w+)/gm)].map((m) => m[1]).sort();
check("S04 the module exports only callWebRiskGuarded, WebRiskReserve and googleWebRiskProvider", exportsWr.join(",") === "WebRiskReserve,callWebRiskGuarded,googleWebRiskProvider", exportsWr.join(","));
check("S05 fetchWebRisk is called only by the guard (call: () => fetchWebRisk(args.url))", (wr.match(/fetchWebRisk\(/g) ?? []).length === 2 && wr.includes("call: () => fetchWebRisk(args.url)"));
const runBody = wr.slice(wr.indexOf("async run()"));
check("S06 the provider's run() makes no request", !/fetch/.test(runBody.slice(0, runBody.indexOf("},") + 2)) && /Reservation required/.test(runBody));
check("S07 googleWebRiskProvider is marked paid", /paid: true,/.test(wr));
check("S08 the request is cancelled after 7 s (AbortController + signal)", /new AbortController\(\)/.test(wr) && /signal: controller\.signal/.test(wr) && /const TIMEOUT_MS = 7000/.test(wr) && /const TIMEOUT_MS = 7000/.test(read("lib/scan/providers/domainAge.ts")));
const importers = appFiles.filter((f) => /callWebRiskGuarded/.test(readFileSync(f, "utf8"))).map(rel).sort();
check("S09 only the scan route (and the provider module) reference callWebRiskGuarded", importers.join(",") === "app/api/scan/route.ts,lib/scan/providers/googleWebRisk.ts", importers.join(","));
const runCallers = appFiles.filter((f) => /\bprovider\.run\(/.test(readFileSync(f, "utf8"))).map(rel).sort();
check("S10 provider.run( is used only by the scan route and the worker", runCallers.join(",") === "app/api/scan/route.ts,inngest/functions/processScan.ts", runCallers.join(","));
const worker = read("inngest/functions/processScan.ts");
check("S11 the worker filters out paid providers and never imports the Web Risk module", /withoutPaidProviders\(/.test(worker) && !/googleWebRisk|callWebRiskGuarded/.test(worker));
check("S12 withoutPaidProviders removes every provider marked paid", /providers\.filter\(\(p\) => p\.paid !== true\)/.test(read("lib/scan/providers/index.ts")));
const route = read("app/api/scan/route.ts");
check("S13 the scan route no longer queues scans to Inngest", !/inngest/.test(route));
check("S14 the scan route sets maxDuration = 30", /export const maxDuration = 30/.test(route));
check("S15 paid providers in the route go only through the guard", /if \(provider\.paid !== true\) return provider\.run\(/.test(route) && /callWebRiskGuarded\(\{ admissionId: admission_id, url: providerInput, reserve \}\)/.test(route));
check("S16 the reservation uses the user's session RPC cbc_reserve_provider_call (never the service role)", /authClient\.rpc\("cbc_reserve_provider_call"/.test(route) && !/createPrivilegedClient|SUPABASE_SERVICE_ROLE_KEY/.test(route));
const iRef = route.indexOf("if (budget.refused)");
check("S17 a refused budget fails the scan and returns 503 before any verdict is computed",
  iRef > 0 && route.indexOf("await failScan(", iRef) > iRef && route.indexOf("status: 503", iRef) > iRef && route.indexOf("calculateConfidenceFromProviders", iRef) > route.indexOf("status: 503", iRef));
const sql = read("infra/supabase/migrations/001_scan_admission.sql");
check("D01 reservation function: SECURITY DEFINER, pinned search_path, execute for authenticated only",
  /cbc_reserve_provider_call\(p_provider text, p_admission_id bigint\)[\s\S]*SECURITY DEFINER\s+SET search_path = pg_catalog, public/.test(sql)
  && /REVOKE ALL ON FUNCTION public\.cbc_reserve_provider_call\(text, bigint\) FROM PUBLIC;/.test(sql)
  && /REVOKE ALL ON FUNCTION public\.cbc_reserve_provider_call\(text, bigint\) FROM anon;/.test(sql)
  && /GRANT EXECUTE ON FUNCTION public\.cbc_reserve_provider_call\(text, bigint\) TO authenticated;/.test(sql));
check("D02 reservation ledger: RLS on, no policies, no grants (incl. service_role), one per admission",
  /ALTER TABLE public\.provider_call_reservations ENABLE ROW LEVEL SECURITY;/.test(sql) && !/CREATE POLICY/i.test(sql)
  && /REVOKE ALL ON TABLE public\.provider_call_reservations FROM anon, authenticated, service_role;/.test(sql)
  && /UNIQUE \(provider, admission_id\)/.test(sql));
check("D03 budget 1000 per rolling 24 h, admission <= 10 minutes old, caller-owned, advisory lock",
  /c_daily_budget\s+constant integer := 1000;/.test(sql) && /c_admission_max_age constant interval := interval '10 minutes';/.test(sql)
  && /a\.user_id = v_user/.test(sql) && /pg_advisory_xact_lock\(hashtext\('cbc_provider_budget:google_web_risk'\)\)/.test(sql));

console.log(`\n=== Gate 007A provider budget: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
