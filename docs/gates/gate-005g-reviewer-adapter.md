# Gate 005G - Reviewer Adapter, Review Workflow and Loop Runner (Offline, Inert by Default)

## Goal

Implement the automated Claude Code → OpenAI reviewer → Claude correction
loop. The design comes from Gate 005D, and the governance and contracts from
Gate 005F. Everything is built and tested **offline** and ships **inert**:

- no live API call;
- no credential;
- no settings change;
- no dependency change.

Activation is a later founder sequence (section 8).

## Base and independence

- **Branch** `gate-005g-reviewer-adapter`, cut from verified `master@998e6cc`.
- **Draft PRs #26 (005E) and #27 (005F) remain unmerged.** 005G does not
  depend on their code and does not edit their files: `AGENTS.md`,
  `.agents/state.yaml`, `scripts/state-reconcile/**`, and
  `scripts/orchestrator/**`.
- **No reliance on unmerged authority.** The adapter and both workflows
  refuse to act unless `AGENTS.md` on **`master`** contains the Gate 005F
  section 6.6 (`E_POLICY_NOT_AUTHORIZED`, or the workflow's `authorized`
  step fails). Merged 005G code therefore stays inert until 005F is merged,
  in addition to the founder variables.
- **`.agents/state.yaml` is not edited,** to avoid a guaranteed conflict
  with PR #26 (same reasoning as Gate 005F section 10).

## Changed files

| File | Purpose |
| --- | --- |
| `scripts/reviewer/lib.ts` | Read-only git wrapper, `yaml` guard, branch, gate and model-ID rules, automation-config and readiness contracts, review target selection |
| `scripts/reviewer/adapter.ts` | The fail-closed adapter pipeline (section 4), secret scanner, output schema, review composition |
| `scripts/reviewer/openai-client.ts` | The `ReviewerClient` for the OpenAI Responses API, using built-in `fetch` and no SDK. **Not exercised** |
| `scripts/reviewer/publish.ts` | Append-only delivery to `automation/reviews`, using git plumbing and never force; plus the founder-run init |
| `scripts/reviewer/cli.ts` | Workflow entry point: `review`, `publish`, `authorized`, `check-branch`, `select-targets`, `init-review-branch` |
| `scripts/review-loop/runner.ts` | Claude's loop runner: waits for delivery, then runs the unchanged Gate 005A `evaluate()` |
| `scripts/reviewer/test-reviewer.ts` | 33 offline tests (section 7) |
| `.github/workflows/reviewer.yml` | The review workflow (`pull_request_target`, `schedule`, `workflow_dispatch`). Inert |
| `.github/workflows/draft-pr-sweep.yml` | The scheduled draft-PR sweep. Inert |
| `.agents/automation.yaml` | Committed config with `model_id: ""`, so the reviewer is disabled by construction |
| `.gitignore` | Adds `.agents/outbox/` |
| `docs/gates/gate-005g-reviewer-adapter.md` | This document |

**Execution model** (as in the Gate 005E fix):

- Scripts run with `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON <script>.ts`,
  using Node's built-in TypeScript support. That needs Node 22.18 or later;
  CI pins `24.14.0`.
- Only erasable TypeScript syntax is used.
- **No `npx` and no runner package is fetched.**
- `yaml` stays a transitive, lockfile-pinned package, loaded through a guard.
  It was **not** added as a devDependency, per the founder's instruction.

## Contracts

### Readiness signal (instead of handoff schema v5)

The reviewed head must be verifiable from the repository without
self-reference. 005G uses a per-gate file committed on the gate branch:

```yaml
# .agents/review-ready/<GATE>.yaml   (e.g. 005G)
schema_version: 1
project: cbc
gate: "005G"
branch: gate-005g-reviewer-adapter
status: ready_for_review        # or in_progress  -> E_REQUEST_NOT_READY
summary: "..."
validation: { build: "passed", results: ["PASS: ..."] }
founder_only_actions_requested: []
# head_commit is FORBIDDEN (E_REQUEST_SCHEMA): the head is taken from git/the PR event.
```

**Deviation from Gate 005F section 7.2.** 005F proposed bumping
`.agents/claude-handoff.yaml` to schema v5. Doing that would break the
Gate 005A orchestrator's strict v4 validation, and the local handoff
template. It would also modify files that PR #26 touches.

A separate per-gate readiness file keeps 005A unchanged, avoids conflicts,
and still carries no self-referencing SHA. The CI side builds the
`cbc.review_request` from git plus this file. The loop runner builds a
v4-compatible view of the delivered request for `evaluate()`.

