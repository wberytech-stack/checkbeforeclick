# Gate 003K - Fast Scan Persistence Scope Decision

## 1. Gate purpose

This is a design-only scope decision gate. Its purpose is to choose the
safe next path after Gate 003J discovery, before any migration, route
wiring, runtime code, tests, Azure work, `cbc_prod` work, Key Vault work,
deploy work, or environment changes.

This gate creates only this document. It does not modify
`app/api/scan/route.ts`, does not modify `src/server/db/postgres.ts`, does
not change package files, does not change migrations, and does not create
implementation code.

## 2. Background from Gate 003J

Gate 003J discovered that
`public.app_record_fast_scan_result(...)` is currently Gate 003D Slice 1
boundary-only.

The current function:

- Reads transaction-local `app.current_user_id`.
- Reads transaction-local `app.current_organization_id`.
- Checks that both context values are present.
- Checks that the scan exists.
- Checks that the scan belongs to the transaction-local organization.
- Checks that the transaction-local user is a member of that
  organization.
- Locks the scan row after authorization succeeds.
- Returns `p_scan_id`.

The current function does not yet persist fast-path result data to:

- `scans`
- `vendor_results`
- `evidence_items`
- audit tables

Because the function is boundary-only, `/api/scan` must not be wired to
this function as if persistence is complete.

## 3. Options considered

Option A: Expand DB function first

Expand `public.app_record_fast_scan_result(...)` in a new migration gate
so it performs the needed fast-path persistence writes inside the database
function before route wiring begins.

This would move the database side forward first, but it still needs
careful scope definition and disposable database validation before route
behavior changes.

Option B: Call boundary-only function as validation only

Add a narrow runtime adapter that calls the current boundary-only function
only as an authorization and transaction-context validation step, while
leaving existing Supabase writes unchanged for now.

This could validate the transaction path earlier, but it risks adding a
runtime call that looks like persistence even though the function does not
write scan, vendor, evidence, or audit data.

Option C: Split DB function expansion and route wiring into separate gates

First plan the database function write expansion, then validate the
expanded function against disposable PostgreSQL, then plan route wiring,
then implement route wiring.

This separates database behavior, validation, route design, and runtime
behavior changes into auditable gates.

## 4. Decision: Option C

Gate 003K chooses Option C.

The safe next path is to split database function write expansion and route
wiring into separate gates:

- Gate 003K: this scope decision document.
- Gate 003L: DB function write-expansion migration plan.
- Gate 003M: disposable DB validation of the expanded function.
- Gate 003N: route wiring plan.
- Gate 003O: route wiring implementation.

## 5. Why Option C is safest

Option C is safest because it prevents the route from depending on a
database function that does not yet perform the required persistence.

It keeps each risk area isolated:

- Gate 003L can design the database write behavior without changing route
  behavior.
- Gate 003M can prove the expanded database function in a disposable
  database before runtime wiring.
- Gate 003N can plan the route integration after the database behavior is
  known and validated.
- Gate 003O can implement the route wiring only after the function writes
  are complete, validated, and scoped.

This avoids bundling migration design, migration implementation,
validation, route planning, and route behavior changes into one large
gate.

## 6. Explicit rejection of premature route wiring

Do not replace the current fast-path write path with
`public.app_record_fast_scan_result(...)` until the function actually
writes the needed scan, vendor, evidence, and audit data and that expanded
behavior has been validated.

Do not call the current boundary-only function and assume persistence
happened.

The current function can prove tenant context and authorization, but it
does not complete the fast-path persistence contract. Treating its current
return value as a completed write would be incorrect.

## 7. Required future gate sequence

The required sequence is:

1. Gate 003K: decide scope and sequencing.
2. Gate 003L: plan the database function write expansion.
3. Gate 003M: validate the expanded function against disposable
   PostgreSQL.
4. Gate 003N: plan route wiring to the validated expanded function.
5. Gate 003O: implement route wiring.

Route wiring must not start before the write-expanded function is planned
and validated.

## 8. What Gate 003L must decide

Gate 003L must decide the database-side write expansion plan for
`public.app_record_fast_scan_result(...)`.

It must define:

- Which columns in `scans` the function updates.
- How `vendor_results` rows are inserted.
- How `evidence_items` rows are inserted.
- Whether audit table writes are in scope for the expansion.
- How provider, verdict, risk, confidence, duration, evidence arrays, and
  error fields map to database writes.
- How the function handles invalid targets, provider errors, partial
  provider results, and empty evidence arrays.
- Whether the existing function signature is sufficient or must change
  without adding `organization_id`.
- The lock ordering and rollback behavior for all writes.
- The migration safety plan and rollback plan.

Gate 003L must not wire `/api/scan` and must not touch Azure,
`cbc_prod`, Key Vault, deploy, or environment files.

