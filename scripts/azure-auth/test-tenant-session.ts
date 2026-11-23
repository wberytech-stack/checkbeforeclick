/** Offline tenant-session security tests. No database, cloud or network. */
import { strict as assert } from "node:assert";
import {
  AZURE_SESSION_COOKIE_NAME, createUnpersistedAzureSessionToken,
} from "../../src/security/azureSession.ts";
import {
  withAzureTenantSession, AzureTenantSessionUnavailable,
  type AzureTenantSessionDependencies,
} from "../../src/server/auth/azureTenantSession.ts";
import type { CommittedSessionQuery } from "../../src/server/auth/postgresAuthSessionStore.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const credential = createUnpersistedAzureSessionToken();
const cookie = AZURE_SESSION_COOKIE_NAME + "=" + credential.token;
const row = { o_user_id: USER, o_organization_id: ORG, o_role: "owner" };

type Options = {
  sessionRows?: Record<string, unknown>[];
  contextRows?: Record<string, unknown>[];
  sqlFailure?: "resolve" | "context" | "protected";
  commitFailure?: boolean;
  operationFailure?: boolean;
};
function fixture(options: Options = {}) {
  const events: string[] = [];
  const calls: { sql: string; values: unknown[] }[] = [];
  let operations = 0;
  const deps: AzureTenantSessionDependencies = {
    async transaction<T>(fn: (client: CommittedSessionQuery) => Promise<T>): Promise<T> {
      events.push("BEGIN");
      try {
        const value = await fn({
          async query(sql, values) {
            calls.push({ sql, values });
            if (sql.includes("app_resolve_auth_session")) {
              events.push("resolve");
              if (options.sqlFailure === "resolve") throw new Error("password=SECRET");
              return { rows: options.sessionRows ?? [row] };
            }
            if (sql.includes("set_config")) {
              events.push("context");
              if (options.sqlFailure === "context") throw new Error("password=SECRET");
              return { rows: options.contextRows ?? [{ user_id: USER, organization_id: ORG }] };
            }
            events.push("protected");
            if (options.sqlFailure === "protected") throw new Error("password=SECRET");
            return { rows: [{ id: "scan-1" }] };
          },
        });
        if (options.commitFailure) throw new Error("COMMIT password=SECRET");
        events.push("COMMIT");
        return value;
      } catch (error) {
        events.push("ROLLBACK");
        throw error;
      }
    },
  };
  async function run(header: unknown = cookie) {
    return withAzureTenantSession(header, deps, async (client, session) => {
      operations++;
      assert.deepEqual(session, { userId: USER, organizationId: ORG, role: "owner" });
      assert.equal(Object.isFrozen(session), true);
      if (options.operationFailure) throw new Error("internal SQL secret=SECRET");
      const result = await client.query("SELECT id FROM public.scans WHERE organization_id = $1", [session.organizationId]);
      return result.rows;
    });
  }
  return { run, calls, events, get operations() { return operations; } };
}
let passed = 0, failed = 0;
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + ": " + String(error)); }
}
async function unavailable(action: Promise<unknown>) {
  await assert.rejects(action, (error: unknown) =>
    error instanceof AzureTenantSessionUnavailable &&
    error.message === "Azure tenant session unavailable" &&
    !JSON.stringify(error).includes("SECRET"));
}
await check("T01 valid cookie resolves, sets tenant context, then queries in same transaction", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { authenticated: true, value: [{ id: "scan-1" }] });
  assert.deepEqual(f.events, ["BEGIN", "resolve", "context", "protected", "COMMIT"]);
  assert.deepEqual(f.calls[0].values, [credential.digest]);
  assert.deepEqual(f.calls[1].values, [USER, ORG]);
  assert.match(f.calls[1].sql, /set_config\('app.current_user_id', \$1, true\)/);
  assert.match(f.calls[1].sql, /set_config\('app.current_organization_id', \$2, true\)/);
  assert.deepEqual(f.calls[2].values, [ORG]);
  assert.ok(!JSON.stringify(f.calls).includes(credential.token));
});
await check("T02 absent cookie never opens transaction", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(null), { authenticated: false });
  assert.deepEqual(f.events, []);
});
await check("T03 invalid cookie never opens transaction", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(AZURE_SESSION_COOKIE_NAME + "=bad"), { authenticated: false });
  assert.deepEqual(f.events, []);
});
await check("T04 duplicate cookie denied before SQL", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(cookie + "; " + cookie), { authenticated: false });
  assert.deepEqual(f.events, []);
});
await check("T05 hostile cookie header injection denied", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(cookie + "\r\nX-Evil: 1"), { authenticated: false });
  assert.deepEqual(f.events, []);
});
await check("T06 revoked/expired/missing session denies operation", async () => {
  const f = fixture({ sessionRows: [] });
  assert.deepEqual(await f.run(), { authenticated: false });
  assert.deepEqual(f.events, ["BEGIN", "resolve", "COMMIT"]);
  assert.equal(f.operations, 0);
});
await check("T07 malformed database user fails closed", async () => {
  const f = fixture({ sessionRows: [{ ...row, o_user_id: "attacker" }] });
  await unavailable(f.run()); assert.deepEqual(f.events, ["BEGIN", "resolve", "ROLLBACK"]);
});
await check("T08 malformed database organization fails closed", async () => {
  const f = fixture({ sessionRows: [{ ...row, o_organization_id: "bad" }] });
  await unavailable(f.run()); assert.equal(f.operations, 0);
});
await check("T09 malformed database role fails closed", async () => {
  const f = fixture({ sessionRows: [{ ...row, o_role: "owner; DROP TABLE" }] });
  await unavailable(f.run()); assert.equal(f.operations, 0);
});
await check("T10 duplicate session rows fail closed", async () => {
  const f = fixture({ sessionRows: [row, row] });
  await unavailable(f.run()); assert.equal(f.operations, 0);
});
await check("T11 database cannot substitute another organization during context installation", async () => {
  const f = fixture({ contextRows: [{ user_id: USER, organization_id: OTHER }] });
  await unavailable(f.run()); assert.deepEqual(f.events, ["BEGIN", "resolve", "context", "ROLLBACK"]);
});
await check("T12 empty context result fails closed", async () => {
  const f = fixture({ contextRows: [] });
  await unavailable(f.run()); assert.equal(f.operations, 0);
});
await check("T13 multiple context rows fail closed", async () => {
  const f = fixture({ contextRows: [{ user_id: USER, organization_id: ORG }, { user_id: USER, organization_id: ORG }] });
  await unavailable(f.run()); assert.equal(f.operations, 0);
});
await check("T14 session SQL failure rolls back and sanitizes", async () => {
  const f = fixture({ sqlFailure: "resolve" });
  await unavailable(f.run()); assert.deepEqual(f.events, ["BEGIN", "resolve", "ROLLBACK"]);
});
await check("T15 context SQL failure rolls back and sanitizes", async () => {
  const f = fixture({ sqlFailure: "context" });
  await unavailable(f.run()); assert.deepEqual(f.events, ["BEGIN", "resolve", "context", "ROLLBACK"]);
});
await check("T16 protected query failure rolls back and sanitizes", async () => {
  const f = fixture({ sqlFailure: "protected" });
  await unavailable(f.run()); assert.deepEqual(f.events, ["BEGIN", "resolve", "context", "protected", "ROLLBACK"]);
});
await check("T17 protected callback failure rolls back and sanitizes", async () => {
  const f = fixture({ operationFailure: true });
  await unavailable(f.run()); assert.deepEqual(f.events, ["BEGIN", "resolve", "context", "ROLLBACK"]);
});
await check("T18 commit failure cannot return authorized data", async () => {
  const f = fixture({ commitFailure: true });
  await unavailable(f.run()); assert.deepEqual(f.events, ["BEGIN", "resolve", "context", "protected", "ROLLBACK"]);
});
await check("T19 SQL is parameterized and cookie/tenant values never interpolate into text", async () => {
  const f = fixture(); await f.run();
  for (const call of f.calls) {
    assert.ok(!call.sql.includes(credential.token));
    assert.ok(!call.sql.includes(credential.digest));
    assert.ok(!call.sql.includes(USER));
    assert.ok(!call.sql.includes(ORG));
  }
});
await check("T20 malformed database session result is not accepted", async () => {
  const f = fixture({ sessionRows: [{ ...row, o_role: null }] });
  await unavailable(f.run()); assert.equal(f.operations, 0);
});
console.log("\n=== Azure tenant session: " + passed + " passed, " + failed + " failed ===");
process.exitCode = failed ? 1 : 0;
