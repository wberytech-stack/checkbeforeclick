# Gate 006C - B4 Phase A what-if handoff (prepared offline)

## Status

> **Update 2026-10-17: B4 was run by the founder and PASSED** (6 to create, 2
> to ignore). B5 (Phase A create) then succeeded. Results:
> `docs/gates/gate-006c-b4-b5-results.md`. The text below is the runbook as
> prepared.

**Prepared offline. B4 has not been run.** This is the founder's runbook for
the first Azure-touching step of Gate 006C: the Phase A `what-if` (B4 in
`docs/gates/gate-006c-staging-readiness-plan.md`, section 3).

- `what-if` changes nothing, but it signs in to Azure and reads the
  subscription, so it is Azure access. **It needs the founder's explicit
  authorization, and only the founder runs it** (AGENTS.md sections 6.3, 8 and
  20).
- Nothing in this document was executed against Azure. No secret values were
  created or read, and no GitHub setting changed.
- Base: `master` **after PR #37 (P8) merges**. First written against
  `master@3fad5db` and merged in PR #36 (`e157572`); refreshed in PR #37
  because P8 changes `main.bicep` and `main.parameters.json`. The files under
  `infra/azure/hosting/` are then exactly those of commit `336fa30`, the last
  commit that changes them.

## 1. Decision recorded: P5a (Key Vault secret names)

On 2026-10-17 the founder's message in the Claude Code session stated:
"Founder has confirmed all seven Key Vault secret names in the merged
staging-readiness plan (P5a)." The confirmed names (`main.parameters.json`):

| Environment | Secret key in template | Key Vault secret name |
| --- | --- | --- |
| Staging | `supabaseServiceRoleKey` | `cbc-stg-supabase-service-role-key` |
| Staging | `googleWebRiskApiKey` | `cbc-shared-google-web-risk-api-key` |
| Staging | `inngestEventKey` | `cbc-stg-inngest-event-key` |
| Staging | `inngestSigningKey` | `cbc-stg-inngest-signing-key` |
| Production | `supabaseServiceRoleKey` | `cbc-prod-supabase-service-role-key` |
| Production | `googleWebRiskApiKey` | `cbc-shared-google-web-risk-api-key` (shared with staging) |
| Production | `inngestEventKey` | `cbc-prod-inngest-event-key` |
| Production | `inngestSigningKey` | `cbc-prod-inngest-signing-key` |

That is 7 distinct names. **P5b (creating the secrets with values) remains
unapproved**, and B4 does not need it: Phase A never references a secret.

## 2. Verified inputs (offline; refreshed 2026-10-17 for P8)

