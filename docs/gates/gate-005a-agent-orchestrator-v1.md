# Gate 005A - Agent Orchestrator v1 (Review Loop State Machine)

## Goal

Build the first local orchestrator for the Claude Code and ChatGPT review
loop. It reads the protocol files, validates them, verifies the branch
against `origin`, and prepares the next payload. It **does not** call any AI
API, write to git, open or change PRs, or perform any founder-only action.
This version exists so the protocol can be smoke-tested without
credentials.

## Scope and constraints

- Local only, scripts and docs only.
- No application source, migration, environment, package, lockfile, or
  deploy-config changes, and no dependency changes.
- No production, Azure, Key Vault, or real database access.
- No merge. Draft PR only where `AGENTS.md` permits it (see "Draft PR"
  below).

## Changed files

- `scripts/orchestrator/orchestrator.ts`: pure state machine and validation.
- `scripts/orchestrator/cli.ts`: file I/O, YAML loading, read-only origin
  lookup.
- `scripts/orchestrator/test-orchestrator.ts`: fixture-only smoke tests.
- `scripts/orchestrator/fixtures/*.yaml`, `remote.json`: synthetic fixtures.
- `docs/gates/gate-005a-agent-orchestrator-v1.md`

## Protocol accepted

- **Handoff:** `.agents/claude-handoff.yaml`, `schema_version: 4`. It
  requires a `status` field whose value is exactly `in_progress` or
  `ready_for_review`. Any other value, such as `done`, is rejected as
  `handoff_invalid`.
  - Required: `project: cbc`, `status`, `gate`, `branch`, `base_commit`,
    `head_commit`, `summary`, `validation.build`, `changed_files` (list),
    `founder_only_actions_requested` (list), `delegated_actions` (mapping).
  - Commits must be hex SHAs.
  - `branch` must match `^[A-Za-z0-9][A-Za-z0-9._/-]*$` with no `..`, so it
    can never be read as a git option.
