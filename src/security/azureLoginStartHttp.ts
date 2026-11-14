/**
 * Fail-closed HTTP boundary for starting an Entra authorization-code login.
 * The trusted server operation MUST reserve the one-time state in committed
 * PostgreSQL storage before returning its cookie and authorization URL.
 * No browser-supplied redirect, issuer, tenant, or client ID is accepted.
 */
import { LOGIN_STATE_COOKIE_NAME, loginStateSetCookie } from "./azureAuthState";

export type AzureLoginStartResult = { authorizationUrl: string; setCookie: string };
export type AzureLoginStartHttpConfig = {
  publicOrigin: string;
  issuer: string;
  clientId: string;
  start(): Promise<AzureLoginStartResult>;
};

const STATE = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_ID = /^[A-Za-z0-9_.-]{1,200}$/;
const EXPECTED_PARAMS = new Set([
  "client_id", "response_type", "redirect_uri", "response_mode", "scope",
  "state", "nonce", "code_challenge", "code_challenge_method",
]);

function trustedOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 255) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password &&
      !url.search && !url.hash && value === url.origin ? value : null;
  } catch { return null; }
}

function expectedAuthorizationEndpoint(issuer: unknown): string | null {
  if (typeof issuer !== "string" || issuer.length > 512) return null;
  try {
    const url = new URL(issuer);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
        url.search || url.hash || url.href !== issuer || !url.pathname.endsWith("/v2.0") ||
        url.pathname === "/v2.0") return null;
    return url.origin + url.pathname.slice(0, -"/v2.0".length) + "/oauth2/v2.0/authorize";
  } catch { return null; }
}

function canonicalAuthorizationUrl(raw: unknown, endpoint: string, origin: string, clientId: string): raw is string {
  if (typeof raw !== "string" || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.origin + url.pathname !== endpoint || url.hash || url.username || url.password ||
        url.href !== raw) return false;
    const params = url.searchParams;
    if ([...params.keys()].length !== EXPECTED_PARAMS.size) return false;
    for (const key of params.keys()) {
      if (!EXPECTED_PARAMS.has(key) || params.getAll(key).length !== 1) return false;
    }
    return params.get("client_id") === clientId && params.get("response_type") === "code" &&
      params.get("redirect_uri") === `${origin}/auth/callback` &&
      params.get("response_mode") === "query" &&
      params.get("code_challenge_method") === "S256" &&
      STATE.test(params.get("state") ?? "") && STATE.test(params.get("nonce") ?? "") &&
      STATE.test(params.get("code_challenge") ?? "") &&
      (params.get("scope") ?? "").split(" ").includes("openid");
  } catch { return false; }
}

function canonicalStateCookie(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2200 ||
      !raw.startsWith(`${LOGIN_STATE_COOKIE_NAME}=`)) return false;
  const end = raw.indexOf(";");
  if (end < 0) return false;
  const value = raw.slice(LOGIN_STATE_COOKIE_NAME.length + 1, end);
  try { return loginStateSetCookie(value) === raw; }
  catch { return false; }
}

function response(status: number, location?: string, cookie?: string): Response {
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Cookie",
  });
  if (location) headers.set("Location", location);
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
}

/** All failures are non-cacheable and never leak state, SQL or provider errors. */
export async function handleAzureLoginStartHttp(request: Request, config: AzureLoginStartHttpConfig): Promise<Response> {
  const origin = trustedOrigin(config.publicOrigin);
  const endpoint = expectedAuthorizationEndpoint(config.issuer);
  if (!origin || !endpoint || !CLIENT_ID.test(config.clientId) || typeof config.start !== "function") {
    return response(503);
  }
  try {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== origin ||
        url.pathname !== "/auth/azure/start" || url.search || url.hash) return response(400);
    const result = await config.start();
    if (!result || !canonicalAuthorizationUrl(result.authorizationUrl, endpoint, origin, config.clientId) ||
        !canonicalStateCookie(result.setCookie)) return response(503);
    return response(303, result.authorizationUrl, result.setCookie);
  } catch { return response(503); }
}