| Check | Result |
| --- | --- |
| Bicep CLI | 0.48.1 (cec7951cf6), installed with founder approval |
| `bicep build infra/azure/hosting/main.bicep` (infra as of `336fa30`, PR #37 branch merged with `master@e157572`) | Exit 0, no diagnostics |
| `bicep lint` on `main.bicep` and `modules/web-app.bicep` | Exit 0, no diagnostics |
| `scripts/azure-hosting/test-hosting-safety.ts` | 103 passed, 0 failed (LF and CRLF checkouts) |
| Compiled ARM | 12 required parameters, all in `main.parameters.json`; 6 unconditional resources |
| SHA-256 `infra/azure/hosting/main.bicep` (LF) | `42ac6d5a85bba47ed45587639eacad40415cc7da6da14867078eba20fad87c2a` |
| SHA-256 `infra/azure/hosting/modules/web-app.bicep` (LF) | `699dfb2c0366ba2e770ecf77363e22be4386ceaf3bb9da06632f0bd839b109a7` |
| SHA-256 `infra/azure/hosting/main.parameters.json` (LF) | `9ce5e0b64fd7038119e7d1efbae720aa1bb5bcc12fe359f26236722bca2f8716` |

Earlier values, before P8, at `master@3fad5db`: `main.bicep` `2c62b141…`,
`web-app.bicep` `7b9e1146…`, `main.parameters.json` `d2811027…`. Safety was
92/92 then.

The hashes are of LF files. A Windows checkout with `core.autocrlf=true` has
CRLF files and different hashes. **The authoritative check is Git:**
`git diff --stat 336fa30 HEAD -- infra/azure/hosting` must print nothing
(section 5, step 1).

## 3. What B4 evaluates (from the compiled ARM template)

With `deployApps=false`, the compiled template has exactly **6 unconditional
resources**. The 2 app deployments are conditional and are skipped.

| # | Type @ API version | Name | Scope | Location |
| --- | --- | --- | --- | --- |
| 1 | `Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31` | `id-cbc-web-cc-001` | resource group | RG location |
| 2 | `Microsoft.ContainerRegistry/registries@2023-07-01` | `crcbcprodcc001` (Basic, admin user disabled) | resource group | RG location |
| 3 | `Microsoft.OperationalInsights/workspaces@2023-09-01` | `log-cbc-prod-cc-001` (PerGB2018, 30 days, 0.5 GB/day cap) | resource group | RG location |
| 4 | `Microsoft.App/managedEnvironments@2024-03-01` | `cae-cbc-prod-cc-001` (logs to #3) | resource group | RG location |
| 5 | `Microsoft.Authorization/roleAssignments@2022-04-01` | `guid(registry, identity, AcrPull)` | registry #2 | - |
| 6 | `Microsoft.Authorization/roleAssignments@2022-04-01` | `guid(vault, identity, Key Vault Secrets User)` | **existing** `kv-cbc-prod-cc-001` | - |

- **Parameters Phase A uses:** `identityName`, `registryName`,
  `logAnalyticsName`, `environmentName`, `keyVaultName`, `logDailyQuotaGb`
  (default `0.5`), `location` (default `resourceGroup().location`), `tags`
  (default).
- **Parameters Phase A ignores:** `stagingAppName`, `productionAppName`,
  `deployApps`, `stagingImage`, `productionImage`, `productionMinReplicas`
  (P8), both `*SecretNames`, both `*PlainEnv`. `productionMinReplicas` has no
  default, so the parameters file must still carry it even for Phase A. It
  does (`0`), and the B4 commands pass that file.
- **Placeholders:** `main.parameters.json` still has 6 `REPLACE_WITH_` values
  (4 in `stagingPlainEnv`, 2 in `productionPlainEnv`). They feed only the Phase
  B app deployments, so they **do not block B4**. They must be filled before B6.
- **Role definition IDs:** AcrPull `7f951dda-4ed3-4680-a7ca-43fe172d538d`;
  Key Vault Secrets User `4633458b-17de-408a-b874-0445c86b69e6`.
- **Key Vault lookup:** `resourceId('Microsoft.KeyVault/vaults', 'kv-cbc-prod-cc-001')`
  in the **deployment's resource group**, so the vault must be in
  `rg-cbc-prod-canadacentral-001`.

## 4. Prerequisites (founder) and blockers

| # | Item | Evidence in the repository | Status for B4 |
| --- | --- | --- | --- |
| A1 | **Founder authorization for B4** (names the action) | None yet | **Blocker** |
| A2 | P8 (Phase B production cost timing). The merged plan's sequence (section 6, step 2) decides it before any Azure step | **Decided 2026-10-17: option 2** (`productionMinReplicas`, 0 until cutover), implemented in PR #37 (`docs/gates/gate-006c-p8-production-min-replicas.md`) | Not a blocker once PR #37 is merged. Run B4 after that merge, so the previewed template is the one that will be applied |
| A3 | P1: right subscription and tenant; founder holds Owner or User Access Administrator on `rg-cbc-prod-canadacentral-001` | Not in the repository | Founder confirms (the B4 commands below show the signed-in account) |
| A4 | RG location is `canadacentral` (template location = RG location) | `docs/azure/FOUNDATION.md:641-642`; audit 2026-06-19 | Historical; B4 prints it (step 3) |
| A5 | `kv-cbc-prod-cc-001` is in `rg-cbc-prod-canadacentral-001` | `docs/azure/FOUNDATION.md:671-673` | Historical; if wrong, B4 fails with a not-found or scope error (stop condition) |
| A6 | P4: vault uses Azure RBAC | Audit 2026-06-19 ("Standard, RBAC, purge-protected") | Historical. Not needed for B4 to succeed (a role assignment is created either way), but needed for Phase B runtime |
| A7 | P2: providers registered (`Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.OperationalInsights`, `Microsoft.ManagedIdentity`) | Not in the repository | `what-if` reports an unregistered provider as an error (stop condition) |
| A8 | P3: names available, especially the global registry name `crcbcprodcc001` | Not in the repository | **`what-if` does not detect a global name clash**: it shows Create, and only B5 would fail. Check before B5 (an Azure read, so under the same authorization or a separate one) |
| A9 | Founder workstation: Azure CLI signed in; repository at `master` including the PR #37 merge (infra identical to `336fa30`) | - | Founder |
| A10 | P5b secret values, P6 plain values, GitHub environments and variables, OIDC | - | **Not needed for B4** |

## 5. Exact commands (founder only, after authorization)

Run from the repository root. Each command is one line (Windows PowerShell and
bash alike).

1. Confirm the code being previewed (offline):

   ```bash
   git fetch origin
   ```
   ```bash
   git switch --detach origin/master
   ```
   ```bash
   git log --oneline -1
   ```
   ```bash
   git diff --stat 336fa30 HEAD -- infra/azure/hosting
   ```
   The `git log` line records the exact master commit previewed; include it
   with the shared output. The last command must print nothing. It also proves
   PR #37 is merged, because before that merge `main.bicep` differs from
   `336fa30`.

2. Confirm the Azure context (Azure read):

   ```bash
   az account show --query "{subscription:name, subscriptionId:id, tenantId:tenantId, user:user.name}" -o table
   ```
   Stop if this is not the CBC subscription and tenant.

3. Confirm the resource group and its location (Azure read):

   ```bash
   az group show --name rg-cbc-prod-canadacentral-001 --query "{name:name, location:location}" -o table
   ```
   Expected: location `canadacentral`.

4. **B4, human-readable** (Azure read; no change):

   ```bash
   az deployment group what-if --resource-group rg-cbc-prod-canadacentral-001 --name cbc-hosting-phase-a-whatif --template-file infra/azure/hosting/main.bicep --parameters infra/azure/hosting/main.parameters.json --parameters deployApps=false
   ```

5. **B4, machine-readable copy for analysis** (optional; the same preview again):

   ```bash
   az deployment group what-if --resource-group rg-cbc-prod-canadacentral-001 --name cbc-hosting-phase-a-whatif --template-file infra/azure/hosting/main.bicep --parameters infra/azure/hosting/main.parameters.json --parameters deployApps=false --no-pretty-print > whatif-phase-a.json
   ```

Notes:
- `deployApps=false` is the template default; passing it explicitly makes the
  intent visible in the command and the output.
- The first `az deployment` call with a `.bicep` file may install the Bicep CLI
  on the founder's machine.
- **Never** follow with `az deployment group create`: that is B5 and needs its
  own authorization.

## 6. Expected output

Summary line: **`Resource changes: 6 to create.`** Resources not in the
template may also be listed as **Ignore**, for example
`pg-cbc-prod-cc-001`, `kv-cbc-prod-cc-001`, and any other resource already in
the group. Ignore is expected in incremental mode and means "left untouched".

The 6 Create entries (`+`) and what to spot-check in each:

| Create | Spot-check |
| --- | --- |
| `Microsoft.ManagedIdentity/userAssignedIdentities/id-cbc-web-cc-001` | `location: "canadacentral"`; tags `project: checkbeforeclick`, `gate: 006B` |
| `Microsoft.ContainerRegistry/registries/crcbcprodcc001` | `sku.name: "Basic"`; `adminUserEnabled: false`; `publicNetworkAccess: "Enabled"` |
| `Microsoft.OperationalInsights/workspaces/log-cbc-prod-cc-001` | `sku.name: "PerGB2018"`; `retentionInDays: 30`; `workspaceCapping.dailyQuotaGb: 0.5` |
| `Microsoft.App/managedEnvironments/cae-cbc-prod-cc-001` | `appLogsConfiguration.destination: "log-analytics"`; `customerId` and `sharedKey` shown as unevaluated expressions (the workspace does not exist yet) |
| `.../registries/crcbcprodcc001/providers/Microsoft.Authorization/roleAssignments/<guid>` | `roleDefinitionId` ends with `7f951dda-4ed3-4680-a7ca-43fe172d538d`; `principalType: "ServicePrincipal"`; `principalId` unevaluated |
| `.../vaults/kv-cbc-prod-cc-001/providers/Microsoft.Authorization/roleAssignments/<guid>` | `roleDefinitionId` ends with `4633458b-17de-408a-b874-0445c86b69e6`; scope is the existing vault |

Not expected: any `~ Modify`, `- Delete`, `* Deploy`, or a Container App.

## 7. Safety checks before sharing the output

- **No secret values.** The environment's `sharedKey` should appear only as an
  expression such as `[listKeys(...).primarySharedKey]`. If a literal key value
  ever appears (possible only if the workspace already existed), redact it and
  treat it as a stop condition (section 8). The key is also rotatable.
- Subscription and tenant IDs appear in resource IDs. They are not secrets, but
  the founder may redact them before sharing.
- Share the human-readable output and, if produced, `whatif-phase-a.json`. Do
  not share `az account` tokens, `~/.azure` files, or any `az login` output.

## 8. Stop conditions (do not proceed to B5; share the output)

1. The change summary differs from **6 to create**, or any Modify, Delete, or
   Deploy appears.
2. Any resource outside the 6 is created, or any Container App, Key Vault,
   PostgreSQL, or budget resource is anything other than Ignore.
3. The location of any created resource is not `canadacentral`.
4. Errors such as `ResourceNotFound`/`ParentResourceNotFound` for the vault,
   `MissingSubscriptionRegistration`, `AuthorizationFailed`, `InvalidTemplate`,
   or `InvalidTemplateDeployment`.
5. A role assignment shows an unexpected `roleDefinitionId` or scope.
6. A literal secret or key value appears in the output.
7. The subscription, tenant, or resource group differs from the expected CBC
   values.
8. `git diff --stat 336fa30 HEAD -- infra/azure/hosting` is not empty (the
   template differs from the reviewed one, or PR #37 is not merged yet).

## 9. After B4

- The founder shares the secret-free output. Claude analyzes it against
  sections 6–8 and reports the result in a gate document (no Azure access).
- B5 (Phase A create) needs **separate** founder authorization. Before B5:
  A8 (registry name availability) and the remaining P-items in the plan's
  sequence.
- Nothing in B4 incurs cost. Costs start at B5 (registry, Log Analytics).
  Under P8 option 2, B7 creates production with `minReplicas: 0`, so replica
  compute is billed only while a replica runs. The always-on replica charge
  starts at the explicit cutover change to `1` (Gate 006D;
  `docs/gates/gate-006c-p8-production-min-replicas.md`). Scale to zero is not
  zero total cost.
