// Gate 007A - offline regression tests for the domain-age RDAP timeout (review CBC-007A-R2-01).
// No network: fetch is replaced by fakes that behave like fetch (they reject when their AbortSignal aborts, also while
// the body is being read). No new dependency.
// Run: node --conditions=react-server --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/rate-limit/test-domain-age.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { lookupDomainAge, domainAgeProvider } from "../../lib/scan/providers/domainAge.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, info = ""): void {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}${info ? `  [${info}]` : ""}`); }
}
const root = path.resolve(import.meta.dirname, "..", "..");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Seen = { url?: string; signal?: AbortSignal; abortedAt?: number; calls: number };
function abortError() { return Object.assign(new Error("This operation was aborted"), { name: "AbortError" }); }
// Never answers on its own; rejects as soon as its signal aborts (the real fetch contract).
function hangingFetch(seen: Seen): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    seen.calls++; seen.url = String(url); seen.signal = init?.signal ?? undefined;
    return new Promise<Response>((_, reject) => {
      const sig = init?.signal;
      if (!sig) return;                                   // without a signal it would hang forever
      const onAbort = () => { seen.abortedAt = Date.now(); reject(abortError()); };
      if (sig.aborted) onAbort(); else sig.addEventListener("abort", onAbort, { once: true });
    });
  }) as typeof fetch;
}
// Answers headers at once, but the body never arrives unless aborted (a slow RDAP server).
function slowBodyFetch(seen: Seen): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    seen.calls++; seen.url = String(url); seen.signal = init?.signal ?? undefined;
    const sig = init?.signal;
    return Promise.resolve({
      ok: true, status: 200,
      json: () => new Promise((_, reject) => { sig?.addEventListener("abort", () => { seen.abortedAt = Date.now(); reject(abortError()); }, { once: true }); }),
    } as unknown as Response);
  }) as typeof fetch;
}
function okFetch(seen: Seen, body: unknown): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    seen.calls++; seen.url = String(url); seen.signal = init?.signal ?? undefined;
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as unknown as Response);
  }) as typeof fetch;
}
const oldDomain = { events: [{ eventAction: "registration", eventDate: "2001-01-01T00:00:00Z" }] };

async function main() {
  {
    const seen: Seen = { calls: 0 }; const t0 = Date.now();
    const r = await lookupDomainAge("example.com", { timeoutMs: 40, fetchImpl: hangingFetch(seen) });
    const took = Date.now() - t0;
    check("A01 the outstanding RDAP fetch receives the abort signal at the timeout", seen.signal?.aborted === true && seen.abortedAt !== undefined);
    check("A02 abort is a provider error: verdict error, 'Timeout', 'Domain age check timed out'",
      r.verdict === "error" && r.error === "Timeout" && r.evidenceTitle === "Domain age check timed out", `${r.verdict} ${r.error}`);
    check("A03 it returns at the timeout, not later (cancelled, not abandoned)", took >= 35 && took < 1000, String(took));
    check("A04 exactly one request, no retry", seen.calls === 1);
  }
  {
    const seen: Seen = { calls: 0 };
    const r = await lookupDomainAge("example.com", { timeoutMs: 40, fetchImpl: slowBodyFetch(seen) });
    check("A05 a slow response body is aborted too (the signal covers reading the body)", seen.signal?.aborted === true && r.error === "Timeout");
  }
  {
    const seen: Seen = { calls: 0 };
    const r = await lookupDomainAge("example.com", { timeoutMs: 40, fetchImpl: okFetch(seen, oldDomain) });
    await sleep(80);                                       // well past the timeout
    check("A06 on success the timer is cleared: the signal is never aborted afterwards", r.verdict === "clean" && seen.signal?.aborted === false);
  }
  {
    const seen: Seen = { calls: 0 };
    const failing = ((url: string, init?: RequestInit) => { seen.calls++; seen.signal = init?.signal ?? undefined; return Promise.reject(new TypeError("fetch failed")); }) as typeof fetch;
    const r = await lookupDomainAge("example.com", { timeoutMs: 1000, fetchImpl: failing });
    check("A07 a network error that is not an abort stays 'could not complete' (not misreported as a timeout)",
      r.verdict === "error" && r.evidenceTitle === "Domain age check could not complete" && seen.signal?.aborted === false);
  }
  {
    // The provider's run() path with the real default wiring: global fetch replaced by a fake for this one call.
    const seen: Seen = { calls: 0 };
    const realFetch = globalThis.fetch;
    globalThis.fetch = okFetch(seen, oldDomain);
    try {
      const r = await domainAgeProvider.run("https://login.example.com/path?q=1", "url");
      check("A08 run() goes through the abortable lookup: fetch receives a signal", seen.signal instanceof AbortSignal && r.verdict === "clean");
      check("A09 privacy unchanged: only the registerable domain is sent (no path, no query)", seen.url === "https://rdap.org/domain/example.com", seen.url);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // ---- static: the race-only timeout is gone -----------------------------------------------------------------------
  const src = readFileSync(path.join(root, "lib/scan/providers/domainAge.ts"), "utf8");
  check("S01 no Promise.race timeout remains in the domain-age provider", !/Promise\.race/.test(src));
  check("S02 fetch is passed the AbortController's signal; the timer aborts it and is cleared in finally",
    /signal,\s*\n\s*\}\)/.test(src) && /setTimeout\(\(\) => controller\.abort\(\), options\.timeoutMs \?\? TIMEOUT_MS\)/.test(src) && /finally \{\s*clearTimeout\(timer\)\s*\}/.test(src));
  check("S03 the default timeout is still 7 s", /const TIMEOUT_MS = 7000/.test(src));
  check("S04 run() calls lookupDomainAge with the defaults", /return await lookupDomainAge\(domain\)/.test(src));

  console.log(`\n=== Gate 007A domain age: ${passed} passed, ${failed} failed ===`);
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
