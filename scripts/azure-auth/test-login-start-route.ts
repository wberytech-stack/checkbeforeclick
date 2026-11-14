/** Offline login-start route regression tests: no network, cloud or live DB. */
import { strict as assert } from "node:assert";
import { runAzureLoginStartRoute } from "../../src/server/auth/azureLoginStartRoute.ts";
import type { CommittedStateQuery } from "../../src/server/auth/postgresLoginStateStore.ts";

const origin = "https://cbc.example";
const issuer = "https://tenant.ciamlogin.com/tenant/v2.0";
const endpoint = "https://tenant.ciamlogin.com/tenant/oauth2/v2.0/authorize";
const env = {
  CBC_AZURE_PUBLIC_ORIGIN: origin,
  CBC_AZURE_OIDC_ISSUER: issuer,
  CBC_AZURE_OIDC_CLIENT_ID: "cbc-app",
  CBC_AZURE_OIDC_STATE_ACTIVE_KID: "k1",
  CBC_AZURE_OIDC_STATE_KEYS: "k1:" + Buffer.alloc(32, 7).toString("base64url"),
};
const metadata = {
  issuer,
  authorizationEndpoint: endpoint,
  tokenEndpoint: "https://tenant.ciamlogin.com/tenant/oauth2/v2.0/token",
  jwksUri: "https://tenant.ciamlogin.com/tenant/discovery/v2.0/keys",
};
type Options = {
  target?: string;
  method?: string;
  env?: Record<string, string | undefined>;
  rows?: Record<string, unknown>[];
  sqlError?: boolean;
  commitError?: boolean;
  metadata?: typeof metadata;
  metadataError?: boolean;
};
async function invoke(options: Options = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  let commits = 0, metadataCalls = 0, factoryIssuer = "";
  const response = await runAzureLoginStartRoute(
    new Request(options.target ?? origin + "/auth/azure/start", { method: options.method ?? "GET" }),
    {
      env: options.env ?? env,
      async transaction<T>(fn: (client: CommittedStateQuery) => Promise<T>): Promise<T> {
        const result = await fn({
          async query(sql, values) {
            calls.push({ sql, values });
            if (options.sqlError) throw new Error("SQL password=never-disclose");
            return { rows: options.rows ?? [{ accepted: true }] };
          },
        });
        if (options.commitError) throw new Error("COMMIT failed password=never-disclose");
        commits++;
        return result;
      },
      transportFactory(value) {
        factoryIssuer = value;
        return {
          async metadata() {
            metadataCalls++;
            if (options.metadataError) throw new Error("provider secret=never-disclose");
            return options.metadata ?? metadata;
          },
        };
      },
    },
  );
  return { response, calls, commits, metadataCalls, factoryIssuer };
}
function denied(result: Awaited<ReturnType<typeof invoke>>, status = 503) {
  assert.equal(result.response.status, status);
  assert.equal(result.response.headers.get("location"), null);
  assert.deepEqual(result.response.headers.getSetCookie(), []);
  assert.equal(result.response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(result.response.headers.get("referrer-policy"), "no-referrer");
  assert.ok(!JSON.stringify([...result.response.headers]).includes("never-disclose"));
}
let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + ": " + String(error)); }
}
await check("R01 trusted metadata and committed reservation precede redirect", async () => {
  const result = await invoke();
  assert.equal(result.response.status, 303);
  assert.equal(result.factoryIssuer, issuer);
  assert.equal(result.metadataCalls, 1);
  assert.equal(result.commits, 1);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].sql, "SELECT public.app_reserve_oidc_login_state($1, $2::bigint) AS accepted");
  assert.match(result.calls[0].values[0] as string, /^[0-9a-f]{64}$/);
  assert.equal(typeof result.calls[0].values[1], "number");
  const location = new URL(result.response.headers.get("location")!);
  assert.equal(location.origin + location.pathname, endpoint);
  assert.equal(location.searchParams.get("redirect_uri"), origin + "/auth/callback");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(location.searchParams.get("response_type"), "code");
  assert.equal(result.response.headers.getSetCookie().length, 1);
  assert.match(result.response.headers.getSetCookie()[0], /^__Secure-cbc-oidc=v1\.k1\./);
  assert.match(result.response.headers.getSetCookie()[0], /HttpOnly; Secure; SameSite=Lax$/);
  assert.equal(result.response.headers.get("referrer-policy"), "no-referrer");
});
await check("R02 rejected reservation never issues redirect or cookie", async () => {
  const result = await invoke({ rows: [{ accepted: false }] });
  denied(result); assert.equal(result.commits, 1);
});
await check("R03 SQL failure never issues redirect or cookie", async () => {
  const result = await invoke({ sqlError: true });
  denied(result); assert.equal(result.commits, 0);
});
await check("R04 COMMIT failure never issues redirect or cookie", async () => {
  const result = await invoke({ commitError: true });
  denied(result); assert.equal(result.commits, 0);
});
await check("R05 malformed SQL boolean fails closed", async () => {
  const result = await invoke({ rows: [{ accepted: "true" }] });
  denied(result); assert.equal(result.commits, 1);
});
await check("R06 empty SQL result fails closed", async () => {
  const result = await invoke({ rows: [] });
  denied(result);
});
await check("R07 missing configuration never reaches metadata or SQL", async () => {
  const result = await invoke({ env: {} });
  denied(result); assert.equal(result.metadataCalls, 0); assert.deepEqual(result.calls, []);
});
await check("R08 insecure configured origin never reaches metadata or SQL", async () => {
  const result = await invoke({ env: { ...env, CBC_AZURE_PUBLIC_ORIGIN: "http://cbc.example" } });
  denied(result); assert.equal(result.metadataCalls, 0); assert.deepEqual(result.calls, []);
});
await check("R09 query redirect injection rejected before side effects", async () => {
  const result = await invoke({ target: origin + "/auth/azure/start?next=https://evil.example" });
  denied(result, 400); assert.equal(result.metadataCalls, 0); assert.deepEqual(result.calls, []);
});
await check("R10 wrong request origin rejected before side effects", async () => {
  const result = await invoke({ target: "https://evil.example/auth/azure/start" });
  denied(result, 400); assert.equal(result.metadataCalls, 0); assert.deepEqual(result.calls, []);
});
await check("R11 POST cannot initiate login", async () => {
  const result = await invoke({ method: "POST" });
  denied(result, 400); assert.equal(result.metadataCalls, 0); assert.deepEqual(result.calls, []);
});
await check("R12 wrong path cannot initiate login", async () => {
  const result = await invoke({ target: origin + "/auth/callback" });
  denied(result, 400); assert.equal(result.metadataCalls, 0); assert.deepEqual(result.calls, []);
});
await check("R13 issuer mix-up fails before reservation", async () => {
  const result = await invoke({ metadata: { ...metadata, issuer: "https://evil.example/tenant/v2.0" } });
  denied(result); assert.equal(result.metadataCalls, 1); assert.deepEqual(result.calls, []);
});
await check("R14 cross-tenant authorization endpoint fails before reservation", async () => {
  const result = await invoke({ metadata: { ...metadata, authorizationEndpoint:
    "https://tenant.ciamlogin.com/other/oauth2/v2.0/authorize" } });
  denied(result); assert.equal(result.metadataCalls, 1); assert.deepEqual(result.calls, []);
});
await check("R15 metadata transport failure sanitized and no reservation", async () => {
  const result = await invoke({ metadataError: true });
  denied(result); assert.equal(result.metadataCalls, 1); assert.deepEqual(result.calls, []);
});
console.log("\n=== Azure login-start route: " + passed + " passed, " + failed + " failed ===");
process.exitCode = failed ? 1 : 0;
