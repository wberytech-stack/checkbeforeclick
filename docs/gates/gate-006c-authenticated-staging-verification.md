# Gate 006C: authenticated staging verification (plan, tooling, founder actions)

Status: tooling prepared on a gate branch. Nothing here has run against staging.

- No test account exists.
- No secret is configured.
- No authenticated run has taken place.

Every live step below is founder-only.

## 1. What the audit found (repository evidence, 2026-10-25)

| Area | Finding | Source |
| --- | --- | --- |
| Sign-in | The app signs in through `POST /api/auth/login` (`signInWithPassword`). It sets the `@supabase/ssr` 0.10.3 session cookie `sb-<ref>-auth-token`, which may be chunked as `.0`, `.1`, with value `base64-` plus base64url(JSON) | `app/api/auth/login/route.ts`, `@supabase/ssr` |
| Sign-out | `GET /auth/signout` calls `supabase.auth.signOut()` and redirects to `/login` | `app/auth/signout/route.ts` |
| Tenant boundary | The **organization**. Every read filters on `organization_id` from `users.organization_id` | `lib/data/index.ts`, `app/api/scan/**` |
| App data access | **Service role** (`createPrivilegedClient`), which **bypasses RLS**. App-level isolation therefore relies on code, not RLS | `lib/data/client.ts`, `lib/data/index.ts` |
| Direct data access | Any signed-in browser user holds the public key plus their own session token and can query the Supabase data API directly. **Only RLS protects that path**, and the repository records no Supabase RLS policies. `infra/db` is the future Azure PostgreSQL | repository search |
| Profiles | A user without a `users` row and organization gets 403 "User profile not found". How Supabase creates that row (a trigger?) is not in the repository | `getUserOrgContext` |
| Scans and Web Risk | `url`/`domain` scans run inline. Other types call `inngest.send(...)`. A `localhost` URL is rejected by `normalizeScanTarget` and completes `unknown` **before any provider runs**: no Web Risk, no RDAP, no Inngest event | `app/api/scan/route.ts`, `lib/security/urlSafety.ts` |
| Staging Auth settings | Email provider **enabled**, signup **enabled**, email autoconfirm **on** | live check I6, [run 40183184495](https://github.com/wberytech-stack/checkbeforeclick/actions/runs/40183184495) |
| Inngest | An unsigned GET returns 401, so the app is in cloud mode. The branch environment is visible only to a signed introspection, which needs the signing key | live check I8; `inngest` 4.4.0 |

## 2. Verification matrix

| ID | Check | Category | How |
| --- | --- | --- | --- |
| I1–I8 | Identity, inspected `/login` assets, Supabase Auth health and settings, anon data API (zero rows), Inngest signature enforcement | **Automated** (passed in run 40183184495) | `staging-verify` |
| U1 | `INNGEST_ENV=audit/azure-current-state` and `INNGEST_SERVE_ORIGIN` equal to the staging origin | **Configuration-guarded at every staging deploy** (new) | `staging-guard.mjs` checks the compiled template, the what-if and the live app config (origin equals ingress FQDN). This proves the **configuration** only, **not** that the app is registered in Inngest Cloud, synced, or that functions execute there (U7). No signing key, no sync, no event |
| U2 | `WEB_RISK_PROVIDER_ENABLED=false`, no Web Risk key | **Automated at every staging deploy** | existing template and config checks |
| J0–J12 | **Prerequisites before any data:** staging identity, distinct accounts and distinct founder-attested organizations (J0); both accounts sign in to staging only (J1–J2) and reach `/dashboard` (J3); distinct organizations observed from each account's own `users` row where RLS allows, otherwise reported **ATTESTED** (J4). **Then:** one localhost scan (J5); status (J6); history (J7); B cannot read A's scan through the app (J8 status API, J9 page); B sees no cross-tenant rows through the data API with its own token (J10); sign-out with the old session replayed and rejected (J12) | **Requires founder approval** (test accounts, a protected environment, each run) | `staging-auth-journeys` workflow |
| J11 | The owner's own data-API read of the scan | **Observed only** (reported, never fails) | same run |
| U3 | Supabase Auth redirect URL allow-list and site URL | **Requires founder action** (read-only) | section 4 |
| U5 | RLS policies themselves, every table and policy | **Unverified** | J9 proves only that B cannot read A's rows in the probed tables. Policy review: section 4 |
| U6 | Client assets beyond `/login` and its directly referenced scripts | **Unverified** | not inspected |
| U7 | Inngest execution (process-scan run in the branch environment) | **Blocked** (kept separate) | needs an app sync and an event, which is a separate approval |
| U8 | Write isolation: B inserting or updating rows of A's organization through the data API | **Blocked** (not in the first run) | a write probe could create data if RLS is missing. Needs its own approval and cleanup |
| P1 | Production Supabase Auth settings (signup, autoconfirm, redirect allow-list) and RLS | **Unverified** | production is out of scope here. See section 6 |

## 3. Founder actions for the first authenticated staging run

Steps 1–4 can be done in one founder-run, idempotent command: see [`gate-006c-staging-auth-bootstrap.md`](gate-006c-staging-auth-bootstrap.md). It never dispatches a workflow.

All of these are in the **staging** Supabase project `zgxmvpbvvakpsnzcymsf` and in GitHub. Nothing touches production.

1. **Create two test accounts** in staging Supabase (Authentication → Users → Add user, with "Auto Confirm User" ticked). Use dedicated addresses, for example `cbc-stg-test-a@<your domain>` and `cbc-stg-test-b@<your domain>`, with strong, unique passwords that are used nowhere else.
2. **Make sure each account has its own organization, and record the evidence.** In the staging SQL editor (read-only):

   ```sql
   select id, organization_id from public.users where id in ('<A user id>', '<B user id>');
   ```

   Two rows are required, each with an `organization_id`, and the two must differ. If the rows are missing, sign in once through the staging UI with each account and check again. If they share an organization, stop.

   This founder evidence is required by the run (J0). J4 confirms it by observation **only** if RLS lets each account read its own `users` row; otherwise the run reports J4 as **ATTESTED** and does not claim to have proven it.

3. **Create the GitHub environment `staging-auth-test`** (repository Settings → Environments) **before adding any secret**:
   - required reviewer: you;
   - deployment branches: `master` only.
4. **Add to the environment:**
   - **secrets:** `CBC_TEST_A_EMAIL`, `CBC_TEST_A_PASSWORD`, `CBC_TEST_B_EMAIL`, `CBC_TEST_B_PASSWORD`;
   - **variables:** `CBC_TEST_A_ORG_ID`, `CBC_TEST_B_ORG_ID`, the two `organization_id` values from step 2.

   They go in the environment only, never at repository level.

5. **After PR review and merge, dispatch once:**

   ```bash
   gh workflow run staging-auth-journeys.yml --repo wberytech-stack/checkbeforeclick --ref master
   ```

   Approve the `staging-auth-test` gate. The run signs in twice, creates **one** localhost scan owned by A, and signs both accounts out.
6. **Clean up** with the verify-then-delete script
   [`docs/gates/sql/gate-006c-staging-test-scan-cleanup.sql`](sql/gate-006c-staging-test-scan-cleanup.sql),
   run in the **staging** SQL editor. Fill in three values first:
   - the scan id and run id, both printed under "Test data created by this run";
   - account A's user id, from step 3.2.

   **Before deleting anything, inside one transaction,** it checks:
   - exactly one scan with that id, owned by A, in A's organization, of type `url`,
     whose `raw_input` is exactly `http://localhost/cbc-staging-journey/<run id>`;
   - exactly 1 `evidence_items` row and 0 `vendor_results` rows for it, in the same
     organization.

   It then deletes only those rows, and each delete must remove exactly the expected
   count. **Any mismatch raises an exception, so nothing is deleted** and the final
   `COMMIT` ends as a rollback. On success it prints the notice
   `cleanup ok: scans 1, evidence_items 1, vendor_results 0`.

   If the run output shows **"scan of unknown id"** instead (the scan request failed
   after the row may have been written), first find it with this read-only query, then
   use the script with the id it returns. If the query returns no row, there is nothing
   to clean up.

   ```sql
   select id from public.scans
    where user_id = '<account A user id>'
      and raw_input = 'http://localhost/cbc-staging-journey/<run id>';
   ```

The test accounts can stay for later runs. Delete them in Authentication → Users when they're no longer needed.

## 4. Read-only founder checks

**U3, redirect allow-list and site URL.** Either:
- open Supabase Dashboard → staging project → Authentication → URL Configuration, and record the Site URL and the Redirect URLs; or
- read them through the Supabase Management API with a personal access token, which stays on your machine:

```bash
curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  https://api.supabase.com/v1/projects/zgxmvpbvvakpsnzcymsf/config/auth \
  | jq '{site_url, uri_allow_list, disable_signup, mailer_autoconfirm, external_email_enabled}'
```

**Expected:**
- the site URL is the staging origin `https://ca-cbc-web-stg-cc-001.lemonmeadow-5efc7b91.canadacentral.azurecontainerapps.io`;
- the allow-list contains `<that origin>/auth/callback`, with no production origin and no wildcard that matches production.

**Autoconfirm and signup (decision).** Staging currently allows **public signup with email autoconfirm**: anyone who finds the staging URL can create a confirmed account and run scans. Web Risk is disabled on staging, so scans cost nothing paid, but they use staging resources and Supabase quota. Decide whether that is intended. Options:
- keep it, and accept the exposure for staging only; or
- disable signup and create test accounts manually (step 3.1 already does).

That is a founder-only settings change and is not made here.

**U5, RLS policy review (read-only, staging SQL editor):**

```sql
select c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' order by 1;
select schemaname, tablename, policyname, roles, cmd, qual, with_check
  from pg_policies where schemaname = 'public' order by tablename, policyname;
```

Share the output for review. Every table holding tenant data (`scans`, `evidence_items`, `vendor_results`, `users`, and any others) should have RLS enabled and policies scoped to the caller's organization.

## 5. Safety properties of the tooling

- **Fails closed, and no scan is created, unless all of these hold:**
  - staging and production are distinguishable (I1/I2);
  - credentials are present, A and B are different accounts, and the attested organizations are distinct UUIDs;
  - both sign-ins succeed with a staging session and no production cookie;
  - both accounts reach `/dashboard`;
  - J4 shows no conflict: an observed organization that differs from the evidence, or A and B observed in the same organization, stops the run.
- **Cleanup evidence is kept:** a created scan, or a possibly created one, is recorded when the scan response arrives. It is printed with the run id even if later checks fail or the script throws.
- **Request allow-list:**
  - GET anywhere on the staging app;
  - POST only to `/api/auth/login` and `/api/scan`;
  - GET/HEAD only on `/rest/v1/{scans,evidence_items,vendor_results,users}` of the staging project;
  - https only, no redirects, a 20 s timeout, no retries.
- **No paid or async work:** the only scan is a `localhost` URL scan, which completes before any provider runs. No Web Risk, no RDAP, no Inngest event, no Inngest sync.
- **No secrets in output:** passwords, emails, cookies and tokens never appear. Evidence goes through the same sanitizer as `staging-verify`, and secrets are also masked by GitHub. The scan id (a UUID) is printed for cleanup.
- **Separate from automatic runs:** `staging-auth-journeys` is `workflow_dispatch` only and is never called by `azure-deploy` or `staging-verify`.

## 6. Production-release blockers surfaced (for R1)

- **Production RLS and Auth settings are unverified** (signup, autoconfirm, redirect allow-list). The app bypasses RLS through the service role, so the data API's RLS is the only barrier against a signed-in user reading other tenants' data directly. A production RLS review (the section 4 queries against the production project, read-only and founder-run) should precede release.
- **Staging public signup with autoconfirm** is a staging exposure, not a production blocker. Production's own setting is unknown (P1).
