# Gate 003L - DB Function Write-Expansion Migration Plan

## 1. Gate purpose

This is a design-only migration planning gate for expanding
`public.app_record_fast_scan_result(...)` in a future migration gate.

The goal is to define how the function should eventually persist
fast-path scan results atomically after it validates transaction-local
tenant context. This gate does not create or edit migrations, does not
modify runtime code, does not create tests, does not wire `/api/scan`,
does not touch Azure, `cbc_prod`, Key Vault, deploy, or environment
files, and does not remove Supabase.

## 2. Background from Gates 003J and 003K

Gate 003J discovered that `public.app_record_fast_scan_result(...)` is
currently Gate 003D Slice 1 boundary-only. It validates
transaction-local user and organization context, checks scan ownership,
checks membership, locks the scan row after authorization, and returns
`p_scan_id`.

The current function does not yet persist fast-path result data to:

- `scans`
- `vendor_results`
- `evidence_items`
- audit tables

Gate 003K chose Option C: split database function write expansion and
route wiring into separate gates.

The planned sequence is:

- Gate 003L: DB function write-expansion migration plan.
- Gate 003M: disposable DB validation of the expanded function.
- Gate 003N: route wiring plan.
- Gate 003O: route wiring implementation.

Because the function is boundary-only today, the route must not be wired
to it as if persistence is complete.

## 3. Current function behavior

The current function is defined in
`infra/db/migrations/003_fast_path_function.sql`.

