// Gate 007A - offline behavioral tests for the POST /api/scan request flow (lib/scan/scanFlow.ts).
// No network, no database, no new dependency. Real modules are used wherever they are pure: the rate limiter and
// admission interpreter, the provider budget guard, URL normalization (SSRF rules) and the scoring helpers. Only
// I/O is faked: Supabase auth, the two RPCs, scan persistence and the Web Risk request itself.
// Run: node --conditions=react-server --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/rate-limit/test-scan-flow.ts
// (--conditions=react-server lets the server-only marker in lib/security/urlSafety.ts load outside Next.)
import { handleScanRequest, MAX_INPUT_LENGTH, type ScanFlowDeps, type ScanResponse, type PaidOutcome } from "../../lib/scan/scanFlow.ts";
import { admitScan, createSlidingWindowLimiter, rateLimitHeaders } from "../../lib/security/rateLimit.ts";
import { guardedPaidCall, WEB_RISK_PROVIDER } from "../../lib/security/providerBudget.ts";
import { normalizeScanTarget } from "../../lib/security/urlSafety.ts";
import {
  calculateConfidenceFromProviders,
  calculateRiskScoreFromProviders,
  buildEvidenceItem,
  buildVendorResultRow,
} from "../../lib/scan/scanHelpers.ts";
import type { ScanProvider, ScanProviderResult } from "../../lib/scan/providers/types.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, info = ""): void {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}${info ? `  [${info}]` : ""}`); }
}

// ---- fakes ------------------------------------------------------------------------------------------------
const clean = (impact = 30): ScanProviderResult => ({
  verdict: "clean", scoreImpact: 0, confidenceImpact: impact, evidenceTitle: "clean", evidenceDetail: "clean",
  evidenceSeverity: "good", rawResponse: null, responseTimeMs: 1,
});
const flagged: ScanProviderResult = {
  verdict: "dangerous", threatType: "MALWARE", scoreImpact: 65, confidenceImpact: 30, evidenceTitle: "Flagged",
  evidenceDetail: "MALWARE", evidenceSeverity: "critical", rawResponse: null, responseTimeMs: 1,
};
const timedOut: ScanProviderResult = {
  verdict: "error", error: "Timeout", scoreImpact: 0, confidenceImpact: -15, evidenceTitle: "timed out",
  evidenceDetail: "timed out", evidenceSeverity: "info", rawResponse: null, responseTimeMs: 7000,
};

function provider(name: string, paid: boolean, run: (input: string) => Promise<ScanProviderResult>): ScanProvider {
  return {
    name, displayName: name, path: "fast", enabled: true, paid, supportedInputTypes: ["url", "domain"],
    privacyLevel: "full_url", sendsFullUrl: true, sendsUrlPath: true, sendsQueryString: true,
    requiresCustomerDisclosure: false, requiresCommercialApproval: false, timeoutMs: 7000,
    run: (input) => run(input),
  };
}

type Ledger = {
  admissions: Map<string, { userId: string; reserved: boolean }>;
  nextId: number;
  perUserCap: number;
  budget: number;
  used: number;
};

type World = ReturnType<typeof makeWorld>;

