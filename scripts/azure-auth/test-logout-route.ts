/** Offline route wiring: committed revocation, secure config, CSRF and error semantics. */
import { strict as assert } from "node:assert";
import { createUnpersistedAzureSessionToken, azureSessionClearCookie } from "../../src/security/azureSession.ts";
import { runAzureLogoutRoute } from "../../src/server/auth/azureLogoutRoute.ts";
import type { CommittedSessionQuery } from "../../src/server/auth/postgresAuthSessionStore.ts";

const origin = "https://cbc.example";
const { token, digest } = createUnpersistedAzureSessionToken();
const cookie = "__Host-cbc-session=" + token;
const env = {
  CBC_AZURE_PUBLIC_ORIGIN: origin,
  CBC_AZURE_OIDC_ISSUER: "https://tenant.ciamlogin.com/tenant/v2.0",
  CBC_AZURE_OIDC_CLIENT_ID: "client-id",
  CBC_AZURE_OIDC_STATE_ACTIVE_KID: "k1",
  CBC_AZURE_OIDC_STATE_KEYS: "k1:" + Buffer.alloc(32, 7).toString("base64url"),
};
type Options = { env?: Record<string, string | undefined>; origin?: string; cookie?: string; result?: unknown; fail?: boolean };
async function invoke(options: Options = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  let committed = false;
  const request = new Request(origin + "/auth/azure/logout", {
    method: "POST",
    headers: { origin: options.origin ?? origin, cookie: options.cookie ?? cookie },
  });
  const response = await runAzureLogoutRoute(request, {
    env: options.env ?? env,
    async transaction<T>(fn: (client: CommittedSessionQuery) => Promise<T>): Promise<T> {
      const result = await fn({
        async query(sql, values) {
          calls.push({ sql, values });
          if (options.fail) throw new Error("SQL password=never-disclose");
          return { rows: options.result === undefined ? [{ ok: true }] : options.result as Record<string, unknown>[] };
        },
      });
      committed = true;
      return result;
    },
  });
  return { response, calls, committed };
}
let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + ": " + String(error)); }
}
await check("R01 successful logout commits digest-only SQL before redirect", async () => {
  const { response, calls, committed } = await invoke();
  assert.equal(response.status, 303);
  assert.equal(committed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, "SELECT public.app_revoke_auth_session($1) AS ok");
  assert.deepEqual(calls[0].values, [digest]);
  assert.ok(!JSON.stringify(calls).includes(token));
  assert.equal(response.headers.get("location"), origin + "/login");
  assert.deepEqual(response.headers.getSetCookie(), [azureSessionClearCookie()]);
});
await check("R02 already revoked digest remains idempotent", async () => {
  const { response, committed } = await invoke({ result: [{ ok: false }] });
  assert.equal(response.status, 303); assert.equal(committed, true);
});
await check("R03 SQL failure denies successful logout and sanitizes error", async () => {
  const { response, committed } = await invoke({ fail: true });
  assert.equal(response.status, 503); assert.equal(committed, false);
  assert.deepEqual(response.headers.getSetCookie(), [azureSessionClearCookie()]);
  assert.ok(!JSON.stringify([...response.headers]).includes("never-disclose"));
});
await check("R04 missing SQL result fails closed, not treated as revoked", async () => {
  const { response, committed } = await invoke({ result: [] });
  assert.equal(response.status, 503); assert.equal(committed, false);
});
await check("R05 malformed SQL result fails closed", async () => {
  const { response, committed } = await invoke({ result: [{ ok: "false" }] });
  assert.equal(response.status, 503); assert.equal(committed, false);
});
await check("R06 missing server configuration never reaches SQL", async () => {
  const { response, calls } = await invoke({ env: {} });
  assert.equal(response.status, 503); assert.deepEqual(calls, []);
  assert.deepEqual(response.headers.getSetCookie(), []);
});
await check("R07 hostile Origin rejected before SQL", async () => {
  const { response, calls } = await invoke({ origin: "https://evil.example" });
  assert.equal(response.status, 403); assert.deepEqual(calls, []);
  assert.deepEqual(response.headers.getSetCookie(), []);
});
await check("R08 missing session cookie clears without SQL", async () => {
  const { response, calls } = await invoke({ cookie: "" });
  assert.equal(response.status, 303); assert.deepEqual(calls, []);
  assert.deepEqual(response.headers.getSetCookie(), [azureSessionClearCookie()]);
});
await check("R09 duplicate session cookies never select a row", async () => {
  const { response, calls } = await invoke({ cookie: cookie + "; " + cookie });
  assert.equal(response.status, 303); assert.deepEqual(calls, []);
});
await check("R10 configured origin cannot be overridden by request", async () => {
  const { response, calls } = await invoke({ env: { ...env, CBC_AZURE_PUBLIC_ORIGIN: "http://cbc.example" } });
  assert.equal(response.status, 503); assert.deepEqual(calls, []);
});
console.log("\n=== Azure logout route wiring: " + passed + " passed, " + failed + " failed ===");
process.exitCode = failed ? 1 : 0;
