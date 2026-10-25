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
| U1 | Inngest branch environment `audit/azure-current-state` and serve origin equal to the staging origin | **Automated at every staging deploy** (new) | `staging-guard.mjs` checks the compiled template, the what-if and the live app (origin equals ingress FQDN). No signing key, no sync, no event |
| U2 | `WEB_RISK_PROVIDER_ENABLED=false`, no Web Risk key | **Automated at every staging deploy** | existing template and config checks |
| J0–J11 | Sign-in (A, B); authenticated `/dashboard`; one localhost scan; status; history; B cannot read A's scan through the app (status API and page); B sees no cross-tenant rows through the data API with its own token (`scans`, `evidence_items`, `vendor_results` by id; other users' `scans` and `users` by count, zero rows requested); sign-out with the old session replayed and rejected | **Requires founder approval** (test accounts, a protected environment, each run) | `staging-auth-journeys` workflow |
| J10 | The owner's own data-API read of the scan | **Observed only** (reported, never fails) | same run |
| U3 | Supabase Auth redirect URL allow-list and site URL | **Requires founder action** (read-only) | section 4 |
| U5 | RLS policies themselves, every table and policy | **Unverified** | J9 proves only that B cannot read A's rows in the probed tables. Policy review: section 4 |
| U6 | Client assets beyond `/login` and its directly referenced scripts | **Unverified** | not inspected |
| U7 | Inngest execution (process-scan run in the branch environment) | **Blocked** (kept separate) | needs an app sync and an event, which is a separate approval |
| U8 | Write isolation: B inserting or updating rows of A's organization through the data API | **Blocked** (not in the first run) | a write probe could create data if RLS is missing. Needs its own approval and cleanup |
| P1 | Production Supabase Auth settings (signup, autoconfirm, redirect allow-list) and RLS | **Unverified** | production is out of scope here. See section 6 |

## 3. Founder actions for the first authenticated staging run

All of these are in the **staging** Supabase project `zgxmvpbvvakpsnzcymsf` and in GitHub. Nothing touches production.

1. **Create two test accounts** in staging Supabase (Authentication → Users → Add user, with "Auto Confirm User" ticked). Use dedicated addresses, for example `cbc-stg-test-a@<your domain>` and `cbc-stg-test-b@<your domain>`, with strong, unique passwords that are used nowhere else.
2. **Make sure each account has its own organization.** Check in the staging SQL editor (read-only):

   ```sql
   select id, organization_id from public.users where id in ('<A user id>', '<B user id>');
   ```

   Two rows are required, each with an `organization_id`, and the two must differ. If the rows are missing, sign in once through the staging UI with each account and check again. If they still share an organization, stop: J7/J8 would rightly fail.
3. **Create the GitHub environment `staging-auth-test`** (repository Settings → Environments) **before adding any secret**:
   - required reviewer: you;
   - deployment branches: `master` only.
4. **Add the four environment secrets:** `CBC_TEST_A_EMAIL`, `CBC_TEST_A_PASSWORD`, `CBC_TEST_B_EMAIL`, `CBC_TEST_B_PASSWORD`. They go in the environment only, never as repository secrets or variables.
5. **After PR review and merge, dispatch once:**

   ```bash
   gh workflow run staging-auth-journeys.yml --repo wberytech-stack/checkbeforeclick --ref master
   ```

   Approve the `staging-auth-test` gate. The run signs in twice, creates **one** localhost scan owned by A, and signs both accounts out.
6. **Clean up** with the scan id printed under "Test data created by this run", in the staging SQL editor:

   ```sql
   -- STAGING ONLY (project zgxmvpbvvakpsnzcymsf). One run's test scan, owned by account A.
   begin;
   delete from public.vendor_results where scan_id = '<scan id>';
   delete from public.evidence_items  where scan_id = '<scan id>';
   delete from public.scans
    where id = '<scan id>' and user_id = '<A user id>'
      and raw_input like 'http://localhost/cbc-staging-journey/%';
   commit;
   ```

   **Expected rows:** the scan delete affects exactly 1 row, evidence 1, vendor results 0. Any other count means stop and roll back.

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

- **Fails closed:**
  - on staging/production ambiguity (I1/I2), before any request;
  - on missing credentials, or A = B;
  - on any production cookie or failed sign-in, before data is written.
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
