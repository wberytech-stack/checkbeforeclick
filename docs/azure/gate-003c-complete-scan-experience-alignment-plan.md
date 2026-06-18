# Gate 003C - Complete Scan Experience Alignment Plan

> PLANNING DOCUMENT ONLY. No production execution is approved by this document.
> This gate aligns the application scan flow with the target `cbc_app` runtime
> role model proven in Gate 003B. It does not create production roles, does not
> move traffic, does not pause Supabase, and does not cut over DNS/Azure app
> hosting.
>
> Branch: `audit/azure-current-state`
> Builds on:
>
> * Gate 002 production tenant isolation
> * Gate 003B disposable DB validation
> * Gate 003B fast-path dependency note

## 1. Purpose

Gate 003C exists because Gate 003B proved the target `cbc_app` database model,
but also exposed an application mismatch.

Gate 003B intentionally proved that `cbc_app` cannot directly:

* update `scans`
* insert `vendor_results`
* insert `evidence_items`
* read `scan_cache`
* directly mutate `memberships`

That is correct for least privilege.

However, current application behavior still includes synchronous scan processing
inside:

```text
app/api/scan/route.ts
```

That request path may update scan status and insert provider/evidence rows.

Therefore, Gate 003C must align the app scan flow with the database security
model while preserving a complete, beautiful, trustworthy product experience.

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

## 3. Product Gate Lens Stack

Every Gate 003C decision must be judged through these lenses:

### Security lens

Does this preserve least privilege, RLS, tenant isolation, and safe trust
boundaries?

### Tenant-isolation lens

Can Org A ever see, write, count, infer, or mutate Org B data?

### Product / UX lens

Does the scan flow remain simple and useful for a normal business user?

### Bold & Beautiful lens

Does the product look and feel premium enough that a serious business user trusts
it within the first 10 seconds?

### Completeness lens

Are we avoiding fake MVP behavior, dead buttons, unfinished flows, and broken
states?

### Trust & explainability lens

Does the result explain why a verdict was produced without overwhelming the user
with technical noise?

### Speed / response-time lens

Does the user get useful feedback quickly, even if deeper analysis continues?

### Failure-mode lens

If providers fail, queues delay, or inputs are malformed, does the product fail
safely and explain clearly?

### Operational lens

Can the system be deployed, monitored, debugged, and rolled back?

### Maintainability lens

Can another engineer understand this boundary and code path quickly?

### Architecture lens

Are API, worker, database, and provider responsibilities cleanly separated?

### Business / buyer lens

Would an IT or security manager believe this can become a serious B2B product?

### Founder / differentiation lens

Does this make CheckBeforeClick feel smarter and clearer than a generic URL
checker?

### Legal / compliance lens

Are claims and stored data appropriate, defensible, and not excessive?

### Cost / practicality lens

Does this add useful capability without unnecessary complexity or waste?

## 4. Current problem

The current app request path is too powerful for the target role model.

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

So we must choose an implementation model that keeps the user experience complete
without broadening `cbc_app` dangerously.

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
* harder to demo as instant safety tool

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
* SECURITY DEFINER must be tightly controlled
* function could become dangerous if too generic
* needs strong tests and code review

### Option C - Hybrid fast verdict + async deep scan

Flow:

```text
API request
-> create scan
-> run fast provider / cache-safe checks
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
* requires clear status model
* requires UI that handles both immediate and enriched results gracefully
* requires careful function + worker boundaries

## 6. Recommended direction

Gate 003C recommends **Option C: Hybrid fast verdict + async deep scan**.

This best satisfies the lens stack:

* Security: `cbc_app` remains narrow.
* UX: user still gets a fast useful verdict.
* Bold & Beautiful: result page can feel immediate and premium.
* Completeness: no broken pending-only experience.
* Operations: deeper work can move to worker path.
* Architecture: controlled function handles fast writes; worker handles deeper
  processing.

## 7. Target 003C runtime behavior

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

## 8. Controlled fast-path function requirements

The fast-path function should be designed in the next implementation sub-gate before app-code changes are approved and must follow these rules.

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
* internally verifies:

  * `scan_id` exists
  * scan belongs to `app_current_org_id()`
  * current user is a member of that org
  * scan is in a state where fast result write is allowed
* writes only for that `scan_id`
* inserts only controlled provider/evidence rows
* updates scan status/verdict only through allowed state transitions
* records audit information where useful
* refuses cross-tenant or mismatched context
* fails closed on malformed input

The function must not become a generic backdoor for arbitrary result/evidence
writes.

## 9. Scan state model

Gate 003C should use simple, complete user-facing states:

```text
pending
processing
complete
failed
```

Verdict states:

```text
safe
suspicious
unknown
```

Rules:

* `safe` must be earned.
* provider failure must not become `safe`.
* if evidence is insufficient, verdict should be `unknown`, not falsely safe.
* result page must explain what is known and what is still being checked.

## 10. Bold & Beautiful scan UX standard

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

## 11. Staging verification surface

Gate 003C is **not** another disposable DB-only gate.

It is app-code + DB-function + UI flow alignment.

Verification must be staging-style:

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

## 12. Definition of done

Gate 003C is done only when all are true:

* design decision documented and committed
* no broad `cbc_app` direct grants added
* current fast-path mismatch resolved by code/function design
* `app/api/scan/route.ts` no longer performs forbidden raw writes directly
* fast verdict UX still works or pending UX is explicitly accepted and polished
* result page has complete user-facing states
* staging-style test evidence committed
* rollback path documented
* Claude/second-eye review completed
* production untouched unless a later gate explicitly approves it

## 13. Non-goals

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

## 14. Current recommendation

Proceed with the hybrid model:

```text
fast verdict through controlled DB function
deeper enrichment through worker path
cbc_app remains narrow
UI remains complete and premium
```

Before implementation, this plan should receive second-eye review.
