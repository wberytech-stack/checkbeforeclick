# Gate 006C - Decision P8: production minimum replicas (offline change)

## Decision

On 2026-10-17 the founder decided P8 (Gate 006C staging-readiness plan,
section 4) as follows:

> Approved preparing an offline, separately reviewed Bicep change to
> parameterize production minReplicas, allowing 0 until cutover and 1 when
> production is activated.

That is option 2 of the plan. This change implements it offline. It does not
apply it: nothing was deployed, no `what-if` was run, and Azure was not
accessed.

## Change

| File | Change |
| --- | --- |
| `infra/azure/hosting/main.bicep` | New `param productionMinReplicas int`, `@allowed([0, 1])`, **no default**. The production module now passes `minReplicas: productionMinReplicas` (was a hard-coded `1`). Staging is unchanged: `minReplicas: 0`, `maxReplicas: 1`. Production keeps `maxReplicas: 3` |
| `infra/azure/hosting/modules/web-app.bicep` | `minReplicas` now has `@maxValue(1)` (with the existing `@minValue(0)`) and a description: defense in depth if a caller's `@allowed` is ever loosened |
| `infra/azure/hosting/main.parameters.json` | `"productionMinReplicas": { "value": 0 }`, the pre-cutover setting |
| `scripts/azure-hosting/test-hosting-safety.ts` | The old "production minReplicas 1" check is replaced by 11 P8 checks (below) |

Why there is no default: a deployment that forgets the value fails (BCP258 at
compile time, a missing-parameter error at deployment) instead of silently
choosing 0 or 1.

## What the pre-cutover value 0 means, and what it does not

- With `minReplicas: 0`, the production Container App keeps **no always-on
  replica** while idle. Replica compute is billed only while a replica is
  running, for example during smoke tests, deployments, or any request that
  reaches the app's Azure address.
- It does **not** make Azure hosting free. Charges that continue regardless of
  replicas include:
  - the container registry (Basic tier is billed daily);
  - Log Analytics ingestion and retention (bounded by the 0.5 GB/day cap);
  - Key Vault operations;
  - outbound data;
  - compute for every period a replica runs, including requests from crawlers
    or anyone who finds the default FQDN.

  Whether the Consumption plan's monthly free grant covers part of this is
  unverified. Cost Management after 24–48 hours (plan section 4) is the check.
- Staging behaves exactly as before (`minReplicas: 0`).

## Implications for Phase B and its smoke tests

1. **Cold starts.** The production app, like staging, starts a replica on the
   first request after idle. The first `/api/healthz` or page request can take
   noticeably longer. `scripts/azure-hosting/smoke.ts` has no retry, so a first
   failure from a timeout is retried once before it counts as a failure (same
   rule as staging in plan section 8).
2. **Deploy workflow readiness check.** `azure-deploy.yml` waits until the
   latest revision equals the latest *ready* revision and runs the expected
   image, then requires `/api/healthz` 200. With `minReplicas: 0`, a new
   revision can be provisioned with zero running replicas. **Whether Azure
   then reports it in `latestReadyRevisionName` before any request arrives is
   unverified.** Staging already runs at `minReplicas: 0`, so the first staging
   deploy (plan sequence step 10) exercises the same path before any production
   deploy. If staging shows the wait loop timing out at zero replicas, stop and
   fix the workflow in a reviewed change before deploying production.
3. **Phase B what-if (B6) expectation** changes for production: the Container
   App's `template.scale.minReplicas` is **0** (was 1), `maxReplicas` 3.
   Everything else in the plan's B6 expectations is unchanged.
4. **Phase A (B4)** is unaffected: still exactly 6 resources. The new
   parameter is consumed only by the production module, which Phase A skips.
   Because it has no default, `main.parameters.json` must carry it. It does,
   and the B4 commands already pass that file.

## Explicit cutover step: set production to 1 (part of Gate 006D, not done here)

Order: **before** the DNS switch, so the first real users do not hit a cold
start. Each step is founder-only or founder-authorized.

1. **Reviewed change (gate branch, draft PR):**
   - `main.parameters.json`: `"productionMinReplicas": { "value": 1 }`.
   - Update the P8 safety check "parameters file sets productionMinReplicas to
     the pre-cutover value 0" to expect 1. That check is a deliberate tripwire,
     so the value cannot change unnoticed.
2. **Founder-authorized what-if** with the Phase B parameters
   (`deployApps=true`) and **the images currently running**. Read them first:

   ```bash
   az containerapp show --name ca-cbc-web-prod-cc-001 --resource-group rg-cbc-prod-canadacentral-001 --query "properties.template.containers[0].image" -o tsv
   ```
   ```bash
   az containerapp show --name ca-cbc-web-stg-cc-001 --resource-group rg-cbc-prod-canadacentral-001 --query "properties.template.containers[0].image" -o tsv
   ```

   Pass these as `stagingImage` and `productionImage`. **Stop condition:** the
   what-if must show exactly one change, production `template.scale.minReplicas`
   0 → 1. Any image change means the apply would roll an app back to another
   image. Staging must show NoChange (or only no-op noise).
