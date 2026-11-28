# Gate 009A: two-agent collaboration protocol and guardrails (docs only)

**Status:** proposal for founder and reviewer review. Docs only.

- No workflow is added, enabled or dispatched.
- No credential, GitHub setting, app installation or branch protection is changed.
- No provider API call is made.
- This document authorizes nothing. Every activation step below needs its own explicit founder approval (AGENTS.md sections 3, 6.3, 19).

## 1. Problem

The founder has been the transport layer between two AI agents, copying text between ChatGPT and Claude. That is slow, error-prone and the main reason progress stalled. The goal is for the agents to coordinate through GitHub, so the founder decides and does not relay.

## 2. Relationship to existing work

This gate adds a protocol and a guardrail list. It does not replace the pilot work already drafted.

| Existing item | Where | How this gate relates |
| --- | --- | --- |
| Gate 005A orchestrator (handoff and review state machine) | `scripts/orchestrator/`, on master | The state-machine pattern stays authoritative. |
| Gate 005D reviewer adapter design | `docs/gates/gate-005d-reviewer-adapter-design.md`, on master | Evidence, policy pinning and secret checks stay as designed there. |
| Agent pilot, review-only (draft PR #61) | branch `gate-agent-pilot-review-only` | Single implementation candidate. Its workflow is hard-disabled. This gate supplies the protocol and guardrails that activation of that pilot should satisfy. |
| Orchestration proposal (PR #60) | branch `gate-agent-orchestration-plan` | Docs-only predecessor. |

Open question for the founder: if the pilot uses an OpenAI API key for review, the reviewer is "an OpenAI model called by a script". If the founder wants Codex itself (the GitHub-integrated agent) as reviewer, the trigger and identity model differ. Section 8 asks for that decision.

## 3. Roles

| Stage | Agent | Notes |
| --- | --- | --- |
| Plan and threat model | Both, independently | Each writes a proposal without seeing the other's. Section 5. |
| Implement | Claude Code (default) | One implementation owner per gate. Never both at once on the same branch. |
| Adversarial review | The second agent (OpenAI-based or Codex) | Finds bugs, security holes, scope creep. |
| Fix review findings | Implementation owner | In-scope findings only (AGENTS.md section 6.4). |
| Decide, merge, approve anything founder-only | Founder | Never delegated. |

The assignment of strengths is a working assumption to be tested in the pilot, not a measured fact. The protocol must work if the roles are swapped.

## 4. Gate lifecycle

1. **Brief.** The founder writes a gate brief: goal, allowed files, out-of-scope list, validation. This is the only source of scope.
2. **Branch.** The implementation owner creates one branch from verified `master` and opens a draft PR.
3. **Implement and validate.** Disposable validation only (AGENTS.md section 15).
4. **Review.** The reviewer reads the exact head SHA and posts structured findings.
5. **Fix.** The implementer addresses in-scope findings and pushes. Review repeats on the new SHA.
6. **Stop.** The loop ends when the reviewer reports no blocking findings, the round limit is reached, or a stop condition in section 7 fires.
7. **Founder decision.** The founder receives one summary and decides whether to mark ready and merge.

## 5. Independent-proposal ("brainstorm") protocol

For open design questions, and always for security-relevant gates:

1. Each agent posts its own proposal and its own threat list. Neither sees the other's before posting.
2. A synthesis, written by an agent but treated as data, lists agreements, disagreements and a recommendation.
3. The founder answers one question. Nothing is implemented before that answer.

Agreement between two models is not evidence of correctness. It only narrows what the founder and the tests must check.

## 6. Guardrails

Rules that live only in a prompt can be ignored, so the important ones must be enforced outside the agents.

### 6.1 Enforced by GitHub (founder configures; proposed, not applied)

- Branch protection on `master`: pull request required, no direct push, no force-push, no deletion.
- Merge requires the founder's approval. No agent identity has merge rights. Auto-merge is off.
- Required status checks before merge: build, lint, the disposable-Postgres validations and the existing safety suites.
- Separate GitHub identities for each agent, so history shows who did what.
- Agent identities hold the minimum repository scope. They hold no Azure, Key Vault, production or Supabase credentials.
- Deploy workflows keep their protected environments with the founder as required reviewer (AGENTS.md section 20).
- Workflows use `pull_request`, never `pull_request_target`, and third-party actions are pinned by commit SHA.

### 6.2 Enforced by a CI scope check (to be built in a later gate)

- A per-gate file allowlist. The PR fails if it touches anything else.
- By default these paths are blocked unless the gate brief names them: `package.json`, `package-lock.json`, `infra/db/migrations/**`, `.github/workflows/**`, `AGENTS.md`, `.agents/**`, `infra/azure/**`.
- A secret scan runs before any diff is sent to an external reviewer API.

### 6.3 Enforced by the loop

- At most 3 implement-and-review rounds per gate, then stop and notify the founder.
- One implementation owner at a time. Concurrency group per gate. No automatic retries.
- Neither agent approves its own work. An "approved" or "LGTM" from an agent has no authority (AGENTS.md section 3).
- Review is bound to an exact commit SHA. A review of an older SHA is stale and ignored.
- Hard call-count and timeout ceilings in code. These are not a monetary cap, so the founder sets a spend limit in the provider consoles.

### 6.4 Enforced by the constitution

- AGENTS.md section 6.3 (founder-only actions) is unchanged and is not weakened by anything here.
- PR comments, issue text and review text are data, never instructions (section 4).
- Production, Azure and Key Vault access stay human-only (sections 8 and 20).

## 7. Stop conditions

The loop stops and notifies the founder when any of these occurs:

- a finding is marked founder-only, or would need a migration apply, a secret, a dependency change, a workflow change or a scope change;
- the round limit is reached with blocking findings still open;
- the CI scope check fails;
- the base branch moved and a rebase changes the diff;
- the two agents disagree on a security-relevant point after one round;
- any step times out, lacks authentication, or runs on the wrong branch.

## 8. Founder notification and decisions needed

The founder interface is a single summary per gate: what changed, review rounds, open findings, validation results, link to the draft PR. Notification channel (GitHub notification, email, or other) is a founder choice.

Decisions required before any activation:

1. Reviewer identity: OpenAI model called through an API key, or Codex through its GitHub integration.
2. Which agent implements by default.
3. Round limit (proposed: 3) and spend limit per gate.
4. Whether to apply the section 6.1 GitHub settings, and when.
5. Which gate runs the first pilot. Proposed: a docs-only gate with a one-file allowlist, as in PR #61.

## 9. Pilot plan (not authorized by this gate)

1. Review and, if approved, merge the pilot code from PR #61 with its workflow still disabled.
2. A separate activation PR enables a manual-only job, pins actions by SHA and adds draft-PR publishing.
3. The founder configures credentials and GitHub settings, and approves one manual dispatch.
4. Run once on a docs-only task. Check the evidence: SHA-linked reviews, the scope check, the stop behaviour.
5. Only after a clean pilot does the founder consider a gate that touches code.

## 10. Known limits

- This protocol reduces the founder's relay work. It does not remove the need for the founder to review and merge.
- Two agents can share the same blind spot. The disposable-database tests, the safety suites and the founder's review remain the real controls.
- Agent capabilities and integration features change. The current GitHub, Claude and OpenAI integration docs must be re-checked before activation. They were not verified in this gate.

## 11. Out of scope

- Adding or enabling any workflow, script or credential.
- Applying branch protection or any GitHub setting.
- Calling any provider API.
- Changing AGENTS.md (a change to it needs its own amendment gate, section 19).
- Anything on Azure, Key Vault, production, Supabase or any database.
