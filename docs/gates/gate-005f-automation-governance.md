# Gate 005F - Automation Governance and Founder Decision Record

## Status

This is a docs-only gate. It amends `AGENTS.md` (section 19) and records the
founder's decisions for the automated Claude Code / reviewer loop.

Nothing in this gate changes:

- application code, workflows, or dependencies;
- credentials, secrets, or repository, GitHub, Vercel, or OpenAI settings.

No API call is made.

Every automation capability described here stays **inactive** until the
founder completes the configuration steps in section 8 **and** a later
implementation gate (005G) lands the code.

**Base:** `master@998e6cc`. PR #26 (Gate 005E, `c2809a7`) is open and
**not** assumed merged or approved.

## 1. Decision record

| # | Decision | Founder decision (Gate 005F) |
| --- | --- | --- |
| D1 | Reviewer credential | Exactly one key, `CBC_REVIEWER_API_KEY`, stored as a GitHub Actions secret in an Environment restricted to `master`. It is consumed only by the reviewer step and never exists on a developer machine (`AGENTS.md` section 11) |
| D2 | Execution environment | **GitHub Actions**, using workflows defined on `master` only (section 5) |
| D3 | Review transport | **The Gate 005D review-file contract**, delivered on an append-only orphan branch, `automation/reviews`, and mirrored as an Actions artifact for audit. **No git notes.** See section 2 |
| D4 | Reviewer identity | An **explicitly approved OpenAI API model** operating under the ChatGPT reviewer policy (`.agents/chatgpt.md`). It is not an interactive ChatGPT session. A validated automated review may only issue section 6.4 in-gate work directives inside an already founder-approved gate, and has no authority outside that scope. Its exact model ID is recorded before live activation (section 3) |
| D5 | Cost and rounds | A **$20 monthly spending target**, not a guaranteed cap. At most **3 review rounds per gate**, **1 model call per commit**, and bounded input and output tokens. A workflow-level stop fails closed whenever the allowance cannot be verified (section 4) |
| D6 | Data egress | Only the Gate 005D evidence (request, policy text, diff, changed text files), after the forbidden-path and secret-suspect checks pass. Before activation, the founder confirms the OpenAI project's data-retention terms |
| D7 | Automation actor | `github-actions[bot]` under `AGENTS.md` section 6.6. It may write only `automation/reviews` and `automation/state-reconcile/*`, and open draft PRs. It never merges, marks ready, approves, deletes, force-pushes, or deploys |
| D8 | Draft PRs | Opened by the automation actor from a **scheduled** workflow on `master`, not from a branch-triggered workflow (section 5) |
| D9 | Vercel | A safe deployment policy is **designed here and tested before** any automated correction loop is enabled. No Vercel setting is changed by this gate, and no preview is assumed harmless (section 6) |
| D10 | Merge method | `--no-ff` merge commits into `master` only. Approving a merge also approves the automatic Vercel production deployment it causes, and nothing else (section 6.1) |
| D11 | Review-file tracking | Consistent with D3: `.agents/chatgpt-review.yaml` stays a tracked **template** on `master`, never modified by agents or the bot. Delivered reviews are read from `automation/reviews` into local, uncommitted `.agents/outbox/` files |
| D12 | Alternate-base gates | Manual review only (Gate 005D section 10a) |
| D13 | `yaml` package | Becomes a direct devDependency in Gate 005G, as a founder-approved dependency change in that gate |

All other founder-only rules are unchanged: merging, production
deployments, secret provisioning, and configuration changes. There is no
automatic approval or merging. Secret scanning and review validation fail
closed.

## 2. Review transport (D3) and how Claude receives reviews automatically

### 2.1 Mechanism

The **`automation/reviews`** branch is an orphan branch: it shares no
history with `master` and is never merged. The automation actor only
appends to it, and never force-pushes. Its layout:

```text
reviews/<gate>/<head_sha>/review-request.json   (the request the workflow built; see 7.2)
reviews/<gate>/<head_sha>/adapter-result.json   (always; Gate 005D AdapterResult, no secrets)
reviews/<gate>/<head_sha>/chatgpt-review.yaml   (only when state == review_written; schema v3)
ledger/<YYYY-MM>.jsonl                          (one line per model call; see section 4)
```

