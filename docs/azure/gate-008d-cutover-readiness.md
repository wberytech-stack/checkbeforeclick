# Gate 008D: Azure-native cutover and deployment readiness (offline plan)

**Status:** plan and offline tooling only.
- Written without any Azure, Entra or live database access.
- **Nothing here authorizes or performs a deployment, a what-if run, a resource change, a database change or a secret change.**
- Every stage below needs its own explicit founder approval naming the action (AGENTS.md sections 6.3, 8, 9 and 20).
- Agent-written text, including lead reviews that mention authorization "in principle", is not that approval.

**Builds on:**
- `infra/azure/hosting/azure-only-web.bicep` and `azure-url-worker-job.bicep` (deploy flags off by default);
- migrations `001`–`010`;
- `docs/azure/azure-only-web-iac.md`, `azure-worker-job-iac.md`, `cleanstart-runtime-preflight.md`;
- the guards `validate-compiled-iac.mjs`, `check-deployment-name-collisions.mjs`, `test-cleanstart-deployment-contract.mjs` and `azure-runtime-preflight.mjs`;
- Gate 008C, the callback-origin fix.

**New in this gate:**
- `infra/azure/cleanstart/cutover-profile.json`: the single non-secret source of names and IDs.
- `scripts/azure-data/check-cleanstart-whatif.mjs`: offline guard for a captured what-if result.
- `scripts/azure-data/test-cleanstart-whatif.mjs`: 57 checks, run in PR CI.

## 1. Resource reconciliation

The existing resources come from founder screenshots taken 2026-11-05. **They are not yet authenticated evidence.**

| Resource | Name in profile | Action | Protected |
| --- | --- | --- | --- |
| Resource group | `rg-cbc-prod-canadacentral-001` | reuse | yes |
| Container Apps environment | `cae-cbc-prod-cc-001` | reuse (no second environment) | yes |
| Container registry | `crcbcprodcc001` | reuse; new repositories `cbc-azure-web`, `cbc-azure-worker` | yes |
| Key Vault | `kv-cbc-prod-cc-001` | reuse; **3 new secrets** for OIDC (founder creates) | yes |
| PostgreSQL Flexible Server | `pg-cbc-prod-cc-001` | reuse server; **new database** `cbc_cleanstart` | yes |
| Log Analytics | `log-cbc-prod-cc-001` | reuse | yes |
| Legacy staging app | `ca-cbc-web-stg-cc-001` | **untouched** | yes |
| Legacy identities | `id-cbc-web-cc-001`, `id-cbc-deploy-cc-001` | **not reused** by clean-start (the web identity has vault-wide reads) | yes |
| **New** web identity | `id-cbc-azweb-cc-001` (proposal) | create (web template) | no |
| **New** web app | `ca-cbc-azweb-cc-001` (proposal) | create (web template, `minReplicas` 0) | no |
| **New** worker identity | `id-cbc-azworker-cc-001` (proposal) | create (worker template) | no |
| **New** worker job | `caj-cbc-urlworker-cc-001` (proposal) | create (worker template, every 15 min) | no |

The protected list is identical to `check-deployment-name-collisions.mjs`, and a test pins that. New names never collide with it.

**Still to fill in the profile** (`REQUIRED:` placeholders; the guard refuses real evidence until they are set):
- subscription ID and tenant ID;
- `publicOrigin`;
- Entra issuer and client ID.

## 2. Authenticated evidence the founder must capture (read-only)

Run these as the founder, signed in to the intended tenant. **None of them change anything.** Keep their outputs out of the repository and out of chat when they contain IDs you consider sensitive; the guards take local file paths.

| # | Command | Proves |
| --- | --- | --- |
| E1 | `az account show -o json` | tenant and subscription; fills `tenantId` / `subscriptionId` |
| E2 | `az resource list -g rg-cbc-prod-canadacentral-001 -o json` | the 8 protected resources exist with these exact types and names, and the proposed names are free |
| E3 | `az containerapp env show -g … -n cae-cbc-prod-cc-001 --query "{domain:properties.defaultDomain,state:properties.provisioningState}"` | the default domain, which gives the origin before a custom domain exists: `https://ca-cbc-azweb-cc-001.<defaultDomain>` |
| E4 | `az keyvault show -n kv-cbc-prod-cc-001 --query "properties.enableRbacAuthorization"` | RBAC mode, so the template's per-secret role assignments are meaningful (must be `true`) |
| E5 | `az keyvault secret list --vault-name kv-cbc-prod-cc-001 --query "[].name"` | **names only**: which secrets exist (the 3 OIDC secrets and the Web Risk secret) |
| E6 | `az postgres flexible-server show -g … -n pg-cbc-prod-cc-001 --query "{v:version,auth:authConfig,state:state,sku:sku.name}"` | PG 16, Entra auth enabled (`activeDirectoryAuth: Enabled`), running, SKU |
| E7 | `az postgres flexible-server db list -g … -s pg-cbc-prod-cc-001 --query "[].name"` | `cbc_cleanstart` does not exist yet; which databases do |
| E8 | `az role assignment list --scope <kv id> --include-inherited -o json` | existing vault-wide grants, which the template cannot revoke and must be reviewed |
| E9 | `az consumption usage list --start-date <first-of-month> --end-date <today> -o json` (or Cost Management in the Portal) | the current run rate; what the PostgreSQL charges are |
| E10 | `az deployment group list -g … --query "[].{n:name,t:properties.timestamp,s:properties.provisioningState}"` | deployment history; no unknown deployments |

