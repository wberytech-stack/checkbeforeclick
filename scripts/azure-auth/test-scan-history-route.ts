/** Offline recent-history API tenant-isolation tests. No real database or network. */
import { strict as assert } from "node:assert";
import { AZURE_SESSION_COOKIE_NAME, createUnpersistedAzureSessionToken } from "../../src/security/azureSession.ts";
import { runAzureScanHistoryRoute, parseAzureHistoryRow } from "../../src/server/data/azureScanHistoryRoute.ts";
import type { CommittedSessionQuery } from "../../src/server/auth/postgresAuthSessionStore.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const SCAN = "44444444-4444-4444-8444-444444444444";
const { token, digest } = createUnpersistedAzureSessionToken();
const cookie = AZURE_SESSION_COOKIE_NAME + "=" + token;
const row = {
  id: SCAN, raw_input: "https://example.test/path", status: "complete",
  verdict: "dangerous", created_at: new Date("2026-11-02T00:00:00.000Z"),
};
type Options = {
  method?: string; url?: string; cookie?: string;
  sessions?: Record<string, unknown>[]; rows?: Record<string, unknown>[];
  contextOrg?: string; fail?: "session" | "context" | "history" | "commit";
};
function fixture(options: Options = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const events: string[] = [];
  const request = new Request(options.url ?? "https://cbc.example/api/azure/history", {
    method: options.method ?? "GET",
    headers: options.cookie === undefined ? { cookie } : options.cookie ? { cookie: options.cookie } : {},
  });
  const deps = {
    async transaction<T>(fn: (client: CommittedSessionQuery) => Promise<T>): Promise<T> {
      events.push("BEGIN");
      try {
        const result = await fn({
          async query(sql, values) {
            calls.push({ sql, values });
            if (sql.includes("app_resolve_auth_session")) {
              events.push("session");
              if (options.fail === "session") throw Error("SECRET session");
              return { rows: options.sessions ?? [{ o_user_id: USER, o_organization_id: ORG, o_role: "owner" }] };
            }
            if (sql.includes("set_config")) {
              events.push("context");
              if (options.fail === "context") throw Error("SECRET context");
              return { rows: [{ user_id: USER, organization_id: options.contextOrg ?? ORG }] };
            }
            if (sql.includes("FROM public.scans")) {
              events.push("history");
              if (options.fail === "history") throw Error("SECRET query");
              return { rows: options.rows ?? [row] };
            }
            throw Error("Unexpected query");
          },
        });
        if (options.fail === "commit") throw Error("SECRET commit");
        events.push("COMMIT");
        return result;
      } catch (error) {
        events.push("ROLLBACK");
        throw error;
      }
    },
  };
  return { calls, events, run: () => runAzureScanHistoryRoute(request, deps) };
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
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("set-cookie"), null);
  return response;
}
await check("H00 direct history row parser accepts PostgreSQL Date", async () => {
  assert.equal(typeof row.id, "string");
  assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(typeof row.raw_input, "string");
  assert.equal(row.raw_input.length <= 10000, true);
  assert.equal(["pending", "processing", "complete", "failed"].includes(row.status), true);
  assert.equal(typeof row.verdict, "string");
  const parsed = parseAzureHistoryRow(row);
  assert.equal(parsed.id, SCAN);
  assert.equal(parsed.created_at, "2026-11-02T00:00:00.000Z");
});
await check("H01 authenticated tenant history commits before response", async () => {
  const f = fixture(); const r = await status(f, 200);
  assert.deepEqual(f.events, ["BEGIN", "session", "context", "history", "COMMIT"]);
  const body = await r.json();
  assert.equal(body.scans[0].id, SCAN);
  assert.equal(body.scans[0].created_at, "2026-11-02T00:00:00.000Z");
  assert.equal(body.has_more, false);
  assert.ok(!JSON.stringify(body).includes(ORG));
});
await check("H02 only DB-derived tenant ID is bound", async () => {
  const f = fixture(); await status(f, 200);
  assert.deepEqual(f.calls[0].values, [digest]);
  assert.deepEqual(f.calls[1].values, [USER, ORG]);
  assert.deepEqual(f.calls[2].values, [ORG]);
  assert.match(f.calls[2].sql, /organization_id = \$1::uuid/);
  assert.match(f.calls[2].sql, /input_type = 'url'/);
  assert.match(f.calls[2].sql, /ORDER BY created_at DESC, id DESC/);
  assert.match(f.calls[2].sql, /LIMIT 51/);
  assert.ok(!JSON.stringify(f.calls).includes(token));
});
await check("H03 no cookie denied before SQL", async () => {
  const f = fixture({ cookie: "" }); await status(f, 401); assert.deepEqual(f.events, []);
});
await check("H04 duplicate cookie denied before SQL", async () => {
  const f = fixture({ cookie: cookie + "; " + cookie }); await status(f, 401); assert.deepEqual(f.events, []);
});
await check("H05 revoked session cannot read history", async () => {
  const f = fixture({ sessions: [] }); await status(f, 401);
  assert.deepEqual(f.events, ["BEGIN", "session", "COMMIT"]);
});
await check("H06 POST denied without DB access", async () => {
  const f = fixture({ method: "POST" }); await status(f, 405); assert.deepEqual(f.events, []);
});
await check("H07 tenant query selector denied before DB access", async () => {
  const f = fixture({ url: "https://cbc.example/api/azure/history?organization_id=" + OTHER });
  await status(f, 400); assert.deepEqual(f.events, []);
});
await check("H08 wrong route denied", async () => {
  const f = fixture({ url: "https://cbc.example/api/azure/scans" });
  await status(f, 400); assert.deepEqual(f.events, []);
});
await check("H09 empty history returns zero items", async () => {
  const f = fixture({ rows: [] }); const r = await status(f, 200);
  assert.deepEqual(await r.json(), { scans: [], has_more: false });
});
await check("H10 51st row is only used for has_more", async () => {
  const f = fixture({ rows: Array.from({ length: 51 }, (_, i) => ({ ...row, id: i === 50 ? OTHER : SCAN })) });
  const r = await status(f, 200); const body = await r.json();
  assert.equal(body.scans.length, 50); assert.equal(body.has_more, true);
  assert.ok(!JSON.stringify(body).includes(OTHER));
});
await check("H11 unbounded result fails closed", async () => {
  const f = fixture({ rows: Array(52).fill(row) }); await status(f, 503);
});
await check("H12 malformed scan identifier fails closed", async () => {
  const f = fixture({ rows: [{ ...row, id: "not-a-uuid" }] }); await status(f, 503);
});
await check("H13 invalid date fails closed", async () => {
  const f = fixture({ rows: [{ ...row, created_at: "not-a-date" }] }); await status(f, 503);
});
await check("H14 invalid verdict fails closed", async () => {
  const f = fixture({ rows: [{ ...row, verdict: 1 }] }); await status(f, 503);
});
await check("H15 malformed tenant context rolls back", async () => {
  const f = fixture({ contextOrg: OTHER }); await status(f, 503);
  assert.deepEqual(f.events, ["BEGIN", "session", "context", "ROLLBACK"]);
});
for (const fail of ["session", "context", "history", "commit"] as const) {
  await check("H16-H19 failure is sanitized: " + fail, async () => {
    const f = fixture({ fail }); const r = await status(f, 503);
    assert.ok(!(await r.text()).includes("SECRET"));
    assert.equal(f.events.at(-1), "ROLLBACK");
  });
}
console.log("\n=== Azure recent scan history: " + passed + " passed, " + failed + " failed ===");
process.exitCode = failed ? 1 : 0;
