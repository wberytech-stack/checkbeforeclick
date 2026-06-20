# Gate 2H — Production Baseline Schema Apply Results

Status: PASS

## Scope

Gate 2H applied the approved Azure baseline schema migration to the production Azure PostgreSQL database `cbc_prod`.

Migration file:

`infra/db/migrations/001_initial_schema.sql`

This migration is baseline-only. It does not include the final tenant-isolation model.

The following remain intentionally deferred to Gate 002:

- `memberships`
- RLS
- session-variable authorization
- app-layer tenant authorization
- tenant-isolation enforcement tests

No app traffic was moved.
No data was imported.
No raw Supabase export was run.

## Target

| Setting | Value |
|---|---|
| Server | `pg-cbc-prod-cc-001.postgres.database.azure.com` |
| Database | `cbc_prod` |
| User | `cbcpgadmin` |
| SSL | Required |
| Source branch | `audit/azure-current-state` |
| Source commit before apply | `aeb0b15` |

## Pre-checks

Before applying the migration:

| Check | Result |
|---|---|
| `current_database()` | `cbc_prod` |
| Existing public tables | `0 rows` |

Result: production database was confirmed empty before baseline apply.

## Apply result

The approved migration file was applied to `cbc_prod`.

Interactive `psql` command `\i infra/db/migrations/001_initial_schema.sql` was used because local PowerShell handling was dropping command flags for this machine. This executed the same committed migration file.

Observed execution:

- `BEGIN`
- `CREATE FUNCTION`
- 10 `CREATE TABLE` operations
- constraints created
- 20 `CREATE INDEX` operations
- foreign keys created
- `COMMIT`
- zero `ERROR:` lines

Result: migration completed successfully as a single transaction.

## Post-checks

| Check | Result |
|---|---|
| Table list | exactly 10 expected tables |
| Foreign keys | 18 |
| FK parents | all `public.*` |
| `auth.users` FK | none |
| Unexpected schemas | none |
| RLS-enabled tables | 0 rows |
| Policies | 0 |
| `current_database()` | `cbc_prod` |

Expected tables confirmed:

- `alerts`
- `audit_log`
- `evidence_items`
- `organizations`
- `scan_cache`
- `scan_feedback`
- `scans`
- `users`
- `vendor_results`
- `watchlist`

No `memberships` table exists in `001`; this is intentional. `memberships` belongs in Gate 002 with the tenant-isolation model.

## Gate 2H result

Gate 2H PASS.

`cbc_prod` now contains the approved baseline schema only.

Production app remains unaffected and still points to the existing Supabase path.

No data import has occurred.

No traffic cutover has occurred.

Next gate: Phase A.1 — auth/tenant code audit, feeding Gate 002 tenant isolation.
