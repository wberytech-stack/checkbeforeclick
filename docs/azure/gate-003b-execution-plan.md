# Gate 003B - Disposable DB Execution Plan

> EXECUTION PLAN ONLY (this document). The RUN it describes targets the
> disposable database cbc_003_validation EXCLUSIVELY. Never cbc_prod. No
> production roles, no traffic move, no Supabase pause, no DNS/Front Door/
> Container Apps change. Branch: audit/azure-current-state. Builds on Gate 003B
> scripts (committed) and the fast-path dependency note (fadb347).

## Purpose

Lock the exact order to: stand up a disposable validation DB, apply 001 + 002,
run the four Gate 003B scripts, capture logs, and commit the evidence - proving
the target cbc_app runtime role model enforces tenant isolation as a non-owner
NOBYPASSRLS role. No production surface is touched.

## Target and boundary

* Disposable DB: cbc_003_validation (created/used only for this run).
* Server: pg-cbc-prod-cc-001.postgres.database.azure.com (same server; a
  SEPARATE database from cbc_prod).
* Admin/migration role for the run: cbcpgadmin.
* Validation role created by the scripts: cbc_app_validation (throwaway).
* HARD: every script self-guards on current_database() = cbc_003_validation and
  refuses otherwise. Do not override that guard.

## Pre-flight checks (STEP 0 - do before anything else)

P0.1 Confirm clean git state and the expected HEAD:

* git status -sb  (expect clean, synced)
* git log --oneline -1  (expect fadb347 ...)

P0.2 Confirm the four SQL scripts contain NO stray markdown artifacts that would
break SQL: neither lines beginning with '##' (heading characters) NOR triple-
backtick code fences. For each of the four files, a search for lines beginning
with '##' AND a search for triple-backtick fences must both return NOTHING. If
either appears, STOP and fix before running (PostgreSQL will error on '##' or on
a backtick fence).

Files:

* infra/db/validation/gate-003/001_create_cbc_app_validation_role.sql
* infra/db/validation/gate-003/002_seed_synthetic_tenants.sql
* infra/db/validation/gate-003/003_validate_cbc_app_rls.sql
* infra/db/validation/gate-003/004_cleanup.sql

P0.3 Decide DB existence: does cbc_003_validation already exist?

* If NO: it will be created in Step 1.
* If YES (leftover): confirm it is safe to DROP and recreate fresh (it is
  disposable), or DROP it first so the run starts clean.

P0.4 Load the DB password from Key Vault into memory only (PGPASSWORD), never
printed. Confirm it loaded (length only).

## Execution order (locked)

Run connected to the SERVER. Steps that run SQL files use psql interactively with
\i (reliable given prior PowerShell flag-dropping). Capture each script's output
to a log file via \o before \i, then \o to close.

Step 1 - Create the disposable DB (connected to the 'postgres' database):

* DROP DATABASE IF EXISTS cbc_003_validation;   (clean slate)
* CREATE DATABASE cbc_003_validation;

Step 2 - Connect into cbc_003_validation, confirm identity:

* \c cbc_003_validation
* SELECT current_database();   (must read cbc_003_validation before proceeding)

Step 3 - Apply baseline schema:

* \i infra/db/migrations/001_initial_schema.sql
* Expect clean BEGIN...COMMIT, zero ERROR. (10 tables.)

Step 4 - Apply tenant isolation:

* \i infra/db/migrations/002_tenant_isolation.sql
* Expect clean BEGIN...COMMIT, zero ERROR. (memberships + RLS + functions.)
* NOTE: the 002 grant block will emit a NOTICE that cbc_app is absent - that is
  expected here (003B uses cbc_app_validation, created in Step 5).

Step 5 - Create validation role + grants (capture log):

* \o gate-003b-step5-create-role.log
* \i infra/db/validation/gate-003/001_create_cbc_app_validation_role.sql
* \o
* Expect all CHECK_* rows = PASS (role NOBYPASSRLS, owns no tenant tables,
  grants as intended, scan_cache NOT granted, RLS still enabled).

Step 6 - Seed synthetic tenants (capture log):

* \o gate-003b-step6-seed.log
* \i infra/db/validation/gate-003/002_seed_synthetic_tenants.sql
* \o
* Expect deterministic Org A / Org B seed; verification counts as documented.

Step 7 - Run the cbc_app RLS validation matrix (capture log) - THE CORE STEP:

