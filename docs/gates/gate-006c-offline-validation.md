# Gate 006C - Offline validation of the Azure hosting configuration

## Status and scope

The founder approved starting Gate 006C **for planning and offline validation
only** (2026-10-17). This document records that offline work.

- **Base:** `master@e63b87b` (PRs #32, #33 and #34 merged).
- **Not done, by design:** no Azure access, no `what-if`, no provisioning or
  deployment, no new tools installed, no secret or settings change, no merge.
- **Reviewed:** `infra/azure/hosting/main.bicep`,
  `infra/azure/hosting/modules/web-app.bicep`,
  `infra/azure/hosting/main.parameters.json`, and
  `.github/workflows/azure-deploy.yml`, against
  `docs/gates/gate-006c-staging-readiness-plan.md`.

## Tools available offline

| Tool | Present | Used |
| --- | --- | --- |
| Bicep CLI (`bicep`, `~/.azure/bin`, VS Code extension, NuGet package) | **No** | Not installed (installing needs founder approval) |
| `az bicep …` | Not run | It can download the Bicep CLI on its own, which is a new tool install |
| Node 24.14.0 with the lockfile `yaml` package | Yes | Static and structural checks |
| bash | Yes | `bash -n` and offline execution of workflow steps |
| Docker images | `postgres:16`, `supabase/postgres` only | None suitable; no image pulled |
| shellcheck, actionlint, yamllint | No | Not available |

So the Bicep is still **not compiled**. Validation used a line-by-line review
and scripted structural checks that target the error classes a compile or
deployment would report.

## Findings

### F1 (fixed): compile error in `modules/web-app.bicep` (BCP138)

The container `env` was built as
`concat([for s in secretMap: {...}], [...], plainEnv)`. Bicep accepts a
for-expression only as the value of a resource, module, variable, or output
declaration, or of a resource or module property, **never as a function
argument**. That is error BCP138, so the module, and with it `main.bicep`,
would not compile. Every Bicep step from B2 on (Gate 006C plan section 3)
would have failed.

Fix in this gate: `var secretEnv = [for s in secretMap: { name: s.envName,
secretRef: s.name }]`, then `env: concat(secretEnv, [...], plainEnv)`. The
deployed result is the same: the same 4 secret references, then `PORT` and
`HOSTNAME`, then the plain variables.

Confidence: high, from Bicep's documented loop rules. It is not
compiler-confirmed: the founder's offline B2 (`az bicep build`) is the first
real confirmation.

### Reviewed with no defect found

| Area | Result |
| --- | --- |
| Resource property names and nesting for the declared API versions (`userAssignedIdentities@2023-01-31`, `registries@2023-07-01`, `workspaces@2023-09-01`, `managedEnvironments@2024-03-01`, `containerApps@2024-03-01`, `roleAssignments@2022-04-01`) | Consistent with those API shapes, including `workspaceCapping.dailyQuotaGb`, `appLogsConfiguration.logAnalyticsConfiguration`, Container Apps `secrets[].keyVaultUrl` + `identity`, `registries[].identity`, `probes` (`Liveness`, `Readiness`), `ingress.allowInsecure` |
| Role assignments | `name` uses `guid()` over IDs known at deployment start; scopes are the registry and the existing Key Vault; `principalType: 'ServicePrincipal'` is correct for a user-assigned identity |
| Conditional modules and outputs | `if (deployApps)` on both modules; outputs use `deployApps ? staging!.outputs.fqdn : ''` (ARM evaluates only the taken branch) |
| Key Vault reference URL | `vaultUri` ends with `/`, so `${keyVaultUri}secrets/<name>` is well formed |
| Name constraints | Container App names 22 characters or fewer (limit 32); registry name alphanumeric; Container Apps secret names lowercase with dashes |
| CPU and memory | `0.5` vCPU with `1Gi` is a valid Consumption combination |
| Parameters file | Matches the template (scripted check below) |

### Notes, not defects

- **N1:** `az bicep build/lint` on the founder's machine may install the Bicep CLI
  the first time. That is expected for B1–B3 and is the founder's action.
- **N2:** GitHub's Node 20 deprecation notice also applies to the actions in
  `azure-deploy.yml` (`actions/checkout@v4`, `setup-node@v4`,
  `upload-artifact@v4`, `download-artifact@v4`, `azure/login@v2`). They run on
  Node 24 for now; a later version bump is optional.
- **N3:** `ubuntu-latest` moves to Ubuntu 26 from 2026-10-19. The deploy job
  relies on the runner's preinstalled Azure CLI and Docker; confirm on the first
  run (unverified).
- **N4:** The built-in role name for the deploy identity's Container Apps update
  permission is still unverified (plan section 5).

## Validation evidence (2026-10-17)

| Check | Result |
| --- | --- |
| `scripts/azure-hosting/test-hosting-safety.ts` | **92 passed, 0 failed** (80 before plus 12 new structural checks) |
| New: no for-expression as a function argument (BCP138), both files | Pass; **fails on the merged `754b945` module**, so F1 is caught |
| New: balanced braces, brackets, parentheses (string- and comment-aware) | Pass |
| New: every required `main.bicep` param is in `main.parameters.json`, and no unknown key (ARM rejects unknown parameters) | Pass |
| New: both module calls pass every required `web-app.bicep` param and no unknown one | Pass |
| New: `stagingSecretNames` / `productionSecretNames` keys equal the module's `secretMap` vault keys | Pass |
| New: every symbol used with `.id`/`.properties`/`.outputs` in `main.bicep` is a declared resource or module | Pass |
| Mutation check of the new checks in a scratch copy: original module, unknown parameter, missing parameter, missing module argument, secret-key typo, unbalanced brace | **All 6 caught** |
| `azure-deploy.yml` `run:` blocks, `bash -n` | 8 of 8 pass |
| Workflow validation step run offline with controlled inputs | 2 valid configurations pass with the right `image_tag`; 10 invalid ones (unknown environment, short, uppercase or metacharacter SHA, missing Supabase values, missing, `http`, or path-bearing `NEXT_PUBLIC_APP_URL`) all fail with no output |
| Deploy job Azure-variable check run offline | Passes when all 6 are set; fails for each one left empty |
| ESLint and strict `tsc` on `scripts/azure-hosting/` | Pass |

The workflow harness (`wf-offline.mjs`) is kept outside the repository as
evidence (AGENTS.md section 15), together with the raw outputs.

## Remaining before any Azure step (unchanged from the plan)

1. Founder confirms the Key Vault secret names (P5a) and decides the Phase B
   production cost timing (P8).
2. Founder runs B1–B3 offline. B2 is the first real compile, and should be
   done after this fix is merged.
3. Each Azure step, including the B4 and B6 `what-if` runs, needs the founder's
   separate authorization.

## Changed files

| File | Change |
| --- | --- |
| `infra/azure/hosting/modules/web-app.bicep` | F1 fix: `secretEnv` variable; `env` concatenates it |
| `scripts/azure-hosting/test-hosting-safety.ts` | 12 structural Bicep checks with a string- and comment-aware scanner |
| `docs/gates/gate-006c-offline-validation.md` | This document |
| `docs/gates/gate-006c-staging-readiness-plan.md` | Section 3 points to this document; B2 runs after F1 is merged |