Once E2 is captured, run `check-deployment-name-collisions.mjs planned.json inventory.json` against it. The planned list is the four new resources above.

## 3. Safe what-if expectations

Run what-if only after E1–E8 pass and the founder approves the **what-if itself**. It changes nothing, but it uses an authenticated session. Then:

```bash
node scripts/azure-data/check-cleanstart-whatif.mjs --profile infra/azure/cleanstart/cutover-profile.json \
  --component web --enabled true --whatif whatif-web.json --image-digest <approved cbc-azure-web digest>
```

The guard **accepts only**:
- web: `Create` of exactly `id-cbc-azweb-cc-001`, `ca-cbc-azweb-cc-001` and **4** role assignments (`AcrPull` on the registry; `Key Vault Secrets User` on each of the 3 named OIDC secrets, never the vault);
- worker: `Create` of exactly the worker identity, the job and **2** role assignments (`AcrPull`; the Web Risk secret);
- everything else must be `NoChange` or `Ignore`, inside the resource group.

**It refuses:**
- any `Delete` or `Modify`, or any change to a protected resource;
- an extra or missing `Create`;
- a vault-wide, resource-group or Owner role;
- a mutable tag, the legacy `cbc-web` repository, or a digest other than the approved one;
- Supabase, Inngest or Web Risk variables in the web app;
- inline secrets, a database password, an admin role, or `password` auth;
- a public origin, issuer or client ID different from the profile;
- `allowInsecure`, or `minReplicas` > 0;
- worker retries or worker ingress;
- the web identity assigned to the worker;
- `potentialChanges`, non-Info diagnostics, or secret-looking text in the output.

**Principal binding** (hardening after lead review 6899949127): every role assignment must be granted to the
**intended** new identity. The what-if `principalId` must be one of:
- the compiled Bicep expression for that template's own identity, `[reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', parameters('webIdentityName' | 'workerIdentityName')), '2023-01-31').principalId]`;
- the same expression with that identity's literal name or full resource ID;
- a concrete GUID equal to `--principal-id <guid>`, supplied from authenticated evidence (for example `az identity show --query principalId`).

These are refused:
- another identity, the legacy identity, or the other component's identity parameter;
- an arbitrary service principal;
- extra expression text, or a missing value;
- duplicate resource IDs anywhere in the what-if.

CI recompiles both templates (`--compiled-drift`), so the guard and the Bicep output cannot silently diverge.

**Passing is necessary, not sufficient:** a human still reads the what-if before any approved apply.

## 4. Entra External ID, certificate and Key Vault bindings

| Item | Value or rule | Where it is enforced |
| --- | --- | --- |
| Redirect URI registered in Entra | exactly `<publicOrigin>/auth/callback` | `redirect_uri` is built only from `CBC_AZURE_PUBLIC_ORIGIN` (Gate 008C; tests C09 and R10) |
| Public origin | E3 default domain first; a custom domain later is a separate change (DNS + managed certificate + updating both Entra and `publicOrigin` together) | guard N26; `parseAzureRuntimeConfig` (https, canonical) |
| Issuer | `https://<tenant>.ciamlogin.com/<tenant-id>/v2.0`, inserted into `trusted_identity_issuers` (migration 005) by the schema owner | `app_sign_in` refuses other issuers |
| Client authentication | confidential client, PS256 client assertion with an X.509 certificate | `azureCallbackRoute` refuses to run without key and certificate |
| Key Vault secrets (founder creates; values never in the repo or chat) | `cbc-azweb-oidc-state-keys` (`k1:<32 random bytes, base64url>`), `cbc-azweb-oidc-client-key` (base64 PEM private key), `cbc-azweb-oidc-client-cert` (base64 PEM certificate whose public key is uploaded to the Entra app) | per-secret `Key Vault Secrets User` for the web identity only (guard N11, N25) |
| Rotation | state keys: add `k2`, switch the active key ID, retire `k1` after 5 minutes; certificate: upload the new public cert to Entra first, then swap the secret | `azureRuntimeConfig` allows up to 3 key IDs |

