# Gate 003C - Complete Scan Experience Alignment Plan

> PLANNING DOCUMENT ONLY. No production execution is approved by this document.
> This gate aligns the application scan experience with the target `cbc_app`
> runtime role model proven in Gate 003B.
>
> This document does not create production roles, does not move traffic, does not
> pause Supabase, does not cut over DNS, and does not approve Azure production
> app deployment.
>
> Branch: `audit/azure-current-state`
>
> Builds on:
>
> * Gate 002 production tenant isolation
> * Gate 003B disposable DB validation
> * Gate 003B fast-path dependency note
> * Gate 003B result evidence

## 1. Purpose

Gate 003C exists because Gate 003B proved the target database security model, but
also exposed an application mismatch.

Gate 003B proved that the target `cbc_app` role must not directly:

* update `scans`
* insert `vendor_results`
* insert `evidence_items`
* read `scan_cache`
* directly mutate `memberships`

That is the correct least-privilege model.

However, the current application request path still includes synchronous scan
processing inside:

```text
app/api/scan/route.ts
```

That path may update scan status and insert provider/evidence rows during the
user request.

Gate 003C defines how to preserve the complete scan experience without weakening
the security model.

## 2. Product promise

The core CheckBeforeClick promise is:

```text
Paste suspicious URL -> get a fast, useful, understandable verdict.
```

The user should not experience backend complexity.

The product must feel:

* fast
* clear
* secure
* premium
* complete
* trustworthy
* bold and beautiful

## 3. Product Gate Lens Stack

Every Gate 003C and later implementation decision must be judged through these
lenses.

### Security lens

Does this preserve least privilege, RLS, safe trust boundaries, and reduce blast
radius?

### Tenant-isolation lens

Can Org A ever see, write, count, infer, or mutate Org B data?

### Product / UX lens

Does the scan flow remain simple, useful, and easy for a normal business user?

### Bold & Beautiful lens

Does the product look and feel premium enough that a serious business user trusts
it within the first 10 seconds?

### Completeness lens

Are we avoiding fake MVP behavior, dead buttons, half-built flows, and broken
states?

### Trust & explainability lens

Does the result explain why a verdict was produced without overwhelming the user
with raw technical noise?

### Speed / response-time lens

Does the user get useful feedback quickly, even if deeper analysis continues?

### Failure-mode lens

If providers fail, queues delay, or inputs are malformed, does the product fail
safely and clearly?

### Operational lens

Can the system be deployed, monitored, debugged, and rolled back?

### Maintainability lens

Can another engineer understand this boundary and code path quickly?

### Architecture lens

Are API, worker, database, and provider responsibilities cleanly separated?

### Business / buyer lens

Would an IT or security manager believe this can become a serious B2B product?

### Founder / differentiation lens

Does this make CheckBeforeClick feel smarter, clearer, and more trustworthy than
a generic URL checker?

### Legal / compliance lens

Are claims, retained data, and user-facing statements appropriate and defensible?

### Cost / practicality lens

Does this add useful capability without unnecessary complexity or waste?

## 4. Current problem

The current request path is too powerful for the target role model.

Current-style request path:

```text
API request
-> authenticate user
-> create scan
-> run provider logic
-> update scans
-> insert vendor_results
-> insert evidence_items
-> return verdict
```

Gate 003B target role model:

```text
cbc_app can create/read same-org scan records.
cbc_app cannot directly write provider results/evidence/status completion.
```

Therefore, the application must be aligned so that the user still gets a complete
scan experience without granting `cbc_app` broad direct table privileges.

## 5. Options considered

### Option A - Async-only worker model

Flow:

```text
API request
-> create pending scan
-> enqueue scan_id
-> return pending
-> worker processes providers
-> worker writes results/evidence/status
-> UI polls or refreshes
```

Advantages:

* cleanest security separation
* worker owns provider processing
* `cbc_app` remains very narrow
* easier DB privilege story

Disadvantages:

* changes UX from fast verdict to pending/polling
* introduces more frontend states
* can feel unfinished if not beautifully designed
* weaker first-use product impression
* harder to demo as an instant click-safety product

### Option B - Controlled SECURITY DEFINER fast-path function

Flow:

```text
API request
-> create scan
-> run fast provider check
-> call controlled DB function to write result only for that scan
-> return quick verdict
```

Advantages:

