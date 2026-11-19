/**
 * Gate 008B: server-side, issuer-pinned OIDC metadata, JWKS and code exchange.
 * No endpoint or URL is ever derived from a browser request or JWT header.
 * Only use this module from server-side auth routes; never expose code verifiers.
 */
export class OidcTransportError extends Error {
  constructor() { super("OIDC provider request or configuration invalid"); this.name = "OidcTransportError"; }
}
export type RsaJwk = { kty: string; kid: string; n?: string; e?: string; alg?: string; use?: string; key_ops?: string[] };

export type TrustedOidcMetadata = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
};
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const CACHE_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 5000;

function fail(): never { throw new OidcTransportError(); }
function trustedUrl(raw: string, origin?: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return fail(); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash || url.search ||
      url.href !== raw || (origin !== undefined && url.origin !== origin)) fail();
  return url;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function nonempty(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
}

export class TrustedOidcTransport {
  private readonly issuer: string;
  private readonly origin: string;
  private readonly tenantPath: string;
  private readonly discoveryUrl: string;
  private readonly request: Fetcher;
  private readonly now: () => number;
  private metadataCache?: { value: TrustedOidcMetadata; until: number };
  private keysCache?: { value: { keys: RsaJwk[] }; until: number; uri: string };

  constructor(issuer: string, request: Fetcher = fetch, now: () => number = Date.now) {
    this.request = request;
    this.now = now;
    const url = trustedUrl(issuer);
    if (url.pathname === "/" || url.pathname.endsWith("/") || !url.pathname.endsWith("/v2.0")) fail();
    this.issuer = issuer;
    this.origin = url.origin;
    this.tenantPath = url.pathname.slice(0, -"/v2.0".length);
    this.discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  }

  private async json(url: string, init: RequestInit, limit: number): Promise<Record<string, unknown>> {
    trustedUrl(url, this.origin);
    let response: Response;
    try {
      response = await this.request(url, { ...init, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch { return fail(); }
    if (response.status !== 200 || (response.url && response.url !== url) ||
        !/^application\/(?:json|jwk-set\+json)(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")) fail();
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) fail();
    if (!response.body) fail();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) fail();
        chunks.push(value);
      }
    } catch { return fail(); }
    finally { reader.releaseLock(); }
    try { return record(JSON.parse(Buffer.concat(chunks.map((v) => Buffer.from(v)), length).toString("utf8"))); }
    catch { return fail(); }
  }

  async metadata(forceRefresh = false): Promise<TrustedOidcMetadata> {
    if (!forceRefresh && this.metadataCache && this.now() < this.metadataCache.until) return this.metadataCache.value;
    const doc = await this.json(this.discoveryUrl, { method: "GET" }, 16_384);
    if (doc.issuer !== this.issuer || typeof doc.authorization_endpoint !== "string" ||
        typeof doc.token_endpoint !== "string" || typeof doc.jwks_uri !== "string") fail();
    const authorization = trustedUrl(doc.authorization_endpoint, this.origin);
    const token = trustedUrl(doc.token_endpoint, this.origin);
    const jwks = trustedUrl(doc.jwks_uri, this.origin);
    if (authorization.pathname !== `${this.tenantPath}/oauth2/v2.0/authorize` ||
        token.pathname !== `${this.tenantPath}/oauth2/v2.0/token` ||
        jwks.pathname !== `${this.tenantPath}/discovery/v2.0/keys`) fail();
    const value = { issuer: this.issuer, authorizationEndpoint: authorization.href,
      tokenEndpoint: token.href, jwksUri: jwks.href };
    this.metadataCache = { value, until: this.now() + CACHE_MS };
    if (this.keysCache && this.keysCache.uri !== value.jwksUri) this.keysCache = undefined;
    return value;
  }

  /** forceRefresh permits one bounded key-rotation retry; callers must still verify signatures. */
  async jwks(forceRefresh = false): Promise<{ keys: RsaJwk[] }> {
    const metadata = await this.metadata(forceRefresh);
    if (!forceRefresh && this.keysCache && this.keysCache.uri === metadata.jwksUri && this.now() < this.keysCache.until) return this.keysCache.value;
    const value = await this.json(metadata.jwksUri, { method: "GET" }, 131_072);
    if (!Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 100 ||
        value.keys.some((key) => !key || typeof key !== "object" || Array.isArray(key))) fail();
    const keys = { keys: value.keys as RsaJwk[] };
    this.keysCache = { value: keys, until: this.now() + CACHE_MS, uri: metadata.jwksUri };
    return keys;
  }

  /** Exchange a one-time code; never log or persist the returned ID token. */
  async exchangeCode(input: { code: string; codeVerifier: string; clientId: string; redirectUri: string;
    clientAssertion?: string }): Promise<string> {
    if (!nonempty(input.code, 4096) || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier) ||
        !nonempty(input.clientId, 200) || !/^[A-Za-z0-9_.-]+$/.test(input.clientId)) fail();
    const redirect = trustedUrl(input.redirectUri);
    if (!redirect.pathname.endsWith("/auth/callback")) fail();
    if (input.clientAssertion !== undefined && (!nonempty(input.clientAssertion, 8192) ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.clientAssertion))) fail();
    const metadata = await this.metadata();
    const body = new URLSearchParams({ grant_type: "authorization_code", code: input.code,
      client_id: input.clientId, redirect_uri: redirect.href, code_verifier: input.codeVerifier });
    if (input.clientAssertion) {
      body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      body.set("client_assertion", input.clientAssertion);
    }
    const result = await this.json(metadata.tokenEndpoint, { method: "POST", body,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" } }, 24_576);
    if (!nonempty(result.id_token, 16_384) || result.id_token.split(".").length !== 3) fail();
    return result.id_token;
  }
}
