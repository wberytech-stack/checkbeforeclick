# Gate 2G - Production Baseline Apply Plan

PLANNING DOCUMENT ONLY. No execution is approved by this document.
Applying 001_initial_schema.sql to cbc_prod is Gate 2H and requires a separate
explicit approval. Nothing in this file may be run against cbc_prod until 2H is approved.

## 1. Current repo / commit state
- Branch: audit/azure-current-state
- Gate 2F commit: 8b65459 infra: fix Azure baseline and record Gate 2F dry-run pass
- Migration file: infra/db/migrations/001_initial_schema.sql (317 lines; BOM-free; pgcrypto removed; baseline-only banner present)
- Dry-run (Gate 2F) result: PASS on disposable cbc_schema_validation - 10 tables, 18 FKs all public.*, no auth.users FK, no Supabase residue, plpgsql only. cbc_prod was not touched.

## 2. Preconditions before touching cbc_prod (all must be TRUE)
- Gate 2H explicitly approved by program lead (ChatGPT) and founder.
- Branch is audit/azure-current-state, clean, synced with origin; HEAD includes 8b65459 (or later).
- The exact 001 to be applied is the committed, dry-run-validated version (git status clean; log shows 2F commit).
- cbc_prod confirmed EMPTY of application tables (pre-check 4.A returns 0). If not empty, STOP.
- Password loaded from Key Vault into memory only (PGPASSWORD), never printed.
- psql path confirmed: C:\Program Files\PostgreSQL\16\bin\psql.exe
- Maintenance/quiet window acceptable (no app traffic depends on cbc_prod yet).
- Reviewer present / available to inspect on any error.

## 3. Exact production apply command - DO NOT RUN YET
Recorded for review. DO NOT RUN until 2H is explicitly approved. Single line:

    & "C:\Program Files\PostgreSQL\16\bin\psql.exe" "host=pg-cbc-prod-cc-001.postgres.database.azure.com port=5432 dbname=cbc_prod user=cbcpgadmin sslmode=require" -v ON_ERROR_STOP=1 -f infra/db/migrations/001_initial_schema.sql

Notes:
- ON_ERROR_STOP=1 halts on first error rather than partially applying.
- 001 is wrapped in BEGIN ... COMMIT; clean run commits atomically; error stops before COMMIT.
- Target is dbname=cbc_prod. This is the ONLY step in this runbook that targets cbc_prod.

## 4. Read-only PRE-CHECK queries against cbc_prod (run when 2H opens)
A. Empty check (EXPECT 0):
    SELECT count(*) AS table_count FROM pg_tables WHERE schemaname='public';
B. Current DB (EXPECT cbc_prod):
    SELECT current_database();
C. Unexpected schemas (EXPECT none):
    SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','public','pg_toast') ORDER BY nspname;
D. Extensions (EXPECT plpgsql only):
    SELECT extname FROM pg_extension ORDER BY extname;
STOP CONDITION: if A is not 0, do not apply. Investigate first.

## 5. Apply step (Gate 2H only - DO NOT RUN in 2G)
Use the command in Section 3. Apply once, watch for any ERROR line.
Clean apply shows: BEGIN, CREATE FUNCTION, 10x CREATE TABLE, ALTER TABLE, CREATE INDEX x20, COMMIT - zero ERROR lines.

## 6. POST-CHECK queries against cbc_prod (Gate 2H only)
A. Table list (EXPECT 10: alerts, audit_log, evidence_items, organizations, scan_cache, scan_feedback, scans, users, vendor_results, watchlist):
    SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;
B. Table count (EXPECT 10):
    SELECT count(*) AS table_count FROM pg_tables WHERE schemaname='public';
C. FK count (EXPECT 18) and none reference auth.users:
    SELECT count(*) AS fk_count FROM pg_constraint WHERE contype='f';
    SELECT conrelid::regclass AS child, confrelid::regclass AS parent, conname FROM pg_constraint WHERE contype='f' ORDER BY child, parent;
D. Unexpected schemas (EXPECT none):
    SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','public','pg_toast') ORDER BY nspname;
E. Policy count (EXPECT 0):
    SELECT count(*) AS policy_count FROM pg_policies;
F. RLS-enabled tables (EXPECT 0 rows):
    SELECT relname FROM pg_class WHERE relrowsecurity = true ORDER BY relname;
G. Supabase roles (EXPECT 0 rows):
    SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','supabase_admin','supabase_auth_admin','authenticator') ORDER BY rolname;
H. Current DB guard (EXPECT cbc_prod):
    SELECT current_database();
PASS criteria: A=10 names match, B=10, C=18 no auth.users parent, D=none, E=0, F=0 rows, G=0 rows, H=cbc_prod.

## 7. Stop conditions
- Pre-check 4.A not 0 -> STOP, do not apply.
- Any ERROR during apply -> STOP; with ON_ERROR_STOP=1 the transaction did not COMMIT; inspect.
- Any post-check mismatch -> STOP and report before any later gate.
- current_database() != cbc_prod -> STOP.

## 8. Rollback reality
- 001 applies inside BEGIN ... COMMIT with ON_ERROR_STOP=1. Error before COMMIT = nothing persists; re-inspect, do not improvise.
- If a clean COMMIT happened but a post-check reveals an unexpected object, DO NOT improvise destructive rollback (no ad-hoc DROPs). STOP, report, decide a reviewed corrective action. Safest reset if ever needed and explicitly approved: recreate the empty database - separate approved action, never improvised.
- No data in cbc_prod at this stage, so a schema-only mistake has no data-loss consequence. That is why applying the baseline now (empty DB) is low-risk.

## 9. Explicit scope notes
- 001_initial_schema.sql is BASELINE-ONLY (pre-tenant-isolation).
- memberships, RLS, session-variable authorization, and app-layer tenant authorization are DEFERRED to 002. Their absence here is by design.
- Applying 001 does NOT move any application traffic. The app remains on Supabase.
- Applying 001 does NOT import any data.
- A clean 001 apply means only: the Azure baseline schema exists in cbc_prod. It does NOT mean tenant isolation is ready, auth is migrated, or the app is on Azure.

## 10. Next gates after 2G
- Gate 2H - apply 001 to cbc_prod (execution; needs explicit approval; uses this runbook).
- Phase A.1 - auth/tenant code audit.
- 002 - tenant isolation: memberships + RLS/session variable + app-layer tenant auth.
- 003+ - auth integration (Entra), app runtime, jobs, data migration rehearsal, production cutover.
