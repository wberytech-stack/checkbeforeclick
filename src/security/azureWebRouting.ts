/**
 * Azure-only web surface. This pure classifier is deliberately independent of
 * Supabase, Next.js and environment state so the boundary can be tested offline.
 * A disabled legacy route must never reach its old handler in the Azure image.
 */
const SCAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AzureWebDecision = "allow" | "redirect" | "deny";

export function isAzureWebPath(pathname: string): boolean {
  if (pathname === "/azure" || pathname === "/azure/" ||
      pathname === "/azure/welcome" ||
      pathname === "/auth/azure/start" ||
      pathname === "/auth/azure/logout" ||
      pathname === "/auth/callback" ||
      pathname === "/api/azure/scans" ||
      pathname === "/api/azure/history" ||
      pathname === "/api/healthz") return true;
  const prefix = "/api/azure/scans/";
  return pathname.startsWith(prefix) && SCAN_ID.test(pathname.slice(prefix.length));
}

/** Route classification is based on the URL path, never Host or forwarded headers. */
export function classifyAzureWebPath(pathname: string): AzureWebDecision {
  if (pathname === "/") return "redirect";
  return isAzureWebPath(pathname) ? "allow" : "deny";
}