The same three review files are also uploaded as the run's Actions artifact
`cbc-review-<gate>-<head_sha>`, which gives an audit copy tied to the run log.

### 2.2 Why this mechanism

- It keeps the exact Gate 005D file contract, which the founder preferred.
- Claude can fetch it with **plain `git`** over the existing remote. That
  needs no GitHub CLI, no API token, and no new credential on the developer
  machine.
- Downloading Actions artifacts directly requires an authenticated GitHub
  API call, which would put a token on the developer machine and run into
  section 11. Artifacts are therefore the **audit** copy, and the review
  branch is the **delivery** path.
- It is auditable: every review, rejection, and ledger entry is a commit on
  the review branch, and each run log links the artifact.
- It has no self-reference: entries are keyed by the reviewed head SHA, and
  that branch never becomes part of the gate's own history.

### 2.3 How Claude receives a review (no copy and paste)

A **loop runner** script, delivered in Gate 005G and run by Claude Code in
its session, works like this:

1. Claude pushes gate head `H` (delegated, section 6.2), with its readiness
   signal (see 7.2).
2. The runner waits, with a bounded timeout (default 20 minutes), by running
   `git fetch origin automation/reviews` about every 60 seconds until
   `reviews/<gate>/<H>/adapter-result.json` exists.
3. **Rejected** (any Gate 005D rejection code), **budget stop**, **round
   limit**, or **timeout**: the result is `founder_action_required`, and
   the loop stops for the founder.
4. **Review written:** the runner copies `chatgpt-review.yaml` to
   `.agents/outbox/reviews/<H>/chatgpt-review.yaml` and runs the Gate 005A
   orchestrator with `--review` set to that path. The tracked template is
   never touched.
5. **`changes_requested`:** the orchestrator's `claude-work-request.json`
   contains only in-scope, non-founder items. Claude implements them,
   reruns the gate validation, commits, and pushes `H2`, which starts the
   next round (section 6.4).
6. **`founder_action_required`** (an approval recommendation, an escalated
   item, or a reject) stops the loop. Claude reports at a checkpoint.

## 3. Reviewer identity (D4)

- The reviewer is an OpenAI API model that the founder explicitly approved.
  It operates under `.agents/chatgpt.md` and the `AGENTS.md` hard rules
  read at `policy_commit` (Gate 005D R1).
- It is **not** an interactive ChatGPT session. Its output is accepted only
  through Gate 005D validation.
- A validated automated review may only issue section 6.4 in-gate work
  directives (`required_changes`), strictly inside a gate the founder has
  already approved. It has no authority outside that scope: it cannot
  approve, authorize, start, or expand anything, and its recommendation
  always ends at `founder_action_required`.
- **The exact model ID** must be recorded before live activation. That
  happens in a docs-only gate, in the committed automation config
  (section 7.3, field `reviewer.model_id`).
- Two independent controls must agree, or the workflow fails closed:
  1. the committed `reviewer.model_id` at `policy_commit`;
  2. the repository variable `CBC_REVIEWER_MODEL`.

  An alias or empty value is rejected. Only an exact, dated identifier as
  published by OpenAI is accepted.

## 4. Spend and round controls (D5)

The OpenAI project budget is a **spending target with alerts**, not a
guaranteed hard cap. Enforcement happens in the workflow itself.

- **Allowance:** `CBC_REVIEW_MONTHLY_ALLOWANCE_USD = 20`, a repository
  variable that must equal the committed config value.
- **Pricing:** a committed per-model price table (input and output USD per
  token) lives in the automation config at `policy_commit`.
- **Ledger:** `automation/reviews:ledger/<YYYY-MM>.jsonl`. It has one line
  per call, recording run ID, gate, head, model, `usage` tokens as reported
  by the API, and the computed cost. If `usage` is missing, the worst-case
  cost is recorded.
- **Pre-call stop,** checked inside a global `concurrency` group so two runs
  cannot both spend:
  - `month_to_date + worst_case(next call) <= allowance`, where
    `worst_case = max_input_tokens × input_price + max_output_tokens × output_price`;
  - if that fails: **no call**. The result is `founder_action_required`
    with the code `E_BUDGET_STOP`.
