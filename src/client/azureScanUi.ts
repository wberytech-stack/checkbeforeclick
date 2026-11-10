/** Pure, strict browser-side parsing for the Azure scan vertical slice.
 * Server-side tenant authorization and URL defenses remain authoritative. */
export type AzureScanView = {
  scan: {
    id: string;
    input_type: string;
    raw_input: string;
    status: "pending" | "processing" | "complete" | "failed";
    verdict: string | null;
  };
  evidence: Array<{ title: string; detail: string | null }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function validateSubmittedUrl(input: string): string | null {
  const value = input.trim();
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    // Mirror the worker's public-URL eligibility checks for immediate feedback.
    // The server and worker remain authoritative; browser validation is UX only.
    const host = url.hostname.replace(/^\\[|\\]$/g, "").replace(/\\.$/, "").toLowerCase();
    const blocked = ["localhost", "local", "internal", "test", "invalid", "example",
      "onion", "home.arpa", "lan", "corp", "intranet"];
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname ||
        url.username || url.password || url.hash || url.href.length > 2048 ||
        /[\\\\\\s]/u.test(value) || (url.port && !["80", "443"].includes(url.port)) ||
        !host.includes(".") || host.length > 253 ||
        blocked.some(suffix => host === suffix || host.endsWith("." + suffix)) ||
        host.split(".").some(part => !part || part.length > 63 ||
          part.startsWith("-") || part.endsWith("-")) ||
        /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(host) || host.includes(":")) return null;
    return url.href;
  } catch { return null; }
}

export function parseScanCreated(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid scan response");
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !UUID.test(row.id) || row.status !== "pending")
    throw new Error("Invalid scan response");
  return row.id;
}

export function parseScanRead(value: unknown, id: string): AzureScanView {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid scan response");
  const row = value as Record<string, unknown>;
  const scan = row.scan;
  if (!scan || typeof scan !== "object" || Array.isArray(scan)) throw new Error("Invalid scan response");
  const s = scan as Record<string, unknown>;
  if (!UUID.test(id) || s.id !== id || s.input_type !== "url" ||
      typeof s.raw_input !== "string" || s.raw_input.length > 10000 ||
      !["pending", "processing", "complete", "failed"].includes(String(s.status)) ||
      !(s.verdict === null || typeof s.verdict === "string") ||
      !Array.isArray(row.evidence) || row.evidence.length > 500) throw new Error("Invalid scan response");
  const evidence = row.evidence.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid evidence");
    const e = entry as Record<string, unknown>;
    if (typeof e.title !== "string" || e.title.length > 2000 ||
        !(e.detail === null || typeof e.detail === "string") ||
        (typeof e.detail === "string" && e.detail.length > 10000)) throw new Error("Invalid evidence");
    return { title: e.title, detail: e.detail };
  });
  return { scan: {
    id, input_type: "url", raw_input: s.raw_input,
    status: s.status as AzureScanView["scan"]["status"],
    verdict: s.verdict as string | null,
  }, evidence };
}

export function scanPresentation(scan: AzureScanView["scan"]): { label: string; description: string } {
  if (scan.status === "pending" || scan.status === "processing")
    return { label: "Checking…", description: "Your scan is queued or running." };
  if (scan.status === "failed")
    return { label: "Check unavailable", description: "The scan did not finish. Do not assume this link is safe." };
  if (scan.verdict === "dangerous")
    return { label: "Dangerous — do not open", description: "Threat intelligence reported a known threat." };
  if (scan.verdict === "suspicious")
    return { label: "Use caution", description: "Signals suggest this link may be risky." };
  return { label: "Safety not confirmed", description: "No confirmed threat was returned; this does not prove the link is safe." };
}
