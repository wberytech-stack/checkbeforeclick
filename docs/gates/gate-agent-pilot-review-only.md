# CBC agent pilot — review-only implementation proposal

**Status:** Draft only. Founder approved preparing scripts and a separate draft PR, **not** enabling or running the workflow, configuring secrets, or touching Azure.

## Purpose and relation to existing work
This is a bounded demonstration design, not a new product architecture. Reuse Gate 005A's existing `scripts/orchestrator/` state machine and Gate 005D's reviewer-adapter contract when wiring real providers. The existing state machine does not call AI APIs. The new files are a minimal, independently inspectable fixture prototype; they are not a replacement for the existing protocol.

## Proposed changed files
- `.github/workflows/agent-pilot.yml` — manual event declaration but job **hard-disabled** by `if: false`; read-only token, no secrets, no external actions.
- `scripts/agent-pilot/orchestrate.mjs` — offline fixture demonstrating implementation → failing check → review → correction → passing check → founder stop.
- `scripts/agent-pilot/review.mjs` — fail-closed review-schema/SHA validator; external OpenAI invocation explicitly disabled.
- `scripts/agent-pilot/verify.mjs` — single allowed documentation file and deterministic acceptance marker.
- `docs/engineering/agent-pilot-sample.md` — future isolated documentation test target.
- This gate document.

## What is real versus simulated
All AI steps in `--offline-fixture` are **synthetic**. The workflow has not been dispatched. No Claude or OpenAI credential is read, no API is called, no branch is created by the scripts, and no PR is created by them. A successful fixture result does **not** prove agent collaboration.

## Remaining implementation after founder review
1. Confirm whether existing Claude Code integration is GitHub Action, GitHub App, or local CLI. Bind it to a single trusted task/branch, with no production credentials.
2. Implement the Gate 005D OpenAI reviewer adapter using its policy-pinning, secret-scan, immutable SHA and founder-decision rules. Validate schema, scope, and commit identity before handing findings to Claude.
3. Wire GitHub Actions to the existing Gate 005A orchestrator and provider adapters, with separate read-only review and least-privilege implementation credentials. Keep workflow manual-only, concurrency one, bounded runtime, maximum two correction rounds, no PR comment trigger, no automatic merge or deploy.
4. Enforce real usage limits or fail closed. Do not call an unbounded provider with a merely advisory budget. Obtain founder approval for each secret/permission change and for the pilot execution.
5. Demonstrate one actual documentation-only task and correction with logs, exact SHAs, check results, draft PR and founder stop. This has **not** occurred.

## Existing constitution constraints
`AGENTS.md` §§5–8, 11, 13, 18–20 apply. Agent instructions and model output are not founder authorization. Changes to constitution require its docs-only amendment procedure. No Azure, Key Vault, non-disposable DB, deployment, dependency, merge, or environment change is part of this PR.

## Validation plan (not executed by this request)
- `node scripts/agent-pilot/orchestrate.mjs --offline-fixture` should produce `fixture_pass` and explicitly `real_agents_invoked: false`.
- `node scripts/agent-pilot/verify.mjs docs/engineering/agent-pilot-sample.md` should fail until a future task adds the acceptance marker.
- Schema checks must reject stale review SHAs, founder-decision injection and out-of-scope findings.
- Inspect workflow job-level `if: false` and read-only permissions before any merge.

## Decisions needed before activation
Founder approval of the exact workflow change to remove the disabled guard; explicit approval to configure narrowly scoped Claude/OpenAI credentials, model selection, cost caps and a one-time manual dispatch. Nothing in this draft constitutes those approvals.
