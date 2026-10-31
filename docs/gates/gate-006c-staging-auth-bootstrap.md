# Gate 006C: staging auth bootstrap (founder-run)

`scripts/azure-hosting/founder/Initialize-StagingAuthTest.ps1` automates steps 3.1–3.4 of `gate-006c-authenticated-staging-verification.md`:
- the two staging test accounts;
- their organization evidence;
- the `staging-auth-test` environment;
- its four secrets and two variables.

It does **not** dispatch `staging-auth-journeys`. That stays a separate founder approval, and the cleanup (step 3.6) is unchanged.

## Command

Run in Windows PowerShell from a checkout of `master`:

```powershell
gh auth login   # only if `gh auth status` does not show wberytech-stack
.\scripts\azure-hosting\founder\Initialize-StagingAuthTest.ps1 -EmailBase you@yourdomain.com
```

`-EmailBase` is an address you control. The accounts become `you+cbc-stg-test-a-g1@yourdomain.com` and `you+cbc-stg-test-b-g1@yourdomain.com`. Autoconfirm means no mail needs to be opened.

**Founder authentication:** only the GitHub CLI, signed in as `wberytech-stack`, the repository owner who can manage environments and secrets. No Supabase or Azure login is used, and no secret is ever typed or pasted.

## Design decisions

- **No Admin API, no service-role key.** The Supabase Auth Admin API needs a service-role or secret key, and AGENTS.md section 12 forbids `SUPABASE_SERVICE_ROLE_KEY` in new paths. Staging allows email signup with autoconfirm (live check I6), so the accounts are created through the **public Auth signup endpoint** with the staging **public** key. That is the same path a real user takes, and it exercises the profile trigger. Nothing is inserted into `auth.users`. If signup or autoconfirm is off, the script stops and the dashboard route (step 3.1) applies.
- **Organization evidence without privileged reads.** Each new account reads its **own** `public.users` row with its own token:
  - **Readable:** the profile and organization are **observed** (VERIFIED).
  - **Hidden by RLS:** the script confirms the profile exists through the app (the status API answers 403 without a profile, 404 with one). It then requires `-OrgIdA` / `-OrgIdB` from the read-only SQL in step 3.2, and the result is **ATTESTED**.
  - **The same organization** for both accounts stops the run.
- **Credentials:**
  - passwords are 32 characters from a cryptographic random generator, one per account;
  - they are sent only to the signup endpoint, the staging app login, and `gh secret set` over **stdin**, which GitHub encrypts with the environment's public key;
  - they are never printed, never passed as command-line arguments, and never written to a file;
  - the signup session is logged out after use.
- **Fail closed before any write.** The script stops unless:
  - `gh` is signed in as `wberytech-stack` and the repository is exactly `wberytech-stack/checkbeforeclick`;
  - `CBC_STG_NEXT_PUBLIC_SUPABASE_URL` is exactly `https://zgxmvpbvvakpsnzcymsf.supabase.co`;
  - the public key is an **anon** JWT for that ref;
  - the app URL is the staging Container App;
  - staging Auth allows confirmed email signup;
  - no half-stored credential pair exists;
  - if `staging-auth-test` already exists, it is compatible: exactly one required-reviewers rule whose only reviewer is you; deployments restricted to selected branches; no deployment policy other than branch `master`; no protection rule types other than required reviewers, wait timer and branch policy. Anything else stops the run with zero writes, and the message lists what to fix in GitHub, or tells you to delete the environment so the script can create it.
- **Stored credentials are never taken as proof (R1).** Secret values are never read back, so a rerun cannot sign in with stored credentials or check their profiles. When an account's two secrets already exist, the script **stops before any write** unless you choose one of two paths:
  - `-Replace -Generation <N+1>`: signs up a fresh pair, which this run verifies, and overwrites both secrets. Then delete the earlier users in Supabase.
  - `-AttestExisting -OrgIdA <uuid> -OrgIdB <uuid>`: keeps the stored credentials on **your attestation**. The organization ids come from the read-only SQL (step 3.2). The outcome is **ATTESTED**: sign-in and profiles are then verified only by J1–J4 of the first `staging-auth-journeys` run.
- **Half-stored credentials are PARTIAL (R2).** If a signup succeeds but only one of its two secrets is stored, the run ends as **PARTIAL** (exit 3), never as a success. Every later rerun also reports PARTIAL and writes nothing, and `-AttestExisting` cannot cover it.
  - **Recovery:** rerun with `-Replace -Generation <N+1>`, which creates and verifies a fresh account and overwrites both secrets. Then delete the orphaned user (`+cbc-stg-test-<a|b>-g<earlier generation>`) in Supabase.
  - **If the first secret of a pair fails,** nothing is stored for that account, and the run stops (exit 1) with the same advice.