### Automation config

`.agents/automation.yaml` follows Gate 005F section 7.3. The adapter reads
it **at `policy_commit`** (the verified `origin/master`), never from the
reviewed branch.

### Review delivery

Results go to `automation/reviews` (Gate 005F section 2):

```text
reviews/<gate>/<head>/{review-request.json, adapter-result.json, chatgpt-review.yaml}
ledger/<YYYY-MM>.jsonl
```

The same files are also uploaded as the Actions artifact
`cbc-review-<head>`.

## Adapter pipeline (fail-closed; at most one model call)

| Step | What happens | Rejection codes |
| --- | --- | --- |
| 1 | Target is `gate-<nnnx>-<name>` and a 40-hex head | `E_REQUEST_SCHEMA` |
| 2 | Pin `policy_commit` = `origin/master`, matching `ls-remote`. Load `AGENTS.md`, `.agents/chatgpt.md` and `.agents/automation.yaml` at `policy_commit` | `E_POLICY_UNAVAILABLE` |
| 3 | `AGENTS.md` contains the 005F section 6.6 | `E_POLICY_NOT_AUTHORIZED` |
| 3 | `CBC_REVIEWER_ENABLED=enabled` | `E_REVIEWER_DISABLED` |
| 3 | `CBC_VERCEL_POLICY_VERIFIED=verified-YYYY-MM-DD` | `E_VERCEL_POLICY_UNVERIFIED` |
| 3 | Committed `model_id` is exact and dated, and equals `CBC_REVIEWER_MODEL` | `E_MODEL_NOT_APPROVED` |
| 3 | The model has a price entry, and the allowance variable equals the committed allowance | `E_BUDGET_STOP` |
| 4 | `origin/<branch>` equals the head (fetched and checked with `ls-remote`) | `E_HEAD_NOT_ON_ORIGIN` |
| 5 | Base = `merge-base(policy_commit, head)` (005D R1/R5) | `E_BASE_INVALID`, `E_BASE_MISMATCH` |
| 6 | Readiness file at head is present, valid, and `ready_for_review` | `E_REQUEST_MISSING`, `E_REQUEST_SCHEMA`, `E_REQUEST_NOT_READY` |
| 7 | Review branch present and well-formed. No previous **model call** for this head. Fewer than 3 rounds. Ledger month-to-date plus worst case fits the allowance | `E_BUDGET_STOP`, `E_REVIEW_BRANCH_INVALID`, `E_REVIEW_EXISTS`, `E_ROUND_LIMIT` |
| 8 | Evidence from git: changed files, forbidden paths, binaries listed by path only, patch, files at head, size limits | `E_EVIDENCE_FORBIDDEN_PATH`, `E_EVIDENCE_TOO_LARGE` |
| 9 | Input bound: `ceil(bytes / 3)` must not exceed `max_input_tokens`. Secret scan of the **whole** input (request, patch, files, policy text); only `{path, line, category}` is recorded | `E_EVIDENCE_TOO_LARGE`, `E_EVIDENCE_SECRET_SUSPECTED` |
| 10 | The single call. `call.made` and its cost are recorded from `usage`, or worst case when usage is absent | `E_RESPONSE_INCOMPLETE` (call failed) |
| 11 | Validation: complete and not a refusal, JSON, no `founder_decision` anywhere, strict schema, identity matches | `E_RESPONSE_INCOMPLETE`, `E_RESPONSE_NOT_JSON`, `E_FOUNDER_DECISION_PRESENT`, `E_RESPONSE_SCHEMA`, `E_IDENTITY_MISMATCH` |
| 11 | Composed v3 review passes the 005A `validateReview()`, and the `founder_decision` template is byte-exact | `E_REVIEW_SCHEMA` |
| 12 | Pre-write rechecks of `origin/<branch>` and `origin/master` | `E_STALE`, `E_POLICY_STALE` |

**Refinements of the 005D and 005F rules:**

- **One call per commit** counts *model calls*. A pre-call rejection for a
  head, such as a budget stop or a disabled switch, can be superseded by a
  later run. Git history keeps every attempt.
- **No duplicate scheduled runs.** The scheduled selector skips any head
  that already has a published result, so a stuck head does not produce a
  new commit every 15 minutes. Pushing a new commit triggers a new review.
- **The budget ledger** is the review branch itself. If the branch is
  absent, the ledger cannot be verified, so the result is `E_BUDGET_STOP`.
  The founder runs `cli.ts init-review-branch` once to create it.