## 9. What Gate 003M must validate

Gate 003M must validate the expanded function against disposable local
PostgreSQL before route wiring.

It must prove:

- Success writes the expected `scans`, `vendor_results`, and
  `evidence_items` data.
- Any audit writes, if included by Gate 003L, occur correctly.
- Missing transaction-local user context fails closed.
- Missing transaction-local organization context fails closed.
- Cross-tenant scan access is refused.
- Non-member access is refused.
- `organization_id` is not passed as a function argument.
- A thrown database error rolls back all function writes.
- Transaction-local GUC values do not leak across transactions or pooled
  client reuse.
- The function remains the final tenant-boundary authority.

Gate 003M must use disposable validation only unless a later gate
explicitly authorizes another environment.

## 10. What Gate 003N must plan

Gate 003N must plan the route wiring after the expanded database function
has been validated.

It must decide:

- The exact route touchpoints in `app/api/scan/route.ts`.
- Whether a server-only adapter is added under `src/server/scan/` or
  another server-only location.
- How the route maps provider results to approved non-tenant function
  arguments.
- How the route obtains `userId` and `organizationId` from authenticated
  server-side context.
- How `withPgTransaction` sets transaction-local GUCs before the function
  call.
- The route runtime requirement for Node.js `pg` usage.
- Error response mapping for database function failures.
- Which existing Supabase writes are removed or retained in the final
  wiring.

Gate 003N must remain a design/plan gate unless explicitly scoped
otherwise.

## 11. What Gate 003O may implement

Gate 003O may implement route wiring only after Gates 003L, 003M, and
003N are complete.

Gate 003O may:

- Add the approved server-only runtime adapter.
- Use `withPgTransaction` to set transaction-local
  `app.current_user_id`.
- Use `withPgTransaction` to set transaction-local
  `app.current_organization_id`.
- Call the validated expanded `public.app_record_fast_scan_result(...)`
  with approved non-tenant arguments.
- Update `app/api/scan/route.ts` according to the Gate 003N plan.
- Add focused tests or validation artifacts if approved in Gate 003N.

Gate 003O must not pass `organization_id` as a function argument and must
not use `SUPABASE_SERVICE_ROLE_KEY` for the new function-call path.

## 12. Tenant/security invariants

These invariants apply to all future gates:

- `organization_id` must not be passed as an argument to
  `public.app_record_fast_scan_result(...)`.
- User identity must come from authenticated server-side context.
- Organization identity must come from authenticated server-side context.
- User and organization identity must be set for the database function
  through transaction-local GUCs.
- The required context sequence is
  `set_config('app.current_user_id', ..., true)`,
  `set_config('app.current_organization_id', ..., true)`, then
  `public.app_record_fast_scan_result(...)` in one transaction.
- The database function remains the final tenant-boundary authority.
- App-side checks are defense-in-depth only.
- Client-trusted tenant input must not influence tenant context.
- `SUPABASE_SERVICE_ROLE_KEY` must not be used for the new function-call
  path.
- No Azure, no `cbc_prod`, no Key Vault, and no deploy work are part of
  this gate.

## 13. Non-goals

This gate does not:

- Modify `app/api/scan/route.ts`.
- Modify `src/server/db/postgres.ts`.
- Modify `package.json`, `package-lock.json`, or `tsconfig.json`.
- Modify migrations.
- Create implementation code.
- Create tests.
- Call `public.app_record_fast_scan_result(...)`.
- Wire `withPgTransaction` into runtime behavior.
- Change route behavior.
- Remove Supabase.
- Use `SUPABASE_SERVICE_ROLE_KEY` for any new path.
- Touch Azure, `cbc_prod`, Key Vault, deploy, or environment files.

## 14. Acceptance criteria

This gate is accepted when:

- `docs/gates/gate-003k-fast-scan-persistence-scope-decision.md` exists.
- The document clearly states that the current
  `public.app_record_fast_scan_result(...)` is boundary-only.
- The document clearly states that the current function does not yet
  persist to `scans`, `vendor_results`, `evidence_items`, or audit tables.
- The document chooses Option C.
- The document defines Gates 003L, 003M, 003N, and 003O as separate future
  gates.
- The document explicitly rejects replacing current fast-path writes with
  the function until write expansion is complete and validated.
- The document states that `organization_id` must not be passed as a
  function argument.
- The document states that user and organization identity must come from
  authenticated server-side context and transaction-local GUCs.
- The document states that the database function remains the final
  tenant-boundary authority.
- The document states that app-side checks are defense-in-depth only.
- The document states that `SUPABASE_SERVICE_ROLE_KEY` is not used for the
  new function-call path.
- The document states no Azure, no `cbc_prod`, no Key Vault, no deploy, no
  migrations, and no runtime code changes occur in this gate.
- No forbidden files are modified.
- No commit is created.
