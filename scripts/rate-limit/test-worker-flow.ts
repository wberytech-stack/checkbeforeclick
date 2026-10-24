// Gate 007A - offline contract tests for the Inngest "process-scan" job (lib/scan/workerFlow.ts) and its wiring.
// No network, no database, no new dependency. Real URL normalization and scoring; only I/O is faked.
// Run: node --conditions=react-server --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/rate-limit/test-worker-flow.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { processScanJob, type WorkerDeps, type WorkerScan } from "../../lib/scan/workerFlow.ts";
import { normalizeScanTarget } from "../../lib/security/urlSafety.ts";
import { calculateConfidenceFromProviders, calculateRiskScoreFromProviders, buildEvidenceItem, buildVendorResultRow } from "../../lib/scan/scanHelpers.ts";
import type { ScanProvider, ScanProviderResult } from "../../lib/scan/providers/types.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, info = ""): void {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}${info ? `  [${info}]` : ""}`); }
}
const root = path.resolve(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const clean: ScanProviderResult = { verdict: "clean", scoreImpact: 0, confidenceImpact: 10, evidenceTitle: "ok", evidenceDetail: "ok", evidenceSeverity: "good", rawResponse: null, responseTimeMs: 1 };
function provider(name: string, paid: boolean, run: (u: string) => Promise<ScanProviderResult>): ScanProvider {
  return { name, displayName: name, path: "fast", enabled: true, paid, supportedInputTypes: ["url", "domain"], privacyLevel: "domain_only",
    sendsFullUrl: false, sendsUrlPath: false, sendsQueryString: false, requiresCustomerDisclosure: false, requiresCommercialApproval: false,
    timeoutMs: 7000, run: (u) => run(u) };
}

function world(scan: Partial<WorkerScan> | null, opts: { insertThrows?: boolean; providerThrows?: boolean; noProviders?: boolean } = {}) {
  const n = { load: 0, mark: 0, paidRun: 0, unpaidRun: 0, evidence: 0, vendor: 0, complete: 0, fail: 0 };
  const seen: { urls: string[]; completed: any[]; evidenceRows: any[] } = { urls: [], completed: [], evidenceRows: [] };
  const row: WorkerScan | null = scan === null ? null : { id: "s1", organization_id: "org-1", raw_input: "https://example.com/a", input_type: "url", status: "pending", ...scan };
  const deps: WorkerDeps = {
    loadScan: async () => { n.load++; return row; },
    markProcessing: async () => { n.mark++; },
    normalizeTarget: normalizeScanTarget,
    getProviders: () => opts.noProviders ? [] : [
      provider("google_web_risk", true, async () => { n.paidRun++; return clean; }),
      provider("domain_age", false, async (u) => { n.unpaidRun++; seen.urls.push(u); if (opts.providerThrows) throw new Error("x"); return clean; }),
    ],
    scoring: { confidence: calculateConfidenceFromProviders, risk: calculateRiskScoreFromProviders, evidence: buildEvidenceItem, vendor: buildVendorResultRow },
    insertEvidence: async (_o, rows) => { n.evidence++; seen.evidenceRows.push(...rows); if (opts.insertThrows) throw new Error("insert failed"); },
    insertVendorResults: async () => { n.vendor++; },
    completeScan: async (_o, _s, r) => { n.complete++; seen.completed.push(r); },
    failScan: async () => { n.fail++; },
    now: () => 0,
  };
  return { deps, n, seen };
}
const runJob = async (w: ReturnType<typeof world>, id: unknown = "s1") => { try { return { ok: true as const, r: await processScanJob(w.deps, id) }; } catch (e) { return { ok: false as const, e: e as Error }; } };

async function main() {
  // ---- per input type (same first-URL handling as master) -----------------------------------------------------
  for (const [type, input, url] of [
    ["url", "https://example.com/a", "https://example.com/a"],
    ["domain", "example.com", "https://example.com/"],
    ["email", "Dear user, verify at https://phish.example.net/v now", "https://phish.example.net/v"],
    ["header", "List-Unsubscribe: <https://list.example.org/u>", "https://list.example.org/u"],
    ["signature", "Jane | https://jane.example.io", "https://jane.example.io/"],
    ["batch", "https://first.example.com/a https://second.example.com/b", "https://first.example.com/a"],
  ] as const) {
    const w = world({ input_type: type, raw_input: input }); const o = await runJob(w);
    check(`W-${type}: completes on the first URL with unpaid providers only; Google Web Risk never runs`,
      o.ok && w.n.complete === 1 && w.n.paidRun === 0 && w.n.unpaidRun === 1 && w.seen.urls[0] === url && w.n.fail === 0,
      `${w.seen.urls[0]} paid=${w.n.paidRun}`);
    check(`W-${type}: a worker verdict is never "safe" (Web Risk is required for safe)`, o.ok && w.seen.completed[0]?.verdict !== "safe", String(w.seen.completed[0]?.verdict));
  }
  for (const [label, type, input] of [["email without a link", "email", "Call me about the invoice"], ["private address", "url", "http://10.0.0.1/"]] as const) {
    const w = world({ input_type: type, raw_input: input }); const o = await runJob(w);
    check(`W-none ${label}: complete/unknown with invalid_target evidence, no provider call`,
      o.ok && w.n.complete === 1 && w.seen.completed[0].verdict === "unknown" && w.seen.evidenceRows[0]?.signal_type === "invalid_target" && w.n.unpaidRun === 0 && w.n.paidRun === 0);
  }
  {
    const w = world({}, { noProviders: true }); const o = await runJob(w);
    check("W-empty no unpaid provider available -> complete/unknown", o.ok && w.n.complete === 1 && w.seen.completed[0].verdict === "unknown");
  }

  // ---- pending-state handling, replays, retries --------------------------------------------------------------------
  for (const status of ["complete", "failed"]) {
    const w = world({ status }); const o = await runJob(w);
    check(`P-${status} replay/re-run of a ${status} scan is a no-op (no status change, no evidence, no provider)`,
      o.ok && "skipped" in o.r && w.n.mark === 0 && w.n.evidence === 0 && w.n.complete === 0 && w.n.fail === 0 && w.n.unpaidRun === 0);
  }
  for (const status of ["pending", "processing", null]) {
    const w = world({ status }); const o = await runJob(w);
    check(`P-${String(status)} a ${String(status)} scan (queued before deploy, or interrupted) is processed to complete`, o.ok && w.n.mark === 1 && w.n.complete === 1);
  }
  {
    const w = world({}, { insertThrows: true }); const o = await runJob(w);
    check("P-error an error marks the scan failed and is rethrown (Inngest retries once)", !o.ok && w.n.fail === 1 && /insert failed/.test(o.e.message));
    const again = world({ status: "failed" }); const o2 = await runJob(again);
    check("P-retry-after-fail the retry of a scan already marked failed is a no-op", o2.ok && "skipped" in o2.r && again.n.fail === 0 && again.n.unpaidRun === 0);
  }
  {
    const w = world({}, { providerThrows: true }); const o = await runJob(w);
    check("P-provider a throwing provider becomes an error result; the scan still completes, never safe", o.ok && w.n.complete === 1 && w.seen.completed[0].verdict !== "safe");
  }
  {
    const w = world(null); const o = await runJob(w);
    check("P-missing an unknown scan id throws before any write", !o.ok && w.n.mark === 0 && w.n.fail === 0);
    const w2 = world({ organization_id: null }); const o2 = await runJob(w2);
    check("P-no-org a scan without organization throws before any write", !o2.ok && w2.n.mark === 0);
    const w3 = world({}); const o3 = await runJob(w3, null);
    check("P-no-id an event without scan_id throws and loads nothing", !o3.ok && w3.n.load === 0);
  }

  // ---- wiring and the queueing contract ---------------------------------------------------------------------------
  const fn = read("inngest/functions/processScan.ts");
  check("X01 process-scan keeps id, retries: 1 and the scan/requested trigger", /id: "process-scan"/.test(fn) && /retries: 1/.test(fn) && /triggers: \[\{ event: "scan\/requested" \}\]/.test(fn));
  check("X02 process-scan delegates to processScanJob with event.data.scan_id", /processScanJob\(/.test(fn) && /event\.data\?\.scan_id/.test(fn));
  check("X03 the worker wiring filters paid providers and never imports the Web Risk module", /withoutPaidProviders\(/.test(fn) && !/googleWebRisk|callWebRiskGuarded/.test(fn));
  check("X04 the worker's scan loader returns status (needed for replay safety)", /\.select\("id, organization_id, raw_input, input_type, status"\)/.test(read("lib/data/index.ts")));
  const wf = read("lib/scan/workerFlow.ts");
  check("X05 workerFlow filters paid providers itself and is pure", /\.filter\(\(p\) => p\.paid !== true\)/.test(wf) && !/^import (?!type )/m.test(wf) && !/process\.env|fetch\(/.test(wf));
  const files: string[] = [];
  const walk = (d: string) => { for (const x of readdirSync(d)) { const f = path.join(d, x); if (statSync(f).isDirectory()) walk(f); else if (/\.(ts|tsx)$/.test(x)) files.push(f); } };
  for (const d of ["app", "lib", "components", "src", "inngest"]) walk(path.join(root, d));
  const senders = files.filter((f) => /inngest\.send\(|\.send\(\s*\{\s*name:\s*"scan\/requested"/.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f).split(path.sep).join("/"));
  check("X06 nothing in the code base sends scan/requested", senders.length === 0, senders.join(","));
  const ui = read("app/(dashboard)/scan/new/page.tsx");
  check("X07 the scan UI reads only scan_id from the response and opens the result page", /router\.push\(`\/scan\/\$\{data\.scan_id\}`\)/.test(ui) && !/data\.(status|verdict)/.test(ui));
  const page = read("app/(dashboard)/scan/[id]/page.tsx");
  check("X08 the result page still polls while pending/processing and shows failed scans", /scan\.status === "pending" \|\| scan\.status === "processing"/.test(page) && /scan\.status === "failed"/.test(page));

  console.log(`\n=== Gate 007A worker flow: ${passed} passed, ${failed} failed ===`);
  finished = true;
  process.exit(failed === 0 ? 0 : 1);
}

// A promise that never settles must not end the run silently: Node would exit with code 0 once the event loop is
// empty, without reaching process.exit above. Any run that did not finish fails.
let finished = false;
process.on("exit", () => {
  if (!finished) { console.log("FAIL: harness did not finish (a pending promise never settled)"); process.exitCode = 1; }
});

main().catch((e) => { console.log(`FAIL: harness error ${(e as Error).stack}`); process.exit(1); });