- **Fail closed (no call)** whenever the allowance cannot be verified:
  - the ledger branch is missing or cannot be fetched;
  - a ledger line is malformed;
  - the price table has no entry for the approved model;
  - the variable and the committed allowance disagree;
  - the clock or month cannot be determined.
- **Token bounds** (defaults, in the committed config):
  - `max_input_tokens = 60000`, checked **before** the call with a
    conservative estimate of `ceil(bytes / 3)` over the full reviewer input.
    Over the bound means `E_EVIDENCE_TOO_LARGE`, never truncation.
  - `max_output_tokens = 8000`, sent as the API's output limit. A
    truncated or incomplete response is `E_RESPONSE_INCOMPLETE`.
- **One call per commit:** if `reviews/<gate>/<head>/adapter-result.json`
  already exists, no call is made.
- **Three rounds per gate:** if `reviews/<gate>/` already holds 3 head
  directories with a model call, no call is made. The result is
  `founder_action_required` with `E_ROUND_LIMIT`.
- **Kill switch:** if `CBC_REVIEWER_ENABLED` is not exactly `enabled`, no
  call is made.
- **Secondary safeguard:** the founder sets the OpenAI project's monthly
  budget alert or limit to $20. It is treated as a backstop, not as the
  enforcement mechanism.

## 5. Workflow security requirements (for Gate 005G)

These requirements follow from D1, D2, and D7:

- **Never run secret-bearing jobs from a branch-defined workflow.** A
  workflow triggered by `push` on a gate branch runs that branch's version
  of the workflow file, so a branch could edit it to exfiltrate the key.
  - The review workflow therefore uses `pull_request_target`
    (`opened`, `synchronize`, `reopened`), which runs the workflow as it is
    defined on `master`, plus `schedule`, which also runs from `master`.
  - It is limited to same-repository draft PRs from `gate-*` branches.
- **Never execute reviewed code.**
  - The job checks out `master` (policy and adapter code) and fetches the
    reviewed head **only as git objects**.
  - It does not check out the head into the workspace, and does not run
    `npm install` or any build or script from it.
- **Scope the secret.** `CBC_REVIEWER_API_KEY` lives in a GitHub
  Environment (`cbc-reviewer`) whose deployment branches are limited to
  `master`, and only the reviewer job references that Environment.
- **Least-privilege permissions per job:**
  - review: `contents: write` (append to `automation/reviews` only, with
    the target ref checked in code), `pull-requests: read`;
  - draft-PR sweep: `pull-requests: write`, `contents: read`.
- **First reviews.** PRs opened with `GITHUB_TOKEN` do not trigger
  `pull_request_target`. The scheduled sweep therefore also reviews ready
  heads that have no review yet. One call per commit still applies.

## 6. Vercel deployment policy (D9)

### 6.1 Merging is a production deployment

`docs/ENVIRONMENTS.md` (on `master`) records that **Vercel Production tracks
`master`** (checkbeforeclick.com), and that Preview builds use the staging
Supabase project, the staging service-role key, an Inngest branch
environment, and the shared production-quota Anthropic and Google keys.
Therefore:

- **Every founder-approved merge into `master` causes an automatic Vercel
  production deployment,** including docs-only and script-only merges.
- Under `AGENTS.md` sections 3, 6.3, and 8, approving a merge into
  `master` **also approves that automatic deployment**, and the approval
  must acknowledge it.
- It approves **nothing else**. Manual deploys, redeploys, promotions,
  rollbacks, production configuration changes, and any production, Azure,
  or Key Vault access each still need separate founder approval.
- **Unverified:** agents have no Vercel access, so it is unverified whether
  the earlier merges (`e1356b0`, `b2df476`, `cbddac2`, `998e6cc`) produced
  production deployments. If they did, each redeployed `master`'s
  application code, which still contains the unresolved fast-scan route
  issue from Gate 003R. The founder can confirm this in the Vercel
  dashboard.

### 6.2 Agent pushes and previews

- Agent pushes to gate branches, this gate's branch included, **may** have
  created Preview deployments. That is unverified.
- A preview of unreviewed branch code runs with staging secrets and
  production-quota API keys. It is **not** assumed harmless.
- An automated correction loop would multiply such pushes.

### 6.3 Proposed policy (designed here; applied only by the founder later)

