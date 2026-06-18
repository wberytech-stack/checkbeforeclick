# Gate 003D - Controlled Fast-Path Function Design

> PLANNING DOCUMENT ONLY. No production execution is approved by this document.
> This gate designs the controlled fast-path database function required before
> app-code changes to `app/api/scan/route.ts`.
>
> This document does not create production roles, does not modify `cbc_prod`,
> does not move traffic, does not pause Supabase, and does not approve DNS/Azure
> app cutover.
>
> Branch: `audit/azure-current-state`
>
> Builds on:
>
> * Gate 002 production tenant isolation
> * Gate 003B disposable DB validation
> * Gate 003C complete scan experience alignment plan
> * Gate 003D second-eye review

## 1. Purpose

Gate 003D designs the controlled database write path needed for the hybrid scan
model approved in Gate 003C.

Gate 003C chose:

```text
Option C - Hybrid fast verdict + async deep scan
```

The API request path should preserve fast verdict UX without giving `cbc_app`
broad table grants.

Gate 003D therefore designs one narrow, atomic `SECURITY DEFINER` function that
allows the API request path to record a controlled fast-path result for a
specific scan while keeping `cbc_app` unable to directly:

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

## 3. Atomic function decision

Gate 003D will use one atomic function, not multiple split functions.

Working name:

```text
app_record_fast_scan_result(...)
```

Reason:

```text
Atomicity of org-check + lock + write + audit is a security feature.
```

The function must perform the tenant check, writable-state check, provider/result
write, evidence write, scan transition, idempotency decision, and audit write in
one controlled database transaction scope.

It must not be split into separate helper functions that could be called out of
order or reused as unsafe write primitives.

Internal helper functions may be considered only if they are private,
non-executable by `cbc_app`, and do not create a second public write path.

## 4. Proposed function responsibility

The function may perform only this controlled operation:

```text
For one same-org scan_id, record one fast-path provider result, controlled
evidence, mandatory audit entry, and allowed scan status/verdict transition.
```

The function must not:

* accept caller-supplied organization IDs
* accept caller-supplied user IDs
* accept arbitrary SQL fragments
* write for multiple scan IDs
* write provider/evidence rows unrelated to the scan
* overwrite already-final scan verdicts with conflicting values
* silently turn provider failures into safe verdicts
* rely on caller RLS because it is `SECURITY DEFINER`
* become a generic write gateway

## 5. Tenant selector rule

The function signature must not include `organization_id`.

The only tenant/data selector supplied by the caller is:

```text
p_scan_id uuid
```

The organization is derived internally from the scan row and compared against:

```text
app_current_org_id()
```

The user is derived internally from:

```text
app_current_user_id()
```

This prevents the API request path from smuggling or spoofing tenant context
through a caller-supplied organization value.

## 6. Proposed typed input model

The function should use typed parameters and a bounded typed evidence array.

It should not accept open-ended `jsonb` evidence from the API request path.

Reason:

```text
Typed parameters make the database enforce the narrow-write property.
Open jsonb moves too much validation into handwritten function logic.
```

A possible function shape:

```text
p_scan_id uuid
p_provider text
p_provider_status text
p_verdict text
p_score numeric
p_summary text
p_evidence_type text[]
p_evidence_value text[]
p_evidence_url text[]
p_evidence_details text[]
p_error_code text default null
p_error_message text default null
```

Implementation may refine the exact shape, but the rule is mandatory:

```text
Use typed, bounded parameters.
Do not accept open arbitrary jsonb as the API fast-path payload.
```

If evidence is modeled as arrays, all arrays must have matching lengths and a
strict maximum row count.

## 7. Required input constraints

### scan_id

* required
* must exist
* must belong to `app_current_org_id()`
* must be checked internally by the function
* must not rely only on caller RLS

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

The final allowed list must match actual implementation.

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

### evidence arrays

Evidence arrays must be capped and validated.

Required constraints:

* all evidence arrays must have matching length
* max evidence rows per fast-path write
* max evidence type length
* max evidence value length
* max evidence URL length
* max evidence details length
* no unlimited raw JSON blob accepted from API request path

Malformed evidence shape must fail closed.

