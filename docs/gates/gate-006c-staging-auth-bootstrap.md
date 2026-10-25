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
- **Stored credentials are never taken as proof (R1).** Secret values are never read back, so a rerun cannot sign in with stored credentials or check their profiles. When an account's two secrets already exist, the script **stops before any write** unless you choose one of two paths:
  - `-Replace -Generation <N+1>`: signs up a fresh pair, which this run verifies, and overwrites both secrets. Then delete the earlier users in Supabase.
  - `-AttestExisting -OrgIdA <uuid> -OrgIdB <uuid>`: keeps the stored credentials on **your attestation**. The organization ids come from the read-only SQL (step 3.2). The outcome is **ATTESTED**: sign-in and profiles are then verified only by J1–J4 of the first `staging-auth-journeys` run.
- **Half-stored credentials are PARTIAL (R2).** If a signup succeeds but only one of its two secrets is stored, the run ends as **PARTIAL** (exit 3), never as a success. Every later rerun also reports PARTIAL and writes nothing, and `-AttestExisting` cannot cover it.
  - **Recovery:** rerun with `-Replace -Generation <N+1>`, which creates and verifies a fresh account and overwrites both secrets. Then delete the orphaned user (`+cbc-stg-test-<a|b>-g<earlier generation>`) in Supabase.
  - **If the first secret of a pair fails,** nothing is stored for that account, and the run stops (exit 1) with the same advice.
- **Other reruns are safe:** the environment update is a `PUT`, extra deployment branches stop the run rather than being deleted, and every run reports what it created.
- **Allow-lists enforced in code:**
  - **gh:** user, this repository, three staging repository variables, the `staging-auth-test` environment and its branch policy, four secrets, two variables. No workflow command.
  - **HTTPS:** staging Supabase signup, logout, settings and the caller's own `users` row; on the staging app, login, a status probe and sign-out.

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