* preserves fast verdict UX
* keeps `cbc_app` table grants narrow
* dangerous writes are constrained inside one audited DB function
* avoids giving `cbc_app` broad direct table privileges

Disadvantages:

* requires careful database function design
* `SECURITY DEFINER` must be tightly controlled
* function could become dangerous if too generic
* needs strong validation because caller RLS is not enough inside definer code

### Option C - Hybrid fast verdict + async deep scan

Flow:

```text
API request
-> create scan
-> run fast provider/cache-safe checks
-> call controlled fast-path result function
-> return useful verdict quickly
-> enqueue scan_id for deeper/background enrichment when needed
-> worker may add later evidence or update status through worker-safe path
```

Advantages:

* preserves the bold, fast product promise
* keeps `cbc_app` narrow
* supports deeper analysis later
* gives a complete v1 experience without pretending every scan must finish
  synchronously
* separates fast verdict from deeper enrichment

Disadvantages:

* most design work
* requires clear scan state model
* requires UI that handles immediate and enriched results gracefully
* requires careful function and worker boundaries

## 6. Recommended direction

Gate 003C recommends:

```text
Option C - Hybrid fast verdict + async deep scan
```

This best satisfies the lens stack:

* Security: `cbc_app` remains narrow.
* UX: user still gets a fast useful verdict.
* Bold & Beautiful: result page can feel immediate and premium.
* Completeness: no broken pending-only experience.
* Operations: deeper work can move to worker path.
* Architecture: controlled function handles fast writes; worker handles deeper
  processing.

## 7. Target runtime behavior

### API request path may do

* authenticate the user
* resolve organization server-side from trusted membership/session context
* set transaction-local app context:

  * `app.current_user_id`
  * `app.current_organization_id`
* create a same-org scan row
* run fast provider checks
* call a controlled fast-path DB function
* enqueue `scan_id` for deeper/background processing when needed
* return verdict or clear status to the user

### API request path must not do directly

* raw `UPDATE scans`
* raw `INSERT vendor_results`
* raw `INSERT evidence_items`
* raw `SELECT scan_cache`
* raw membership mutation
* trust browser-provided `organization_id`

## 8. Gate 003D scope

Before app-code changes are approved, the next implementation sub-gate must be:

```text
Gate 003D - Controlled fast-path DB function design + disposable-DB validation
```

Gate 003D must design the function, write the migration/script, and validate the
function behavior in a disposable database before `app/api/scan/route.ts` is
changed.

Gate 003D is still not a production cutover gate.

## 9. Controlled fast-path function requirements

Working name:

```text
app_record_fast_scan_result(...)
```

Required properties:

* `SECURITY DEFINER`
* owned by privileged migration/database owner, not `cbc_app`
* locked `search_path`
* `EXECUTE` granted to `cbc_app`
* no broad table grants added to `cbc_app`
* input includes `scan_id` and controlled result payload
* input must not trust browser-provided `organization_id`
* function loads the scan by `scan_id`
* function compares scan `organization_id` to `app_current_org_id()`
* function verifies `app_current_user_id()` is a member of that organization
* function writes only for that `scan_id`
* function inserts only controlled provider/evidence rows
* function updates scan status/verdict only through allowed transitions
* function fails closed on malformed input
* function must not become a generic backdoor for arbitrary result/evidence
  writes

Because the function is `SECURITY DEFINER`, it must not rely on caller RLS as the
primary protection. The function must enforce tenant and write-safety checks
internally.

## 10. Required state-transition model

Gate 003D must define and test an enumerated allowed state-transition table.

Required rules:

* refuse already-complete scans
* refuse already-failed scans unless explicitly designed as retryable
* refuse illegal status jumps
* refuse illegal verdict changes
* allow only explicitly documented transitions, such as:

  * `pending -> processing`
  * `processing -> complete`
  * `processing -> failed`
* never silently move a failed provider path to `safe`
* never overwrite a final result without an explicit retry/reopen design

The function must check that the scan is in a writable state before writing
results.

## 11. Required idempotency and double-write behavior

Gate 003D must define and test idempotency.

Required rules:

* refuse double-writes for the same fast-path provider result
* prevent duplicate evidence rows for the same scan/provider/evidence key
* handle retry safely without corrupting scan state
* repeated user submission must not create inconsistent duplicate final results
* retry must be either idempotent or explicitly refused with a clear state

The behavior must be documented and tested.

## 12. Required bounded and typed payload

