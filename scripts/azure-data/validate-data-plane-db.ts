// Gate 008A - validation of migrations 001-005 and the Azure data-plane code against a DISPOSABLE loopback
// PostgreSQL database. Started only by scripts/azure-data/run-disposable-db.sh, which creates the cluster,
// applies the migrations as the owner, and removes everything afterwards.
//
// The code under test runs as cbc_app (NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS) through the REAL
// modules: src/server/db/postgres.ts (config parser, pool, transactions), src/server/data/azureStore.ts
// and src/server/scan/recordFastScanResult.ts (migration 004). The owner connection is used only to
// inspect state and to prove that the integrity triggers also bind the owner.
//
// Env (set by the runner, loopback only): CBC_DATABASE_URL (cbc_app), CBC_DATABASE_SSL=false,
// CBC_TEST_OWNER_URL (owner), CBC_TEST_ISSUER.
// Run via scripts/azure-data/run-disposable-db.sh (node --experimental-transform-types: recordFastScanResult.ts uses parameter properties)
import { register } from "node:module";
import pg from "pg";

// The app modules use extensionless relative imports (Next.js resolution). Map them to .ts for this process.
register("data:text/javascript," + encodeURIComponent(`
  import { existsSync } from "node:fs";
  import { fileURLToPath } from "node:url";
  export async function resolve(spec, ctx, next) {
    if ((spec.startsWith("./") || spec.startsWith("../")) && !/\\.[a-z]+$/.test(spec) && ctx.parentURL?.startsWith("file:")) {
      const u = new URL(spec + ".ts", ctx.parentURL);
      if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
    }
    return next(spec, ctx);
  }`));

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, info = ""): void {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}${info ? `  [${info}]` : ""}`); }
}

for (const k of ["CBC_DATABASE_URL", "CBC_TEST_OWNER_URL"]) {
  const h = new URL(process.env[k] ?? "postgres://x@invalid/x").hostname;
  if (h !== "127.0.0.1") throw new Error(`${k} must point at the loopback disposable database`);
}
const ISSUER = process.env.CBC_TEST_ISSUER ?? "";

const { withTenantTransaction, withPgTransaction } = await import("../../src/server/db/postgres.ts");
const store = await import("../../src/server/data/azureStore.ts");
const { recordFastScanResult } = await import("../../src/server/scan/recordFastScanResult.ts");
const owner = new pg.Client({ connectionString: process.env.CBC_TEST_OWNER_URL });
await owner.connect();

const sqlState = (e: unknown) => (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code ?? "";
async function rejects(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return sqlState(e) || (e as Error).message || "error"; }
}
const signIn = (subject: string, email: string | null = null, name: string | null = null, issuer = ISSUER) =>
  withPgTransaction((c) => store.signInWithIdentity(c as never, { issuer, subject, email, displayName: name }));
const count = async (sql: string, v: unknown[] = []) => Number((await owner.query(sql, v)).rows[0].n);

async function main() {
  // ---- role and grants -----------------------------------------------------------------------------------
  const role = (await owner.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = 'cbc_app'")).rows[0];
  check("D01 cbc_app is NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS", role && !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole && !role.rolbypassrls);
  const who = await withPgTransaction(async (c) => (await c.query("SELECT current_user AS u")).rows[0].u);
  check("D02 the application pool connects as cbc_app", who === "cbc_app", String(who));
  const pub = await count(`SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege('public', p.oid, 'EXECUTE')`);
  check("D03 no SECURITY DEFINER function in public is executable by PUBLIC", pub === 0, String(pub));
  const bootstrap = await owner.query("SELECT has_function_privilege('cbc_app', 'public.bootstrap_new_organization(uuid,text,text,text)', 'EXECUTE') AS x");
  check("D04 cbc_app can no longer execute bootstrap_new_organization (superseded by app_sign_in)", bootstrap.rows[0].x === false);

  // ---- sign-in -------------------------------------------------------------------------------------------
  const a = await signIn("subject-A", "alice@example.com", "Alice");
  const a2 = await signIn("subject-A", "alice@example.com", "Alice");
  const b = await signIn("subject-B", "bob@example.com", "Bob");
  check("D05 first sign-in provisions user, organization and owner membership", a.created === true && a.role === "owner");
  check("D06 repeat sign-in returns the same account without provisioning", a2.created === false && a2.userId === a.userId && a2.organizationId === a.organizationId);
  check("D07 two identities get distinct users and organizations", b.userId !== a.userId && b.organizationId !== a.organizationId);
  const sameEmail = await signIn("subject-C", "alice@example.com", "Mallory");
  check("D08 an identity with the same email is NOT linked to the existing account", sameEmail.userId !== a.userId && sameEmail.organizationId !== a.organizationId);
  const sameSubjectOtherIssuer = await rejects(() => signIn("subject-A", null, null, "https://evil.example/v2.0"));
  check("D09 an untrusted issuer is refused (even with a known subject)", sameSubjectOtherIssuer === "28000", String(sameSubjectOtherIssuer));
  for (const [label, subj] of [["D10 empty subject", ""], ["D11 subject over 255 chars", "s".repeat(256)], ["D12 subject with a control character", "a\nb"]] as const) {
    const r = await rejects(() => signIn(subj));
    check(`${label} -> refused`, r === "22023", String(r));
  }
  const withCtx = await rejects(() => withTenantTransaction(a, (c) => store.signInWithIdentity(c as never, { issuer: ISSUER, subject: "subject-Z", email: null, displayName: null })));
  check("D13 sign-in inside a tenant context is refused", withCtx === "28000", String(withCtx));
  check("D14 provisioning and sign-ins are audited", await count("SELECT count(*) AS n FROM audit_log WHERE user_id = $1 AND action IN ('user.provisioned','user.signed_in')", [a.userId]) === 2);
  const concurrent = await Promise.all([1, 2, 3, 4].map(() => signIn("subject-race")));
  check("D15 concurrent first sign-ins of one identity create exactly one account",
    new Set(concurrent.map((r) => r.userId)).size === 1 && concurrent.filter((r) => r.created).length === 1 &&
    await count("SELECT count(*) AS n FROM user_identities WHERE subject = 'subject-race'") === 1);
  const evilName = await signIn("subject-D", null, "x'); DROP TABLE scans; --\u0007");
  check("D16 hostile display name is stored as data (tables intact, control characters stripped)",
    evilName.created && await count("SELECT count(*) AS n FROM pg_tables WHERE tablename = 'scans'") === 1 &&
    await count("SELECT count(*) AS n FROM users WHERE id = $1 AND full_name = $2", [evilName.userId, "x'); DROP TABLE scans; --"]) === 1);
  const ids = await withTenantTransaction(a, async (c) => (await c.query("SELECT user_id FROM user_identities")).rows);
  check("D17 a user sees only their own identities", ids.length === 1 && ids[0].user_id === a.userId);
  const issuers = await rejects(() => withTenantTransaction(a, (c) => c.query("SELECT * FROM trusted_identity_issuers")));
  check("D18 cbc_app cannot read the trusted-issuer allow-list", issuers === "42501", String(issuers));

  // ---- scans and tenant isolation ------------------------------------------------------------------------
  const scanA = await withTenantTransaction(a, (c) => store.createScan(c, "url", "https://a.example/x?q=1'; DROP TABLE scans;--"));
  const scanB = await withTenantTransaction(b, (c) => store.createScan(c, "url", "https://b.example/"));
  const seenByA = await withTenantTransaction(a, (c) => store.listRecentScans(c, 50));
  check("D19 A lists only A's scans", seenByA.length === 1 && seenByA[0].id === scanA && seenByA[0].raw_input.endsWith("DROP TABLE scans;--"));
  check("D20 B cannot read A's scan by id (row-level security)", (await withTenantTransaction(b, (c) => store.getScan(c, scanA))) === null);
  check("D21 B cannot read A's evidence", (await withTenantTransaction(b, (c) => store.getScanEvidence(c, scanA))).length === 0);
  const markForeign = await rejects(() => withTenantTransaction(b, (c) => store.markScanProcessing(c, scanA)));
  check("D22 B cannot move A's scan to processing (same error as a missing scan)", markForeign === "P0002", String(markForeign));
  const forged = await rejects(() => withTenantTransaction({ userId: a.userId, organizationId: b.organizationId }, (c) => store.createScan(c, "url", "https://x.example/")));
  check("D23 a context naming another organization is refused (membership check)", forged === "42501", String(forged));
  const forgedRead = await withTenantTransaction({ userId: a.userId, organizationId: b.organizationId }, (c) => store.listRecentScans(c));
  check("D24 a forged organization context reads nothing", forgedRead.length === 0);
  const noCtx = await withPgTransaction(async (c) => (await c.query("SELECT count(*)::int AS n FROM scans")).rows[0].n);
  check("D25 without tenant context cbc_app reads no scans", noCtx === 0, String(noCtx));
  const noCtxCreate = await rejects(() => withPgTransaction((c) => store.createScan(c as never, "url", "https://x.example/")));
  check("D26 without tenant context no scan can be created", noCtxCreate === "28000", String(noCtxCreate));
  for (const [label, t, input] of [["D27 invalid input_type", "pdf", "x"], ["D28 blank input", "url", "   "], ["D29 input over 10,000 chars", "url", "x".repeat(10001)]] as const) {
    const r = await rejects(() => withTenantTransaction(a, (c) => store.createScan(c, t as never, input)));
    check(`${label} -> refused`, r === "22023", String(r));
  }

  // ---- direct writes are not possible for cbc_app --------------------------------------------------------
  for (const [label, sql] of [
    ["D30 INSERT scans", `INSERT INTO scans (organization_id, user_id, input_type, raw_input) VALUES ('${a.organizationId}', '${a.userId}', 'url', 'x')`],
    ["D31 UPDATE scans verdict", `UPDATE scans SET verdict = 'safe' WHERE id = '${scanA}'`],
    ["D32 DELETE scans", `DELETE FROM scans WHERE id = '${scanA}'`],
    ["D33 INSERT evidence_items", `INSERT INTO evidence_items (scan_id, organization_id, signal_type, severity, title) VALUES ('${scanA}', '${a.organizationId}', 'x', 'good', 'forged')`],
    ["D34 INSERT vendor_results", `INSERT INTO vendor_results (scan_id, organization_id, vendor_name) VALUES ('${scanA}', '${a.organizationId}', 'forged')`],
    ["D35 INSERT audit_log", `INSERT INTO audit_log (organization_id, user_id, action) VALUES ('${a.organizationId}', '${a.userId}', 'forged')`],
    ["D36 UPDATE organizations plan (billing escalation)", `UPDATE organizations SET plan = 'msp' WHERE id = '${a.organizationId}'`],
    ["D37 UPDATE users organization_id", `UPDATE users SET organization_id = '${b.organizationId}' WHERE id = '${a.userId}'`],
    ["D38 INSERT user_identities (account takeover)", `INSERT INTO user_identities (user_id, issuer, subject) VALUES ('${a.userId}', '${ISSUER}', 'attacker')`],
  ] as const) {
    const r = await rejects(() => withTenantTransaction(a, (c) => c.query(sql)));
    check(`${label} as cbc_app -> permission denied`, r === "42501", String(r));
  }
  const rename = await withTenantTransaction(a, async (c) => (await c.query("UPDATE users SET full_name = 'Alice A' WHERE id = $1", [a.userId])).rowCount);
  check("D39 cbc_app may still update its display name", rename === 1);

  // ---- lifecycle and one-shot completion (real recordFastScanResult) ------------------------------------
  check("D40 pending -> processing", await withTenantTransaction(a, (c) => store.markScanProcessing(c, scanA)) === true);
  check("D41 processing replay is a no-op", await withTenantTransaction(a, (c) => store.markScanProcessing(c, scanA)) === false);
  const result = {
    userId: a.userId, organizationId: a.organizationId, scanId: scanA, status: "complete" as const, verdict: "suspicious" as const,
    riskScore: 55, confidenceScore: 70, aiExplanation: null, recommendedAction: null, scanDurationMs: 1200,
    vendorResults: [{ vendorName: "domain_age", verdict: "suspicious", rawResponse: { days: 3 }, errorMessage: null, responseTimeMs: 20 }],
    evidenceItems: [{ signalType: "domain_age", severity: "medium", title: "New domain", detail: "3 days", scoreImpact: 20 }],
  };
  await recordFastScanResult(result as never);
  const done = await withTenantTransaction(a, (c) => store.getScan(c, scanA));
  check("D42 result recorded through app_record_fast_scan_result", done?.status === "complete" && done.verdict === "suspicious" && done.risk_score === 55);
  check("D43 evidence readable by its organization", (await withTenantTransaction(a, (c) => store.getScanEvidence(c, scanA))).length === 1);
  const again = await rejects(() => recordFastScanResult({ ...result, verdict: "safe" } as never));
  check("D44 a second result for a final scan is refused (one-shot)", again !== null && await count("SELECT count(*) AS n FROM evidence_items WHERE scan_id = $1", [scanA]) === 1);
  const crossResult = await rejects(() => recordFastScanResult({ ...result, scanId: scanB } as never));
  check("D45 A cannot record a result for B's scan", crossResult !== null && (await count("SELECT count(*) AS n FROM scans WHERE id = $1 AND status = 'pending'", [scanB])) === 1);
  const markFinal = await rejects(() => withTenantTransaction(a, (c) => store.markScanProcessing(c, scanA)));
  check("D46 a final scan cannot return to processing", markFinal === "55000", String(markFinal));

  // ---- integrity triggers bind the owner too -------------------------------------------------------------
  await withTenantTransaction(b, (c) => store.markScanProcessing(c, scanB));   // scanB: processing (not final)
  for (const [label, sql] of [
    ["D47 owner changes a final verdict", `UPDATE scans SET verdict = 'safe' WHERE id = '${scanA}'`],
    ["D48 owner moves a scan to another organization", `UPDATE scans SET organization_id = '${a.organizationId}' WHERE id = '${scanB}'`],
    ["D49 owner rewrites a scan's input", `UPDATE scans SET raw_input = 'x' WHERE id = '${scanB}'`],
    ["D50 owner moves a processing scan back to pending", `UPDATE scans SET status = 'pending' WHERE id = '${scanB}'`],
    ["D51 owner edits evidence", `UPDATE evidence_items SET severity = 'good' WHERE scan_id = '${scanA}'`],
    ["D52 owner edits a vendor result", `UPDATE vendor_results SET verdict = 'clean' WHERE scan_id = '${scanA}'`],
    ["D53 owner edits the audit log", `UPDATE audit_log SET action = 'x' WHERE user_id = '${a.userId}'`],
    ["D54 owner deletes an audit row", `DELETE FROM audit_log WHERE user_id = '${a.userId}'`],
  ] as const) {
    const r = await rejects(() => owner.query(sql));
    check(`${label} -> refused by trigger`, r === "55000", String(r));
  }
  // FK cascades the triggers must still allow
  await owner.query("DELETE FROM users WHERE id = $1", [a.userId]);
  check("D55 deleting a user keeps its final scan and audit rows (user_id set to NULL)",
    await count("SELECT count(*) AS n FROM scans WHERE id = $1 AND user_id IS NULL AND status = 'complete'", [scanA]) === 1 &&
    await count("SELECT count(*) AS n FROM audit_log WHERE organization_id = $1 AND user_id IS NULL", [a.organizationId]) === 2);
  await owner.query("DELETE FROM memberships WHERE organization_id = $1", [b.organizationId]);
  await owner.query("DELETE FROM users WHERE organization_id = $1", [b.organizationId]);
  await owner.query("DELETE FROM organizations WHERE id = $1", [b.organizationId]);
  check("D56 deleting an organization cascades its scans and audit rows", await count("SELECT count(*) AS n FROM audit_log WHERE organization_id = $1", [b.organizationId]) === 0 &&
    await count("SELECT count(*) AS n FROM scans WHERE organization_id = $1", [b.organizationId]) === 0);

  // ---- transaction-local context does not leak through the pool ------------------------------------------
  const c2 = await signIn("subject-leak");
  await withTenantTransaction(c2, (c) => store.createScan(c, "domain", "leak.example"));
  const leaked = await Promise.all(Array.from({ length: 12 }, () => withPgTransaction(async (c) =>
    (await c.query("SELECT current_setting('app.current_user_id', true) AS u, current_setting('app.current_organization_id', true) AS o, (SELECT count(*)::int FROM scans) AS n")).rows[0])));
  check("D57 after COMMIT no pooled connection keeps a tenant context", leaked.every((r) => !r.u && !r.o && r.n === 0), JSON.stringify(leaked[0]));
  const failedTx = await rejects(() => withTenantTransaction(c2, async (c) => { await c.query("SELECT 1"); throw new Error("app failure"); }));
  const afterRollback = await withPgTransaction(async (c) => (await c.query("SELECT current_setting('app.current_user_id', true) AS u")).rows[0].u);
  check("D58 after ROLLBACK the context is gone as well", failedTx === "app failure" && !afterRollback);
}

let finished = false;
process.on("beforeExit", () => { if (!finished) { console.log("FAIL: run did not finish"); process.exitCode = 1; } });
main()
  .then(() => { finished = true; console.log(`\n=== Gate 008A data plane (disposable DB): ${passed} passed, ${failed} failed ===`); process.exitCode = failed === 0 ? 0 : 1; },
        (e) => { finished = true; console.log(`FAIL: unexpected error ${String(e)}`); process.exitCode = 1; })
  .finally(async () => { await owner.end(); await (globalThis as { __cbcPgPool?: { end: () => Promise<void> } }).__cbcPgPool?.end(); });
