/**
 * Gate 008B: sealed OIDC login-state cookie and mandatory one-time redemption.
 *
 * This is a server-side primitive, not an in-memory session store. An implementation
 * of LoginStateStore MUST reserve unique state hashes and consume them atomically
 * in shared durable storage (e.g. a PostgreSQL DELETE ... RETURNING transaction).
 * AES-GCM alone does NOT prevent replay. No callback may bypass consumeLoginState.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { LoginChallenge } from "./azureOidc.ts";

export class AuthStateError extends Error {
  constructor() { super("Invalid or expired login state"); this.name = "AuthStateError"; }
}

export type LoginStateStore = {
  /** Insert a unique SHA-256 state digest, with an expiry. Fail closed on collision. */
  reserve(stateDigest: string, expiresAtSeconds: number): Promise<boolean>;
  /** Atomically delete and return whether a previously reserved, unexpired digest existed. */
  consume(stateDigest: string, nowSeconds: number): Promise<boolean>;
};
export type LoginStateKeys = { activeKid: string; keys: Readonly<Record<string, Buffer>> };
export type LoginStateBinding = { issuer: string; clientId: string };
export type RedeemedLoginState = { nonce: string; codeVerifier: string };

export const LOGIN_STATE_COOKIE_NAME = "__Secure-cbc-oidc";
export const LOGIN_STATE_TTL_SECONDS = 300;
const KID = /^[A-Za-z0-9_-]{1,32}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const RANDOM_32 = /^[A-Za-z0-9_-]{43}$/;
const MAX_COOKIE_LENGTH = 2048;
const PURPOSE = "cbc:oidc-login-state:v1:";

function fail(): never { throw new AuthStateError(); }
function nowValid(now: number): boolean { return Number.isSafeInteger(now) && now >= 0; }
function digest(state: string): string { return createHash("sha256").update(state, "ascii").digest("hex"); }
function random32(value: unknown): value is string {
  if (typeof value !== "string" || !RANDOM_32.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}
function validBinding(binding: LoginStateBinding): boolean {
  if (typeof binding?.issuer !== "string" || typeof binding.clientId !== "string" ||
      binding.issuer.length > 512 || binding.clientId.length > 200 || !binding.clientId) return false;
  try {
    const url = new URL(binding.issuer);
    return url.protocol === "https:" && url.href === binding.issuer && !!url.hostname &&
      !url.username && !url.password && !url.hash && !url.search;
  } catch { return false; }
}
function keyFor(keys: LoginStateKeys, kid: string): Buffer {
  if (!KID.test(kid) || !keys || !keys.keys || !Object.prototype.hasOwnProperty.call(keys.keys, kid)) fail();
  const key = keys.keys[kid];
  if (!Buffer.isBuffer(key) || key.length !== 32) fail();
  return key;
}
function decode(part: string, limit: number): Buffer {
  if (!part || !B64.test(part) || part.length > Math.ceil(limit * 4 / 3) + 2) fail();
  const decoded = Buffer.from(part, "base64url");
  if (decoded.length > limit || decoded.toString("base64url") !== part) fail();
  return decoded;
}
function same(a: string, b: string): boolean {
  const x = Buffer.from(a, "ascii"); const y = Buffer.from(b, "ascii");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Seals the challenge and reserves its hash BEFORE returning a cookie value. */
export async function issueLoginState(input: {
  challenge: Pick<LoginChallenge, "state" | "nonce" | "codeVerifier">;
  binding: LoginStateBinding;
  keys: LoginStateKeys;
  store: LoginStateStore;
  nowSeconds?: number;
}): Promise<string> {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const { state, nonce, codeVerifier } = input.challenge;
  if (!nowValid(now) || !validBinding(input.binding) || !random32(state) || !random32(nonce) ||
      !random32(codeVerifier) || state === nonce || state === codeVerifier || nonce === codeVerifier ||
      !KID.test(input.keys?.activeKid ?? "")) fail();
  const kid = input.keys.activeKid;
  const key = keyFor(input.keys, kid);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(PURPOSE + kid, "ascii"));
  const plaintext = Buffer.from(JSON.stringify({ state, nonce, codeVerifier,
    issuer: input.binding.issuer, clientId: input.binding.clientId, issuedAt: now }), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const value = `v1.${kid}.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  if (value.length > MAX_COOKIE_LENGTH) fail();
  try {
    if (!await input.store.reserve(digest(state), now + LOGIN_STATE_TTL_SECONDS)) fail();
  } catch { fail(); }
  return value;
}

/** Decrypts, checks browser callback state, and consumes its durable record once. */
export async function consumeLoginState(input: {
  cookie: unknown;
  callbackState: unknown;
  binding: LoginStateBinding;
  keys: LoginStateKeys;
  store: LoginStateStore;
  nowSeconds?: number;
}): Promise<RedeemedLoginState> {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!nowValid(now) || !validBinding(input.binding) || typeof input.cookie !== "string" ||
      input.cookie.length > MAX_COOKIE_LENGTH || typeof input.callbackState !== "string" ||
      !random32(input.callbackState)) fail();
  const parts = input.cookie.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") fail();
  const [, kid, encodedIv, encodedCiphertext, encodedTag] = parts;
  const key = keyFor(input.keys, kid);
  const iv = decode(encodedIv, 12);
  const tag = decode(encodedTag, 16);
  const ciphertext = decode(encodedCiphertext, 1024);
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) fail();
  let record: unknown;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(PURPOSE + kid, "ascii"));
    decipher.setAuthTag(tag);
    record = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
  } catch { fail(); }
  if (!record || typeof record !== "object" || Array.isArray(record)) fail();
  const payload = record as Record<string, unknown>;
  if (Object.keys(payload).sort().join(",") !== "clientId,codeVerifier,issuedAt,issuer,nonce,state" ||
      !random32(payload.state) || !random32(payload.nonce) || !random32(payload.codeVerifier) ||
      payload.issuer !== input.binding.issuer || payload.clientId !== input.binding.clientId ||
      typeof payload.issuedAt !== "number" || !nowValid(payload.issuedAt) ||
      payload.issuedAt > now + 60 || now >= payload.issuedAt + LOGIN_STATE_TTL_SECONDS ||
      !same(payload.state, input.callbackState)) fail();
  try {
    if (!await input.store.consume(digest(payload.state), now)) fail();
  } catch { fail(); }
  return { nonce: payload.nonce, codeVerifier: payload.codeVerifier };
}

/** Cookie is scoped to the OIDC callback; it must be cleared on every callback outcome. */
export function loginStateSetCookie(value: string): string {
  if (!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ||
      value.length > MAX_COOKIE_LENGTH) fail();
  return `${LOGIN_STATE_COOKIE_NAME}=${value}; Path=/auth/callback; Max-Age=${LOGIN_STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}
export function loginStateClearCookie(): string {
  return `${LOGIN_STATE_COOKIE_NAME}=; Path=/auth/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
