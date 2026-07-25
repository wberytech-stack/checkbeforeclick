/**
 * Gate 003P - Disposable PostgreSQL validation of recordFastScanResult.
 *
 * This script does NOT apply migrations to any real database. It assumes a
 * prepared disposable local Docker PostgreSQL database exists.
 *
 * ============================================================================
 * SETUP - run from repo root in PowerShell
 * ============================================================================
 *
 * docker rm -f cbc-gate-003p-postgres 2>$null
 *
 * docker run --name cbc-gate-003p-postgres `
 *   -e POSTGRES_PASSWORD=postgres `
 *   -e POSTGRES_DB=gate_003p_validation `
 *   -p 55435:5432 `
 *   -d postgres:16
 *
 * Start-Sleep -Seconds 5
 *
 * & "C:\Program Files\PostgreSQL\16\bin\psql.exe" "host=localhost port=55435 dbname=gate_003p_validation user=postgres password=postgres sslmode=disable"
 *
 * Inside psql, run in exact order:
 *
 * \i infra/db/migrations/001_initial_schema.sql
 * \i infra/db/migrations/002_tenant_isolation.sql
 *
 * CREATE ROLE cbc_app_validation
 *   LOGIN PASSWORD 'cbc_app_validation'
 *   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 *
 * GRANT USAGE ON SCHEMA public TO cbc_app_validation;
 *
 * \i infra/db/migrations/003_fast_path_function.sql
 * \i infra/db/migrations/004_fast_path_function_write_expansion.sql
 *
 * \q
 *
 * ============================================================================
 * RUN
 * ============================================================================
 *
 * $env:NODE_OPTIONS="--conditions=react-server"
 * $env:CBC_DATABASE_URL="postgresql://cbc_app_validation:cbc_app_validation@localhost:55435/gate_003p_validation"
 * $env:CBC_DATABASE_SSL="false"
 * npx --yes tsx@4.23.0 scripts/validate-scan-result-helper.ts
 *
 * ============================================================================
 * TEARDOWN
 * ============================================================================
 *
 * Remove-Item Env:CBC_DATABASE_URL
 * Remove-Item Env:CBC_DATABASE_SSL
 * Remove-Item Env:NODE_OPTIONS
 * docker rm -f cbc-gate-003p-postgres
 *
 * SAFETY GUARDS:
 * - Requires CBC_DATABASE_URL.
 * - Refuses cbc_prod, azure, supabase, supabase.co,
 *   postgres.database.azure.com, pooler.supabase.com.
 * - Requires localhost / 127.0.0.1 / ::1.
 * - Requires exact port 55435.
 * - Requires exact database /gate_003p_validation.
 * - Requires runtime user cbc_app_validation or cbc_app.
 * - Requires NODE_OPTIONS=--conditions=react-server before importing the
 *   server-only helper.
 *
 * A separate admin connection is used only for disposable local seed/reset
 * and verification queries. recordFastScanResult is always called through
 * CBC_DATABASE_URL using the least-privileged runtime role.
 */

const url = process.env.CBC_DATABASE_URL;

if (!url) {
  console.error("FAIL: CBC_DATABASE_URL is not set.");
  process.exit(1);
}

const forbidden = [
  "cbc_prod",
  "azure",
  "supabase",
  "supabase.co",
  "postgres.database.azure.com",
  "pooler.supabase.com",
];

for (const pattern of forbidden) {
  if (url.toLowerCase().includes(pattern)) {
    console.error(`FAIL: CBC_DATABASE_URL contains "${pattern}".`);
    process.exit(1);
  }
}

let parsedUrl: URL;
try {
  parsedUrl = new URL(url);
} catch {
  console.error("FAIL: CBC_DATABASE_URL is not a valid URL.");
  process.exit(1);
}

const host = parsedUrl.hostname.toLowerCase();
if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
  console.error(`FAIL: CBC_DATABASE_URL host is "${host}". Must be localhost.`);
  process.exit(1);
}

if (parsedUrl.port !== "55435") {
  console.error(`FAIL: CBC_DATABASE_URL port is "${parsedUrl.port}". Must be 55435.`);
  process.exit(1);
}

if (parsedUrl.pathname !== "/gate_003p_validation") {
  console.error(
    `FAIL: CBC_DATABASE_URL database is "${parsedUrl.pathname}". Must be /gate_003p_validation.`
  );
  process.exit(1);
}

const runtimeUser = parsedUrl.username;
if (runtimeUser !== "cbc_app_validation" && runtimeUser !== "cbc_app") {
  console.error(
    `FAIL: CBC_DATABASE_URL user is "${runtimeUser}". ` +
      "Must be cbc_app_validation or cbc_app."
  );
  process.exit(1);
}

