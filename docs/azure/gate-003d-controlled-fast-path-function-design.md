# Gate 003D - Controlled Fast-Path Function Design

> PLANNING DOCUMENT ONLY. No production execution is approved by this document.
> This gate designs the controlled fast-path database function required before
> app-code changes to `app/api/scan/route.ts`.
>
> This document does not create production roles, does not modify `cbc_prod`, does
> not move traffic, does not pause Supabase, and does not approve DNS/Azure app
> cutover.
>
> Branch: `audit/azure-current-state`
>
> Builds on:
>
> * Gate 002 production tenant isolation
> * Gate 003B disposable DB validation
> * Gate 003C complete scan experience alignment plan

## 1. Purpose

Gate 003D designs the controlled database write path needed for the hybrid scan
model approved in Gate 003C.

Gate 003C chose:

```text
Option C - Hybrid fast verdict + async deep scan
```

The API request path should preserve fast verdict UX without giving `cbc_app`
broad table grants.

Gate 003D therefore designs a narrow `SECURITY DEFINER` function that allows the
API request path to record a controlled fast-path result for a specific scan,
while keeping `cbc_app` unable to directly:

* update `scans`
* insert `vendor_results`
* insert `evidence_items`
* read `scan_cache`
* mutate `memberships`

## 2. Core security principle

The function will run as `SECURITY DEFINER`.

Therefore:

```text
Caller RLS is not enough.
The function must enforce tenant ownership internally.
```

The function must load the scan by `scan_id`, compare the scan's
`organization_id` to `app_current_org_id()`, and verify `app_current_user_id()`
is a member of that organization.

If any check fails, the function must refuse.

## 3. Working function name

Working name:

```text
app_record_fast_scan_result(...)
```

Final name may change during implementation, but the function must remain narrow
and purpose-specific.

It must not become a generic write gateway.

## 4. Proposed function responsibility

The function may perform only this controlled operation:

```text
For one same-org scan_id, record one fast-path provider result, controlled
evidence, audit entry, and allowed scan status/verdict transition.
```

The function must not:

* accept arbitrary organization IDs
* accept arbitrary user IDs
* accept arbitrary SQL fragments
* write for multiple scan IDs
* write provider/evidence rows unrelated to the scan
* overwrite already-final scans
* silently turn provider failures into safe verdicts
* bypass tenant checks because it is `SECURITY DEFINER`

## 5. Proposed input model

The function should accept a bounded typed payload. A possible shape:

```text
p_scan_id uuid
p_provider text
p_verdict text
p_score numeric
p_summary text
p_evidence jsonb
p_provider_status text
p_error_code text default null
p_error_message text default null
```

Implementation may choose separate typed arrays instead of `jsonb`, but the
principle is mandatory:

```text
Input must be bounded, validated, and purpose-specific.
```

## 6. Required input constraints

### scan_id

* required
* must exist
* must belong to `app_current_org_id()`
* must be visible by internal tenant check, not only caller RLS

### provider

* required
* must be a known/allowed fast-path provider name
* must be length-capped
* must not be arbitrary unbounded text

Example allowed provider names may include:

```text
google_web_risk
internal_fast_path
```

The final list must match actual implementation.

### verdict

Required allowed values:

```text
safe
suspicious
unknown
```

Rules:

* `safe` must be earned
* provider failure must not become `safe`
* insufficient evidence must become `unknown` or `suspicious`

### score/confidence

* numeric
* bounded
* recommended range: `0.00` to `1.00`
* null allowed only if verdict/failure semantics explicitly support it

### summary

* controlled plain-English summary
* length-capped
* must not expose raw provider JSON as the primary user experience

### evidence

Evidence payload must be capped and validated.

Required constraints:

* max evidence rows per fast-path write
* max evidence type length
* max evidence value length
* max evidence URL length
* max evidence details size
* no unlimited raw JSON blob accepted from API request path

The function may store structured evidence, but only after validating size and
shape.

### provider_status

Allowed values should be enumerated, such as:

```text
success
partial
timeout
error
skipped
```

Provider failure states must not produce `safe`.

## 7. Required internal checks

The function must perform these checks in this order or an equivalent safe order:

1. Read transaction-local app context:

   * `app_current_user_id()`
   * `app_current_org_id()`
2. Refuse if either context value is missing.
3. Load the scan row by `p_scan_id`.
4. Refuse if scan does not exist.
5. Refuse if scan `organization_id` does not equal `app_current_org_id()`.
6. Refuse if `app_current_user_id()` is not a member of the scan organization.
7. Lock the scan row for update.
8. Verify the scan is in a writable state.
9. Verify the provider/result has not already been recorded.
10. Validate bounded typed payload.
11. Apply allowed status/verdict transition.
12. Insert controlled provider result.
13. Insert controlled evidence rows.
14. Insert mandatory org-scoped audit log entry.
15. Return controlled result metadata.

## 8. Required scan state transitions

Gate 003D must define and test an allowed transition table.

Initial allowed transitions:

```text
pending -> processing
processing -> complete
processing -> failed
pending -> complete
pending -> failed
```

Potentially allowed only if deliberately designed:

```text
failed -> processing
failed -> complete
complete -> processing
complete -> failed
complete -> complete
```

Default rule:

```text
Already-final scans are not writable.
```

For Gate 003D, the recommended initial rule is:

