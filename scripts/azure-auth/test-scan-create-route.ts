/** Offline Azure scan creation security tests; no network or database. */
import { strict as assert } from "node:assert";
import {
  AZURE_SESSION_COOKIE_NAME, createUnpersistedAzureSessionToken,
} from "../../src/security/azureSession.ts";
import { runAzureScanCreateRoute } from "../../src/server/data/azureScanCreateRoute.ts";
import type { CommittedSessionQuery } from "../../src/server/auth/postgresAuthSessionStore.ts";

const ORIGIN = "https://cbc.example";
const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const FOREIGN = "33333333-3333-4333-8333-333333333333";
const SCAN = "44444444-4444-4444-8444-444444444444";
const { token, digest } = createUnpersistedAzureSessionToken();
const cookie = AZURE_SESSION_COOKIE_NAME + "=" + token;
const env = {
  CBC_AZURE_PUBLIC_ORIGIN: ORIGIN,
  CBC_AZURE_OIDC_ISSUER: "https://tenant.ciamlogin.com/tenant/v2.0",
  CBC_AZURE_OIDC_CLIENT_ID: "cbc-app",
  CBC_AZURE_OIDC_STATE_ACTIVE_KID: "k1",
  CBC_AZURE_OIDC_STATE_KEYS: "k1:" + Buffer.alloc(32, 7).toString("base64url"),
};
const payload = JSON.stringify({ input_type: "url", raw_input: "https://example.org/" });
const session = { o_user_id: USER, o_organization_id: ORG, o_role: "owner" };

