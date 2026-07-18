# Gate 003M - DB Function Write-Expansion Migration Draft

## 1. Gate purpose

Create a conservative migration draft that expands
`public.app_record_fast_scan_result(...)` so it can atomically persist
fast-path scan results after tenant-boundary validation passes.

This gate produces a draft migration only. It does not apply the migration
to any real database. Disposable local PostgreSQL validation happens in
Gate 003N.

## 2. Files changed

- `infra/db/migrations/004_fast_path_function_write_expansion.sql`
  (new file, draft migration)
- `docs/gates/gate-003m-db-function-write-expansion-migration-draft.md`
  (this note)

No existing migration files, runtime code, package files, or route files
are modified.

## 3. Function signature chosen

Old signature (Gate 003D Slice 1, 15 parameters):

```sql
public.app_record_fast_scan_result(
    p_scan_id               uuid,
    p_provider              text,
    p_provider_status       text,
    p_verdict               text,
    p_risk_score            integer,
    p_confidence_score      integer,
    p_ai_explanation        text,
    p_recommended_action    text,
    p_scan_duration_ms      integer    DEFAULT NULL,
    p_evidence_signal_type  text[]     DEFAULT '{}',
    p_evidence_severity     text[]     DEFAULT '{}',
    p_evidence_title        text[]     DEFAULT '{}',
    p_evidence_detail       text[]     DEFAULT '{}',
    p_evidence_score_impact integer[]  DEFAULT '{}',
    p_error_message         text       DEFAULT NULL
)
```

New signature (Gate 003M, 11 parameters):

```sql
public.app_record_fast_scan_result(
    p_scan_id               uuid,
    p_status                text,
    p_verdict               text,
    p_risk_score            integer,
    p_confidence_score      integer,
    p_ai_explanation        text,
    p_recommended_action    text,
    p_scan_duration_ms      integer  DEFAULT NULL,
    p_vendor_results        jsonb    DEFAULT '[]'::jsonb,
    p_evidence_items        jsonb    DEFAULT '[]'::jsonb,
    p_error_message         text     DEFAULT NULL
)
```

`organization_id` is not present in either signature. It is never a
function argument.

Because the parameter list changes, the migration explicitly drops the old
15-parameter function before creating the new 11-parameter function.

## 4. Why JSONB was chosen

The old signature used per-provider parallel text arrays. The current
scan route (`app/api/scan/route.ts`) runs multiple fast providers via
`getFastProviders(...)` and `Promise.allSettled(...)`, producing one
vendor result and potentially multiple evidence items per provider. The
old single-provider parallel-array shape does not fit that multi-provider
model without either multiple function calls (breaking atomicity) or
unbounded parallel arrays (harder to validate before writes).

JSONB arrays allow:

- One function call for all providers atomically.
- Per-element shape validation (each element must be a JSON object)
  before any row is inserted.
- Required field and type validation per element before any write.
- Natural extension to additional optional fields per provider or
  evidence item without changing the function signature.

The downside is that JSONB is less strongly typed than parallel arrays at
the SQL layer. This is mitigated by the explicit per-element validation
loop inside the function body: each element is confirmed to be a JSON
object, required fields are checked for presence and non-emptiness,
allowed enum values are enforced, and optional numeric fields are
validated as integers before any write statement executes.

## 5. Tenant/security behavior

- `SECURITY DEFINER` is preserved.
- `SET search_path = public, pg_temp` is preserved.
- Tenant context comes only from transaction-local GUCs:
  `app_current_user_id()` and `app_current_org_id()`.
- `organization_id` is not a function argument.
- Client-supplied tenant input cannot influence tenant context.
- The function fails closed before any writes for:
  - Missing `app.current_user_id`.
  - Missing `app.current_organization_id`.
  - Scan not found.
  - Scan organization does not match context organization.
  - Caller is not a member of the scan organization.
  - Scan already in a final state (complete or failed) at lock time.
  - Invalid p_status (must be complete or failed).
  - Invalid verdict, score range, JSONB shape, required fields, object
    type per element, severity enum, or non-integer optional numerics.
- `organization_id` on inserted `vendor_results` and `evidence_items`
  rows is stamped from `v_scan_org` (loaded from the locked scan row by
  the function), never from any function argument.
- The scan UPDATE WHERE clause includes both `id = p_scan_id` and
  `organization_id = v_scan_org` for tenant anchoring.
- The database function remains the final tenant-boundary authority.
  App-side checks are defense-in-depth only.
## 6. Idempotency and one-shot completion rule

