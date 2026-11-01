/**
 * Gate 008B: opaque, high-entropy browser session credentials.
 *
 * A token is NOT a session until a trusted server transaction has committed
 * its digest and the verified identity to durable PostgreSQL storage. The
 * database must check expiry and revocation on every request, and atomically
 * revoke the old digest when rotating a session. Never log the raw token.
 * No user, organization, claims or expiry are trusted from the browser cookie.
 */
import { createHash, randomBytes } from "node:crypto";

export const AZURE_SESSION_COOKIE_NAME = "__Host-cbc-session";
export const AZURE_SESSION_TTL_SECONDS = 12 * 60 * 60;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_HEADER_MAX = 8192;
const DIGEST_PURPOSE = "cbc:azure-session:v1:";

export class AzureSessionError extends Error {
  constructor() { super("Invalid session credential"); this.name = "AzureSessionError"; }
}

/** Rejects non-canonical base64url, not just invalid characters. */
function validToken(value: unknown): value is string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === TOKEN_BYTES && bytes.toString("base64url") === value;
}

/** Returns the digest used as the database lookup key; never persist raw tokens. */
export function digestAzureSessionToken(token: unknown): string | null {
  if (!validToken(token)) return null;
  return createHash("sha256").update(DIGEST_PURPOSE, "ascii").update(token, "ascii").digest("hex");
}

/** Create an UNPERSISTED token; caller must commit its digest before setting the cookie. */
export function createUnpersistedAzureSessionToken(): { token: string; digest: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const digest = digestAzureSessionToken(token);
  if (!digest) throw new AzureSessionError();
  return { token, digest };
}

/** Use only AFTER a durable session creation/rotation transaction commits. */
export function azureSessionSetCookie(token: unknown): string {
  if (!validToken(token)) throw new AzureSessionError();
  return `${AZURE_SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${AZURE_SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

/** Browser logout always clears the cookie, even if database revocation fails. */
export function azureSessionClearCookie(): string {
  return `${AZURE_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Read an untrusted Cookie header. Duplicate session cookies are ambiguous and
 * denied (including a valid token followed by an attacker-controlled token).
 * Do not URL-decode, trim, or normalize the token; only canonical bytes pass.
 */
export function readAzureSessionToken(cookieHeader: unknown): string | null {
  if (typeof cookieHeader !== "string" || cookieHeader.length > COOKIE_HEADER_MAX ||
      /[\r\n\x00]/.test(cookieHeader)) return null;
  let token: string | null = null;
  let found = false;
  for (const segment of cookieHeader.split(";")) {
    const entry = segment.trim();
    const equals = entry.indexOf("=");
    if (equals < 0) continue;
    const name = entry.slice(0, equals).trim();
    if (name !== AZURE_SESSION_COOKIE_NAME) continue;
    if (found) return null;
    found = true;
    const candidate = entry.slice(equals + 1);
    if (!validToken(candidate)) return null;
    token = candidate;
  }
  return token;
}
