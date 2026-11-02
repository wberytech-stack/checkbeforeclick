/** Offline full Azure callback route tests: fake PostgreSQL and Entra, real crypto. */
import { strict as assert } from "node:assert";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { issueLoginState, loginStateClearCookie } from "../../src/security/azureAuthState.ts";
import { digestAzureSessionToken, readAzureSessionToken } from "../../src/security/azureSession.ts";
import { runAzureCallbackRoute } from "../../src/server/auth/azureCallbackRoute.ts";
import type { CommittedStateQuery } from "../../src/server/auth/postgresLoginStateStore.ts";
import type { TrustedOidcTransport } from "../../src/security/azureOidcTransport.ts";

const origin = "https://cbc.example";
const issuer = "https://tenant.ciamlogin.com/tenant/v2.0";
const clientId = "cbc-app";
const binding = { issuer, clientId };
const keys = { activeKid: "k1", keys: { k1: Buffer.alloc(32, 7) } };
const env = {
  CBC_AZURE_PUBLIC_ORIGIN: origin,
  CBC_AZURE_OIDC_ISSUER: issuer,
  CBC_AZURE_OIDC_CLIENT_ID: clientId,
  CBC_AZURE_OIDC_STATE_ACTIVE_KID: "k1",
  CBC_AZURE_OIDC_STATE_KEYS: "k1:" + keys.keys.k1.toString("base64url"),
};
const userId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pub = publicKey.export({ format: "jwk" });
const jwks = { keys: [{ kty: "RSA", kid: "kid-1", n: pub.n, e: pub.e, alg: "RS256", use: "sig" }] };
const random = () => randomBytes(32).toString("base64url");
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(nonce: string, claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const message = b64({ alg: "RS256", typ: "JWT", kid: "kid-1" }) + "." +
    b64({ iss: issuer, aud: clientId, sub: "subject-1", nonce, iat: now - 5, exp: now + 600, ...claims });
  return message + "." + sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64url");
}
type Options = {
  url?: string;
  cookie?: string;
  env?: Record<string, string | undefined>;
  commitErrorAt?: number;
  sqlErrorAt?: number;
  consumeRows?: Record<string, unknown>[];
  identityRows?: Record<string, unknown>[];
  sessionRows?: Record<string, unknown>[];
  tokenClaims?: Record<string, unknown>;
  badSignature?: boolean;
  exchangeError?: boolean;
  omitAssertionFactory?: boolean;
  signerError?: boolean;
};
async function fixture(options: Options = {}) {
  const events: string[] = [];
  const calls: { sql: string; values: unknown[] }[] = [];
  const reserved = new Map<string, number>();
  const challenge = { state: random(), nonce: random(), codeVerifier: random() };
  const sealed = await issueLoginState({
    challenge, binding, keys,
    store: {
      async reserve(digest, expiry) { reserved.set(digest, expiry); return true; },
      async consume() { throw new Error("test setup must not consume state"); },
    },
  });
  const cookie = "__Secure-cbc-oidc=" + sealed;
  const url = origin + "/auth/callback?code=authorization-code&state=" + challenge.state;
  let transactions = 0;
  let transportFactories = 0;
  async function invoke(overrides: Options = {}) {
    const opt = { ...options, ...overrides };
    const request = new Request(opt.url ?? url, { headers: { cookie: opt.cookie ?? cookie } });
    return runAzureCallbackRoute(request, {
      env: opt.env ?? env,
      async transaction<T>(fn: (client: CommittedStateQuery) => Promise<T>): Promise<T> {
        const number = ++transactions;
        const result = await fn({
          async query(sql, values) {
            calls.push({ sql, values });
            if (opt.sqlErrorAt === number) throw new Error("SQL password=never-disclose");
            if (sql.includes("app_consume_oidc_login_state")) {
              events.push("consume");
              const digest = values[0] as string;
              const exists = reserved.has(digest);
              reserved.delete(digest);
              return { rows: opt.consumeRows ?? [{ consumed: exists }] };
            }
            if (sql.includes("app_sign_in")) {
              events.push("provision");
              return { rows: opt.identityRows ?? [{
                o_user_id: userId, o_organization_id: organizationId,
                o_role: "owner", o_created: false,
              }] };
            }
            if (sql.includes("app_create_auth_session")) {
              events.push("session");
              return { rows: opt.sessionRows ?? [{ ok: true }] };
            }
            throw new Error("unexpected SQL");
          },
        });
        if (opt.commitErrorAt === number) throw new Error("COMMIT failed password=never-disclose");
        events.push("commit" + number);
        return result;
      },
      clientAssertionFactory: opt.omitAssertionFactory ? undefined : () => {
        if (opt.signerError) throw new Error("client key secret=never-disclose");
        return "abc.def.ghi";
      },
      transportFactory(actualIssuer) {
        transportFactories++;
        assert.equal(actualIssuer, issuer);
        return {
          async exchangeCode(args: { code: string; codeVerifier: string; clientId: string; redirectUri: string; clientAssertion: string }) {
            events.push("exchange");
            assert.deepEqual(args, {
              code: "authorization-code", codeVerifier: challenge.codeVerifier,
              clientId, redirectUri: origin + "/auth/callback", clientAssertion: "abc.def.ghi",
            });
            if (opt.exchangeError) throw new Error("provider secret=never-disclose");
            const jwt = token(challenge.nonce, opt.tokenClaims);
            const signatureStart = jwt.lastIndexOf(".") + 1;
            return opt.badSignature ? jwt.slice(0, signatureStart) +
              (jwt[signatureStart] === "A" ? "B" : "A") + jwt.slice(signatureStart + 1) : jwt;
          },
          async jwks(forceRefresh?: boolean) {
            events.push(forceRefresh ? "refresh" : "jwks");
            return jwks;
          },
        } as unknown as TrustedOidcTransport;
      },
    });
  }
  return { invoke, calls, events, url, cookie, challenge,
    get transactions() { return transactions; },
    get transportFactories() { return transportFactories; } };
}
function denied(response: Response, status = 303) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("location"), status === 303 ? origin + "/azure" : null);
  assert.deepEqual(response.headers.getSetCookie(), [loginStateClearCookie()]);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.ok(!JSON.stringify([...response.headers]).includes("never-disclose"));
}
let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + ": " + String(error)); }
}
await check("C01 state commit -> exchange -> verify -> provision commit -> session commit -> cookie", async () => {
  const f = await fixture(); const response = await f.invoke();
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), origin + "/azure");
  assert.deepEqual(f.events, ["consume", "commit1", "exchange", "jwks", "provision", "commit2", "session", "commit3"]);
  assert.equal(f.transactions, 3);
  assert.deepEqual(response.headers.getSetCookie()[0], loginStateClearCookie());
  const sessionCookie = response.headers.getSetCookie()[1];
  const raw = readAzureSessionToken(sessionCookie.split(";")[0]);
  assert.ok(raw);
  assert.equal(f.calls[2].values[2], digestAzureSessionToken(raw));
  assert.ok(!JSON.stringify(f.calls).includes(raw));
  assert.deepEqual(f.calls[1].values.slice(0, 2), [issuer, "subject-1"]);
  assert.deepEqual(f.calls[2].values.slice(0, 2), [issuer, "subject-1"]);
});
await check("C02 replay cannot exchange or provision", async () => {
  const f = await fixture(); assert.equal((await f.invoke()).status, 303);
  const before = f.events.length;
  denied(await f.invoke());
  assert.deepEqual(f.events.slice(before), ["consume", "commit4"]);
});
await check("C03 eight concurrent callbacks issue exactly one session", async () => {
  const f = await fixture();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.invoke()));
  assert.equal(results.filter((r) => r.headers.getSetCookie().length === 2).length, 1);
  assert.equal(f.events.filter((x) => x === "exchange").length, 1);
  assert.equal(f.events.filter((x) => x === "session").length, 1);
});
await check("C04 duplicate code rejected before transport or SQL", async () => {
  const f = await fixture(); denied(await f.invoke({ url: f.url + "&code=evil" }));
  assert.deepEqual(f.calls, []); assert.equal(f.transportFactories, 0);
});
await check("C05 untrusted redirect parameter rejected", async () => {
  const f = await fixture(); denied(await f.invoke({ url: f.url + "&next=https://evil.example" }));
  assert.deepEqual(f.calls, []);
});
await check("C06 mismatched RFC 9207 issuer rejected", async () => {
  const f = await fixture(); denied(await f.invoke({ url: f.url + "&iss=https%3A%2F%2Fevil.example" }));
  assert.deepEqual(f.calls, []);
});
await check("C07 duplicate state cookie rejected", async () => {
  const f = await fixture(); denied(await f.invoke({ cookie: f.cookie + "; " + f.cookie }));
  assert.deepEqual(f.calls, []);
});
await check("C08 missing configuration returns sanitized 503 and clears state", async () => {
  const f = await fixture(); denied(await f.invoke({ env: {} }), 503);
  assert.deepEqual(f.calls, []); assert.equal(f.transportFactories, 0);
});
await check("C09 hostile origin denied before SQL", async () => {
  const f = await fixture();
  denied(await f.invoke({ url: f.url.replace(origin, "https://evil.example") }));
  assert.deepEqual(f.calls, []);
});
await check("C10 state consume SQL failure prevents token exchange", async () => {
  const f = await fixture(); denied(await f.invoke({ sqlErrorAt: 1 }));
  assert.ok(!f.events.includes("exchange"));
});
await check("C11 state consume COMMIT failure prevents token exchange", async () => {
  const f = await fixture(); denied(await f.invoke({ commitErrorAt: 1 }));
  assert.ok(!f.events.includes("exchange"));
});
await check("C12 malformed state consume result fails closed", async () => {
  const f = await fixture(); denied(await f.invoke({ consumeRows: [{ consumed: "true" }] }));
  assert.ok(!f.events.includes("exchange"));
});
await check("C13 provider token exchange failure cannot create session", async () => {
  const f = await fixture(); denied(await f.invoke({ exchangeError: true }));
  assert.ok(!f.events.includes("provision"));
});
await check("C14 invalid token issuer cannot provision", async () => {
  const f = await fixture(); denied(await f.invoke({ tokenClaims: { iss: "https://evil.example/" } }));
  assert.ok(!f.events.includes("provision"));
});
await check("C15 invalid token nonce cannot provision", async () => {
  const f = await fixture(); denied(await f.invoke({ tokenClaims: { nonce: random() } }));
  assert.ok(!f.events.includes("provision"));
});
await check("C16 invalid token signature cannot provision", async () => {
  const f = await fixture(); denied(await f.invoke({ badSignature: true }));
  assert.ok(!f.events.includes("provision"));
});
await check("C17 malformed identity result cannot create session", async () => {
  const f = await fixture(); denied(await f.invoke({ identityRows: [{ o_user_id: "forged" }] }));
  assert.ok(!f.events.includes("session"));
});
await check("C18 provisioning COMMIT failure cannot create session", async () => {
  const f = await fixture(); denied(await f.invoke({ commitErrorAt: 2 }));
  assert.ok(!f.events.includes("session"));
});
await check("C19 session SQL failure cannot issue credential", async () => {
  const f = await fixture(); denied(await f.invoke({ sqlErrorAt: 3 }));
  assert.ok(f.events.includes("session") === false);
});
await check("C20 session COMMIT failure cannot issue credential", async () => {
  const f = await fixture(); denied(await f.invoke({ commitErrorAt: 3 }));
  assert.ok(f.events.includes("session"));
  assert.ok(!f.events.includes("commit3"));
});
await check("C21 session function false cannot issue credential", async () => {
  const f = await fixture(); denied(await f.invoke({ sessionRows: [{ ok: false }] }));
  assert.ok(f.events.includes("commit3"));
});
await check("C22 malformed session result cannot issue credential", async () => {
  const f = await fixture(); denied(await f.invoke({ sessionRows: [{ ok: "true" }] }));
});
await check("C23 missing confidential-client credential denies before state consumption", async () => {
  const f = await fixture(); denied(await f.invoke({ omitAssertionFactory: true }), 503);
  assert.deepEqual(f.calls, []); assert.equal(f.transportFactories, 0);
});
await check("C24 signing failure prevents code exchange and session", async () => {
  const f = await fixture(); denied(await f.invoke({ signerError: true }));
  assert.deepEqual(f.events, ["consume", "commit1"]);
  assert.equal(f.transactions, 1);
});
console.log("\n=== Azure callback route integration: " + passed + " passed, " + failed + " failed ===");
process.exitCode = failed ? 1 : 0;
