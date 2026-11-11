# CBC multi-AI coordinator — review-only implementation increment

**Status: NOT ACTIVATED.** This increment is prepared only on draft PR #61. It creates no GitHub workflow trigger, credentials, provider calls, permissions, deployment or merge. The existing `.github/workflows/agent-pilot.yml` remains hard-disabled with `if: false`.

## Design decision

Use **native GitHub Actions** as the eventual event runner, GitHub issue/PR state as durable evidence, and a simplified GitHub Projects view as the founder interface. Claude Code is the sole implementation owner; OpenAI and Gemini independently review the exact same commit. Do not introduce Linear, LangGraph, LangSmith or gh-aw in this pilot. GitHub remains the only source of truth. The founder should not be required to relay agent messages.

Gate 005A (`scripts/orchestrator/orchestrator.ts`) remains the authoritative handoff/review state-machine pattern and founder-only policy. Gate 005D (`docs/gates/gate-005d-reviewer-adapter-design.md`) remains the evidence, policy pinning, secret scan and review lifecycle specification. The new `coordination.mjs` is a **pure two-review join decision** for the narrow documentation pilot, not a second generalized orchestration platform. The existing `review.mjs` validation is reused; do not treat it as a replacement for Gate 005D.

## Prepared files

- `scripts/agent-pilot/coordination.mjs`: no side effects; checks trusted task ID, full commit/base SHAs, allowed file, correction count, reviewer completeness, exact-SHA review validation, review escalations, and deterministic acceptance. Produces a *proposal* to correct or a founder-stop state. It cannot dispatch Claude or approve a merge.
- `scripts/agent-pilot/test-coordination.mjs`: offline regression cases covering join, stale SHA, missing reviewer, active implementation, out-of-scope changes, founder-only findings, correction ceiling, approval stop and malformed state.
- The original disabled workflow, local pilot runner and sample document are unchanged by this increment.

## Required integration before any real pilot

1. **Trusted event source and task state:** define an allowlisted founder-approved task record; validate event actor against trusted GitHub identity, not text labels or AI comments alone. Persist task ID, single implementation owner, PR/branch, base/head SHA, correction count and run IDs. Recompute state on retries. Use concurrency plus idempotent branch/PR and event checks; concurrency alone is insufficient.
2. **Evidence and independent reviewers:** fetch immutable GitHub commit evidence and policy from verified origin refs per Gate 005D, perform pre-egress secret checks, and bind each reviewer response to trusted provider-run provenance and exactly the same full SHA. A JSON field claiming `reviewed_commit` is not independent proof of what was reviewed. Keep OpenAI and Gemini output isolated until both have completed.
3. **Deterministic controller:** wait for both validated reviews, reject stale/duplicate events, aggregate only in-scope findings, allow at most one correction, and stop on errors or founder-only decisions. Re-review the corrected SHA before declaring readiness; never infer approval from an AI recommendation.
4. **Provider adapters:** use bounded, isolated Claude Code CLI execution and independently authenticated OpenAI and Gemini reviewer APIs. Provider credentials, model selections, supported Gemini integration, exact budgets and immutable dependencies require separate founder approval.
5. **Safe publishing and UX:** draft PR only, immutable SHA-linked check results, a read-only consolidated Projects/issue view, and founder notifications. No automatic merge, marking PR ready, deploy or Azure operation. Master-branch workflow activation and any production consequences require a separate approval.

## Current proof boundary

The offline test source is prepared but **has not been executed** as part of this GitHub-only change. There is no live Gemini adapter, provider handoff, remote state persistence, task-dispatch workflow or founder dashboard yet. The earlier `orchestrate.mjs` is still a gated Claude/OpenAI-only local pilot, not a complete three-AI system. No runtime success is claimed.

## Activation gate (not authorized)

Before enabling any workflow: review the code and policies; run isolated offline tests; verify the task/branch/commit guards and actual provider authentication; pin third-party actions; review GitHub permission boundaries; obtain founder approval for secrets, usage budgets, workflow activation and a single pilot dispatch separately. Never interpret approval of this review-only preparation as permission for those actions.
