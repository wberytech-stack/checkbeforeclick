/** Gate 008B: offline HTTP callback boundary regression tests (no cloud or DB). */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { handleAzureCallbackHttp, readAzureLoginStateCookie, type AzureCallbackFields } from "../../src/security/azureCallbackHttp.ts";
import { loginStateClearCookie, LOGIN_STATE_COOKIE_NAME } from "../../src/security/azureAuthState.ts";
import { azureSessionSetCookie, createUnpersistedAzureSessionToken } from "../../src/security/azureSession.ts";
import type { AzureLoginCompletion } from "../../src/server/auth/completeAzureLogin";

const origin = "https://cbc.example";
const issuer = "https://tenant.ciamlogin.com/tenant/v2.0";
const state = randomBytes(32).toString("base64url");
const sealed = "v1.k1." + "a".repeat(16) + "." + "b".repeat(128) + "." + "c".repeat(22);
const cookieHeader = LOGIN_STATE_COOKIE_NAME + "=" + sealed + "; preference=light";
const session = azureSessionSetCookie(createUnpersistedAzureSessionToken().token);
const success = { ok: true as const, setCookies: [loginStateClearCookie(), session] as const };
const callbackUrl = origin + "/auth/callback?code=abc&state=" + state;
let calls = 0;
let complete: (fields: AzureCallbackFields) => Promise<AzureLoginCompletion> = async () => { calls++; return success; };
function make(url = callbackUrl, header = cookieHeader, method = "GET") {
  return new Request(url, { method, headers: { Cookie: header } });
}
async function run(request = make(), overrides: Record<string, unknown> = {}) {
  calls = 0;
  return handleAzureCallbackHttp(request, { publicOrigin: origin, issuer, complete: (fields) => complete(fields), ...overrides });
}
function cookies(response: Response) { return response.headers.getSetCookie(); }
function denied(response: Response, status = 303, called = 0) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("location"), status === 303 ? origin + "/azure" : null);
  assert.deepEqual(cookies(response), [loginStateClearCookie()]);
  assert.equal(calls, called);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
}
let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + ": " + String(error)); }
}
await check("H01 success redirects to fixed dashboard and sets canonical cookies", async () => {
  const response = await run();
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), origin + "/azure");
  assert.deepEqual(cookies(response), [loginStateClearCookie(), session]);
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(calls, 1);
});
await check("H02 failed completion cannot emit session", async () => {
  complete = async () => { calls++; return { ok: false, setCookies: [loginStateClearCookie()] }; };
  denied(await run(), 303, 1);
  complete = async () => { calls++; return success; };
});
const malformed: [string, string][] = [
  ["H03 duplicate code", callbackUrl + "&code=def"],
  ["H04 duplicate state", callbackUrl + "&state=" + state],
  ["H05 untrusted next redirect", callbackUrl + "&next=https://evil.example"],
  ["H06 hostile request origin", "https://evil.example/auth/callback?code=abc&state=" + state],
  ["H07 insecure request origin", "http://cbc.example/auth/callback?code=abc&state=" + state],
  ["H08 wrong path", origin + "/auth/other?code=abc&state=" + state],
  ["H09 code and provider error", callbackUrl + "&error=access_denied"],
  ["H10 provider error only", origin + "/auth/callback?error=access_denied&error_description=secret"],
  ["H11 mismatched RFC 9207 issuer", callbackUrl + "&iss=https%3A%2F%2Fevil.example"],
  ["H12 invalid state", origin + "/auth/callback?code=abc&state=bad"],
  ["H13 oversized query", callbackUrl + "&session_state=" + "x".repeat(9000)],
  ["H14 duplicate error parameter", callbackUrl + "&error=a&error=b"],
  ["H15 missing code", origin + "/auth/callback?state=" + state],
  ["H16 percent-encoded duplicate key", callbackUrl + "&c%6fde=def"],
];
for (const [name, url] of malformed) {
  await check(name + " denied before exchange", async () => denied(await run(make(url))));
}
await check("H17 matching issuer response accepted", async () => {
  const response = await run(make(callbackUrl + "&iss=" + encodeURIComponent(issuer)));
  assert.equal(response.headers.get("location"), origin + "/azure"); assert.equal(calls, 1);
});
await check("H18 optional session_state accepted", async () => {
  const response = await run(make(callbackUrl + "&session_state=opaque"));
  assert.equal(response.headers.get("location"), origin + "/azure"); assert.equal(calls, 1);
});
await check("H19 absent login-state cookie denied", async () => denied(await run(make(callbackUrl, "other=abc"))));
await check("H20 duplicate login-state cookie denied", async () => denied(await run(make(callbackUrl, cookieHeader + "; " + LOGIN_STATE_COOKIE_NAME + "=" + sealed))));
await check("H21 encoded login-state cookie denied", async () => denied(await run(make(callbackUrl, LOGIN_STATE_COOKIE_NAME + "=%76" + sealed.slice(1)))));
await check("H22 CRLF cookie rejected", async () => assert.equal(readAzureLoginStateCookie(cookieHeader + "\r\nInjected: yes"), null));
await check("H23 POST denied", async () => denied(await run(make(callbackUrl, cookieHeader, "POST"))));
await check("H24 exception sanitized and state cleared", async () => {
  complete = async () => { calls++; throw new Error("database password=secret"); };
  const response = await run(); denied(response, 303, 1);
  assert.ok(!(await response.text()).includes("secret"));
  complete = async () => { calls++; return success; };
});
await check("H25 injected session cookie from completion rejected", async () => {
  complete = async () => { calls++; return { ok: true, setCookies: [loginStateClearCookie(), session + "\r\nX-Injection: yes"] }; };
  denied(await run(), 303, 1);
  complete = async () => { calls++; return success; };
});
await check("H26 malformed session token rejected", async () => {
  complete = async () => { calls++; return { ok: true, setCookies: [loginStateClearCookie(), "__Host-cbc-session=bad; Path=/; HttpOnly; Secure"] }; };
  denied(await run(), 303, 1);
  complete = async () => { calls++; return success; };
});
await check("H27 forged state-clearing cookie rejected", async () => {
  complete = async () => { calls++; return { ok: true, setCookies: ["invalid", session] }; };
  denied(await run(), 303, 1);
  complete = async () => { calls++; return success; };
});
await check("H28 invalid configured public origin fails closed", async () => denied(await run(make(), { publicOrigin: "http://cbc.example" }), 503));
await check("H29 invalid configured issuer fails closed", async () => denied(await run(make(), { issuer: "https://evil.example/?redirect=x" }), 503));
await check("H30 untrusted provider error description never reflected", async () => {
  const response = await run(make(origin + "/auth/callback?error=access_denied&error_description=" + encodeURIComponent("secret\r\nX-Test: yes")));
  denied(response);
  assert.ok(!JSON.stringify([...response.headers]).includes("secret"));
});
console.log("\n=== Gate 008B Azure callback HTTP boundary: " + passed + " passed, " + failed + " failed ===");
process.exitCode = failed ? 1 : 0;
