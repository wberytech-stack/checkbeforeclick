# Gate 007A - Scanner rate limiting and provider-cost protection

## Status

- **Branch and PR:** `gate-007a-scanner-rate-limiting`, draft PR #45 into `master`.
  - First commit: `b0961bf` (base `master@1810aeb`).
  - **Revision 2:** `061e4e6` (login path, scan-flow extraction, Web Risk
    hardening, tenant guard, regression tests), committed and pushed with founder
    approval on 2026-10-23.
  - **CI:** `f040dd1` adds the read-only pull-request validation workflow (see
    "Continuous validation"). Founder instruction, 2026-10-24.
  - **Review round 1:** independent ChatGPT review of `19d22ff` (PR #45 review,
    2026-10-24T07:16Z): **changes required**. The founder's execution handoff
    (PR #45 comment, 2026-10-24T07:30Z) followed it. The response is in
    "Review round 1 response", next section. **Release remains blocked.**
  - **Review round 2:** ChatGPT review of `984c2b8` (founder-relayed,
    2026-10-24): **recommend_changes**, with two in-scope required changes
    (CBC-007A-R1-01, CBC-007A-R1-02). The response is in "Review round 2
    response".
  - **Review round 3:** ChatGPT review of `74baf27` (founder-relayed,
    2026-10-24): **recommend_changes**, with one in-scope required change
    (CBC-007A-R2-01). The paid-provider cancellation contract was assessed as
    "materially improved". The response is in "Review round 3 response".
- **Not merged and not deployed.** Merging into `master` is a Vercel production
  deployment.
- **Migrations:**
  - `001_scan_admission.sql` is **applied to Supabase staging only**
    (`zgxmvpbvvakpsnzcymsf`), by the founder; see "Staging validation". It is not
    applied to production.
  - `002_users_identity_guard.sql` is a **draft, applied to no real database**.
    It was validated on a disposable local database on 2026-10-24: 17/17, plus a
    negative control (see "Review round 1 response", item 3).
    - The file's header comment still says "not yet validated". The file is left
      byte-identical to the reviewed commit (AGENTS.md section 9: never edit an
      existing migration). This document is authoritative.
  - Applying either to a real database is founder-only (AGENTS.md sections 6.3
    and 9).
- **Approval:** founder-approved design and limits, 2026-10-22. Revision 2 was
  requested by the founder on 2026-10-23 for local edits and offline tests only.

## Review round 1 response (2026-10-24)

The items are numbered as in the founder's handoff. Each item says what the
repository now does, the evidence, and what stays external.

### 1. Scan contract (`master@1810aeb` compared with this PR)

**Finding: input-type handling did not change. Only the timing did.** On
`master`, the worker already reduced email, header, signature and batch input to
the first URL:
- `processScan` called `normalizeScanTarget(raw_input, input_type)`, which
  extracts the first `http(s)://` URL for those types and returns `ok: false`
  when there is none;
- with no URL, the scan completed as `unknown` with `invalid_target`;
- with a URL, it ran `getFastProviders("url")`, the same Web Risk and domain-age
  providers as the URL fast path;
- the `getAsyncProviders` branch was unreachable, and **no async provider exists**
  (both providers declare `path: "fast"`).

So "every input becomes its first URL" is `master` behaviour, preserved, not
introduced by this PR.

| Aspect | `master@1810aeb` | This PR |
| --- | --- | --- |
| url / domain | synchronous in `/api/scan`; 201 `{scan_id, status: "complete", verdict}` | unchanged, plus admission and Web Risk reservation |
| email / header / signature / batch | `inngest.send("scan/requested")`; 201 `{scan_id}`; scan `pending` → worker | synchronous in `/api/scan`; 201 `{scan_id, status: "complete", verdict}` |
| What is scanned for those types | first `http(s)` URL; none → `unknown` | **identical** (the same `normalizeScanTarget`) |
| Providers for those types | Web Risk + domain age, **in the worker, unreserved** | Web Risk (reserved, at most once) + domain age, in the request |
| Queue failure | 502 and the scan marked failed | not applicable (nothing queued) |
| Retries | Inngest `retries: 1`: a retry **re-called Web Risk** | none in the request; the worker never calls paid providers |
| Time limit | worker step: none of ours; route: platform default | provider phase deadline **20 s** → 504 + scan failed; route `maxDuration = 30` |
| UI (`app/(dashboard)/scan/new`) | reads only `scan_id`, opens `/scan/[id]` | unchanged (test X07). A 201 is already terminal; 503/504 bodies carry `scan_id` (tests U01–U02) |
| Result page `/scan/[id]` | polls `/api/scan/[id]/status` while `pending`/`processing` (30 s) | unchanged and still needed for scans queued before the deploy (test X08) |
| UI sends | `url`, `email`, `header` (domain/signature/batch are API-only) | unchanged |

**Fixes made in this round:**
- **Worker contract extracted and tested.** The logic moved to
  `lib/scan/workerFlow.ts`; `inngest/functions/processScan.ts` is now an adapter.
  `test-worker-flow.ts` has 34 checks: every input type, no-link and private
  targets, empty provider list, pending/processing/null status, error → failed +
  rethrow, retry after failure, missing id or organization, and the wiring.
- **Real defect fixed: worker replays.** On `master`, a replayed or re-run
  `scan/requested` event for a finished scan re-processed it. That appended
  duplicate evidence and, after this gate, would have overwritten a Web
  Risk-backed verdict with an unpaid-only one.
  - The worker now skips scans that are already `complete` or `failed`.
  - `loadScanForProcessing` returns `status` for this.
- **Pending-state handling in the request.**
  - A provider-phase deadline of 20 s (`PROVIDER_PHASE_DEADLINE_MS`) marks the
    scan failed and returns 504 `scan_timeout`. A hung reservation RPC or
    provider can no longer outlive `maxDuration` and leave the scan in
    `processing`.
  - Tests D01–D03.
- **Residual risk:** a platform kill before `failScan` runs (for example, a hung
  Supabase write after the deadline) still leaves a scan `processing`. The result
  page stops polling after 30 s. There is no sweeper; that is a candidate for a
  later gate.

**Founder-level change request FCR-007A-1 (decision needed, nothing implemented
for it).** The founder-approved budget design (2026-10-22) makes every paid call
inside the signed-in request. A reservation needs the user's own session and an
admission no more than 10 minutes old, and the worker has neither. The options:

| Option | Effect | Cost |
| --- | --- | --- |
| **A. Keep synchronous for all types** (this PR) | Same inputs scanned as on `master`; Web Risk still checked for email/header, now budgeted; no queue dependency | Request latency includes the provider phase (deadline 20 s); measured latency is a staging item (ST6) |
| B. Restore async for email/header/signature/batch, unpaid providers only | Old response shape (`{scan_id}`, pending) | **Detection regression:** Web Risk would never run for those types, so they could never be `safe` |
| C. Restore async with worker-side reservations | Old shape and Web Risk | The worker has no user session: it needs a service-role or definer path for reservations (deepens AGENTS.md section 12) and a new design. That is a new gate |

Recommendation: **A**. If the founder wants B or C, that is a scoped
architecture decision recorded in a gate, not an in-gate review fix.

### 2. Client IP and login throttling

**Evidence (official documentation, read 2026-10-24):**
- **Vercel** (vercel.com/docs/headers/request-headers): Vercel will "overwrite
  the X-Forwarded-For header and do not forward external IPs" (stated for the
  proxy case, "to prevent IP spoofing"). X-Forwarded-For is documented as "the
  public IP address of the client that made the request".
