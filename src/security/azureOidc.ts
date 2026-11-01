/**
 * Gate 008B — pure Microsoft Entra External ID / OIDC security primitives.
 *
 * This module does not make network requests or set cookies. The future server-only
 * route must fetch JWKS over verified HTTPS, pin issuer/client/redirect settings,
 * persist the one-time state+nonce+verifier in an encrypted HttpOnly cookie,
 * and exchange the authorization code server-side before calling verifyIdToken.
 * No ID-token claim is trusted until the RS256 signature and every binding is checked.
 */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";

export class OidcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcValidationError";
  }
}

export type OidcSettings = {
  issuer: string;
  clientId: string;
  authorizationEndpoint: string;
  redirectUri: string;
  scope?: string;
};
export type LoginChallenge = {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
};
export type VerifiedOidcIdentity = {
  issuer: string;
  subject: string;
  email: string | null;
  displayName: string | null;
};
export type RsaJwk = {
  kty: string;
  kid: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
};

const B64URL = /^[A-Za-z0-9_-]+$/;
const MAX_JWT_CHARS = 16_384;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LIFETIME_SECONDS = 2 * 60 * 60;

function fail(message: string): never { throw new OidcValidationError(message); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("OIDC payload must be an object");
  return value as Record<string, unknown>;
}
function nonempty(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function secureEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
function exactBase64Url(part: string, maxBytes: number): Buffer {
  if (!part || !B64URL.test(part) || part.length > Math.ceil(maxBytes * 4 / 3) + 2) fail("malformed OIDC token encoding");
  const bytes = Buffer.from(part, "base64url");
  if (bytes.length > maxBytes || bytes.toString("base64url") !== part) fail("non-canonical OIDC token encoding");
  return bytes;
}
function parseJson(part: string, maxBytes: number): Record<string, unknown> {
  try { return object(JSON.parse(exactBase64Url(part, maxBytes).toString("utf8"))); }
  catch (error) { if (error instanceof OidcValidationError) throw error; return fail("malformed OIDC token JSON"); }
}
function httpsUrl(value: string, name: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { return fail(`${name} must be a valid URL`); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) fail(`${name} must use HTTPS without credentials or fragment`);
  return url;
}

/** Creates a one-time authorization-code + PKCE S256 + state + nonce challenge. */
export function createLoginChallenge(settings: OidcSettings, random: (size: number) => Buffer = randomBytes): LoginChallenge {
  const issuer = httpsUrl(settings.issuer, "issuer");
  const auth = httpsUrl(settings.authorizationEndpoint, "authorization endpoint");
  const redirect = httpsUrl(settings.redirectUri, "redirect URI");
  if (issuer.origin !== auth.origin || issuer.search || issuer.pathname === "/") fail("authorization endpoint must share the configured issuer origin");
  if (auth.search || !auth.pathname.endsWith("/authorize")) fail("authorization endpoint must be a fixed /authorize URL");
  if (redirect.search || !redirect.pathname.endsWith("/auth/callback")) fail("redirect URI must be a fixed /auth/callback URL");
  if (!nonempty(settings.clientId, 200) || !/^[A-Za-z0-9_.-]+$/.test(settings.clientId)) fail("invalid OIDC client ID");
  const scope = settings.scope ?? "openid profile email";
  if (!scope.split(" ").includes("openid") || !/^[a-zA-Z0-9:/. _-]{6,200}$/.test(scope)) fail("OIDC scope must include openid");
  const take = (size: number) => {
    const bytes = random(size);
    if (!Buffer.isBuffer(bytes) || bytes.length !== size) fail("cryptographic random source failed");
    return bytes.toString("base64url");
  };
  const state = take(32);
  const nonce = take(32);
  const codeVerifier = take(32);
  const challenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
  const url = new URL(auth.href);
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirect.href);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { authorizationUrl: url.href, state, nonce, codeVerifier };
}

/** Compare callback state to the stored one-time state; caller must consume it on first use. */
export function verifyCallbackState(received: unknown, expected: unknown): void {
  if (!nonempty(received, 256) || !nonempty(expected, 256) || !secureEquals(received, expected)) fail("OIDC callback state mismatch");
}

