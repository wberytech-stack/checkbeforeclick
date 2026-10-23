# Gate 007A - Scanner rate limiting and provider-cost protection

## Status

Implementation on the local branch `gate-007a-scanner-rate-limiting` (base `master@1810aeb`).

- **Not committed, not pushed, not deployed.**
- **The Supabase migration is a draft.** It has been validated only on a disposable
  local Postgres. Applying it to the Supabase staging or production project is
  founder-only (AGENTS.md sections 6.3 and 9).
- **Approval:** founder-approved design and limits, 2026-10-22. That approval
  covers implementation and local tests only.

## Goal

Stop abuse and unexpected Google Web Risk costs before outside users get access:
- rate-limit scans and logins;
- cap paid provider calls;
- fail closed when the shared limit cannot be confirmed.

## Limits (founder-approved)

| Limit | Value | Enforced by |
| --- | --- | --- |
| Scans per user, burst | 5 per minute | Application memory, per instance (`lib/security/rateLimit.ts`) |
| Scans per user | 50 per rolling 24 hours | Database admission (`public.cbc_admit_scan`) |
| Scans per organization | 200 per rolling 24 hours | Database admission |
| Scan admissions, global | 500 per rolling 24 hours | Database admission |
| Login attempts per client IP | 10 per 15 minutes | Application memory, per instance |
| Login attempts per email | 5 per 15 minutes | Application memory, per instance |

### Admissions versus provider calls (Codex cycle 3 P2 fix)

- **Two separate limits:**
  - **An admission is permission for one scan:** 500, 200 and 50 per rolling
    24 hours.
  - **The Web Risk provider budget is separate.** It's enforced at **execution
    time**: at most **1,000 Google Web Risk requests per rolling 24 hours**
    (founder decision, 2026-10-22).
- **Why admission can't be the budget:** reservations made at admission age out of
  the window, and delayed, retried, duplicated or replayed background jobs could
  then still call Web Risk.
- **How the budget works:** every Web Risk request needs its own reservation,
  made immediately before the request through `cbc_reserve_provider_call`.
  - The reservation must be funded by the caller's own admission, no more than
    10 minutes old.
  - Each admission can fund only one reservation.
  - The cap holds under concurrency.
- **Where paid calls happen:** only in the signed-in scan request. Every input
  type (email, header, signature, batch included) is now scanned synchronously,
  and the Inngest worker runs unpaid providers only.
- **Budget refused or unconfirmed:** the scan fails with **HTTP 503**. No request
  is made and no verdict is produced.
- **`scan_admissions.provider_calls_reserved`** is now an informational estimate
  only.

## Design

### Atomic shared admission

`infra/supabase/migrations/001_scan_admission.sql` creates the `public.scan_admissions` ledger and the
`public.cbc_admit_scan(p_input_type)` function.