Current signature:

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
RETURNS uuid
```

Current behavior:

1. Reads `public.app_current_user_id()`.
2. Reads `public.app_current_org_id()`.
3. Fails closed if either context value is missing.
4. Loads the scan row by `p_scan_id` without locking.
5. Fails if the scan does not exist.
6. Fails if the scan organization does not match the transaction-local
   organization.
7. Fails if the transaction-local user is not a member of the scan
   organization.
8. Locks the scan row with `FOR UPDATE` after authorization succeeds.
9. Returns `p_scan_id`.

It performs no result, vendor, evidence, or audit writes today.

## 4. Planned expanded function responsibility

The expanded function should perform all fast-path completion writes
atomically inside one database transaction, after the existing tenant
boundary checks pass.

The function should:

- Keep transaction-local context validation.
- Keep scan ownership and membership checks.
- Keep `organization_id` out of the function arguments.
- Lock the scan row after authorization.
- Update the existing `scans` row.
- Insert related `vendor_results` rows.
- Insert related `evidence_items` rows.
- Defer audit writes unless a clear audit contract is approved.
- Return the validated `p_scan_id`.

The function remains the final tenant-boundary authority. App-side checks
remain defense-in-depth only.

## 5. Proposed write contract

The future expanded function should take a scan id and approved
non-tenant scan result data, validate tenant context, then write the
result as one unit.

The write contract should cover:

- Final scan status.
- Final verdict.
- Risk score.
- Confidence score.
- Optional AI explanation.
- Optional recommended action.
- Scan duration in milliseconds.
- One or more vendor result records.
- One or more evidence item records.
- Optional error information for provider failures.

The function must derive tenant scope from transaction-local GUCs only:

- `app.current_user_id`
- `app.current_organization_id`

`organization_id` must not be accepted as a function argument. The
function should stamp related child rows with the already-authorized scan
organization loaded from the locked scan row.

## 6. `scans` table update plan

After authorization and row locking, the expanded function should update
the existing `scans` row identified by `p_scan_id`.

Planned columns:

- `status`: likely `complete` for successful fast-path completion and
  possibly `failed` only if the function explicitly supports recording
  failed completion.
- `risk_score`: from approved non-tenant result input.
- `confidence_score`: from approved non-tenant result input.
- `verdict`: from approved non-tenant result input.
- `ai_explanation`: optional result input.
- `recommended_action`: optional result input.
- `scan_duration_ms`: optional duration input.
- `completed_at`: set by the database, preferably with `now()`.

The update must keep the tenant filter anchored to the authorized scan
row. It must not rely on client-provided organization identity.

## 7. `vendor_results` insert plan

The expanded function should insert `vendor_results` rows for provider
checks represented by the fast-path result.

Target columns from the current schema:

- `scan_id`
- `organization_id`
- `vendor_name`
- `verdict`
- `raw_response`
- `error_message`
- `response_time_ms`
- `checked_at`

`scan_id` should be `p_scan_id`. `organization_id` should be the
authorized scan organization loaded by the function, not a function
argument. `checked_at` can use the table default unless the migration plan
later approves an explicit timestamp source.

The future migration must define how raw provider response data is passed
and inserted. If structured provider arrays or JSONB are used, the
function must validate array lengths or JSON shape before inserting rows.

## 8. `evidence_items` insert plan

The expanded function should insert `evidence_items` rows for the
evidence generated by the fast path.

Target columns from the current schema:

- `scan_id`
- `organization_id`
- `signal_type`
- `severity`
- `title`
- `detail`
- `score_impact`
- `created_at`

`scan_id` should be `p_scan_id`. `organization_id` should be the
authorized scan organization loaded by the function, not a function
argument. `created_at` can use the table default.

The future migration must validate that evidence fields are internally
consistent. If arrays remain in the signature, all evidence arrays should
have matching lengths before any insert occurs.

## 9. Audit table decision

Audit writes should be explicitly deferred for this function expansion
unless current schema and prior gates prove a clear `audit_log` contract.

The current schema has `audit_log` with:

- `organization_id`
- `user_id`
- `action`
- `target_type`
- `target_id`
- `metadata`
- `ip_address`
- `created_at`

Gate 003L does not decide a final audit event shape. A future gate may add
audit writes only after it defines action names, metadata schema, user
identity handling, IP address handling, and validation expectations.

## 10. Function signature decision

The existing signature may not be sufficient for the current fast path.

The current function accepts one `p_provider` and one
`p_provider_status`, but the current route can run multiple fast providers
and writes one `vendor_results` row and one `evidence_items` row per
provider.

Recommended conservative migration plan:

- Do not add `organization_id`.
- Preserve transaction-local tenant context.
- Either expand the function signature to accept provider arrays or
  structured JSONB provider results, or explicitly limit the migration to
  one-provider behavior.
- Prefer a representation that can validate provider rows and evidence
  rows before any writes occur.
- Keep final SQL implementation out of this planning gate.

If arrays are used, the migration plan should define exact array length
checks. If JSONB is used, the migration plan should define required keys,
types, and failure behavior for malformed data.

## 11. Multi-provider handling decision

The current fast path can produce multiple provider results through
`getFastProviders(...)` and `Promise.allSettled(...)`.

Gate 003L recommends planning for multi-provider persistence rather than
pretending the route is single-provider. The expanded function should
support multiple vendor result rows and multiple evidence item rows in one
atomic call, unless a later decision explicitly narrows scope to a single
provider and keeps route behavior aligned with that limitation.

The migration plan must define how provider status, verdict, raw response,
error message, response time, and evidence fields map across multiple
providers without introducing tenant arguments.

## 12. Invalid target handling

The current route handles invalid targets by inserting one
`evidence_items` row with `signal_type = invalid_target`, completing the
scan with `risk_score = 0`, `confidence_score = 10`, and
`verdict = unknown`.

The expanded function should support this outcome if fast-path invalid
target completion is moved into the function. Gate 003L recommends
including invalid-target completion in the write contract so route wiring
does not need to retain a separate Supabase write path for that branch.

The future migration plan must decide whether invalid target writes use
the same provider/evidence representation or a separate explicit mode. In
both cases, tenant context must still come only from transaction-local
GUCs.

## 13. Provider error and partial-result handling

The current route treats provider failures as per-provider error results
and continues processing other providers. One provider failure does not
block all provider results.

The expanded function should preserve that persistence model:

- Successful provider checks can be inserted as normal vendor/evidence
  rows.
- Failed provider checks can be inserted with `verdict = error` or the
  approved equivalent, `error_message`, raw response if present, and
  response time.
- Overall scan verdict, risk score, and confidence score should be passed
  as already-calculated non-tenant inputs from the server-side route flow.

The function should not recalculate provider verdicts unless a later gate
explicitly moves scoring logic into the database. It should validate and
persist the approved result payload atomically.

## 14. Transaction and rollback behavior

All writes inside the expanded function must be atomic.

Expected behavior:

- Missing transaction-local user context fails before writes.
- Missing transaction-local organization context fails before writes.
- Missing scan row fails before writes.
- Cross-tenant scan access fails before writes.
- Non-member access fails before writes.
- Invalid function payload fails before writes.
- If the scan update succeeds but any vendor or evidence insert fails,
  the whole transaction rolls back.
- If any audit write is later added and fails, the whole transaction rolls
  back unless a future gate explicitly designs a different audit strategy.

Gate 003M must validate rollback by checking that no partial scan,
vendor, evidence, or audit changes remain after a forced failure.

## 15. Locking and concurrency behavior

The current function reads the scan row without a lock for authorization
checks, then locks the scan row with `FOR UPDATE` only after authorization
succeeds. This avoids locking a row the caller is not authorized to touch.

The expanded function should preserve that ordering:

1. Read transaction-local context.
2. Load scan organization by `p_scan_id` without lock.
3. Refuse missing or cross-tenant access.
4. Refuse non-member access.
5. Lock the authorized scan row with `FOR UPDATE`.
6. Perform all writes while holding the scan row lock.

Gate 003M should validate repeated or concurrent calls against the same
scan id. Gate 003L does not decide whether the expanded function is
idempotent; a future migration plan must decide whether existing child
rows are deleted, appended, rejected, or replaced on repeated calls.

## 16. Tenant/security invariants

These invariants are mandatory:

- `organization_id` must not be passed as a function argument.
- Client-supplied tenant input must not influence tenant context.
- User identity must come from authenticated server-side context.
- Organization identity must come from authenticated server-side context.
- User and organization identity must be set through transaction-local
  GUCs before the function call.
- The database function remains the final tenant-boundary authority.
- App-side checks are defense-in-depth only.
- `SUPABASE_SERVICE_ROLE_KEY` must not be used for the new function-call
  path.
- The function must fail closed if transaction-local context is missing.
- Cross-tenant scan access must fail.
- Non-member scan access must fail.
- All writes must roll back if any part fails.
- No Azure, no `cbc_prod`, no Key Vault, and no deploy work are part of
  this gate.

## 17. Required validation cases for Gate 003M

Gate 003M should validate the expanded function against disposable local
PostgreSQL.

Required cases:

- Valid context and valid payload updates `scans` to the expected final
  state.
- Valid context and valid payload inserts expected `vendor_results` rows.
- Valid context and valid payload inserts expected `evidence_items` rows.
- Invalid target payload records the approved unknown/invalid-target
  completion shape.
- Provider error payload records failed provider details without blocking
  other valid provider rows.
- Multiple provider results persist as multiple vendor and evidence rows.
- Missing `app.current_user_id` fails closed.
- Missing `app.current_organization_id` fails closed.
- Cross-tenant scan access fails.
- Non-member scan access fails.
- `organization_id` is absent from the function argument list.
- Malformed arrays or JSONB payload fail before writes.
- Forced failure after scan update rolls back scan, vendor, evidence, and
  audit writes.
- Repeated or concurrent calls have the behavior decided by the migration
  plan.
- Transaction-local GUCs do not leak across transactions.

## 18. Explicit non-goals

This gate does not:

- Modify `app/api/scan/route.ts`.
- Modify `src/server/db/postgres.ts`.
- Modify `package.json`, `package-lock.json`, or `tsconfig.json`.
- Modify migrations.
- Create implementation code.
- Create tests.
- Call `public.app_record_fast_scan_result(...)`.
- Wire `/api/scan`.
- Change route behavior.
- Remove existing Supabase writes.
- Remove Supabase.
- Use `SUPABASE_SERVICE_ROLE_KEY` for any new function-call path.
- Touch Azure, `cbc_prod`, Key Vault, deploy, or environment files.

## 19. Acceptance criteria

This gate is accepted when:

- `docs/gates/gate-003l-db-function-write-expansion-plan.md` exists.
- The document states that the current
  `public.app_record_fast_scan_result(...)` is boundary-only.
- The document states that the current function does not yet persist to
  `scans`, `vendor_results`, `evidence_items`, or audit tables.
- The document plans an expanded function that performs all fast-path
  completion writes atomically in one database transaction.
- The document says `organization_id` must not be passed as a function
  argument.
- The document says user and organization identity come from
  authenticated server-side context and transaction-local GUCs.
- The document says the database function remains the final
  tenant-boundary authority.
- The document says app-side checks are defense-in-depth only.
- The document says `SUPABASE_SERVICE_ROLE_KEY` must not be used for the
  new function-call path.
- The document defers audit writes unless a clear audit contract is
  approved.
- The document calls out the existing one-provider signature versus the
  current multi-provider route behavior as a design issue.
- The document recommends either provider arrays or structured JSONB, or
  an explicit one-provider scope limit, without inventing final SQL.
- The document states no migrations, no runtime code changes, no tests,
  no route wiring, no Azure, no `cbc_prod`, no Key Vault, and no deploy in
  this gate.
- No forbidden files are modified.
- No commit is created.
