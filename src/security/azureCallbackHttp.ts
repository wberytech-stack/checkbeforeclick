/**
 * Gate 008B: fail-closed HTTP boundary for the Entra authorization-code callback.
 *
 * Pure Web Request/Response adapter so it can be exercised offline without
 * importing Next.js, a database driver, or the identity provider. The Next.js
 * route must inject the real completeAzureLogin operation and a FIXED trusted
 * public origin and issuer, never values taken from Host/X-Forwarded-* headers.
 *
 * This module never issues a session credential itself: a successful result
 * must contain the canonical cookie emitted only after the database commit.
 */
import { LOGIN_STATE_COOKIE_NAME, loginStateClearCookie } from "./azureAuthState";
import { azureSessionSetCookie, readAzureSessionToken } from "./azureSession";
import type { AzureLoginCompletion } from "../server/auth/completeAzureLogin";

export type AzureCallbackFields = {
  code: string;
  state: string;
  cookie: string;
};

export type AzureCallbackHttpConfig = {
  /** Exact canonical https://host[:port] origin, not request headers. */
  publicOrigin: string;
  /** Exact allow-listed Entra issuer; compare any RFC 9207 iss response. */
  issuer: string;
  complete(fields: AzureCallbackFields): Promise<AzureLoginCompletion>;
};

const COOKIE_HEADER_MAX = 8192;
const QUERY_MAX = 8192;
const COOKIE_VALUE = /^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[\x21-\x7e]{1,4096}$/;
const ALLOWED = new Set(["code", "state", "error", "error_description", "error_uri", "session_state", "iss"]);

/** Never decode, normalize, or accept ambiguous duplicate state cookies. */
export function readAzureLoginStateCookie(header: unknown): string | null {
  if (typeof header !== "string" || header.length > COOKIE_HEADER_MAX ||
      /[\x00-\x1f\x7f]/.test(header)) return null;
  let value: string | null = null;
  for (const part of header.split(";")) {
    const entry = part.trim();
    const equals = entry.indexOf("=");
    if (equals < 0 || entry.slice(0, equals).trim() !== LOGIN_STATE_COOKIE_NAME) continue;
    if (value !== null) return null;
    const candidate = entry.slice(equals + 1);
    if (candidate.length > 2048 || !COOKIE_VALUE.test(candidate)) return null;
    value = candidate;
  }
  return value;
}

function trustedOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 255) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password &&
      !url.search && !url.hash && value === url.origin ? value : null;
  } catch { return null; }
}

function trustedIssuer(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password &&
      !url.search && !url.hash && url.href === value && url.pathname !== "/";
  } catch { return false; }
}

function safeResponse(origin: string | null, sessionCookie?: string): Response {
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Cookie",
  });
  headers.append("Set-Cookie", loginStateClearCookie());
  if (!origin) return new Response(null, { status: 503, headers });
  // Fixed destinations: callback query, next, Host, and error never affect Location.
  headers.set("Location", `${origin}${sessionCookie ? "/dashboard" : "/login"}`);
  if (sessionCookie) headers.append("Set-Cookie", sessionCookie);
  return new Response(null, { status: 303, headers });
}

/**
 * Reject duplicate/unknown callback parameters and ambiguous cookies before
 * any code exchange or identity provisioning. All outcomes clear OIDC state.
 */
export async function handleAzureCallbackHttp(
  request: Request,
  config: AzureCallbackHttpConfig,
): Promise<Response> {
  const origin = trustedOrigin(config.publicOrigin);
  if (!origin || !trustedIssuer(config.issuer) || typeof config.complete !== "function") {
    return safeResponse(null);
  }
  try {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== origin ||
        url.pathname !== "/auth/callback" || url.hash || url.search.length > QUERY_MAX) {
      return safeResponse(origin);
    }
    const params = url.searchParams;
    for (const [key] of params) {
      if (!ALLOWED.has(key) || params.getAll(key).length !== 1) return safeResponse(origin);
    }
    const code = params.get("code");
    const state = params.get("state");
    // Provider failures must never trigger a code exchange. Even a valid
    // existing state cookie is cleared, preventing accidental reuse.
    if (params.has("error") || !code || !CODE.test(code) || !state || !STATE.test(state) ||
        (params.has("iss") && params.get("iss") !== config.issuer)) {
      return safeResponse(origin);
    }
    const cookie = readAzureLoginStateCookie(request.headers.get("cookie"));
    if (!cookie) return safeResponse(origin);
    const result = await config.complete({ code, state, cookie });
    if (!result.ok || result.setCookies.length !== 2 ||
        result.setCookies[0] !== loginStateClearCookie()) return safeResponse(origin);
    // Do not forward arbitrary Set-Cookie values, even from a miswired adapter.
    const raw = readAzureSessionToken(result.setCookies[1]);
    if (!raw || azureSessionSetCookie(raw) !== result.setCookies[1]) return safeResponse(origin);
    return safeResponse(origin, result.setCookies[1]);
  } catch {
    // No SQL, identity, token, query or provider error is reflected to clients.
    return safeResponse(origin);
  }
}