- **Review:** `.agents/chatgpt-review.yaml`, `schema_version: 3`.
  - Required: `project: cbc`, `gate` (must equal the handoff's), and
    `reviewed_commit` (hex).
  - `recommendation` must be one of `recommend_approve`,
    `recommend_changes`, or `recommend_reject`.
  - Each `required_changes` item has `id`, `file`, `change`, and boolean
    `in_scope` and `founder_only`.
  - `founder_decision.recorded_by` must be `founder_only`.

## State machine

The result carries a `transitions` trace: intermediate steps followed by the
final state.

```text
no handoff file ............................................. no_handoff
handoff_loaded -> invalid (incl. unknown status) ............ handoff_invalid
handoff_valid  -> status in_progress ......................... not_ready
status_ready_for_review -> branch master/main or PR not draft  founder_action_required (safety_violation)
safety_checked -> branch absent on origin ................... blocked_branch_not_on_origin
safety_checked -> origin head != head_commit ................ blocked_head_mismatch
origin_verified -> review_request_prepared -> no review ..... awaiting_review   (+ review-request.json)
review_loaded  -> invalid / other gate ...................... review_invalid
review_valid   -> reviewed_commit != head ................... awaiting_review   (stale)
review_current -> recommend_approve ......................... founder_action_required
review_current -> recommend_reject .......................... founder_action_required
review_current -> recommend_changes, >=1 actionable ......... changes_requested (+ claude-work-request.json,
                                                               + founder-action.json for escalated items)
review_current -> recommend_changes, none actionable ........ founder_action_required
```

A required change is **actionable** (sent to Claude) only if all of these
hold:

- `in_scope: true`;
- `founder_only: false`;
- its `file` and `change` text match none of the founder-only patterns:
  merge, mark ready or non-draft, deploy, production or `cbc_prod`, Azure,
  Key Vault, secrets or env, applying migrations or `infra/db/migrations`,
  `package.json` or dependencies, force-push or delete or reset, new gate,
  scope expansion, or architecture.

Every other change is escalated to the founder with the reasons. This
implements AGENTS.md section 6.4 as defense in depth: a review's own flags
are not trusted on their own.

`recommend_approve` always ends at `founder_action_required`, because a
ChatGPT approval is not founder approval. A non-pending `founder_decision`
is reported in `notes`, and the orchestrator never acts on it.

## What the orchestrator does and does not do

- **Reads:** the two YAML files, plus
  `git ls-remote --heads origin refs/heads/<branch>`. That is a read-only
  lookup, done with `execFileSync` and no shell. With `--remote-fixture` it
  makes no git call at all.
- **Writes:** only JSON payloads, to the `--out` directory when given:
  `result.json`, `review-request.json`, `claude-work-request.json`, and
  `founder-action.json`.
- **Never:** git writes, pushes, PR changes, merges, deploys, AI or API
  calls, secrets, or database access.

Exit codes:

- `0`: a normal loop state;
- `1`: an invalid or blocked state;
- `2`: a usage or environment error.

## Usage

```bash
npx --yes tsx@4.23.0 scripts/orchestrator/cli.ts --out .agents/outbox
npx --yes tsx@4.23.0 scripts/orchestrator/test-orchestrator.ts
```

## Validation (2026-10-16)

- **Fixture tests:** 21 passed, 0 failed. Every case runs the real CLI with
  `--remote-fixture`, so no network or git call is made.

```text
PASS: O01 no handoff file: no_handoff
PASS: O02 handoff schema_version 3 rejected: handoff_loaded -> handoff_invalid
PASS: O03 handoff missing required fields: handoff_loaded -> handoff_invalid
PASS: O04 branch name that looks like a git option rejected: handoff_loaded -> handoff_invalid
PASS: O21 status outside in_progress|ready_for_review rejected: handoff_loaded -> handoff_invalid
PASS: O05 status in_progress: handoff_loaded -> handoff_valid -> not_ready
PASS: O06 handoff on master -> founder: ... status_ready_for_review -> founder_action_required
PASS: O07 PR not draft -> founder: ... status_ready_for_review -> founder_action_required
PASS: O08 branch missing on origin: ... safety_checked -> blocked_branch_not_on_origin
PASS: O09 origin head differs from handoff: ... safety_checked -> blocked_head_mismatch
PASS: O10 ready, no review -> review request: ... origin_verified -> review_request_prepared -> awaiting_review
PASS: O11 stale review (other commit): ... review_loaded -> review_valid -> awaiting_review
PASS: O12 review for another gate: ... review_loaded -> review_invalid
PASS: O13 review rewrote founder_decision.recorded_by: ... review_loaded -> review_invalid
PASS: O14 unknown recommendation value: ... review_loaded -> review_invalid
PASS: O15 recommend_changes, all in scope -> Claude work request: ... review_current -> changes_requested
PASS: O16 recommend_changes, mixed -> R1 to Claude, R2-R5 escalated: ... review_current -> changes_requested
PASS: O17 recommend_changes, only founder-only items -> founder: ... review_current -> founder_action_required
PASS: O18 recommend_approve -> founder_action_required: ... review_current -> founder_action_required
PASS: O19 approve with non-pending founder_decision -> noted, not acted on: ... -> founder_action_required
PASS: O20 recommend_reject -> founder_action_required: ... review_current -> founder_action_required
=== Gate 005A orchestrator: 21 passed, 0 failed ===
```

O21 (added in `9ef11d9`) uses `fixtures/handoff-status-done.yaml`. It
expects exit 1 and the error
`status must be one of in_progress, ready_for_review`.

In O16, each escalated item was escalated for these reasons:

| Item | Reason |
| --- | --- |
| R1 | Not escalated; sent to Claude |
| R2 | Mentions merge |
| R3 | Mentions a dependency change |
| R4 | `in_scope` is false |
| R5 | `founder_only` is true, and mentions marking the PR ready |

- **Live read-only origin check** (no fixture, real `git ls-remote`):
  - A handoff pointing at the existing `origin/docs/agent-operating-files`
    at `7a933f5` reached `awaiting_review` and wrote
    `review-request.json`.
  - A nonexistent branch reached `blocked_branch_not_on_origin`.
- **Type check:** `tsc --noEmit --strict` on the three scripts passed. The
  `scripts/` folder is excluded from the app's `tsconfig`, so this was run
  separately.
- **Build:** `npm run build` passed, with the application unchanged.

## Known limitations and follow-ups (founder decisions)

1. **YAML parser:** `yaml@2.9.0` is only a transitive dependency (via
   `inngest` and OpenTelemetry). The CLI loads it through a guard and
   fails closed (exit 2) if it is missing. Making it a direct
   devDependency is a dependency change, so it needs the founder.
2. **Protocol files are not on `master`.** The `.agents/` files and
   AGENTS.md section 6 live on the unmerged `docs/agent-operating-files`
   branch. That branch's handoff template was bumped to v4 with `status` in
   `d26331b` to match this orchestrator.
3. **No AI calls, no automatic loop.** The payloads are prepared for a
   person or a later gate to deliver. Wiring an AI API is a later gate.
4. **Keyword screening is conservative.** It may escalate a harmless change
   that merely mentions, for example, "architecture". Escalation is the
   safe failure mode.
5. **Draft PR:** not created. The GitHub CLI is not installed in this
   environment. Also, the delegated draft-PR rule (AGENTS.md section 6.2)
   exists only on the unmerged docs branch.

## Out of scope

- AI API calls, credentials, and network access other than the read-only
  `git ls-remote`.
- Application source, migrations, environment files, packages, lockfiles,
  and deploy config.
- Merging, marking PRs ready, deploying, production, Azure, and Key Vault.