## Workflows (inert)

`.github/workflows/reviewer.yml`:

- `select` job runs only if `vars.CBC_REVIEWER_ENABLED == 'enabled'`. It:
  - checks out `master`;
  - runs `npm ci --ignore-scripts`;
  - runs `cli.ts authorized` (the 005F gate);
  - lists open **draft**, same-repository `gate-*` PRs whose head has no
    published result.
- `review` job uses the `cbc-reviewer` Environment and permission
  `contents: write`, with `max-parallel: 1`. It:
  - checks out `master` and fetches the target **as git objects only**;
  - exposes the API key to **one** step;
  - publishes with no force;
  - uploads the audit artifact.
- **Security properties:**
  - Triggers run `master`'s definition. There is no `push` or
    `pull_request` trigger, so a gate branch cannot change the workflow
    used to review it.
  - PR head values are passed only through `env` and validated by
    `check-branch` and the code.
  - Top-level permissions are `contents: read`.
  - The global `concurrency` group prevents two runs spending at once.

`.github/workflows/draft-pr-sweep.yml` runs on a schedule, only if
`vars.CBC_DRAFT_PR_ENABLED == 'enabled'` and `authorized` passes. It
opens **draft** PRs for `gate-*` branches that have never had a PR. It never
marks ready, merges, closes, deletes, or pushes.

## Loop runner (Claude side, no credentials)

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/review-loop/runner.ts \
  --branch gate-005x-name --head <sha40> [--timeout-min 20] [--interval-s 60]