- **Who calls it:** the API route, through the **signed-in user's own Supabase
  session** (`authClient.rpc`, using the anon key and the user's JWT). The
  service-role key is never used, so the legacy service-role path is not
  deepened (AGENTS.md section 12).
- **Identity is derived on the server:** the user comes from `auth.uid()` and the
  organization from `public.users`. Neither is a parameter.
- **Concurrency:** `pg_advisory_xact_lock` serializes admissions across all app
  instances, so the caps are exact under concurrency. This was validated with 20
  parallel requests.
- **Ledger access:**
  - row-level security is on, with no policies;
  - all table grants are revoked from `anon`, `authenticated` and
    `service_role`;
  - the function has `SECURITY DEFINER` and a pinned `search_path`;
  - only `authenticated` may execute it.
- **Pruning:** rows older than 48 hours are deleted on each admission.

### Execution-time Web Risk budget

The same migration creates the `public.provider_call_reservations` ledger and the
`public.cbc_reserve_provider_call(p_provider, p_admission_id)` function.

- **Who calls it:** the signed-in user's own session (`authClient.rpc`), never the
  service role.
- **What it requires:**
  - an authenticated caller;
  - provider `google_web_risk`;
  - an admission that belongs to the caller and is no more than 10 minutes old.
- **One per admission:** `UNIQUE (provider, admission_id)`; a second attempt gets
  `already_reserved`.
- **The cap:** 1,000 per rolling 24 hours, serialized with
  `pg_advisory_xact_lock`. On exhaustion it returns `provider_budget_exhausted`
  with `Retry-After`.
- **Ledger access:** row-level security on with no policies; grants revoked from
  `anon`, `authenticated` and `service_role`; `SECURITY DEFINER` with a pinned
  `search_path`; execute for `authenticated` only.
- **Pruning:** rows older than 48 hours are deleted on each reservation.

### One reservation, at most one request

- **`lib/security/providerBudget.ts`** (pure module): `guardedPaidCall` reserves
  exactly once.
  - **Anything but an unambiguous grant:** refusal, error, an unexpected shape, a
    thrown call or an invalid admission ID means **no request**, and a 503 decision.
  - **A grant:** the paid call runs exactly once, with no retry.
- **`lib/scan/providers/googleWebRisk.ts`:**
  - **The only export that can reach Google** is `callWebRiskGuarded`.
  - **The request function `fetchWebRisk`** is private, contains the module's
    single `fetch`, and is cancelled by an `AbortController` after 7 seconds.
  - **The provider's `run()`** never makes a request.
  - **Missing API key:** no reservation and no request; the result is "skipped",
    so the verdict can't be "safe".
- **`lib/scan/providers/index.ts`:** `withoutPaidProviders()`.
  **`inngest/functions/processScan.ts`** uses it, so the worker can never call Web
  Risk.
- **`app/api/scan/route.ts`:**
  - `export const maxDuration = 30`;
  - no Inngest enqueue;
  - paid providers run only through `callWebRiskGuarded`;
  - a refused budget means `failScan` and a 503 before any verdict is computed.
- **`lib/scan/providers/domainAge.ts`:** the timeout is now 7 seconds.

### Application

- **`lib/security/rateLimit.ts`:** a pure module with no imports and no
  environment access. It contains:
  - the in-memory sliding-window limiter;
  - burst-then-admission ordering (a burst rejection consumes no admission);
  - fail-closed interpretation of the function result;
  - login limits and client-IP extraction.
- **Client IP:** taken from the last `X-Forwarded-For` entry, the one the hosting
  proxy appends.
- **`app/api/scan/route.ts`:** admission runs after input validation and before
  the scan row is created.
  - **On rejection:** HTTP 429 for the user and organization limits, HTTP 503 for
    the global cap and whenever admission can't be confirmed, both with a
    `Retry-After` header.
  - **Effect of a rejection:** no scan row is created, no event is queued and no
    provider is called.
- **`app/api/auth/login/route.ts`:** per-IP and per-email limits run before
  Supabase is called (HTTP 429 with `Retry-After`). This matters because Supabase
  sees this server's address, so its own per-IP limits can't tell users apart.

## Changed files

| File | Change |
| --- | --- |
| `lib/security/rateLimit.ts` | New |
| `app/api/scan/route.ts` | Admission before scan creation |
| `app/api/auth/login/route.ts` | Login limits before sign-in |
| `infra/supabase/migrations/001_scan_admission.sql` | New, draft |
| `infra/supabase/migrations/001_scan_admission.down.sql` | New rollback |
| `scripts/rate-limit/test-rate-limit.ts` | New offline unit and static tests |
| `scripts/rate-limit/validate-admission-db.ts` | New disposable-database validation (admission and reservation) |
| `docs/gates/gate-007a-scanner-rate-limiting.md` | This document |
| `lib/security/providerBudget.ts` | New: the reservation guard (cycle 3 P2 fix) |
| `lib/scan/providers/googleWebRisk.ts` | Single guarded entry point, private request with a 7 s abort |
| `lib/scan/providers/types.ts` | `paid` flag |
| `lib/scan/providers/index.ts` | `withoutPaidProviders` |
| `lib/scan/providers/domainAge.ts` | 7 s timeout |
| `inngest/functions/processScan.ts` | Unpaid providers only |
| `scripts/rate-limit/test-provider-budget.ts` | New offline and static tests for the provider budget |

## Validation (local)

| Check | Result |
| --- | --- |
| `node scripts/rate-limit/test-rate-limit.ts` | 75 passed, 0 failed |
| `node scripts/rate-limit/test-provider-budget.ts` | 45 passed, 0 failed |
| `scripts/rate-limit/validate-admission-db.ts` | 40 passed, 0 failed (includes 16 reservation checks) |
| `test-hosting-safety.ts` | 110 passed, 0 failed |
| `test-reconcile.ts` | 22 passed, 0 failed |
| `test-orchestrator.ts` | 21 passed, 0 failed |
| `tsc --noEmit` | exit 0 |
| `eslint` on the changed files | exit 0 |
| `git diff --check` | clean |

**What the unit and static tests cover:**
- the limiter windows and `Retry-After`;
- the burst rejection not consuming an admission;
- fail-closed handling of every unexpected or error result;
- login per IP and per email;
- IP extraction that ignores forged entries;
- route ordering;
- that the admission path doesn't use the service role;
- the migration's grants, lock and limits.

**The disposable-database validation:**
- **Environment:** the `public.ecr.aws/supabase/postgres:17.6.1.121` image,
  bound to 127.0.0.1, with the real Supabase roles and `auth.uid()`. The code
  under test ran as `authenticator` → `authenticated`. The container was removed
  afterwards.
- **What it covers:**
  - the function's properties;
  - admission and recording;
  - unauthenticated requests, users without a profile and invalid input types;
  - denied direct ledger access, for `service_role` too;
  - the 50, 200 and 500 caps, including under 20 parallel requests;
  - `Retry-After`;
  - the 24-hour window and 48-hour pruning;
  - the Web Risk bound.
- **Defect found during validation:** Supabase's default grants gave
  `service_role` access to the new table. The grant is now revoked and tested.

**Not exercised:**
- `next build`;
- the migration on a real Supabase project;
- runtime behaviour on Vercel or Azure.

## Required deployment order (founder)

1. Apply `001_scan_admission.sql` to Supabase **staging**, then **production**,
   **before** this code is merged. A merge to `master` is a Vercel production
   deployment, and without the function every scan fails closed (HTTP 503).
2. Merge, after review.
3. On Azure staging: run the smoke tests, including that the 6th scan within a
   minute returns 429.

**Rollback:** revert the application change first, then run
`001_scan_admission.down.sql`.

## Risks and limitations

- **In-memory limiter memory is bounded** (Codex review P2 fix). Each limiter keeps at most `limit`
  timestamps per key (rejected attempts included) and at most 10,000 keys, with keys truncated to 320
  characters.
  - **At capacity:** after expired keys are swept, a *new* key is refused with 429
    `rate_limiter_at_capacity` (fail closed).
  - **No early eviction:** tracked keys are never evicted early, so flooding can't reset a victim's counter.
  - **Trade-off:** a flood of about 10,000 distinct emails can block new sign-ins on that instance for up to
    15 minutes. The per-IP limit makes such a flood costly.
  - **IP is checked first** (Codex cycle 2 P1 fix). An attempt the IP limit rejects never reaches the email
    limiter, so each IP can create or update at most 10 email buckets per 15 minutes. Filling the 10,000-key
    capacity therefore needs about 1,000 distinct IPs.
- **In-memory limits are per instance.** The burst and login limits apply per
  instance: up to 3x on Azure production (3 replicas), and weaker on Vercel's
  serverless platform today.
- **Organization switching** (pre-existing, Phase 0 audit): users may be able to
  change their own `organization_id`. That could move a user between
  per-organization buckets; the per-user and global caps still apply.
- **Global serialization:** all admissions are serialized. That is negligible at
  500 per day.
- **Admissions are consumed even when the scan later fails,** for example if
  creating the scan row fails. That is the conservative choice.
- **Inngest re-runs are not reserved:** manual re-runs from the dashboard fall
  outside the bound.
- **The `X-Forwarded-For` behaviour on Azure Container Apps** must be confirmed
  on staging.
- **Founder-side protection (Google Cloud):** a Web Risk daily quota and a budget
  alert. These are not changed by this gate.

## Out of scope

- No commit, push, deploy, Azure or Google Cloud change, or Codex run.
- No new dependency or paid infrastructure.
