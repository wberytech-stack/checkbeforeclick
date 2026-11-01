/** Offline Azure login initiation and HTTP boundary regression tests. */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { handleAzureLoginStartHttp, type AzureLoginStartResult } from "../../src/security/azureLoginStartHttp.ts";
import { loginStateSetCookie, type LoginStateStore } from "../../src/security/azureAuthState.ts";
import { startAzureLogin } from "../../src/server/auth/startAzureLogin.ts";

const origin = "https://cbc.example";
const issuer = "https://tenant.ciamlogin.com/tenant/v2.0";
const clientId = "cbc-app";
const endpoint = "https://tenant.ciamlogin.com/tenant/oauth2/v2.0/authorize";
const rand = () => randomBytes(32).toString("base64url");
const state = rand(), nonce = rand(), challenge = rand();
const cookie = loginStateSetCookie(`v1.k1.${"a".repeat(16)}.${"b".repeat(120)}.${"c".repeat(22)}`);
const url = new URL(endpoint);
for (const [key, value] of Object.entries({
  client_id: clientId, response_type: "code", redirect_uri: origin + "/auth/callback",
  response_mode: "query", scope: "openid profile email", state, nonce,
  code_challenge: challenge, code_challenge_method: "S256",
})) url.searchParams.set(key, value);
const valid: AzureLoginStartResult = { authorizationUrl: url.href, setCookie: cookie };
let called = 0;
let start: () => Promise<AzureLoginStartResult> = async () => { called++; return valid; };
const config = () => ({ publicOrigin: origin, issuer, clientId, start });
const request = (target = origin + "/auth/azure/start", method = "GET") => new Request(target, { method });
async function run(target?: string, overrides: Record<string, unknown> = {}, method = "GET") {
  called = 0;
  return handleAzureLoginStartHttp(request(target, method), { ...config(), ...overrides });
}
function denied(response: Response, status: number, calls = 0) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("location"), null);
  assert.deepEqual(response.headers.getSetCookie(), []);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(called, calls);
}
let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + ": " + String(error)); }
}
await check("S01 successful start redirects only to issuer-pinned endpoint", async () => {
  const res = await run();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), url.href);
  assert.deepEqual(res.headers.getSetCookie(), [cookie]);
  assert.equal(res.headers.get("pragma"), "no-cache");
  assert.equal(res.headers.get("vary"), "Cookie");
  assert.equal(called, 1);
});
for (const [name, target, method] of [
  ["S02 next redirect injection", origin + "/auth/azure/start?next=https://evil.example", "GET"],
  ["S03 duplicate query", origin + "/auth/azure/start?state=x&state=y", "GET"],
  ["S04 wrong path", origin + "/auth/callback", "GET"],
  ["S05 wrong host", "https://evil.example/auth/azure/start", "GET"],
  ["S06 insecure origin", "http://cbc.example/auth/azure/start", "GET"],
  ["S07 POST", origin + "/auth/azure/start", "POST"],
  ["S08 HEAD", origin + "/auth/azure/start", "HEAD"],
  ["S09 fragment", origin + "/auth/azure/start#secret", "GET"],
] as const) await check(name + " rejected before state reservation", async () => denied(await run(target, {}, method), 400));
for (const [name, overrides] of [
  ["S10 untrusted configured origin", { publicOrigin: "http://cbc.example" }],
  ["S11 origin userinfo", { publicOrigin: "https://u:p@cbc.example" }],
  ["S12 issuer query", { issuer: issuer + "?evil=1" }],
  ["S13 issuer tenant mismatch", { issuer: "https://tenant.ciamlogin.com/v2.0" }],
  ["S14 invalid client ID", { clientId: "bad\r\nX-Test: 1" }],
] as const) await check(name + " fails closed", async () => denied(await run(undefined, overrides), 503));
const tamper: [string, (url: URL) => void][] = [
  ["S15 attacker origin", u => { u.host = "evil.example"; }],
  ["S16 other tenant", u => { u.pathname = "/other/oauth2/v2.0/authorize"; }],
  ["S17 duplicate state", u => { u.searchParams.append("state", rand()); }],
  ["S18 unknown parameter", u => { u.searchParams.append("next", "https://evil.example"); }],
  ["S19 redirect exfiltration", u => { u.searchParams.set("redirect_uri", "https://evil.example/callback"); }],
  ["S20 non-PKCE", u => { u.searchParams.set("code_challenge_method", "plain"); }],
  ["S21 missing openid", u => { u.searchParams.set("scope", "profile email"); }],
  ["S22 implicit response", u => { u.searchParams.set("response_type", "id_token"); }],
  ["S23 invalid state", u => { u.searchParams.set("state", "bad"); }],
  ["S24 fragment", u => { u.hash = "#access_token=secret"; }],
];
for (const [name, mutate] of tamper) await check(name + " cannot redirect", async () => {
  const modified = new URL(url.href); mutate(modified);
  start = async () => { called++; return { ...valid, authorizationUrl: modified.href }; };
  denied(await run(), 503, 1);
  start = async () => { called++; return valid; };
});
await check("S25 injected Set-Cookie rejected", async () => {
  start = async () => { called++; return { ...valid, setCookie: cookie + "\r\nX-Test: yes" }; };
  denied(await run(), 503, 1);
  start = async () => { called++; return valid; };
});
await check("S26 exception is sanitized", async () => {
  start = async () => { called++; throw new Error("database password=secret"); };
  const res = await run(); denied(res, 503, 1);
  assert.ok(!JSON.stringify([...res.headers]).includes("secret"));
  start = async () => { called++; return valid; };
});

