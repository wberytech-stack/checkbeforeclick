/**
 * Gate 003H - Disposable PostgreSQL validation of the pg transaction helper.
 *
 * Run with:
 *   $env:NODE_OPTIONS="--conditions=react-server"
 *   $env:CBC_DATABASE_URL="postgresql://postgres:postgres@localhost:55433/gate_003h_validation"
 *   $env:CBC_DATABASE_SSL="false"
 *   npm run validate:pg-helper
 *   Remove-Item Env:NODE_OPTIONS
 *   Remove-Item Env:CBC_DATABASE_URL
 *   Remove-Item Env:CBC_DATABASE_SSL
 *
 * Requires CBC_DATABASE_URL to point to a local disposable PostgreSQL only.
 * Refuses production, Azure, Supabase, cbc_prod, or non-localhost URLs.
 * NODE_OPTIONS=--conditions=react-server is required so server-only resolves
 * correctly outside Next.js runtime while still exercising the real helper.
 *
 * Does NOT touch migrations, scan route, Azure, cbc_prod, Key Vault, or deploy.
 */

const url = process.env.CBC_DATABASE_URL;

if (!url) {
  console.error("FAIL: CBC_DATABASE_URL is not set.");
  console.error("Set it to a local disposable PostgreSQL URL before running.");
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
    console.error("This script must only run against a local disposable database.");
    process.exit(1);
  }
}

// Refuse non-localhost hosts.
try {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    console.error(`FAIL: CBC_DATABASE_URL host is "${host}".`);
    console.error("This script only runs against localhost. Refusing non-local host.");
    process.exit(1);
  }
} catch {
  console.error("FAIL: CBC_DATABASE_URL is not a valid URL.");
  process.exit(1);
}

if (!process.env.CBC_DATABASE_SSL) {
  process.env.CBC_DATABASE_SSL = "false";
  console.log("INFO: CBC_DATABASE_SSL not set; defaulting to false for local validation.");
}

import { withPgTransaction } from "../src/server/db/postgres.js";

const TABLE = "pg_helper_validation";
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

async function setup(client: import("pg").PoolClient) {
  await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await client.query(
    `CREATE TABLE ${TABLE} (id serial PRIMARY KEY, marker text NOT NULL)`
  );
}

async function teardown(client: import("pg").PoolClient) {
  await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
}

async function runValidation() {
  console.log("\n=== Gate 003H: pg transaction helper validation ===\n");

  // Setup: create disposable table in its own transaction.
  await withPgTransaction(async (client) => {
    await setup(client);
  });

  // T1: commit success
  try {
    await withPgTransaction(async (client) => {
      await client.query(`INSERT INTO ${TABLE} (marker) VALUES ($1)`, ["t1-commit"]);
    });
    const result = await withPgTransaction(async (client) => {
      return client.query(`SELECT marker FROM ${TABLE} WHERE marker = $1`, ["t1-commit"]);
    });
    if (result.rows.length === 1 && result.rows[0].marker === "t1-commit") {
      pass("T1: commit success - row persisted after transaction");
    } else {
      fail("T1: commit success", "row not found after commit");
    }
  } catch (err) {
    fail("T1: commit success", String(err));
  }

  // T2: rollback on thrown error
  try {
    await withPgTransaction(async (client) => {
      await client.query(`INSERT INTO ${TABLE} (marker) VALUES ($1)`, ["t2-rollback"]);
      throw new Error("deliberate rollback");
    });
    fail("T2: rollback on error", "expected exception was swallowed");
  } catch {
    const result = await withPgTransaction(async (client) => {
      return client.query(`SELECT marker FROM ${TABLE} WHERE marker = $1`, ["t2-rollback"]);
    });
    if (result.rows.length === 0) {
      pass("T2: rollback on error - row correctly absent after rollback");
    } else {
      fail("T2: rollback on error", "row persisted despite rollback");
    }
  }

  // T3: transaction-local set_config / current_setting GUC behavior
  try {
    const marker = await withPgTransaction(async (client) => {
      await client.query(
        `SELECT set_config('app.validation_marker', $1, true)`,
        ["gate-003h"]
      );
      const res = await client.query(
        `SELECT current_setting('app.validation_marker', true) AS val`
      );
      return res.rows[0]?.val as string | null;
    });
    if (marker === "gate-003h") {
      pass("T3: transaction-local set_config/current_setting - GUC visible on same client");
    } else {
      fail("T3: set_config/current_setting", `expected 'gate-003h', got '${marker}'`);
    }
  } catch (err) {
    fail("T3: set_config/current_setting", String(err));
  }

  // Teardown
  await withPgTransaction(async (client) => {
    await teardown(client);
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    console.error("GATE 003H VALIDATION FAILED");
    process.exit(1);
  }

  console.log("GATE 003H VALIDATION PASSED");
}

runValidation().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
