# Gate 006C - Staging readiness plan (planning only)

## Status

**Plan only. Gate 006C has not started.** This document prepares the first
Azure **staging** deployment of CheckBeforeClick and its smoke tests. Nothing
here was executed:

- no Azure access, provisioning, `what-if`, or deployment;
- no GitHub environment, variable, or secret change;
- no Supabase, Inngest, DNS, or Vercel change.

Every execution step is founder-only (`AGENTS.md` sections 6.3, 8 and 20).
Starting Gate 006C, and each Azure action inside it, needs the founder's
explicit approval naming the action. That includes `az deployment group
what-if`: it changes nothing, but it signs in to Azure and reads the
subscription, so it is Azure access that needs authorization like any other
step.

Revised after ChatGPT's PR #34 review (2026-10-17): secret names versus values
(P5), `what-if` as authorized Azure access (section 3), the Phase B production
cost as a decision taken **before** provisioning (sections 4 and 6), and
resource counts and commands checked against `master@754b945`.

- **Base:** `master@754b945` (Gate 006B merged through PR #32).
- **Inputs:** Gate 006A plan (`docs/gates/gate-006a-azure-hosting-migration.md`),
  Gate 006B artifacts and runbook (`docs/gates/gate-006b-azure-hosting-build.md`),
  `docs/ENVIRONMENTS.md`.
- **Schedule (Gate 006A section 11):** provisioning Oct 23–26, 006C Oct 26–29,
  006D Oct 30–Nov 3, Vercel retired before **November 7, 2026**.

## 1. Goal and exit criteria

Goal: run the merged app on `ca-cbc-web-stg-cc-001`, built and deployed only
through the approved `azure-deploy.yml`, and prove smoke tests S1–S12 against
the staging Supabase project and the Inngest staging branch environment.

Gate 006C passes only when all of these hold:

1. The `azure-deploy` staging run for a master SHA succeeds: the new revision
   is the latest ready revision with the expected image, and
   `/api/healthz` returns 200.
2. `scripts/azure-hosting/smoke.ts <stg> <stg>` reports 11 passed, 0 failed.
3. S4–S12 (Gate 006A section 7) pass, including S8 completing in the staging
   Inngest branch environment and S11 sign-out landing on the staging origin.
4. Log Analytics shows no secret values and no unhandled errors for the test
   window.
5. Latency and cost observations are recorded.
6. Vercel production is untouched throughout (no DNS change in 006C).

## 2. Azure prerequisites (founder)

| # | Prerequisite | How to confirm | Evidence for review (no secrets) |
| --- | --- | --- | --- |
| P1 | Subscription and `rg-cbc-prod-canadacentral-001` exist; founder holds Owner or User Access Administrator (needed for role assignments) | Portal or `az role assignment list --assignee <founder>` | Screenshot or text naming the role and scope |
| P2 | Resource providers registered: `Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.OperationalInsights`, `Microsoft.ManagedIdentity` | `az provider show -n <ns> --query registrationState` | "Registered" for each |
| P3 | Names free: `crcbcprodcc001` (global), `log-cbc-prod-cc-001`, `cae-cbc-prod-cc-001`, `id-cbc-web-cc-001`, both app names | `az acr check-name -n crcbcprodcc001`; the what-if shows "Create", not "Modify" | Output lines |
| P4 | `kv-cbc-prod-cc-001` uses **Azure RBAC** authorization (required for the Key Vault Secrets User role) | `az keyvault show -n kv-cbc-prod-cc-001 --query properties.enableRbacAuthorization` | `true` |
| P5a | Key Vault secret **names** as in `main.parameters.json` (7 names: `cbc-stg-supabase-service-role-key`, `cbc-prod-supabase-service-role-key`, `cbc-shared-google-web-risk-api-key`, `cbc-stg-inngest-event-key`, `cbc-stg-inngest-signing-key`, `cbc-prod-inngest-event-key`, `cbc-prod-inngest-signing-key`) | ChatGPT's PR #34 review reports that the founder approved these names before the PR #32 merge. Claude has not seen that approval, and another agent's statement is not founder approval (AGENTS.md section 3), so the founder confirms it in their own words | The founder's confirmation |
| P5b | Creating the 7 secrets with **values** copied from Vercel | **Not approved.** A separate founder-only action (secrets; AGENTS.md sections 6.3 and 20) | Names listed in the portal, never values |
| P6 | Plain values decided: `INNGEST_ENV` (staging branch environment name), `WEB_RISK_PROVIDER_ENABLED`, `DOMAIN_AGE_PROVIDER_ENABLED` (copy current Vercel Preview values) | Vercel dashboard (names and non-secret values) | Values, since they are not secrets |
| P7 | Budget alert ($300) still active; optional alert scoped to the new resources | Cost Management | Screenshot |
| P8 | Phase B production cost decision (section 4), taken **before** any provisioning step | Founder | Recorded decision (option 1 or 2); no default is assumed |

Off limits and unchanged: the `cbcpgadmin` item and `pg-cbc-prod-cc-001`
(`.agents/state.yaml` `off_limits`). Gate 006C does not touch the Azure
PostgreSQL server; Phase 1 runs on Supabase.

## 3. Bicep validation plan

The Bicep has **never been compiled** (Gate 006B had no Bicep CLI). It is
validated in increasing order of risk; stop at the first failure and share
the output for analysis. B1–B3 run offline on the founder's machine. **B4–B7
all access Azure** and each needs founder authorization: B4 and B6 change
nothing, B5 and B7 create resources.

Resource counts below were checked against `infra/azure/hosting/main.bicep`
and `modules/web-app.bicep` at `master@754b945`.

| Step | Command (founder) | Touches Azure? | Pass condition |
| --- | --- | --- | --- |
| B1 | `az bicep version` | No (offline) | Bicep 0.23 or later (the template uses the `!` non-null assertion on conditional module outputs) |
| B2 | `az bicep build --file infra/azure/hosting/main.bicep --stdout` | No (offline) | Compiles with no errors (the ARM JSON is printed). Review any warnings |
| B3 | `az bicep lint --file infra/azure/hosting/main.bicep` | No (offline) | No errors |
| B4 | Phase A what-if: `az deployment group what-if --resource-group rg-cbc-prod-canadacentral-001 --template-file infra/azure/hosting/main.bicep --parameters infra/azure/hosting/main.parameters.json` | **Yes**: signs in and reads Azure; changes nothing. Founder authorization required | Exactly **6 Create**: `id-cbc-web-cc-001` (userAssignedIdentities), `crcbcprodcc001` (registries), `log-cbc-prod-cc-001` (workspaces), `cae-cbc-prod-cc-001` (managedEnvironments), and 2 roleAssignments (AcrPull on the registry; Key Vault Secrets User on `kv-cbc-prod-cc-001`). **No** Container Apps (`deployApps` defaults to `false`); **no** Modify or Delete on any existing resource. The Key Vault itself is only read (`existing`) |
| B5 | Phase A create: the B4 command with `create` in place of `what-if` | **Yes**: creates the 6 resources. Founder authorization required | Succeeds; record outputs `registryLoginServer`, `identityClientId`, `stagingPublicOrigin` |
| B6 | Phase B what-if: the B4 command plus `--parameters deployApps=true stagingImage=<stg ref> productionImage=<prod ref>`. First, no `REPLACE_WITH_` value may remain in `main.parameters.json` (those values feed only the Phase B app environments) | **Yes**: reads Azure; changes nothing. Founder authorization required, and only after the P8 decision | **2 Create**: `ca-cbc-web-stg-cc-001` and `ca-cbc-web-prod-cc-001` (containerApps, through the `web-staging` and `web-production` module deployments). The 6 Phase A resources show NoChange; no Modify or Delete |
| B7 | Phase B create: the B6 command with `create` | **Yes**: creates both apps; the production app starts its always-on replica. Founder authorization required | Both apps provisioned; the staging revision becomes healthy once the Key Vault references resolve |

Optional, needs founder approval because it downloads a binary: let Claude run
B1–B3 locally (`az bicep install`), so compile errors are fixed on a gate
branch before the founder runs B4. Claude would never run B4–B7, because they
all access Azure (AGENTS.md section 8). Until then, B1–B3 are founder-run.

Known review points for the what-if output:

- Role definition IDs: AcrPull `7f951dda-4ed3-4680-a7ca-43fe172d538d`,
  Key Vault Secrets User `4633458b-17de-408a-b874-0445c86b69e6`.
- API versions `2023-*`/`2024-03-01`; newer versions are fine if the CLI
  suggests them, but that is a template change on a gate branch.
- Role-assignment propagation can delay the first Key Vault reference
  resolution in B7; wait a few minutes and retry once before debugging.

## 4. Costs

Estimates from Gate 006A section 4 (unverified list prices, Canada Central,
consumption plan):

| Item | Approx. monthly | 006C note |
| --- | --- | --- |
| Staging app (scale to zero) | $0–5 | Billed only while smoke tests run |
| Production app (min 1 replica, 0.5 vCPU / 1 GiB) | $25–35 | **Created by Phase B, before cutover** (see decision below) |
| Container registry Basic | about $5 | From Phase A |
| Log Analytics (0.5 GB/day cap, 30 days) | $1–5 | Cap bounds the worst case |
| Identity, managed certificate | $0 | |

**Decision for the founder before provisioning (P8):** as merged, Phase B
creates **both** apps, and the production app always keeps one replica
(`minReplicas: 1` in `main.bicep`). Production hosting cost therefore starts
when B7 runs, about a week before the DNS cutover. This plan assumes neither
option; the founder chooses before B6:

1. Keep the merged template and accept the early cost (roughly $6–9 for the
   extra days at the section 4 estimate).
2. Approve a small Bicep change on a gate branch first, making production
   `minReplicas` a parameter (0 until cutover, then 1). That is a code change
   with its own review and approval, and it adds a step before B6.

Either way, from B7 on, the production app runs the production configuration
(production Supabase project and Inngest keys) on its default Azure FQDN,
although no DNS points at it until Gate 006D.

Cost evidence for 006C: Cost Management for the resource group after 24–48
hours, compared with the estimate.

## 5. Security checklist

| Area | Control | Source |
| --- | --- | --- |
| Deploy authentication | OIDC federated credentials only, subjects `repo:wberytech-stack/checkbeforeclick:environment:azure-staging` and `…:azure-production`; no client secret anywhere | AGENTS.md section 20 |
| Deploy permissions | `AcrPush` on `crcbcprodcc001`; update rights scoped to the two Container Apps (or a narrow custom role with `Microsoft.App/containerApps/read` and `write`). Confirm built-in role names in the portal (unverified here) | 006B runbook step 3 |
| GitHub gates | `azure-staging` and `azure-production` environments with the founder as required reviewer and deployment branches limited to `master`; `CBC_AZURE_DEPLOY_ENABLED=enabled` set **last** | 006B workflow and runbook |
| Workflow guards | Dispatch-only, master-only, master-ancestry check, required https `NEXT_PUBLIC_APP_URL`, fail closed when variables are missing or the app does not exist | `scripts/azure-hosting/test-hosting-safety.ts` (80 checks) |
| Runtime secrets | Key Vault references by name through `id-cbc-web-cc-001`; no secret in the image (verified in 006B); staging never uses production secrets | 006B validation |
| Registry | Admin user disabled; pull by managed identity | Bicep |
| Ingress | HTTPS only (`allowInsecure: false`) | Bicep |
| Staging isolation | Staging Supabase project; Inngest branch environment via `INNGEST_ENV`; `INNGEST_SERVE_ORIGIN` = staging origin | `docs/ENVIRONMENTS.md` sections 9 and 10 |
| Auth redirects | Staging Supabase redirect URL `<stagingPublicOrigin>/auth/callback`; `CBC_STG_NEXT_PUBLIC_APP_URL` = staging origin | 006B findings |
| Logs | Log Analytics retention 30 days; check that no secret values appear (S12) | Bicep, 006A S12 |
| Legacy key | `SUPABASE_SERVICE_ROLE_KEY` is provided only to preserve existing behavior; no new use (AGENTS.md section 12) | |
| Agents | Claude never reads Azure credentials, Key Vault values, or Container Apps secrets; it analyzes only founder-shared, secret-free output | AGENTS.md sections 8, 11, 20 |

## 6. Execution sequence (founder approval points marked **A**)

1. **A** Approve starting Gate 006C (names this plan's scope).
2. **A** Decide P8 (production cost timing; section 4) and confirm P5a (secret
   names) in your own words. If option 2 is chosen, its Bicep change is
   reviewed and merged first.
3. P1–P4 and P6–P7 completed; B1–B3 pass (offline).
4. **A** Authorize B4 (Phase A what-if; Azure access) and review its output
   against section 3.
5. **A** Authorize B5 (Phase A create).
6. **A** Founder-only secrets and settings actions: create the 7 Key Vault
   secrets with values (P5b); fill the `REPLACE_WITH_` values in
   `main.parameters.json` (staging `INNGEST_SERVE_ORIGIN` =
   `stagingPublicOrigin`); set up the OIDC identity, GitHub environments and
   variables (006B runbook steps 1, 3 and 4; `CBC_STG_NEXT_PUBLIC_APP_URL` =
   `stagingPublicOrigin`); add the Supabase staging redirect URL.
7. **A** Dispatch `azure-deploy` for staging, then production, with the same
   master SHA. Both runs are **expected to fail after pushing their images**
   ("Container App … not found"); record both image refs.
8. **A** Authorize B6 (Phase B what-if; Azure access) and review it against
   section 3.
9. **A** Authorize B7 (Phase B create; production replica cost starts per P8).
10. **A** Dispatch `azure-deploy` for staging again; it must succeed.
11. Sync the app in the Inngest staging branch environment
    (`<stagingPublicOrigin>/api/inngest`); there is no Vercel integration on Azure.
12. Testing (section 8), then the founder shares the evidence for Claude's analysis.

## 7. Rollback and containment

Vercel production is not affected by any 006C step: there is no DNS change and
no change to Vercel.

| Situation | Action (founder) |
| --- | --- |
| B4 or B6 shows anything other than the expected Create/NoChange set (section 3), or any Modify/Delete on an existing resource | Stop; do not apply; share the output |
| B5 or B7 fails part-way | Re-run the same deployment (idempotent); if abandoning, delete only the resources the deployment created (identity, registry, workspace, environment, apps, the 2 role assignments). Never touch Key Vault itself or `pg-cbc-prod-cc-001` |
| A staging deploy revision is unhealthy | Nothing to do for traffic: in single-revision mode the previous revision keeps serving; the workflow fails closed. Investigate logs; redeploy a known-good SHA |
| A bad revision became active | `az containerapp revision list` / `revision activate` the previous revision, or redeploy the previous SHA |
| A secret was exposed in logs or output | Rotate it at the source (Supabase, Inngest, Google), update Key Vault, restart the revision; record the incident |
| Freeze all Azure deploys | Set `CBC_AZURE_DEPLOY_ENABLED` to anything other than `enabled` (every job is skipped) |
| Remove Key Vault access | Delete the `id-cbc-web-cc-001` role assignment on the vault |
| Cost runaway | Scale staging to 0 (it already is when idle); the Log Analytics cap limits ingestion |

## 8. Testing plan

| Test | Method | Pass condition |
| --- | --- | --- |
| Workflow run | Founder shares the run log | Revision-ready wait names the expected image; healthz 200 |
| S1–S3, API guards, callback, sign-out | `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/azure-hosting/smoke.ts <stg> <stg>` | 11 passed, 0 failed |
| S4 | Register (and confirm, if enabled) with a staging test account, then log in | Session established; dashboard loads |
| S5–S7 | Fast URL scan, domain scan, `localhost` | 201 `complete`; 201 `complete`; 201 `unknown` with one evidence item |
| S8 | Slow-path (email) scan | Run COMPLETES in the staging Inngest branch environment; none in Inngest production |
| S9–S10 | Status endpoint, scan page, history, watchlist | Consistent with the POST; signed-in user only |
| S11 | Sign out | Redirect to `<stg>/login`; protected routes redirect again |
| S12 | Log Analytics query over the test window (console and system logs) | No secret values; no unhandled errors |
| Latency | Time 5 fast scans on staging and on the Vercel Preview | Recorded (Supabase in Tokyo, app in Canada Central); acceptable for Phase 1 per 006A |
| Cold start | First request after scale-to-zero idle | Recorded; one healthz retry is acceptable |
| Cost | Cost Management after 24–48 h | Within section 4 |

Evidence package for Claude (secret-free): what-if outputs (B4, B6), workflow
run logs, `smoke.ts` output, S4–S12 notes, the log query results, latency
timings, and the cost screenshot. Claude's 006C role is analysis and
documentation on a gate branch only.

## 9. Repository work possibly needed during 006C (each needs approval)

- Fixes found by B2/B3 or B4 (Bicep only), on a gate branch with a draft PR.
- Optional production `minReplicas` parameter (section 4, option 2).
- Optional post-deploy Inngest sync step in `azure-deploy.yml`.
- The 006C results document and the `state.yaml` update after the gate.

## 10. Decisions needed from the founder

1. Approve starting Gate 006C when provisioning is ready (P1–P8).
2. Confirm the Key Vault secret names in your own words (P5a). Creating the
   secret values (P5b) is a separate approval.
3. Phase B production cost timing (P8, section 4), decided before any
   provisioning. No option is assumed.
4. Authorize each Azure step separately, including the `what-if` runs B4 and
   B6, which change nothing but still access Azure.
5. Whether Claude may install the Bicep CLI locally for offline compile and
   lint (B1–B3) before the founder's what-if.
6. Whether a later gate should automate the Inngest sync after each deploy.

## Out of scope

Production deployment, DNS, custom domains, certificates, and Vercel
retirement (Gate 006D and later); Phase 2 direct PostgreSQL; dependency
changes; any action on `pg-cbc-prod-cc-001` or the `cbcpgadmin` item.
