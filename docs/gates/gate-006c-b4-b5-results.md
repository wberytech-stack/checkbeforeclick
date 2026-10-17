# Gate 006C - B4 (Phase A what-if) and B5 (Phase A create) results

## Status

- **B4 passed** and **B5 succeeded**, on 2026-10-17, against
  `master@c220dda5bab99751b25f51fe583636f33989c2a3` (PR #37 merge). The
  infrastructure files there are identical to `336fa30`.
- The Phase A platform now exists in `rg-cbc-prod-canadacentral-001`.
- **No Container App exists yet.** Phase B (B6/B7), secrets, GitHub settings,
  and cutover have not started.
- ChatGPT independently reviewed both results and accepted them.

**Redaction:** the repository is public. Subscription and tenant IDs appear as
`<subscription-id>` and `<tenant-id>`. No secret value appeared in any output,
and none is recorded here. Raw command output is kept outside the repository.

## Approval boundaries and who did what

| Step | Founder authorization (2026-10-17) | Operator | Claude Code's role |
| --- | --- | --- | --- |
| B4 | Azure read access to verify prerequisites, plus the Phase A `what-if` with `deployApps=false`. No creation, no secrets, no role-assignment or GitHub changes | Founder | Guided one command at a time and analyzed output. **Ran no Azure command** (AGENTS.md sections 8 and 20 were applied even when asked to run them; the founder kept AGENTS.md unchanged and ran everything) |
| Provider registration | The founder's own action, after B4 stopped (see below) | Founder | Prepared a remediation plan; ran nothing |
| B5 | Phase A create, limited to the six resources approved in the B4 what-if | Founder | Same as B4 |

Following the runbook: "founder-reported" marks output the founder stated in
chat without pasting it. Everything else is the founder's pasted terminal
output, analyzed by Claude.

## B4 - Phase A what-if

Runbook: `docs/gates/gate-006c-b4-whatif-handoff.md`.

### Pre-checks

| Check | Result |
| --- | --- |
| Repository commit | `c220dda5…`; `git diff --stat 336fa30 HEAD -- infra/azure/hosting` empty; Git blob IDs `ef853f09…` (`main.bicep`), `afde115f…` (`main.parameters.json`), `5137463f…` (`modules/web-app.bicep`) |
| Subscription | "Azure subscription 1" (`<subscription-id>`), matching `docs/azure/FOUNDATION.md:622`. The founder's cached sign-in had expired (`AADSTS700082`, 90 days inactive) and was renewed interactively by the founder |
| Resource group | `rg-cbc-prod-canadacentral-001`, `canadacentral` |
| Key Vault | `kv-cbc-prod-cc-001` in that resource group, `canadacentral`, RBAC authorization `True` (founder-reported) |
| Resource providers | **First attempt stopped:** `Microsoft.App` was `NotRegistered` (founder-reported), a runbook stop condition, so the what-if was not run. The founder then registered it (a subscription-level action outside the B4 read authorization, taken by the founder) and reported all four (`Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.OperationalInsights`, `Microsoft.ManagedIdentity`) `Registered` |

### Command and result

```bash
az deployment group what-if --resource-group rg-cbc-prod-canadacentral-001 --name cbc-hosting-phase-a-whatif --template-file infra/azure/hosting/main.bicep --parameters infra/azure/hosting/main.parameters.json --parameters deployApps=false
```

**`Resource changes: 6 to create, 2 to ignore.`** There was no Modify,
Delete, Deploy, or error.

| # | Expected create | Previewed | Checked properties |
| --- | --- | --- | --- |
| 1 | Identity `id-cbc-web-cc-001` | `+ Microsoft.ManagedIdentity/userAssignedIdentities` | `canadacentral`; tags |
| 2 | Registry `crcbcprodcc001` | `+ Microsoft.ContainerRegistry/registries` | `Basic`; `adminUserEnabled: false`; `publicNetworkAccess: Enabled` |
| 3 | Workspace `log-cbc-prod-cc-001` | `+ Microsoft.OperationalInsights/workspaces` | `PerGB2018`; 30 days; `dailyQuotaGb: 0.5` |
| 4 | Environment `cae-cbc-prod-cc-001` | `+ Microsoft.App/managedEnvironments` | `destination: log-analytics`; `customerId` unevaluated reference; `sharedKey` masked `*******` |
| 5 | AcrPull on the registry | `+ …/registries/crcbcprodcc001/…/roleAssignments/b8c7eae4-180a-51ad-91af-cfa998c01c6d` | role `7f951dda-4ed3-4680-a7ca-43fe172d538d`; `principalId` reference to the identity |
| 6 | Key Vault Secrets User on the existing vault | `+ …/vaults/kv-cbc-prod-cc-001/…/roleAssignments/5565f3ef-36ff-5ddb-9685-c2e66ef3a440` | role `4633458b-17de-408a-b874-0445c86b69e6`; `principalId` reference to the identity |

Ignored (left untouched): `pg-cbc-prod-cc-001` and `kv-cbc-prod-cc-001`.
All eight runbook stop conditions were clear. Non-blocking notes at the time:
`principalType` was not displayed (resolved by B5 check 5); the `gate: 006B`
tag default is cosmetic; what-if cannot detect a global registry-name clash
(checked before B5).

## B5 readiness checks (read-only)

| Check | Result |
| --- | --- |
| `az acr check-name --name crcbcprodcc001` | `NameAvailable: True` |
| Founder's effective roles (inherited and groups) at the resource group | **Owner** at subscription scope, which covers the four resources and both role assignments |
| `az consumption budget list` | `cbc-monthly-cost-guardrail`: 300, Monthly (current spend recorded outside the repository) |

## B5 - Phase A create

```bash
az deployment group create --resource-group rg-cbc-prod-canadacentral-001 --name cbc-hosting-phase-a --template-file infra/azure/hosting/main.bicep --parameters infra/azure/hosting/main.parameters.json --parameters deployApps=false --confirm-with-what-if
```

Pre-checks were repeated immediately before: commit `c220dda5…`, clean
templates, subscription, resource group, and a live sign-in. At the
confirmation prompt, the founder inspected the preview: **6 to create, 2 to
ignore**, matching B4, and answered `y`. Result: `provisioningState: Succeeded`,
`error: null` (founder-reported), then confirmed by check 1.

### Post-deployment verification (read-only)

| # | Check | Result |
| --- | --- | --- |
| 1 | `az deployment group show … cbc-hosting-phase-a` | `Succeeded`, `2026-10-17T13:25:56Z`; outputs as listed below; `stagingFqdn` and `productionFqdn` empty (no apps) |
| 2 | `az resource list` (resource group) | Exactly 6 resources, all `canadacentral`: new `cae-cbc-prod-cc-001`, `crcbcprodcc001`, `id-cbc-web-cc-001`, `log-cbc-prod-cc-001`; existing `pg-cbc-prod-cc-001`, `kv-cbc-prod-cc-001`. No Container App |
| 3 | `az acr show`; `az monitor log-analytics workspace show` | Registry `Basic`, admin user `False`, public access `Enabled`, `crcbcprodcc001.azurecr.io`; workspace `PerGB2018`, 30 days, `0.5` GB/day |
| 4 | `az identity show`; `az containerapp env show` | Identity in `canadacentral`, client ID equal to the deployment output; environment `Succeeded`, logs `log-analytics`, default domain `lemonmeadow-5efc7b91.canadacentral.azurecontainerapps.io` |
| 5 | `az role assignment list --assignee <identity principal> --all` | Exactly 2, both **`ServicePrincipal`**: `AcrPull` on `crcbcprodcc001` (`b8c7eae4-…`) and `Key Vault Secrets User` on `kv-cbc-prod-cc-001` (`5565f3ef-…`). Names equal the B4 preview |

Nothing was retried, redeployed, or deleted.

## Non-secret outputs needed for Phase B

| Output | Value | Used for (later, each separately approved) |
| --- | --- | --- |
| `stagingPublicOrigin` | `https://ca-cbc-web-stg-cc-001.lemonmeadow-5efc7b91.canadacentral.azurecontainerapps.io` | `CBC_STG_NEXT_PUBLIC_APP_URL` (GitHub repository variable); staging `INNGEST_SERVE_ORIGIN` in `main.parameters.json` (replaces `REPLACE_WITH_STAGING_PUBLIC_ORIGIN_FROM_PHASE_A_OUTPUT`); staging Supabase redirect URL `<origin>/auth/callback` |
| `registryLoginServer` | `crcbcprodcc001.azurecr.io` | `AZURE_ACR_NAME` = `crcbcprodcc001`; image refs `crcbcprodcc001.azurecr.io/cbc-web:<sha>-<env>` |
| Container Apps environment default domain | `lemonmeadow-5efc7b91.canadacentral.azurecontainerapps.io` | Source of the staging origin and the future production default FQDN |

The identity's client and principal IDs are not recorded here. Phase B does
not need them (the Bicep references the identity by resource ID), and they can
be read at any time with `az identity show`. This identity is the app's
runtime identity, not the GitHub deploy identity, which is a separate OIDC
setup.

## What exists now, and cost

Phase A resources: identity, registry (Basic), Log Analytics workspace,
Container Apps environment (Consumption), and the two role assignments.
Estimated recurring cost is about $5–10 per month: registry about $5; Log
Analytics minimal while no apps log, bounded by the 0.5 GB/day cap; no
environment charge without apps. These are unverified list prices; check Cost
Management after 24–48 hours. The $300 per month budget alert is in place.

## Plan status (`docs/gates/gate-006c-staging-readiness-plan.md`)

| Plan item | Status |
| --- | --- |
| P1 access and role | Done: Owner on the subscription |
| P2 providers | Done: all four registered (founder) |
| P3 names | Done: registry name available; the other names were created in B5 |
| P4 Key Vault RBAC | Done: `True` (founder-reported) |
| P5a secret names | Confirmed (2026-10-17) |
| P5b secret values | **Not approved, not done** |
| P6 plain values | Founder-verified 2026-10-17 and filled in the parameters file (`docs/gates/gate-006c-p6-plain-values.md`); take effect only at B6/B7 |
| P7 budget | Done: alert present |
| P8 production cost timing | Decided: option 2 (PR #37) |
| B1–B3 offline | Done (PR #35) |
| B4 | **Passed** (this document) |
| B5 | **Done** (this document) |
| Sequence step 6 (secrets, plain values, OIDC, GitHub environments/variables, Supabase redirect) | Not started; each needs separate founder approval |
| B6/B7 (Phase B) | Not started |

## Next decisions (founder)

1. Merge this documentation PR (a merge is a Vercel production deployment; no
   app change).
2. Plan sequence step 6, item by item, each separately approved: P5b secrets,
   P6 plain values (including `stagingPublicOrigin`), OIDC deploy identity, the
   GitHub `azure-staging`/`azure-production` environments and variables, and
   the Supabase staging redirect.
3. Then the first image pushes (expected fail-closed), B6 what-if, and B7.
