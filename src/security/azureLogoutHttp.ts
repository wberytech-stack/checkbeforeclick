/**
 * Pure, fail-closed HTTP boundary for revoking an Azure browser session.
 *
 * The Next.js route must inject a committed PostgreSQL session store, and a
 * canonical public origin from server configuration (never Host headers).
 * Logout requires an exact same-origin POST to prevent cross-site logout CSRF.
 * A storage failure clears the browser cookie but returns 503: it must never
 * claim server-side revocation succeeded while a stolen token remains valid.
 */
import { azureSessionClearCookie, digestAzureSessionToken, readAzureSessionToken } from "./azureSession";

export type AzureLogoutHttpConfig = {
  publicOrigin: string;
  /** Autocommit database revocation; no caller-controlled SQL or tenant. */
  revoke(digest: string): Promise<boolean>;
};

function trustedOrigin(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 255) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.origin === raw && !url.username &&
      !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function response(status: number, origin: string | null, clear: boolean): Response {
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Cookie, Origin",
  });
  if (clear) headers.append("Set-Cookie", azureSessionClearCookie());
  if (status === 303 && origin) headers.set("Location", `${origin}/login`);
  return new Response(null, { status, headers });
}

/**
 * Revoke the digest of the browser credential, never its raw token. The route
 * must not substitute GET or accept a missing Origin, even behind a proxy.
 */
export async function handleAzureLogoutHttp(request: Request, config: AzureLogoutHttpConfig): Promise<Response> {
  if (!trustedOrigin(config.publicOrigin) || typeof config.revoke !== "function") {
    return response(503, null, false);
  }
  const origin = config.publicOrigin;
  try {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.origin !== origin ||
        url.pathname !== "/auth/azure/logout" || url.search || url.hash ||
        request.headers.get("origin") !== origin ||
        ![null, "same-origin"].includes(request.headers.get("sec-fetch-site")) ||
        ![null, "0"].includes(request.headers.get("content-length")) ||
        request.headers.has("transfer-encoding")) {
      return response(403, origin, false);
    }
    const token = readAzureSessionToken(request.headers.get("cookie"));
    const digest = token === null ? null : digestAzureSessionToken(token);
    // Missing/invalid credentials cannot select a database row. Still clear
    // the browser cookie so a broken session does not linger client-side.
    if (digest === null) return response(303, origin, true);
    await config.revoke(digest);
    // An already-expired/revoked digest is idempotent logout, not a new login.
    return response(303, origin, true);
  } catch {
    // A valid token may still be active if the database is unavailable.
    return response(503, origin, true);
  }
}
