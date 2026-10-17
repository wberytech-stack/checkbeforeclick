# Gate 006C - Offline validation of the Azure hosting configuration

## Status and scope

The founder approved starting Gate 006C **for planning and offline validation
only** (2026-10-17). This document records that offline work.

- **Base:** `master@e63b87b` (PRs #32, #33 and #34 merged).
- **Not done, by design:** no Azure access, no `what-if`, no provisioning or
  deployment, no secret or settings change, no merge.
- **Bicep CLI:** the first pass (`a944223`) had no compiler. The founder then
  approved installing the Bicep CLI locally (2026-10-17), and the templates
  were compiled and linted (section "Compiler validation" below).
- **Reviewed:** `infra/azure/hosting/main.bicep`,
  `infra/azure/hosting/modules/web-app.bicep`,
  `infra/azure/hosting/main.parameters.json`, and
  `.github/workflows/azure-deploy.yml`, against
  `docs/gates/gate-006c-staging-readiness-plan.md`.

## Tools available offline

| Tool | Present | Used |
| --- | --- | --- |
| Bicep CLI | **No** in the first pass; **v0.48.1 installed after founder approval** | `bicep build`, `bicep lint` (see "Compiler validation") |
| `az bicep install` | Run once, after approval | Downloads the CLI from Bicep's GitHub releases; no Azure sign-in |
| Node 24.14.0 with the lockfile `yaml` package | Yes | Static and structural checks |
| bash | Yes | `bash -n` and offline execution of workflow steps |
| Docker images | `postgres:16`, `supabase/postgres` only | None suitable; no image pulled |
| shellcheck, actionlint, yamllint | No | Not available |

The first pass used a line-by-line review and scripted structural checks that
target the error classes a compile or deployment would report. The second pass
compiled and linted with the real Bicep CLI.

## Compiler validation (Bicep CLI v0.48.1)

| Item | Value |
| --- | --- |
| Install | `az bicep install` (Azure CLI 2.87.0) installed `C:\Users\GN User\.azure\bin\bicep.exe`; no Azure sign-in or resource access |
| Version | `Bicep CLI version 0.48.1 (cec7951cf6)`; compiled templates carry `_generator.version` `0.48.1.52935` |
| Binary integrity | SHA-256 `398af294cf16ac4becdbd008a77d148d0e8e91492309a6b60ec911b7e1cab082`; Authenticode **Valid**, signer `CN=Microsoft Corporation`, issuer `Microsoft Code Signing PCA 2024` |
| Local side effect | The installer set the local Azure CLI preference `bicep.use_binary_from_path=false` (a CLI preference on this machine, not an Azure setting) |

| Check (branch `a944223`) | Result |
| --- | --- |
| `bicep build infra/azure/hosting/main.bicep` | **Exit 0, no errors, no warnings** |
| `bicep build infra/azure/hosting/modules/web-app.bicep` | **Exit 0, no errors, no warnings** |
| `bicep lint` on both files (default rule set) | **Exit 0, no diagnostics** |
| Type check | No BCP037 (unknown property) and no BCP081 (unknown type or API version): every property is valid for its declared API version in the CLI's type catalog |
| Compiled ARM vs `main.parameters.json` | 11 required parameters, all present with matching types (string, object, array); no unknown key |
| Compiled resources | Unconditional: identity, registry, workspace, managed environment, 2 role assignments (**6**, matching the plan's Phase A count); the Key Vault is referenced only, not emitted. Conditional on `deployApps`: 2 `Microsoft.Resources/deployments` (`web-staging`, `web-production`) |
| **Control: merged `master@e63b87b`** | **Exit 1:** `web-app.bicep(90,14) Error BCP138: For-expressions are not supported in this context…`, plus `BCP104` (referenced module has errors) at `main.bicep(134,16)` and `(156,19)`. This **compiler-confirms F1** |

Strict lint (scratch copy with a temporary `bicepconfig.json` enabling the
off-by-default rules; no config is committed) reports **advisories only, no
errors**:

- `use-recent-api-versions` (6): `containerApps` and `managedEnvironments`
  `2024-03-01`, `userAssignedIdentities` `2023-01-31`, `registries`
  `2023-07-01`, `workspaces` `2023-09-01`, `vaults` `2023-07-01` are older than
  the rule's 730-day window. They are GA versions the CLI type-checks. Moving to
  newer versions changes resource schemas, so it should be its own reviewed
  change (optional follow-up), not part of this offline gate.
- `use-user-defined-types` (9): `object`/`array` parameters could be typed. This
  is a style improvement; the structural safety checks already cover the
  parameter shapes.

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

Confirmation: first found from Bicep's documented loop rules, then
**compiler-confirmed** with Bicep CLI v0.48.1. The merged module fails with
BCP138, and the fixed branch builds and lints cleanly (see "Compiler
validation").

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

- **N1:** if the founder repeats B1–B3, `az bicep build/lint` may install the
  Bicep CLI on their machine the first time.
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

## Remaining before any Azure step

1. The founder confirmed the Key Vault secret names (P5a) on 2026-10-17. The
   Phase B production cost timing (P8) is still open. The B4 runbook,
   prerequisites, and stop conditions are in
   `docs/gates/gate-006c-b4-whatif-handoff.md`.
2. Offline B1–B3 are **done by Claude** with Bicep CLI v0.48.1 (builds and lint
   clean on this branch). The founder may repeat them, but they are no longer
   blocking. The F1 fix must be merged before B4, so the `what-if` uses the
   compiling template.
3. Each Azure step, including the B4 and B6 `what-if` runs, needs the founder's
   separate authorization. The `what-if` is now the first check against Azure
   itself (resource provider registration, name availability, role-assignment
   permissions), which no offline tool can cover.
4. Optional follow-ups, each a separate reviewed change: newer API versions
   (`use-recent-api-versions`), user-defined parameter types, and Node 24-native
   action versions.

## Changed files

| File | Change |
| --- | --- |
| `infra/azure/hosting/modules/web-app.bicep` | F1 fix: `secretEnv` variable; `env` concatenates it |
| `scripts/azure-hosting/test-hosting-safety.ts` | 12 structural Bicep checks with a string- and comment-aware scanner |
| `docs/gates/gate-006c-offline-validation.md` | This document |
| `docs/gates/gate-006c-staging-readiness-plan.md` | Section 3 points to this document and records B1–B3 as done offline; decision 5 marked resolved |
