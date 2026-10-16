# Gate 006B - Azure hosting build artifacts (local implementation only)

## Goal

Build everything needed to host the current CheckBeforeClick app on Azure
Container Apps (Gate 006A, Phase 1), **without** touching Azure. The work
covers the container image, health probe, infrastructure as code and a
manual deploy workflow. Nothing was provisioned, applied or deployed, and
no GitHub environment, variable or secret was configured.

Branch `gate-006b-azure-hosting-build`, cut from master `c23d2c5`.

## Founder conditions and how they were met

| # | Condition | Status |
| --- | --- | --- |
| 1 | No Azure access, provisioning, deploy, DNS, GitHub environment, secrets or production actions | Met. `az` was not invoked; the Bicep was not compiled against Azure. Docker ran locally on 127.0.0.1 only |
| 2 | Deploy workflow manual-only, fail closed | Met. `workflow_dispatch` only; inert until `CBC_AZURE_DEPLOY_ENABLED=enabled`; validates inputs, variables and master ancestry before building; Azure access only in the `azure-<env>` environment |
| 3 | Preserve Vercel production behavior; validate the Vercel preview before any merge | Code-level: see "Vercel impact" below. **The preview check is founder-run** (Claude cannot access Vercel) |
| 4 | Verify real routes and auth behavior before finalizing container tests | Met. The smoke expectations come from `proxy.ts`, `app/page.tsx` and `app/api/scan/**` |
| 5 | Distinguish locally validated from Azure-pending | See the two tables under "Validation" |
| 6 | No dependency or lockfile changes | Met. `package.json` and `package-lock.json` are unchanged. `npm ci --ignore-scripts` works (see Findings) |
| 7 | Follow AGENTS.md; stop if more authorization is needed | Followed. No step needed more authorization |

## Changed files

| File | Change |
| --- | --- |
| `next.config.ts` | `output: "standalone"` |
| `app/api/healthz/route.ts` | New. `GET` returns `{"status":"ok"}` with status 200 and `no-store`. No auth, no database, no environment reads |
| `proxy.ts` | Matcher excludes exactly `/api/healthz`, so probes never call Supabase auth. All other routes are unchanged (regex checked) |
| `Dockerfile` | New. Three stages (deps, build, runtime) on `node:24.14.0-bookworm-slim`. `npm ci --ignore-scripts`; only `NEXT_PUBLIC_*` and `CBC_BUILD_SHA` build args; runtime runs as `USER node` on port 3000 with a `HEALTHCHECK` |
| `.dockerignore` | New. Excludes `.env*`, `.git`, `.github`, `.claude`, key and certificate files, `.npmrc`, `docs`, `scripts`, `infra`, build output |
| `infra/azure/hosting/main.bicep` | New. Identity, registry (Basic, admin disabled), Log Analytics (30 days, daily cap), Container Apps environment, AcrPull and Key Vault Secrets User role assignments, existing Key Vault. Apps are created in Phase B only |
| `infra/azure/hosting/modules/web-app.bicep` | New. One Container App: user-assigned identity, registry pull by identity, Key Vault references **by name**, probes on `/api/healthz:3000`, HTTPS-only ingress |
| `infra/azure/hosting/main.parameters.json` | New. Resource names and **Key Vault secret names** (no values). Plain-variable values are `REPLACE_WITH_…` placeholders the founder fills in |
| `.github/workflows/azure-deploy.yml` | New. Manual, founder-gated deploy (below) |
| `scripts/azure-hosting/test-hosting-safety.ts` | New. 71 static safety assertions |
| `scripts/azure-hosting/smoke.ts` | New. Signed-out smoke checks for any base URL (local or staging) |

## Findings

- **Lifecycle scripts can be skipped.** Packages with install scripts in the
  lockfile are `msw`, `protobufjs`, `sharp` (optional) and `unrs-resolver`
  (dev). The image builds and runs with `npm ci --ignore-scripts`. `sharp` is
  only used by Next image optimization, and no file in `app/`, `components/`
  or `lib/` imports `next/image`, so no current route needs it.
