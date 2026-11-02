# Gate 008A — transactional scan outbox and exhaustion recovery (draft)

Migration: `infra/db/migrations/008_scan_job_outbox.sql`, followed by
`009_worker_scan_completion.sql`. These are **draft code**, not proof that
Azure PostgreSQL has been initialized.

## Security and transaction contract

- `app_create_scan` inserts a tenant-bound pending scan; its `AFTER INSERT`
  trigger inserts exactly one outbox row in the same transaction. Rollback
  removes both.
- `cbc_app` cannot read or mutate the outbox or call worker functions.
  `cbc_worker` is a separate `NOINHERIT NOBYPASSRLS` non-owner role, with
  no direct scan, evidence or outbox table writes.
- Only `cbc_worker` may call `app_claim_scan_jobs(limit, lease_seconds)`.
  Claims use `FOR UPDATE SKIP LOCKED`, at most 10 jobs, 30–600-second
  leases, a fresh lease token and a maximum of eight attempts. The worker
  receives database-derived tenant metadata; browsers never see it.
- Migration 009 grants only `cbc_worker` the atomic
  `app_complete_scan_job` function. It checks the live lease and writes
  terminal scan status, vendor evidence and outbox completion in one
  transaction. Legacy separate acknowledgment and browser result-writing
  functions are revoked.
- Provider execution is **at least once**, not exactly once. A crashed
  worker can cause a repeated provider lookup; stale completion tokens
  cannot overwrite a terminal result.

## Exhausted-lease recovery

The eighth attempt is allowed to run until its lease expires. On a subsequent
worker claim, the restricted database function reconciles up to ten expired
eight-attempt jobs: it locks the job, marks its still-pending scan
`failed` with verdict `unknown`, and closes the outbox row atomically.
It never invents a safe verdict or fabricated threat evidence. A partial
index on exhausted leases keeps reconciliation bounded as the outbox grows.

This requires the scheduled worker to continue invoking claims. If the
scheduler stops, recovery stops too; production monitoring must alert on
missing worker runs, failed scans and aging pending jobs. Exhausted jobs
remain recorded for investigation and are not deleted.

## Verification

The read-only `data-plane-validate` PR workflow applies migrations
001–009 to a disposable loopback PostgreSQL 16 cluster, tests web/worker
role isolation, transactional enqueue/claim/completion, stale and replayed
leases, tenant-bound evidence, exhaustion, no premature expiry and
concurrent idempotent reconciliation. It does not access Azure or a paid
provider. A green run is evidence for that test environment only.

## Live deployment controls

The founder authorized the Azure hosting, Entra External ID and clean-start
PostgreSQL work on 2026-11-02, subject to verified target inventory, costs,
least-privilege identity mapping, TLS, Key Vault access, deployment review,
rollback planning and actual end-to-end tests. This code change does not
provision anything by itself. Do not use the web database role for worker
calls, deploy mutable image tags, or enable a billable reputation provider
without reviewing its configuration and spending.

Before cutover, validate the exact deployed PostgreSQL grants and RLS
catalog with both managed identities; test real customer login, URL
submission, scheduled claim, result/evidence retrieval, session revocation
and outage recovery. Keep Supabase and Inngest untouched until a separate
post-launch decision.