- **Azure Container Apps** (learn.microsoft.com/azure/container-apps/ingress-overview):
  X-Forwarded-For "is appended to", and "Only the rightmost IP is provided by
  Azure Container Apps". Other values "must be validated by the user to prevent
  IP spoofing".
- **Azure Front Door** (learn.microsoft.com/azure/frontdoor/front-door-http-headers-protocol):
  Front Door appends the client socket IP to X-Forwarded-For. **Not documented:**
  what the rightmost entry is at an app behind Front Door + Container Apps. It is
  probably Front Door's egress address.

**What the code does:**
- It uses the **rightmost** X-Forwarded-For entry. That rule is supported by the
  documentation for **Vercel** and for **Container Apps without another proxy**.
- `normalizeIp` (new) accepts only a well-formed IPv4 address (an optional port is
  stripped) or IPv6 address (lower-cased, brackets and port stripped). Anything
  else maps to the shared `unknown` bucket. Test G09.
- **Unsafe assumption rejected:** behind Azure Front Door, or any other proxy, the
  rightmost entry is not the client. **An Azure deployment with Front Door must
  change this derivation first**, for example to a validated `X-Azure-ClientIP`.
  That is a release precondition for that topology, recorded in the dossier.
- **Runtime proof is a staging item (ST8):** confirm on the Preview that a forged
  leading X-Forwarded-For entry does not change the bucket.