* refuse `complete -> *`
* refuse `failed -> *`
* allow `pending -> complete`
* allow `pending -> failed`
* allow `processing -> complete`
* allow `processing -> failed`

No final result overwrite unless a later retry/reopen design explicitly approves
it.

## 9. Idempotency and double-write behavior

The function must prevent duplicate or inconsistent writes.

Required rules:

* same scan + same provider fast-path result can be written only once
* duplicate fast-path result must be refused or handled as idempotent no-op
* duplicate evidence rows must not be created
* retry behavior must be explicit
* double-submit must not corrupt scan state
* failed provider retry must not silently change verdict to `safe`

Recommended Gate 003D initial behavior:

```text
Refuse duplicate provider result for the same scan.
Return a clear error.
Do not overwrite existing result.
```

## 10. Partial-provider-failure behavior

Provider failure must be explicit.

Rules:

* timeout must not become `safe`
* provider error must not become `safe`
* partial provider signal must not become silently `safe`
* insufficient evidence must resolve to `unknown` or `suspicious`
* failure details must be captured in controlled fields
* user-facing result must explain limited confidence

Recommended mapping:

```text
provider_status = success + strong safe signal -> safe
provider_status = success + suspicious signal -> suspicious
provider_status = partial/timeout/error -> unknown or suspicious
provider_status = skipped -> unknown
```

## 11. Mandatory audit behavior

Every successful fast-path write must insert an org-scoped `audit_log` row.

Audit logging is mandatory.

Audit entry must include enough controlled metadata to answer:

* organization ID
* user ID
* scan ID
* provider/fast-path source
* previous scan status
* new scan status
* previous verdict
* new verdict
* timestamp/action

Relevant denied attempts should also be audit logged when safe and practical, but
successful fast-path writes are mandatory.

## 12. SECURITY DEFINER hardening

The function must:

* be `SECURITY DEFINER`
* be owned by privileged migration/database owner, not `cbc_app`
* set a locked `search_path`, preferably `public, pg_temp`
* schema-qualify table/function references
* avoid dynamic SQL
* avoid accepting table names, column names, or SQL fragments
* validate all inputs before writing
* return controlled output only
* grant `EXECUTE` only to intended runtime role
* not grant broad direct table privileges to `cbc_app`

## 13. Required disposable DB validation

Gate 003D must include a disposable DB validation script before app-code changes.

Target DB:

```text
cbc_003d_validation
```

The 003D validation must apply:

1. baseline schema
2. tenant isolation migration
3. 003D function migration/script
4. synthetic tenants/scans/results
5. validation matrix
6. cleanup

The validation must not run against `cbc_prod`.

## 14. Required validation tests

The disposable DB validation matrix must include at least:

### Database guard

* refuses outside `cbc_003d_validation`

### Function existence/security

* function exists
* function is `SECURITY DEFINER`
* function owner is not `cbc_app`
* function search path is locked
* `EXECUTE` grant is only to intended runtime role
* no broad direct table grants added to `cbc_app`

### Same-org success

* Org A context records fast result for Org A scan
* provider result inserted
* evidence inserted
* scan status/verdict updated through allowed transition
* audit_log row inserted

### Wrong-org scan_id refusal

Mandatory test:

```text
Org A context calls function with Org B scan_id.
Expected: refused internally.
```

This is the most important `SECURITY DEFINER` test.

### Missing context refusal

* no `app.current_user_id` refused
* no `app.current_organization_id` refused

### Non-member refusal

* user not member of scan org refused

### Already-complete refusal

* complete scan cannot be written again

### Duplicate provider result refusal

* same scan/provider double-write refused

### Illegal transition refusal

* final state overwrite refused
* illegal status jump refused

### Bounded payload refusal

* invalid verdict refused
* score below range refused
* score above range refused
* too many evidence rows refused
* oversized evidence fields refused
* unapproved provider refused

### Partial-provider failure behavior

* timeout cannot produce safe
* error cannot produce safe
* insufficient evidence becomes unknown/suspicious
* failure is captured in controlled result/evidence/audit fields

### Audit behavior

* successful fast-path write creates audit_log row
* audit_log is same-org scoped
* audit_log contains controlled metadata

### Cleanup

* validation roles/functions/test data removed or disposable DB dropped

## 15. App-code dependency

No app-code changes to:

```text
app/api/scan/route.ts
```

are approved until Gate 003D passes.

The route must not be changed to call a function that has not been designed and
validated.

## 16. Production boundary

Gate 003D does not approve:

* production function creation
* production role creation
* production app cutover
* DNS cutover
* Supabase pause
* traffic move
* Azure app deployment

Any production apply requires a later explicit gate.

## 17. Definition of done

Gate 003D is done only when:

* function design is documented
* SQL migration/script exists
* disposable DB validation script exists
* validation target is disposable only
* wrong-org scan_id test passes
* state transition tests pass
* idempotency/double-write tests pass
* bounded payload tests pass
* partial-provider-failure tests pass
* mandatory audit_log tests pass
* `cbc_app` direct grants remain narrow
* results are documented and committed
* second-eye review completed
* production remains untouched

## 18. Current recommendation

Proceed to implement Gate 003D in this order:

1. commit this design document
2. create 003D SQL migration/script for the controlled fast-path function
3. create 003D disposable validation scripts
4. run only against `cbc_003d_validation`
5. document results
6. only then approve app-code changes for Gate 003E
