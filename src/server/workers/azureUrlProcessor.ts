// Pure URL reputation processor. It NEVER connects to a submitted URL, resolves
// its DNS, follows redirects, or fetches page content. Only the injected threat
// intelligence adapter can make an outbound request to its own pinned endpoint.
import { isIP } from "node:net";
import type { ScanJob, ScanProcessor, ScanCompletion } from "./azureScanWorker";

export type ThreatLookupResult = { threatTypes: string[] };
export type ThreatLookup = (canonicalUrl: string, signal: AbortSignal) => Promise<ThreatLookupResult>;

const ALLOWED_THREATS = new Set([
  "MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "SOCIAL_ENGINEERING_EXTENDED_COVERAGE",
]);
const BLOCKED_SUFFIXES = [
  "localhost", "local", "internal", "test", "invalid", "example", "onion",
  "arpa", "alt", "localdomain", "lan", "corp", "intranet",
];

export function canonicalPublicUrl(raw: string): string | null {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 2048 ||
      raw !== raw.trim() || /[\s\u0000-\u001f\u007f\\]/u.test(raw)) return null;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return null; }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
      !parsed.hostname || (parsed.port && !["80", "443"].includes(parsed.port))) return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host.includes(".") || isIP(host) !== 0 ||
      BLOCKED_SUFFIXES.some(suffix => host === suffix || host.endsWith("." + suffix)) ||
      host.split(".").some(part => !part || part.length > 63 || part.startsWith("-") || part.endsWith("-")) ||
      host.length > 253) return null;
  parsed.hash = ""; // fragments are never sent to a reputation provider
  return parsed.href;
}

function rejected(reason: string): ScanCompletion {
  return {
    status: "failed", verdict: "unknown", riskScore: null, confidenceScore: null,
    explanation: reason, recommendedAction: "Submit a public HTTP(S) URL for a reputation check.",
    durationMs: null, vendorResults: [],
    evidenceItems: [{
      signal_type: "not_scanned", severity: "info", title: "No reputation check performed",
      detail: reason, score_impact: 0,
    }],
  };
}

/** A positive match is dangerous. A negative lookup is UNKNOWN, never safe:
 * absence from a blocklist is not proof that a site is trustworthy. */
export function createUrlReputationProcessor(lookup: ThreatLookup): ScanProcessor {
  return async (job: ScanJob): Promise<ScanCompletion> => {
    if (job.inputType !== "url") return rejected("This worker supports URL scans only.");
    const url = canonicalPublicUrl(job.rawInput);
    if (url === null) return rejected("This URL is not eligible for a public reputation check.");
    if (job.signal.aborted) throw new Error("Reputation lookup unavailable");
    const started = Date.now();
    const response = await lookup(url, job.signal);
    if (!response || !Array.isArray(response.threatTypes) ||
        response.threatTypes.length > 4 ||
        !response.threatTypes.every(t => typeof t === "string" && ALLOWED_THREATS.has(t))) {
      throw new Error("Reputation lookup unavailable");
    }
    const threats = [...new Set(response.threatTypes)];
    const matched = threats.length > 0;
    const elapsed = Math.max(0, Math.min(3600000, Date.now() - started));
    return {
      status: "complete", verdict: matched ? "dangerous" : "unknown",
      riskScore: matched ? 95 : null, confidenceScore: matched ? 90 : null,
      explanation: matched
        ? "Threat intelligence reports a known malicious or deceptive URL."
        : "No known threat-list match was reported. This does not establish that the URL is safe.",
      recommendedAction: matched
        ? "Do not visit this link or enter personal information."
        : "Treat unfamiliar links cautiously; verify the sender and destination independently.",
      durationMs: elapsed,
      vendorResults: [{
        vendor_name: "google-web-risk", verdict: matched ? "dangerous" : "unknown",
        response_time_ms: elapsed, raw_response: { threat_types: threats },
      }],
      evidenceItems: [{
        signal_type: matched ? "threat_list_match" : "threat_list_no_match",
        severity: matched ? "critical" : "info",
        title: matched ? "Known threat-list match" : "No known threat-list match",
        detail: matched ? "Reported categories: " + threats.join(", ") : "No match does not mean safe.",
        score_impact: matched ? 95 : 0,
      }],
    };
  };
}