if (!process.env.NODE_OPTIONS?.includes("--conditions=react-server")) {
  console.error("FAIL: NODE_OPTIONS must include --conditions=react-server.");
  console.error('PowerShell: $env:NODE_OPTIONS="--conditions=react-server"');
  process.exit(1);
}

if (!process.env.CBC_DATABASE_SSL) {
  process.env.CBC_DATABASE_SSL = "false";
  console.log("INFO: CBC_DATABASE_SSL not set; defaulting to false for local validation.");
}

import { Client } from "pg";

const ADMIN_URL = "postgresql://postgres:postgres@localhost:55435/gate_003p_validation";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";
const USER_A = "a1111111-0000-0000-0000-000000000001";

const SCAN_A = "05ca1111-0000-0000-0000-000000000001";
const SCAN_B = "05cb2222-0000-0000-0000-000000000002";
const SCAN_FRESH = "05c30000-0000-0000-0000-000000000004";
const SCAN_SABOTAGE = "05c50000-0000-0000-0000-000000000005";

const TEST_SCAN_IDS = [SCAN_A, SCAN_B, SCAN_FRESH, SCAN_SABOTAGE];

let passed = 0;
let failed = 0;

function pass(name: string) {
  console.log(`PASS: ${name}`);
  passed++;
}