3. **Founder-authorized apply** of the same command with `create`.
4. **Verify:** `template.scale.minReplicas` is 1, and at least one replica is
   running:

   ```bash
   az containerapp show --name ca-cbc-web-prod-cc-001 --resource-group rg-cbc-prod-canadacentral-001 --query "properties.template.scale" -o json
   ```
   ```bash
   az containerapp replica list --name ca-cbc-web-prod-cc-001 --resource-group rg-cbc-prod-canadacentral-001 -o table
   ```

5. Then continue with the Gate 006D DNS switch.

A direct `az containerapp update --min-replicas 1` would have the same runtime
effect, but it drifts from the Bicep and the parameters file. Use it only as a
founder-approved emergency step, followed by step 1 to bring the repository
back in line.

## Validation (offline, 2026-10-17 01:22 -04:00)

| Check | Result |
| --- | --- |
| Bicep CLI 0.48.1: `build main.bicep`, `build modules/web-app.bicep` | Exit 0, no diagnostics |
| `bicep lint` on both files | Exit 0, no diagnostics |
| Compiled ARM `productionMinReplicas` | `type: int`, `allowedValues: [0, 1]`, no `defaultValue` |
| Compiled ARM deployment `web-staging` | `minReplicas: 0` (literal), `maxReplicas: 1` |
| Compiled ARM deployment `web-production` | `minReplicas: [parameters('productionMinReplicas')]`, `maxReplicas: 3` |
| Compiled ARM module `minReplicas` | `minValue: 0`, `maxValue: 1` |
| Compiled ARM vs parameters file | 12 required parameters, none missing, no unknown key |
| Phase A unconditional resources | Still 6 |
| Compiler, temporary `.bicepparam` files (scratch, deleted) | `0` compiles and the compiled parameters carry 0; `1` compiles; `2` rejected (BCP327); `-1` rejected (BCP328); `'0'` rejected (BCP033); omitted rejected (BCP258); module alone with `minReplicas = 2` rejected (BCP327) |
| `scripts/azure-hosting/test-hosting-safety.ts` | **102 passed, 0 failed** at `336fa30` (11 new P8 checks); **103 passed, 0 failed** from `7f38246` on (line-ending fix below), on LF and CRLF checkouts |
| Mutation run of the P8 checks (scratch copy) | **8/8 caught**: default added; `@allowed` removed; staging wired to the parameter; production hard-coded back to 1; parameters file set to 1; parameters entry removed; module `@maxValue` removed; staging raised to 1 |
| ESLint, strict `tsc` on `scripts/azure-hosting/` | Pass |
| `state-reconcile --check` | consistent |

New safety checks: declared as `int`; no default; `@allowed([0, 1])`;
production passes the parameter; production `maxReplicas` 3; staging keeps 0/1;
staging does not use the parameter; the parameter is used only by production;
no hard-coded production `minReplicas: 1`; the parameters file has 0; module
bound `@minValue(0)` and `@maxValue(1)`.

## Line-ending independence of the safety test (commit `7f38246`)

Found while re-verifying after a reboot, and fixed with founder approval
(2026-10-17). The safety test matched literal `\n`, so on a CRLF checkout
(Windows with `core.autocrlf=true`, or a `git archive` export):

- 4 P8 checks failed falsely;
- the two module-call checks were silently skipped.

`read()` now normalizes line endings. The module-call checks now emit one check
per expected module, which fails when its params block cannot be parsed. The
LF tree, a CRLF copy, and a `git archive` export all pass 103/103. An
unparseable module block now fails; the previous test reported 101 passed,
0 failed.

## Relationship to PR #36 (B4 handoff, merged)

PR #36 merged into master as `e157572`. This branch was brought up to date
with a merge commit (no rebase); the merge was conflict-free and matched
`git merge-tree`. Because P8 changes `main.bicep` and `main.parameters.json`,
this PR also refreshes `docs/gates/gate-006c-b4-whatif-handoff.md`:

- it is re-pinned to master after this PR merges;
- the authoritative check is `git diff --stat 336fa30 HEAD -- infra/azure/hosting`
  printing nothing;
- the LF file hashes are updated;
- P8 is no longer a B4 blocker;
- `productionMinReplicas` is listed among the parameters Phase A ignores.

The B4 expected result is unchanged (6 to create).

`.agents/state.yaml` records P8 as decided (option 2) and PR #36's merge.
