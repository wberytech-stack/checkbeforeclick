/** Offline configuration security regression tests: no network or secrets. */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { parseAzureRuntimeConfig } from "../../src/server/auth/azureRuntimeConfig.ts";

const key = () => randomBytes(32).toString("base64url");
const k1 = key(), k2 = key(), k3 = key(), k4 = key();
const good = {
  CBC_AZURE_PUBLIC_ORIGIN: "https://cbc.example",
  CBC_AZURE_OIDC_ISSUER: "https://tenant.ciamlogin.com/tenant/v2.0",
  CBC_AZURE_OIDC_CLIENT_ID: "b9731234-1234-1234-1234-123456789012",
  CBC_AZURE_OIDC_STATE_ACTIVE_KID: "k1",
  CBC_AZURE_OIDC_STATE_KEYS: `k1:${k1}`,
};
let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + ": " + String(error)); }
}
function reject(name: string, overrides: Record<string, string | undefined>) {
  check(name, () => assert.throws(
    () => parseAzureRuntimeConfig({ ...good, ...overrides }),
    (error: unknown) => error instanceof Error &&
      error.message === "Azure authentication configuration unavailable",
  ));
}
check("C01 valid fixed origin issuer and 256-bit key", () => {
  const parsed = parseAzureRuntimeConfig(good);
  assert.equal(parsed.publicOrigin, good.CBC_AZURE_PUBLIC_ORIGIN);
  assert.deepEqual(parsed.binding, { issuer: good.CBC_AZURE_OIDC_ISSUER,
    clientId: good.CBC_AZURE_OIDC_CLIENT_ID });
  assert.equal(parsed.keys.activeKid, "k1");
  assert.equal(parsed.keys.keys.k1.toString("base64url"), k1);
  assert.equal(parsed.keys.keys.k1.length, 32);
});
check("C02 rotation accepts previous keys without changing active", () => {
  const parsed = parseAzureRuntimeConfig({ ...good, CBC_AZURE_OIDC_STATE_ACTIVE_KID: "k2",
    CBC_AZURE_OIDC_STATE_KEYS: `k1:${k1},k2:${k2},k3:${k3}` });
  assert.equal(parsed.keys.activeKid, "k2");
  assert.deepEqual(Object.keys(parsed.keys.keys), ["k1", "k2", "k3"]);
});
reject("C03 missing origin", { CBC_AZURE_PUBLIC_ORIGIN: undefined });
reject("C04 HTTP origin", { CBC_AZURE_PUBLIC_ORIGIN: "http://cbc.example" });
reject("C05 origin path", { CBC_AZURE_PUBLIC_ORIGIN: "https://cbc.example/auth" });
reject("C06 origin slash", { CBC_AZURE_PUBLIC_ORIGIN: "https://cbc.example/" });
reject("C07 origin userinfo", { CBC_AZURE_PUBLIC_ORIGIN: "https://user@cbc.example" });
reject("C08 origin query", { CBC_AZURE_PUBLIC_ORIGIN: "https://cbc.example?next=x" });
reject("C09 origin fragment", { CBC_AZURE_PUBLIC_ORIGIN: "https://cbc.example#x" });
reject("C10 noncanonical origin port", { CBC_AZURE_PUBLIC_ORIGIN: "https://cbc.example:443" });
reject("C11 origin header injection", { CBC_AZURE_PUBLIC_ORIGIN: "https://cbc.example\r\nHost:evil" });
reject("C12 missing issuer", { CBC_AZURE_OIDC_ISSUER: undefined });
reject("C13 HTTP issuer", { CBC_AZURE_OIDC_ISSUER: "http://tenant.ciamlogin.com/tenant/v2.0" });
reject("C14 issuer wrong version", { CBC_AZURE_OIDC_ISSUER: "https://tenant.ciamlogin.com/tenant/v1.0" });
reject("C15 issuer root version", { CBC_AZURE_OIDC_ISSUER: "https://tenant.ciamlogin.com/v2.0" });
reject("C16 issuer other tenant encoding", { CBC_AZURE_OIDC_ISSUER: "https://tenant.ciamlogin.com/tenant%2fother/v2.0" });
reject("C17 issuer query", { CBC_AZURE_OIDC_ISSUER: good.CBC_AZURE_OIDC_ISSUER + "?x=1" });
reject("C18 issuer userinfo", { CBC_AZURE_OIDC_ISSUER: "https://user@tenant.ciamlogin.com/tenant/v2.0" });
reject("C19 missing client", { CBC_AZURE_OIDC_CLIENT_ID: undefined });
reject("C20 client injection", { CBC_AZURE_OIDC_CLIENT_ID: "client\r\nX-Evil: 1" });
reject("C21 missing active kid", { CBC_AZURE_OIDC_STATE_ACTIVE_KID: undefined });
reject("C22 unknown active kid", { CBC_AZURE_OIDC_STATE_ACTIVE_KID: "missing" });
reject("C23 malformed active kid", { CBC_AZURE_OIDC_STATE_ACTIVE_KID: "k1;evil" });
reject("C24 no keys", { CBC_AZURE_OIDC_STATE_KEYS: undefined });
reject("C25 short key", { CBC_AZURE_OIDC_STATE_KEYS: "k1:AA" });
reject("C26 padded key", { CBC_AZURE_OIDC_STATE_KEYS: `k1:${k1}=` });
reject("C27 whitespace", { CBC_AZURE_OIDC_STATE_KEYS: `k1:${k1} ` });
reject("C28 duplicate key IDs", { CBC_AZURE_OIDC_STATE_KEYS: `k1:${k1},k1:${k2}` });
reject("C29 empty key ID", { CBC_AZURE_OIDC_STATE_KEYS: `:${k1}` });
reject("C30 invalid key ID", { CBC_AZURE_OIDC_STATE_KEYS: `k.1:${k1}` });
reject("C31 too many keys", { CBC_AZURE_OIDC_STATE_KEYS: `k1:${k1},k2:${k2},k3:${k3},k4:${k4}` });
reject("C32 empty rotation entry", { CBC_AZURE_OIDC_STATE_KEYS: `k1:${k1},` });
reject("C33 key separator injection", { CBC_AZURE_OIDC_STATE_KEYS: `k1:${k1}:junk` });
reject("C34 noncanonical key", { CBC_AZURE_OIDC_STATE_KEYS: `k1:${k1.slice(0, -1)}*` });
reject("C35 no active key material", { CBC_AZURE_OIDC_STATE_KEYS: `k2:${k2}` });
reject("C36 oversized key material", { CBC_AZURE_OIDC_STATE_KEYS: `k1:${k1}`.repeat(20) });
check("C37 prototype-safe key registry", () => {
  const parsed = parseAzureRuntimeConfig({ ...good,
    CBC_AZURE_OIDC_STATE_ACTIVE_KID: "__proto__",
    CBC_AZURE_OIDC_STATE_KEYS: `__proto__:${k1}` });
  assert.equal(Object.getPrototypeOf(parsed.keys.keys), null);
  assert.equal(parsed.keys.keys.__proto__.toString("base64url"), k1);
});
console.log(`\n=== Azure runtime config: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed ? 1 : 0;
