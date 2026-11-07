/** Offline Azure scan/evidence HTTP isolation tests; no database or network. */
import { strict as assert } from "node:assert";
import {
  AZURE_SESSION_COOKIE_NAME, createUnpersistedAzureSessionToken,
} from "../../src/security/azureSession.ts";
import { runAzureScanReadRoute } from "../../src/server/data/azureScanReadRoute.ts";
import type { CommittedSessionQuery } from "../../src/server/auth/postgresAuthSessionStore.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const SCAN = "44444444-4444-4444-8444-444444444444";
const { token, digest } = createUnpersistedAzureSessionToken();
const cookie = AZURE_SESSION_COOKIE_NAME + "=" + token;
const session = { o_user_id: USER, o_organization_id: ORG, o_role: "owner" };
const scan = {
  id: SCAN, input_type: "url", raw_input: "https://example.test/",
  status: "complete", verdict: "safe", risk_score: 0, confidence_score: 90,
  created_at: new Date("2026-01-01T00:00:00.000Z"), completed_at: null,
};
const evidence = { signal_type: "url", severity: "low", title: "Observed", detail: null, score_impact: 0 };
type Options = {
  id?: unknown; method?: string; cookie?: string; query?: string; path?: string;
  sessions?: Record<string, unknown>[];
  scans?: Record<string, unknown>[];
  evidence?: Record<string, unknown>[];
  contextOrg?: string; fail?: "session" | "context" | "scan" | "evidence" | "commit";
};
function fixture(options: Options = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const events: string[] = [];
  const request = new Request("https://cbc.example" + (options.path ?? "/api/azure/scans/" + SCAN) + (options.query ?? ""), {
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
              if (options.fail === "session") throw new Error("password=SECRET");
              return { rows: options.sessions ?? [session] };
            }
            if (sql.includes("set_config")) {
              events.push("context");
              if (options.fail === "context") throw new Error("password=SECRET");
              return { rows: [{ user_id: USER, organization_id: options.contextOrg ?? ORG }] };
            }
            if (sql.includes("FROM public.scans")) {
              events.push("scan");
              if (options.fail === "scan") throw new Error("password=SECRET");
              return { rows: options.scans ?? [scan] };
            }
            if (sql.includes("FROM public.evidence_items")) {
              events.push("evidence");
              if (options.fail === "evidence") throw new Error("password=SECRET");
              return { rows: options.evidence ?? [evidence] };
            }
            throw new Error("Unexpected query");
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
  return {
    calls, events,
    run: () => runAzureScanReadRoute(request, options.id === undefined ? SCAN : options.id, deps),
  };
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
await check("S01 authenticated scan and evidence commit before 200", async () => {
  const f = fixture();
  const response = await status(f, 200);
  assert.deepEqual(f.events, ["BEGIN", "session", "context", "scan", "evidence", "COMMIT"]);
  const body = await response.json();
  assert.equal(body.scan.id, SCAN);
  assert.equal(body.scan.created_at, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(body.evidence, [evidence]);
  assert.ok(!JSON.stringify(body).includes(ORG));
  assert.ok(!JSON.stringify(body).includes(USER));
});
await check("S02 SQL uses DB-derived tenant for both scan and evidence", async () => {
  const f = fixture(); await status(f, 200);
  assert.deepEqual(f.calls[0].values, [digest]);
  assert.deepEqual(f.calls[1].values, [USER, ORG]);
  assert.deepEqual(f.calls[2].values, [SCAN, ORG]);
  assert.deepEqual(f.calls[3].values, [SCAN, ORG]);
  assert.match(f.calls[2].sql, /organization_id = \$2::uuid/);
  assert.match(f.calls[3].sql, /INNER JOIN public.scans/);
  assert.match(f.calls[3].sql, /e.organization_id = \$2::uuid/);
  assert.match(f.calls[3].sql, /s.organization_id = \$2::uuid/);
  assert.ok(!JSON.stringify(f.calls).includes(token));
});
await check("S03 missing session denied before SQL", async () => {
  const f = fixture({ cookie: "" }); await status(f, 401); assert.deepEqual(f.events, []);
});
await check("S04 duplicate session cookie denied", async () => {
  const f = fixture({ cookie: cookie + "; " + cookie }); await status(f, 401); assert.deepEqual(f.events, []);
});
await check("S05 revoked or expired session denies scan and evidence", async () => {
  const f = fixture({ sessions: [] }); await status(f, 401);
  assert.deepEqual(f.events, ["BEGIN", "session", "COMMIT"]);
});
await check("S06 other-tenant scan is indistinguishable from nonexistent", async () => {
  const f = fixture({ scans: [] });
  const response = await status(f, 404);
  assert.deepEqual(await response.json(), { error: "Scan not found" });
  assert.ok(!f.events.includes("evidence"));
});
await check("S07 invalid scan UUID rejected before connection", async () => {
  const f = fixture({ id: SCAN + "' OR true --" }); await status(f, 400); assert.deepEqual(f.events, []);
});
await check("S08 uppercase/noncanonical scan UUID rejected", async () => {
  const f = fixture({ id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }); await status(f, 400); assert.deepEqual(f.events, []);
});
await check("S09 POST cannot access data", async () => {
  const f = fixture({ method: "POST" }); await status(f, 405); assert.deepEqual(f.events, []);
});
await check("S10 malformed DB tenant context fails closed", async () => {
  const f = fixture({ contextOrg: OTHER }); await status(f, 503);
  assert.deepEqual(f.events, ["BEGIN", "session", "context", "ROLLBACK"]);
});
await check("S11 duplicate scan rows fail closed before evidence", async () => {
  const f = fixture({ scans: [scan, scan] }); await status(f, 503);
  assert.ok(!f.events.includes("evidence"));
});
await check("S12 unexpected scan ID fails closed", async () => {
  const f = fixture({ scans: [{ ...scan, id: OTHER }] }); await status(f, 503);
});
await check("S13 malformed evidence fails closed", async () => {
  const f = fixture({ evidence: [{ ...evidence, score_impact: "0" }] }); await status(f, 503);
});
await check("S14 oversized evidence fails closed instead of truncating", async () => {
  const f = fixture({ evidence: Array(501).fill(evidence) }); await status(f, 503);
});
await check("S15 session storage failure is sanitized", async () => {
  const f = fixture({ fail: "session" });
  const r = await status(f, 503); assert.ok(!(await r.text()).includes("SECRET"));
});
await check("S16 protected scan query failure is sanitized", async () => {
  const f = fixture({ fail: "scan" });
  const r = await status(f, 503); assert.ok(!(await r.text()).includes("SECRET"));
});
await check("S17 evidence query failure is sanitized", async () => {
  const f = fixture({ fail: "evidence" });
  const r = await status(f, 503); assert.ok(!(await r.text()).includes("SECRET"));
});
await check("S18 commit failure cannot emit protected data", async () => {
  const f = fixture({ fail: "commit" });
  const r = await status(f, 503); assert.ok(!(await r.text()).includes("SECRET"));
  assert.equal(f.events.at(-1), "ROLLBACK");
});
await check("S19 malformed session identity fails closed", async () => {
  const f = fixture({ sessions: [{ ...session, o_organization_id: "not-a-uuid" }] });
  await status(f, 503); assert.ok(!f.events.includes("scan"));
});
await check("S20 no tenant ID is read from request query parameters", async () => {
  const f = fixture(); await status(f, 200);
  assert.ok(f.calls.every(c => !c.values.includes(OTHER)));
});
await check("S21 query-string tenant hints rejected before SQL", async () => {
  const f = fixture({ query: "?organization_id=" + OTHER });
  const response = await status(f, 400);
  assert.deepEqual(await response.json(), { error: "Invalid scan request" });
  assert.deepEqual(f.events, []);
});
await check("S22 alternate scan path rejected before SQL", async () => {
  const f = fixture({ path: "/api/azure/scans/" + OTHER });
  await status(f, 400);
  assert.deepEqual(f.events, []);
});
await check("S23 fragment rejected before SQL", async () => {
  const f = fixture({ query: "#evidence" });
  await status(f, 400);
  assert.deepEqual(f.events, []);
});
console.log("\n=== Azure scan read boundary: " + passed + " passed, " + failed + " failed ===");
process.exitCode = failed ? 1 : 0;
