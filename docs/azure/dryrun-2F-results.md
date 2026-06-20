# Gate 2F — Dry-Run Schema Validation Results

Date: 2026-06-12
Branch: audit/azure-current-state
Migration file: infra/db/migrations/001_initial_schema.sql
Target server: pg-cbc-prod-cc-001.postgres.database.azure.com (PostgreSQL 16.14)
Validation database: cbc_schema_validation (disposable; cbc_prod NOT touched)

## Outcome: PASS (after two fixes)

The first dry-run surfaced two issues. Both were fixed and the migration was
re-validated on a fresh disposable database with zero errors.

### Issues found on first run
1. UTF-8 BOM on line 1 caused a syntax error on the opening comment line.
   Fixed by re-saving the file as UTF-8 without BOM.
2. CREATE EXTENSION pgcrypto failed: pgcrypto is not allow-listed on Azure
   Database for PostgreSQL Flexible Server. Determined the extension is
   unnecessary - the only usage was UUID generation via gen_random_uuid(),
   which is built into PostgreSQL 13+ core. Verified gen_random_uuid() returns
   a valid UUID with no extension installed. Fixed by removing the line.

### Re-validation (clean run)
Migration applied as a single transaction (BEGIN ... COMMIT) with no errors.

- Table count: 10 (expected 10).
- Table names: alerts, audit_log, evidence_items, organizations, scan_cache,
  scan_feedback, scans, users, vendor_results, watchlist. No memberships (by design).
- Foreign keys: 18, all parents in public.*; none reference auth.users.
- Unexpected schemas: none (no auth/storage/realtime/vault).
- RLS-enabled tables: none. Policies: 0.
- Supabase roles (anon/authenticated/service_role/supabase_*): none.
- Extensions installed: plpgsql only (pgcrypto not required).
- current_database(): cbc_schema_validation (ran in disposable DB).

## Scope / design notes
- 001_initial_schema.sql is the Azure-safe BASELINE schema. It is NOT the final
  tenant-isolation model.
- memberships is intentionally deferred to the tenant-isolation layer (002),
  with RLS/session-variable authorization and app-layer tenant enforcement.
- users.id is now a standalone PK; the former auth.users linkage is replaced by
  Entra identity mapping in a later auth-integration gate.
- generate_org_slug retained: reviewed, pure app logic, pinned search_path, no
  auth/Supabase coupling. handle_new_user and get_user_org_id are correctly NOT
  in the baseline.

## Important
- Gate 2F is validation only. The baseline was NOT applied to cbc_prod.
- A clean 2F proves the schema applies cleanly to Azure. It does NOT mean tenant
  isolation is ready - that is the 002 layer plus staging rehearsal, which is the
  gating safety milestone before any production cutover.
