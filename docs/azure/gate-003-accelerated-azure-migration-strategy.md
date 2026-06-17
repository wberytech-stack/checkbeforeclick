# Gate 003 Accelerated Azure Migration Strategy

> PLANNING DOCUMENT ONLY.
> This document changes the migration posture because CheckBeforeClick currently has no active customer usage.
> It does not approve production execution by itself.
> Branch: audit/azure-current-state.

## 1. Reason for acceleration

Supabase has prompted for database pause due to low/no usage, and CheckBeforeClick is not currently serving active production customers.

This creates an opportunity to move faster toward the Azure-native runtime without building unnecessary long-term dual-run infrastructure.

The migration should be bold and fast, but not reckless.

## 2. New migration posture

Previous posture:

- slow gated migration
- Supabase retained as active runtime for longer
- Azure runtime prepared gradually

New posture:

- accelerated Azure cutover
- Supabase retained only as temporary export/rollback source
- avoid complex dual-write
- validate Azure runtime path before production cutover
- pause Supabase only after Azure runtime is proven

## 3. Core principle

No customers means controlled downtime is acceptable.

No customers does not mean security shortcuts are acceptable.

The project must still preserve:

- tenant isolation
- RLS enforcement
- least-privilege runtime roles
- safe worker processing
- reproducible database state
- rollback/export evidence
- clear operational audit trail

## 4. Architecture decision remains

Gate 003 will use two runtime roles:

- `cbc_app`
- `cbc_worker`

Both roles must be:

- non-owner
- `NOBYPASSRLS`
- least privilege
- unable to disable RLS
- unable to perform broad DDL
- unable to bypass tenant isolation

## 5. Application data-access decision

Current app data access is centralized through:

- `lib/data/client.ts`
- `lib/data/index.ts`

This is good for migration control.

However, the current implementation uses Supabase service-role access and bypasses RLS.

The Azure path must not simply flip a connection string.

The Azure path requires a PostgreSQL runtime adapter that supports:

- transactions
- `SET LOCAL app.current_user_id`
- `SET LOCAL app.current_organization_id`
- tenant-scoped queries in the same transaction
- worker-safe scan lifecycle operations

## 6. Worker decision

The worker path must be treated separately from user/API traffic.

Current worker processing starts from `scan_id`.

The worker must:

- not trust `organization_id` from queue payloads
- reload scan/org context from trusted database state
- avoid broad tenant-table DML where possible
- use `cbc_worker`
- prefer narrow controlled database functions for scan lifecycle writes

## 7. Accelerated gate sequence

### Gate 003A - runtime role runbook

Create the exact runbook for:

- `cbc_app`
- `cbc_worker`
- grants
- worker function model
- validation matrix
- disposable database test flow
- stop conditions

### Gate 003B - disposable validation

Validate the model against a disposable Azure PostgreSQL database before touching production roles/grants.

Validation must prove:

- no-context denial
- valid-context success
- wrong-org denial
- cross-tenant denial
- `cbc_worker` cannot broadly read tenant data
- worker functions cannot cross-write tenant results
- neither runtime role has `BYPASSRLS`
- neither runtime role owns tenant tables

### Gate 003C - Azure/Postgres adapter implementation

Build an Azure/Postgres adapter beside the current Supabase data path.

The adapter should preserve the existing `lib/data` business surface where practical.

The adapter must support transaction-bound context and worker-safe operations.

### Gate 003D - one-way data migration

Export Supabase data and import into Azure PostgreSQL.

Because there are no active customers, avoid complex dual-write.

Before export/import:

- capture Supabase state
- capture Azure state
- confirm Azure restore posture
- keep export artifacts secure
- do not expose secrets in logs

### Gate 004 - controlled Azure app cutover

Move the application runtime to Azure-backed data only after:

- Azure DB validation passes
- app adapter works
- auth path is decided
- worker path works
- smoke tests pass
- rollback path is known

### Gate 005 - Supabase pause/decommission

Pause Supabase only after:

- Azure production smoke test passes
- dashboard works
- scan creation works
- scan status works
- scan result page works
- worker processing works
- no critical logs/errors are observed
- export backup is retained securely

## 8. Explicit rejected shortcuts

Do not:

- pause Supabase before export/backup
- point app directly at Azure admin credentials
- use `cbcpgadmin` in application runtime
- create a new service-role-style BYPASSRLS runtime
- flip connection strings without an Azure/Postgres adapter
- ignore worker tenant isolation
- trust tenant/org IDs from browser payloads
- move traffic before smoke tests
- delete Supabase immediately after cutover

## 9. Acceptable acceleration

Because there are no active customers, the following are acceptable:

- shorter soak period
- no dual-write
- controlled downtime
- faster cutover once validation passes
- simpler rollback posture
- faster Supabase pause after Azure proof

## 10. Success definition

This accelerated strategy succeeds when CheckBeforeClick runs on Azure as the primary runtime with:

- Azure PostgreSQL as system of record
- no Supabase service-role runtime dependency
- tenant isolation enforced
- worker processing constrained
- app smoke tests passing
- Supabase safe to pause as fallback/export source

## 11. Current status

- Azure PostgreSQL foundation exists.
- Baseline schema applied.
- Gate 002 tenant isolation applied.
- Gate 003 runtime role architecture decision recorded.
- Current app data access findings recorded.
- No runtime roles created yet.
- No app traffic moved yet.
- Supabase still remains the active application backend until cutover.