This function is one-shot. After locking the scan row with `FOR UPDATE`,
the function reads the current `status` from the locked row. Writes are
only permitted when the locked status is `pending` or `processing`. If the
locked status is already `complete` or `failed`, the function raises an
exception before any writes occur.

This is the Gate 003M idempotency decision: repeated calls after a scan
is in a final state are rejected rather than silently creating duplicate
`vendor_results` or `evidence_items` rows. Concurrent second calls are
also blocked by the same row lock and status check.

The lock and status read are combined in one statement:

```sql
SELECT s.status
  INTO v_locked_status
  FROM public.scans s
 WHERE s.id = p_scan_id
   AND s.organization_id = v_scan_org
   FOR UPDATE;
```

This ensures the status check and the lock are atomic. If the row is not
found under this tenant at lock time, the function fails closed.

## 7. p_status restriction

`p_status` is restricted to `complete` or `failed` only. This function
is for fast-path terminal completion. Setting `pending` or `processing`
while also writing `completed_at = now()` is not meaningful and is
explicitly rejected before any writes.

## 8. Write behavior

Lock order:

1. Read transaction-local user and organization context.
2. Load scan organization by `p_scan_id` without a lock (auth check).
3. Reject missing scan, cross-tenant access, non-member access.
4. Lock the authorized scan row with `FOR UPDATE` and read current status.
5. Reject if locked status is already `complete` or `failed`.
6. Validate payload: p_status, p_verdict, scores, null checks, JSONB
   array types, per-element object types, required fields, severity enum,
   optional integer fields.
7. Update `scans` row to final state.
8. Insert `vendor_results` rows (one per entry in `p_vendor_results`).
9. Insert `evidence_items` rows (one per entry in `p_evidence_items`).

Payload validation before writes also covers:

- `p_scan_duration_ms`: NULL is allowed. If present, must be >= 0.
  Negative values are rejected before any write.
- `p_error_message`: accepted in the signature for future compatibility
  and failed-scan context. This migration does not write `p_error_message`
  to the `scans` table because the current `scans` schema has no overall
  `error_message` column. Per-provider errors are persisted through
  `vendor_results.error_message`.

Writes:

- `scans`: updates `status`, `verdict`, `risk_score`, `confidence_score`,
  `ai_explanation`, `recommended_action`, `scan_duration_ms`,
  `completed_at` (set to `now()`). WHERE clause: `id = p_scan_id AND
  organization_id = v_scan_org`. `p_error_message` is not written here.
- `vendor_results`: inserts one row per object in `p_vendor_results`.
  Fields: `scan_id`, `organization_id` (from `v_scan_org`),
  `vendor_name`, `verdict`, `raw_response`, `error_message`,
  `response_time_ms`, `checked_at` (set to `now()`).
- `evidence_items`: inserts one row per object in `p_evidence_items`.
  Fields: `scan_id`, `organization_id` (from `v_scan_org`),
  `signal_type`, `severity`, `title`, `detail`,
  `score_impact` (defaults to 0 if absent), `created_at` (set to `now()`).

## 9. Rollback behavior

All writes are inside the caller's transaction. If any write fails, the
entire transaction rolls back. No partial state (scan updated but vendor
rows missing, or some vendor rows inserted but evidence rows missing) is
possible. The caller's `withPgTransaction` helper issues `ROLLBACK` on
any exception, which covers all writes in this function.

Validation failures and one-shot rejection before writes also cause the
caller transaction to roll back, since they raise exceptions.

## 10. Audit decision

No `audit_log` writes in this migration. Deferred to a future gate after
the audit event shape, action names, metadata schema, user identity
handling, IP address handling, and validation expectations are decided.

The `audit_log` table exists in the schema with columns: `organization_id`,
`user_id`, `action`, `target_type`, `target_id`, `metadata`, `ip_address`,
`created_at`. None of these are written by this migration.

## 11. Grant model

EXECUTE is revoked from PUBLIC. Two conditional grants are issued:

- `cbc_app`: the production runtime role. Granted if the role exists.
- `cbc_app_validation`: the disposable validation role used in Gate 003N,
  matching the pattern established in Gate 003D validation (T07). Granted
  if the role exists.

Both grants are conditional so the migration runs safely on disposable
databases that may have only one or neither role present.

## 12. Non-goals

This gate does not:

- Apply the migration to any real database, Azure server, or `cbc_prod`.
- Modify `app/api/scan/route.ts`.
- Modify `src/server/db/postgres.ts`.
- Modify `lib/data/index.ts`.
- Modify any existing migration file.
- Modify `package.json`, `package-lock.json`, or `tsconfig.json`.
- Create tests or validation scripts (Gate 003N).
- Wire `/api/scan` to the expanded function.
- Remove Supabase or existing Supabase write paths.
- Use `SUPABASE_SERVICE_ROLE_KEY` for any new function-call path.
- Touch Azure, Key Vault, deploy, or environment files.
## 13. Required Gate 003N disposable validation cases

Gate 003N must validate the expanded function against disposable local
PostgreSQL with migrations 001-004 applied. The validation role is
`cbc_app_validation`, created by the Gate 003N script and granted EXECUTE
by migration 004 if present.

Required cases:

1. Valid context and valid payload: scans row updated to expected final state.
2. Valid context and valid payload: vendor_results rows inserted correctly.
3. Valid context and valid payload: evidence_items rows inserted correctly.
4. Multiple providers: multiple vendor_results and evidence_items rows
   inserted in one call.
5. Empty p_vendor_results array: no vendor_results inserted, scan still updated.
6. Empty p_evidence_items array: no evidence_items inserted, scan still updated.
7. Missing app.current_user_id: fails closed before any writes.
8. Missing app.current_organization_id: fails closed before any writes.
9. Cross-tenant scan id: fails closed before any writes.
10. Non-member access: fails closed before any writes.
11. organization_id absent from function argument list (T05 equivalent).
12. p_status 'complete' accepted.
13. p_status 'failed' accepted.
14. p_status 'pending' rejected before writes.
15. p_status 'processing' rejected before writes.
16. Invalid verdict value: fails before writes.
17. risk_score out of range: fails before writes.
18. confidence_score out of range: fails before writes.
19. p_scan_duration_ms negative: fails before writes.
20. p_vendor_results NULL: fails before writes.
21. p_evidence_items NULL: fails before writes.
22. p_vendor_results not a JSON array: fails before writes.
23. p_evidence_items not a JSON array: fails before writes.
24. Vendor entry that is not a JSON object: fails before writes.
25. Evidence entry that is not a JSON object: fails before writes.
26. Vendor object missing vendor_name: fails before writes.
27. Evidence object missing signal_type: fails before writes.
28. Evidence object missing title: fails before writes.
29. Evidence object invalid severity: fails before writes.
30. Non-integer response_time_ms in vendor entry: fails before writes.
31. Non-integer score_impact in evidence entry: fails before writes.
32. Forced failure after scan UPDATE: full transaction rolls back, no
    vendor_results or evidence_items rows persist.
33. Repeated call after scan is complete: rejected, no duplicate child rows.
34. Repeated call after scan is failed: rejected, no duplicate child rows.
35. Concurrent second call: blocked by row lock and status check, cannot
    create duplicate child rows.
36. Transaction-local GUCs do not leak across transactions.
37. SECURITY DEFINER confirmed in pg_proc.
38. EXECUTE revoked from PUBLIC.
39. EXECUTE granted to cbc_app_validation role.
40. search_path locked to public, pg_temp.
## 14. Acceptance criteria

This gate is accepted when:

- `infra/db/migrations/004_fast_path_function_write_expansion.sql` exists
  as a new file (not a modification of any existing migration).
- The migration drops the old 15-parameter signature explicitly before
  creating the new 11-parameter signature.
- The new signature does not include `organization_id` as a parameter.
- The migration preserves `SECURITY DEFINER` and `SET search_path`.
- The lock reads the current status and fails if already complete or failed.
- The scan UPDATE WHERE clause includes both id and organization_id.
- p_status is restricted to complete or failed only.
- The migration validates p_vendor_results and p_evidence_items are
  non-null JSON arrays before any writes.
- The migration validates each element is a JSON object before any writes.
- The migration validates optional numeric fields as integers before
  any writes.
- The migration validates p_scan_duration_ms is >= 0 if not NULL before
  any writes.
- The migration does not write p_error_message to scans (no such column
  in the current schema); per-provider errors go to vendor_results.
- The migration validates payload before any writes.
- The migration updates `scans`, inserts `vendor_results`, and inserts
  `evidence_items` in lock-order-correct sequence.
- The migration does not write to `audit_log`.
- The migration revokes EXECUTE from PUBLIC and conditionally grants to
  both `cbc_app` and `cbc_app_validation`.
- No existing migration files are modified.
- No runtime code, package files, or route files are modified.
- No commit is created in this gate.
- Gate 003N validation cases are documented above.
