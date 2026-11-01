/** Offline callback -> provision -> session tests; fake Entra/DB, real cryptography. */
import { strict as assert } from "node:assert";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { issueLoginState, loginStateClearCookie } from "../../src/security/azureAuthState.ts";
import { AZURE_SESSION_TTL_SECONDS, digestAzureSessionToken,
  readAzureSessionToken } from "../../src/security/azureSession.ts";
import { completeAzureLogin } from "../../src/server/auth/completeAzureLogin.ts";

const binding = { issuer: "https://tenant.ciamlogin.com/tenant/v2.0", clientId: "cbc-client" };
const redirectUri = "https://cbc.example/auth/callback";
const keys = { activeKid: "v1", keys: { v1: Buffer.alloc(32, 42) } };
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pub = publicKey.export({ format: "jwk" });
const jwks = { keys: [{ kty: "RSA", kid: "kid-1", n: pub.n, e: pub.e, alg: "RS256", use: "sig" }] };
const userId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const random = () => randomBytes(32).toString("base64url");
function signedToken(nonce: string, changes: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "RS256", typ: "JWT", kid: "kid-1" });
  const payload = b64({ iss: binding.issuer, aud: binding.clientId, sub: "subject-1",
    nonce, iat: now - 5, exp: now + 600, ...changes });
  const message = header + "." + payload;
  return message + "." + sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64url");
}
async function fixture() {
  const calls: string[] = [];
  const reserved = new Map<string, number>();
  const store = {
    async reserve(digest: string, expires: number) {
      calls.push("reserve");
      if (reserved.has(digest)) return false;
      reserved.set(digest, expires); return true;
    },
    async consume(digest: string, now: number) {
      calls.push("consume");
      const expires = reserved.get(digest);
      if (expires === undefined || now >= expires) return false;
      reserved.delete(digest); return true;
    },
  };
  const challenge = { state: random(), nonce: random(), codeVerifier: random() };
  const cookie = await issueLoginState({ challenge, binding, keys, store });
  let token = signedToken(challenge.nonce);
  let provision = true, persist = true, storageError = false;
  let storedDigest: string | null = null, storedExpiry = 0;
  const transport = {
    async exchangeCode(args: { code: string; codeVerifier: string; clientId: string; redirectUri: string }) {
      calls.push("exchange");
      assert.deepEqual(args, { code: "authorization-code", codeVerifier: challenge.codeVerifier,
        clientId: binding.clientId, redirectUri });
      return token;
    },
    async jwks(forceRefresh?: boolean) { calls.push(forceRefresh ? "refresh" : "jwks"); return jwks; },
  };
  const provisioner = {
    async provision(identity: { issuer: string; subject: string; email: string | null; displayName: string | null }) {
      calls.push("provision");
      assert.deepEqual(identity, { issuer: binding.issuer, subject: "subject-1", email: null, displayName: null });
      if (storageError) throw new Error("password=secret");
      return provision ? { userId, organizationId, role: "owner", created: false } : null;
    },
  };
  const sessions = {
    async create(identity: { issuer: string; subject: string }, digest: string, expires: number) {
      calls.push("create");
      assert.equal(identity.subject, "subject-1");
      assert.match(digest, /^[0-9a-f]{64}$/);
      storedDigest = digest; storedExpiry = expires;
      if (storageError) throw new Error("database password=secret");
      return persist;
    },
  };
  const callback = { code: "authorization-code", state: challenge.state, cookie, binding,
    redirectUri, keys, store, transport: transport as never };
  const run = (overrides: Partial<typeof callback> = {}) =>
    completeAzureLogin({ callback: { ...callback, ...overrides }, provisioner, sessions });
  return { run, calls, callback, challenge, provisioner, sessions,
    setToken: (value: string) => { token = value; },
    setProvision: (value: boolean) => { provision = value; },
    setPersist: (value: boolean) => { persist = value; },
    setStorageError: (value: boolean) => { storageError = value; },
    stored: () => ({ digest: storedDigest, expiry: storedExpiry }) };
}
let passed = 0, failed = 0;
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + ": " + String(error)); }
}
const cleared = loginStateClearCookie();
async function denied(f: Awaited<ReturnType<typeof fixture>>, overrides = {}) {
  const result = await f.run(overrides);
  assert.deepEqual(result, { ok: false, setCookies: [cleared] });
  assert.ok(!JSON.stringify(result).includes("secret"));
}
await check("L01 verified identity, committed digest, secure cookie in strict order", async () => {
  const f = await fixture(); const before = Math.floor(Date.now() / 1000);
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls, ["reserve", "consume", "exchange", "jwks", "provision", "create"]);
  assert.equal(result.setCookies[0], cleared);
  const cookie = result.setCookies[1];
  assert.match(cookie, /^__Host-cbc-session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$/);
  const raw = readAzureSessionToken(cookie.split(";")[0]);
  assert.ok(raw);
  assert.equal(f.stored().digest, digestAzureSessionToken(raw));
  assert.ok(f.stored().expiry >= before + AZURE_SESSION_TTL_SECONDS);
  assert.ok(f.stored().expiry <= Math.floor(Date.now() / 1000) + AZURE_SESSION_TTL_SECONDS);
});
await check("L02 replay cannot exchange or create session", async () => {
  const f = await fixture(); assert.equal((await f.run()).ok, true);
  const before = f.calls.length; await denied(f);
  assert.deepEqual(f.calls.slice(before), ["consume"]);
});
await check("L03 eight concurrent callbacks issue exactly one session", async () => {
  const f = await fixture(); const results = await Promise.all(Array.from({ length: 8 }, () => f.run()));
  assert.equal(results.filter(x => x.ok).length, 1);
  assert.equal(f.calls.filter(x => x === "exchange").length, 1);
  assert.equal(f.calls.filter(x => x === "create").length, 1);
});
await check("L04 tampered sealed cookie fails before exchange", async () => {
  const f = await fixture(); await denied(f, { cookie: f.callback.cookie + "x" });
  assert.deepEqual(f.calls, ["reserve"]);
});
await check("L05 callback state mismatch fails before exchange", async () => {
  const f = await fixture(); await denied(f, { state: random() });
  assert.deepEqual(f.calls, ["reserve"]);
});
await check("L06 provider error denies and clears state", async () => {
  const f = await fixture(); await denied(f, { providerError: "access_denied" });
  assert.deepEqual(f.calls, ["reserve"]);
});
await check("L07 missing authorization code denies", async () => {
  const f = await fixture(); await denied(f, { code: "" });
  assert.deepEqual(f.calls, ["reserve"]);
});
await check("L08 invalid token signature never provisions", async () => {
  const f = await fixture(); f.setToken(signedToken(f.challenge.nonce) + "x"); await denied(f);
  assert.ok(!f.calls.includes("provision"));
});
await check("L09 nonce mismatch never provisions", async () => {
  const f = await fixture(); f.setToken(signedToken(random())); await denied(f);
  assert.deepEqual(f.calls, ["reserve", "consume", "exchange", "jwks"]);
});
await check("L10 expired token never provisions", async () => {
  const f = await fixture(); const now = Math.floor(Date.now() / 1000);
  f.setToken(signedToken(f.challenge.nonce, { iat: now - 900, exp: now - 600 })); await denied(f);
  assert.ok(!f.calls.includes("provision"));
});
await check("L11 refused provisioning never creates session", async () => {
  const f = await fixture(); f.setProvision(false); await denied(f);
  assert.ok(f.calls.includes("provision")); assert.ok(!f.calls.includes("create"));
});
await check("L12 refused session commit never issues cookie", async () => {
  const f = await fixture(); f.setPersist(false); await denied(f);
  assert.ok(f.calls.includes("create"));
});
await check("L13 provisioning exception is sanitized", async () => {
  const f = await fixture(); f.setStorageError(true); await denied(f);
  assert.ok(!f.calls.includes("create"));
});
await check("L14 session exception is sanitized", async () => {
  const f = await fixture();
  const sessions = { create: async () => { throw new Error("database password=secret"); } };
  const result = await completeAzureLogin({ callback: f.callback, provisioner: f.provisioner, sessions });
  assert.deepEqual(result, { ok: false, setCookies: [cleared] });
});
await check("L15 wrong issuer never provisions", async () => {
  const f = await fixture(); f.setToken(signedToken(f.challenge.nonce, { iss: "https://evil.example/" }));
  await denied(f); assert.ok(!f.calls.includes("provision"));
});
await check("L16 wrong audience never provisions", async () => {
  const f = await fixture(); f.setToken(signedToken(f.challenge.nonce, { aud: "other-client" }));
  await denied(f); assert.ok(!f.calls.includes("provision"));
});
console.log("\n=== Gate 008B Azure login completion: " + passed + " passed, " + failed + " failed ===");
process.exitCode = failed ? 1 : 0;
