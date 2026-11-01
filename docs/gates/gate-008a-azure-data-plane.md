# Gate 008A: Azure data plane (identity binding, tenant context, scan integrity)

**Status:** draft implementation on branch `gate-008a-azure-data-plane`.
- Validated offline and on a disposable loopback PostgreSQL 16 cluster.
- **Not applied** to any real database and **not deployed**.
- Applying migration 005, creating database principals, and changing app settings are founder-only (AGENTS.md sections 6.3, 8, 9 and 20).

**Authority:** the founder directive of 2026-11-01 ("secure, complete Azure migration … fresh Azure database and authentication architecture"):
- Existing Supabase users and staging test accounts are **not** migrated.
- The legacy Supabase staging-auth bootstrap is no longer a prerequisite.

## 1. Migration plan (fastest secure path)

Repository facts this plan rests on, inspected 2026-11-01:

| Concern | Today | Azure target | Gate |
| --- | --- | --- | --- |
| Hosting | Vercel (production), Azure Container Apps (built in 006B/006C, staging only) | Azure Container Apps only; Vercel retired after cutover | 008E |
| Database | Supabase Postgres (service-role path in `lib/data`) | Azure Database for PostgreSQL Flexible Server (exists, PG16 Burstable), schema `infra/db/migrations` 001–005 | **008A (this)** |
| DB credentials | n/a | **None stored.** Microsoft Entra token from the app's user-assigned managed identity | **008A (this)** |
| Authentication | Supabase Auth (password) | Microsoft Entra External ID (OIDC authorization code + PKCE). MFA, lockout and bot protection are handled by Entra. App session in an encrypted, HttpOnly cookie | 008B |
| Tenant isolation | App-layer `organization_id` filter with the service role | RLS on every tenant table; context only via transaction-local `set_config` (002, 005) | **008A (this)** |
| Scan admission / Web Risk budget | Supabase RPCs (`cbc_admit_scan`, `cbc_reserve_provider_call`, PR #45) | Same functions ported to Azure Postgres on `app_current_user_id()` | 008C |
| Background jobs | Inngest `processScan` only | **None needed for scans:** FCR-007A-1 (option A) processes every input synchronously, so Inngest is removed, not replaced. Future scheduled work: a Container Apps Job (cron, scale to zero) | 008D |
| File storage | **Not used** (no Supabase Storage call in the code) | None until needed (then Blob Storage via managed identity) | — |

**Cost:**
- No new always-on service; the PostgreSQL server and Container Apps environment already exist.
- Entra External ID's free tier covers the first 50,000 monthly active users.
- No queue or worker service is added while scans stay synchronous.
- Vercel and Supabase are removed at cutover, so no duplicate infrastructure remains.

## 2. What this gate implements

### 2.1 Migration `infra/db/migrations/005_identity_and_scan_integrity.sql` (draft)

1. **`trusted_identity_issuers`.**
   - An operator-managed allow-list of OIDC issuers, such as the External ID tenant issuer.
   - RLS is enabled with no policy and no grant, so `cbc_app` can neither read nor change it.
   - A misconfigured token validator therefore still cannot introduce an issuer.
2. **`user_identities`.**
   - Holds `(issuer, subject)` → user, which is unique.
   - Accounts are linked only by issuer and subject, **never by email**: email is informational and may be unverified.
   - RLS lets users see only their own identities.
3. **`app_sign_in(issuer, subject, email, display_name)`** is a SECURITY DEFINER function that finds or provisions the account.
   - Requires an **empty** tenant context.
   - Rejects untrusted issuers and malformed subjects.
   - Serializes concurrent first sign-ins with an advisory lock.
   - A first sign-in creates, in one transaction: user, personal organization, owner membership, identity, and an audit row.
   - Returns user, organization and role. **`organization_id` is never an argument** (section 10).
4. **Scan lifecycle only through functions.**
   - `app_create_scan(input_type, raw_input)`: requires context and membership; viewers are refused; input is validated.
   - `app_mark_scan_processing(scan_id)`: an idempotent replay is accepted; a final scan raises; a foreign scan gets the same error as a missing one.
   - `app_record_fast_scan_result` (004): one-shot completion.
5. **Least privilege for `cbc_app`.**
   - No direct `INSERT/UPDATE/DELETE` on `scans`, `vendor_results`, `evidence_items`, `audit_log`, `organizations` or `users`. Only `UPDATE (full_name)` on `users` remains.
   - `SELECT` remains, under RLS.
   - This closes two holes in 002's grants:
     - a member could set `organizations.plan = 'msp'` (billing escalation);
     - the app role could rewrite verdicts and evidence directly, bypassing the one-shot function.
6. **Integrity triggers that bind every role, including the owner.**
   - `scans`: identity columns are immutable; final scans are immutable; status only moves forward.
   - `vendor_results` and `evidence_items`: never updated.
   - `audit_log`: append-only.
   - Only the FK cascades are let through: a user deletion nulls `user_id`, and an organization deletion removes its rows.
7. **`EXECUTE` revoked from `PUBLIC`** on every definer function. PostgreSQL grants `EXECUTE` to `PUBLIC` by default, and 002 never revoked it. `bootstrap_new_organization` is superseded and no longer granted.
8. The migration **refuses to run** unless `cbc_app` exists with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`.

### 2.2 Application code

| File | Purpose |
| --- | --- |
| `src/server/db/config.ts` | Parses `CBC_DATABASE_URL` into discrete fields. Any non-loopback host requires **verified TLS (chain and hostname)** and **Entra auth**, and rejects passwords. Every query parameter is rejected, because node-postgres lets `sslmode=no-verify` or `ssl=false` in a connection string override the `ssl` option. Admin role names are refused. Errors never echo the URL. |
| `src/server/db/entraToken.ts` | Managed-identity token provider (resource `https://ossrdbms-aad.database.windows.net`). Sends `IDENTITY_HEADER` only to a loopback endpoint. Caches tokens and refreshes 5 minutes before expiry; concurrent callers share one refresh. Fails closed. Tokens and the header never appear in errors. |
| `src/server/db/transaction.ts` | `runTransaction` and `runTenantTransaction` (pure; the pool is injected). Context is validated as canonical UUIDs **before** a connection is taken, and set with `set_config(..., true)` on the same client. A failed `ROLLBACK` destroys the connection and rethrows the original error. |
| `src/server/db/postgres.ts` | Pool wiring. **Fixes a section 14 violation on `master`:** the pool used `{ rejectUnauthorized: false }`. Adds `withTenantTransaction`. |
| `src/server/data/azureStore.ts` | `signInWithIdentity`, `createScan`, `markScanProcessing`, `getScan`, `listRecentScans`, `getScanEvidence`. Bound parameters only; never sends an organization id; writes only through functions. |

Not yet wired into any route: that is 008B (sign-in) and 008C (scan route). The Supabase path is unchanged until cutover.

## 3. Validation

| Suite | Result |
| --- | --- |
| `scripts/azure-data/test-db-config.ts` (offline) | `=== Gate 008A db config: 48 passed, 0 failed ===` |
| `scripts/azure-data/run-disposable-db.sh` → `validate-data-plane-db.ts` | `=== Gate 008A data plane (disposable DB): 58 passed, 0 failed ===` |
| Mutation check, disposable DB | **10/10 killed** (details below) |
| `tsc --noEmit`, `next build` | exit 0, exit 0 (13/13 pages) |
| eslint on new files | 0 errors (one pre-existing warning on `postgres.ts`, also on `master`) |
| `test-hosting-safety.ts`, `test-staging-integration.ts`, `test-staging-auth-journeys.ts` | 272 / 65 / 76 passed, 0 failed |

The mutation check covered these regressions:
- a `PUBLIC` grant;
- `cbc_app` keeping `INSERT` on evidence;
- no issuer check;
- no empty-context check;
- no membership check;
- the scans trigger removed;
- audit deletes allowed;
- no organization filter when marking a scan processing;
- session-level (not transaction-local) `set_config`;
- email-based account linking.

The disposable-DB suite runs the **real** modules as `cbc_app`: `postgres.ts`, `azureStore.ts`, and the existing `recordFastScanResult.ts`. It covers:
- the role's attributes;
- no `PUBLIC` definer execute;
- sign-in:
  - provisioning and idempotence;
  - no email linking;
  - untrusted issuer;
  - subject validation;
  - context must be empty;
  - auditing;
  - 4 concurrent first sign-ins → one account;
  - hostile display name;
- cross-tenant reads and writes, forged organization context, no-context access;
- 9 direct-write attempts that must be denied, including plan escalation and identity takeover;
- lifecycle and one-shot completion;
- 8 owner-level integrity violations;
- the FK cascades that must still work;
- no tenant context left on pooled connections after `COMMIT` or `ROLLBACK`.

**CI:** `.github/workflows/data-plane-validate.yml` runs both suites on every pull request into `master`. It is read-only: `contents: read`, no secrets, SHA-pinned actions, `npm ci --ignore-scripts`. Its database is a throwaway cluster on 127.0.0.1.

**Deviation (section 15):** the disposable database is a local PostgreSQL 16 cluster that the runner script creates with `initdb` in a temporary directory, not a Docker container. The cloud session has no Docker daemon. It is equally disposable: loopback only, random one-time passwords, deleted on exit (verified).

**Consequence:** the Gate 003H helper validator documents a connection as `postgres`. The new configuration refuses admin role names (section 10). Use a non-admin role for it.

## 4. Founder-only actions this gate needs later (none taken)

1. Approve applying 005 to the Azure server: after 001–004, as the schema owner, with a backup first.
2. Configure the Entra admin on the PostgreSQL server, and create the managed-identity principal for the app: `pgaadauth_create_principal`, granted the privileges of `cbc_app`. Then set `CBC_DATABASE_URL=postgres://<principal>@<server>.postgres.database.azure.com/<db>` and `AZURE_CLIENT_ID` on the Container App. No password exists.
3. Insert the External ID issuer into `trusted_identity_issuers` (008B supplies the exact value).

## 5. Next components

- **008B:** Entra External ID sign-in:
  - OIDC code + PKCE, ID-token validation (RS256 via JWKS with `node:crypto`; no new dependency);
  - encrypted session cookie;
  - `app_sign_in`;
  - replaces `lib/supabase` and `proxy.ts` session handling.
- **008C:** port the 007A admission and budget functions to Azure; scan and status routes on `azureStore`.
- **008D:** remove Inngest (scans are synchronous). Add a Container Apps cron job only if scheduled work appears.
- **008E:** Bicep for the Entra app settings, the DB principal and the app settings; then the cutover runbook (founder-executed) and Vercel and Supabase retirement.
