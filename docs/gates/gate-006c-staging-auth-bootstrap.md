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
  - no half-stored credential pair exists.
- **Idempotent and safe on partial failure:**
  - **Credentials are stored first.** Each account's credentials are stored immediately after its signup.
  - **Rerun skips finished accounts.** An account whose two secrets exist is not recreated.
  - **An orphaned user stops the run.** A user that exists without stored credentials stops with advice: delete it in the dashboard, or rerun with `-Generation 2`.
  - **The environment update is safe to repeat.** It runs as a `PUT`. Extra deployment branches stop the run rather than being deleted.
  - **The run reports what it created,** and rerunning is always safe.
- **Allow-lists enforced in code:**
  - **gh:** user, this repository, three staging repository variables, the `staging-auth-test` environment and its branch policy, four secrets, two variables. No workflow command.
  - **HTTPS:** staging Supabase signup, logout, settings and the caller's own `users` row; on the staging app, login, a status probe and sign-out.

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