- **`NEXT_PUBLIC_*` values are inlined at build time** into both client and
  server bundles. The container ran with **no runtime environment** and the
  proxy still redirected correctly, which confirms this. The result is one
  image per environment (`<sha>-stg`, `<sha>-prod`), as 006A planned.
- **Design correction during the gate.** A bootstrap placeholder image
  (listening on port 80) would fail the 3000 `/api/healthz` probes. The Bicep
  is therefore two-phase: Phase A creates the platform, Phase B creates the
  apps from a real image.
- **PR #32 review fix: the auth callback broke in the container.**
  `app/auth/callback/route.ts` uses
  `process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin`. The first
  Dockerfile always set `NEXT_PUBLIC_APP_URL` (default `""`), so Next inlined an
  empty string and `new URL("/login", "")` threw. Reproduced on the 880d6ce
  image: `GET /auth/callback` returned **500** (`TypeError: Invalid URL`). The
  Dockerfile now leaves the variable truly unset when it is empty.
- **PR #32 review finding: the origin fallback is wrong in a container.** In
  standalone mode `request.nextUrl.origin` is the bind address
  (`http://0.0.0.0:3000`), even with `Host`/`X-Forwarded-Host` headers. So
  unlike Vercel previews (`docs/ENVIRONMENTS.md` section 9), Azure staging needs
  an explicit `NEXT_PUBLIC_APP_URL`. The workflow now **requires** it as an
  https origin for both environments and refuses to build otherwise. The proxy
  and page redirects are relative and unaffected. App code was not changed.
- **The workflow cannot read GitHub Environment variables in the
  secret-free build job.** Build-time public values are therefore
  **repository** variables with `CBC_STG_` / `CBC_PROD_` prefixes. Azure IDs
  live in the `azure-<env>` environments.

## Deploy workflow (`.github/workflows/azure-deploy.yml`)

- **Trigger:** `workflow_dispatch` only. Inputs: `environment` (`staging` or
  `production`) and `commit` (a full 40-hex SHA). There is no push, merge, PR
  or schedule trigger.