## 5. PostgreSQL: principals, migration order, rollback

**Order matters**, and each step is founder-run:
1. **Create the database** `cbc_cleanstart` on the existing server. Never reuse or alter an existing database.
2. **Create a dedicated owner role** (for example `cbc_owner`, NOLOGIN, granted to the Entra admin for the migration session). This keeps objects from being owned by a personal account.
3. **Create the runtime principals as Entra-mapped roles, bound to the identities' object IDs, BEFORE any migration:**
   - `SELECT * FROM pgaadauth_create_principal_with_oid('cbc_app', '<web identity principalId>', 'service', false, false);`
   - the same for `cbc_worker` with the worker identity;
   - then `ALTER ROLE … NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS` (and `NOINHERIT` for `cbc_worker`).

   A plain password role named `cbc_app` would **not** accept the managed-identity token, and every login would fail. Migration 005 refuses to run if `cbc_app` is missing or privileged. Migration 008 requires `cbc_worker`.
4. **Apply migrations `001` → `010` in order** as the owner, one transaction each. No extensions are needed, so there is no `azure.extensions` change.
5. **Insert the issuer** into `trusted_identity_issuers`.
6. **Run `azure-runtime-preflight.mjs`** against the new database. Its CLI is currently hard-restricted to the disposable `127.0.0.1/cbc_test`; a live variant is a separate approved change. Expect: 2 roles, no admin or BYPASSRLS, RLS on 14 tables, no direct protected writes, correct function grants.
7. **Rollback** before any user data exists: `DROP DATABASE cbc_cleanstart` and drop the two roles. Other databases and the server are never touched. After users exist, use point-in-time restore of the server (confirm the retention window in E6) under a separately approved runbook.

## 6. Staged acceptance matrix (each stage separately approved; stop on any failure)

| Stage | Action (founder) | Accept when | Evidence |
| --- | --- | --- | --- |
| S0 | Capture E1–E10 | the profile is complete; the collision guard passes; Key Vault is in RBAC mode; PG has Entra auth | E-files kept locally |
| S1 | Build and push the `cbc-azure-web` image by digest (no deploy) | the `azure-oidc-validate` image smoke and the 008C origin tests pass on the same commit | digest |
| S2 | What-if for web with `--enabled true` | `check-cleanstart-whatif` accepts **and** a human review | guard output |
| S3 | Apply web (`deployWeb=true`, `minReplicas` 0) | the new revision is ready; `/api/healthz` returns 200; the legacy app is unchanged | revision name, health |
| S4 | Database steps 1–6 | the preflight passes on `cbc_cleanstart` | preflight output |
| S5 | Real sign-in with **new** test accounts A and B (no Supabase accounts) | A and B each get their own organization; the session cookie is set only after commit; logout revokes | `user_identities`, `auth_sessions` rows (no tokens) |
| S6 | Scan and evidence | A creates a scan → pending → result; B gets 404 on A's scan; B's history has no A rows | API responses |
| S7 | Worker what-if, apply and one run | the guard accepts; a single run completes one leased scan; at most 1 paid call; no retries | job execution log |
| S8 | Cost check after 7 days | the run rate matches the estimate; scale-to-zero is observed | Cost Management |
| S9 | Cutover (DNS / custom domain) | S5–S8 all green and the founder approves; the rollback plan is ready | separate runbook |

## 7. Decisions needed from the founder (none taken)
1. Confirm or rename the four proposed new resource names.
2. **Web Risk key for the worker:** reuse `cbc-shared-google-web-risk-api-key` (production key, R1 checklist) or create a dedicated key with its own quota and budget alert. Recommended: a dedicated key.
3. The public origin for S5: the ACA default domain (recommended for staging acceptance) or a custom domain.
4. Approval of each stage S0–S9 individually.

## 8. Known gaps (offline follow-ups, not blockers for S0)
- **Closed:** migrations 001–010 and every database suite now also run with a **non-superuser, non-BYPASSRLS** owner that is a member of `azure_pg_admin` with `CREATEDB` and `CREATEROLE` (`CBC_TEST_OWNER_MODE=azure-like`, in CI). All suites pass, including the owner-level integrity triggers and the runtime-role preflight.
- `azure-runtime-preflight.mjs` cannot target a live database by design. A read-only live mode needs its own reviewed change.
- **Closed:** `cleanstart-runtime-preflight.md` now says 001–010.