**What the limits are and are not:**
- The 10 per IP and 5 per email per 15 minutes are **per server instance,
  best-effort**. They are not a global guarantee, and the documentation says so.
- Direct calls to Supabase Auth with the public anon key bypass them entirely.
- **Shared enforcement is a founder decision.** It is needed only if the product
  requires strict cross-instance caps. It would need either a database-backed
  limiter (a new migration and an `anon`-callable pre-auth function, with its own
  abuse analysis) or a shared store (new infrastructure, a dependency change).
  Not implemented.
- **Supabase Auth's own per-IP limits, CAPTCHA and sign-up policy are the real
  outer boundary.** Their production values are unverified and are a release
  blocker.

### 3. Migration 002 on a disposable database

- **Environment:**
  - `public.ecr.aws/supabase/postgres:17.6.1.121`, bound to `127.0.0.1:55472`,
    with a random session-only password;
  - the container was removed afterwards and the password file deleted.
- **Fixture** (`scripts/rate-limit/fixtures/users-guard-fixture.sql`, run as
  `supabase_admin`):
  - `organizations` and `users`, with `users.id` referencing
    `auth.users ON DELETE CASCADE`;
  - `handle_new_user` (SECURITY DEFINER, owned by `postgres`), fired by
    `on_auth_user_created`;
  - Supabase default grants;
  - a **deliberately permissive** self-update policy;
  - a user-callable definer function.
- **002 was applied as `postgres`,** the non-superuser role the Supabase SQL
  editor uses.
- **`validate-users-guard-db.ts`: 17 passed, 0 failed.**
  - The guard is installed, is not a definer function, and cannot be executed by
    `anon` or `authenticated`.
  - Sign-up through `auth.users` as `supabase_auth_admin` still provisions the
    user through `handle_new_user`.
  - A signed-in user cannot change `organization_id`, `role` or `id`, or
    insert or delete a `users` row (42501). Editing `full_name` and no-op writes
    still work.
  - `anon` is blocked.
  - `service_role` and `postgres` can still change identity columns.
  - Deleting the auth user still cascades.
  - **Limitation confirmed (U17):** a user-callable SECURITY DEFINER function
    owned by `postgres` can still move a user. Production must be checked for
    such functions (read-only SQL, item 3 in the verification list below).
- **Negative control:**
  - with `002…down.sql` applied, the same signed-in request moved the user to
    another organization and set `role = 'owner'` (1 row changed);
  - with 002 re-applied, it was refused: "cbc: id, organization_id and role on
    public.users cannot be changed by authenticated".
- **Idempotence:** 002 was applied twice after the rollback without error; the
  validator still passed 17/17.
- **The fixture models the documented production shape;** the production DDL is
  not in the repository. **Applying 002 to staging or production remains a
  separate founder decision,** after the read-only production checks.

### 4. CI

