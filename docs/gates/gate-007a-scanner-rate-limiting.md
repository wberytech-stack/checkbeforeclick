# Gate 007A - Scanner rate limiting and provider-cost protection

## Status

- **Branch and PR:** `gate-007a-scanner-rate-limiting`, draft PR #45 into `master`.
  - First commit: `b0961bf` (base `master@1810aeb`).
  - **Revision 2:** `061e4e6` (login path, scan-flow extraction, Web Risk
    hardening, tenant guard, regression tests), committed and pushed with founder
    approval on 2026-10-23.
  - **CI:** `f040dd1` adds the read-only pull-request validation workflow (see
    "Continuous validation"). Founder instruction, 2026-10-24.
  - **Not yet reviewed by ChatGPT.** An independent review of the complete
    Revision 2 diff has been requested.
- **Not merged and not deployed.** Merging into `master` is a Vercel production
  deployment.
- **Migrations:**
  - `001_scan_admission.sql` is **applied to Supabase staging only**
    (`zgxmvpbvvakpsnzcymsf`), by the founder; see "Staging validation". It is not
    applied to production.
  - `002_users_identity_guard.sql` is a **draft**. It is not applied anywhere and
    not yet validated on a disposable database.
  - Applying either to a real database is founder-only (AGENTS.md sections 6.3
    and 9).
- **Approval:** founder-approved design and limits, 2026-10-22. Revision 2 was
  requested by the founder on 2026-10-23 for local edits and offline tests only.

## Goal

