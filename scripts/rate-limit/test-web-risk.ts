// Gate 007A - offline behavioural tests for the REAL Google Web Risk module (lib/scan/providers/googleWebRisk.ts).
// The other suites cover this module statically (test-provider-budget.ts S01-S11) or through a mock
// (test-scan-flow.ts V05). This suite runs the module itself, with globalThis.fetch replaced by a recording fake:
// no network, no paid request, no real key (the key below is a fixed dummy string).
//
// Why it matters for Gate 006C: Azure staging never receives GOOGLE_WEB_RISK_API_KEY (web-app.bicep
// injectWebRiskKey: false). Staging's "no paid request" guarantee therefore rests on callWebRiskGuarded()
// short-circuiting BEFORE any reservation or request when the key is absent (W01-W03).
// Run: node --conditions=react-server --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/rate-limit/test-web-risk.ts
import { register } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The module imports "@/lib/..." (the tsconfig path alias Next resolves). Plain Node does not, so a resolve hook
// maps "@/x" to "<repo>/x.ts" for this process only. No dependency, no package.json change.
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const hook = `
  export async function resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(new URL(spec.slice(2) + ".ts", ${JSON.stringify(pathToFileURL(ROOT + "/").href)}).href, ctx);
    return next(spec, ctx);
  }`;