const keys = { activeKid: "k1", keys: { k1: randomBytes(32) } };
const binding = { issuer, clientId };
const metadata = { issuer, authorizationEndpoint: endpoint,
  tokenEndpoint: "https://tenant.ciamlogin.com/tenant/oauth2/v2.0/token",
  jwksUri: "https://tenant.ciamlogin.com/tenant/discovery/v2.0/keys" };
let reserves = 0;
const store: LoginStateStore = {
  reserve: async () => { reserves++; return true; },
  consume: async () => { throw new Error("must not consume at initiation"); },
};
await check("S27 trusted start reserves state before emitting redirect", async () => {
  reserves = 0;
  const result = await startAzureLogin({ publicOrigin: origin, binding, keys, store,
    transport: { metadata: async () => metadata } });
  assert.equal(reserves, 1);
  assert.equal(new URL(result.authorizationUrl).origin, new URL(issuer).origin);
  assert.equal(new URL(result.authorizationUrl).searchParams.get("code_challenge_method"), "S256");
  assert.ok(result.setCookie.startsWith("__Secure-cbc-oidc=v1.k1."));
  assert.ok(result.setCookie.includes("HttpOnly; Secure; SameSite=Lax"));
});
await check("S28 failed reservation never issues cookie or redirect", async () => {
  reserves = 0;
  await assert.rejects(() => startAzureLogin({ publicOrigin: origin, binding, keys,
    store: { ...store, reserve: async () => { reserves++; return false; } },
    transport: { metadata: async () => metadata } }), /Azure login initiation unavailable/);
  assert.equal(reserves, 1);
});
await check("S29 mismatched discovery issuer never reserves", async () => {
  reserves = 0;
  await assert.rejects(() => startAzureLogin({ publicOrigin: origin, binding, keys, store,
    transport: { metadata: async () => ({ ...metadata, issuer: "https://evil.example/v2.0" }) } }));
  assert.equal(reserves, 0);
});
await check("S30 poisoned authorization endpoint never reserves", async () => {
  reserves = 0;
  await assert.rejects(() => startAzureLogin({ publicOrigin: origin, binding, keys, store,
    transport: { metadata: async () => ({ ...metadata, authorizationEndpoint: "https://evil.example/authorize" }) } }));
  assert.equal(reserves, 0);
});
await check("S31 metadata failure never reserves", async () => {
  reserves = 0;
  await assert.rejects(() => startAzureLogin({ publicOrigin: origin, binding, keys, store,
    transport: { metadata: async () => { throw new Error("token=secret"); } } }));
  assert.equal(reserves, 0);
});
console.log(`\n=== Gate 008B Azure login start: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed ? 1 : 0;
