# Gate 002 - Production Apply Plan

> PLANNING DOCUMENT ONLY.
>
> This document does **not** approve execution.
> Applying Gate 002 to `cbc_prod` requires a separate explicit approval step.
> Nothing in this document should be interpreted as permission to run production
> DDL, create runtime roles, move application traffic, or import data.

## 0. Current status

Gate 002 tenant isolation has been designed, implemented as a migration, and
successfully validated against a disposable Azure PostgreSQL database.

The disposable dry-run is **complete and passed**.

Latest confirmed commit:

```text
3c04133 docs: record Gate 002 dry-run results
```

Production database state:

```text
Azure PostgreSQL server: pg-cbc-prod-cc-001.postgres.database.azure.com
Production DB: cbc_prod
Current cbc_prod state: 001 baseline only
Gate 002 production state: NOT APPLIED
```

No application traffic has been moved to Azure-only runtime.

No production data has been imported.

The `cbc_app` runtime role has not been created yet.

## 1. Gate 002 dry-run proof

Disposable validation database:

```text
cbc_002_validation
```

Validation role:

```text
cbc_app_validation
non-owner
NOBYPASSRLS
```

Dry-run result summary:

| Check                                           | Result |
| ----------------------------------------------- | ------ |
| Applied 001 baseline                            | PASS   |
| Applied 002 tenant isolation migration          | PASS   |
| Missing tenant context denied                   | PASS   |
| Wrong organization context denied               | PASS   |
| Valid membership allowed own tenant only        | PASS   |
| Cross-organization update denied                | PASS   |
| Cross-organization insert denied                | PASS   |
| Membership SELECT avoided recursive RLS failure | PASS   |
| Member cannot mutate memberships                | PASS   |
| Owner can mutate memberships                    | PASS   |
| Audit log insert allowed                        | PASS   |
| Audit log delete denied                         | PASS   |
| Bootstrap mismatch denied                       | PASS   |
| Bootstrap session-user allowed                  | PASS   |
| Disposable DB dropped                           | PASS   |
| Validation role dropped                         | PASS   |

Conclusion:

Gate 002 is runtime-validated against a disposable Azure PostgreSQL database
using a non-owner, NOBYPASSRLS role.

## 2. Purpose of Gate 002 production apply

Gate 002 introduces tenant isolation enforcement for the Azure PostgreSQL target
schema.

The intended production outcome is:

1. Apply the Gate 002 migration to `cbc_prod`.
2. Preserve the existing 001 baseline schema.
3. Enforce tenant-scoped access through RLS.
4. Prepare the database for later runtime role creation and application wiring.
5. Avoid moving application traffic during this gate.

## 3. Explicit non-goals

This gate must **not** perform any of the following:

* Do not create the final `cbc_app` runtime role.
* Do not move application traffic to Azure.
* Do not import production or Supabase data.
* Do not connect the deployed app to `cbc_prod`.
* Do not alter DNS, Front Door, Container Apps, or application runtime settings.
* Do not bypass RLS.
* Do not run application tests against production with privileged owner access.
* Do not treat this document as execution approval.

## 4. Preconditions before production apply

Before applying Gate 002 to `cbc_prod`, all of the following must be true:

1. Current branch is confirmed:

```text
audit/azure-current-state
```

2. Git working tree is clean.

3. Latest committed dry-run result is present:

```text
3c04133 docs: record Gate 002 dry-run results
```

4. Production target is explicitly confirmed as:

```text
pg-cbc-prod-cc-001.postgres.database.azure.com
cbc_prod
```

5. The migration file for Gate 002 is reviewed.

6. No pending local changes exist in migration files.

7. A separate explicit approval is given to apply Gate 002 to `cbc_prod`.

## 5. Production apply sequence

The future production apply sequence should be:

1. Confirm local branch and clean working tree.
2. Confirm target server and database.
3. Set production database password in session memory only.
4. Connect to `cbc_prod` using the migration/admin role.
5. Run the Gate 002 migration exactly once.
6. Validate the migration completed.
7. Run post-apply RLS smoke checks using a non-owner validation role.
8. Confirm cross-tenant denial behavior.
9. Confirm valid tenant membership behavior.
10. Drop any temporary validation role created for the production smoke test.
11. Clear password variables from shell session.
12. Commit the production apply result document.

## 6. Production validation expectations

After applying Gate 002 to `cbc_prod`, validation should confirm:

| Validation                              | Expected result |
| --------------------------------------- | --------------- |
| 001 baseline remains intact             | PASS            |
| Gate 002 objects exist                  | PASS            |
| RLS is enabled on tenant-scoped tables  | PASS            |
| Missing context denied                  | PASS            |
| Wrong organization context denied       | PASS            |
| Own-tenant SELECT allowed               | PASS            |
| Cross-tenant SELECT denied              | PASS            |
| Cross-tenant INSERT denied              | PASS            |
| Cross-tenant UPDATE denied              | PASS            |
| Membership recursion avoided            | PASS            |
| Unauthorized membership mutation denied | PASS            |
| Owner membership mutation allowed       | PASS            |
| Audit log append allowed                | PASS            |
| Audit log delete denied                 | PASS            |
| Bootstrap mismatch denied               | PASS            |
| Bootstrap session-user allowed          | PASS            |

## 7. Rollback posture

Gate 002 affects tenant isolation and RLS behavior. Rollback must not be treated
as a casual automatic step.

If production apply fails before completion:

1. Stop immediately.
2. Capture the exact error.
3. Do not continue applying additional changes.
4. Do not move application traffic.
5. Assess whether the failure occurred before or after partial DDL execution.
6. Decide whether to repair forward or restore from backup.

If production apply succeeds but validation fails:

1. Keep application traffic away from `cbc_prod`.
2. Preserve evidence of the failed validation.
3. Do not create `cbc_app`.
4. Do not import data.
5. Investigate and fix in a new migration or controlled corrective script.

## 8. Risk controls

Production safety controls:

* Application traffic remains off.
* Runtime role is not created yet.
* Data import is blocked until tenant isolation is proven in production.
* Validation must use non-owner, NOBYPASSRLS behavior.
* Passwords must remain session-scoped and cleared after use.
* Every production action must be documented after execution.

## 9. Approval boundary

This document only prepares the production apply plan.

The next approval gate is:

```text
Approve Gate 002 production apply to cbc_prod
```

Until that approval is explicitly given:

```text
DO NOT apply Gate 002 to cbc_prod.
DO NOT create cbc_app.
DO NOT move app traffic.
DO NOT import data.
```

## 10. Current decision

Gate 002 production apply is planned but not approved.

Current state remains:

```text
cbc_prod has 001 baseline only.
Gate 002 is not applied to cbc_prod.
Application traffic remains unchanged.
```