- Actions are pinned to immutable commits:
  - `actions/checkout@11d5960a326750d5838078e36cf38b85af677262` (v4.4.0);
  - `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (v4.4.0).

  These are GitHub-verified commits, identical to the commits `v4` resolved to
  during the earlier green runs.
- **Controlled build added:**
  - **The step:** `next build`, last in the job, with only
    `NEXT_TELEMETRY_DISABLED=1`.
  - **Proven secret-free first:** a clean worktree with **no `.env*` file and no
    Supabase variables**, after `npm ci --ignore-scripts`, built with exit 0 and
    generated all 13 static pages. The `package.json` and `package-lock.json`
    hashes were unchanged.
- **Suites:** the worker-flow suite was added, so there are now seven offline
  suites.
- **Invariants in `test-hosting-safety.ts` (now 129 checks):**
  - every action is SHA-pinned to the reviewed commit, with no movable reference;
  - `next build` runs exactly once, last;
  - the only environment variable anywhere is the telemetry flag on the build
    step;
  - seven suites; the `react-server` condition for scan and worker flow.

  A mutation check of 13 mutants across code and workflow killed 13/13.
- **Still founder-only:**
  - making `pr-validate / offline` a **required status check** (a GitHub
    settings change);
  - pinning the other workflows (`azure-deploy.yml`, `state-reconcile.yml`),
    which belong to other gates and, for the deploy workflow, to deploy
    configuration.
- **A green offline CI run is not release proof.**

### 5. Release dossier: status of every release condition

None of these can be completed by an agent. Each needs the founder or operator.
**All are unverified until evidence is recorded here.**

| # | Condition | Owner | Status | Evidence required |
| --- | --- | --- | --- | --- |
| R1 | Google Cloud: daily Web Risk quota and budget alert on the key; ideally separate or rotated Production/Preview keys | Founder | **Unverified, blocker** | Screenshot or export of the quota value and budget alert |
| R2 | Production read-only RLS checks (`users`/`organizations` policies, grants, definer functions, `handle_new_user` body) | Founder (SQL editor) | **Unverified, blocker** | Query output per "Production facts that need read-only verification" |
| R3 | Supabase Auth: sign-in rate limits, CAPTCHA, sign-up policy (production) | Founder | **Unverified, blocker** | Dashboard values |
| R4 | Vercel plan supports `maxDuration = 30`; function region relative to the Supabase region | Founder | **Unverified, blocker** | Plan page; project region setting |
| R5 | Staging ST1–ST8 on the PR #45 Preview | Founder/operator | **Not run, blocker** | Per-test results and SQL counts |
| R6 | One explicitly budgeted Web Risk request to prove the `X-Goog-Api-Key` header (ST4) | Founder approval, then run | **Not run, blocker** | A real Google result (not `API error 401/403`) and ledger counts |
| R7 | Migration 001 on production **before** merge: SHA check, backup or point-in-time-restore confirmation, apply, `NOTIFY pgrst, 'reload schema'`, verification queries | Founder/operator | **Not done, blocker** | Backup reference; apply log; function and grant queries |
| R8 | Decision on migration 002 (apply to staging, then production, or not) after R2 | Founder | **Open** | Recorded decision; staging validation if applied |
| R9 | FCR-007A-1 (sync vs async for email/header) | Founder | **Open** | Recorded decision |
| R10 | Topology for Azure: Front Door changes client-IP derivation | Founder | **Open (Azure only)** | Recorded decision before any Azure release with Front Door |
| R11 | Fresh independent review of the final diff | Founder relays | **Requested** | `.agents/chatgpt-review.yaml` |

**Rollback after migration 001 (unchanged):**
1. Vercel instant rollback first (the old code works with 001 applied).
2. Then, only if required, `001…down.sql`, which deletes both ledgers.

Never run it while this code is live.

## Review round 2 response (2026-10-24)

**CBC-007A-R1-01: cancel the provider phase at the deadline.**

The finding was correct: `Promise.race` returned the 504 but left the reservation
RPC and any provider request running. A grant arriving after the deadline could
still have started a paid request.

What the code does now:
- **`lib/scan/scanFlow.ts`:**
  - each scan creates an `AbortController` for its provider phase;
  - when the deadline fires, it aborts the controller **before** marking the scan
    failed and returning 504;
  - providers that have not started yet do not start;
  - after a 504 nothing is persisted, so late results cannot change the terminal
    `failed` status.
- **`lib/security/providerBudget.ts`, `guardedPaidCall` contract item 4:**
  - signal already aborted: no reservation and no request;
  - signal aborted while the reservation is in flight: the signal reaches the
    RPC, and a grant that arrives later is **not used** (`deadline_exceeded`; the
    unit may be consumed, but the request is never made);
  - signal aborted after a grant: no request;
  - during the request: the signal reaches `call()`.
  - Exactly-once is unchanged: at most one reservation attempt and at most one
    request per admission, with no retry.
- **`app/api/scan/route.ts`:** the reservation RPC is cancellable over HTTP
  (`.abortSignal(signal)`, supported by `@supabase/postgrest-js` 2.106.1).
  - A reservation the database commits anyway is harmless, because the guard
    re-checks the signal before any request.
- **`lib/scan/providers/googleWebRisk.ts`:** the deadline signal is linked to the
  request's own `AbortController`, alongside its 7 s timeout. An in-flight Web
  Risk request is aborted, not abandoned.
- **Not cancellable:** unpaid providers that are already running (domain age).
  `ScanProvider.run()` takes no signal. They are bounded by their own 7 s
  timeouts, and their results are discarded.

**CBC-007A-R1-02: tests.**
- **`test-scan-flow.ts` C10–C21.** These use a deadline fired by the test and
  deferred promises, so the ordering is exact. They cover:
  - a reservation in flight at the deadline that is then granted late: no paid
    request (C13);
  - the RPC's signal is aborted (C12);
  - terminal status preserved after late results: nothing persisted, failed once
    (C14);
  - no verdict and nothing stored, so no false "safe" (C15);
  - exactly once (C16);
  - an in-flight request aborted through its signal, with no second request
    (C17–C19);
  - a late refusal changes nothing (C20);
  - a control case where nothing is aborted when the scan finishes in time
    (C21).
- **`test-provider-budget.ts`:**
  - B21–B25 test the guard: aborted before, during and after the reservation; the
    signal is forwarded; behaviour is unchanged without a signal;
  - S19 checks the static wiring: abort before `failScan`, RPC
    `.abortSignal`, the Web Risk link.
- **Mutation check:** 9/9 mutants of the cancellation code were killed (each abort
  check, signal forwarding, abort order, Web Risk link, RPC abort).

**Not addressed by code:** the reviewer's third finding (live release
prerequisites unverified) is correct and unchanged. Release dossier R1–R11 stays
open.

## Review round 3 response (2026-10-24)

**CBC-007A-R2-01: an abortable RDAP timeout in `lib/scan/providers/domainAge.ts`.**

The finding was correct. `Promise.race` against a 7 s timer returned the timeout
result but never aborted `fetch`, and it never cleared the timer.

What the code does now:
- **`lookupDomainAge()`** (exported for tests) creates an `AbortController`,
  passes its signal to `fetch`, and aborts it after 7 s. The signal also covers
  reading the response body.
- **The timer is cleared in `finally`.**
- **An abort is reported as the provider's existing error,** "Domain age check
  timed out" (`verdict: "error"`, `error: "Timeout"`). It can never make a scan
  `safe`, because domain age is a required provider.
- **Other network errors** stay "could not complete".
- **`run()`** calls `lookupDomainAge(domain)`. `Promise.race` is gone.
- **Privacy is unchanged:** only the registerable domain is sent.

**Tests: `scripts/rate-limit/test-domain-age.ts`, 13 checks.** Fake `fetch`
implementations reject when their signal aborts, like the real `fetch`. They
cover:
- a hanging request receives the abort and returns at the timeout (A01–A04);
- a slow response body is aborted (A05);
- the timer is cleared on success, so there is no late abort (A06);
- a non-abort network error is not misreported (A07);
- `run()` uses the abortable path and sends only the domain (A08–A09);
- static checks (S01–S04).

The suite runs in CI as the eighth suite (`--conditions=react-server`), and
`test-hosting-safety.ts` enforces it (130 checks).

**Mutation check:** 6/6 mutants killed (signal not passed, timer not cleared,
abort misreported, timer never aborting, option ignored, `run()` bypassing the
lookup).

**Harness defect found and fixed.** The first mutation run let two mutants
survive. A promise that never settles made Node exit with **code 0** before
`main()` reached `process.exit(1)`.
- The four suites with an async `main()` (scan flow, login flow, worker flow,
  domain age) now fail any run that does not finish ("harness did not finish").
- The provider-budget suite uses top-level await, which Node already fails (exit
  13) when unsettled.

**Also unchanged:** dossier R1–R11 and FCR-007A-1 remain open.

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
| ST8 | Two sign-in attempts with different forged leading `X-Forwarded-For` entries (wrong password) | Both count against the same per-IP bucket (the rightmost entry is the client) |

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
| `scripts/rate-limit/validate-users-guard-db.ts` | **Rev 2, new; round 1:** auth.users sign-up, service role, cascade, definer limitation; run: 17/17 |
| `scripts/rate-limit/fixtures/users-guard-fixture.sql` | **Round 1, new:** disposable-database fixture for 002 |
| `lib/scan/workerFlow.ts` | **Round 1, new:** pure worker flow (skips terminal scans, never runs paid providers) |
| `inngest/functions/processScan.ts` | Commit 1: unpaid only; **round 1:** adapter over `workerFlow` |
| `lib/data/index.ts` | **Round 1:** `loadScanForProcessing` also returns `status` |
| `lib/security/rateLimit.ts` | **Round 1:** `normalizeIp`, documented platform evidence |
| `scripts/rate-limit/test-worker-flow.ts` | **Round 1, new:** worker contract tests |
| `lib/scan/providers/domainAge.ts` | Commit 1: 7 s timeout; **round 3:** `AbortController`-backed RDAP timeout (`lookupDomainAge`) |
| `scripts/rate-limit/test-domain-age.ts` | **Round 3, new:** RDAP cancellation tests |
| `docs/gates/gate-007a-scanner-rate-limiting.md` | This document |
| `.github/workflows/pr-validate.yml` | **CI, new:** read-only pull-request validation |
| `scripts/azure-hosting/test-hosting-safety.ts` | **CI:** invariants for `pr-validate.yml` (19 after round 1) |

## Continuous validation (`.github/workflows/pr-validate.yml`)

- **Trigger:** `pull_request` into `master` only. Never `pull_request_target`,
  `push` or dispatch.
- **Permissions:** `contents: read`, at the workflow level and the job level.
- **No secrets:** no secrets, repository variables, GitHub environment or cloud
  credentials.
- **Checkout:** `persist-credentials: false`. Only `actions/checkout` and
  `actions/setup-node` are used. **Round 1:** both are pinned to immutable commit
  SHAs (v4.4.0).
- **Steps:**
  1. Node 24.14.0;
  2. `npm ci --ignore-scripts --no-audit --no-fund`;
  3. `tsc --noEmit -p tsconfig.json`;
  4. the eight offline suites (rate limit, provider budget, scan flow, worker
     flow and domain age with `--conditions=react-server`, login flow, tenant
     guard, hosting and workflow safety; worker flow added in round 1, domain age
     in round 3);
  5. **round 1:** `next build` (no secrets, telemetry off).
- **What it never does:** it deploys nothing and makes no database, Supabase,
  Google, Vercel or Azure call. The disposable-database validators and the smoke
  test are excluded, and a test asserts this.
- **Guarded by `test-hosting-safety.ts`:** the invariants cover the trigger,
  permissions, absence of secrets and tokens, allowed actions, SHA pins,
  credentials, the Node pin, `--ignore-scripts`, `tsc`, all suites, the
  `react-server` condition, the build step and its environment, and no deploy,
  cloud, database or network commands.
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
Results after review round 1 (the CI run for the round-1 commit is recorded in
PR #45 and `.agents/claude-handoff.yaml`, since a commit cannot cite its own run):

| Check | Result |
| --- | --- |
| `test-rate-limit.ts` | 76 passed, 0 failed (75 before round 1) |
| `test-provider-budget.ts` | 60 passed, 0 failed (54 before round 2) |
| `test-scan-flow.ts` | 85 passed, 0 failed (73 before round 2, 68 before round 1) |
| `test-login-flow.ts` | 30 passed, 0 failed |
| `test-worker-flow.ts` | 34 passed, 0 failed (new in round 1) |
| `test-domain-age.ts` | 13 passed, 0 failed (new in round 3) |
| `test-tenant-guard.ts` | 21 passed, 0 failed |
| `test-hosting-safety.ts` | 130 passed, 0 failed (129 before round 3, 125 before round 1, 110 before CI) |
| Mutation checks | Revision 2: 13/13; CI: 10/10; round 1 (worker, deadline, IP, workflow): 13/13; round 2 (cancellation): 9/9; round 3 (RDAP timeout): 6/6 |
| `tsc --noEmit` | exit 0 |
| `next build` | exit 0 locally, and exit 0 in a clean worktree with no `.env*` file and no Supabase variables |
| `eslint` on the changed application files | exit 0 |
| `validate-admission-db.ts` (commit 1, disposable DB) | 40 passed, 0 failed |
| `validate-users-guard-db.ts` (round 1, disposable DB) | **17 passed, 0 failed**, plus a negative control and an idempotence check |

**Not exercised:**
- any request against a running app (Preview or production);
- the Web Risk header change against Google (ST4);
- migration 002 on any real database;
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
