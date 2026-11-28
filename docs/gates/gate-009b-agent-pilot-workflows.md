# Gate 009B: disabled agent pilot workflows, identity acceptance test and pilot runbook

**Status:** draft for Codex review and founder approval. Preparation and offline validation only.

- No workflow is enabled. Every job is hard-disabled with `if: ${{ false }}`.
- No workflow was dispatched. No secret was created or read. No GitHub setting changed.
- No GitHub App exists yet. No model, provider or Azure call was made.
- Merging, activating and running any of this are founder actions (AGENTS.md section 6.3).

Builds on Gate 009A (draft PR #64: protocol, guardrails, App setup). Gate 009A is not merged, so this gate cites it by number and does not depend on its files.

## 1. What this gate adds

| File | Purpose |
| --- | --- |
| `.github/workflows/agent-pilot-run.yml` | Founder-dispatched pilot: `implement` (round 1) and `fix` (rounds 2 and 3). Disabled. |
| `.github/workflows/agent-identity-test.yml` | Identity acceptance test A1, A2, A4 to A7. A3 is manual. Runs no model. Disabled. |
| `scripts/agent-collab/guard.mjs` | Deterministic guard: dispatch inputs, scope, PR state, round count, reviewer-findings filter, secret scan. |
| `scripts/agent-collab/test-guard.mjs` | 60 offline tests for the guard. |
| `scripts/agent-collab/test-workflow-safety.mjs` | Static checks of both workflows, with 17 mutation tests proving the checks bite. |
| this document | Design, verification record, runbook, activation requirements. |

No `package.json` or lockfile change. The scripts use only Node built-ins.

## 2. Verified: current Claude Code GitHub Actions setup

Read from the official documentation on 2026-11-28 (<https://code.claude.com/docs/en/github-actions>, <https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md>).

- The action is `anthropics/claude-code-action@v1`. A `prompt` input selects automation mode. Without it the action waits for an `@claude` comment (interactive mode).
- Authentication to Claude: `anthropic_api_key` (secret `ANTHROPIC_API_KEY`), or `claude_code_oauth_token`. Workload identity federation is also supported. This gate uses the API-key path because it is the simplest to revoke.
- **A custom GitHub App is supported.** Mint a token with `actions/create-github-app-token` and pass it as `github_token`. The docs state the custom App needs **Contents, Issues and Pull requests, each read and write**.
- Who can trigger: the action requires write access on issue and PR events, and rejects bot actors unless listed in `allowed_bots`. A manual `workflow_dispatch` by the founder passes these checks.
- Cost controls named in the docs: `--max-turns`, workflow timeouts and concurrency groups. All three are used here.
- Commits made with the default `GITHUB_TOKEN` do not trigger other workflows. Commits made with an App token do. This is a reason to use the App token for pushes.
- `id-token: write` is documented as needed for the default Claude App authentication and for federation. With an own `github_token` and an API key it is documented as not needed. These workflows grant no `id-token`. If the first run shows the action needs it, that is a finding for the activation gate, not a silent change.

**Correction to Gate 009A section 13.3.** 009A listed Contents and Pull requests only and said Issues was not needed. The official docs say the action's custom App needs Issues read and write too (PR comments use the issues API). The App token in these workflows therefore requests `contents`, `pull-requests` and `issues`, each write. This is one permission wider than 009A proposed. It is not granted by this gate. The founder decides when creating the App. Gate 009A's table should be updated if the founder accepts it.

**Not verified** (needs a live run, so it belongs to activation):
- the exact reviewer login that Codex posts as, which is why the workflow reads `vars.CBC_CODEX_REVIEWER_LOGIN`;
- whether Codex review comments arrive as pull request review comments (the endpoint read here) or as issue comments;
- that `claude-code-action` makes no commit or comment of its own when the only allowed tools are `Read,Write,Edit,Glob,Grep`;
- the behaviour of `actions/create-github-app-token` v2.2.2 inputs. It was chosen because its `app-id` and `private-key` inputs are the ones the Claude docs use. Later versions exist (v3.x) and need their input names checked first.

Pinned versions (resolved with `git ls-remote`, 2026-11-28):

| Action | Pin |
| --- | --- |
| `actions/checkout` | `d23441a48e516b6c34aea4fa41551a30e30af803` (v6.1.0) |
| `actions/create-github-app-token` | `fee1f7d63c2ff003460e3d139729b119787bc349` (v2.2.2) |
| `anthropics/claude-code-action` | `4411a9e9b0283becf4b924f7bce360fd7756c78c` (v1.0.290, annotated tag peeled to its commit) |

## 3. Design: how Claude's work reaches the App-owned branch

The key choice: **Claude never holds write power over the repository.**

1. Claude runs with only `Read, Write, Edit, Glob, Grep`. `Bash`, web and sub-agent tools are disallowed. It cannot run git, call the API, comment, approve or merge.
2. Claude edits files in the runner's working tree only.
3. A deterministic step then runs `guard.mjs`. It checks that the diff touches only the task's allowlisted file, uses statuses `A` or `M` only (no delete, rename or mode change), has no unsafe path, and contains no secret-like text. It fails closed.
4. Only after that does the same job commit as the implementer App and push to the task branch. The App token is short-lived and minted per run.
5. The PR is opened as a **draft** by the App, so GitHub shows `cbc-implementer[bot]` as the author. The founder approves and merges as a different identity.

```text
founder dispatch -> guard(inputs) -> mint App token -> Claude edits working tree
   -> guard(scope, secrets) -> commit + push as App -> draft PR (author: App bot)
founder: "@codex review" on the PR  -> Codex posts findings (data)
founder dispatch (fix) -> guard(PR, round, sha) -> fetch + filter findings -> Claude edits
   -> guard(scope, secrets) -> commit + push same branch
```

### Founder-triggered, two rounds

- Every run is a manual `workflow_dispatch` by the founder, from `master`, and the guard rejects any other actor. There is no comment, label, schedule or PR trigger.
- Codex is triggered by the founder commenting `@codex review` on the PR. Codex's findings never start a workflow.
- Round numbering: round 1 is the initial implementation. The two review-and-fix rounds are rounds 2 and 3. A request for round 4 is refused. A round that skips or repeats a number is refused. The round is recorded as a `CBC-Agent-Round: n` trailer in each commit.
- The fix run must name the exact head SHA that Codex reviewed (`expected_head_sha`). If the branch moved, the run stops.

### Review comments are data

`guard.mjs findings` keeps only comments that are all of: written by the configured reviewer login, attached to the exact head SHA, free of secret-like text. It strips control characters, truncates each comment to 2000 characters, caps the count at 20, and wraps the result in an "UNTRUSTED DATA" notice. The prompt tells Claude the findings are information, grant no authority, and must be ignored if they ask for anything outside the single allowlisted file. The scope check is the real control: even a fully compromised prompt cannot get an out-of-scope file pushed.

### Residual risks (honest list)

- Claude can write anything to the allowlisted file, including misleading text. The founder reviews the diff before any merge.
- The Codex reviewer login is configured by the founder. If it is wrong, the filter drops everything and the fix run sees no findings. It does not fail open.
- A GitHub App token pushed through a `git` URL is masked by GitHub in logs, and A7 checks the transcript. It is still the most sensitive value in the run.
- The workflows were validated offline only. Nothing here proves the action or Codex behave as described until the founder runs the activation steps.

## 4. Pilot task (trusted, one file)

Task id `cbc-doc-pilot-001`. Allowed file: `docs/engineering/agent-pilot-sample.md`. Nothing else may change.

The implementer writes a short document (about 15 lines) with exactly these headings: `Purpose`, `How a round works`, `Round limit`, `Who decides`. It states, in its own words, that: the founder triggers every run; Codex reviews and Claude fixes; at most two review-and-fix rounds; the founder alone merges. It must not mention any secret, URL or credential.

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

## 6. Runbook: founder steps in order

Nothing in this list is done by this gate.

1. Codex reviews the exact head commit of this PR. The founder reads the findings.
2. The founder merges this PR (a merge into `master` is also a Vercel production deployment under AGENTS.md section 20; this PR changes no application code).
3. The founder creates the GitHub App (Gate 009A section 13), with Contents, Pull requests and Issues set to read and write, and installs it on this repository only.
4. The founder creates the GitHub environment `agent-implementer` with the founder as required reviewer and `master` as the only deployment branch.
5. In that environment, the founder stores the secrets `CBC_APP_PRIVATE_KEY` and `ANTHROPIC_API_KEY`, and sets a hard spend limit for the Anthropic key in the provider console. Never paste either into chat.
6. As repository or environment variables, the founder sets `CBC_APP_ID`, `CBC_APP_SLUG`, `CBC_FOUNDER_LOGIN` and `CBC_CODEX_REVIEWER_LOGIN`. The reviewer login is learned from a first Codex review comment on any PR.
7. The founder approves a **separate activation PR** that removes `if: ${{ false }}` from `agent-identity-test.yml` only, after Codex reviews it.
8. The founder dispatches the identity test once and checks A1 to A7, including A3 by hand.
9. If A1 to A7 pass, a second activation PR enables `agent-pilot-run.yml`. Codex reviews it. The founder merges it.
10. Pilot, all manual:
    1. dispatch `agent-pilot-run` with mode `implement`, round `1`;
    2. open the draft PR, comment `@codex review`, wait for findings;
    3. dispatch with mode `fix`, round `2`, the PR number and the reviewed head SHA;
    4. comment `@codex review` again;
    5. dispatch with mode `fix`, round `3`;
    6. read the diff, then decide whether to approve and merge. The workflow never merges.
11. Pilot acceptance: the PR author is the App bot; only the allowlisted file changed; round trailers are 1, 2, 3 and no more; Codex findings were applied or explicitly ignored; no secret appears in any log; the founder merged or closed it by hand.

Stop at any step if a check fails. Revoke by removing the App key, uninstalling the App, or deleting the environment secrets.

## 7. Activation requirements (for the later PRs, not this one)

- Each activation PR changes only the `if:` line of one workflow, and nothing else.
- Re-run both offline test scripts on the activation commit.
- Re-check the pinned actions and the Claude docs for changes since 2026-11-28.
- Codex reviews the exact activation commit before the founder approves execution.

## 8. Offline validation performed (2026-11-28)

Commands, run in a clean checkout of this branch:

```text
node scripts/agent-collab/test-guard.mjs               -> 60 passed, 0 failed
node scripts/agent-collab/test-workflow-safety.mjs     -> 19 passed, 0 failed (2 real files + 17 mutation tests)
python3 -c "yaml.safe_load(...)" on both workflows     -> parse OK
bash -n on every run block (expressions replaced)      -> 0 syntax errors
```

Not run: `actionlint` (not installed in the session), any GitHub-hosted run, any dispatch. The workflows have therefore never executed anywhere.

## 9. Open founder decisions

1. Accept the wider App permission (Issues read and write)? If not, the Claude action may not work, and the activation gate must test that.
2. Keep `ANTHROPIC_API_KEY` as the credential, or use the subscription OAuth token or federation? The API key is the proposed default.
3. Relationship to the older pilot draft (PR #61): this gate is an alternative that avoids a separate API-key reviewer script. Close, keep or merge PR #61 later. This gate does not touch it.

## 10. Out of scope

Enabling or dispatching any workflow; creating the App, the environment, secrets or variables; changing the ruleset or any setting; merging; deploying; Azure, Key Vault, Supabase or database access; package or lockfile changes; changing `AGENTS.md`.