* \o gate-003b-step7-validate.log
* \i infra/db/validation/gate-003/003_validate_cbc_app_rls.sql
* \o
* Expect EVERY test row = PASS. This includes: no-context deny; Org A sees only
  Org A; Org B sees only Org B; wrong-org context denied; cross-tenant read
  denied; cross-tenant write denied; dashboard/result/status reads same-org
  only; same-org scan create allowed; cross-org create denied; member cannot
  mutate memberships; owner/admin direct membership mutation is ALSO denied under
  the narrow cbc_app grant model (cbc_app_validation has no membership
  INSERT/UPDATE/DELETE grant - admin membership management goes through a
  controlled function / separate admin path later, not raw table mutation; this
  is test T19_OWNER_DIRECT_MEMBERSHIP_MUTATION_DENIED); membership SELECT no
  recursion; audit_log UPDATE/DELETE denied; bootstrap mismatch denied.
* Plus the documented fast-path expectations: cbc_app cannot UPDATE scans,
  INSERT vendor_results, or INSERT evidence_items under the target model. These
  denials are EXPECTED PASSES per the fadb347 dependency note.

Step 8 - Capture/verify logs:

* Confirm the three .log files exist and contain the PASS/FAIL lines.
* Review for ANY 'FAIL' or unexpected 'ERROR'.

Step 9 - Cleanup (ONLY if Step 7 fully passed - see stop conditions):

* \o gate-003b-step9-cleanup.log
* \i infra/db/validation/gate-003/004_cleanup.sql
* \o
* Expect: validation role dropped, synthetic data truncated, role-absence
  confirmed.
* Then dispose the whole DB. You CANNOT drop the database you are connected to,
  so reconnect to 'postgres' FIRST, then drop:

\c postgres
DROP DATABASE IF EXISTS cbc_003_validation;

* Clear password from memory (Remove-Variable / Remove-Item Env:PGPASSWORD).

Step 10 - Commit evidence (docs only):

* Write docs/azure/gate-003b-dry-run-results.md summarizing PASS/FAIL per test
  and citing the run. This summarized results doc is the PRIMARY evidence and
  is committed first.
* Do NOT auto-commit raw psql logs. Raw logs may contain hostnames, usernames,
  connection details, or environment output. Before committing ANY log, inspect
  it for secrets/connection strings/usernames/hostnames and sanitize. Only
  commit a log if it is confirmed secrets-free; otherwise keep it local or
  commit a sanitized excerpt. Decide location (e.g. docs/azure/ or
  infra/db/validation/gate-003/logs/) only for sanitized files.
* Commit message: docs: record Gate 003B disposable-DB validation results.

## Stop conditions (halt and inspect; do NOT proceed or clean up)

* P0.2 finds '##' or triple-backtick fences in a script -> fix first.
* Step 2 current_database() is not cbc_003_validation -> STOP (never run on prod).
* Step 3 or Step 4 apply shows any ERROR -> STOP (schema/migration problem).
* Step 5 any CHECK_* = FAIL (e.g. role has BYPASSRLS, owns tables, wrong grants)
  -> STOP.
* Step 7 ANY test = FAIL or unexpected cross-tenant access ALLOWED -> STOP and
  DO NOT run cleanup (preserve the failed state for inspection). Capture the log,
  report, decide a fix. A cross-tenant leak here is the most important signal in
  the whole gate.
* Any sign the run is touching cbc_prod, real data, or a persistent role beyond
  the throwaway -> STOP immediately.

## Cleanup-on-success vs pause-on-failure

* All Step 7 tests PASS -> proceed to Step 9 cleanup (dispose role + DB), then
  Step 10 evidence commit.
* Any FAIL -> STOP at Step 8; preserve cbc_003_validation and the logs for
  inspection; do not drop the role/DB until the failure is understood and
  documented. Cleanup can happen after, deliberately.

## What this run proves (and does not)

* PROVES: the target cbc_app role model enforces tenant isolation (and the
  documented fast-path denials) as a non-owner NOBYPASSRLS role, in a disposable
  DB, by behavior.
* DOES NOT: create any production role, grant anything on cbc_prod, move traffic,
  pause Supabase, or change DNS/Front Door/Container Apps. Those remain separate,
  later, explicitly-approved gates. The fast-path implementation dependency
  (fadb347) must be resolved before the app can actually run on cbc_app.

## Boundaries honored

Plan/run targets cbc_003_validation only. cbc_prod untouched. No production
roles. No traffic. No data import. No Supabase pause. No DNS/Front Door/Container
Apps change.
