/**
 * Server-only Entra confidential-client authentication. The operator supplies
 * a registered X.509 certificate and matching RSA private key through protected
 * environment secrets. Never persist or log the signed assertion or key.
 */
import { X509Certificate, createHash, createPrivateKey, createPublicKey,
  randomUUID, sign, constants } from "node:crypto";

const MAX_B64 = 16384;
const CLIENT_ID = /^[A-Za-z0-9_.-]{1,200}$/;

function unavailable(): never {
  throw new Error("Azure client authentication unavailable");
}

function decodePem(value: string | undefined): string {
  if (!value || value.length > MAX_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) unavailable();
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.toString("base64") !== value) unavailable();
  const pem = bytes.toString("utf8");
  if (pem.includes("\0") || pem.length > 12000) unavailable();
  return pem;
}

/** Create a fresh PS256 assertion for exactly one issuer-pinned token exchange. */
export function createAzureClientAssertion(input: {
  clientId: string;
  tokenEndpoint: string;
  privateKeyPemBase64: string | undefined;
  certificatePemBase64: string | undefined;
  now?: () => number;
}): string {
  try {
    if (!CLIENT_ID.test(input.clientId)) unavailable();
    const endpoint = new URL(input.tokenEndpoint);
    if (endpoint.protocol !== "https:" || endpoint.href !== input.tokenEndpoint ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        !/^\/(?:[A-Za-z0-9._~-]+\/)+oauth2\/v2\.0\/token$/.test(endpoint.pathname)) unavailable();
    const key = createPrivateKey(decodePem(input.privateKeyPemBase64));
    const certificate = new X509Certificate(decodePem(input.certificatePemBase64));
    if (key.asymmetricKeyType !== "rsa" || certificate.publicKey.asymmetricKeyType !== "rsa" ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
        !createPublicKey(key).export({ format: "der", type: "spki" })
          .equals(certificate.publicKey.export({ format: "der", type: "spki" }))) unavailable();
    const now = Math.floor((input.now ?? Date.now)() / 1000);
    if (!Number.isSafeInteger(now) || now <= 0 ||
        Date.parse(certificate.validFrom) > now * 1000 ||
        Date.parse(certificate.validTo) <= (now + 300) * 1000) unavailable();
    const header = { alg: "PS256", typ: "JWT",
      "x5t#S256": createHash("sha256").update(certificate.raw).digest("base64url") };
    const claims = { aud: input.tokenEndpoint, iss: input.clientId, sub: input.clientId,
      jti: randomUUID(), iat: now, nbf: now - 5, exp: now + 300 };
    const encoded = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const signingInput = encoded(header) + "." + encoded(claims);
    const signature = sign("sha256", Buffer.from(signingInput), {
      key, padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString("base64url");
    return signingInput + "." + signature;
  } catch { return unavailable(); }
}