/**
 * Verifies a signed OIDC ID token against already-fetched JWKS.
 * `nonce` must be the one-time value from the same browser's encrypted login-state cookie.
 * Caller MUST ensure JWKS was obtained from the allow-listed issuer's metadata over HTTPS.
 */
export function verifyIdToken(input: {
  token: string;
  jwks: { keys: RsaJwk[] };
  issuer: string;
  audience: string;
  nonce: string;
  nowSeconds?: number;
}): VerifiedOidcIdentity {
  const { token, jwks, issuer, audience, nonce } = input;
  if (typeof token !== "string" || token.length > MAX_JWT_CHARS) fail("OIDC token missing or oversized");
  const parts = token.split(".");
  if (parts.length !== 3) fail("OIDC token must contain three segments");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJson(encodedHeader, 1024);
  if (header.alg !== "RS256" || (header.typ !== undefined && header.typ !== "JWT") || header.crit !== undefined) fail("unsupported OIDC token header");
  if (!nonempty(header.kid, 128)) fail("OIDC signing key ID missing");
  if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length > 100) fail("invalid OIDC JWKS");
  const matches = jwks.keys.filter((k) => k && k.kid === header.kid);
  if (matches.length !== 1) fail("OIDC signing key must be unique and present");
  const jwk = matches[0];
  if (jwk.kty !== "RSA" || !nonempty(jwk.n, 2048) || !nonempty(jwk.e, 16) ||
      (jwk.alg !== undefined && jwk.alg !== "RS256") ||
      (jwk.use !== undefined && jwk.use !== "sig") ||
      (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify")))) {
    fail("OIDC signing key not valid for RS256 verification");
  }
  let publicKey: ReturnType<typeof createPublicKey>;
  try { publicKey = createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" }); }
  catch { return fail("OIDC signing key is malformed"); }
  if (publicKey.asymmetricKeyType !== "rsa" || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail("OIDC signing key too weak");
  const signature = exactBase64Url(encodedSignature, 512);
  if (!verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"), publicKey, signature)) fail("OIDC signature invalid");

  const claims = parseJson(encodedPayload, 8192);
  if (!nonempty(issuer, 512) || httpsUrl(issuer, "issuer").href !== issuer || claims.iss !== issuer) fail("OIDC issuer mismatch");
  if (!nonempty(audience, 200)) fail("OIDC audience missing");
  const aud = claims.aud;
  const audiences = typeof aud === "string" ? [aud] : aud;
  if (!Array.isArray(audiences) || audiences.length < 1 || audiences.length > 10 ||
      audiences.some((v) => !nonempty(v, 200)) || !audiences.includes(audience)) fail("OIDC audience mismatch");
  if (audiences.length > 1 && claims.azp !== audience) fail("OIDC authorized party mismatch");
  if (claims.azp !== undefined && claims.azp !== audience) fail("OIDC authorized party mismatch");
  if (!nonempty(nonce, 256) || !nonempty(claims.nonce, 256) || !secureEquals(claims.nonce, nonce)) fail("OIDC nonce mismatch");
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(now)) fail("OIDC clock invalid");
  if (typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp <= now - CLOCK_SKEW_SECONDS) fail("OIDC token expired");
  if (typeof claims.iat !== "number" || !Number.isSafeInteger(claims.iat) || claims.iat > now + CLOCK_SKEW_SECONDS ||
      claims.iat >= claims.exp || claims.exp - claims.iat > MAX_TOKEN_LIFETIME_SECONDS) fail("OIDC token lifetime invalid");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isSafeInteger(claims.nbf) || claims.nbf > now + CLOCK_SKEW_SECONDS)) fail("OIDC token not yet valid");
  if (!nonempty(claims.sub, 255)) fail("OIDC subject missing");
  // Email/name are display-only; never link accounts by email or infer verified ownership.
  const email = nonempty(claims.email, 320) ? claims.email : null;
  const displayName = nonempty(claims.name, 200) ? claims.name : null;
  return { issuer, subject: claims.sub, email, displayName };
}
