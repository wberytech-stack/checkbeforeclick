/** Offline Azure logout CSRF, revocation and cookie-clearing regressions. */
import { strict as assert } from "node:assert";
import { createUnpersistedAzureSessionToken, azureSessionClearCookie } from "../../src/security/azureSession.ts";
import { handleAzureLogoutHttp } from "../../src/security/azureLogoutHttp.ts";

const origin = "https://cbc.example";
const { token, digest } = createUnpersistedAzureSessionToken();
const cookie = `__Host-cbc-session=${token}`;
let calls: string[] = [];
let revoke = async (value: string): Promise<boolean> => { calls.push(value); return true; };
const config = () => ({ publicOrigin: origin, revoke });
function request(options: {
  url?: string; method?: string; headers?: Record<string, string>;
} = {}): Request {
  return new Request(options.url ?? `${origin}/auth/azure/logout`, {
    method: options.method ?? "POST",
    headers: { origin, cookie, ...options.headers },
  });
}
async function run(options: Parameters<typeof request>[0] = {}, override: Record<string, unknown> = {}) {
  calls = [];
  return handleAzureLogoutHttp(request(options), { ...config(), ...override });
}
function expectResponse(res: Response, status: number, cleared: boolean) {
  assert.equal(res.status, status);
  assert.equal(res.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("vary"), "Cookie, Origin");
  assert.deepEqual(res.headers.getSetCookie(), cleared ? [azureSessionClearCookie()] : []);
  assert.equal(res.headers.get("location"), status === 303 ? `${origin}/azure` : null);
}
let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + ": " + String(error)); }
}
await check("L01 POST revokes only SHA-256 digest and clears browser cookie", async () => {
  const res = await run(); expectResponse(res, 303, true);
  assert.deepEqual(calls, [digest]); assert.notEqual(calls[0], token);
});
await check("L02 already-revoked session still clears cookie", async () => {
  revoke = async (value) => { calls.push(value); return false; };
  expectResponse(await run(), 303, true); assert.deepEqual(calls, [digest]);
  revoke = async (value) => { calls.push(value); return true; };
});
await check("L03 absent session clears without SQL", async () => {
  expectResponse(await run({ headers: { cookie: "" } }), 303, true);
  assert.deepEqual(calls, []);
});
await check("L04 malformed token clears without SQL", async () => {
  expectResponse(await run({ headers: { cookie: "__Host-cbc-session=not-a-token" } }), 303, true);
  assert.deepEqual(calls, []);
});
await check("L05 duplicate cookies cannot choose a digest", async () => {
  expectResponse(await run({ headers: { cookie: `${cookie}; ${cookie}` } }), 303, true);
  assert.deepEqual(calls, []);
});
await check("L06 SQL outage clears cookie but does not claim revocation", async () => {
  revoke = async (value) => { calls.push(value); throw new Error("SQL password=secret"); };
  const res = await run(); expectResponse(res, 503, true);
  assert.deepEqual(calls, [digest]); assert.ok(!JSON.stringify([...res.headers]).includes("secret"));
  revoke = async (value) => { calls.push(value); return true; };
});
const denied: [string, Parameters<typeof request>[0]][] = [
  ["L07 missing Origin", { headers: { origin: "" } }],
  ["L08 cross-origin Origin", { headers: { origin: "https://evil.example" } }],
  ["L09 sibling subdomain Origin", { headers: { origin: "https://other.cbc.example" } }],
  ["L10 multiple Origin injection", { headers: { origin: `${origin}, https://evil.example` } }],
  ["L11 cross-origin Origin header (CSRF)", { headers: { origin: "https://evil.example" } }],
  ["L12 Origin header downgraded to http", { headers: { origin: "http://cbc.example" } }],
  ["L12b missing Origin header", { headers: { origin: "" } }],
  ["L12c proxied request with a hostile Origin header", { url: "http://0.0.0.0:3000/auth/azure/logout", headers: { origin: "https://evil.example", host: "cbc.example" } }],
  ["L13 GET not allowed", { method: "GET" }],
  ["L14 query not allowed", { url: `${origin}/auth/azure/logout?next=evil` }],
  ["L15 fragment not allowed", { url: `${origin}/auth/azure/logout#frag` }],
  ["L16 wrong route", { url: `${origin}/auth/callback` }],
  ["L17 cross-site fetch metadata", { headers: { "sec-fetch-site": "cross-site" } }],
  ["L18 same-site subdomain fetch metadata", { headers: { "sec-fetch-site": "same-site" } }],
  ["L19 body not accepted", { headers: { "content-length": "999999" } }],
  ["L20 transfer encoding not accepted", { headers: { "transfer-encoding": "chunked" } }],
];
for (const [name, options] of denied) await check(name, async () => {
  expectResponse(await run(options), 403, false); assert.deepEqual(calls, []);
});
// Gate 008C: request.url carries the bind origin in the standalone server (measured); a proxied same-origin
// logout must work, and Host / X-Forwarded-* cannot stand in for the browser's Origin header.
await check("L21b proxied logout with internal request origin and hostile forwarded headers revokes and clears", async () => {
  const res = await run({ url: "http://0.0.0.0:3000/auth/azure/logout", headers: { "sec-fetch-site": "same-origin", ...{ host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http", forwarded: "host=evil.example;proto=http" } } });
  expectResponse(res, 303, true); assert.deepEqual(calls, [digest]);
});
await check("L21 same-origin fetch metadata accepted", async () => {
  expectResponse(await run({ headers: { "sec-fetch-site": "same-origin", "content-length": "0" } }), 303, true);
  assert.deepEqual(calls, [digest]);
});
await check("L22 invalid configured public origin fails closed", async () => {
  const res = await run({}, { publicOrigin: "http://cbc.example" });
  assert.equal(res.status, 503); assert.deepEqual(res.headers.getSetCookie(), []);
  assert.deepEqual(calls, []);
});
await check("L23 missing revoke adapter fails closed", async () => {
  const res = await run({}, { revoke: null });
  assert.equal(res.status, 503); assert.deepEqual(res.headers.getSetCookie(), []);
  assert.deepEqual(calls, []);
});
await check("L24 unrelated cookie does not shadow valid session", async () => {
  const res = await run({ headers: { cookie: `${cookie}; invalid=bad` } });
  expectResponse(res, 303, true); assert.deepEqual(calls, [digest]);
});
console.log(`\n=== Gate 008B Azure logout HTTP: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed ? 1 : 0;