| Branch or ref | Vercel behavior |
| --- | --- |
| `master` | Production builds. Optional, founder decision: skip the build when a commit changes only `docs/**`, `.agents/**`, `scripts/**`, or `.github/**`, leaving production on its previous build |
| `gate-*`, `docs/*`, `automation/*` (including `automation/reviews`) | **No deployment** |
| `preview/*` (founder-designated) | Preview builds, for deliberate human testing only |

How to apply it: either the Vercel project's Ignored Build Step setting or
a `vercel.json` `git.deploymentEnabled` map. Either one is a deploy
configuration change, which is founder-only (section 6.3). Note that Vercel
reads `vercel.json` from the branch being built, so committing that file on
any branch is itself a deploy-configuration change.

### 6.4 Test plan (before any automated correction loop is enabled)

1. The founder applies the policy.
2. The founder pushes a throwaway `gate-999z-vercel-policy-test` branch.
   Expected: no deployment in Vercel.
3. The founder pushes `automation/vercel-policy-test`. Expected: no
   deployment.
4. The founder pushes `preview/vercel-policy-test`. Expected: one Preview
   deployment.
5. Production is unchanged throughout.
6. The founder records the date and the evidence, as a Vercel deployment
   list screenshot or export, in the decision record through a docs gate,
   and sets the repository variable
   `CBC_VERCEL_POLICY_VERIFIED=verified-YYYY-MM-DD`.

The review workflow (005G) must refuse to call the model unless that
variable is set (`E_VERCEL_POLICY_UNVERIFIED`). This makes the
`AGENTS.md` section 6.6 precondition enforceable rather than procedural.

## 7. Compatibility plan with the Gate 005D reviewer-adapter design

### 7.1 What stays unchanged from 005D

- The review-file contract: `.agents/chatgpt-review.yaml` schema v3, and the
  `founder_decision` template appended by the adapter and never authored by
  the model.
- Policy pinning to the verified `origin/master` (`policy_commit`), and the
  rule `base == merge-base(policy_commit, head)` (R1, R5).
- All 21 rejection codes, the evidence collection sequence, the
  forbidden-path list, and the pre-egress secret scan (R3).
- `ReviewerClient` as the only network component, and `adapter-result.json`
  provenance.

### 7.2 What changes or is added in Gate 005G

| 005D element | Gate 005G treatment |
| --- | --- |
| Adapter writes `.agents/chatgpt-review.yaml` (section 7) | In CI, the workspace is a fresh `master` checkout, so the file is always the pristine template. The adapter writes there, then a separate **publish step** (not the adapter) appends `reviews/<gate>/<head>/…` to `automation/reviews`. The adapter itself still never pushes |
| Review-file lifecycle and older-head preservation (section 7.2) | History is kept naturally on the review branch, keyed by head SHA. Locally, the loop runner copies into `.agents/outbox/reviews/<head>/`. The tracked template is never modified (D11) |
| `E_REVIEW_EXISTS` | Becomes the one-call-per-commit check against the review branch, checked before the model call |
| New codes | `E_BUDGET_STOP`, `E_ROUND_LIMIT`, `E_MODEL_NOT_APPROVED` (variable and config disagree, or the ID is not exact), `E_VERCEL_POLICY_UNVERIFIED`, `E_REVIEWER_DISABLED`. All mean no call and `founder_action_required` |
| Input: `review-request.json` produced by the local orchestrator from the local handoff | **Readiness must be verifiable from the repository without self-reference.** Gate 005G defines handoff **schema v5**, committed on the gate branch with `status: ready_for_review` and **no `head_commit` field**. CI builds the request from git (`head` = the PR head SHA; `base` = merge-base with `policy_commit`; changed files from git) plus the committed v5 handoff, then runs the unchanged 005A validation over it. Summary and validation claims stay untrusted (005D section 6) |
| Model ID and limits | Read from a committed automation config at `policy_commit` (see 7.3) and cross-checked against repository variables |
| Gate 005A orchestrator | Unchanged contract. The loop runner calls it with `--review <outbox path>`. Gate 005G adds a fixture test proving that a CI-delivered review drives `changes_requested` and `founder_action_required` correctly |
| `.gitignore` | Gate 005G adds `.agents/outbox/` so delivered reviews never appear as working-tree changes |

### 7.3 The committed automation config (to be created in 005G with the model unset)

