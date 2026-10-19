# Gate 006C - P5b Key Vault secrets: record (secrets 1-7)

## Status (as of 2026-10-19)

- **All 7 planned secrets are written and metadata-verified** in
  `kv-cbc-prod-cc-001`. Each one was **individually authorized by the founder
  and then created by the founder**.
  - Secrets 1-4 are staging or shared.
  - Production secrets 5-7 were each authorized by a separate, explicit founder
    approval naming that secret.
  - The vault holds 8 active secrets: the pre-existing off-limits secret plus
    these seven.
- **No secret value has been runtime-verified.** Values are proven only when the
  apps resolve their Key Vault references (B7) and the staging and production
  smoke tests pass. None of these has run, so none is recorded as passed.
- **B6/B7 have not run.** No Container App exists, and nothing was deployed to
  Azure.
- **Final names-only check not yet run:** the read-only rerun of the name
  pre-check from the Step 4 plan.

**Redaction:** the repository is public. No secret value was seen by Claude
Code, and none is recorded here or was printed in any evidence. Subscription
and tenant IDs were redacted at the source. The evidence files and scripts stay
outside the repository (founder-local, `Desktop\chatgpt-review\`).

**Evidence class:** every Key Vault and provider fact below is
**founder-reported**. It comes from founder-run tools and redacted evidence
files that Claude analyzed, or from the founder's statements in chat. None of
it is repository evidence; agents have no Azure access (AGENTS.md sections 8
and 20). Only the merge facts in the last record section are repository
evidence.

## Approval boundaries and who did what

| Item | Founder authorization | Operator | Claude Code's role |
| --- | --- | --- | --- |
| Step 3: Key Vault write access check | Read-only check, 2026-10-17 | Founder | Prepared a read-only, allow-listed check script; ran no Azure command |
| Name pre-check | Read-only, names only, 2026-10-17 | Founder | Prepared the script and analyzed the output |
| P5b (Step 4) | Founder-only creation of the 7 P5a secrets, one at a time (Step 4 approval, 2026-10-17; the approved entry method was the Azure portal). **Each secret was then individually authorized by the founder before it was created.** Production secrets 5-7 each had a separate, explicit production approval naming the secret and the tool's SHA-256 | Founder | Guidance and metadata analysis only. Never requested, saw or handled a value |
| Entry-method change | Portal sign-in failed (`AADSTS50058`), so the founder used founder-run PowerShell tools. Each version was independently reviewed by ChatGPT before the founder ran it (founder-reported) | Founder | Wrote and tested the tools offline only (dummy values, a local mock server, a fake `az`) |
| Inngest event key for staging | The founder created a dedicated Branch Environments event key, `azure-staging-cbc`. Of the three existing keys (`branch-preview`, `Vercel: checkbeforeclick`, `Default ingest key`), the repository records none as the Azure staging key | Founder | Reviewed repository documentation only (`docs/ENVIRONMENTS.md` §10) |
| Inngest event key for production | The founder created a dedicated **Production** event key, `azure-production-cbc` (a provider change by the founder), so Azure production does not share Vercel's event key | Founder | Analysis only: recommended a dedicated key for isolation, rollback and Vercel retirement |
| Inngest production signing key | The existing **current** Production signing key was used. No key was created or rotated | Founder | None |
| Supabase production service_role | The existing service_role key of production project `qnjqwmcsfpmpnvlnomat` was used. No key was created or rotated | Founder | None |
| Google Cloud billing | The founder linked the CheckBeforeClick Google Cloud project to an active paid billing account, then confirmed the existing Web Risk key works (founder-reported) | Founder | None |

Not approved and not done:
- any change to the pre-existing secret;
- deleting, purging, disabling or rotating anything;
- role changes, including removing the founder's Secrets Officer role;
- OIDC, GitHub or Supabase settings;
- B6/B7;
- any Azure deployment.

## Pre-checks (founder-run, 2026-10-17)

| Check | Result |
| --- | --- |
| Step 3: founder can write secrets | PASS. The founder has a **direct** Key Vault Secrets Officer assignment at vault scope, and there are 0 deny assignments. Network: `defaultAction` and `bypass` were blank, read as "no firewall"; the successful writes have since confirmed it |
| Name collision pre-check | PASS: 1 active pre-existing secret (not named, off-limits), 0 soft-deleted, all 7 target names free |

## Method (tools kept outside the repository)

The Azure CLI accepts a secret value only as a command-line argument or a file,
so neither was used. The founder-run tools instead:
- read the value through a masked prompt, entered twice;
- send it in exactly one HTTPS PUT to the Key Vault REST API, with TLS
  certificate validation, no redirects, and the response body never read on
  success;
- report errors as an HTTP status plus allow-listed error codes only;
- make only metadata reads through an allow-listed `az` wrapper;
- refuse to write if the name already exists (active or soft-deleted) or if an
  earlier attempt's outcome is unresolved (state marker);
- write redacted evidence.

| Tool | SHA-256 | Used for |
| --- | --- | --- |
| `step4-secret1-create.ps1` (revision 3) | `58ead4f23a2974b4e4c4c07379c254512ac6fc49e3a02ba8546faf8d71816ce0` | Secret 1 |
| `step4-secret2-create.ps1` | `2aa8fd9399d55caf2df8a61143a469706638e46164d1439a06374af051b93210` | Secret 2 |
| `step4-secrets-3to7.ps1` (fixed allow-list of secrets 3-7; production gate for 5-7) | `dc7cab62e48fe37f06835347614889a4be69b48010e3caef30631769f52fbbe8` | Secrets 3-7 |

The founder confirmed that each tool's hash matched before running it. These
are founder-local harnesses and are not part of the repository (AGENTS.md
section 15).

## Results

| # | Secret | Content type | Value source (description only) | Created (UTC) | Write | Verification |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `cbc-stg-inngest-event-key` | `inngest-event-key staging` | Inngest Branch Environments event key `azure-staging-cbc` | 2026-10-18T03:15:42Z | HTTP 200 | PASS |
| 2 | `cbc-stg-inngest-signing-key` | `inngest-signing-key staging` | Inngest Branch Environments signing key (shared with Vercel Preview by design, `docs/ENVIRONMENTS.md` §10) | 2026-10-18T17:08:08Z | HTTP 200 | PASS |
| 3 | `cbc-stg-supabase-service-role-key` | `supabase-service-role staging` | Supabase staging project `zgxmvpbvvakpsnzcymsf`, service_role key | 2026-10-18T17:45:16Z | HTTP 200 | PASS |
| 4 | `cbc-shared-google-web-risk-api-key` | `google-web-risk-api-key shared` | The existing Google API key restricted to the Web Risk API (shared by design, `docs/ENVIRONMENTS.md` §11) | 2026-10-19T19:02:55Z | HTTP 200 | PASS |
| 5 | `cbc-prod-inngest-event-key` | `inngest-event-key production` | Inngest Production event key `azure-production-cbc` (dedicated to Azure production) | 2026-10-19T21:30:41Z | HTTP 200 | PASS |
| 6 | `cbc-prod-inngest-signing-key` | `inngest-signing-key production` | Inngest Production current signing key (one per environment; shared with Vercel production) | 2026-10-19T21:45:45Z | HTTP 200 | PASS |
| 7 | `cbc-prod-supabase-service-role-key` | `supabase-service-role production` | Supabase production project `qnjqwmcsfpmpnvlnomat`, service_role key | 2026-10-19T21:56:12Z | HTTP 200 | PASS |

In every row, PASS means:
- exactly one active secret with the exact name;
- enabled, with no expiry;
- **exactly one** version, enabled, with no expiry.

Active secrets in the vault after each write: 2, 3, 4, 5, 6, 7, then 8.

Additional checks, from the redacted evidence:
- **Secrets 3 and 7:** in-memory claim checks passed before each write:
  `role=service_role`, with project ref `zgxmvpbvvakpsnzcymsf` for secret 3 and
  `qnjqwmcsfpmpnvlnomat` for secret 7. They catch an anon key or a
  staging/production swap.
- **Secret 4:**
  - The tool's format check passed (39 characters, `AIza` prefix).
  - Provider check (founder-reported): after the billing link, the selected key
    returned HTTP 200 from the Web Risk `SearchUris` endpoint.
  - No Google API key was created, rotated or deleted.
- **Secret 6:** the tool's `signkey-prod-` prefix check passed.
- **"generic checks passed":** for secrets 4, 5 and 6 the evidence line reads
  this. The tool prints the same message after a key-specific check succeeds;
  secret 5 has no key-specific check.
- **Failed attempts:** several runs of secrets 1, 2 and 5 stopped **before
  sending anything** (empty or too-short input when Ctrl+V did not reach the
  masked prompt, entries that differed, mistyped confirmations). Secrets 3, 4,
  6 and 7 had no stopped write run. No run sent a second PUT, and no secret has
  more than one version.

Evidence files, founder-local and redacted:

| Secret | File |
| --- | --- |
| 1 | `step4-secret1-evidence-20261017-231549.txt` |
| 2 | `step4-secret2-evidence-20261018-130818.txt` |
| 3 | `step4-secret3-evidence-20261018-134526.txt` |
| 4 | `step4-secret4-evidence-20261019-150306.txt` |
| 5 | `step4-secret5-evidence-20261019-173049.txt` |
| 6 | `step4-secret6-evidence-20261019-174552.txt` |
| 7 | `step4-secret7-evidence-20261019-175921.txt` |

All seven state markers read `verified`.

## Not verified

- **Values:** that each value is correct for its consumer. That is proven at B7
  (Key Vault reference resolution by the apps' managed identity) and in the
  smoke tests:
  - sign-in for the service_role path;
  - the slow-path scan, S8, for the Inngest keys.

  Staging comes first. Production values (secrets 5-7) are used only after a
  separately approved production deployment; production runs 0 replicas until
  cutover (P8).
- **Managed identity:** that `id-cbc-web-cc-001` can read these secrets at
  runtime. Its Key Vault Secrets User assignment exists, but no app has used it
  yet.
- **Final check:** the final names-only check (expected 8 active, all 7 targets
  present) has not been run.
- **Google:** any Google Cloud setting beyond the founder's report.

## Repository record and Vercel deployments (post-merge)

The two evidence classes are kept apart:

| Fact | Evidence class | Source |
| --- | --- | --- |
| The secrets 1-4 record merged through PR #41, merge commit `e653f6fb3b5d801ff42c5958711a325b80508361` (parents `15f4fa1` and `db3e960`). `db3e960` is `refs/pull/41/head`, and the merge tree is identical to it | **Repository evidence** (verified with git) | `git log`, `git ls-remote`, `git diff db3e960 e653f6f` (empty) |
| The PR #41 post-merge reconciliation merged through PR #42, merge commit `29e98c31575efb1650117cb938d8c7e1628ec5a9` (parents `e653f6f` and `8c83df7`). `8c83df7` is `refs/pull/42/head`, and the merge tree is identical to it | **Repository evidence** (verified with git) | `git log`, `git ls-remote`, `git diff 8c83df7 29e98c3` (empty) |
| PRs #41 and #42 changed only docs and `.agents/state.yaml` | **Repository evidence** | `git diff --stat 15f4fa1 29e98c3` |
| The Vercel Production deployment for `e653f6f` showed **Ready**, and the one for `29e98c3` completed | **Founder-reported** (founder observations, 2026-10-19). Not independent runtime validation; no agent ran any runtime check | Founder |
| Key Vault secrets 1-7 exist with one enabled version each | **Founder-reported** (not repository evidence; merges do not verify it) | Sections above |

Secrets 5-7 were created after the PR #42 merge (committed 16:46:29 -04:00;
Secret 5 created 21:30:41Z, which is 17:30:41 -04:00). Merging records facts
only: it changes no application behavior and is not an Azure deployment
(AGENTS.md section 20).

## Risks carried forward

- **Supabase service_role keys (secrets 3 and 7)** bypass RLS. If one is ever
  exposed, rotate it in Supabase (a separate decision). Rotating secret 7 also
  affects Vercel production.
- **Shared Inngest signing keys:** the staging signing key is shared with Vercel
  Preview, and the production signing key with Vercel production. Rotating
  either affects both platforms.
- **Dedicated event keys:** `azure-staging-cbc` and `azure-production-cbc` can
  each be revoked without affecting Vercel. After Vercel is retired, revoking
  Vercel's event keys is a separate decision.
- **Google Cloud billing is now active** for the project that owns the shared
  Web Risk key. Usage from staging and production counts against it
  (`docs/ENVIRONMENTS.md` §11).
- **Key Vault set-secret is not atomic** ("create only if absent" is not
  possible). The tools detect a second version afterwards (verification fails)
  rather than prevent one. None occurred.

## Remaining steps (each needs its own explicit founder approval)

1. **Final check (optional, read-only, founder-run):** rerun the names-only
   pre-check. The expected result is 8 active secrets and all 7 targets reported
   as existing; the script's "BLOCKED" verdict then means "created".
2. **Later Phase B steps:** OIDC (step 5), GitHub environments (step 6), the
   Supabase redirect (step 7), B6/B7, and the staging smoke tests. Production
   cutover comes later and separately.