type Options = {
  body?: string | Uint8Array; method?: string; url?: string;
  origin?: string | null; fetchSite?: string | null; cookie?: string;
  contentType?: string; contentLength?: string; contentEncoding?: string;
  env?: Record<string, string | undefined>;
  sessions?: Record<string, unknown>[]; create?: Record<string, unknown>[];
  contextOrg?: string; fail?: "session" | "context" | "create" | "commit";
};
function fixture(options: Options = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const events: string[] = [];
  const headers = new Headers();
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  if (options.fetchSite !== null) headers.set("sec-fetch-site", options.fetchSite ?? "same-origin");
  if (options.cookie !== "") headers.set("cookie", options.cookie ?? cookie);
  if (options.contentType !== "") headers.set("content-type", options.contentType ?? "application/json");
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  if (options.contentEncoding !== undefined) headers.set("content-encoding", options.contentEncoding);
  const request = new Request(options.url ?? ORIGIN + "/api/azure/scans", {
    method: options.method ?? "POST", headers,
    ...(options.method === "GET" ? {} : { body: options.body ?? payload }),
  });
  const deps = {
    env: options.env ?? env,
    async transaction<T>(fn: (client: CommittedSessionQuery) => Promise<T>): Promise<T> {
      events.push("BEGIN");
      try {
        const result = await fn({
          async query(sql, values) {
            calls.push({ sql, values });
            if (sql.includes("app_resolve_auth_session")) {
              events.push("session");
              if (options.fail === "session") throw new Error("SQL password=SECRET");
              return { rows: options.sessions ?? [session] };
            }
            if (sql.includes("set_config")) {
              events.push("context");
              if (options.fail === "context") throw new Error("SQL password=SECRET");
              return { rows: [{ user_id: USER, organization_id: options.contextOrg ?? ORG }] };
            }
            if (sql.includes("app_create_scan")) {
              events.push("create");
              if (options.fail === "create") throw new Error("SQL password=SECRET");
              return { rows: options.create ?? [{ id: SCAN }] };
            }
            throw new Error("Unexpected SQL");
          },
        });
        if (options.fail === "commit") throw new Error("COMMIT password=SECRET");
        events.push("COMMIT");
        return result;
      } catch (error) {
        events.push("ROLLBACK");
        throw error;
      }
    },
  };
  return { calls, events, run: () => runAzureScanCreateRoute(request, deps) };
}

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + ": " + String(error)); }
}
async function status(f: ReturnType<typeof fixture>, code: number) {
  const response = await f.run();
  assert.equal(response.status, code);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("vary"), "Cookie, Origin, Sec-Fetch-Site");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("set-cookie"), null);
  return response;
}
await check("C01 committed tenant-scoped scan creation returns only id and pending", async () => {
  const f = fixture(); const response = await status(f, 201);
  assert.deepEqual(await response.json(), { id: SCAN, status: "pending" });
  assert.deepEqual(f.events, ["BEGIN", "session", "context", "create", "COMMIT"]);
  assert.deepEqual(f.calls[0].values, [digest]);
  assert.deepEqual(f.calls[1].values, [USER, ORG]);
  assert.deepEqual(f.calls[2].values, ["url", "https://example.org/"]);
  assert.equal(f.calls[2].sql, "SELECT public.app_create_scan($1::text, $2::text) AS id");
  assert.ok(!JSON.stringify(f.calls).includes(token));
});
await check("C02 browser-supplied tenant and role cannot select a tenant", async () => {
  const f = fixture({ url: ORIGIN + "/api/azure/scans", body: JSON.stringify({ input_type: "url", raw_input: "https://example.org/?tenant=" + FOREIGN }) });
  await status(f, 201);
  assert.deepEqual(f.calls[1].values, [USER, ORG]);
  assert.deepEqual(f.calls[2].values, ["url", "https://example.org/?tenant=" + FOREIGN]);
});
await check("C03 missing cookie denies before SQL", async () => {
  const f = fixture({ cookie: "" }); await status(f, 401); assert.deepEqual(f.events, []);
});
await check("C04 duplicate session cookie denies before SQL", async () => {
  const f = fixture({ cookie: cookie + "; " + cookie }); await status(f, 401); assert.deepEqual(f.events, []);
});
await check("C05 expired or revoked session denies creation", async () => {
  const f = fixture({ sessions: [] }); await status(f, 401);
  assert.deepEqual(f.events, ["BEGIN", "session", "COMMIT"]);
});
await check("C06 DB-derived viewer role cannot create", async () => {
  const f = fixture({ sessions: [{ ...session, o_role: "viewer" }] });
  await status(f, 403); assert.ok(!f.events.includes("create"));
});
await check("C06a only database-supported writing roles can create scans", async () => {
  for (const role of ["owner", "admin", "member"]) {
    const f = fixture({ sessions: [{ ...session, o_role: role }] });
    await status(f, 201); assert.ok(f.events.includes("create"));
  }
});
await check("C06b unexpected but syntactically valid roles fail closed before scan creation", async () => {
  for (const role of ["analyst", "guest", "service", "owner_backup"]) {
    const f = fixture({ sessions: [{ ...session, o_role: role }] });
    await status(f, 403); assert.ok(!f.events.includes("create"));
  }
});
await check("C07 foreign or invalid session membership fails closed", async () => {
  const f = fixture({ contextOrg: FOREIGN }); await status(f, 503);
  assert.deepEqual(f.events, ["BEGIN", "session", "context", "ROLLBACK"]);
});
await check("C08 unknown or extra JSON member rejected before DB", async () => {
  const f = fixture({ body: '{"input_type":"url","raw_input":"x","organization_id":"' + FOREIGN + '"}' });
  await status(f, 400); assert.deepEqual(f.events, []);
});
await check("C09 duplicate JSON member rejected before DB", async () => {
  const f = fixture({ body: '{"input_type":"url","input_type":"email","raw_input":"x"}' });
  await status(f, 400); assert.deepEqual(f.events, []);
});
await check("C10 nested JSON and non-string values rejected", async () => {
  for (const body of ['{"input_type":"url","raw_input":{}}', '{"input_type":"url","raw_input":2}', '[]']) {
    const f = fixture({ body }); await status(f, 400); assert.deepEqual(f.events, []);
  }
});
await check("C11 order-independent valid JSON with whitespace accepted", async () => {
  const f = fixture({ body: ' { "raw_input" : "https://example.org/a", "input_type" : "url" } ' });
  await status(f, 201); assert.deepEqual(f.calls[2].values, ["url", "https://example.org/a"]);
});
await check("C12 invalid scan types, blank and NUL rejected", async () => {
  for (const [input_type, raw_input] of [["pdf", "x"], ["url", "  "], ["url", "a\0b"]]) {
    const f = fixture({ body: JSON.stringify({ input_type, raw_input }) });
    await status(f, 400); assert.deepEqual(f.events, []);
  }
});
await check("C13 raw scan input longer than 10000 rejected", async () => {
  const f = fixture({ body: JSON.stringify({ input_type: "url", raw_input: "a".repeat(10001) }) });
  await status(f, 400); assert.deepEqual(f.events, []);
});
await check("C14 oversized streaming body rejected without SQL", async () => {
  const f = fixture({ body: "a".repeat(12001) }); await status(f, 413); assert.deepEqual(f.events, []);
});
await check("C15 declared oversized body rejected before reading", async () => {
  const f = fixture({ contentLength: "12001" }); await status(f, 413); assert.deepEqual(f.events, []);
});
await check("C16 invalid Content-Length rejected", async () => {
  const f = fixture({ contentLength: "10, 20" }); await status(f, 400); assert.deepEqual(f.events, []);
});
await check("C17 invalid UTF-8 body rejected", async () => {
  const f = fixture({ body: new Uint8Array([0xff, 0xfe]) }); await status(f, 400); assert.deepEqual(f.events, []);
});
await check("C18 cross-site Origin rejected before SQL", async () => {
  const f = fixture({ origin: "https://evil.example" }); await status(f, 403); assert.deepEqual(f.events, []);
});
await check("C19 missing Origin rejected before SQL", async () => {
  const f = fixture({ origin: null }); await status(f, 403); assert.deepEqual(f.events, []);
});
await check("C20 cross-site Fetch Metadata rejected before SQL", async () => {
  const f = fixture({ fetchSite: "cross-site" }); await status(f, 403); assert.deepEqual(f.events, []);
});
await check("C21 wrong path, query and untrusted URL origin rejected", async () => {
  for (const url of [ORIGIN + "/api/azure/scans/", ORIGIN + "/api/azure/scans?role=owner", "https://evil.example/api/azure/scans"]) {
    const f = fixture({ url }); await status(f, 403); assert.deepEqual(f.events, []);
  }
});
await check("C22 GET cannot create scans", async () => {
  const f = fixture({ method: "GET" }); await status(f, 405); assert.deepEqual(f.events, []);
});
await check("C23 wrong media type or encoded body rejected", async () => {
  for (const f of [fixture({ contentType: "text/plain" }), fixture({ contentEncoding: "gzip" })]) {
    await status(f, 415); assert.deepEqual(f.events, []);
  }
});
await check("C24 invalid server config fails closed", async () => {
  const f = fixture({ env: { ...env, CBC_AZURE_PUBLIC_ORIGIN: "https://evil.example/path" } });
  await status(f, 503); assert.deepEqual(f.events, []);
});
await check("C25 SQL and session failures sanitized", async () => {
  for (const fail of ["session", "context", "create"] as const) {
    const f = fixture({ fail }); const r = await status(f, 503);
    assert.ok(!(await r.text()).includes("SECRET"));
    assert.equal(f.events.at(-1), "ROLLBACK");
  }
});
await check("C26 COMMIT failure cannot return scan id", async () => {
  const f = fixture({ fail: "commit" }); const r = await status(f, 503);
  assert.ok(!(await r.text()).includes(SCAN));
  assert.equal(f.events.at(-1), "ROLLBACK");
});
await check("C27 malformed, ambiguous or uppercase DB scan IDs fail closed", async () => {
  for (const rows of [[], [{ id: SCAN }, { id: SCAN }], [{ id: "not-uuid" }], [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase() }]]) {
    const f = fixture({ create: rows }); await status(f, 503); assert.equal(f.events.at(-1), "ROLLBACK");
  }
});
await check("C28 hostile raw input is bound data, not SQL", async () => {
  const attack = "https://example.org/?q=%27%3B%20DROP%20TABLE%20scans%3B--";
  const f = fixture({ body: JSON.stringify({ input_type: "url", raw_input: attack }) });
  const r = await status(f, 201);
  assert.deepEqual(f.calls[2].values, ["url", attack]);
  assert.ok(!(await r.text()).includes(attack));
});
await check("C29 unsupported input types cannot create unprocessable outbox jobs", async () => {
  for (const input_type of ["domain", "email", "header", "signature", "batch"]) {
    const f = fixture({ body: JSON.stringify({ input_type, raw_input: "https://example.org/" }) });
    await status(f, 400); assert.deepEqual(f.events, []);
  }
});
await check("C30 private, metadata, reserved and IP targets rejected before database access", async () => {
  for (const raw_input of ["http://localhost/", "http://127.0.0.1/", "http://169.254.169.254/",
    "http://0x7f000001/", "http://10.0.0.1/", "http://[::1]/",
    "https://metadata.internal/", "https://foo.local/", "https://foo.test/",
    "https://example.com:8080/", "https://user:password@example.org/",
    "https://example.org/\\n", "https://example.org/\\\\@localhost/"]) {
    const f = fixture({ body: JSON.stringify({ input_type: "url", raw_input }) });
    await status(f, 400); assert.deepEqual(f.events, []);
  }
});
await check("C31 canonical URL stored without fragment and with normalized host", async () => {
  const f = fixture({ body: JSON.stringify({
    input_type: "url", raw_input: "https://Example.ORG/path?q=1#private-fragment",
  }) });
  await status(f, 201);
  assert.deepEqual(f.calls[2].values, ["url", "https://example.org/path?q=1"]);
});
await check("C32 oversized URL is rejected before creating a job", async () => {
  const f = fixture({ body: JSON.stringify({
    input_type: "url", raw_input: "https://example.org/" + "a".repeat(2048),
  }) });
  await status(f, 400); assert.deepEqual(f.events, []);
});
await check("C33 valid public HTTP and HTTPS URLs create pending scans", async () => {
  for (const raw_input of ["http://example.org/a", "https://example.org/?q=1"]) {
    const f = fixture({ body: JSON.stringify({ input_type: "url", raw_input }) });
    await status(f, 201);
    assert.equal(f.calls[2].values[1], raw_input);
  }
});
console.log("\n=== Azure scan creation: " + passed + " passed, " + failed + " failed ===");
process.exitCode = failed ? 1 : 0;
