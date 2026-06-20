# Gate 002 — Tenant Isolation Disposable Dry-Run Results

Status: PASS

## Scope

Gate 002 disposable dry-run validated the committed tenant-isolation migration and RLS behavior using a disposable Azure PostgreSQL database.

This was a dry-run only.

No production database changes were made.

## Target

| Item | Value |
|---|---|
| Disposable database | `cbc_002_validation` |
| Production database | `cbc_prod` untouched |
| Migration 001 | `infra/db/migrations/001_initial_schema.sql` |
| Migration 002 | `infra/db/migrations/002_tenant_isolation.sql` |
| Validation script | `infra/db/validation/002_tenant_isolation_dry_run_tests.sql` |
| Runtime-like validation role | `cbc_app_validation` |
| Role security | non-owner, NOBYPASSRLS |

## Apply Results

| Check | Result |
|---|---|
| Created disposable database | PASS |
| Applied 001 baseline schema | PASS |
| Applied 002 tenant isolation migration | PASS |
| Public table count after 002 | 11 |
| Membership count after empty backfill | 0 |
| Tenant tables RLS enabled | PASS |
| `scan_cache` excluded from tenant RLS | PASS |

## RLS Behavior Tests

| Test | Result |
|---|---|
| `CHECK_DATABASE` = `cbc_002_validation` | PASS |
| `cbc_app_validation` exists and has no superuser / no BYPASSRLS | PASS |
| `scan_cache` has no `organization_id` or `user_id` columns | PASS |
| `scan_cache` RLS disabled | PASS |
| Seeded 2 orgs, 3 users, 3 memberships, 2 scans | PASS |
| No context sees zero scans | PASS |
| Org A owner sees only Org A scan | PASS |
| Org A user with Org B context sees zero scans | PASS |
| Membership SELECT works without recursion | PASS |
| Org A sees only Org A child rows | PASS |
| Cross-org update affects zero rows | PASS |
| Cross-org insert denied by RLS | PASS |
| Plain member cannot mutate memberships | PASS |
| Owner can mutate memberships in own org | PASS |
| Audit log insert allowed, delete denied | PASS |
| Bootstrap mismatch denied | PASS |
| Bootstrap succeeds for session user | PASS |
| Validation role dropped | PASS |
| Disposable database dropped | PASS |

## Security Conclusion

Gate 002 dry-run proves the intended defense-in-depth behavior:

- RLS denies access when tenant context is missing.
- RLS denies access when the user is not a member of the selected organization.
- Valid membership allows access only to that tenant.
- Cross-tenant reads and writes are denied.
- Membership administration is restricted to owner/admin logic.
- Audit log is append-only for runtime role.
- Bootstrap function is constrained to the authenticated session user.
- Validation was performed as a non-owner, NOBYPASSRLS runtime-like role, not as `cbcpgadmin`.

## Cleanup

| Item | Result |
|---|---|
| Dropped disposable database `cbc_002_validation` | PASS |
| Dropped validation role `cbc_app_validation` | PASS |
| Cleared password from memory | PASS |

## Production Status

`cbc_prod` was not touched during this dry-run.

No traffic was moved.

No data was imported.

No app runtime connection was changed.

## Next Gate

Next gate is production apply planning for Gate 002, not execution.

Before applying 002 to `cbc_prod`, we still need an explicit production apply plan and approval.