- **Only a confirmed 404 means the environment is absent.** The preflight lookup uses `gh api -i`, so the HTTP status line is visible. It accepts exactly two answers:
  - **absent:** status 404, a nonzero `gh` exit, and the JSON body `{"message":"Not Found"}`;
  - **present:** status 200, `gh` exit 0, and a JSON body naming `staging-auth-test`.

  Anything else stops the run in preflight with zero writes: 401, 403, 500, a CLI or network failure, no status line, a malformed body, or a status that contradicts the exit code. Only a confirmed 404 allows the environment to be created.
- **An existing environment is never overwritten.** The script runs a `PUT` only to **create** an absent environment, because a `PUT` replaces its protections.
  - **Compliant environment:** left untouched, including stricter settings such as a wait timer or self-review prevention.
  - **Compliant but missing the `master` policy** (an earlier interrupted run): the only write is adding that policy.
  - **After any environment write:** the environment is read and validated again before any account is touched.
- **Every run reports what it created.**
- **Allow-lists enforced in code:**
  - **gh:** user, this repository, three staging repository variables, the `staging-auth-test` environment and its branch policy, four secrets, two variables. No workflow command.
  - **HTTPS:** staging Supabase signup, logout, settings and the caller's own `users` row; on the staging app, an unauthenticated `/api/healthz` warm-up, login, a status probe and sign-out.

## Outcomes and exit codes

| Exit | Outcome | Meaning |
| --- | --- | --- |
| 0 | **VERIFIED** | This run signed up and checked both accounts, and observed both organizations |
| 2 | **ATTESTED** | Configuration is complete, but part of it rests on your attestation (`-AttestExisting`, or `-OrgIdA`/`-OrgIdB` because RLS hides the rows). The first `staging-auth-journeys` run verifies it |
| 3 | **PARTIAL** | A user exists with only one of its two secrets stored. Founder recovery is required (above). Do not dispatch `staging-auth-journeys` |
| 1 | **STOP** | A precondition failed. Anything created is listed, and rerunning is safe |

## What it verifies at the end (read-only)

- you are the required reviewer;
- deployments are limited to `master` only;
- the four credential secrets are present;
- `CBC_TEST_A_ORG_ID` and `CBC_TEST_B_ORG_ID` are set, distinct, and equal to the evidence.

## Tests

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/azure-hosting/founder/test-staging-auth-bootstrap.ps1
```

The tests run offline with stateful mocks of `gh` and HTTP. Every call still passes through the real allow-lists.

## Fix: GET requests carried an empty body (first live run)

The first founder-approved live run, from `master` at `e9c2a5f`, stopped in preflight at its first HTTP call (`GET /auth/v1/settings`) with `Cannot send a content-body with this verb-type.` and `Created this run: nothing` (exit 1).

- **Cause:** `Invoke-CbcHttp` declares `[string]$Body = $null`. PowerShell converts `$null` to `''` for a `[string]` parameter, so `if ($null -ne $Body)` was always true and every GET got an empty JSON `StringContent`. Windows PowerShell 5.1 (.NET Framework `HttpClientHandler`) refuses to send content with a GET.
- **Why the tests missed it:** the suite replaces `Invoke-CbcHttp` with a mock, so request construction never ran.
- **Fix:** request construction moved to `New-CbcHttpRequest`. Content is attached only for a non-empty body, and a GET with a body is refused. `Invoke-CbcHttp` is otherwise unchanged: the allow-list is checked first, redirects and cookies stay off, and the 20 s timeout stays.
- **Regression tests:**
  - The HTTP mock now builds every request with the real `New-CbcHttpRequest`, and records a violation for a GET with content, in every scenario.
  - Direct tests cover GET without a body, POST JSON bodies, and the refusal of a GET with a body.
  - A real send on Windows PowerShell 5.1 goes to a closed loopback port, so nothing leaves the machine. A control shows the same runtime refuses a GET with empty content.

## Staging cold-start warm-up

Staging runs at `minReplicas: 0` (`infra/azure/hosting/staging-app.bicep`), so it scales to zero when idle. Unauthenticated GETs of staging `/api/healthz` from idle took 30.1 s and 31.7 s (2026-10-28) and 38.6 s (2026-10-29), against 0.57 s when warm. Every bootstrap request has a 20 s limit, and the first request to the app (the login) comes after an account is signed up and its secrets stored. From idle, that login would time out and leave an account and credentials behind.

- **Warm-up:** the last preflight step, before any write, is `GET https://<staging app>/api/healthz`. It sends no headers, no cookie and no key, and allows up to 90 s.
- **Fail closed:** anything but HTTP 200 stops the run with nothing changed. That covers a timeout, a connection error, a redirect (not followed), or any other status.
- **Unchanged:** every other request keeps the 20 s limit. The allow-list gains exactly `GET /api/healthz` on the staging app host, with no query string.
- **Tests:**
  - the warm-up runs once, before the first write, with a 90 s limit and no headers;
  - every other request uses 20 s;
  - a timeout, 503, 302 or 404 stops the run with zero writes;
  - it is never sent to a host other than the staging app;
  - the allow-list refuses any variation of the URL or method;
  - a source check confirms that only the warm-up passes a non-default timeout.