Stop abuse and unexpected Google Web Risk costs before outside users get access:
- rate-limit scans;
- throttle password sign-ins made through the CBC login page (see "Login
  protection" for what this can and cannot cover);
- cap paid provider calls made by this code;
- fail closed when a shared limit cannot be confirmed.

## Limits (founder-approved)

| Limit | Value | Enforced by |
| --- | --- | --- |
| Scans per user, burst | 5 per minute | Application memory, per instance (`lib/security/rateLimit.ts`) |
| Scans per user | 50 per rolling 24 hours | Database admission (`public.cbc_admit_scan`) |
| Scans per organization | 200 per rolling 24 hours | Database admission |
| Scan admissions, global | 500 per rolling 24 hours | Database admission |
| Web Risk reservations | 1,000 per rolling 24 hours, one per admission | Database (`public.cbc_reserve_provider_call`) |
| Sign-in attempts per client IP | 10 per 15 minutes | Application memory, per instance (login route) |
| Sign-in attempts per email | 5 per 15 minutes | Application memory, per instance (login route) |

### Effective Web Risk ceiling

- **Per Supabase project:** each reservation needs its own admission no more than
  10 minutes old, and admissions are capped at 500 globally. So **at most 500 Web
  Risk requests per rolling 24 hours** can be made by this code against one
  Supabase project. The 1,000 reservation cap is a second, never-binding bound.
- **The cap is per Supabase project.** Staging and production each have their own
  ledgers, so code from this gate can make up to about 1,000 requests a day in
  total on the shared key.
- **Older deployments are not covered at all** (next section).

### Admissions versus provider calls (Codex cycle 3 P2 fix)

- **Two separate limits:**
  - **An admission is permission for one scan:** 500, 200 and 50 per rolling
    24 hours.
  - **The Web Risk budget is enforced at execution time:** one reservation is
    made immediately before each request.
- **Why admission can't be the budget:** reservations made at admission age out of
  the window, and delayed, retried, duplicated or replayed background jobs could
  then still call Web Risk.
- **How the budget works:** every Web Risk request needs its own reservation
  through `cbc_reserve_provider_call`.
  - The reservation must be funded by the caller's own admission, no more than
    10 minutes old.
  - Each admission funds one reservation at most.
  - The cap holds under concurrency.
- **Where paid calls happen:** only in the signed-in scan request. Every input
  type is scanned synchronously, and the Inngest worker runs unpaid providers
  only.
- **Budget refused or unconfirmed:** the scan fails with **HTTP 503**. No request
  is made and no verdict is produced.
- **`scan_admissions.provider_calls_reserved`** is an informational estimate only.

## Google Web Risk: every execution path

The API key `GOOGLE_WEB_RISK_API_KEY` is **shared by Production and Preview**
(`docs/ENVIRONMENTS.md` section 11). Application code can only control the code
it runs. **It cannot cap requests made by deployments built from older commits.**

| # | Path | Guarded by this gate? |
| --- | --- | --- |
| 1 | Scan request (`POST /api/scan`) on a deployment of this branch: Vercel Preview (staging Supabase), production after merge, or Azure | Yes: admission, then one reservation, then at most one request |
| 2 | Inngest worker (`process-scan`) on a deployment of this branch, including dashboard re-runs and events queued before deploy | Yes: paid providers are filtered out, so no request is possible |
| 3 | **Current production** (`master` before this merge): scan route and Inngest worker | **No.** Unguarded until this gate is deployed |
| 4 | **Every older Vercel Preview deployment still reachable** (built before `b0961bf`), and its Inngest branch environment | **No.** Unguarded, uses the shared key, and is never fixed by merging |
| 5 | Local development (`next dev` with a key in a local env file) | Same as 1, against whichever Supabase project is configured |
| 6 | Any other holder of the key (copied key, other projects) | No; only Google Cloud controls apply |

**Protections in the repository (this gate):**
- one guarded entry point (`callWebRiskGuarded`); the worker filters paid
  providers out; only `googleWebRisk.ts` reads the key;
- static tests assert this, and that no script or tool calls the API;
- **Revision 2:**
  - the key is sent in the `X-Goog-Api-Key` header, never in the URL (AGENTS.md
    section 11);
  - redirects are refused, so the key header is never forwarded;
  - Google's error body is stored only as a 500-character excerpt;
- `WEB_RISK_PROVIDER_ENABLED=false` disables the provider. The environment
  variable is read at startup, so changing it needs a redeploy.

**Protections only the founder can apply (outside the repository):**
- **a hard daily quota** on the Web Risk API in Google Cloud, plus a billing budget
  alert. This is the only control that also covers paths 3, 4 and 6;
- **separate keys for Production and Preview**, or a rotated key given only to
  current deployments. Rotation is the only way to cut off path 4 without
  deleting deployments;
- **deleting or disabling old Preview deployments** that hold the shared key.

## Login protection

### What changed (Revision 2)

The original commit added limits to `app/api/auth/login/route.ts`, but the login
page called `supabase.auth.signInWithPassword` directly from the browser. The
route had no callers, so the limits were inert. Now:

- **The login page** (`app/(auth)/login/[[...rest]]/page.tsx`) posts to
  `/api/auth/login`. It no longer creates a browser Supabase client. A 429
  produces a distinct "wait about N minutes" message.
- **`lib/security/loginFlow.ts`** (pure, tested offline):
  1. validates the body: 400 for malformed input or for an email over 320 or a
     password over 1,024 characters;
  2. checks the per-IP limit, then the per-email limit, **before** Supabase is
     called;
  3. returns a generic 401 on failure;
  4. sends `Cache-Control: no-store` on every response.
- **Session cookies** from Supabase are copied onto the response only on success.
- **`?next=`** is restricted to same-site paths (`safeNextPath`), closing an open
  redirect after sign-in.
- **`signInWithPassword` is called only by the server route** (static test).

### What this cannot cover

- **Direct Supabase Auth access.** `NEXT_PUBLIC_SUPABASE_URL` and the anon key are
  public by design, so anyone can call `POST /auth/v1/token` directly and skip
  this route.
  - Those requests are limited only by **Supabase Auth's own rate limits and
    CAPTCHA setting**, which are project configuration (founder, Supabase
    dashboard) and are not in this repository.
  - Their current production values are **unverified**.
- **Serverless instances.** The limiters are in memory, per instance. On Vercel
  each concurrent instance has its own counters, so the effective limit is
  "nominal × instances". They are a best-effort first layer, not a global cap.
  - A database-backed login limiter would need a new migration and a
    pre-authentication function callable by `anon`. That would be a design
    decision for a later gate.
- **Supabase sees the server's address.** Sign-ins through the route reach
  Supabase from Vercel's egress addresses, so Supabase's per-IP limits now apply
  to all route users together.
  - At current scale this is not a constraint. Under load, legitimate users could
    hit Supabase's per-IP sign-in limit.
  - Check the configured value before outside users get access.
- **Sign-up** (`/register`) still calls Supabase Auth from the browser and is
  covered only by Supabase's sign-up limits. It is not in this gate's scope.

## Tenant pointer: `public.users.organization_id`

### Facts established from the repository

- **The only tenant pointer.** The Supabase schema has no membership table
  (Phase 0 audit table list). `public.users.organization_id` is the only link
  between a user and an organization.
- **The app trusts it completely:**
  - `lib/data/index.ts` `getUserOrgContext` reads it with the **service-role**
    client (RLS bypassed);
  - every scan read and write then uses that organization;
  - `cbc_admit_scan` uses it for the per-organization quota.
- **The app never writes `public.users` or `public.organizations`,** and reads no
  `user_metadata` for authorization.
- **Sign-up sends only `full_name` and `organization_name` as metadata** (static
  tests A01–A08).
- **The production RLS policies, grants and the `handle_new_user` body are not in
  this repository.**
  - The Phase 0 audit lists "users may be able to update sensitive profile fields
    such as role or organization" as an **open, unverified** risk.
  - If an UPDATE policy lets a user change their own row, that user can move into
    any organization whose UUID they know and read and write its scans. That is a
    **critical cross-tenant exposure**.

### Repository fix (draft)

`infra/supabase/migrations/002_users_identity_guard.sql` adds a `BEFORE INSERT OR
UPDATE OR DELETE` trigger on `public.users`.

- **What it blocks:** for requests running as `anon` or `authenticated`, it
  refuses INSERT and DELETE, and refuses changes to `id`, `organization_id` and
  `role` (SQLSTATE 42501).
- **It works whatever the RLS policies say.**
- **What it leaves alone:**
  - the service role (the app's data layer);
  - `handle_new_user` (runs as its owner or `supabase_auth_admin`);
  - the dashboard and SQL editor;
  - other columns, where RLS allows editing them.
- **Rollback:** `002_users_identity_guard.down.sql`.
- **Disposable validation:** `scripts/rate-limit/validate-users-guard-db.ts` is
  written to run against a disposable database with a deliberately permissive
  policy (10 checks). It is **not yet run**.
- **What it does not cover:**
  - a user-callable `SECURITY DEFINER` function that writes `public.users`,
    because it runs as its owner;
  - writes to `public.organizations`.

  Both need the verification below.

### Production facts that need read-only verification (founder, SQL Editor)

```sql
-- 1. Policies and grants on the tenant tables
select tablename, policyname, cmd, roles, qual, with_check from pg_policies
 where schemaname = 'public' and tablename in ('users', 'organizations') order by 1, 2;
select table_name, grantee, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and table_name in ('users', 'organizations')
   and grantee in ('anon', 'authenticated') order by 1, 2, 3;
select table_name, column_name, grantee, privilege_type from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'users' and grantee in ('anon', 'authenticated')
   and privilege_type in ('INSERT', 'UPDATE') order by 1, 2, 3;
-- 2. RLS enabled?
select relname, relrowsecurity, relforcerowsecurity from pg_class
 where relnamespace = 'public'::regnamespace and relname in ('users', 'organizations');
-- 3. SECURITY DEFINER functions callable by signed-in users (any of them could write public.users)
select p.proname, pg_get_function_identity_arguments(p.oid) from pg_proc p
 where p.pronamespace = 'public'::regnamespace and p.prosecdef
   and has_function_privilege('authenticated', p.oid, 'EXECUTE');
-- 4. Existing triggers on public.users and the handle_new_user body
select tgname from pg_trigger where tgrelid = 'public.users'::regclass and not tgisinternal;
select pg_get_functiondef('public.handle_new_user'::regproc);
```

- **Expected for a safe system:**
  - no UPDATE, INSERT or DELETE path for `authenticated` or `anon` that can change
    `organization_id` or `role`;
  - no user-callable definer function that writes them;
  - `handle_new_user` reads nothing but `full_name` and `organization_name` from
    metadata.
- **If any of these fail, it's a blocker.** Apply 002 (after disposable
  validation and founder approval) before outside users get access.

## Design

### Atomic shared admission

`infra/supabase/migrations/001_scan_admission.sql` creates the
`public.scan_admissions` ledger and `public.cbc_admit_scan(p_input_type)`.

- **Who calls it:** the scan route, through the **signed-in user's own Supabase
  session** (anon key and the user's JWT). The service-role key is never used
  (AGENTS.md section 12).
- **Identity is derived on the server:** the user from `auth.uid()`, the
  organization from `public.users`. Neither is a parameter.
- **Concurrency:** `pg_advisory_xact_lock` serializes admissions, so the caps are
  exact under concurrency.
- **Ledger access:** RLS on with no policies; all table grants revoked from
  `anon`, `authenticated` and `service_role`; `SECURITY DEFINER` with a pinned
  `search_path`; execute for `authenticated` only.
- **Pruning:** rows older than 48 hours are deleted on each admission.

### Execution-time Web Risk budget

The same migration creates `public.provider_call_reservations` and
`public.cbc_reserve_provider_call(p_provider, p_admission_id)`.

- **Who calls it:** the signed-in user's own session, never the service role.
- **What it requires:** an authenticated caller, provider `google_web_risk`, and
  the caller's own admission, no more than 10 minutes old.
- **One per admission:** `UNIQUE (provider, admission_id)`; a repeat gets
  `already_reserved`.
- **The cap:** 1,000 per rolling 24 hours, serialized; on exhaustion it returns
  `provider_budget_exhausted` with `Retry-After`.
- **Ledger access and pruning:** the same as the admission ledger.

### Scan request flow (Revision 2: `lib/scan/scanFlow.ts`)

The request flow was moved, unchanged in behaviour, from the route into a pure
module with every effect injected. `app/api/scan/route.ts` now only wires the real
effects. This made the whole flow testable offline. Order:

1. **Authenticate:** signed-in user, else 401.
2. **Resolve the organization** server-side from the user ID, else 403.
3. **Validate the input**, else 400:
   - JSON body, which must be an object (a `null` or array body is now 400, not
     500);
   - `input_type` must be one of the six valid types;
   - `input` must be a non-empty string of at most 10,000 characters.
4. **Admit:** the per-user burst limit, then `cbc_admit_scan`.
   - 429 for the burst, user and organization limits; 503 for the global cap and
     for any unconfirmed admission; both with `Retry-After`.
   - On rejection, no scan row is created.
5. **Create the scan row,** else 500.
6. **Normalize the target** (the SSRF rules in `lib/security/urlSafety.ts`):
   - **URL input:** the URL itself (`https://` added when there's no scheme);
   - **domain input:** `https://<domain>`;
   - **email, header, signature, batch:** the **first** `http(s)://` URL in the
     text;
   - **no safe target** (no link, a private or loopback address, a blocked
     scheme, an invalid domain): `complete` / `unknown`, **no provider call and
     no reservation**.
7. **Run the providers in parallel.**
   - Unpaid providers run directly.
   - The paid provider runs only through `callPaid`, which maps to
     `callWebRiskGuarded` for `google_web_risk` and refuses any other paid
     provider.
   - A refused reservation calls `failScan` and returns 503 before any verdict.
8. **Score and persist,** then 201.
   - Any later error marks the scan failed and returns a JSON 500.
   - The Supabase client is now created inside this error handling.

- **`maxDuration = 30`:** providers time out after 7 s and run in parallel.

### Paid provider module

- **`lib/security/providerBudget.ts`:** `guardedPaidCall` makes exactly one
  reservation.
  - Anything but an unambiguous grant means no request and a 503.
  - A grant means exactly one call, with no retry.
- **`lib/scan/providers/googleWebRisk.ts`:**
  - `callWebRiskGuarded` is the only export that can reach Google;
  - `fetchWebRisk` is private, holds the single `fetch`, and is aborted after
    7 s;
  - `run()` never makes a request;
  - a missing key means no reservation and a "skipped" result, which is never
    "safe".
- **`withoutPaidProviders()`** is used by `inngest/functions/processScan.ts`.

## Staging validation

### Supabase API validation: PASSED (founder-run, 2026-10-23)

This is reported by the founder and is not repository evidence (AGENTS.md
section 16).

- **Setup:**
  - **Migration:** the founder applied `001_scan_admission.sql` (SHA-256
    `f0391cdb4f8f7f56943ef1e220d640d316c726948c37f773409addc488ccb3a0`) to
    staging `zgxmvpbvvakpsnzcymsf`.
  - **Script:** `cbc-007a-staging-api.ps1`, SHA-256
    `6a81987420dfc58fa9eed97984674ba85a7c09569d3096438eae6f1719bf5d2d`, kept
    outside the repository.
  - **Offline harness for the script:** 151 checks passed, 23/23 mutants killed.
- **What the run did:**
  1. signed in a test user through Supabase Auth;
  2. confirmed that anonymous calls to both functions are denied, and that direct
     reads of both ledgers are denied;
  3. confirmed `invalid_input_type`, `unknown_provider` and `admission_not_valid`;
  4. made **one admission** and **one reservation**;
  5. confirmed that a second reservation for the same admission gets
     `already_reserved`;
  6. logged out with `scope=local`.
- **Independent SQL check:** exactly one admission row and one reservation row
  were added.
- **Not covered by that run:**
  - any application route (`/api/scan`, `/api/auth/login`);
  - any Web Risk request;
  - the burst limiter, concurrency through the app, and latency;
  - Revision 2.

### Still required on staging (through this PR's Preview, founder-approved)

| # | Test | Pass condition |
| --- | --- | --- |
| ST1 | Sign in through the UI, then 6 rapid sign-in failures for one email | 6th attempt shows the 429 message; a correct password signs in after the window |
| ST2 | One scan per input type (url, domain, email with link, email without link) | 201; one admission per scan; a reservation only for scans with a safe link (SQL counts) |
| ST3 | 6 scans within a minute | 6th is 429 `user_burst_limit` with `Retry-After`; no admission row for it |
| ST4 | One URL scan with the key-in-header change | Web Risk returns a real result (not `API error 401/403`). This is the only check of the header change; it needs **one founder-approved Web Risk request** |
| ST5 | `WEB_RISK_PROVIDER_ENABLED=false` on Preview (optional) | Scan completes, no reservation, verdict not `safe` |
| ST6 | 5–10 URL scans | p95 latency well under 30 s |
| ST7 | Inngest dashboard after ST2–ST6 | No new `process-scan` runs |

## Changed files

| File | Change |
| --- | --- |
| `lib/security/rateLimit.ts` | New (commit 1) |
| `lib/security/providerBudget.ts` | New: the reservation guard (commit 1) |
| `lib/scan/scanFlow.ts` | **Rev 2, new:** pure scan request flow |
| `app/api/scan/route.ts` | Commit 1: admission and guard; **Rev 2:** thin adapter over `scanFlow` |
| `lib/security/loginFlow.ts` | **Rev 2, new:** pure login flow and `safeNextPath` |
| `app/api/auth/login/route.ts` | Commit 1: limits; **Rev 2:** adapter, cookies only on success |
| `app/(auth)/login/[[...rest]]/page.tsx` | **Rev 2:** signs in through `/api/auth/login`; safe `next` |
| `lib/scan/providers/googleWebRisk.ts` | Commit 1: guarded entry; **Rev 2:** key in header, no redirects, bounded error body |
| `lib/scan/providers/types.ts`, `index.ts`, `domainAge.ts` | `paid` flag, `withoutPaidProviders`, 7 s timeout (commit 1) |
| `inngest/functions/processScan.ts` | Unpaid providers only (commit 1) |
| `infra/supabase/migrations/001_scan_admission(.down).sql` | Commit 1; applied to staging only |
| `infra/supabase/migrations/002_users_identity_guard(.down).sql` | **Rev 2, new, draft** |
| `scripts/rate-limit/test-rate-limit.ts` | Commit 1; **Rev 2:** static checks follow the flow modules |
| `scripts/rate-limit/test-provider-budget.ts` | Commit 1; **Rev 2:** flow statics, key hygiene, Web Risk path inventory |
| `scripts/rate-limit/test-scan-flow.ts` | **Rev 2, new:** behavioural scan-flow tests |
| `scripts/rate-limit/test-login-flow.ts` | **Rev 2, new:** behavioural login tests and UI statics |
| `scripts/rate-limit/test-tenant-guard.ts` | **Rev 2, new:** migration 002 and tenant-resolution statics |
| `scripts/rate-limit/validate-admission-db.ts` | Disposable-database validation of 001 (commit 1) |
| `scripts/rate-limit/validate-users-guard-db.ts` | **Rev 2, new:** disposable validation of 002, not yet run |
| `docs/gates/gate-007a-scanner-rate-limiting.md` | This document |
| `.github/workflows/pr-validate.yml` | **CI, new:** read-only pull-request validation |
| `scripts/azure-hosting/test-hosting-safety.ts` | **CI:** 15 invariants for `pr-validate.yml` |

## Continuous validation (`.github/workflows/pr-validate.yml`)

- **Trigger:** `pull_request` into `master` only. Never `pull_request_target`,
  `push` or dispatch.
- **Permissions:** `contents: read`, at the workflow level and the job level.
- **No secrets:** no secrets, repository variables, GitHub environment or cloud
  credentials.
- **Checkout:** `persist-credentials: false`. Only `actions/checkout@v4` and
  `actions/setup-node@v4` are used.
- **Steps:**
  1. Node 24.14.0;
  2. `npm ci --ignore-scripts --no-audit --no-fund`;
  3. `tsc --noEmit -p tsconfig.json`;
  4. the six offline suites (rate limit, provider budget, scan flow with
     `--conditions=react-server`, login flow, tenant guard, hosting and workflow
     safety).
- **What it never does:** it deploys nothing and makes no database, Supabase,
  Google, Vercel or Azure call. The disposable-database validators and the smoke
  test are excluded, and a test asserts this.
- **Guarded by `test-hosting-safety.ts`:** 15 invariants, covering the trigger,
  permissions, absence of secrets and tokens, allowed actions, credentials, the
  Node pin, `--ignore-scripts`, `tsc`, all six suites, the `react-server`
  condition, and no deploy, cloud, database or network commands.
  - A mutation check ran 10 workflow mutants against them (for example
    `pull_request_target`, `contents: write`, a secret reference, a dropped suite,
    a deploy step, an unpinned Node): **10/10 killed**.

### Actual run (2026-10-24)

| Item | Value |
| --- | --- |
| Run | [40072932680](https://github.com/wberytech-stack/checkbeforeclick/actions/runs/40072932680), event `pull_request`, head `f040dd13031952004019dd062e1d016ffccc5e57` |
| Conclusion | `success`, first attempt; job `offline` 31 s |
| Token permissions (from the log) | `Contents: read`, `Metadata: read` |
| Runtime | `node: v24.14.0` (linux-x64); `npm ci` added 836 packages |
| Steps 1–11 | all `success` (checkout, setup-node, install, tsc, six suites) |
| Suite output | `=== Gate 007A rate limit: 75 passed, 0 failed ===`; `=== Gate 007A provider budget: 54 passed, 0 failed ===`; `=== Gate 007A scan flow: 68 passed, 0 failed ===`; `=== Gate 007A login flow: 30 passed, 0 failed ===`; `=== Gate 007A tenant guard: 21 passed, 0 failed ===`; `125 passed, 0 failed` (hosting and workflow safety) |
| Log lines matching `FAIL` | 0 |

- **Failures found and fixed before the push:**
  1. Two of the new workflow assertions failed locally, because their text
     patterns matched the workflow's own explanatory comments ("Never
     pull_request_target", "No `npx <package>`"). Fix: the text checks now ignore
     YAML comment lines.
  2. An edit script wrote literal newlines into a TypeScript string, and the
     suite failed to parse (`ERR_INVALID_TYPESCRIPT_SYNTAX`). Fix: the line was
     corrected and the suite re-run (125/0).
- **The CI run itself had no failures.**

## Validation (local, offline)

Run with `node --conditions=react-server --disable-warning=MODULE_TYPELESS_PACKAGE_JSON <file>`.

| Check | Result |
| --- | --- |
| `test-rate-limit.ts` | 75 passed, 0 failed |
| `test-provider-budget.ts` | 54 passed, 0 failed |
| `test-scan-flow.ts` | 68 passed, 0 failed |
| `test-login-flow.ts` | 30 passed, 0 failed |
| `test-tenant-guard.ts` | 21 passed, 0 failed |
| `test-hosting-safety.ts` | 125 passed, 0 failed (110 before the CI invariants) |
| Mutation check (13 hand-written mutants of the flow, login, Web Risk and guard code) | 13/13 killed |
| `tsc --noEmit` | exit 0 |
| `eslint` on the changed application files | exit 0 |
| `validate-admission-db.ts` (commit 1, disposable DB) | 40 passed, 0 failed |
| `validate-users-guard-db.ts` | **Not exercised** (needs approval for disposable database work) |

**Not exercised:**
- `next build`;
- any request against a running app;
- the Web Risk header change against Google (ST4);
- migration 002 on any database;
- runtime behaviour on Vercel or Azure.

## Required deployment order (founder)

1. **Close the external blockers:**
   - Google Cloud quota and budget alert;
   - the production RLS verification above;
   - Supabase Auth rate-limit and CAPTCHA settings;
   - the Vercel plan and region.
2. **Staging tests ST1–ST7** on this PR's Preview.
3. **If the RLS verification fails,** or as defence in depth: validate 002 on a
   disposable database, then apply it to staging and then production.
4. **Apply `001_scan_admission.sql` to production** (check its SHA-256), then run
   `NOTIFY pgrst, 'reload schema'`.
   - The current production code ignores the new objects, so this is safe before
     the merge.
5. **Merge PR #45** (this is the Vercel production deployment).
   - **Never merge before step 4:** without the functions every scan fails closed
     with 503.
6. **Post-deploy checks:**
   - one URL scan: one admission and one reservation in SQL;
   - one scan with no link: no reservation;
   - Vercel logs show no 500s or `PGRST202`;
   - the 24-hour ledger counts match Google Cloud's request count.

**Rollback:**
1. Vercel instant rollback of the application. The migrations can stay, because
   the old code works with them.
2. Only then, and only if needed, run `001_scan_admission.down.sql`; it deletes
   both ledgers. Never run it while this code is live: every scan would return
   503.
3. `002_users_identity_guard.down.sql` is independent of the application.

Rolling back the application removes every scan limit; the Google Cloud quota is
then the only cost control.

## Risks and limitations

- **In-memory limiter memory is bounded** (Codex review P2 fix).
  - Each limiter keeps at most `limit` timestamps per key and at most 10,000
    keys, with keys truncated to 320 characters.
  - At capacity, a *new* key is refused with 429 `rate_limiter_at_capacity`
    (fail closed). Tracked keys are never evicted early.
  - The IP is checked first (Codex cycle 2 P1 fix), so each IP can create at most
    10 email buckets per 15 minutes.
- **In-memory limits are per instance.** The burst and login limits are
  multiplied by the number of instances on Vercel's serverless platform, and by
  up to 3× on Azure production (3 replicas).
- **Any signed-in user can call the functions directly** through PostgREST.
  - Each account counts against its own 50 a day, so about 10 accounts can use up
    the global 500 admissions.
  - That would be a denial of service for everyone until the window rolls over.
  - Cost stays bounded.
  - Whether production sign-up is open is unverified.
- **Organization switching:** see "Tenant pointer". It is a pre-existing risk,
  unverified, and potentially critical.
- **Global serialization:** all admissions are serialized. That is negligible at
  500 per day.
- **Admissions are consumed even when the scan later fails.** That is the
  conservative choice.
- **Inngest:**
  - re-runs and events queued before deploy run unpaid providers only, so they
    make no Web Risk request;
  - those scans are never `safe`;
  - Phase 0 recorded 7 scans stuck in `pending`.
- **`X-Forwarded-For` handling** on Vercel and Azure Container Apps must be
  confirmed on staging. The last entry is used.
- **Observability:** only `console.error`. There are no alerts on 503 rates,
  exhausted caps or Web Risk errors.

## Out of scope

- No deployment, Azure or Google Cloud change, Supabase configuration change, or
  migration application by an agent.
- No new dependency or paid infrastructure.
- Sign-up throttling, a database-backed login limiter, and RLS changes beyond
  draft 002.
