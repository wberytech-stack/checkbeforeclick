# Gate 008A — lease-bound scan completion (migration 009)

**Status:** Draft code only. Founder approval is required to apply migration 009 to a persistent database or deploy any worker. No Supabase account migration or staging account bootstrap is needed for the clean-room Azure architecture.

## Security contract

Migration 009 adds **app_complete_scan_job** with scan ID, lease token, terminal scan fields and JSONB vendor/evidence arrays. It is a SECURITY DEFINER function with a pinned search path, and **only** the separately isolated cbc_worker PostgreSQL role can execute it. The worker must first claim a job through migration 008's app_claim_scan_jobs; its lease token is a bearer capability and must never be logged or returned to a browser.

The function locks the matching outbox row, rechecks lease expiry, locks the tenant-bound scan, validates bounded JSONB provider/evidence arrays and final status, and atomically writes the scan, vendor results, evidence and outbox terminal acknowledgment. It derives organization_id exclusively from the locked outbox record, never from a caller-supplied tenant ID or session GUC. Missing, foreign, expired and replayed leases return false without writing. A failed insert, invalid payload, expired lease during completion or transaction rollback cannot commit a partial scan/evidence result. Terminal scans and immutable evidence remain protected by migration 005 triggers.

The same migration **revokes** cbc_app execution of app_record_fast_scan_result and app_mark_scan_processing, and revokes the separate app_ack_scan_job from cbc_worker. It also revokes any legacy validation-role result writer grant. Existing legacy web paths that invoke those functions are intentionally not supported after 009; do not route Azure scan traffic to those paths. The new Azure scan-create route can still enqueue pending jobs through app_create_scan.

## Validation

The pull-request workflow uses a freshly initialized loopback PostgreSQL 16 cluster and random temporary credentials. It first runs migrations 001–008 and the existing pre-hardening regression suites. Then it applies 009 and runs scripts/azure-data/validate-worker-completion-db.mjs against the **final** grants and schema. This tests worker-only privileges, stale/cross-tenant leases, JSON rejection, concurrency, one-shot completion, injected evidence strings, transaction rollback, and denied direct table mutation. The old suites run before 009 because they intentionally exercise legacy writer functions that 009 removes; this is a transitional test ordering, not a claim that those old write paths remain functional after 009.

## Cutover prerequisites (external approval required)

1. Independently review migrations 001–009 and the final grants against a fresh, disposable PostgreSQL cluster; do not apply to a persistent database without founder approval.
2. Provision a separate Azure managed identity and least-privileged cbc_worker PostgreSQL role with no inheritance or table DML; keep the worker identity inaccessible to the web app. Do not put the schema-owner connection in a runtime.
3. Implement a bounded Azure-native worker (timer-triggered Azure Functions or equivalent) using parameterized calls to claim and complete. It must not send scan inputs, lease tokens, provider credentials or raw evidence to logs. Enforce provider egress/SSRF controls, timeouts, retries, idempotent completion and dead-letter monitoring.
4. Before directing scan traffic, verify the **post-009** schema/grants, the web application's scan-create/read routes, end-to-end worker processing, RLS isolation, crash/retry behavior, and alerting. A pending scan without a functioning worker is not a complete scan experience.
5. Coordinate the old web result-writer shutdown with the migration: applying 009 before routing away from legacy result-writing routes will intentionally deny those writes. Do not dispatch workflows, provision Azure resources, change secrets or deploy without approval.

## Rollback / recovery

**Before cutover:** revert the draft branch or omit 009 from an unapproved deployment; no live state is touched. **After cutover:** an operator must stop new scan submissions and worker polling, preserve outbox and scan/evidence records, and reconcile ready/leased/terminal jobs. Do not automatically restore old cbc_app result-writer grants or run the legacy processor against the new outbox. Do not drop tables, delete pending work or replay paid provider requests automatically. Any production database rollback or recovery requires a separately approved, backed-up plan.

## Next coding action

Implement a provider-neutral Azure worker adapter that claims bounded batches and invokes the lease-bound completion function, with offline tests for duplicate delivery, timeouts, sanitized logging and safe failure/retry behavior.

## Provider-neutral worker core (draft)

`src/server/workers/azureScanWorker.ts` provides `runAzureScanWorkerBatch`, a pure
adapter for an Azure Functions timer or Container Apps job entrypoint. It accepts
an injected, **worker-role-only** PostgreSQL query executor and an injected
provider processor; it neither connects to Azure nor starts a job. The caller
must use a separate managed identity restricted to `cbc_worker`, with verified
PostgreSQL TLS and statement/connection timeouts. Never reuse the web role,
schema owner, or web pool.

Each invocation claims 1–10 leases using parameterized
`app_claim_scan_jobs`, validates canonical IDs and lease expiry, then
processes jobs sequentially under an abort signal and bounded deadline. The
provider receives only scan ID, input type, raw input and abort signal: **never
the lease token or database tenant context**. The adapter persists terminal
results only through `app_complete_scan_job` and treats an exact boolean
`false` as a lost/replayed lease, never as success. Claim/completion errors
are sanitized; optional telemetry receives only fixed event names, not
credentials, scan inputs, tokens or evidence. Malformed claim rows and
duplicate scan IDs are denied before processing.

**Important limits:** provider timeouts are cooperative. A processor MUST
honor `AbortSignal`, enforce its own egress allowlist and DNS/IP rebinding
protections, avoid SSRF and injection, and use bounded provider HTTP
timeouts. The adapter's timeout stops awaiting a provider; it cannot forcibly
cancel an external paid API request. Lease expiry means **at-least-once**
execution: duplicate provider calls are possible after a crash, timeout or
network failure even though database completion is one-shot. Use provider
idempotency keys (based on a stable scan ID) wherever supported; do not claim
exactly-once billing. Run with `batchSize: 1` initially so later jobs do not
lose their leases while an earlier job runs. Jobs exhausted after eight claims
require operator review; do not automatically delete or replay them.

Offline validation: `node --experimental-strip-types
scripts/azure-data/test-azure-scan-worker.ts`. This tests fake database and
provider behavior only, not Azure identity, actual HTTP providers, PostgreSQL
integration or a deployed timer. No infrastructure, secrets, persistent
database, deployment or workflow dispatch was changed by this code.

**Next coding action:** add a dedicated Azure worker runtime entrypoint with
verified-TLS managed-identity `cbc_worker` pool, a safe provider adapter and
Azure Functions/Container Apps job IaC; keep provisioning and deployment
behind founder approval.