- **Inert:** both jobs have
  `if: vars.CBC_AZURE_DEPLOY_ENABLED == 'enabled' && github.ref == 'refs/heads/master'`.
  The master-ref condition (PR #32 review) means only the reviewed workflow
  definition on master can run; a dispatch from another branch, which would run
  that branch's copy of the file, is skipped.
- **build job** (`contents: read`, no Azure access, no secrets):
  1. Validates the inputs and public variables, including a required
     https `NEXT_PUBLIC_APP_URL`.
  2. Checks out with `persist-credentials: false`.
  3. Requires that the commit is an ancestor of `origin/master`.
  4. Pins Node 24.14.0, runs `npm ci --ignore-scripts` and the safety tests.
  5. Builds with public build args only, then uploads the image tarball
     (kept 3 days).
- **deploy job** (`environment: azure-<env>`, `id-token: write`,
  `contents: read`):
  1. Fails if any Azure environment variable is missing.
  2. Signs in with `azure/login@v2` (OIDC, no client secret).
  3. Pushes `<registry>/cbc-web:<sha>-<env>`.
  4. Fails closed if the Container App does not exist.
  5. Runs `az containerapp update --image`.
  6. Waits up to about 7 minutes until the app's latest revision runs exactly
     this image **and** is the latest ready revision, then requires
     `https://<fqdn>/api/healthz` to return 200 (PR #32 review: a bare FQDN
     probe could be answered by the old revision while the new one fails).
- **No `secrets.*` references anywhere.** The safety test enforces this.
- **Rollback:** manual (runbook step R).

## Validation

### Locally validated (2026-10-16, evidence under `.git/cbc-evidence/`, not committed)

Initial run on 880d6ce:

| Check | Result |
| --- | --- |
| `docker build` from the lockfile with placeholder public values | Pass (`docker-build-006b.txt`) |
| Container user | `uid=1000(node)`; process user 1000; image `Config.User=node` |
| Docker `HEALTHCHECK` | `healthy` |
| Smoke on `127.0.0.1:3006` (`smoke.ts`) | 9/9 pass: healthz 200; `/` 307 to `/login`; `/login` and `/register` 200; `/dashboard` 307 to `/login?next=%2Fdashboard`; `/history` 307 to login; `POST /api/scan` signed-out 401; `GET /api/scan` 405; scan status signed-out 401 |
| `.env*` files anywhere in the image filesystem | 0 |
| Secret patterns (JWT, Stripe, Anthropic, Google, Inngest signing key, private key, Postgres URL with password) in `/app`, including `node_modules` | 0 hits |
| Server secret names in `.next/static` (client bundle) | 0 |
| Source tree, `.git` in image | Absent (`/app` holds `.next`, `node_modules`, `package.json`, `public`, `server.js`) |
| `docker history` | No secret-like strings |
| Final image size | 99.2 MB content (402 MB on disk) |
| Local container and image | Removed after the checks |
| `scripts/azure-hosting/test-hosting-safety.ts` | 71/71 pass |
| Mutation check of the safety test (push trigger, missing environment, `secrets.` reference, `USER root`, missing `.dockerignore` entry) | Every mutation caught |
| `npm run build` (host, standalone) | Pass; `.next/standalone/server.js` produced |
| ESLint on changed TypeScript; `tsc --noEmit --strict` on the scripts | Pass |
| `git diff --check` | Clean |
| `package.json` / `package-lock.json` | Unchanged |

Note: `smoke.ts` got a no-op `export {};` (for `tsc`) after the container run;
its checks are unchanged.

PR #32 review fixes (rerun):

| Check | Result |
| --- | --- |
| Pre-fix image (880d6ce Dockerfile), `GET /auth/callback` | **500**, `TypeError: Invalid URL` (bug reproduced) |
| Fixed image, `NEXT_PUBLIC_APP_URL` empty | Build pass; smoke 10/10 (new check: callback 307 to `…/login`, origin `http://0.0.0.0:3000`) |
| Same image with `smoke.ts <base> https://stg.example.test` | Callback check FAILS as intended (proves the public-origin guard) |
| Fixed image, `NEXT_PUBLIC_APP_URL=https://stg.example.test` | Smoke 10/10 with public-origin check (callback 307 to `https://stg.example.test/login`); runs as `uid=1000(node)` |
| `test-hosting-safety.ts` | 76/76 pass (new: master-ref gate on both jobs, revision-ready wait, required https APP_URL, APP_URL never an ENV and unset when empty) |
| ESLint, `tsc --strict` on scripts, `npm run build`, `git diff --check` | Pass |
| Local containers and images | All removed |

### Still requires Azure or founder validation (not done by Claude)

| Item | Why it is unverified |
| --- | --- |
| Bicep compiles (`az bicep build`) and `what-if` is as expected | No local Bicep CLI; downloading one was out of scope. Validated by text tests only |
| API versions, role definition IDs, Key Vault reference format | Checked against known values, not against Azure |
| Container App pulls from ACR via identity; Key Vault references resolve | Needs the real resources and secrets |
| OIDC federated credentials and `azure/login` | Needs founder app registration and environment setup |
| Workflow run end to end | Inert until the founder configures it; never run |
| Real Supabase / Inngest behavior in the container (S4–S12) | Placeholder values used locally; staging smoke is founder-run |
| Vercel preview of this branch | Vercel build status is `success` on 880d6ce, but the preview is behind Vercel SSO (302 to `vercel.com/sso-api`), so Claude could not load it. Founder checks it before any merge |
| Key Vault permission model | The Key Vault Secrets User role only works if `kv-cbc-prod-cc-001` uses Azure RBAC authorization, not access policies. Founder confirms in what-if or the portal |
| Bicep conditional modules and the `staging!.outputs` syntax | Needs Bicep 0.23 or later; confirmed only by `az bicep build` |

## Vercel impact (condition 3)

- `output: "standalone"` only adds `.next/standalone` to the build output;
  Vercel uses its own output handling and ignores it. The `next build` route
  table is unchanged.
- The proxy matcher change removes only `/api/healthz` from the proxy. That
  route is new, so no existing route changes behavior.
- The new workflow never runs on push or merge. `Dockerfile`,
  `.dockerignore` and `infra/` are not used by Vercel.
- **Merging this PR still deploys to Vercel production** (`AGENTS.md`
  section 20 transition rule). The founder confirms the Vercel preview first.

## Founder runbook (nothing here is done by agents)

**0. Before merge.** Open the Vercel preview for this PR and check `/`,
`/login`, `/register`, `/api/healthz` and a signed-in dashboard. Merge with
**"Create a merge commit"**.

**1. Key Vault secrets** in `kv-cbc-prod-cc-001`, copying values from Vercel:
`cbc-stg-supabase-service-role-key`, `cbc-prod-supabase-service-role-key`,
`cbc-shared-google-web-risk-api-key`, `cbc-stg-inngest-event-key`,
`cbc-stg-inngest-signing-key`, `cbc-prod-inngest-event-key`,
`cbc-prod-inngest-signing-key`. Then fill the `REPLACE_WITH_…` placeholders
in `main.parameters.json` (plain values only) locally.

**2. Phase A (platform):**
```bash
az deployment group what-if --resource-group rg-cbc-prod-canadacentral-001 --template-file infra/azure/hosting/main.bicep --parameters infra/azure/hosting/main.parameters.json
```
Review, then run the same with `create` in place of `what-if`. Before applying,
confirm the vault uses **Azure RBAC** authorization. Note the
`stagingPublicOrigin` output: it is the staging app's future
`https://<app>.<environment default domain>`.

**3. OIDC.** Create an Entra app registration (or a separate user-assigned
identity) for GitHub with federated credentials for
`repo:wberytech-stack/checkbeforeclick:environment:azure-staging` and
`…:environment:azure-production`. Grant it `AcrPush` on the registry and
`Container Apps Contributor` (or a narrower custom role) on the resource
group. Do not create a client secret.

**4. GitHub configuration.**
- Environments `azure-staging` and `azure-production`, each with the founder
  as required reviewer, and variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
  `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_ACR_NAME`
  (`crcbcprodcc001`) and `AZURE_CONTAINERAPP_NAME` (the app for that
  environment).
- In both environments, restrict **deployment branches** to `master`
  (defense in depth alongside the workflow's master-ref condition).
- Repository variables `CBC_STG_NEXT_PUBLIC_SUPABASE_URL`,
  `CBC_STG_NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `CBC_PROD_NEXT_PUBLIC_SUPABASE_URL`,
  `CBC_PROD_NEXT_PUBLIC_SUPABASE_ANON_KEY`, and the **required**
  `CBC_STG_NEXT_PUBLIC_APP_URL` (the `stagingPublicOrigin` output) and
  `CBC_PROD_NEXT_PUBLIC_APP_URL` (`https://checkbeforeclick.com`).
- In the **staging** Supabase project, add `<stagingPublicOrigin>/auth/callback`
  to the allowed redirect URLs.
- **Decision for you:** with `https://checkbeforeclick.com` baked into the
  production image, auth callbacks from the production Container App go to
  that domain. Before DNS cutover the domain is still served by Vercel, so
  pre-cutover signed-in tests of email confirmation on the Azure FQDN would land
  on Vercel. Password login is unaffected.
- Last: `CBC_AZURE_DEPLOY_ENABLED=enabled`.

**5. First image.** Run `azure-deploy` with `staging` and a master SHA. The
run pushes `crcbcprodcc001.azurecr.io/cbc-web:<sha>-stg`, then fails closed
because the app does not exist yet. Repeat for `production` if desired.

**6. Phase B (apps):** rerun what-if and then create with
`deployApps=true stagingImage=<ref> productionImage=<ref>` as extra
`--parameters`.

**7. Staging smoke.**
```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/azure-hosting/smoke.ts https://<staging-fqdn> https://<staging-fqdn>
```
Then run the manual S4–S12 checks from Gate 006A section 7. Later deploys are
just step 5, which now updates the app.

**R. Rollback.** In the portal, or with
`az containerapp revision list` / `az containerapp revision activate` and
`az containerapp ingress traffic set`, return traffic to the previous
revision.

Production cutover, DNS and Vercel retirement remain as in Gate 006A
sections 8 to 10 and are separate founder decisions.

## Out of scope

Azure provisioning, DNS, GitHub settings, secrets, Vercel changes, Phase 2
(direct PostgreSQL), dependency changes, `state.yaml` (reconciled after merge
by Gate 005E automation).
