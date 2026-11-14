/** Offline Gate 008B login-state tests: fake atomic store, no network or secrets. */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { AuthStateError, consumeLoginState, issueLoginState, loginStateSetCookie, loginStateClearCookie,
  LOGIN_STATE_COOKIE_NAME, LOGIN_STATE_TTL_SECONDS, type LoginStateStore } from "../../src/security/azureAuthState.ts";

const binding = { issuer: "https://tenant.ciamlogin.com/tenant-id/v2.0", clientId: "cbc-client-id" };
const makeChallenge = () => ({ state: randomBytes(32).toString("base64url"), nonce: randomBytes(32).toString("base64url"), codeVerifier: randomBytes(32).toString("base64url") });
const challenge = makeChallenge();
const key = randomBytes(32);
const keys = { activeKid: "current", keys: { current: key, old: randomBytes(32) } };
const NOW = 1_800_000_000;
function store(): LoginStateStore & { count(): number } {
  const items = new Map<string, number>();
  return {
    async reserve(hash, expiry) { if (items.has(hash)) return false; items.set(hash, expiry); return true; },
    async consume(hash, now) { const expiry = items.get(hash); items.delete(hash); return expiry !== undefined && now < expiry; },
    count() { return items.size; },
  };
}
let passed = 0; let failed = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${String(e)}`); }
}
async function rejects(name: string, fn: () => unknown | Promise<unknown>) {
  await check(name, async () => assert.rejects(async () => fn(), AuthStateError));
}
function fixture() {
  const db = store();
  return { db, issue: (overrides: Partial<Parameters<typeof issueLoginState>[0]> = {}) => issueLoginState({ challenge, binding, keys, store: db, nowSeconds: NOW, ...overrides }),
    redeem: (cookie: unknown, overrides: Partial<Parameters<typeof consumeLoginState>[0]> = {}) => consumeLoginState({ cookie, callbackState: challenge.state, binding, keys, store: db, nowSeconds: NOW + 1, ...overrides }) };
}
await check("S01 sealed state redeemed exactly once", async () => {
  const f = fixture(); const cookie = await f.issue(); assert.equal(f.db.count(), 1);
  assert.deepEqual(await f.redeem(cookie), { nonce: challenge.nonce, codeVerifier: challenge.codeVerifier });
  assert.equal(f.db.count(), 0);
  await assert.rejects(f.redeem(cookie), AuthStateError);
});
await rejects("S02 callback state mismatch rejected", async () => {
  const f = fixture(); const cookie = await f.issue(); await f.redeem(cookie, { callbackState: makeChallenge().state });
});
await check("S03 wrong state does not consume valid challenge", async () => {
  const f = fixture(); const cookie = await f.issue();
  await assert.rejects(f.redeem(cookie, { callbackState: makeChallenge().state }), AuthStateError);
  assert.equal(f.db.count(), 1); await f.redeem(cookie);
});
await rejects("S04 expired cookie denied", async () => { const f = fixture(); await f.redeem(await f.issue(), { nowSeconds: NOW + LOGIN_STATE_TTL_SECONDS }); });
await rejects("S05 future issuance denied", async () => { const f = fixture(); await f.redeem(await f.issue(), { nowSeconds: NOW - 61 }); });
await rejects("S06 issuer binding denied", async () => { const f = fixture(); await f.redeem(await f.issue(), { binding: { ...binding, issuer: "https://other.ciamlogin.com/t/v2.0" } }); });
await rejects("S07 client binding denied", async () => { const f = fixture(); await f.redeem(await f.issue(), { binding: { ...binding, clientId: "another-client" } }); });
await rejects("S08 wrong key denied", async () => { const f = fixture(); await f.redeem(await f.issue(), { keys: { activeKid: "current", keys: { current: randomBytes(32) } } }); });
await rejects("S09 unknown key ID denied", async () => { const f = fixture(); const c = await f.issue(); await f.redeem(c.replace(".current.", ".unknown.")); });
await rejects("S10 ciphertext tampering denied", async () => { const f = fixture(); const c = await f.issue(); const p = c.split("."); p[3] = (p[3][0] === "A" ? "B" : "A") + p[3].slice(1); await f.redeem(p.join(".")); });
await rejects("S11 authentication tag tampering denied", async () => { const f = fixture(); const c = await f.issue(); const p = c.split("."); p[4] = (p[4][0] === "A" ? "B" : "A") + p[4].slice(1); await f.redeem(p.join(".")); });
await rejects("S12 invalid IV denied", async () => { const f = fixture(); const c = await f.issue(); const p = c.split("."); p[2] = "a"; await f.redeem(p.join(".")); });
await rejects("S13 malformed encoding denied", async () => { const f = fixture(); await f.redeem((await f.issue()) + "="); });
await rejects("S14 oversized cookie denied", async () => { const f = fixture(); await f.redeem("a".repeat(5000)); });
await rejects("S15 missing cookie denied", async () => { const f = fixture(); await f.redeem(undefined); });
await rejects("S16 missing state denied", async () => { const f = fixture(); await f.redeem(await f.issue(), { callbackState: null }); });
await rejects("S17 invalid key size denied", async () => { const f = fixture(); await f.issue({ keys: { activeKid: "current", keys: { current: randomBytes(16) } } }); });
await rejects("S18 duplicate reservation denied", async () => { const f = fixture(); await f.issue(); await f.issue(); });
await rejects("S19 failed reservation denied", async () => { const f = fixture(); await f.issue({ store: { reserve: async () => { throw Error("db offline"); }, consume: async () => true } }); });
await rejects("S20 failed consume denied", async () => { const f = fixture(); const c = await f.issue(); await f.redeem(c, { store: { reserve: async () => true, consume: async () => { throw Error("db offline"); } } }); });
await check("S21 key rotation supports old decryption key", async () => {
  const f = fixture(); const c = await f.issue({ keys: { activeKid: "old", keys: keys.keys } }); await f.redeem(c);
});
await rejects("S22 old key removed rejects old cookie", async () => {
  const f = fixture(); const c = await f.issue({ keys: { activeKid: "old", keys: keys.keys } });
  await f.redeem(c, { keys: { activeKid: "current", keys: { current: key } } });
});
await rejects("S23 malformed state source denied", async () => { const f = fixture(); await f.issue({ challenge: { ...challenge, nonce: "invalid" } }); });
await rejects("S24 unsafe issuer denied", async () => { const f = fixture(); await f.issue({ binding: { ...binding, issuer: "http://tenant.ciamlogin.com/t/v2.0" } }); });
await check("S25 callback-only secure cookie attributes", async () => {
  const f = fixture(); const header = loginStateSetCookie(await f.issue());
  assert.ok(header.startsWith(`${LOGIN_STATE_COOKIE_NAME}=v1.`));
  for (const flag of ["Path=/auth/callback", "Max-Age=300", "HttpOnly", "Secure", "SameSite=Lax"]) assert.ok(header.includes(flag));
  assert.ok(!header.includes("Domain="));
  assert.equal(loginStateClearCookie(), `${LOGIN_STATE_COOKIE_NAME}=; Path=/auth/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
});
await check("S26 independent logins produce distinct IV/ciphertext", async () => {
  const f = fixture(); const a = await f.issue(); const b = await f.issue({ challenge: makeChallenge() }); assert.notEqual(a, b);
});
await rejects("S27 cookie header injection denied", () => loginStateSetCookie("v1.foo.bar.baz.tag\r\nSet-Cookie:evil=1"));
await rejects("S28 incorrect challenge key denied", async () => { const f = fixture(); await f.issue({ challenge: { ...challenge, codeVerifier: challenge.state } }); });
await rejects("S29 unreserved sealed cookie denied", async () => {
  const f = fixture(); const cookie = await f.issue(); const empty = store(); await f.redeem(cookie, { store: empty });
});
console.log(`\n=== Gate 008B one-time login state: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed ? 1 : 0;
