/** 
 * Server-only, fail-closed configuration for Entra External ID browser login.
 * Never derive these values from Host/X-Forwarded-* or the browser request.
 * OIDC state keys are 32-byte AES-GCM keys, supplied out-of-band by the operator.
 * This module does not create secrets, connect to Azure or change infrastructure.
 */
import "server-only";
import type { LoginStateBinding, LoginStateKeys } from "../../security/azureAuthState";

export type AzureRuntimeConfig = {
  publicOrigin: string;
  binding: LoginStateBinding;
  keys: LoginStateKeys;
};

export type AzureRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const CLIENT_ID = /^[A-Za-z0-9_.-]{1,200}$/;
const KID = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const ISSUER_PATH = /^\/(?:[A-Za-z0-9._~-]+\/)+v2\.0$/;
const MAX_KEYS = 3;

function unavailable(): never {
  // Never reflect key material, tenant names, or raw environment variables.
  throw new Error("Azure authentication configuration unavailable");
}

function canonicalOrigin(value: string | undefined): value is string {
  if (!value || value.length > 255) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username &&
      !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function canonicalIssuer(value: string | undefined): value is string {
  if (!value || value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.href === value && !!url.hostname &&
      !url.username && !url.password && !url.search && !url.hash &&
      ISSUER_PATH.test(url.pathname);
  } catch { return false; }
}

function decodeKey(encoded: string): Buffer {
  if (!BASE64URL_32.test(encoded)) unavailable();
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded) unavailable();
  return key;
}

/**
 * Strict format: `kid:base64url32bytes[,kid2:base64url32bytes]`.
 * No whitespace, duplicate key IDs, unknown active IDs or more than 3 keys.
 * Rotation is explicit: the active ID seals new states, old IDs remain for
 * in-flight five-minute callbacks, then must be retired by the operator.
 */
export function parseAzureRuntimeConfig(env: AzureRuntimeEnvironment): AzureRuntimeConfig {
  if (!env || typeof env !== "object") unavailable();
  const publicOrigin = env.CBC_AZURE_PUBLIC_ORIGIN;
  const issuer = env.CBC_AZURE_OIDC_ISSUER;
  const clientId = env.CBC_AZURE_OIDC_CLIENT_ID;
  const activeKid = env.CBC_AZURE_OIDC_STATE_ACTIVE_KID;
  const encodedKeys = env.CBC_AZURE_OIDC_STATE_KEYS;
  if (!canonicalOrigin(publicOrigin) || !canonicalIssuer(issuer) ||
      !clientId || !CLIENT_ID.test(clientId) || !activeKid || !KID.test(activeKid) ||
      !encodedKeys || encodedKeys.length > 512) unavailable();

  const entries = encodedKeys.split(",");
  if (entries.length < 1 || entries.length > MAX_KEYS) unavailable();
  const keys: Record<string, Buffer> = Object.create(null) as Record<string, Buffer>;
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator <= 0 || entry.indexOf(":", separator + 1) !== -1) unavailable();
    const kid = entry.slice(0, separator);
    if (!KID.test(kid) || Object.prototype.hasOwnProperty.call(keys, kid)) unavailable();
    keys[kid] = decodeKey(entry.slice(separator + 1));
  }
  if (!Object.prototype.hasOwnProperty.call(keys, activeKid)) unavailable();
  return { publicOrigin, binding: { issuer, clientId }, keys: { activeKid, keys } };
}
