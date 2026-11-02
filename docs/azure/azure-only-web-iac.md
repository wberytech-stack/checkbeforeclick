# Azure-only web Container App (draft; no deployment)

This is a **new, independent web deployment path** for the clean-start CBC
application. It does not invoke the legacy `infra/azure/hosting/main.bicep`
or `modules/web-app.bicep`, which still inject Supabase/Inngest credentials.
The Azure-only runtime image is built from `Dockerfile.azure-web` and exposes
`/azure`, Entra auth routes and tenant-scoped scan APIs.

## Security and cost posture

- `infra/azure/hosting/azure-only-web.bicep` defaults to `deployWeb=false`
  and `minReplicas=0`. All **new** identities, role assignments and web
  Container App resources are conditional on `deployWeb`. No changes to
  existing environment, registry, vault or database are authored here.
- Use a **new dedicated web identity**, different from the legacy web
  identity and from the worker identity. The legacy hosting template grants
  vault-wide Key Vault Secrets User access; this template instead grants
  the new identity access **only to the named OIDC state secret**.
- The web image must be pinned to an immutable `sha256` digest from an
  approved build of `Dockerfile.azure-web`. It cannot receive a
  Supabase service-role key, Inngest key, or paid Web Risk provider key.
- `CBC_DATABASE_URL` contains only `cbc_app`, database host and name;
  `CBC_DATABASE_AUTH=entra` and `AZURE_CLIENT_ID` select short-lived
  managed-identity tokens. TLS chain and hostname verification are enforced
  in `src/server/db/config.ts`.
- `CBC_AZURE_OIDC_STATE_KEYS` is a **Key Vault reference**, not a
  plaintext parameter. Other OIDC fields are non-secret, explicit values.
- The web app has no Web Risk key. Reputation lookups belong only in the
  separately authorized worker. The web container's liveness/readiness
  endpoint is intentionally independent of external services.

## Before a founder-approved Azure what-if

1. Verify that the existing Container Apps environment, registry and Key
   Vault are the intended resources, and that the named OIDC state secret
   exists. **Never paste secret values into commands, PRs or logs.**
2. Verify the selected `webIdentityName` is **not** the old broad-vault
   identity or the worker identity. Review existing role assignments before
   approving changes. An IaC template cannot revoke legacy grants by itself.
3. Verify the Entra External ID application is configured for the exact
   `publicOrigin` and callback `<publicOrigin>/auth/callback`; validate
   whether its token endpoint accepts the currently implemented PKCE public
   client exchange. A confidential-client assertion is not implemented.
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