function makeWorld(opts: {
  user?: { id: string } | null;
  org?: { userId: string; organizationId: string } | null;
  body?: unknown;
  bodyThrows?: boolean;
  admission?: { data: unknown; error: unknown } | "throw";
  ledger?: Ledger;
  burstLimit?: number;
  createScanResult?: string | null;
  webRisk?: ScanProviderResult | "throw";
  webRiskConfigured?: boolean;
  reservation?: { data: unknown; error: unknown } | "throw";
  includeWebRisk?: boolean;
  domainAge?: ScanProviderResult | "throw";
  extraPaidProvider?: boolean;
  persistThrows?: boolean;
  failScanThrows?: boolean;
  markThrows?: boolean;
  getUserThrows?: boolean;
  hangReservation?: boolean;
  deadlineFires?: boolean;
} = {}) {
  const n = { timers: 0, timerMs: 0, cleared: 0, getUser: 0, org: 0, admitRpc: 0, createScan: 0, mark: 0, reserve: 0, webRiskRequest: 0, domainAge: 0, persist: 0, failScan: 0, errors: 0, otherPaid: 0 };
  const seen: { webRiskUrls: string[]; domainAgeUrls: string[]; persisted: any[]; reservedFor: string[] } = { webRiskUrls: [], domainAgeUrls: [], persisted: [], reservedFor: [] };
  const userId = opts.user === undefined ? "user-1" : opts.user?.id;
  const burst = createSlidingWindowLimiter({ limit: opts.burstLimit ?? 5, windowMs: 60_000, reason: "user_burst_limit" });
  let scanSeq = 0;

  const reserve = async (_p: string, admissionId: string) => {
    n.reserve++;
    seen.reservedFor.push(admissionId);
    if (opts.reservation === "throw") throw new Error("rpc down");
    if (opts.hangReservation) return new Promise<never>(() => {});
    if (opts.reservation) return opts.reservation;
    const L = opts.ledger;
    if (L) {
      const a = L.admissions.get(admissionId);
      if (!a || a.userId !== userId) return { data: [{ granted: false, reason: "admission_not_valid", retry_after_seconds: 0, reservation_id: null }], error: null };
      if (a.reserved) return { data: [{ granted: false, reason: "already_reserved", retry_after_seconds: 0, reservation_id: null }], error: null };
      if (L.used >= L.budget) return { data: [{ granted: false, reason: "provider_budget_exhausted", retry_after_seconds: 3600, reservation_id: null }], error: null };
      a.reserved = true; L.used++;
      return { data: [{ granted: true, reason: "granted", retry_after_seconds: 0, reservation_id: L.used }], error: null };
    }
    return { data: [{ granted: true, reason: "granted", retry_after_seconds: 0, reservation_id: 77 }], error: null };
  };

  const webRiskProvider = provider("google_web_risk", true, async () => {
    throw new Error("run() must never be used for a paid provider");
  });
  const otherPaid = provider("other_paid", true, async () => { n.otherPaid++; return clean(); });
  const domainAge = provider("domain_age", false, async (input) => {
    n.domainAge++; seen.domainAgeUrls.push(input);
    if (opts.domainAge === "throw") throw new Error("whois down");
    return opts.domainAge ?? clean(10);
  });

  // Mirrors app/api/scan/route.ts: only google_web_risk has a guarded entry point (callWebRiskGuarded), which skips
  // when no key is configured and otherwise reserves once and requests once (guardedPaidCall).
  const callPaid = async (p: ScanProvider, admissionId: string | undefined, url: string): Promise<PaidOutcome> => {
    if (p.name !== "google_web_risk") throw new Error("No guarded entry point for this paid provider");
    if (opts.webRiskConfigured === false) {
      return { called: false, notConfigured: true, result: { ...timedOut, verdict: "skipped", skipped: true, error: undefined, confidenceImpact: -25 } };
    }
    return guardedPaidCall({
      provider: WEB_RISK_PROVIDER,
      admissionId,
      reserve,
      call: async () => {
        n.webRiskRequest++; seen.webRiskUrls.push(url);
        if (opts.webRisk === "throw") throw new Error("socket hang up");
        return opts.webRisk ?? clean();
      },
    });
  };

  const deps: ScanFlowDeps = {
    getUser: async () => { n.getUser++; if (opts.getUserThrows) throw new Error("auth down"); return opts.user === undefined ? { id: "user-1" } : opts.user; },
    getOrgContext: async (id) => { n.org++; return opts.org === undefined ? { userId: id, organizationId: "org-1" } : opts.org; },
    readBody: async () => { if (opts.bodyThrows) throw new SyntaxError("bad json"); return opts.body === undefined ? { input: "https://example.com/a", input_type: "url" } : opts.body; },
    admit: (uid, inputType) => admitScan({
      userId: uid, inputType, burst,
      callAdmission: async () => {
        n.admitRpc++;
        if (opts.admission === "throw") throw new Error("rpc down");
        if (opts.admission) return opts.admission;
        const L = opts.ledger;
        if (L) {
          const mine = [...L.admissions.values()].filter((a) => a.userId === uid).length;
          if (mine >= L.perUserCap) return { data: [{ admitted: false, reason: "user_daily_limit", retry_after_seconds: 3600, provider_calls_reserved: 0, admission_id: null }], error: null };
          const id = String(L.nextId++);
          L.admissions.set(id, { userId: uid, reserved: false });
          return { data: [{ admitted: true, reason: "admitted", retry_after_seconds: 0, provider_calls_reserved: 1, admission_id: id }], error: null };
        }
        return { data: [{ admitted: true, reason: "admitted", retry_after_seconds: 0, provider_calls_reserved: 1, admission_id: 42 }], error: null };
      },
    }),
    createScan: async () => { n.createScan++; return opts.createScanResult === undefined ? `scan-${++scanSeq}` : opts.createScanResult; },
    markProcessing: async () => { n.mark++; if (opts.markThrows) throw new Error("db down"); },
    normalizeTarget: normalizeScanTarget,
    getProviders: () => [
      ...(opts.includeWebRisk === false ? [] : [webRiskProvider]),
      domainAge,
      ...(opts.extraPaidProvider ? [otherPaid] : []),
    ],
    callPaid,
    scoring: {
      confidence: calculateConfidenceFromProviders,
      risk: calculateRiskScoreFromProviders,
      evidence: buildEvidenceItem,
      vendor: buildVendorResultRow,
    },
    persist: async (input) => { n.persist++; if (opts.persistThrows) throw new Error("insert failed"); seen.persisted.push(input); },
    failScan: async () => { n.failScan++; if (opts.failScanThrows) throw new Error("update failed"); },
    retryHeaders: rateLimitHeaders,
    now: () => 1_000,
    timer: (ms) => {
      n.timers++; n.timerMs = ms;
      return { done: opts.deadlineFires ? Promise.resolve() : new Promise<void>(() => {}), clear: () => { n.cleared++; } };
    },
    logError: () => { n.errors++; },
  };
  return { deps, n, seen, burst };
}

