# Azure-only web Container App (draft; no deployment)

This is a **new, independent web deployment path** for the clean-start CBC
application. It does not invoke the legacy `infra/azure/hosting/main.bicep`
or `modules/web-app.bicep`, which still inject Supabase/Inngest credentials.
The Azure-only runtime image is built from `Dockerfile.azure-web` and exposes
`/azure`, Entra auth routes and tenant-scoped scan APIs.

## Existing CBC infrastructure reconciliation (2026-11-05; screenshot evidence only)

Founder-provided Azure Portal screenshots identify subscription `Azure subscription 1`,
resource group `rg-cbc-prod-canadacentral-001` (Canada Central), and these
**already existing** resources:

| Type | Observed resource | Reuse / verification rule |
| --- | --- | --- |
| Container Apps environment | `cae-cbc-prod-cc-001` | Reuse; do not create a second environment |
| Container App | `ca-cbc-web-stg-cc-001` | Existing staging app; inspect revisions, image, ingress and legacy credentials before deciding whether to replace or isolate |
| Container registry | `crcbcprodcc001` | Reuse after verifying access and repository/digest |
| Managed identity | `id-cbc-deploy-cc-001` | Existing deploy identity; verify RBAC before using |
| Managed identity | `id-cbc-web-cc-001` | Existing web identity; do not silently reuse for clean-start app because older hosting may have broad vault grants |
| Key Vault | `kv-cbc-prod-cc-001` | Reuse vault; verify RBAC and individual secret scopes |
| Log Analytics | `log-cbc-prod-cc-001` | Reuse workspace after checking retention and charges |
| PostgreSQL Flexible Server | `pg-cbc-prod-cc-001` | Reuse server if safe; create a **new application database**, not a duplicate server, after verifying current databases and configuration |

The environment overview shows provisioning status **Succeeded**, project tag
`checkbeforeclick`, gate tag `006B`, and the existing staging app. September
2026 billing screenshots show PostgreSQL charges, but do **not** establish
current monthly run rate, server state or which database incurred them.

**This is an inventory lead, not authenticated Azure verification.** Before
setting `deployWeb=true`, compare the exact resource IDs, tenant, current
resource list, role assignments, database names, deployment history and costs
using read-only Azure access. Inspect Gate 006B/006C history (PRs #30–57)
alongside Gate 008A/008B (PRs #58–59). The clean-start template deliberately
creates a *new* web app and identity; those are **additional resources**, not
in-place upgrades to `ca-cbc-web-stg-cc-001`. Decide explicitly whether this
is a justified isolated rollout and document incremental costs before apply.
Do not deploy the legacy `main.bicep` as a shortcut or remove legacy services.

## Security and cost posture

- `infra/azure/hosting/azure-only-web.bicep` defaults to `deployWeb=false`
  and `minReplicas=0`. All **new** identities, role assignments and web
  Container App resources are conditional on `deployWeb`. No changes to
  existing environment, registry, vault or database are authored here.
- Use a **new dedicated web identity**, different from the legacy web
  identity and from the worker identity. The legacy hosting template grants
  vault-wide Key Vault Secrets User access; this template instead grants
  the new identity access **only to three named secrets**: the OIDC
  state keys, the confidential-client RSA private key, and the matching
  public X.509 certificate. All three grants are scoped to individual secrets.
- The web image must be pinned to an immutable `sha256` digest from an
  approved build of `Dockerfile.azure-web`. It cannot receive a
  Supabase service-role key, Inngest key, or paid Web Risk provider key.
- `CBC_DATABASE_URL` contains only `cbc_app`, database host and name;
  `CBC_DATABASE_AUTH=entra` and `AZURE_CLIENT_ID` select short-lived
  managed-identity tokens. TLS chain and hostname verification are enforced
  in `src/server/db/config.ts`.
- `CBC_AZURE_OIDC_STATE_KEYS`,
  `CBC_AZURE_OIDC_CLIENT_PRIVATE_KEY_PEM_B64`, and
  `CBC_AZURE_OIDC_CLIENT_CERT_PEM_B64` are **Key Vault references**, not
  plaintext parameters. Other OIDC fields are non-secret, explicit values.
- The web app has no Web Risk key. Reputation lookups belong only in the
  separately authorized worker. The web container's liveness/readiness
  endpoint is intentionally independent of external services.

## Before a founder-approved Azure what-if

1. Verify that the existing Container Apps environment, registry and Key
   Vault are the intended resources, and that the named OIDC state, client
   private-key, and client-certificate secrets exist. **Never paste secret values into commands, PRs or logs.**
2. Verify the selected `webIdentityName` is **not** the old broad-vault
   identity or the worker identity. Review existing role assignments before
   approving changes. An IaC template cannot revoke legacy grants by itself.
3. Verify the Entra External ID application is configured for the exact
   `publicOrigin` and callback `<publicOrigin>/auth/callback`; validate
   that its registered X.509 public certificate matches the separately stored
   RSA private key. The callback now signs a short-lived PS256 confidential-client
   assertion, but no live token exchange has been verified.
4. Verify the restricted `cbc_app` PostgreSQL principal is correctly mapped
   to the dedicated web managed identity, and that migrations 001–009 and
   tenant-isolation tests have been independently reviewed. **Do not apply
   database migrations or role grants as part of this template.**
5. Build and verify the Azure-only image, record its registry digest, review
   the precise resource changes in `az deployment group what-if`, and
   approve provisioning separately from the eventual image deployment.
   Set `deployWeb=true` only with explicit founder approval. Keep
   `minReplicas=0` until there is a deliberate always-on cost decision.
6. Verify DNS, ingress, TLS, callback URL and end-to-end Entra login + scan
   on a founder-approved isolated deployment before shifting production
   traffic. A successful `/api/healthz` response is **not** proof of
   database readiness, login or safe scanning.

## Offline verification

```sh
node scripts/azure-auth/test-azure-web-iac.mjs
```

The pull-request workflow runs this source-level check and builds/tests the
actual Azure web image. A separate `compiled-iac` job also runs `az bicep
build` and `az bicep lint` on both Azure-only templates, then checks the
compiled ARM JSON for default-off provisioning, conditional resources,
secret-scoped RBAC, digest-pinned images, restricted database roles and
bounded runtime settings. Its validator has positive and negative fixtures.
The runner may download the free Bicep compiler from GitHub; it does not
log into Azure or make ARM deployment calls. Compilation does **not** prove
live permissions or deployability: an authorized operator must still review
`az deployment group what-if`, identity bindings and costs before any apply.

## Cutover and rollback

Keep the existing demo endpoints/providers untouched until the Azure-only
web, Entra login, PostgreSQL RLS and scheduled worker pass real authorized
smoke tests. Cutover and DNS are founder-only actions. If Azure login or scan
fails after cutover, revert DNS/traffic to the previous known-good service
only with a separately approved rollback. No automatic Supabase data import,
dual-write, service deletion or database reset is required.

This document authorizes **no** Azure access, provisioning, database changes,
secret changes, paid calls, deployment, workflow dispatch or merge.
