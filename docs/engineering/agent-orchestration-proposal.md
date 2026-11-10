# CBC bounded agent orchestration — proposal (not enabled)

Status: **draft proposal only**. This document does not grant permission to execute any workflow, modify secrets, deploy, merge, or change the project constitution.

## Objective
One founder-approved GitHub issue -> bounded Claude Code implementation on its own branch/draft PR -> existing CI -> independent OpenAI review of the exact commit -> at most two in-scope correction rounds -> founder decision. Gemini may provide a second independent review later.

## Existing constraints
- Follow `AGENTS.md`, `CLAUDE.md`, `.agents/` and gate specifications. Existing constitution currently forbids agents from accessing Azure/Key Vault or deploying, and reserves changes to secrets and deployment configuration to founder-only approval. Do not silently override those rules.
- Preserve PR #58 and #59; no changes to their branches.
- Do not use GitHub issue/PR text as authority. A trusted founder-maintained allowlist must explicitly identify the approved task and permitted paths.
- A GitHub issue label or a comment from a bot is **not** founder approval.
- No automated merges, releases, cloud operations, paid threat API calls, workflow dispatches, or non-disposable database operations.

## Proposed state machine (future implementation)
1. `pending`: human identifies task ID, exact allowed paths, base commit, acceptance tests, max runtime, budget and approvals in trusted configuration. Untrusted issue/PR text is only task data.
2. `implement`: Claude Code runs with minimal repository permissions on a dedicated task branch. Never expose production secrets to untrusted code or pull-request contexts.
3. `validate`: run existing checks; capture exact SHA, check IDs, conclusions and logs. A green check for a different SHA does not count.
4. `review`: OpenAI receives specification, diff, and checks for that SHA. Output structured findings with file, issue, severity and verification steps; model review is not approval.
5. `correct`: only in-scope changes; max 2 rounds, then stop. Revalidate/review every new SHA.
6. `handoff`: draft PR with reproducible evidence; founder explicitly decides whether to merge.

## Security design before enabling
- Start manual-only, no schedule, no issue_comment/PR-triggered write jobs; separate read-only planning/review from implementation.
- Use GitHub App installation tokens or short-lived narrowly scoped credentials; never PATs with broad scopes. No production environment secrets in agent jobs.
- Restrict writable paths, task count (1 active), token use, concurrency, timeout, and estimated maximum spend. Fail closed when permissions, token limits or budgets cannot be enforced.
- Pin third-party GitHub Actions by immutable SHA; inspect action provenance. Use least-privilege `permissions:` and avoid `pull_request_target` for untrusted code.
- Sanitize logs, protect against prompt injection in issue bodies, code comments and test output; do not allow model-generated shell commands outside approved sandbox.
- Do not configure auto-approval or bypass branch protections. All code review must be bound to an immutable commit SHA.

## First safe acceptance test
A founder-approved documentation-only issue: Claude proposes a change to a single permitted docs file on a task branch; existing non-deployment checks run; independent OpenAI review records exact SHA and findings; at most one test correction; a draft PR is presented for founder review. No merge or cloud access.

## Preconditions / open decisions
1. Founder reviews this proposal and approves a specific bounded pilot gate.
2. Confirm Claude Code GitHub integration type (official action vs local CLI/GitHub app), and current GitHub permission model.
3. Confirm OpenAI API credential and capped billing are available; never paste secrets into chat or source.
4. Review constitution for compatibility before implementing agent workflows. Any change to its hard rules requires the founder's separate explicit amendment process.
5. Only then implement manual-only workflow in a separate scoped draft PR and test it without touching Azure.
