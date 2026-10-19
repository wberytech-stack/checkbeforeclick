# Gate 006C - P5b Key Vault secrets: progress record (secrets 1-4)

## Status (as of 2026-10-19)

- **Secrets 1-4 are created and metadata-verified** in `kv-cbc-prod-cc-001`. The
  founder created all four. The vault now holds 5 active secrets: the
  pre-existing off-limits secret plus these four.
- **Secrets 5-7 (production) are not approved and not created.**
- **B6/B7 have not run.** No Container App exists, and nothing was deployed.
- **Value correctness is unverified.** It is proven only when the apps resolve
  their Key Vault references (B7) and the staging smoke tests pass. Neither has
  run, so neither is recorded as passed.

**Redaction:** the repository is public. No secret value was seen by Claude
Code, and none is recorded here or was printed in any evidence. Subscription
and tenant IDs were redacted at the source. The evidence files and scripts stay
outside the repository (founder-local, `Desktop\chatgpt-review\`).

**Evidence class:** everything below is **founder-reported**. It comes from
founder-run tools and redacted evidence files that Claude analyzed, or from
the founder's statements in chat. None of it is repository evidence; agents
have no Azure access (AGENTS.md sections 8 and 20).

## Approval boundaries and who did what

| Item | Founder authorization | Operator | Claude Code's role |
| --- | --- | --- | --- |
| Step 3: Key Vault write access check | Read-only check, 2026-10-17 | Founder | Prepared a read-only, allow-listed check script; ran no Azure command |
| Name pre-check | Read-only, names only, 2026-10-17 | Founder | Prepared the script and analyzed the output |
| P5b (Step 4) | Founder-only creation of exactly the 7 P5a secrets, one at a time, 2026-10-17. The approved entry method was the Azure portal | Founder | Guidance and metadata analysis only. Never requested, saw or handled a value |
| Entry-method change | Portal sign-in failed (`AADSTS50058`), so the founder used founder-run PowerShell tools. Each version was independently reviewed by ChatGPT before the founder ran it (founder-reported) | Founder | Wrote and tested the tools offline only (dummy values, a local mock server, a fake `az`) |
| Inngest event key for staging | The founder created a dedicated Branch Environments event key, `azure-staging-cbc`. Of the three existing keys (`branch-preview`, `Vercel: checkbeforeclick`, `Default ingest key`), the repository records none as the Azure staging key | Founder | Reviewed repository documentation only (`docs/ENVIRONMENTS.md` §10) |
| Google Cloud billing | The founder linked the CheckBeforeClick Google Cloud project to an active paid billing account, then confirmed the existing Web Risk key works (founder-reported) | Founder | None |

Not approved and not done: secrets 5-7; any change to the pre-existing secret;
deleting, purging, disabling or rotating anything; role changes (including
removing the founder's Secrets Officer role); OIDC, GitHub or Supabase settings;
B6/B7; any deployment.

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
| `step4-secrets-3to7.ps1` (fixed allow-list of secrets 3-7; production gate for 5-7) | `dc7cab62e48fe37f06835347614889a4be69b48010e3caef30631769f52fbbe8` | Secrets 3 and 4 |

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

In every row, PASS means:
- exactly one active secret with the exact name;
- enabled, with no expiry;
- **exactly one** version, enabled, with no expiry.

Active secrets in the vault after each write: 2, 3, 4, then 5.

Additional checks, from the redacted evidence:
- **Secret 3:** in-memory claim checks passed before the write: `role=service_role`
  and project ref `zgxmvpbvvakpsnzcymsf`. They catch an anon key or a production
  key.
- **Secret 4:**
  - The tool's format check passed (39 characters, `AIza` prefix). The evidence
    line reads "generic checks passed"; the tool prints that same message after
    the Google check succeeds.
  - Provider check (founder-reported): after the billing link, the selected key
    returned HTTP 200 from the Web Risk `SearchUris` endpoint.
  - No Google API key was created, rotated or deleted.
- **Failed attempts:** several runs stopped **before sending anything** (too-short
  input when Ctrl+V did not reach the masked prompt, entries that differed, a
  mistyped confirmation). No run sent a second PUT, and no secret has more than
  one version.

Evidence files, founder-local and redacted:

| Secret | File |
| --- | --- |
| 1 | `step4-secret1-evidence-20261017-231549.txt` |
| 2 | `step4-secret2-evidence-20261018-130818.txt` |
| 3 | `step4-secret3-evidence-20261018-134526.txt` |
| 4 | `step4-secret4-evidence-20261019-150306.txt` |

Each secret's state marker reads `verified`.

## Not verified

- **Values:** that each value is correct for its consumer. That is proven at B7
  (Key Vault reference resolution by the apps' managed identity) and in the
  staging smoke tests (sign-in for the service_role path; the slow-path scan,
  S8, for the Inngest keys).
- **Managed identity:** that `id-cbc-web-cc-001` can read these secrets at
  runtime. Its Key Vault Secrets User assignment exists, but no app has used it
  yet.
- **Google:** any Google Cloud setting beyond the founder's report.

## Risks carried forward

- **Supabase service_role (secret 3)** bypasses RLS. If it is ever exposed,
  rotate it in Supabase (a separate decision).
- **The staging Inngest signing key** is shared with Vercel Preview. Rotating it
  affects both.
- **Google Cloud billing is now active** for the project that owns the shared
  Web Risk key. Usage from staging and production counts against it
  (`docs/ENVIRONMENTS.md` §11).
- **Key Vault set-secret is not atomic** ("create only if absent" is not
  possible). The tools detect a second version afterwards (verification fails)
  rather than prevent one. None occurred.

## Remaining steps (each needs its own explicit founder approval)

1. **Secrets 5-7 (production):**
   - `cbc-prod-inngest-event-key`, `cbc-prod-inngest-signing-key` and
     `cbc-prod-supabase-service-role-key`, one per approval, using the
     production gate of `step4-secrets-3to7.ps1`.
   - For secret 5, decide which production event key to use. A dedicated key,
     as for staging, would be a provider change and needs its own approval.
2. **Final check:** after all seven, rerun the names-only pre-check. The
   expected result is 8 active secrets and all 7 targets reported as existing.
3. **Later Phase B steps:** OIDC (step 5), GitHub environments (step 6), the
   Supabase redirect (step 7), B6/B7, and the smoke tests.