if (!existsSync(path.join(ROOT, "lib/security/providerBudget.ts"))) throw new Error("repository layout changed");
register("data:text/javascript," + encodeURIComponent(hook));
const { callWebRiskGuarded, googleWebRiskProvider } = await import("../../lib/scan/providers/googleWebRisk.ts");

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, info = ""): void {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}${info ? `  [${info}]` : ""}`); }
}

const DUMMY_KEY = "dummy-web-risk-key-for-offline-tests-0001";
const ADMISSION = "42";
type Call = { url: string; init: RequestInit | undefined };
const calls: Call[] = [];
let respond: (call: Call) => Promise<Response> = async () => { throw new Error("no fake response configured"); };
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const call = { url: String(url), init };
  calls.push(call);
  return respond(call);
}) as typeof fetch;

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const textResponse = (status: number, text: string) =>
  ({ ok: false, status, json: async () => { throw new Error("not json"); }, text: async () => text }) as unknown as Response;

type Reserve = Parameters<typeof callWebRiskGuarded>[0]["reserve"];
function reserver(data: unknown, error: unknown = null) {
  const seen = { n: 0, provider: "", admission: "", signal: undefined as AbortSignal | undefined };
  const fn: Reserve = async (p, id, sig) => { seen.n++; seen.provider = p; seen.admission = id; seen.signal = sig; return { data, error }; };
  return { fn, seen };
}
const GRANT = [{ granted: true, reason: "granted", reservation_id: 7 }];
const EXHAUSTED = [{ granted: false, reason: "provider_budget_exhausted", retry_after_seconds: 120 }];

function setKey(v: string | undefined) {
  if (v === undefined) delete process.env.GOOGLE_WEB_RISK_API_KEY; else process.env.GOOGLE_WEB_RISK_API_KEY = v;
}
const before = () => calls.length;

async function main() {
  // ---- no key: the Gate 006C staging configuration --------------------------------------------------------
  for (const [label, key] of [["W01 key unset", undefined], ["W02 key empty string", ""]] as const) {
    setKey(key);
    const r = reserver(GRANT); const n0 = before();
    const out = await callWebRiskGuarded({ admissionId: ADMISSION, url: "https://example.com/", reserve: r.fn });
    check(`${label} -> no reservation, no request`, r.seen.n === 0 && calls.length === n0, `reserve=${r.seen.n} fetch=${calls.length - n0}`);
    const res = "result" in out ? out.result : undefined;
    check(`${label} -> skipped result, never clean/safe, called=false`,
      out.called === false && "notConfigured" in out && res?.verdict === "skipped" && res.skipped === true, JSON.stringify(out));
  }
  {
    // No key and no valid admission: still no reservation attempt (the key check is first).
    setKey(undefined);
    const r = reserver(GRANT); const n0 = before();
    await callWebRiskGuarded({ admissionId: undefined, url: "https://example.com/", reserve: r.fn });
    check("W03 key unset, no admission -> no reservation, no request", r.seen.n === 0 && calls.length === n0);
  }

  // ---- key present: the reservation decides -----------------------------------------------------------------
  setKey(DUMMY_KEY);
  for (const [label, data, error] of [
    ["W04 budget exhausted", EXHAUSTED, null],
    ["W05 reservation RPC error", null, { message: "permission denied" }],
    ["W06 unexpected reservation shape", [{ ok: true }], null],
  ] as const) {
    const r = reserver(data, error); const n0 = before();
    const out = await callWebRiskGuarded({ admissionId: ADMISSION, url: "https://example.com/", reserve: r.fn });
    check(`${label} -> one reservation attempt, no request, 503 decision`,
      r.seen.n === 1 && calls.length === n0 && out.called === false && "decision" in out && out.decision.status === 503, JSON.stringify(out));
  }
  {
    const ac = new AbortController(); ac.abort();
    const r = reserver(GRANT); const n0 = before();
    const out = await callWebRiskGuarded({ admissionId: ADMISSION, url: "https://example.com/", reserve: r.fn, signal: ac.signal });
    check("W07 deadline already passed -> no reservation, no request, deadline_exceeded",
      r.seen.n === 0 && calls.length === n0 && "decision" in out && out.decision.reason === "deadline_exceeded");
  }
  {
    // A non-numeric admission id never reaches the reservation RPC (p_admission_id is a bigint).
    const r = reserver(GRANT); const n0 = before();
    await callWebRiskGuarded({ admissionId: "1; select 1", url: "https://example.com/", reserve: r.fn });
    check("W08 malformed admission id -> no reservation, no request", r.seen.n === 0 && calls.length === n0);
  }

  // ---- granted: exactly one request, key in a header only ---------------------------------------------------
  {
    respond = async () => jsonResponse(200, {});
    const r = reserver(GRANT); const n0 = before();
    const target = "https://evil.example/a?x=1&threatTypes=NONE&key=leak#frag";
    const out = await callWebRiskGuarded({ admissionId: ADMISSION, url: target, reserve: r.fn });
    const c = calls[calls.length - 1];
    check("W09 grant -> exactly one reservation for google_web_risk with the admission id, then exactly one request",
      r.seen.n === 1 && r.seen.provider === "google_web_risk" && r.seen.admission === ADMISSION && calls.length === n0 + 1);
    const u = new URL(c.url);
    check("W10 request goes to webrisk.googleapis.com/v1/uris:search over https",
      u.protocol === "https:" && u.host === "webrisk.googleapis.com" && u.pathname === "/v1/uris:search", c.url);
    check("W11 API key is sent only in X-Goog-Api-Key, never in the URL",
      (c.init?.headers as Record<string, string>)?.["X-Goog-Api-Key"] === DUMMY_KEY && !c.url.includes(DUMMY_KEY) && !u.searchParams.has("key"));
    check("W12 the target is one encoded uri parameter: it cannot inject query parameters",
      u.searchParams.getAll("uri").length === 1 && u.searchParams.get("uri") === target &&
      JSON.stringify(u.searchParams.getAll("threatTypes")) === '["MALWARE","SOCIAL_ENGINEERING","UNWANTED_SOFTWARE"]', c.url);
    check("W13 GET, redirects refused, abortable", c.init?.method === "GET" && c.init?.redirect === "error" && c.init?.signal instanceof AbortSignal);
    check("W14 empty threat response -> clean (not dangerous), reservation id returned",
      out.called === true && "reservationId" in out && out.reservationId === "7" && out.result.verdict === "clean", JSON.stringify(out));
  }
  {
    respond = async () => jsonResponse(200, { threat: { threatTypes: ["SOCIAL_ENGINEERING"] } });
    const out = await callWebRiskGuarded({ admissionId: ADMISSION, url: "https://phish.example/", reserve: reserver(GRANT).fn });
    check("W15 flagged response -> dangerous with the threat type", out.called === true && "result" in out &&
      out.result.verdict === "dangerous" && out.result.threatType === "SOCIAL_ENGINEERING");
  }
  {
    const huge = "E".repeat(5000);
    respond = async () => textResponse(429, huge);
    const out = await callWebRiskGuarded({ admissionId: ADMISSION, url: "https://example.com/", reserve: reserver(GRANT).fn });
    const res = "result" in out ? out.result : undefined;
    const stored = JSON.stringify(res?.rawResponse ?? "");
    check("W16 non-OK response -> error verdict (never clean), no upstream body persisted",
      res?.verdict === "error" && res.error === "API error 429" &&
      stored === '{"status":429}' && !JSON.stringify(res).includes(huge), JSON.stringify(res));
  }
  {
    // Google answers errors (bad key, quota) with a JSON body; it must never be read as "no threat".
    respond = async () => jsonResponse(403, { error: { code: 403, message: "API key not valid.", status: "PERMISSION_DENIED" } });
    const out = await callWebRiskGuarded({ admissionId: ADMISSION, url: "https://example.com/", reserve: reserver(GRANT).fn });
    const res = "result" in out ? out.result : undefined;
    check("W16b JSON error response (403) -> error verdict with the status, never clean", res?.verdict === "error" && /403/.test(res?.error ?? ""), JSON.stringify(res));
  }
  {
    respond = async () => { throw new TypeError("fetch failed: redirect mode is set to error"); };
    const out = await callWebRiskGuarded({ admissionId: ADMISSION, url: "https://example.com/", reserve: reserver(GRANT).fn });
    const res = "result" in out ? out.result : undefined;
    check("W17 network error or refused redirect -> error verdict, key not in any stored field",
      res?.verdict === "error" && !JSON.stringify(res).includes(DUMMY_KEY));
  }
  {
    // A fetch exception can echo the API key, scanned URL or headers. None may be persisted.
    const privateUrl = "https://private.example/secret-path?session=private-token";
    respond = async () => { throw new Error(`request failed: ${DUMMY_KEY} ${privateUrl}`); };
    const out = await callWebRiskGuarded({ admissionId: ADMISSION, url: privateUrl, reserve: reserver(GRANT).fn });
    const res = "result" in out ? out.result : undefined;
    const persisted = JSON.stringify(res);
    check("W21 network exceptions never persist the key, target URL or exception text",
      res?.verdict === "error" && res.error === "Provider request failed" &&
      !persisted.includes(DUMMY_KEY) && !persisted.includes(privateUrl) &&
      !persisted.includes("request failed:"), persisted);
  }
  {
    // The upstream body may contain sensitive request metadata. Do not even read it.
    let bodyReads = 0;
    const secretBody = `sensitive upstream details: ${DUMMY_KEY}`;
    respond = async () => ({
      ok: false, status: 401,
      text: async () => { bodyReads++; return secretBody; },
    }) as unknown as Response;
    const out = await callWebRiskGuarded({ admissionId: ADMISSION, url: "https://example.com/", reserve: reserver(GRANT).fn });
    const res = "result" in out ? out.result : undefined;
    check("W22 upstream HTTP error body is never read or persisted",
      bodyReads === 0 && res?.verdict === "error" && res.error === "API error 401" &&
      JSON.stringify(res.rawResponse) === '{"status":401}' &&
      !JSON.stringify(res).includes(DUMMY_KEY), JSON.stringify(res));
  }
  {
    // The deadline fires while the request is in flight: the request's own signal must abort.
    const ac = new AbortController();
    respond = (c) => new Promise<Response>((_, reject) => {
      const sig = c.init?.signal;
      sig?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      setTimeout(() => ac.abort(), 5);
    });
    const t0 = Date.now();
    const out = await callWebRiskGuarded({ admissionId: ADMISSION, url: "https://example.com/", reserve: reserver(GRANT).fn, signal: ac.signal });
    const res = "result" in out ? out.result : undefined;
    check("W18 deadline during the request -> request aborted promptly, timed-out error (never clean)",
      Date.now() - t0 < 2000 && res?.verdict === "error" && res.error === "Timeout", JSON.stringify(res));
  }

  // ---- the provider object never makes a request ------------------------------------------------------------
  {
    const n0 = before();
    const res = await googleWebRiskProvider.run("https://example.com/", "url");
    check("W19 googleWebRiskProvider.run() makes no request and returns an error verdict", calls.length === n0 && res.verdict === "error");
    check("W20 googleWebRiskProvider is marked paid", googleWebRiskProvider.paid === true);
  }

  setKey(undefined);
  console.log(`\n=== Gate 007A web risk: ${passed} passed, ${failed} failed ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

// A promise that never settles must not end the run with exit code 0 (same harness rule as the other suites).
let finished = false;
process.on("beforeExit", () => { if (!finished) { console.log("FAIL: run did not finish"); process.exitCode = 1; } });
main().then(() => { finished = true; }, (e) => { finished = true; console.log(`FAIL: unexpected error ${String(e)}`); process.exitCode = 1; });