The fast-path function must accept only a bounded and typed payload.

Required rules:

* verdict must be constrained to:

  * `safe`
  * `suspicious`
  * `unknown`
* score/confidence must be numeric and bounded
* provider name must be controlled or validated
* evidence row count must be capped
* evidence text/URL/details sizes must be capped
* raw JSON must not be accepted as an unlimited arbitrary blob
* malformed payload must fail closed

The function must not accept unlimited arbitrary provider data from the API path.

## 13. Required partial-provider-failure behavior

Gate 003D must define and test partial-provider-failure behavior.

Required rules:

* provider failure must never silently become `safe`
* timeout or insufficient evidence must resolve to `unknown` or `suspicious`
* failure reason should be captured in controlled evidence and audit fields
* user-facing result must explain the limited confidence clearly
* if safe cannot be earned, safe must not be returned

## 14. Required audit behavior

Every successful fast-path write must create an org-scoped `audit_log` entry.

Audit logging is mandatory, not optional.

The audit entry must include enough controlled metadata to answer:

* which org
* which user
* which scan
* which provider/fast-path source
* what verdict/status transition happened
* when it happened

Relevant denied attempts should also be audit logged when safe to do so.

## 15. Required definer-function cross-tenant test

Gate 003D validation must explicitly test the most important definer-function
case:

```text
Org A context calls the function with Org B scan_id.
Expected result: function refuses internally.
Reason: caller RLS is not sufficient protection inside SECURITY DEFINER code.
```

This test is mandatory.

The function must prove its own internal tenant check.

## 16. Scan state model

User-facing scan status values:

```text
pending
processing
complete
failed
```

User-facing verdict values:

```text
safe
suspicious
unknown
```

Rules:

* `safe` must be earned
* provider failure must not become `safe`
* if evidence is insufficient, verdict must be `unknown`, not falsely safe
* result page must explain what is known and what is still being checked

## 17. Bold & Beautiful scan UX standard

The scan experience must feel complete and premium.

Required screens/states:

* scan input state
* scanning/loading state
* fast verdict result state
* unknown/inconclusive state
* suspicious warning state
* safe confirmation state
* provider failure / temporary issue state
* scan history state
* empty history state

Result page must show:

* verdict card
* confidence or signal strength
* plain-English explanation
* evidence summary
* provider signal summary
* recommended action
* timestamp
* scan status
* clear next step

The UI must not expose raw provider JSON as the primary experience.

## 18. Verification surface

Gate 003C itself is a planning gate.

Gate 003D must use disposable DB validation for the controlled function.

Later app-code alignment must use staging-style verification.

Required staging-style verification later:

* app runs against staging/Azure-like database
* runtime role behavior matches `cbc_app`
* route uses server-side org resolution
* route uses transaction-local app context
* route does not directly perform forbidden raw writes
* controlled function performs allowed fast-path writes
* UI result page works
* scan history works
* cross-tenant access remains denied
* provider failure path is safe and understandable
* logs do not leak secrets

## 19. Definition of done for Gate 003C

Gate 003C is done when:

* design decision is documented and committed
* second-eye review confirms Option C
* second-eye review confirms Gate 003D must happen before app-code changes
* no broad `cbc_app` direct grants are approved
* no production role creation is approved
* no production traffic move is approved
* no Supabase pause is approved

## 20. Definition of done for Gate 003D

Gate 003D will be done only when:

* controlled fast-path function design is documented
* SQL migration/script exists
* disposable DB validation script exists
* function validates internal org ownership
* wrong-org `scan_id` test passes
* state-transition tests pass
* double-write/idempotency tests pass
* bounded payload tests pass
* partial-provider-failure tests pass
* mandatory audit_log tests pass
* `cbc_app` still has no broad direct table grants
* results are documented and committed
* production remains untouched

## 21. Non-goals

Gate 003C does not:

* create real production runtime roles
* cut over production app traffic
* pause Supabase
* move DNS
* deploy final Azure production app
* implement full enterprise admin console
* implement billing
* implement SIEM export
* implement all future worker/deep-scan capabilities
* approve app-code changes before Gate 003D

## 22. Current recommendation

Proceed with:

```text
Option C - Hybrid fast verdict + async deep scan
```

Then proceed to:

```text
Gate 003D - Controlled fast-path DB function design + disposable-DB validation
```

Only after Gate 003D passes should app-code changes to `app/api/scan/route.ts`
be approved.