const run = (w: World) => handleScanRequest(w.deps);
const noWork = (w: World) => w.n.createScan === 0 && w.n.reserve === 0 && w.n.webRiskRequest === 0 && w.n.domainAge === 0;
const verdictOf = (r: ScanResponse) => r.body.verdict;

async function main() {
  // ---- authentication, organization, input validation ------------------------------------------------------
  {
    const w = makeWorld({ user: null }); const r = await run(w);
    check("F01 signed out -> 401, nothing admitted, no scan row, no provider call", r.status === 401 && w.n.admitRpc === 0 && noWork(w));
  }
  {
    const w = makeWorld({ org: null }); const r = await run(w);
    check("F02 no organization context -> 403, nothing admitted", r.status === 403 && w.n.admitRpc === 0 && noWork(w));
  }
  for (const [label, o] of [
    ["F03 malformed JSON", { bodyThrows: true }],
    ["F04 JSON null body", { body: null }],
    ["F05 JSON array body", { body: [1, 2] }],
    ["F06 unknown input_type", { body: { input: "https://a.com", input_type: "pdf" } }],
    ["F07 input_type not a string", { body: { input: "https://a.com", input_type: ["url"] } }],
    ["F08 missing input", { body: { input_type: "url" } }],
    ["F09 whitespace-only input", { body: { input: "   \n ", input_type: "url" } }],
    ["F10 input not a string", { body: { input: { u: 1 }, input_type: "url" } }],
    ["F11 input over 10,000 characters", { body: { input: "https://a.com/" + "x".repeat(MAX_INPUT_LENGTH), input_type: "url" } }],
  ] as const) {
    const w = makeWorld(o as any); const r = await run(w);
    check(`${label} -> 400, no admission consumed, no scan row`, r.status === 400 && w.n.admitRpc === 0 && noWork(w), String(r.status));
  }
  {
    const w = makeWorld({ body: { input: "https://a.com/" + "x".repeat(MAX_INPUT_LENGTH - 14), input_type: "url" } }); const r = await run(w);
    check("F12 input of exactly 10,000 characters is accepted", r.status === 201, String(r.status));
    const w2 = makeWorld({ body: { input: "https://a.com/" + "x".repeat(MAX_INPUT_LENGTH - 13), input_type: "url" } }); const r2 = await run(w2);
    check("F12b input of 10,001 characters is rejected with 400 before admission", r2.status === 400 && w2.n.admitRpc === 0, String(r2.status));
  }
  {
    const w = makeWorld({ getUserThrows: true }); const r = await run(w);
    check("F13 auth lookup throwing -> JSON 500, no scan row", r.status === 500 && noWork(w) && w.n.errors === 1);
  }

  // ---- burst limit and admission -----------------------------------------------------------------------------
  {
    const w = makeWorld();
    const rs: ScanResponse[] = [];
    for (let i = 0; i < 6; i++) rs.push(await run(w));
    const sixth = rs[5];
    check("F14 5 scans in a minute succeed; the 6th is 429 user_burst_limit with Retry-After",
      rs.slice(0, 5).every((r) => r.status === 201) && sixth.status === 429 && sixth.body.reason === "user_burst_limit" && Number(sixth.headers?.["Retry-After"]) >= 1);
    check("F15 the burst rejection makes no admission RPC, no scan row, no reservation", w.n.admitRpc === 5 && w.n.createScan === 5 && w.n.reserve === 5);
  }
  for (const [label, adm, status, reason] of [
    ["F16 user_daily_limit", { data: [{ admitted: false, reason: "user_daily_limit", retry_after_seconds: 1234, provider_calls_reserved: 0, admission_id: null }], error: null }, 429, "user_daily_limit"],
    ["F17 organization_daily_limit", { data: [{ admitted: false, reason: "organization_daily_limit", retry_after_seconds: 99, provider_calls_reserved: 0, admission_id: null }], error: null }, 429, "organization_daily_limit"],
    ["F18 global_scan_capacity_reached", { data: [{ admitted: false, reason: "global_scan_capacity_reached", retry_after_seconds: 50, provider_calls_reserved: 0, admission_id: null }], error: null }, 503, "global_scan_capacity_reached"],
    ["F19 admission RPC error (e.g. migration missing, PGRST202)", { data: null, error: { code: "PGRST202" } }, 503, "admission_unavailable"],
    ["F20 admission row of unexpected shape", { data: [{ ok: true }], error: null }, 503, "admission_unavailable"],
  ] as const) {
    const w = makeWorld({ admission: adm as any }); const r = await run(w);
    check(`${label} -> ${status} ${reason} with Retry-After, no scan row, no provider call`,
      r.status === status && r.body.reason === reason && !!r.headers?.["Retry-After"] && noWork(w), `${r.status} ${String(r.body.reason)}`);
  }
  {
    const w = makeWorld({ admission: { data: [{ admitted: false, reason: "user_daily_limit", retry_after_seconds: 1234, provider_calls_reserved: 0, admission_id: null }], error: null } });
    const r = await run(w);
    check("F21 Retry-After comes from the database (1234 s)", r.headers?.["Retry-After"] === "1234");
  }
  {
    const w = makeWorld({ admission: "throw" }); const r = await run(w);
    check("F22 admission RPC throwing -> 503 admission_unavailable, fail closed", r.status === 503 && r.body.reason === "admission_unavailable" && noWork(w));
  }
  {
    const w = makeWorld({ createScanResult: null }); const r = await run(w);
    check("F23 scan row cannot be created -> 500, no provider call, no reservation", r.status === 500 && w.n.reserve === 0 && w.n.webRiskRequest === 0 && w.n.domainAge === 0);
  }

  // ---- every input type ------------------------------------------------------------------------------------
  const typed: Array<[string, string, string, string]> = [
    ["url with scheme", "url", "https://example.com/login?x=1", "https://example.com/login?x=1"],
    ["url without scheme", "url", "example.com/path", "https://example.com/path"],
    ["domain", "domain", "Example.COM", "https://example.com/"],
    ["email with a link", "email", "Hi,\nplease verify at https://phish.example.net/verify now.\nThanks", "https://phish.example.net/verify"],
    ["header with a link", "header", "Received: from x\nList-Unsubscribe: <https://list.example.org/u?id=1>", "https://list.example.org/u?id=1"],
    ["signature with a link", "signature", "Jane Doe | https://jane.example.io", "https://jane.example.io/"],
    ["batch (first link only)", "batch", "https://first.example.com/a https://second.example.com/b", "https://first.example.com/a"],
  ];
  for (const [label, type, input, expectUrl] of typed) {
    const w = makeWorld({ body: { input, input_type: type } }); const r = await run(w);
    const ok = r.status === 201 && w.n.reserve === 1 && w.n.webRiskRequest === 1 && w.n.domainAge === 1
      && w.seen.webRiskUrls[0] === expectUrl && w.seen.domainAgeUrls[0] === expectUrl && w.n.persist === 1;
    check(`T-${type} ${label}: 201, one reservation, one Web Risk request on the normalized URL`, ok,
      `${r.status} reserve=${w.n.reserve} wr=${w.n.webRiskRequest} url=${w.seen.webRiskUrls[0]}`);
  }
  for (const [label, type, input] of [
    ["email with no link", "email", "Hello, please call me back about the invoice."],
    ["header with no link", "header", "Received: from mail.example.com by mx"],
    ["domain that is a path", "domain", "example.com/login"],
    ["domain with spaces", "domain", "exa mple.com"],
    ["domain that is an encoded IP", "domain", "2130706433"],
    ["url to loopback", "url", "http://127.0.0.1/admin"],
    ["url to cloud metadata", "url", "http://169.254.169.254/latest/meta-data"],
    ["url to private network", "url", "http://10.0.0.5/"],
    ["url with javascript scheme", "url", "javascript:alert(1)"],
    ["url to localhost", "url", "http://localhost:3000/"],
  ] as const) {
    const w = makeWorld({ body: { input, input_type: type } }); const r = await run(w);
    const p = w.seen.persisted[0];
    check(`N-${label}: 201 unknown, NO reservation and NO provider call, invalid_target evidence`,
      r.status === 201 && verdictOf(r) === "unknown" && w.n.reserve === 0 && w.n.webRiskRequest === 0 && w.n.domainAge === 0
      && p?.evidenceItems?.[0]?.signalType === "invalid_target" && w.n.admitRpc === 1,
      `${r.status} ${String(verdictOf(r))} reserve=${w.n.reserve}`);
  }

  // ---- verdicts ------------------------------------------------------------------------------------------------
  {
    const w = makeWorld(); const r = await run(w);
    check("V01 both required providers clean -> safe (the happy path can still be safe)", r.status === 201 && verdictOf(r) === "safe", String(verdictOf(r)));
  }
  {
    const w = makeWorld({ webRisk: flagged }); const r = await run(w);
    check("V02 Web Risk flag -> dangerous", r.status === 201 && verdictOf(r) === "dangerous");
  }
  {
    const w = makeWorld({ webRisk: timedOut }); const r = await run(w);
    check("V03 Web Risk timeout -> 201 unknown (never safe), exactly one request, no retry", r.status === 201 && verdictOf(r) === "unknown" && w.n.webRiskRequest === 1 && w.n.reserve === 1);
  }
  {
    const w = makeWorld({ webRisk: "throw" }); const r = await run(w);
    check("V04 Web Risk request throwing -> 201 unknown, one request, no retry", r.status === 201 && verdictOf(r) === "unknown" && w.n.webRiskRequest === 1);
  }
  {
    const w = makeWorld({ webRiskConfigured: false }); const r = await run(w);
    check("V05 Web Risk key not configured -> no reservation, no request, verdict not safe", r.status === 201 && verdictOf(r) !== "safe" && w.n.reserve === 0 && w.n.webRiskRequest === 0);
  }
  {
    const w = makeWorld({ includeWebRisk: false }); const r = await run(w);
    check("V06 kill switch (WEB_RISK_PROVIDER_ENABLED=false removes the provider) -> no reservation, verdict not safe", r.status === 201 && verdictOf(r) !== "safe" && w.n.reserve === 0 && w.n.webRiskRequest === 0);
  }
  {
    const w = makeWorld({ domainAge: "throw" }); const r = await run(w);
    check("V07 unpaid provider throwing -> 201, verdict not safe, Web Risk still made exactly once", r.status === 201 && verdictOf(r) !== "safe" && w.n.webRiskRequest === 1);
  }
  {
    const w = makeWorld({ extraPaidProvider: true }); const r = await run(w);
    const vendor = w.seen.persisted[0]?.vendorResults?.find((v: any) => v.vendorName === "other_paid");
    check("V08 a paid provider without a guarded entry point is never run; it is recorded as an error",
      r.status === 201 && w.n.otherPaid === 0 && w.n.webRiskRequest === 1 && vendor?.verdict === "error", String(vendor?.verdict));
  }

  // ---- provider reservation outcomes ---------------------------------------------------------------------------
  for (const [label, res, reason] of [
    ["R01 budget exhausted", { data: [{ granted: false, reason: "provider_budget_exhausted", retry_after_seconds: 3600, reservation_id: null }], error: null }, "provider_budget_exhausted"],
    ["R02 admission not valid (expired / foreign)", { data: [{ granted: false, reason: "admission_not_valid", retry_after_seconds: 0, reservation_id: null }], error: null }, "provider_budget_unavailable"],
    ["R03 already reserved (replay)", { data: [{ granted: false, reason: "already_reserved", retry_after_seconds: 0, reservation_id: null }], error: null }, "provider_budget_unavailable"],
    ["R04 reservation RPC error", { data: null, error: { code: "42883" } }, "provider_budget_unavailable"],
    ["R05 grant without a reservation id", { data: [{ granted: true, reason: "granted", retry_after_seconds: 0, reservation_id: null }], error: null }, "provider_budget_unavailable"],
  ] as const) {
    const w = makeWorld({ reservation: res as any }); const r = await run(w);
    check(`${label} -> 503 ${reason}, NO Web Risk request, scan marked failed, nothing persisted`,
      r.status === 503 && r.body.reason === reason && w.n.webRiskRequest === 0 && w.n.failScan === 1 && w.n.persist === 0 && !!r.headers?.["Retry-After"] && typeof r.body.scan_id === "string",
      `${r.status} ${String(r.body.reason)} wr=${w.n.webRiskRequest}`);
  }
  {
    const w = makeWorld({ reservation: { data: [{ granted: false, reason: "provider_budget_exhausted", retry_after_seconds: 3600, reservation_id: null }], error: null } });
    const r = await run(w);
    check("R06 budget refusal carries the database Retry-After (3600) and no verdict", r.headers?.["Retry-After"] === "3600" && r.body.verdict === undefined);
  }
  {
    const w = makeWorld({ reservation: "throw" }); const r = await run(w);
    check("R07 reservation RPC throwing -> 503, no request", r.status === 503 && w.n.webRiskRequest === 0 && w.n.failScan === 1);
  }
  {
    const w = makeWorld({ admission: { data: [{ admitted: true, reason: "admitted", retry_after_seconds: 0, provider_calls_reserved: 1, admission_id: "12x" }], error: null } });
    const r = await run(w);
    check("R08 malformed admission id -> no reservation attempt, no request, 503", r.status === 503 && w.n.reserve === 0 && w.n.webRiskRequest === 0);
  }
  {
    const w = makeWorld(); await run(w);
    check("R09 the reservation is funded by the admission id the database returned", w.seen.reservedFor.length === 1 && w.seen.reservedFor[0] === "42");
  }

  // ---- failures after the scan row exists -------------------------------------------------------------------------
  {
    const w = makeWorld({ persistThrows: true }); const r = await run(w);
    check("E01 persistence failure -> JSON 500 and the scan is marked failed", r.status === 500 && w.n.failScan === 1 && w.n.errors >= 1);
  }
  {
    const w = makeWorld({ persistThrows: true, failScanThrows: true }); const r = await run(w);
    check("E02 persistence and failScan both failing -> still a JSON 500 (both errors logged)", r.status === 500 && w.n.errors === 2);
  }
  {
    const w = makeWorld({ markThrows: true }); const r = await run(w);
    check("E03 marking the scan processing fails -> 500, scan marked failed, no provider call", r.status === 500 && w.n.failScan === 1 && w.n.reserve === 0 && w.n.domainAge === 0);
  }
  {
    const w = makeWorld({ reservation: { data: null, error: { code: "x" } }, failScanThrows: true }); const r = await run(w);
    check("E04 budget refusal where failScan throws -> 500 JSON, still no Web Risk request", r.status === 500 && w.n.webRiskRequest === 0);
  }

  // ---- deadline inside maxDuration = 30 s ------------------------------------------------------------------------
  {
    const w = makeWorld({ hangReservation: true, deadlineFires: true }); const r = await run(w);
    check("D01 hung reservation RPC -> 504 scan_timeout with scan_id, scan marked failed, nothing persisted, no Web Risk request",
      r.status === 504 && r.body.reason === "scan_timeout" && typeof r.body.scan_id === "string" && w.n.failScan === 1 && w.n.persist === 0 && w.n.webRiskRequest === 0,
      `${r.status} ${String(r.body.reason)}`);
  }
  {
    const w = makeWorld(); await run(w);
    check("D02 the deadline is 20 s (inside maxDuration 30 s) and its timer is cleared on a normal scan", w.n.timers === 1 && w.n.timerMs === 20_000 && w.n.cleared === 1);
  }
  {
    const w = makeWorld({ body: { input: "no link here", input_type: "email" } }); await run(w);
    check("D03 no deadline timer is started when there is nothing to check (no-target path)", w.n.timers === 0);
  }

  // ---- UI contract: app/(dashboard)/scan/new reads only scan_id, then /scan/[id] polls the stored status --------------
  {
    const outcomes: Array<[string, ScanResponse]> = [];
    for (const [label, o] of [
      ["url 201", {}], ["email 201", { body: { input: "see https://a.example/x", input_type: "email" } }],
      ["header 201", { body: { input: "Link: <https://a.example/y>", input_type: "header" } }],
      ["no-link 201", { body: { input: "plain text", input_type: "email" } }],
      ["budget 503", { reservation: { data: [{ granted: false, reason: "provider_budget_exhausted", retry_after_seconds: 5, reservation_id: null }], error: null } }],
      ["timeout 504", { hangReservation: true, deadlineFires: true }],
    ] as const) outcomes.push([label, await run(makeWorld(o as any))]);
    const bad = outcomes.filter(([, r]) => typeof r.body.scan_id !== "string").map(([l]) => l);
    check("U01 every response for a created scan (201 complete, 503 budget, 504 timeout) carries scan_id", bad.length === 0, bad.join(","));
    const terminal = outcomes.filter(([, r]) => r.status === 201).every(([, r]) => r.body.status === "complete");
    check("U02 a 201 means the scan is already terminal (status complete); the result page needs no polling", terminal);
  }

  // ---- concurrency against an atomic ledger -----------------------------------------------------------------------
  {
    const ledger: Ledger = { admissions: new Map(), nextId: 1, perUserCap: 50, budget: 1000, used: 0 };
    const w = makeWorld({ ledger, burstLimit: 1000 });
    const rs = await Promise.all(Array.from({ length: 60 }, () => run(w)));
    const ok = rs.filter((r) => r.status === 201).length;
    const limited = rs.filter((r) => r.status === 429 && r.body.reason === "user_daily_limit").length;
    check("C01 60 parallel scans by one user against a 50/day cap -> exactly 50 succeed, 10 are 429", ok === 50 && limited === 10, `${ok}/${limited}`);
    check("C02 ...with exactly 50 reservations and 50 Web Risk requests (one per admission)", ledger.used === 50 && w.n.webRiskRequest === 50 && w.n.createScan === 50);
  }
  {
    const ledger: Ledger = { admissions: new Map(), nextId: 1, perUserCap: 1000, budget: 30, used: 0 };
    const w = makeWorld({ ledger, burstLimit: 1000 });
    const rs = await Promise.all(Array.from({ length: 50 }, () => run(w)));
    const ok = rs.filter((r) => r.status === 201).length;
    const refused = rs.filter((r) => r.status === 503 && r.body.reason === "provider_budget_exhausted").length;
    check("C03 50 parallel scans against a 30-call budget -> 30 complete, 20 are 503 provider_budget_exhausted", ok === 30 && refused === 20, `${ok}/${refused}`);
    check("C04 ...exactly 30 Web Risk requests; the 20 refused scans are marked failed", w.n.webRiskRequest === 30 && w.n.failScan === 20);
  }
  {
    const ledger: Ledger = { admissions: new Map(), nextId: 1, perUserCap: 50, budget: 1000, used: 0 };
    const w = makeWorld({ ledger });
    ledger.admissions.set("900", { userId: "someone-else", reserved: false });
    const out = await w.deps.callPaid(w.deps.getProviders()[0], "900", "https://example.com/");
    check("C05 another user's admission cannot fund a request", out.called === false && w.n.webRiskRequest === 0);
    ledger.admissions.set("901", { userId: "user-1", reserved: false });
    const first = await w.deps.callPaid(w.deps.getProviders()[0], "901", "https://example.com/");
    const second = await w.deps.callPaid(w.deps.getProviders()[0], "901", "https://example.com/");
    check("C06 replaying one admission makes exactly one request", first.called === true && second.called === false && w.n.webRiskRequest === 1);
  }

  console.log(`\n=== Gate 007A scan flow: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.log(`FAIL: harness error ${(e as Error).stack}`); process.exit(1); });