The config lives at `.agents/automation.yaml`, schema v1, and is changed
only through docs-only, founder-approved gates:

```yaml
reviewer:
  model_id: ""                 # MUST be set to an exact approved ID before activation; "" means E_MODEL_NOT_APPROVED
  max_input_tokens: 60000
  max_output_tokens: 8000
  max_rounds_per_gate: 3
budget:
  monthly_allowance_usd: 20
  prices_usd_per_million_tokens: {}   # { "<model_id>": { input: <n>, output: <n> } }; a missing entry fails closed
transport:
  review_branch: automation/reviews
```

## 8. Founder configuration steps before Gate 005G may make live API calls

These are all founder-only (`AGENTS.md` section 6.3), and none is
performed in this gate. They are listed in order:

1. **Merge Gate 005F**, so the amendments take effect. This merge is a
   Vercel production deployment (section 6.1).
2. **Decide on PR #26** (Gate 005E). Merging it is recommended before
   005G, since 005G reuses its bot and reconciler patterns. That merge is
   also a production deployment.
3. **Merge Gate 005G** after review. It is code with live calls disabled.
4. **OpenAI:**
   - create a dedicated project (for example `cbc-reviewer`);
   - set a $20 monthly budget alert or limit as a backstop;
   - confirm the project's data-retention terms;
   - create one project API key.
5. **Record the model ID.** Run a docs-only gate setting
   `.agents/automation.yaml` `reviewer.model_id` to the exact approved ID,
   with its price-table entry.
6. **GitHub, secret:** create the Environment `cbc-reviewer`, with
   deployment branches limited to `master`, and add the secret
   `CBC_REVIEWER_API_KEY` to it.
7. **GitHub, settings:**
   - allow GitHub Actions to create pull requests (needed for draft PRs);
   - add branch protection on `master`: require a PR, require the
     founder's review, block force-pushes and deletion;
   - ensure the bot cannot approve or merge.
8. **GitHub, variables:**
   - `CBC_REVIEWER_MODEL=<exact ID>`;
   - `CBC_REVIEW_MONTHLY_ALLOWANCE_USD=20`;
   - `CBC_DRAFT_PR_ENABLED=enabled`;
   - optionally `CBC_STATE_RECONCILE_PR=enabled`.
9. **Vercel:** apply and verify the section 6 policy, then set
   `CBC_VERCEL_POLICY_VERIFIED=verified-YYYY-MM-DD`.
10. **Last step:** set `CBC_REVIEWER_ENABLED=enabled`. Live calls begin only
    when steps 3–9 all hold. The workflow re-checks each of them on every
    run.

## 9. Remaining gate sequence

- **Gate 005G (implementation, live calls disabled):**
  - the adapter per 005D, plus the section 7.2 changes;
  - a fixture `ReviewerClient` and tests for all rejection codes, including
    the new ones;
  - the review workflow (`pull_request_target` plus `schedule`, Environment
    scoped);
  - the publish step and ledger;
  - the scheduled draft-PR sweep;
  - the loop runner;
  - handoff schema v5;
  - `.agents/automation.yaml` with `model_id: ""`;
  - `yaml` as a direct devDependency;
  - the `.gitignore` entry for `.agents/outbox/`.
- **Gate 005H (live smoke, founder-enabled):**
  - one real review of a docs-only gate;
  - one deliberate `changes_requested` round, in which Claude corrects the
    change, re-pushes, and gets a re-review;
  - spend and ledger verified against the allowance;
  - after that, the loop is declared complete.

## 10. Deviation from the usual gate checklist

**`.agents/state.yaml` is intentionally not edited in this gate.** PR #26
rewrites that file (schema v4 migration). Any `state.yaml` edit here would
cause a certain merge conflict with #26. This gate's state entry is added
after #26's disposition, either by the 005E reconciler's check or by
Gate 005G. Under `AGENTS.md` section 1, repository evidence (this document
and git) governs in the meantime.

## Validation (this gate)

- The `.agents/*.yaml` files parse.
- `git diff --check`.
- `npm run build`. No application files changed.

## Out of scope

- Any code, workflow, dependency, credential, secret, or setting change.
- API calls.
- Vercel, GitHub, or OpenAI configuration.
- Merging PR #26.
