# Gate 003E - Runtime Integration Plan

## 1. Gate status

**PLANNING ONLY. No implementation code has been written.** This document
defines how application runtime code will call
`public.app_record_fast_scan_result(...)`. No app code, no database
migrations, and no Azure resources are touched by this gate.

Dependency: Gate 003D Slice 1 (boundary-only fast-path function) is
**CLOSED / MERGED**. It landed on `master` at commit `b00a2b4` (squash merge
of PR #3, which included both the original implementation and the two
follow-up fixes from review: the `DO $grant$` block terminator correction
and the T08/T09/T10 hard-fail validation logic). Slice 1 is the frozen
foundation this gate plans against - Gate 003E does not modify it.

## 2. Purpose

Define, before any code is written, exactly how runtime/application code is
allowed to invoke `app_record_fast_scan_result`: what session context it must
establish, what it may and may not assume about authorization, how it handles
failure, and what stays explicitly out of scope. The goal is to fix the
contract on paper first, so the eventual implementation PR has no ambiguity
about the tenant-boundary rules.

## 3. Current foundation from Gate 003D

Slice 1, merged on `master` at `b00a2b4`, provides:

- `public.app_record_fast_scan_result(...)`, `SECURITY DEFINER`, with
  `search_path` locked to `public, pg_temp`.
- `EXECUTE` revoked from `PUBLIC`; conditionally granted to `cbc_app` only if
  that role exists in the target database.
- Internal authorization sequence: read `app.current_user_id` and
  `app.current_organization_id` from transaction-local GUCs, refuse if
  either is missing, load the scan row's `organization_id` without a lock,
  refuse if the scan does not exist, refuse if the scan's org does not
  match the context org, refuse if the caller is not a member of that org,
  only then take a `FOR UPDATE` lock on the row.
- **No writes.** Slice 1 performs no inserts/updates to `scans`,
  `vendor_results`, `evidence_items`, or `audit_log`. It returns the
  validated `p_scan_id` as a stub. Write behavior is a later slice, not part
  of 003E.
- Validation includes a hard database guard and hard-fail tenant-boundary
  behavior checks for T08/T09/T10. T01-T07 remain structural/security
  PASS/FAIL checks, and all checks passed locally against the disposable
  validation database.

Helper functions already available from Gate 003B/002:
`app_current_user_id()`, `app_current_org_id()`, `app_is_member(uuid)`,
`app_is_org_admin(uuid)`, `app_tenant_check(uuid)`,
`app_tenant_admin_check(uuid)`.

## 4. Runtime caller design

Proposed call sequence for the runtime layer (e.g. an API route such as
`app/api/scan/route.ts` - not yet touched by any gate):

1. Authenticate the incoming request through the existing auth layer.
2. Resolve `user_id` and `organization_id` server-side from verified session
   state (never from client-supplied request body fields).
3. Open a single database transaction using the runtime DB role (assumed to
   be `cbc_app` - see Section 6).
4. Inside that transaction, set both context GUCs transaction-locally
   (Section 5).
5. Call `app_record_fast_scan_result(...)` with the validated inputs
   (Section 7).
6. On success, commit; on exception, let the transaction roll back and map
   the error (Section 9).
7. Return a response to the caller without leaking internal tenant-boundary
   error text (Section 9).

The runtime layer is a thin caller around the DB function. It does not
duplicate the function's authorization logic as a gate to decide whether to
call it - it always calls it, and lets the function be the actual authority.

## 5. Required session context handling

Before calling the function, the runtime **must**, inside the same
transaction:

```sql
SELECT set_config('app.current_user_id', $1, true);
SELECT set_config('app.current_organization_id', $2, true);
```

`true` means transaction-local - this is required, not optional, because it
prevents context from leaking onto a pooled connection's next user.

Rules:

- `organization_id` is **never** passed as a function argument. It only
  ever reaches the function through the GUC. This is a hard design rule, not
  a style preference - the function's signature intentionally has no
  `organization_id` parameter (Gate 003D's T05 check enforces this at the DB
  level).
- Both values must come from server-verified session state, never trusted
  client input.
- Context must be set fresh on every call, inside the same transaction as the
  function call. It must never be cached, reused across requests, or assumed
  to persist on a connection between calls.
- **Connection pooling risk (flagged here, resolved in Section 14):** if the
  app's database client uses a pooler in transaction-pooling mode, each
  logical transaction must still get its own `set_config(..., true)` calls.
  A stale GUC value surviving onto a different tenant's reused connection
  would be a serious cross-tenant bug. This needs explicit verification
  against the actual pooling setup before implementation, not assumed safe.

## 6. DB role / privilege assumptions

- The runtime DB role is assumed to be `cbc_app` (the role Gate 003D's
  migration conditionally grants `EXECUTE` to). This role does not yet exist
  in disposable/local validation databases by design - its absence there is
  expected and handled by the migration's conditional grant.
- The runtime role must have `EXECUTE` on the function, must **not** be the
  function owner, must **not** have `BYPASSRLS`, and must **not** be a
  superuser. The function's `SECURITY DEFINER` elevation is only meaningful
  if the calling role is otherwise unprivileged.
- Whether `cbc_app` actually exists with the correct grant in any real
  non-disposable environment (dev, staging) is **not confirmed** by this
  document - it is listed as an open question (Section 14), not an
  assumption.

## 7. Inputs and validation rules

Required: `p_scan_id` (uuid, must reference an existing scan - enforced by
the function), `p_provider`, `p_provider_status`, `p_verdict`,
`p_risk_score`, `p_confidence_score`, `p_ai_explanation`,
`p_recommended_action`.

