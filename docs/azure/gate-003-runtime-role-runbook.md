# Gate 003A - Runtime Role Runbook

> PLANNING DOCUMENT ONLY.
> This runbook does not approve production execution by itself.
> Branch: audit/azure-current-state.
> Production DB: cbc_prod on pg-cbc-prod-cc-001.postgres.database.azure.com.

## 1. Purpose

Gate 003A defines the safe runtime-role plan for moving CheckBeforeClick from Supabase service-role access toward Azure PostgreSQL runtime enforcement.

The goal is to prepare:

- `cbc_app` for user/API traffic
- `cbc_worker` for background scan processing
- least-privilege grants
- RLS-compatible runtime behavior
- disposable validation before production execution

## 2. Current state

Completed:

- Azure PostgreSQL foundation exists.
- Baseline schema is applied.
- Gate 002 tenant isolation is applied to `cbc_prod`.
- Gate 003 runtime-role design is documented.
- Current app data-access findings are documented.
- Accelerated Azure migration strategy is documented.

Not completed:

- `cbc_app` does not exist.
- `cbc_worker` does not exist.
- Azure/Postgres app adapter does not exist.
- Worker database functions do not exist.
- No app traffic has moved to Azure PostgreSQL.
- Supabase remains the current active backend until cutover.

## 3. Hard execution boundary

This runbook may be reviewed and committed.

This runbook does not authorize:

- creating roles in `cbc_prod`
- granting production permissions
- creating production worker functions
- changing app environment variables
- importing Supabase production data
- moving traffic
- pausing Supabase

Production execution requires separate explicit approval.

## 4. Required role model

Gate 003A uses two runtime roles:

- `cbc_app`
- `cbc_worker`

Both roles must be:

- `NOBYPASSRLS`
- non-superuser
- non-owner
- no database ownership
- no schema ownership
- no tenant table ownership
- no broad DDL
- least privilege only

## 5. `cbc_app` model

`cbc_app` is used by user-facing API/server routes.

Expected paths:

- dashboard reads
- scan result reads
- scan status reads
- scan creation writes
- future user/org tenant features

Each tenant-scoped operation must run in a transaction using:

- `SET LOCAL app.current_user_id`
- `SET LOCAL app.current_organization_id`

The tenant query must execute in the same transaction.

`cbc_app` must not use session-level `SET`.

`cbc_app` must not trust browser-supplied organization IDs.

## 6. `cbc_worker` model

`cbc_worker` is used by asynchronous background jobs.

Expected paths:

- scan processing
- provider result writes
- evidence writes
- scan status updates
- scan completion/failure updates

The worker must not trust queue payload `organization_id`.

Queue payload should carry `scan_id`.

Worker must reload scan/org context from trusted database state.

Preferred model:

- `cbc_worker` has no broad tenant-table DML by default.
- `cbc_worker` receives narrow `EXECUTE` permission on controlled scan lifecycle functions.
- Worker functions validate tenant ownership and state transitions internally.

## 7. Disposable validation first

Before production execution, create/use a disposable validation database.

The disposable database must contain:

- baseline schema
- Gate 002 tenant isolation migration
- proposed runtime roles
- proposed grants
- proposed worker functions
- synthetic tenant data

Production `cbc_prod` must not be used for first validation.

## 8. Synthetic validation data

Synthetic validation should include at minimum:

- organization A
- organization B
- user A in organization A
- user B in organization B
- scan A under organization A
- scan B under organization B
- evidence/vendor rows for each scan

The data must prove cross-tenant denial.

## 9. `cbc_app` validation matrix

Validate:

- no context: denied
- valid user/org context: allowed for same org
- valid user with wrong org context: denied
- org A cannot read org B scans
- org A cannot update org B scans
- org A cannot insert rows stamped as org B
- user-facing scan creation stamps correct org/user
- dashboard query returns only same-org data
- scan result query returns only same-org evidence/vendor rows

## 10. `cbc_worker` validation matrix

Validate:

- `cbc_worker` has `NOBYPASSRLS`
- `cbc_worker` does not own tenant tables
- `cbc_worker` cannot broadly read tenant tables unless explicitly justified
- `cbc_worker` cannot directly cross-write evidence/vendor rows
- worker function can process scan A correctly
- worker function cannot attach org A evidence to scan B
- worker function cannot override trusted org state with caller-supplied org ID
- invalid scan status transition is rejected
- nonexistent scan ID is rejected safely

## 11. Stop conditions

Stop immediately if:

- either runtime role has `BYPASSRLS`
- either runtime role owns tenant tables
- app role can read without context
- app role can cross-read tenant data
- app role can cross-write tenant data
- worker role can broadly read/write tenant tables without explicit controlled design
- worker function accepts caller-provided organization ID as authority
- RLS depends on session-level `SET`
- validation requires production customer data
- output logs expose secrets

## 12. Production execution prerequisites

Before touching `cbc_prod`, require:

- disposable validation pass
- reviewed SQL migration/runbook
- confirmed Azure restore posture
- clean Git branch
- committed runbook
- explicit execution approval
- rollback/cleanup commands prepared

## 13. App adapter prerequisite

Runtime roles alone are not enough.

The current app uses Supabase SDK service-role access.

Before app cutover, create an Azure/Postgres adapter that supports:

- PostgreSQL connection pooling safely
- transactions
- `SET LOCAL` tenant context
- typed data-access functions
- no service-role bypass
- worker-safe function calls

## 14. Success definition

Gate 003A succeeds when:

- runtime role model is documented
- validation matrix is documented
- stop conditions are documented
- production boundary is documented
- disposable validation plan is ready

Gate 003A does not mean runtime roles are created in production.

Gate 003A does not mean the app is Azure-live.
