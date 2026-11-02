// Google Web Risk is an OPTIONAL, replaceable reputation provider. This adapter
// contacts only a fixed HTTPS API origin; it never fetches the submitted URL.
// Requires separately approved API setup/billing and secret configuration.
import type { ThreatLookup, ThreatLookupResult } from "./azureUrlProcessor";

const API = "https://webrisk.googleapis.com/v1/uris:search";
const ERROR = "Reputation provider unavailable";
const TYPES = ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"] as const;
const KNOWN = new Set<string>([...TYPES, "SOCIAL_ENGINEERING_EXTENDED_COVERAGE"]);

export function createWebRiskLookup(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
}): ThreatLookup {
  // An invalid/missing key is a configuration failure, not a "safe" result.
  if (!options || typeof options.apiKey !== "string" ||
      !/^[A-Za-z0-9_-]{16,256}$/.test(options.apiKey)) throw new Error(ERROR);
  const request = options.fetchImpl ?? fetch;
  return async (url: string, signal: AbortSignal): Promise<ThreatLookupResult> => {
    if (signal.aborted) throw new Error(ERROR);
    const endpoint = new URL(API);
    endpoint.searchParams.set("uri", url);
    for (const type of TYPES) endpoint.searchParams.append("threatTypes", type);
    endpoint.searchParams.set("key", options.apiKey);
    try {
      const response = await request(endpoint.href, {
        method: "GET", redirect: "manual", cache: "no-store",
        referrerPolicy: "no-referrer", headers: { Accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      if (response.status !== 200 || !response.body) throw new Error(ERROR);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16384) throw new Error(ERROR);
          chunks.push(value);
        }
      } finally {
        try { await reader.cancel(); } catch { /* Ignore cleanup failures. */ }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(ERROR);
      const data = payload as Record<string, unknown>;
      if (data.threat === undefined) {
        // Only the documented empty object represents no match.
        if (Object.keys(data).length !== 0) throw new Error(ERROR);
        return { threatTypes: [] };
      }
      if (!data.threat || typeof data.threat !== "object" || Array.isArray(data.threat)) throw new Error(ERROR);
      const threatTypes = (data.threat as Record<string, unknown>).threatTypes;
      if (!Array.isArray(threatTypes) || threatTypes.length === 0 || threatTypes.length > 4 ||
          !threatTypes.every(t => typeof t === "string" && KNOWN.has(t))) throw new Error(ERROR);
      return { threatTypes };
    } catch {
      // Never surface the API key, submitted URL, provider body or transport error.
      throw new Error(ERROR);
    }
  };
}
