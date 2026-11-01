/** Gate 008B callback sequencing checks. All fakes: no network, DB or secrets. */
import { strict as assert } from "node:assert";
import { redeemAzureOidcCallback, AzureOidcCallbackError,
  type AzureOidcCallbackOperations } from "../../src/security/azureOidcCallback.ts";

const binding = { issuer: "https://tenant.ciamlogin.com/tenant/v2.0", clientId: "cbc-client" };
const redirectUri = "https://cbc.example/auth/callback";
const keys = { activeKid: "a", keys: { a: Buffer.alloc(32, 42) } };
const store = { reserve: async () => true, consume: async () => true };
const identity = { issuer: binding.issuer, subject: "sub-123", email: null, displayName: null };
const jwks = { keys: [{ kty: "RSA", kid: "a" }] };
const code = "valid-code";
let passed = 0; let failed = 0;
async function check(label: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); passed++; console.log(`PASS ${label}`); }
  catch (error) { failed++; console.error(`FAIL ${label}: ${String(error)}`); }
}
function fixture() {
  const calls: string[] = [];
  const operations: AzureOidcCallbackOperations = {
    async consumeState(args) {
      calls.push("consume");
      assert.equal(args.cookie, "sealed-cookie");
      assert.equal(args.callbackState, "state");
      assert.deepEqual(args.binding, binding);
      assert.equal(args.keys, keys);
      assert.equal(args.store, store);
      return { nonce: "expected-nonce", codeVerifier: "secret-verifier" };
    },
    async exchangeCode(args) {
      calls.push("exchange");
      assert.deepEqual(args, { code, codeVerifier: "secret-verifier", clientId: binding.clientId, redirectUri });
      return "signed-token";
    },
    async jwks(force) { calls.push(force ? "refresh" : "keys"); return jwks; },
    verifyIdToken(args) {
      calls.push("verify");
      assert.deepEqual(args, { token: "signed-token", jwks, issuer: binding.issuer,
        audience: binding.clientId, nonce: "expected-nonce" });
      return identity;
    },
  };
  const input = { code, state: "state", cookie: "sealed-cookie", binding,
    redirectUri, keys, store, operations };
  return { calls, operations, input };
}
async function rejects(f: ReturnType<typeof fixture>, overrides: object = {}) {
  await assert.rejects(redeemAzureOidcCallback({ ...f.input, ...overrides }),
    (e: unknown) => e instanceof AzureOidcCallbackError && e.message === "Authentication could not be completed");
}
await check("C01 state consumed before token exchange and verification", async () => {
  const f = fixture(); assert.deepEqual(await redeemAzureOidcCallback(f.input), identity);
  assert.deepEqual(f.calls, ["consume", "exchange", "keys", "verify"]);
});
await check("C02 provider error denies before state or network", async () => {
  const f = fixture(); await rejects(f, { providerError: "access_denied" }); assert.deepEqual(f.calls, []);
});
await check("C03 empty provider error also denies", async () => {
  const f = fixture(); await rejects(f, { providerError: "" }); assert.deepEqual(f.calls, []);
});
await check("C04 absent code denies", async () => {
  const f = fixture(); await rejects(f, { code: undefined }); assert.deepEqual(f.calls, []);
});
await check("C05 non-string code denies", async () => {
  const f = fixture(); await rejects(f, { code: ["a", "b"] }); assert.deepEqual(f.calls, []);
});
await check("C06 oversized code denies", async () => {
  const f = fixture(); await rejects(f, { code: "x".repeat(4097) }); assert.deepEqual(f.calls, []);
});
await check("C07 control characters deny", async () => {
  const f = fixture(); await rejects(f, { code: "abc\r\n" }); assert.deepEqual(f.calls, []);
});
await check("C08 redirect must be HTTPS", async () => {
  const f = fixture(); await rejects(f, { redirectUri: "http://cbc.example/auth/callback" }); assert.deepEqual(f.calls, []);
});
await check("C09 redirect cannot have userinfo", async () => {
  const f = fixture(); await rejects(f, { redirectUri: "https://x@cbc.example/auth/callback" }); assert.deepEqual(f.calls, []);
});
await check("C10 redirect cannot have query or fragment", async () => {
  const f = fixture(); await rejects(f, { redirectUri: redirectUri + "?next=evil" });
  await rejects(f, { redirectUri: redirectUri + "#fragment" }); assert.deepEqual(f.calls, []);
});
await check("C11 redirect must be callback path", async () => {
  const f = fixture(); await rejects(f, { redirectUri: "https://cbc.example/other" }); assert.deepEqual(f.calls, []);
});
await check("C12 failed state consumption never exchanges code", async () => {
  const f = fixture(); f.operations.consumeState = async () => { f.calls.push("consume"); throw Error("replayed"); };
  await rejects(f); assert.deepEqual(f.calls, ["consume"]);
});
await check("C13 failed code exchange never verifies token", async () => {
  const f = fixture(); f.operations.exchangeCode = async () => { f.calls.push("exchange"); throw Error("token secret=abc"); };
  await rejects(f); assert.deepEqual(f.calls, ["consume", "exchange"]);
});
await check("C14 failed JWKS fetch fails closed", async () => {
  const f = fixture(); f.operations.jwks = async () => { throw Error("JWKS unavailable"); };
  await rejects(f); assert.deepEqual(f.calls, ["consume", "exchange"]);
});
await check("C15 nonce mismatch never refreshes keys", async () => {
  const f = fixture(); f.operations.verifyIdToken = () => { f.calls.push("verify"); throw Error("OIDC nonce mismatch"); };
  await rejects(f); assert.deepEqual(f.calls, ["consume", "exchange", "keys", "verify"]);
});
await check("C16 issuer mismatch never refreshes keys", async () => {
  const f = fixture(); f.operations.verifyIdToken = () => { f.calls.push("verify"); throw Error("OIDC issuer mismatch"); };
  await rejects(f); assert.deepEqual(f.calls, ["consume", "exchange", "keys", "verify"]);
});
await check("C17 missing key refreshes exactly once", async () => {
  const f = fixture(); let count = 0;
  f.operations.verifyIdToken = () => { f.calls.push("verify"); if (count++ === 0) throw Error("OIDC signing key must be unique and present"); return identity; };
  assert.deepEqual(await redeemAzureOidcCallback(f.input), identity);
  assert.deepEqual(f.calls, ["consume", "exchange", "keys", "verify", "refresh", "verify"]);
});
await check("C18 signature failure refreshes exactly once", async () => {
  const f = fixture(); let count = 0;
  f.operations.verifyIdToken = () => { f.calls.push("verify"); if (count++ === 0) throw Error("OIDC signature invalid"); return identity; };
  assert.deepEqual(await redeemAzureOidcCallback(f.input), identity);
  assert.deepEqual(f.calls, ["consume", "exchange", "keys", "verify", "refresh", "verify"]);
});
await check("C19 second signature failure terminates", async () => {
  const f = fixture(); f.operations.verifyIdToken = () => { f.calls.push("verify"); throw Error("OIDC signature invalid"); };
  await rejects(f); assert.deepEqual(f.calls, ["consume", "exchange", "keys", "verify", "refresh", "verify"]);
});
await check("C20 refresh failure denies login", async () => {
  const f = fixture(); f.operations.verifyIdToken = () => { throw Error("OIDC signature invalid"); };
  f.operations.jwks = async (force) => { if (force) throw Error("provider failure"); return jwks; };
  await rejects(f);
});
await check("C21 token expiry never refreshes", async () => {
  const f = fixture(); f.operations.verifyIdToken = () => { f.calls.push("verify"); throw Error("OIDC token expired"); };
  await rejects(f); assert.deepEqual(f.calls, ["consume", "exchange", "keys", "verify"]);
});
console.log(`\n=== Gate 008B OIDC callback sequence: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed ? 1 : 0;
