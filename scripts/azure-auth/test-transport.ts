/** Gate 008B offline OIDC transport tests. Fake fetch only; no live network. */
import { strict as assert } from "node:assert";
import { TrustedOidcTransport } from "../../src/security/azureOidcTransport.ts";
import { OidcValidationError } from "../../src/security/azureOidc.ts";

const ISSUER = "https://tenant.ciamlogin.com/tenant-id/v2.0";
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const AUTH = "https://tenant.ciamlogin.com/tenant-id/oauth2/v2.0/authorize";
const TOKEN = "https://tenant.ciamlogin.com/tenant-id/oauth2/v2.0/token";
const KEYS = "https://tenant.ciamlogin.com/tenant-id/discovery/v2.0/keys";
const REDIRECT = "https://app.example.com/auth/callback";
const metadata = { issuer: ISSUER, authorization_endpoint: AUTH, token_endpoint: TOKEN, jwks_uri: KEYS };
const jwks = { keys: [{ kty: "RSA", kid: "test", n: "abc", e: "AQAB" }] };
const idToken = "header.payload.signature";
let passed = 0;
let failed = 0;
async function check(label: string, action: () => unknown | Promise<unknown>) {
  try { await action(); passed++; console.log(`PASS ${label}`); }
  catch (e) { failed++; console.error(`FAIL ${label}: ${String(e)}`); }
}
async function rejects(label: string, action: () => unknown | Promise<unknown>) {
  await check(label, async () => { await assert.rejects(async () => action(), OidcValidationError); });
}
function json(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}
function fake(overrides: Record<string, unknown> = {}, responseOverrides: Record<string, Response> = {}) {
  let clock = 100_000;
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (responseOverrides[url]) return responseOverrides[url];
    if (url === DISCOVERY) return json({ ...metadata, ...overrides });
    if (url === KEYS) return json(jwks);
    if (url === TOKEN) return json({ id_token: idToken });
    throw Error("unexpected endpoint");
  };
  const transport = new TrustedOidcTransport(ISSUER, fetcher, () => clock);
  return { transport, calls, tick: (ms: number) => { clock += ms; } };
}
const input = { code: "one-time-code", codeVerifier: "a".repeat(43), clientId: "client-id", redirectUri: REDIRECT };

await check("T01 trusted metadata", async () => assert.deepEqual(await fake().transport.metadata(),
  { issuer: ISSUER, authorizationEndpoint: AUTH, tokenEndpoint: TOKEN, jwksUri: KEYS }));