Optional: `p_scan_duration_ms`, the four parallel evidence arrays
(`p_evidence_signal_type`, `p_evidence_severity`, `p_evidence_title`,
`p_evidence_detail`, `p_evidence_score_impact`), `p_error_message`.

App-layer validation is **defense-in-depth, not authoritative**:

- Basic shape/type/range checks (e.g. `p_risk_score` within expected bounds,
  `p_verdict` in an allowed set, evidence arrays of equal length) should
  happen before the call, purely to fail fast with a clear app-level error
  instead of a confusing DB exception for malformed input.
- App-side checks must **never** be used to decide whether to skip or
  short-circuit the DB call. Even if app-side logic believes the request is
  same-tenant, the function call still happens and its refusal is still
  authoritative.

## 8. Transaction design

One short transaction per call:

```sql
BEGIN;
SELECT set_config('app.current_user_id', $1, true);
SELECT set_config('app.current_organization_id', $2, true);
SELECT app_record_fast_scan_result(...);
COMMIT;
-- or automatic ROLLBACK on exception
```

For Gate 003E scope, this should remain a single, short transaction wrapping
just the context-set + function call, not a larger transaction spanning
unrelated writes. If a future endpoint needs this call as one step among
several, that composition is a decision for that later work, not assumed
here.

## 9. Failure behavior

The function fails closed with `RAISE EXCEPTION` for: missing session
context, scan not found, cross-tenant access, caller not a member of the
scan's organization.

Runtime must:

- Catch these exceptions and map them to a response that does **not** leak
  the internal refusal message to the end client (e.g. log
  "cross-tenant scan access refused" server-side; return a generic,
  product-decided status to the caller - exact mapping is an open question,
  Section 14).
- Never automatically retry a call that failed due to a tenant-boundary
  refusal - retrying does not change authorization and risks masking a real
  bug or attack attempt.
- Handle transient DB/connection errors (not boundary refusals) using normal
  backend retry/error practice - a separate, unrelated concern from the
  tenant-boundary refusals above.

## 10. Logging/audit behavior

Gate 003D Slice 1 writes nothing to `audit_log` - that remains a later
slice's responsibility, not this gate's.

For Gate 003E, the runtime layer should define **app-level** logging only:
on each call, log scan_id, user_id, organization_id, timestamp, and
success/failure outcome server-side (not the raw DB exception text sent to
the client). This is distinct from, and not a substitute for, any future
DB-level `audit_log` writes that a later slice of the function may add.

## 11. Local validation plan

No live validation is performed by this planning document. Once an actual
implementation PR exists (separate from this one), validation should mirror
Gate 003D's approach:

- Disposable PostgreSQL instance only - never Azure, never `cbc_prod`.
- Run migrations 001-003 against it.
- Create a role mirroring the real runtime role's privileges (not the
  `cbc_app_validation` role used for DB-level slice validation - a role that
  matches what the actual app connection will use).
- Exercise the runtime caller code itself (not just raw SQL) against that
  disposable database, including negative cases (missing context,
  cross-tenant scan id) to confirm the app layer surfaces the DB's refusal
  correctly instead of masking or swallowing it.

## 12. Out of scope

- Any actual code changes to `app/api/scan/route.ts` or any other runtime
  file (a later, separate PR).
- Any change to the database migration or function itself - Slice 1 is
  merged and frozen for this gate; no write behavior (Slice 2) is designed
  or implemented here.
- Azure, `cbc_prod`, Key Vault, or any `cbcpgadmin` credential work. The
  credential mismatch noted earlier in this project remains separate and
  unresolved, and is not a dependency of this planning document.
- Any deploy.
- Connection pooler configuration changes - Section 5 identifies a risk that
  needs a decision, but configuring the pooler is not a deliverable of this
  gate.

## 13. Merge criteria

This document (not an implementation) is ready to merge when:

- All 14 sections are present and internally consistent with the design
  rules stated throughout (no `organization_id` parameter, transaction-local
  GUCs, DB function as sole tenant-boundary authority, app checks as
  defense-in-depth only).
- ChatGPT and the founder have both reviewed it, per the existing dual-review
  process.
- Every open question in Section 14 is either resolved inline or explicitly
  deferred with a noted owner before any implementation PR begins.
- No live database validation is required for this PR, since it contains no
  executable code.

## 14. Open questions

- What is the actual app-side auth/session provider, and how is
  `organization_id` derived server-side from it? Needs confirmation before
  implementation starts.
- Does the app's actual database client/pooling setup guarantee that
  `set_config(..., true)` is correctly scoped per logical transaction when
  using a pooled connection (e.g. a pooler running in transaction mode)?
  This is the single biggest risk identified in this plan and must be
  verified against the real stack before implementation.
- Does `cbc_app` actually exist with the correct `EXECUTE` grant in any real
  non-disposable environment today? Not confirmed by this document.
- When does Gate 003D Slice 2 (actual writes) land, and should the Gate 003E
  runtime caller be designed to anticipate an interface change, or should it
  only call the current stub and be revisited later?
- What HTTP-layer status/error contract does the frontend expect for each
  refusal type (not found vs. cross-tenant vs. missing context)? Product
  decision, not yet made.
- Where should app-side pre-validation (Section 7) live - route handler,
  shared service layer, or a schema validation library? Implementation
  detail, not a blocker for this planning document.
- The `cbcpgadmin` / Key Vault credential mismatch remains open and
  unresolved as a separate project-level item, unrelated to this gate.