## 8. Required internal checks

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
8. Validate bounded typed payload.
9. Evaluate current scan status/verdict.
10. Evaluate existing provider result for idempotency or conflict.
11. Verify the requested transition is allowed.
12. Insert or return existing controlled provider result.
13. Insert controlled evidence rows if this is a first write.
14. Apply allowed scan status/verdict transition if this is a first write.
15. Insert mandatory org-scoped audit log entry.
16. Return controlled result metadata.

## 9. SECURITY DEFINER hardening

The function must:

* be `SECURITY DEFINER`
* be owned by privileged migration/database owner, not `cbc_app`
* include a literal locked search path clause
* schema-qualify table/function references
* avoid dynamic SQL
* avoid accepting table names, column names, or SQL fragments
* validate all inputs before writing
* return controlled output only
* not grant broad direct table privileges to `cbc_app`

Required literal function clause:

```sql
SECURITY DEFINER
SET search_path = public, pg_temp
```

Required grant hardening:

```sql
REVOKE ALL ON FUNCTION public.app_record_fast_scan_result(...) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_record_fast_scan_result(...) TO cbc_app;
```

The exact signature must be used in the `REVOKE` and `GRANT` statements.

This is mandatory because PostgreSQL functions can be executable by `PUBLIC`
unless explicitly revoked.

## 10. Required scan state and transition model

Gate 003D must define and test an explicit allowed transition table.

The design must resolve the fast-verdict versus async-enrichment seam.

### Fast-path function responsibility

The fast-path function records the initial fast verdict and moves the scan to a
user-facing final fast-result state.

Initial fast-path allowed transitions:

```text
pending -> complete
pending -> failed
processing -> complete
processing -> failed
```

Default fast-path rule:

```text
Already-final scans are not writable by the fast-path function, except for
idempotent retry of the exact same scan/provider/result.
```

### Async enrichment seam

The hybrid model allows deeper worker enrichment after the fast verdict.

Therefore, later async worker enrichment must not be modeled as a normal
fast-path `complete -> *` rewrite.

The recommended v1 seam is:

```text
Fast-path function may complete the scan for user-facing fast verdict.
Async worker may add supplemental evidence through a separate worker-safe path,
but must not use app_record_fast_scan_result(...) to rewrite final verdict.
```

If the worker later needs to change verdict, that requires a separate later gate
with its own function, role, audit, and transition rules.

For Gate 003D:

```text
app_record_fast_scan_result(...) refuses complete -> * conflicting writes.
app_record_fast_scan_result(...) allows exact idempotent retry no-op.
Async enrichment is out of scope for this function.
```

This keeps the app fast-path secure while preserving future hybrid enrichment.

## 11. Idempotency, duplicate retry, and conflicting retry

The function must distinguish duplicate retry from conflicting retry.

### Idempotent duplicate retry

If the same scan/provider/result is submitted again with equivalent controlled
values, the function should:

```text
return existing result metadata as an idempotent no-op
not insert duplicate provider_result rows
not insert duplicate evidence rows
not change scan status/verdict
record audit only if the design explicitly chooses to audit no-op retries
```

### Conflicting retry

If the same scan/provider is submitted again with a different verdict, different
score, different provider status, or incompatible evidence for an already-final
scan, the function must refuse.

Examples:

```text
same scan/provider previously completed safe
retry attempts suspicious
expected: refused

same scan/provider previously completed suspicious
retry attempts safe
expected: refused

same scan/provider previously timed out as unknown
retry attempts safe without approved retry/reopen design
expected: refused
```

No final result overwrite is allowed in Gate 003D.

## 12. Row-lock serialization

The function must lock the scan row before deciding writability, idempotency, or
conflict behavior.

Required behavior:

```text
SELECT ... FOR UPDATE
```

or equivalent row-locking must serialize competing writes for the same scan.

Gate 003D validation must include a row-lock serialization test or a practical
proxy test proving duplicate/conflicting writes do not create inconsistent rows.

## 13. Partial-provider-failure behavior

Provider failure must be explicit.

Rules:

* timeout must not become `safe`
* provider error must not become `safe`
* partial provider signal must not silently become `safe`
* skipped provider must not become `safe`
* insufficient evidence must resolve to `unknown` or `suspicious`
* failure details must be captured in controlled fields
* user-facing result must explain limited confidence

Recommended mapping:

```text
provider_status = success + strong safe signal -> safe
provider_status = success + suspicious signal -> suspicious
provider_status = partial/timeout/error/skipped -> unknown or suspicious
```

## 14. Mandatory audit behavior

