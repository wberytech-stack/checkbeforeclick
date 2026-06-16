# Gate 002 - Production Apply Results

## Summary

Gate 002 tenant-isolation migration was applied to Azure PostgreSQL production database `cbc_prod`.

## Target

- Server: `pg-cbc-prod-cc-001.postgres.database.azure.com`
- Database: `cbc_prod`
- Migration file: `infra/db/migrations/002_tenant_isolation.sql`
- Branch: `audit/azure-current-state`
- Commit: `19119b4`
- Operator: Wbery
- Apply log: `docs/azure/gate-002-production-apply-20260616T192402Z.log`
- Restore posture: Confirmed before apply
  - Backup retention: 7 days
  - Point-in-time restore available
  - Earliest restore point: June 12
  - Latest restore point: June 16

## Apply Result

- Migration transaction completed with `COMMIT`.
- `memberships` table created.
- Tenant RLS policies created.
- Expected `app_*` helper functions created as `SECURITY DEFINER`.
- `cbc_app` role was not present, so grants were skipped as expected by this gate.
- No `cbc_app` runtime role was created.
- No app traffic was moved.
- No data was imported.

## Validation Results

### Production identity check

Confirmed connection target:

- Database: `cbc_prod`
- User: `cbcpgadmin`
- PostgreSQL: `16.14`

### Public tables

Post-apply public tables:

- `alerts`
- `audit_log`
- `evidence_items`
- `memberships`
- `organizations`
- `scan_cache`
- `scan_feedback`
- `scans`
- `users`
- `vendor_results`
- `watchlist`

### RLS status

RLS enabled on tenant tables:

- `alerts`
- `audit_log`
- `evidence_items`
- `memberships`
- `organizations`
- `scan_feedback`
- `scans`
- `users`
- `vendor_results`
- `watchlist`

`scan_cache` remains without RLS and is treated as global/provider cache data, not tenant-owned customer data.

### Policies

Tenant policies were confirmed on:

- `alerts`
- `audit_log`
- `evidence_items`
- `memberships`
- `organizations`
- `scan_feedback`
- `scans`
- `users`
- `vendor_results`
- `watchlist`

### Helper functions

Confirmed expected helper functions exist and are `SECURITY DEFINER`:

- `app_current_org_id`
- `app_current_user_id`
- `app_is_member`
- `app_is_org_admin`
- `app_tenant_admin_check`
- `app_tenant_check`

### Data state

Production tenant data tables were empty at apply time:

- `organizations`: 0
- `users`: 0
- `memberships`: 0
- `scans`: 0

Because production had no tenant/user/scan rows, no membership backfill rows were required.

### Temporary validation role smoke test

Temporary non-owner role:

- Role: `cbc_gate002_validation`
- `NOBYPASSRLS`: confirmed
- No-context RLS smoke test returned 0 visible organizations
- Temporary validation role privileges revoked
- Temporary validation role dropped
- Role absence confirmed after cleanup

## Final Status

Gate 002 production apply is complete at the database-structure and RLS-policy level.

Runtime cutover remains blocked until a later gate creates/configures the runtime app role and application connection path.

## Explicit Non-Actions

The following were intentionally not performed:

- Did not create `cbc_app`
- Did not move application traffic
- Did not import production data
- Did not change DNS
- Did not change Azure Front Door
- Did not change Container Apps
- Did not run app traffic against `cbc_prod`