function fail(name: string, reason: string) {
  console.error(`FAIL: ${name} - ${reason}`);
  failed++;
}

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function resetSeedData() {
  await withAdmin(async (client) => {
    await client.query("DROP TRIGGER IF EXISTS t05_sabotage_trigger ON public.vendor_results");
    await client.query("DROP FUNCTION IF EXISTS public._t05_sabotage_vendor_insert()");

    await client.query(
      "DELETE FROM public.vendor_results WHERE scan_id = ANY($1::uuid[])",
      [TEST_SCAN_IDS]
    );
    await client.query(
      "DELETE FROM public.evidence_items WHERE scan_id = ANY($1::uuid[])",
      [TEST_SCAN_IDS]
    );
    await client.query(
      "DELETE FROM public.scans WHERE id = ANY($1::uuid[])",
      [TEST_SCAN_IDS]
    );

    await client.query(
      `INSERT INTO public.organizations (id, name, slug) VALUES
         ($1, 'Org A', 'org-a'),
         ($2, 'Org B', 'org-b')
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A, ORG_B]
    );

    await client.query(
      `INSERT INTO public.users (id, organization_id, full_name, role)
       VALUES ($1, $2, 'User A', 'admin')
       ON CONFLICT (id) DO UPDATE
       SET organization_id = EXCLUDED.organization_id,
           full_name = EXCLUDED.full_name,
           role = EXCLUDED.role`,
      [USER_A, ORG_A]
    );

    await client.query(
      `INSERT INTO public.memberships (user_id, organization_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (user_id, organization_id) DO NOTHING`,
      [USER_A, ORG_A]
    );

    await client.query(
      `INSERT INTO public.scans (id, organization_id, user_id, input_type, raw_input, status)
       VALUES
         ($1, $2, $3, 'url', 'http://a.example', 'pending'),
         ($4, $5, NULL, 'url', 'http://b.example', 'pending'),
         ($6, $2, $3, 'url', 'http://fresh.example', 'pending'),
         ($7, $2, $3, 'url', 'http://sabotage.example', 'pending')`,
      [SCAN_A, ORG_A, USER_A, SCAN_B, ORG_B, SCAN_FRESH, SCAN_SABOTAGE]
    );
  });
}

async function cleanupSabotageTrigger() {
  await withAdmin(async (client) => {
    await client.query("DROP TRIGGER IF EXISTS t05_sabotage_trigger ON public.vendor_results");
    await client.query("DROP FUNCTION IF EXISTS public._t05_sabotage_vendor_insert()");
  });
}

async function runValidation() {
  console.log("\n=== Gate 003P: recordFastScanResult validation ===\n");

  const { recordFastScanResult, RecordFastScanResultError } = await import(
    "../src/server/scan/recordFastScanResult.js"
  );
  const { mapVendorResults, mapEvidenceItems } = await import(
    "../src/server/scan/mapFastScanResultPayload.js"
  );

  await resetSeedData();

  try {
    const mapped = mapVendorResults([
      { vendorName: "virustotal", verdict: "safe", responseTimeMs: 250 },
      { vendorName: "", verdict: "safe" },
    ]);

    if (
      mapped.length === 2 &&
      mapped[0].vendor_name === "virustotal" &&
      mapped[0].verdict === "safe" &&
      mapped[0].response_time_ms === 250 &&
      mapped[1].vendor_name === ""
    ) {
      pass("T01: mapVendorResults transforms shape and preserves entries");
    } else {
      fail("T01", `unexpected mapping result: ${JSON.stringify(mapped)}`);
    }
  } catch (err) {
    fail("T01", String(err));
  }

  try {
    const mapped = mapEvidenceItems([
      { signalType: "domain_age", severity: "low", title: "Young domain", scoreImpact: 5 },
      { signalType: "", severity: "low", title: "Preserved for DB validation" },
    ]);

    if (
      mapped.length === 2 &&
      mapped[0].signal_type === "domain_age" &&
      mapped[0].severity === "low" &&
      mapped[0].title === "Young domain" &&
      mapped[0].score_impact === 5 &&
      mapped[1].signal_type === ""
    ) {
      pass("T02: mapEvidenceItems transforms shape and preserves entries");
    } else {
      fail("T02", `unexpected mapping result: ${JSON.stringify(mapped)}`);
    }
  } catch (err) {
    fail("T02", String(err));
  }

  try {
    const result = await recordFastScanResult({
      userId: USER_A,
      organizationId: ORG_A,
      scanId: SCAN_A,
      status: "complete",
      verdict: "safe",
      riskScore: 15,
      confidenceScore: 85,
      aiExplanation: "No threats detected.",
      recommendedAction: "Safe to proceed.",
      scanDurationMs: 300,
      vendorResults: [{ vendorName: "virustotal", verdict: "safe", responseTimeMs: 250 }],
      evidenceItems: [
        { signalType: "domain_age", severity: "low", title: "Young domain", scoreImpact: 5 },
      ],
    });

    const state = await withAdmin(async (client) => {
      const scanRow = await client.query(
        "SELECT status, verdict, completed_at FROM public.scans WHERE id = $1",
        [SCAN_A]
      );
      const vendorRow = await client.query(
        "SELECT COUNT(*)::int AS n FROM public.vendor_results WHERE scan_id = $1",
        [SCAN_A]
      );
      const evidenceRow = await client.query(
        "SELECT COUNT(*)::int AS n FROM public.evidence_items WHERE scan_id = $1",
        [SCAN_A]
      );

      return {
        status: scanRow.rows[0]?.status,
        verdict: scanRow.rows[0]?.verdict,
        completedAt: scanRow.rows[0]?.completed_at,
        vendorCount: vendorRow.rows[0]?.n,
        evidenceCount: evidenceRow.rows[0]?.n,
      };
    });

    if (
      result.scanId === SCAN_A &&
      state.status === "complete" &&
      state.verdict === "safe" &&
      state.completedAt !== null &&
      state.vendorCount === 1 &&
      state.evidenceCount === 1
    ) {
      pass("T03: successful helper call writes scan, vendor_results, evidence_items");
    } else {
      fail("T03", `unexpected result/state: ${JSON.stringify({ result, state })}`);
    }
  } catch (err) {
    fail("T03", String(err));
  }

  try {
    const result = await recordFastScanResult({
      userId: USER_A,
      organizationId: ORG_A,
      scanId: SCAN_FRESH,
      status: "complete",
      verdict: "unknown",
      riskScore: 0,
      confidenceScore: 0,
      aiExplanation: "No providers checked.",
      recommendedAction: "Use caution.",
      scanDurationMs: null,
      vendorResults: [],
      evidenceItems: [],
    });

    if (result.scanId === SCAN_FRESH) {
      pass("T04: GUC sequence works on same transaction/client for fresh same-tenant scan");
    } else {
      fail("T04", `unexpected scanId: ${result.scanId}`);
    }
  } catch (err) {
    fail("T04", String(err));
  }

  try {
    await cleanupSabotageTrigger();

    await withAdmin(async (client) => {
      await client.query(`
        CREATE OR REPLACE FUNCTION public._t05_sabotage_vendor_insert()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 't05_sabotage: deliberate vendor_results insert failure';
        END;
        $$;
      `);

      await client.query(`
        CREATE TRIGGER t05_sabotage_trigger
        BEFORE INSERT ON public.vendor_results
        FOR EACH ROW EXECUTE FUNCTION public._t05_sabotage_vendor_insert();
      `);
    });

    let raised = false;
    let isRecordError = false;
    let category: string | undefined;

    try {
      await recordFastScanResult({
        userId: USER_A,
        organizationId: ORG_A,
        scanId: SCAN_SABOTAGE,
        status: "complete",
        verdict: "safe",
        riskScore: 10,
        confidenceScore: 90,
        aiExplanation: "No threats.",
        recommendedAction: "Safe.",
        scanDurationMs: null,
        vendorResults: [{ vendorName: "vt", verdict: "safe" }],
        evidenceItems: [],
      });
    } catch (err) {
      raised = true;
      if (err instanceof RecordFastScanResultError) {
        isRecordError = true;
        category = err.category;
      }
    } finally {
      await cleanupSabotageTrigger();
    }

    const state = await withAdmin(async (client) => {
      const scanRow = await client.query(
        "SELECT status, completed_at FROM public.scans WHERE id = $1",
        [SCAN_SABOTAGE]
      );
      const vendorRow = await client.query(
        "SELECT COUNT(*)::int AS n FROM public.vendor_results WHERE scan_id = $1",
        [SCAN_SABOTAGE]
      );

      return {
        status: scanRow.rows[0]?.status,
        completedAt: scanRow.rows[0]?.completed_at,
        vendorCount: vendorRow.rows[0]?.n,
      };
    });

    if (
      raised &&
      isRecordError &&
      state.status === "pending" &&
      state.completedAt === null &&
      state.vendorCount === 0
    ) {
      pass(`T05: rollback on post-update failure, RecordFastScanResultError category=${category}`);
    } else {
      fail(
        "T05",
        `raised=${raised} isRecordError=${isRecordError} category=${category} state=${JSON.stringify(state)}`
      );
    }
  } catch (err) {
    await cleanupSabotageTrigger();
    fail("T05", `unexpected error: ${String(err)}`);
  }

  try {
    let raised = false;
    let category: string | undefined;

    try {
      await recordFastScanResult({
        userId: "",
        organizationId: "",
        scanId: SCAN_B,
        status: "complete",
        verdict: "safe",
        riskScore: 10,
        confidenceScore: 90,
        aiExplanation: "x",
        recommendedAction: "x",
        scanDurationMs: null,
        vendorResults: [],
        evidenceItems: [],
      });
    } catch (err) {
      raised = true;
      if (err instanceof RecordFastScanResultError) {
        category = err.category;
      }
    }

    if (raised && category === "context_missing") {
      pass("T06: empty identity values fail closed as context_missing through helper");
    } else {
      fail("T06", `raised=${raised} category=${category}`);
    }
  } catch (err) {
    fail("T06", `unexpected error: ${String(err)}`);
  }

  try {
    let raised = false;
    let category: string | undefined;

    try {
      await recordFastScanResult({
        userId: USER_A,
        organizationId: ORG_A,
        scanId: SCAN_B,
        status: "complete",
        verdict: "safe",
        riskScore: 10,
        confidenceScore: 90,
        aiExplanation: "x",
        recommendedAction: "x",
        scanDurationMs: null,
        vendorResults: [],
        evidenceItems: [],
      });
    } catch (err) {
      raised = true;
      if (err instanceof RecordFastScanResultError) {
        category = err.category;
      }
    }

    if (raised && category === "tenant_refused") {
      pass("T07: cross-tenant call refused through helper");
    } else {
      fail("T07", `raised=${raised} category=${category}`);
    }
  } catch (err) {
    fail("T07", `unexpected error: ${String(err)}`);
  }

  try {
    let raised = false;
    let category: string | undefined;

    try {
      await recordFastScanResult({
        userId: USER_A,
        organizationId: ORG_A,
        scanId: SCAN_A,
        status: "complete",
        verdict: "safe",
        riskScore: 10,
        confidenceScore: 90,
        aiExplanation: "x",
        recommendedAction: "x",
        scanDurationMs: null,
        vendorResults: [{ vendorName: "duplicate-attempt", verdict: "safe" }],
        evidenceItems: [],
      });
    } catch (err) {
      raised = true;
      if (err instanceof RecordFastScanResultError) {
        category = err.category;
      }
    }

    const dupCount = await withAdmin(async (client) => {
      const r = await client.query(
        "SELECT COUNT(*)::int AS n FROM public.vendor_results WHERE scan_id = $1 AND vendor_name = 'duplicate-attempt'",
        [SCAN_A]
      );
      return r.rows[0]?.n;
    });

    if (raised && category === "already_final" && dupCount === 0) {
      pass("T08: repeated final-state call refused, no duplicate rows");
    } else {
      fail("T08", `raised=${raised} category=${category} dupCount=${dupCount}`);
    }
  } catch (err) {
    fail("T08", `unexpected error: ${String(err)}`);
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    console.error("GATE_003P_VALIDATION_FAILED");
    process.exit(1);
  }

  console.log("GATE_003P_VALIDATION_PASSED");
}

runValidation().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
