# CBC agent pilot — implementation for review, deliberately disabled

**Status:** Draft only. Founder authorized code preparation, not workflow activation, dispatch, credential changes, merge, deployment, Azure access or governance amendment.

## Relationship to existing PRs and code
PR #60 contains a docs-only proposal; PR #61 is the **single implementation candidate** and supersedes PR #60's proposed implementation path without changing or closing PR #60. Gate 005A (`scripts/orchestrator/`) already provides a local review state machine and Gate 005D specifies a rigorous reviewer adapter. The new narrow runner is a pilot execution adapter, **not** a second general-purpose orchestrator. Production-grade integration should reuse Gate 005A/005D rather than duplicating their protocols.

## Exact proposed execution and authentication
1. Founder explicitly approves a **separate activation PR** and one manual dispatch. This PR's workflow remains hard-disabled.
2. The future GitHub Actions `workflow_dispatch` checks out the pinned `master` SHA, creates the dedicated task branch `gate-agent-pilot-run-001`, and runs the pilot script with a **GitHub App installation token** scoped to this repository and branch (contents write and draft-PR creation only). No broad PAT; GitHub's built-in token is read-only in this draft.
3. `claude -p` invokes the preinstalled **Claude Code CLI** with its own separate approved Claude authentication (e.g., scoped Anthropic API credential supported by the CLI). It is not assumed that a GitHub-connected Claude web session makes the CLI available in Actions. Exact install method and immutable action/dependency versions must be verified before activation. The CLI is limited to Edit/Write/Read tools and a task allowlist, with filesystem changes verified by git.
4. The runner uses `fetch('https://api.openai.com/v1/responses')` with `OPENAI_API_KEY` and a founder-selected `CBC_OPENAI_REVIEW_MODEL`; the model receives a bounded diff, task spec and deterministic acceptance outcome. Its JSON findings are checked for exact commit SHA, permitted file and founder-only escalation. **The reviewer is an API agent, not this ChatGPT conversation.**
5. The first Claude pass intentionally omits the acceptance marker. The **real verifier** reads the changed document and fails. The OpenAI reviewer must independently identify the missing criterion, rather than being supplied a fabricated reviewer response. Claude gets its validated finding, makes exactly one correction, and the verifier must pass on a new SHA. The reviewer re-examines the new SHA. If any step fails, stop for founder.
6. A separate approved publishing stage would push the task branch and create a **draft PR**, record check IDs, commit SHAs, outcomes and redacted logs. This draft runner deliberately does not push or open a PR. It cannot yet demonstrate the full remote handoff.

## Security and control requirements
- Allowed changed file: **only** `docs/engineering/agent-pilot-sample.md`. Both worktree and committed diff are checked. No application, migration, infrastructure, environment, workflow or dependency changes in the live pilot.
- Single trusted task `cbc-doc-pilot-001`, no issue/PR text instructions. Only manual `workflow_dispatch`; no comments, schedules or PR-triggered write jobs.
- Single run at a time via GitHub Actions `concurrency` and no automatic retries. One correction attempt, two Claude invocations, two OpenAI reviewer invocations.
- GitHub token read-only until separately approved activation. Implementation/publishing token must have minimal repository scope and no access to protected branches. No Azure, Key Vault or deployment secrets.
- Pin GitHub Actions by immutable commit SHAs; use an isolated runner with no cloud credentials and no untrusted checkout contexts. Do not enable `pull_request_target`.
- Manual stop: cancel the Actions run, revoke its short-lived GitHub App token or provider credential if necessary, and leave branch/PR unmerged. Fail closed on timeouts, missing auth, wrong branch, scope violation, changed master, review SHA mismatch or exceeded budgets.
- No model response is founder authorization. No automatic merge, release, workflow modification or governance change.

## Costs and limits
- Hard **call-count ceilings in code**: at most 2 Claude invocations and 2 OpenAI invocations. Each Claude invocation has a 120-second process timeout; each OpenAI request a 30-second abort timeout. OpenAI requests cap output tokens at 700 and diff input at 20 KB. Workflow job timeout must be 10 minutes or less.
- These limits are **not a monetary hard cap**: provider-side metering, retries inside Claude Code, model pricing, prompt/context expansion, and charges on timed-out calls may exceed estimates. Before activation, select specific models, set provider-side budget alerts and usage caps where supported, and enforce Claude's model/max-turns and a bounded input budget. If a strict spending ceiling cannot be guaranteed, disclose that and obtain explicit founder approval of maximum financial exposure.
- No Gemini costs in this pilot.

## Activation plan — separate approval required
1. Review PR #61, inspect Gate 005A/005D compatibility, and run offline test `node scripts/agent-pilot/test-pilot.mjs` in a disposable local checkout **only after approval to run validation**. This request did not authorize running the pilot.
2. Obtain founder approval to merge the reviewed workflow and scripts into **default branch `master`**. GitHub normally offers manual `workflow_dispatch` for workflows present on the default branch. This merge is **not** authorized here and may have separate Vercel production implications under AGENTS.md.
3. In a **separate activation PR**, replace the hard-disabled job with a manual-only, pinned-actions job, install/verify Claude Code CLI, create/pin the isolated task branch, add a safe draft-PR publishing stage, enforce concurrency, verify exact SHA after push, capture CI check conclusions for that SHA, and integrate Gate 005A/005D review contracts. This draft is not yet dispatchable for a real end-to-end loop.
4. Founder separately approves credential creation/configuration, GitHub App permissions, provider models, budgets, and the exact manual dispatch. No secrets in repository files or chat.
5. Dispatch exactly once, capture SHA-linked evidence, stop for founder review; never merge or deploy automatically.

## Current validation status
No workflow dispatched, no AI/API calls made, and no Azure touched. The offline test script is prepared but has **not** been executed in this request. A passing offline test would not establish live AI collaboration.
