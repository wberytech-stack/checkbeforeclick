# Gate 008A — transactional scan outbox (draft)

Migration: `infra/db/migrations/008_scan_job_outbox.sql`. This is **code only**. It has not been applied to an Azure, staging, production or shared database.

## Security and transaction contract

- `app_create_scan` inserts a pending scan. An `AFTER INSERT` trigger inserts one outbox row **inside the same transaction**. Failed/rolled-back scan creation leaves neither row. A migration-time backfill captures existing pending scans.
- The web role `cbc_app` has no direct outbox table access and cannot execute the worker functions. The worker role `cbc_worker` must be a separate `NOINHERIT NOBYPASSRLS` non-owner role, with no inherited membership granted to `cbc_app`. Neither role gets direct table DML.
- Only `cbc_worker` may claim jobs with `app_claim_scan_jobs(limit, lease_seconds)`. Claims are atomic via `FOR UPDATE SKIP LOCKED`, bounded to 10 jobs, 30–600 second leases, and 8 attempts. The function returns the exact input and **database-derived** organization ID to the trusted worker; no user-facing endpoint may expose this payload.
- Claim is **at least once**, not exactly once. Lease expiration can redeliver a job with a fresh random token. Consumers must not call provider APIs or persist evidence more than once without a lease-aware idempotency contract.
- `app_ack_scan_job(scan_id, lease_token)` only acknowledges an unexpired, current lease after the scan is terminal. It does not write scan/evidence data. Replay, stale tokens and nonterminal scans return false.
- No job is dispatched to Azure or Inngest by this migration. Exhausted jobs remain in the table for investigation; do not silently delete them. Worker processing and lease-bound result persistence are **not implemented yet**.

## Disposable validation

The existing `data-plane-validate` pull-request workflow runs `scripts/azure-data/run-disposable-db.sh` against a freshly initialized loopback PostgreSQL 16 instance. The runner creates an ephemeral `cbc_worker` and tests SQL role separation, zero outbox RLS policies, denied direct table access, atomic rollback, concurrent claims, stale lease replay, terminal acknowledgment, and eight-attempt exhaustion. The database is stopped and removed after the tests. No cloud access or credentials are needed.

## Deployment prerequisites — require founder approval

1. Review migrations 001–008 together and independently validate them against a disposable database. Create a dedicated managed-identity-backed `cbc_worker` PostgreSQL principal with the specified role restrictions, distinct from the web application's `cbc_app` identity. Do not grant the web app worker identity permissions.
2. Implement and test a lease-bound completion function that atomically writes terminal scan results and evidence **only for the currently leased job**. Restrict direct `app_record_fast_scan_result` / `app_mark_scan_processing` execution to the necessary service boundary. Until that is complete, **do not enable worker polling or deploy this as a functioning queue**.
3. Deploy a dedicated Azure-native timer-triggered worker with a separate managed identity, bounded concurrency, no public ingress, least-privilege egress to required scan providers, and structured logs that omit raw inputs and credentials. Validate idempotency, timeouts, dead-letter alerting and crash recovery before cutover.
4. Only after approval, apply the reviewed migration using the schema-owner identity in a controlled transaction. Never run the migration as `cbc_app` or `cbc_worker`. Validate grants, RLS, triggers and worker-only claims before directing production scan traffic to the new path.

## Rollback and recovery

- **Before cutover:** disable worker polling; the migration is additive, and the legacy job path remains untouched. No Azure resource changes are needed to roll back a draft code change.
- **After cutover (requires explicit approval):** stop new scan submissions and worker polling first, preserve the outbox and scan/evidence records, and reconcile any `leased` or `ready` rows with scan terminal states. Do not drop the outbox table or trigger while pending work exists. Restore the previous routing only after a reviewed reconciliation plan; do not automatically replay external provider calls.
- A PostgreSQL schema rollback or data deletion is **not authorized** by this draft. Use a reviewed, backed-up, operator-run recovery procedure.

## Next code milestone

Implement the **lease-token-validated, atomic scan/evidence completion function** and its disposable-PostgreSQL regression tests, then connect an Azure-native worker adapter. The existing `cbc_app` grants for older scan-processing functions remain a cutover hardening task; they must be removed before a worker can safely execute provider results.