await check("T02 metadata cached for five minutes", async () => {
  const f = fake(); await f.transport.metadata(); await f.transport.metadata(); assert.equal(f.calls.length, 1);
});
await check("T03 metadata refresh after TTL", async () => {
  const f = fake(); await f.transport.metadata(); f.tick(300_001); await f.transport.metadata(); assert.equal(f.calls.length, 2);
});
await check("T04 explicit metadata refresh", async () => {
  const f = fake(); await f.transport.metadata(); await f.transport.metadata(true); assert.equal(f.calls.length, 2);
});
await check("T05 JWKS cached", async () => {
  const f = fake(); assert.equal((await f.transport.jwks()).keys[0].kid, "test");
  await f.transport.jwks(); assert.deepEqual(f.calls.map(c => c.url), [DISCOVERY, KEYS]);
});
await check("T06 JWKS force refresh reloads metadata and keys", async () => {
  const f = fake(); await f.transport.jwks(); await f.transport.jwks(true);
  assert.deepEqual(f.calls.map(c => c.url), [DISCOVERY, KEYS, DISCOVERY, KEYS]);
});
await check("T07 JWKS TTL expiration", async () => {
  const f = fake(); await f.transport.jwks(); f.tick(300_001); await f.transport.jwks(); assert.equal(f.calls.length, 4);
});
await check("T08 code exchange POST uses fixed endpoint and PKCE", async () => {
  const f = fake(); assert.equal(await f.transport.exchangeCode(input), idToken);
  const call = f.calls.at(-1)!; assert.equal(call.url, TOKEN); assert.equal(call.init.method, "POST");
  const body = call.init.body as URLSearchParams;
  assert.equal(body.get("grant_type"), "authorization_code"); assert.equal(body.get("code_verifier"), input.codeVerifier);
  assert.equal(body.get("redirect_uri"), REDIRECT); assert.equal(body.get("client_id"), input.clientId);
  assert.equal(body.get("code"), input.code); assert.equal(body.get("client_secret"), null);
  assert.equal(call.init.redirect, "manual"); assert.equal(call.init.cache, "no-store");
  assert.ok(call.init.signal instanceof AbortSignal);
});
await check("T09 optional signed client assertion forwarded only to token endpoint", async () => {
  const f = fake(); await f.transport.exchangeCode({ ...input, clientAssertion: "abc.def.ghi" });
  const call = f.calls.at(-1)!; const body = call.init.body as URLSearchParams;
  assert.equal(body.get("client_assertion"), "abc.def.ghi");
  assert.equal(body.get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
  assert.ok(f.calls.slice(0, -1).every(c => !JSON.stringify(c.init).includes("abc.def.ghi")));
});
for (const [name, issuer] of [
  ["T10 HTTP issuer", "http://tenant.ciamlogin.com/tenant-id/v2.0"],
  ["T11 issuer with query", `${ISSUER}?a=1`],
  ["T12 issuer with fragment", `${ISSUER}#foo`],
  ["T13 issuer with credentials", "https://user:pass@tenant.ciamlogin.com/tenant-id/v2.0"],
  ["T14 issuer without v2.0", "https://tenant.ciamlogin.com/tenant-id"],
] as const) {
  await check(name, () => assert.throws(() => new TrustedOidcTransport(issuer), OidcValidationError));
}
for (const [name, overrides] of [
  ["T15 metadata wrong issuer", { issuer: "https://evil.invalid/tenant/v2.0" }],
  ["T16 metadata external authorization endpoint", { authorization_endpoint: "https://evil.invalid/oauth2/v2.0/authorize" }],
  ["T17 metadata external token endpoint", { token_endpoint: "https://evil.invalid/oauth2/v2.0/token" }],
  ["T18 metadata external JWKS", { jwks_uri: "https://evil.invalid/discovery/v2.0/keys" }],
  ["T19 metadata HTTP token endpoint", { token_endpoint: TOKEN.replace("https:", "http:") }],
  ["T20 metadata query JWKS", { jwks_uri: KEYS + "?redirect=1" }],
  ["T21 metadata wrong token path", { token_endpoint: TOKEN.replace("/token", "/anything") }],
  ["T22 metadata credentials", { jwks_uri: KEYS.replace("https://", "https://u:p@") }],
  ["T39 cross-tenant token endpoint rejected", { token_endpoint: TOKEN.replace("/tenant-id/", "/other-tenant/") }],
  ["T40 cross-tenant JWKS endpoint rejected", { jwks_uri: KEYS.replace("/tenant-id/", "/other-tenant/") }],
] as const) await rejects(name, () => fake(overrides).transport.metadata());
await rejects("T23 HTTP redirect denied", () => fake().transport.exchangeCode({ ...input, redirectUri: "http://app.example.com/auth/callback" }));
await rejects("T24 open redirect query denied", () => fake().transport.exchangeCode({ ...input, redirectUri: REDIRECT + "?next=evil" }));
await rejects("T25 invalid PKCE verifier denied", () => fake().transport.exchangeCode({ ...input, codeVerifier: "short" }));
await rejects("T26 empty authorization code denied", () => fake().transport.exchangeCode({ ...input, code: "" }));
await rejects("T27 invalid client assertion denied", () => fake().transport.exchangeCode({ ...input, clientAssertion: "not-a-jwt" }));
await rejects("T28 JWKS missing keys denied", () => fake({}, { [KEYS]: json({ keys: [] }) }).transport.jwks());
await rejects("T29 JWKS oversized key list denied", () => fake({}, { [KEYS]: json({ keys: Array(101).fill({ kty: "RSA" }) }) }).transport.jwks());
await rejects("T30 oversized JWKS response denied", () => fake({}, { [KEYS]: json({ keys: [jwks.keys[0]], pad: "a".repeat(150_000) }) }).transport.jwks());
await rejects("T31 redirect response denied", () => fake({}, { [DISCOVERY]: new Response(null, { status: 302, headers: { location: "https://evil.invalid" } }) }).transport.metadata());
await rejects("T32 non-JSON content-type denied", () => fake({}, { [DISCOVERY]: new Response("{}", { headers: { "content-type": "text/html" } }) }).transport.metadata());
await rejects("T33 missing token denied", () => fake({}, { [TOKEN]: json({ access_token: "not-id-token" }) }).transport.exchangeCode(input));
await rejects("T34 malformed ID token denied", () => fake({}, { [TOKEN]: json({ id_token: "invalid" }) }).transport.exchangeCode(input));
await rejects("T35 network failure denied", () => new TrustedOidcTransport(ISSUER, async () => { throw Error("network failure"); }).metadata());
await rejects("T36 non-JSON payload denied", () => fake({}, { [DISCOVERY]: new Response("not json", { headers: { "content-type": "application/json" } }) }).transport.metadata());
await rejects("T37 content-length guard denied", () => fake({}, { [DISCOVERY]: new Response("{}", { headers: { "content-type": "application/json", "content-length": "99999999" } }) }).transport.metadata());
await check("T38 failed discovery never cached", async () => {
  let count = 0;
  const transport = new TrustedOidcTransport(ISSUER, async () => {
    count++; if (count === 1) return json({ issuer: "wrong" }); return json(metadata);
  });
  await assert.rejects(() => transport.metadata(), OidcValidationError);
  await transport.metadata(); assert.equal(count, 2);
});
console.log(`\n=== Gate 008B trusted OIDC transport: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed ? 1 : 0;