```

1. The runner polls `git fetch origin automation/reviews` for
   `reviews/<gate>/<head>/adapter-result.json`.
2. It writes the delivery into `.agents/outbox/reviews/<head>/`, which is
   untracked and git-ignored.
3. It runs the unchanged Gate 005A `evaluate()`.

Exit codes:

- **0:** `changes_requested`. `claude-work-request.json` holds only in-scope,
  non-founder items, which Claude may act on under `AGENTS.md` section 6.4.
- **3:** `founder_action_required`, for an approval recommendation, an
  escalation, or any adapter rejection.
- **4:** timeout.
- **2:** an invalid delivery or usage error.

## Validation (2026-10-16)

Offline tests (`scripts/reviewer/test-reviewer.ts`): **33 passed, 0 failed.**
Every test uses throwaway git repositories (a bare origin, a developer clone,
a CI clone) with an isolated git config and a fixture `ReviewerClient`.
There is no network, no credential, and no API call.

```text
PASS: A01 happy path: one call, valid v3 review with exact founder_decision template, usage-based cost
PASS: A02 AGENTS.md without Gate 005F section 6.6 -> E_POLICY_NOT_AUTHORIZED, no call
PASS: A03 CBC_REVIEWER_ENABLED not 'enabled' -> E_REVIEWER_DISABLED
PASS: A04 Vercel policy not verified -> E_VERCEL_POLICY_UNVERIFIED
PASS: A05 committed model_id empty -> E_MODEL_NOT_APPROVED
PASS: A06 model alias / variable mismatch -> E_MODEL_NOT_APPROVED
PASS: A07 allowance variable differs from committed allowance -> E_BUDGET_STOP
PASS: A08 head not on origin -> E_HEAD_NOT_ON_ORIGIN
PASS: A09 readiness file missing at head -> E_REQUEST_MISSING
PASS: A10 readiness status in_progress -> E_REQUEST_NOT_READY
PASS: A11 readiness carries head_commit (self-reference) -> E_REQUEST_SCHEMA
PASS: A12 automation/reviews absent (ledger unverifiable) -> E_BUDGET_STOP
PASS: A13 diff touches .env.example -> E_EVIDENCE_FORBIDDEN_PATH
PASS: A14 secret in an allowed file -> E_EVIDENCE_SECRET_SUSPECTED; only path/line/category recorded; nothing sent
PASS: A15 oversized changed file -> E_EVIDENCE_TOO_LARGE (never truncated)
PASS: A16 response not JSON -> E_RESPONSE_NOT_JSON
PASS: A17 truncated/incomplete response -> E_RESPONSE_INCOMPLETE
PASS: A18 model emits founder_decision -> E_FOUNDER_DECISION_PRESENT
PASS: A19 extra key / bad enum -> E_RESPONSE_SCHEMA
PASS: A20 review_target for another commit -> E_IDENTITY_MISMATCH
PASS: A21 branch moves during review -> E_STALE
PASS: A22 master moves during review -> E_POLICY_STALE
PASS: P01 publish appends review + ledger (no force); same head is never called twice; re-publish is idempotent
PASS: P02 round limit: three reviewed heads -> fourth head rejected E_ROUND_LIMIT without a call
PASS: P03 month-to-date + worst case would exceed allowance -> E_BUDGET_STOP
PASS: P04 malformed ledger line -> E_BUDGET_STOP (fail closed)
PASS: P05 publish refuses to replace a head that already has a model call
PASS: L01 delivered recommend_changes -> exit 0 with claude-work-request.json (R1 only)
PASS: L02 delivered recommend_approve -> exit 3 founder_action_required (never approval)
PASS: L03 delivered adapter rejection -> exit 3 with founder-action.json naming the code
PASS: L04 nothing delivered -> exit 4 timeout
PASS: S01 target selection: only open, same-repo, draft gate PRs not yet published
PASS: W01 workflows are inert, master-defined, least-privilege, and never run reviewed code
=== Gate 005G reviewer: 33 passed, 0 failed ===
```

The first run had one failure, P01. `Git.showFile` trimmed a trailing
newline, so an identical re-publish was not byte-equal. This was fixed by
reading exact bytes, and all tests pass.

Other checks:

- **Strict `tsc`:** `--strict --erasableSyntaxOnly --allowImportingTsExtensions`
  with ESM settings, over the seven scripts. It passes.
- **Read-only checks against the real repository:**
  - `check-branch` refuses a shell-injection branch name;
  - `authorized` exits 1 (005F is not on `master`);
  - `select-targets` returns no targets;
  - a `review` attempt on `gate-005b-agent-loop-smoke` was rejected at once
    with `E_POLICY_UNAVAILABLE`, because `master` has no
    `.agents/automation.yaml` yet. `call.made` was `false`, and the OpenAI
    client was not reached.
- `npm run build`, `git diff --check`, and YAML parsing (see the
  checkpoint).

**Not exercised:**

- The OpenAI Responses API call and its response parsing. These need a
  founder-run live smoke (Gate 005H).
- Workflow execution on GitHub. Workflows triggered by `pull_request_target`
  and `schedule` run only from the default branch, so they can first run
  after a merge.
- `gh` commands in the workflows.

## Activation sequence (all founder-only; nothing done here)

1. **Vercel first.** Apply and verify the Gate 005F section 6 policy. The
   recommended method is the project's **Ignored Build Step** with an inline
   command, so that a branch cannot change the rule. A repo-side
   `vercel.json` is read from the branch being built, so a branch could
   rewrite its own rule. This also lets later merges of scripts- and
   docs-only gates skip production builds.
2. Merge Gate 005F. **That merge is a production deployment.**
3. Decide on PR #26. **Merging it is a production deployment.**
4. Merge Gate 005G. **That merge is a production deployment.** It stays
   inert: `model_id` is empty and no variables are set.
5. **OpenAI:** create the project, budget alert and key; confirm
   data-retention terms; choose the exact dated model ID and its prices.
6. **Record the model ID:** a docs-only gate sets
   `.agents/automation.yaml` `reviewer.model_id` and the price entry.
7. **GitHub:**
   - create the Environment `cbc-reviewer`, limited to `master`, with the
     secret `CBC_REVIEWER_API_KEY`;
   - allow Actions to create PRs;
   - add branch protection on `master`.
8. **Initialize the review branch:** the founder runs
   `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/reviewer/cli.ts init-review-branch`
   once. It pushes the orphan `automation/reviews` branch, which is
   founder-only.
9. **Variables:**
   - `CBC_REVIEWER_MODEL`;
   - `CBC_REVIEW_MONTHLY_ALLOWANCE_USD=20`;
   - `CBC_VERCEL_POLICY_VERIFIED=verified-YYYY-MM-DD`;
   - `CBC_DRAFT_PR_ENABLED=enabled`;
   - **last:** `CBC_REVIEWER_ENABLED=enabled`.
10. **Gate 005H (live smoke):**
    - one real review of a docs-only gate;
    - one `changes_requested` round with a correction and re-review;
    - confirm the response parsing and the ledger against the allowance.

## Out of scope

- Live API calls, credentials, secrets, and repository, GitHub, Vercel, or
  OpenAI settings.
- Merges.
- `AGENTS.md`, `.agents/state.yaml`, `scripts/orchestrator/**`, and
  `scripts/state-reconcile/**`.
- `package.json` and `package-lock.json` (no `yaml` devDependency).