Every successful first-time fast-path write must insert an org-scoped
`audit_log` row.

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
* action
* timestamp

Idempotent no-op retries may either:

* return existing metadata without audit, or
* write a separate retry/no-op audit event

The chosen behavior must be documented in the implementation script and tested.

Relevant denied attempts should also be audit logged when safe and practical. If
audit-on-refusal is adopted, Gate 003D must test it.

## 15. Required disposable DB validation

Gate 003D must include disposable DB validation before app-code changes.

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

## 16. Required validation tests

The disposable DB validation matrix must include at least the following tests.

### Database guard

* refuses outside `cbc_003d_validation`

### Function existence/security

* function exists
* function is `SECURITY DEFINER`
* function owner is not `cbc_app`
* function has literal `SET search_path = public, pg_temp`
* `EXECUTE` is revoked from `PUBLIC`
* `EXECUTE` is granted only to intended runtime role
* no broad direct table grants added to `cbc_app`
* function signature has no caller-supplied `organization_id`

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

### Idempotent retry

* same scan/provider/result repeated
* returns existing result metadata
* does not duplicate provider result
* does not duplicate evidence
* does not rewrite scan state

### Conflicting retry

* same scan/provider repeated with different verdict/status/score
* refused
* no duplicate provider result
* no scan verdict rewrite

### Already-complete conflicting write refusal

* complete scan cannot receive conflicting fast-path write

### Illegal transition refusal

* final state overwrite refused
* illegal status jump refused

### Enrichment seam

* fast-path function refuses to rewrite completed scan with new conflicting
  evidence/verdict
* design confirms async enrichment must use a separate later worker-safe path if
  needed
* no app-role fast-path function is used as generic enrichment gateway

### Row-lock serialization

* duplicate/conflicting competing write path cannot create duplicate or
  inconsistent rows
* validation must include a direct row-lock/concurrency test or a practical proxy
  proving serialized behavior

### Bounded typed payload refusal

* invalid verdict refused
* invalid provider_status refused
* score below range refused
* score above range refused
* too many evidence rows refused
* mismatched evidence array lengths refused
* oversized evidence fields refused
* unapproved provider refused
* caller-supplied organization_id is impossible because it is not in signature

### Partial-provider failure behavior

* timeout cannot produce safe
* error cannot produce safe
* skipped cannot produce safe
* partial cannot silently produce safe
* insufficient evidence becomes unknown/suspicious
* failure is captured in controlled result/evidence/audit fields

### Audit behavior

* successful first-time fast-path write creates audit_log row
* audit_log is same-org scoped
* audit_log contains controlled metadata
* audit-on-refusal tested if adopted
* idempotent no-op audit behavior tested according to chosen design

### Cleanup

* validation roles/functions/test data removed or disposable DB dropped

## 17. App-code dependency

No app-code changes to:

```text
app/api/scan/route.ts
```

are approved until Gate 003D passes on:

```text
cbc_003d_validation
```

The route must not be changed to call a function that has not been designed and
validated.

## 18. Production boundary

Gate 003D does not approve:

* production function creation
* production role creation
* production app cutover
* DNS cutover
* Supabase pause
* traffic move
* Azure app deployment

Any production apply requires a later explicit gate.

## 19. Definition of done

Gate 003D is done only when:

* function design is documented
* SQL migration/script exists
* disposable DB validation script exists
* validation target is disposable only
* one atomic function is used for org-check + write + audit
* function signature has no caller-supplied `organization_id`
* function uses typed parameters and bounded typed evidence array
* `REVOKE EXECUTE FROM PUBLIC` is present and validated
* literal `SET search_path = public, pg_temp` is present and validated
* wrong-org scan_id test passes
* state transition tests pass
* idempotent retry test passes
* conflicting retry refusal test passes
* bounded payload tests pass
* partial-provider-failure tests pass
* mandatory audit_log tests pass
* enrichment seam is explicitly tested or documented as out of scope for this
  fast-path function
* row-lock serialization behavior is tested
* `cbc_app` direct grants remain narrow
* results are documented and committed
* second-eye review completed
* production remains untouched

## 20. Current recommendation

Proceed to implement Gate 003D in this order:

1. commit this updated design document
2. create 003D SQL migration/script for the controlled fast-path function
3. create 003D disposable validation scripts
4. run only against `cbc_003d_validation`
5. document results
6. only then approve app-code changes for Gate 003E
