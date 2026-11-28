# Gate 009B: event-driven agent pilot (disabled), identity acceptance test and runbook

**Status:** draft for Codex review and founder approval. Preparation and offline validation only.

- No workflow is enabled. Every job is hard-disabled with `if: ${{ false && <its own mode or event condition> }}`. Activation removes only the `false && ` prefix.
- No workflow was dispatched or run. No secret, variable or setting was created or changed.
- No GitHub App exists yet. No model, provider or Azure call was made.
- Merging, activating and running any of this are founder actions (AGENTS.md section 6.3).

Builds on Gate 009A (draft PR #64: protocol, guardrails, App setup). Gate 009A is not merged, so this gate cites it by number and does not depend on its files.

**Founder authorization for this revision (2026-11-28):** the founder asked for automatic GitHub handoffs: a new implementation commit triggers Codex review, and a completed review triggers Claude to assess and fix in-scope findings. Two rounds, no duplicate runs, no loops, merge and deployment stay with the founder, execution stays disabled until Codex reviews the workflow. This revises the earlier founder-triggered design in the same gate. The manual dispatch path stays as a fallback.

## 1. What this gate adds

| File | Purpose |
| --- | --- |
| `.github/workflows/agent-pilot-router.yml` | Secret-free router. On a Codex review, dispatches the privileged run. Optional fallback job posts `@codex review`. Disabled. |
| `.github/workflows/agent-pilot-run.yml` | Privileged run, dispatched only: `implement` (round 1) and `fix` (rounds 2 and 3). Always runs from `master`. Disabled. |
| `.github/workflows/agent-identity-test.yml` | Identity acceptance test A1, A2, A4 to A7. A3 is manual. Runs no model. Disabled. |
| `scripts/agent-collab/guard.mjs` | Deterministic guard: inputs, scope, PR state, review binding, round and duplicate planning, findings filter, secret scan. |
| `scripts/agent-collab/test-guard.mjs` | 80 offline tests, including loop and duplicate-event simulations. |
| `scripts/agent-collab/test-workflow-safety.mjs` | Static checks of all three workflows, with 39 mutation tests proving the checks bite. |
| `scripts/agent-collab/test-router-filter.mjs` | Runs the router's real pre-filter shell blocks against 29 synthetic events. |
| this document | Verification record, design, runbook, activation requirements. |

No `package.json` or lockfile change. The scripts use only Node built-ins.

## 2. Verified trigger support

Read from official documentation on 2026-11-28. "Not stated" means the documentation does not say, so it is **unverified** and listed in section 2.3.

### 2.1 Codex (<https://learn.chatgpt.com/docs/third-party/github>, which <https://developers.openai.com/codex/integrations/github> redirects to)

| Question | Documentation says |
| --- | --- |
| Automatic review | **Supported.** Connect the repository to Codex, then in Codex settings turn on "Automatic review" under "Review code", and choose "Review trigger". Configuring needs GitHub push or admin permission. The available trigger options are not listed. |
| Manual review | A pull request comment containing `@codex review`. |
| How findings arrive | A standard GitHub **code review**, "just like a teammate would". Flags **only P0 and P1** issues. |
| Author | The bot shown as `chatgpt-codex-connector`. The full login string is not stated. |
| Completion signal | Codex reacts with a 👀 to the trigger comment, then posts the review. No separate completion event is described. The submitted review is the signal. |
| Re-review on new commits | **Not stated.** |
| Draft pull requests | **Not stated.** |
| Repository guidance | Reads `AGENTS.md` files, including a "## Code Review Rules" section. |
| Fix or implement from a comment | Not covered. Only review. |

### 2.2 Claude Code GitHub Action (<https://code.claude.com/docs/en/github-actions>, setup guide)

- Automation mode (a `prompt` input) runs on any GitHub event, including `workflow_dispatch`.
- A custom GitHub App token is supported through `github_token`. The custom App needs Contents, Issues and Pull requests, each read and write.
- Actor checks run before Claude starts: on issue and PR events the actor must have write access (override: `allowed_non_write_users` plus an own `github_token`), and on every event a bot actor is rejected unless listed in `allowed_bots`.
- Cost controls: `--max-turns`, workflow timeouts, concurrency groups.
- `--allowedTools` and `--disallowedTools` restrict Claude's tools.
- Commits made with the default `GITHUB_TOKEN` do not start other workflows. Commits made with an App token do.

### 2.3 What is NOT verified, and what that changes

| # | Unverified | Why it matters | Planned handling |
| --- | --- | --- | --- |
| U1 | Codex's exact login string | The router and the run both match it exactly. | Founder reads it from the first Codex review and stores it in `CBC_CODEX_REVIEWER_LOGIN`. A wrong value makes the filter drop everything. It fails closed. |
| U2 | Whether Codex re-reviews a new commit pushed to an existing PR | "A new commit triggers a review" depends on it. | The optional fallback job posts `@codex review` once per head SHA when `CBC_CODEX_TRIGGER_MODE=comment`. |
| U3 | Whether Codex answers an `@codex review` comment written by a GitHub App or `github-actions`, rather than a person | The fallback depends on it. | Test once at activation. If it does not answer, the founder comments by hand. This is exactly the pre-existing founder-triggered flow. |
| U4 | Whether Codex reviews **draft** pull requests | The pilot PR is a draft by design. | Test at activation. If it skips drafts, the founder triggers by hand, or the pilot PR is opened ready (a founder decision, because it changes the PR rules). |
| U5 | The exact value format of the Claude action's `allowed_bots` | The privileged run is dispatched as `github-actions[bot]`. | The workflow sets `allowed_bots: "github-actions"` with a comment. Verified by the first activation run. If refused, the fix job fails closed and the founder dispatches by hand. |
| U6 | Whether the Claude action posts or commits on its own when only `Read,Write,Edit,Glob,Grep` are allowed | The App token could otherwise write. | Verified by the first activation run, and the scope check still gates every push. |
| U7 | Behaviour of `actions/create-github-app-token` versions newer than v2.2.2 | Pinned to v2.2.2, whose inputs match the Claude docs. | Re-check before changing the pin. |
| U8 | Whether a review with no P0 or P1 issues is posted as a review at all | The loop must end cleanly either way. | Both outcomes end the loop. No review means no event. A review with no usable findings ends the run without a model call. |

GitHub platform behaviour relied on, **from general knowledge, not re-verified in this session**: `pull_request_review` runs the workflow file from the pull request, so a secret-free router is needed; `workflow_dispatch` and `repository_dispatch` are the events that a `GITHUB_TOKEN` is allowed to start; `workflow_dispatch` always uses the workflow file from the ref given. Check these against GitHub's documentation in the activation gate.

## 3. Design

### 3.1 Two workflows, because of one GitHub fact

Codex reviews arrive as `pull_request_review` events, and for that event GitHub uses the workflow file **from the pull request**. Anything that holds a secret must therefore not run on that event. So:

```text
Codex submits a review on the App's draft PR
      |  (pull_request_review)
      v
ROUTER  agent-pilot-router.yml     no secrets, no checkout, no repository code, read-only plus actions:write
      |  pre-filter in shell, then: gh workflow run agent-pilot-run.yml --ref master -f mode=fix ...
      v  (workflow_dispatch, always the file from master)
RUN     agent-pilot-run.yml (fix)  three separate jobs, see 3.1a
        1. guard: dispatcher is the founder or github-actions[bot], kill switch is "enabled"
        2. re-read the PR, the review and the commits from the GitHub API (inputs are NOT trusted)
        3. guard: PR is an open DRAFT, opened by the App, same repo, agent/pilot-* branch, head SHA matches
        4. guard: review author is Codex, review commit == head SHA
        5. guard: this review not already handled; round limit not reached; round DERIVED from commit trailers
        6. fetch only this review's text, filter to Codex + head SHA, bound, mark UNTRUSTED
        7. no usable findings -> marker comment (no_findings), stop, no model call
        8. edit job: Claude edits the working tree only; no write credential
        9. publish job: no change -> marker (no_change), stop. Otherwise guard: candidate, tree, scope,
           modes, secrets; commit + push as the App with trailers CBC-Agent-Round: n and
           CBC-Agent-Review: <review id>
      |  push by the App token -> Codex reviews the new head (U2, U3)
      v
(next review event, at most once more)
```

A malicious or modified router can at worst dispatch the run with real-looking inputs. The run re-verifies everything from the GitHub API, so it cannot be tricked into acting on a review that is not Codex's, not on the current head, or already handled.

### 3.1a Credential isolation: three roles, three jobs (review blocker 1)

The model never shares a runner, a checkout or a token with a write credential.

| Role | Jobs | Environment | Holds | Can do |
| --- | --- | --- | --- | --- |
| verify | `fix-verify` | none | read-only `GITHUB_TOKEN`, no secrets | re-reads PR, review, commits and markers from the API, applies every guard, writes the filtered findings file as an artifact |
| edit | `implement-edit`, `fix-edit` | `agent-model` | `ANTHROPIC_API_KEY`, read-only token, checkout with `persist-credentials: false` | Claude edits the working tree (Read, Write, Edit, Glob, Grep). Runs no git and no GitHub API call. Outputs one candidate file as an artifact |
| publish | `implement-publish`, `fix-publish` | `agent-publisher` | `CBC_APP_PRIVATE_KEY`, short-lived App token | never runs the model. Re-verifies, validates the candidate (size, UTF-8, no NUL, no secret-like text), writes it into a **fresh clean checkout**, compares trees with `lstat` instead of git, enforces scope and file modes, commits and pushes as the App, writes the handled-review marker |

The model's `.git` directory is never used or trusted (it could hold hooks or config). The static test fails if a job holds both the model and the App token, if an edit job runs git or `gh api`, or if a checkout stores a credential in a job that must not.

### 3.1b Explicit, separate mode conditions (review blocker 2)

Each job names exactly one condition: `inputs.mode == 'implement'` for the implement jobs, `inputs.mode == 'fix'` for the fix jobs. Every condition starts with `false && ` while disabled. The static test rejects a job that lacks its own condition, selects the other mode, or loses the `false &&` prefix.

### 3.1c File modes and symlinks (review blocker 3)

The candidate is compared with the base tree by `treeDiff`, using `lstat`. Every entry carries a mode (`100644`, `100755`, `120000`). `checkChangedFiles` refuses an entry with no mode, a symlink, an executable, a delete, a rename and any file except the one allowlisted file. A top-level `.git` is ignored because it is never read; a nested `.git` is not.

### 3.1d Reviews that change nothing (review blocker 4)

Every handled review leaves a record. A commit trailer `CBC-Agent-Review: <id>` is written when files change. When Claude finds nothing to change, or the findings are all dropped, or validation fails, the publish job posts one marker comment as the App: `<!-- cbc-agent-handled-review:ID round:N outcome:(committed|no_change|no_findings) -->`. `planFixRound` refuses a review id found in a trailer or in a marker, and counts the highest round in either place, so a no-change review still uses its round and cannot be replayed at paid cost. Only comments of type Bot written by the App count. A human-written or other-bot marker is ignored.

### 3.2 How the first commit reaches Codex

Round 1 (`implement`) stays a **founder dispatch**, which keeps "start a new pilot" a human decision. The App opens a draft PR. Codex's Automatic review (or the fallback comment) picks it up. From there the handoffs are automatic.

### 3.3 Loop, duplicate and runaway protection

| Risk | Control | Where |
| --- | --- | --- |
| Endless review and fix cycle | Round derived from commit trailers. Implementation is round 1, fixes are rounds 2 and 3. Round 4 is refused. Cannot be set by an input. | `planFixRound`, simulated with a reviewer that always finds something: exactly 2 fix runs |
| Same review delivered twice | Each fix commit records `CBC-Agent-Review: <id>`, and every no-change outcome records an App-authored marker comment. A review id already recorded in either place is refused. | `planFixRound`, simulated by replaying events |
| Two events at once | Per-PR concurrency group, no cancel. The second run waits, then finds its review handled or its head SHA stale. | `fix` job `concurrency` |
| Review of an old commit | `review.commit_id` must equal the current head SHA and the SHA named in the dispatch. | `checkReview`, `checkPullRequest` |
| Claude's own push triggering Claude | Claude's push produces no Claude trigger. Only a **Codex review** does. The router ignores every other author. | router pre-filter |
| Bot or comment ping-pong | The router subscribes to reviews, not comments, and posts no comment except the optional single `@codex review` per head SHA (marker comment, checked first). | router |
| Runaway cost | `--max-turns 8`, 20 minute timeout, at most 2 fix runs per pilot, provider-side spend limit set by the founder. | run |
| Forged or injected review text | Only the named reviewer, only this review, only the head SHA, 2000 characters each, 20 items, control characters stripped, secret-like text dropped, wrapped as UNTRUSTED DATA. Scope check is the real control. | `prepareFindings`, scope step |
| Stop everything now | Unset or change `CBC_AGENT_PILOT_ENABLED` (checked by the router and the run). No PR is needed. Removing the App key or uninstalling the App also stops it. | router, run |

### 3.4 Founder authority is unchanged

- Claude is given no Bash, no git, no network tools. It cannot push, comment, approve or merge.
- Only deterministic steps hold the App token's write power, and only after `guard.mjs` passes.
- The App has no Workflows, Administration or Secrets permission, so it cannot change CI or settings.
- PRs stay drafts. The existing ruleset needs a human approval to merge. No step calls merge or enables auto-merge (the static check forbids it).
- Nothing deploys. A merge to `master` is still a Vercel production deployment (AGENTS.md section 20) and is the founder's act.

### 3.5 Residual risks (honest list)

- **The two environments (`agent-model`, `agent-publisher`) must have no required reviewer** for the loop to run unattended. A required reviewer would pause every run for the founder's click. Without it, the controls are: the master-only deployment branch for the environment, the kill switch, the provider spend limit, the scope check and the ruleset. This is a founder decision (section 9).
- Claude can write anything to the one allowlisted file, including misleading text. The founder reviews the diff before any merge.
- A prompt-injected Codex review cannot get an out-of-scope file pushed (scope check), cannot start a third round, and cannot repeat a review. It can still waste one bounded run.
- Codex reports only P0 and P1. A docs-only pilot may get an empty review and end after round 1. That is a valid result but a weak test of the fix path. Section 9 offers a founder option for this.
- The App token embedded in git operations is masked by GitHub in logs and checked by A7. It is still the most sensitive value in a run.
- **Unverified:** how the Claude action behaves with only Read, Write, Edit, Glob and Grep and a read-only token (it may try to post a comment and fail). Cannot be tested offline; first dispatch will show it.
- Everything here was validated offline only. No workflow has ever executed.

## 4. Pilot task (trusted, one file)

Task id `cbc-doc-pilot-001`. Allowed file: `docs/engineering/agent-pilot-sample.md`. Nothing else may change.

The implementer writes a short document (about 15 lines) with exactly these headings: `Purpose`, `How a round works`, `Round limit`, `Who decides`. It states, in its own words, that: the founder starts the pilot; Codex reviews and Claude fixes automatically; at most two review-and-fix rounds; the founder alone merges. It must not mention any secret, URL or credential.

## 5. Identity acceptance test A1 to A7

Run once, by the founder, after the App is installed and `agent-identity-test.yml` has been activated by a separate PR.

| # | Check | Pass condition | Automated |
| --- | --- | --- | --- |
| A1 | The App token pushes a docs branch | branch on `origin` | yes |
| A2 | The App opens a draft PR | author `<slug>[bot]`, type Bot, draft | yes |
| A3 | The founder approves that PR from the founder account | approval accepted by the existing ruleset | **manual** |
| A4 | Master protection is active | rules for `master` include `pull_request`, `non_fast_forward`, `deletion` | yes (read-only; a live push to master is deliberately not attempted) |
| A5 | The App cannot change a workflow file | push of a `.github/workflows/*` change is refused | yes (throwaway branch) |
| A6 | The App cannot approve its own PR, and the PR is blocked | approval refused; `mergeable_state` is `blocked` | yes (merge is never called) |
| A7 | No key or token in the transcript | no secret pattern, and the token literal is absent | yes |

If A2 fails the identity model does not work and the pilot does not start. Record the result in a follow-up gate document.

## 6. Exact credential and setting requirements

Nothing here is created by this gate. **Never paste any value into chat.**

| Where | Name | Kind | Content |
| --- | --- | --- | --- |
| GitHub App (Settings, Developer settings) | `cbc-implementer` | App | Webhook off. Install on **this repository only**. Permissions: Metadata read, Contents read and write, Pull requests read and write, Issues read and write. Nothing else. |
| Environment `agent-publisher` | `CBC_APP_PRIVATE_KEY` | secret | the App's `.pem` private key. Used only by publish jobs and the identity test. Never visible to the model. |
| Environment `agent-model` | `ANTHROPIC_API_KEY` | secret | an Anthropic API key with a console spend limit. Used only by edit jobs. Never alongside the App key. |
| Both environments | (settings) | environment | deployment branches: `master` only. Required reviewer: **none** (decision 1, section 9, confirmed by the founder). |
| Repository variables | `CBC_APP_ID` | variable | the App's numeric ID |
| | `CBC_APP_SLUG` | variable | `cbc-implementer` (the name, without `[bot]`) |
| | `CBC_FOUNDER_LOGIN` | variable | the founder's GitHub login |
| | `CBC_CODEX_REVIEWER_LOGIN` | variable | the exact login on a real Codex review (probably `chatgpt-codex-connector[bot]`, **unverified**) |
| | `CBC_AGENT_PILOT_ENABLED` | variable | set to `enabled` only while a pilot is allowed to run. Unset or any other value stops it. |
| | `CBC_CODEX_TRIGGER_MODE` | variable | leave unset. Set to `comment` only if Codex does not review the App's pushes by itself. |
| Codex settings | Code review, "Automatic review", "Review trigger" | setting | enable for **this repository only** |

## 7. Runbook: founder steps in order

Nothing in this list is done by this gate.

1. **Observe Codex first (cheap, before creating the App).** Enable Codex code review and Automatic review for this repository. Open or use any small PR and note: (a) does Codex review a **draft** PR (U4)? (b) does it review again after a new commit (U2)? (c) the exact author login on its review (U1). Write the three answers into the PR conversation or tell Claude. These decide whether the fallback job is needed.
2. Codex reviews the exact head commit of the gate PR. The founder reads the findings.
3. The founder merges this PR (a merge to `master` is also a Vercel production deployment under AGENTS.md section 20; this PR changes no application code).
4. Create and install the App, create the environment, create both environments, store the two secrets (one in each), set the variables (section 6). Leave `CBC_AGENT_PILOT_ENABLED` unset.
5. Activation PR 1 removes the `false && ` prefix from `agent-identity-test.yml` only. Codex reviews it. The founder merges it.
6. Dispatch the identity test once. Check A1 to A7, including A3 by hand.
7. If A1 to A7 pass: activation PR 2 removes the `false && ` prefix in the run and router workflows. Codex reviews it. The founder merges it.
8. Set `CBC_AGENT_PILOT_ENABLED=enabled`. Dispatch `agent-pilot-run` once with mode `implement`.
9. Watch the loop. Expected: draft PR by the App, Codex review, router run, fix run, new commit, Codex review, router run, fix run (or an earlier clean stop). At most rounds 1, 2, 3.
10. Unset `CBC_AGENT_PILOT_ENABLED`. Read the diff and decide whether to approve and merge. The workflows never merge.
11. Pilot acceptance: PR author is the App bot; only the allowlisted file changed; round trailers 1, 2, 3 and no more; no review handled twice; no secret in any log; every handoff happened without a founder click except the first dispatch.

Stop at any step if a check fails. Revoke by removing the App key, uninstalling the App, deleting the environment secrets, or unsetting `CBC_AGENT_PILOT_ENABLED`.

## 8. Activation requirements and offline validation

Activation PRs change only `if:` lines, and nothing else. Re-run the offline scripts. The router filter test uses bash and must run on Linux or WSL; a Windows Git Bash result is not evidence either way on each activation commit. Re-check the pinned actions and the Claude and Codex documentation. Codex reviews the exact activation commit before the founder approves execution.

Pinned versions (resolved with `git ls-remote`, 2026-11-28):

| Action | Pin |
| --- | --- |
| `actions/checkout` | `d23441a48e516b6c34aea4fa41551a30e30af803` (v6.1.0) |
| `actions/create-github-app-token` | `fee1f7d63c2ff003460e3d139729b119787bc349` (v2.2.2) |
| `anthropics/claude-code-action` | `4411a9e9b0283becf4b924f7bce360fd7756c78c` (v1.0.290, annotated tag peeled to its commit) |
| `actions/upload-artifact` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` (v7.0.2) |
| `actions/download-artifact` | `9000827ccba6bdab643e8b6fd33ac0654aef8333` (v8.0.2) |

Offline validation performed (2026-11-28), in a clean checkout of this branch:

```text
node scripts/agent-collab/test-guard.mjs               -> 117 passed, 0 failed (includes tree/mode, candidate, marker and synthetic-review fixture cases)
node scripts/agent-collab/test-workflow-safety.mjs     -> 60 passed, 0 failed (3 real files + 57 mutation tests)
node scripts/agent-collab/test-router-filter.mjs       -> 29 passed, 0 failed
yaml.safe_load on the three workflows                  -> parse OK
bash -n on every run block (expressions replaced)      -> 0 syntax errors
```

Not run: `actionlint` (not installed in the session), any GitHub-hosted run, any dispatch. **The workflows have never executed anywhere.**

## 9. Open founder decisions

**Founder confirmation (2026-11-28, in the founder's own words in chat):** "I confirm decisions 1-3: no required reviewer for the dedicated agent-model and agent-publisher environments; Issues read/write for the CBC-only App; and a docs-only pilot with AGENTS.md unchanged." The founder stated that this **does not authorize merging or activation**. The founder's decisions 1, 2 and 3 map to items 1, 2 and 4 below. Item 3 (which Anthropic credential to use) is **not yet confirmed**; the API key remains a proposal. Merge, activation, App and environment creation, secrets and Codex settings still each need the founder's separate approval.

1. **Environments without a required reviewer** (`agent-model` and `agent-publisher` only; production protections unchanged). **Confirmed.** Needed for unattended rounds (section 3.5). Alternative: keep the founder as required reviewer, so each run waits for one click, which is semi-automatic.
2. **Wider App permission** (Issues read and write, this repository only), required by the Claude docs. **Confirmed.**
3. **Credential (open, awaiting the founder):** an Anthropic API key (proposed), or the subscription OAuth token, or federation.
4. **Pilot scope** (the founder's decision 3). **Confirmed:** docs-only, `AGENTS.md` unchanged. Keep the first pilot docs-only and accept an empty review as a valid outcome; do not change `AGENTS.md` just to manufacture findings; test the fix path with the controlled fixtures in `test-guard.mjs`. Alternative: the founder approves a "## Code Review Rules" section in `AGENTS.md` (an amendment under section 19, a separate docs-only gate) that tells Codex to treat contradictions with the gate document as P1.
5. **Older pilot draft (PR #61).** This gate is an alternative that avoids a separate API-key reviewer script. Close, keep or merge it later. This gate does not touch it.

## 9a. Cost note

Codex reviews are not free: each automatic review uses the founder's ChatGPT plan review allowance, and each loop run adds Anthropic API cost. Controls: two fix rounds at most, `--max-turns 8`, a provider spend limit, the kill switch, and no model call when a review has no findings.

## 10. Out of scope

Enabling or dispatching any workflow; creating the App, the environment, secrets or variables; enabling Codex; changing the ruleset or any setting; merging; deploying; Azure, Key Vault, Supabase or database access; package or lockfile changes; changing `AGENTS.md`.
