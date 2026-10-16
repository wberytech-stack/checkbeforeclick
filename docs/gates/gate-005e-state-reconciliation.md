# Gate 005E - Automated Repository State Reconciliation

## Goal

Stop `.agents/state.yaml` from going stale after every merge into `master`.
This gate:

- reconciles the five Gate 005D entries that went stale when 005D merged
  (`998e6cc`);
- removes the root cause, a committed copy of `master`'s own SHA;
- adds a reconciler with tests;
- adds a GitHub Actions workflow that checks state consistency after every
  merge and can propose a **draft** housekeeping PR. It never pushes to
  `master`.

## Changed files

- `scripts/state-reconcile/reconcile.ts`: pure planning and application
  over a `yaml` Document and a read-only `GitView`.
- `scripts/state-reconcile/cli.ts`: `--check` and `--write`, read-only git,
  atomic write.
- `scripts/state-reconcile/test-reconcile.ts`, plus
  `scripts/state-reconcile/fixtures/*.yaml` (13 synthetic templates).
- `.github/workflows/state-reconcile.yml`: a `check` job (read-only) and a
  `propose` job (disabled by default).
- `.agents/state.yaml`: schema v4 migration and reconciliation (below).
- `docs/gates/gate-005e-state-reconciliation.md`

Not changed: `AGENTS.md`, application code, migrations, `package.json`,
the lockfile, env files, deploy configuration, and the orchestrator.

## Findings

1. **Corrupted evidence in `state.yaml`.** Five SHAs written without quotes
   were parsed as numbers, all as `Infinity`:
   - `98e3761` (PR #23);
   - `3e24285`, four times (PR #25, gate 003R evidence, and a `parents`
     entry).

   YAML reads `<digits>e<digits>` as scientific notation. All SHA fields are
   now quoted. The reconciler rejects any SHA field that is not a string,
   with exit 2 (test R09).
2. **The self-referential `master` SHA.**
   `repository.integration_base.commit` could never be correct after a
   merge, because the merge creates a new commit that the file cannot name
   inside itself. It is removed. The field `commit_source` now states that
   the current `master` SHA is derived from git at read time and never
   stored. The reconciler removes any stored copy (test R12). Other stored
   SHAs, such as merge commits and branch heads, always refer to *earlier*
   commits, so they are not self-referential.

## `state.yaml` changes (schema 3 to 4)

- Schema bumped to 4, because the `integration_base` fields changed
  (AGENTS.md section 18).
- Every SHA value is quoted.
- One canonical formatting pass:
  - `yaml` library output with `lineWidth: 0` and
    `flowCollectionPadding: false`;
  - a comment on a list key moves to the next line;
  - flow maps lose their inner padding.

  This pass happens once. After it, parsing and re-serializing is
  byte-identical, which is what makes rewrites idempotent.
- The pre-gate file is preserved locally at
  `.git/cbc-evidence/state.yaml.pre-005e`.

The five stale Gate 005D entries were reconciled. Changes 1, 3 and 5 below
were made by `cli.ts --write` against `origin`. Changes 2 and 4 were made by
hand during the schema v4 migration.

| # | Stale entry (on `master@998e6cc`) | Reconciled to | Evidence |
| --- | --- | --- | --- |
| 1 | `repository.integration_base.commit: cbddac265ae2…` | Removed; `commit_source: derived …` | `git rev-parse origin/master` is `998e6cc…` and changes with every merge |
| 2 | `integration_base` evidence line `"… == cbddac2 after fetch"` | Removed with the stored SHA | Same as above |
| 3 | `unmerged_gate_branches`: `gate-005d-reviewer-adapter-design` | Moved to `merged_branches_on_master`: `branch_head "8946c2b"`, `merge_commit "998e6ccb1e80b6c2549e2d5b804dfab6052f1b3d"`, `parents ["cbddac2", "8946c2b"]` | `998e6cc^1 = cbddac2`, `998e6cc^2 = 8946c2b`; `998e6cc` is on `master`'s first-parent history; `merge-base --is-ancestor 8946c2b origin/master` |
| 4 | `unmerged_gate_branches` comment naming `(cbddac2)` | Comment no longer names a SHA | Same root cause as 1 |
| 5 | `gates."005D".status: in_progress_this_branch` | `merged`, `merge_commit "998e6cc"`, commit evidence added | The same merge commit |

This gate's own entries were added in the usual way: `gates."005E"` is
`in_progress_this_branch`, and its branch is listed as unmerged. After 005E
merges, the workflow's `check` job reports exactly those two entries as
stale. That is the intended self-test.

## Reconciler design

Rules, all read-only against git (`refs/remotes/origin/` by default):

- **Unmerged entry with a recorded `commit`:**
  - If the commit is not in the clone, it is unmerged. Every commit
    reachable from `master` is present in a full clone, so a missing commit
    cannot be merged.
  - If the commit is present but not an ancestor of `master`, it is
    unmerged.
  - The recorded commit wins over the branch tip. For example,
    `gate-003r-runtime-smoke-validation` has tip `f25a02b` on `origin`, which
    *is* in `master` (PR #25). Its recorded commit `7ec9019` is not, so the
    branch correctly stays unmerged (test R03).
- **Unmerged entry without a recorded commit:** `<prefix><branch>` is used.
  If that ref is missing, the run fails as ambiguous (test R06).
- **Target is in `master`:** exactly **one** commit on `master`'s
  first-parent history must have the target as a non-first parent.
  - Zero such commits (fast-forward, squash or indirect merge) is ambiguous
    (test R04).
  - More than one is ambiguous (test R05).
  - When exactly one is found, the entry moves to the merged list with the
    full merge SHA and short head and parent SHAs.
- **Gates:** a gate that is not merged, whose evidence names exactly one
  merged branch, becomes `merged`. Naming two merged branches is ambiguous
  (test R13).
- **Consistency of existing merged records:** each `merge_commit` must be on
  `master`'s first-parent history and must merge its `branch_head`
  (test R10).
- **Structure:** a duplicate branch across the two lists (test R11), a
  wrong schema (test R08) or invalid YAML (test R07) is exit 2.
- **Fail-closed:** any error means exit 2 and **no change** to the file, in
  `--check` and `--write` alike (tests R04–R11 and R13 compare bytes).
- **Deterministic:** a reconciled `verified_at` is the merge commit's
  committer date (`git show -s --format=%cs`), not the clock. The same git
  state therefore always yields the same bytes (test R16). Line endings are
  preserved (test R15). A second `--write` changes nothing (tests R02, R12
  and R14).

Exit codes:

- `0`: consistent, or the file was written;
- `1`: `--check` found stale state;
- `2`: invalid, ambiguous, or an environment error.

## Execution model (review fix: lockfile-backed, no fetched runner)

The first version of this gate ran the scripts with
`npx --yes tsx@4.23.0`. `tsx` is **not** in `package-lock.json`, so every CI
run would have downloaded and executed a package from the npm registry
without the lockfile's integrity check. This is now replaced:

- **Runner:** `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON <script>.ts`,
  using Node's built-in TypeScript type stripping.
  - The scripts already use only erasable TypeScript syntax.
  - Relative imports now name the `.ts` file (`./reconcile.ts`,
    `./orchestrator.ts`). Those are the only code changes, one line in
    each CLI.
- **Pinned runtime:** CI uses `actions/setup-node` with
  `node-version: "24.14.0"`, the same version used for local validation.
  Locally, Node 22.18 or later is required.
- **Packages:** `npm ci --ignore-scripts` installs exactly the lockfile. The
  `yaml` parser comes from there; it is still a transitive dependency, as
  before.
- **No `package.json` or `package-lock.json` change.** The flag only
  silences Node's notice that the root `package.json` has no `"type"`
  field. Adding `"type": "module"` would be a `package.json` change, so it
  was not made.
- **Rejected alternative:** compiling with the lockfile's `typescript`
  (`tsc`). It works, but adds a build step and changes test paths, for no
  security gain over the built-in runner.
- **Validation after the change** (Node v24.14.0, no `tsx`):
  - reconciler tests: 16 passed, 0 failed;
  - orchestrator tests: 21 passed, 0 failed;
  - real `cli.ts --check` against `origin`: `consistent`, with empty
    stderr;
  - no warnings;
  - strict `tsc --erasableSyntaxOnly --allowImportingTsExtensions`
    (nodenext) passes on all six scripts, which confirms they stay within
    what Node can run natively.

## Workflow (`.github/workflows/state-reconcile.yml`)

- **Triggers:** `push` to `master` (every completed merge) and
  `workflow_dispatch`. There is **no** `pull_request` trigger, so nothing
  runs from gate branches or PRs.
- **`check`:** `permissions: contents: read`.
  - Fetches all branch refs.
  - Runs `npm ci --ignore-scripts` (the lockfile; no dependency change).
  - Runs the reconciler tests and the orchestrator tests, then
    `cli.ts --check`, all with `node` on the pinned runtime (see
    "Execution model").
  - Results: `consistent` is OK. `stale` is a warning annotation.
    Ambiguous or invalid **fails the job**, and nothing is proposed.
  - The JSON report is uploaded as an artifact.
- **`propose`:** runs only when **all** of these hold: the check result is
  `stale`, `vars.CBC_STATE_RECONCILE_PR == 'enabled'`, and the ref is
  `master`. Job-scoped permissions are `contents: write` and
  `pull-requests: write`. It:
  - checks out the exact pushed `master` SHA and runs `--write`;
  - aborts if anything other than `.agents/state.yaml` changed;
  - names the branch `automation/state-reconcile/<git hash-object of the
    reconciled file, 12 chars>`;
  - stops with "already proposed" if that branch exists on `origin`
    (idempotent across re-runs and unrelated `master` pushes);
  - otherwise commits as `github-actions[bot]`, pushes **only** that branch
    without force, and runs `gh pr create --draft`.

  It never pushes `master`, merges, approves, marks a PR ready,
  force-pushes, or deletes anything.
- **Loop prevention:**
  - The reconciled file never stores `master`'s SHA.
  - Housekeeping branches are not tracked in `state.yaml`.
  - So merging a housekeeping PR leads to `consistent` on the next run, and
    nothing more is proposed.
  - Additionally, `check` skips runs triggered by `github-actions[bot]`;
    `concurrency` serializes runs; and PRs created with `GITHUB_TOKEN` do not
    trigger further workflow runs.

## Validation (2026-10-16)

```text
PASS: R01 consistent state -> exit 0, no changes
PASS: R02 merge detection: --no-ff merge found, entry moved, gate updated; repeat run is a no-op
PASS: R03 recorded local-only commit absent from repo, and recorded commit ahead of a merged tip -> both stay unmerged
PASS: R04 fast-forward merge (no merge commit) -> ambiguous, nothing written
PASS: R05 two merge commits on master merge the same head -> ambiguous, nothing written
PASS: R06 branch without recorded commit is missing -> ambiguous, nothing written
PASS: R07 invalid YAML -> exit 2, nothing written
PASS: R08 wrong schema_version -> exit 2, nothing written
PASS: R09 unquoted SHA parsed as a number (3e24285 -> Infinity) -> exit 2, nothing written
PASS: R10 merged record whose merge_commit does not merge branch_head -> exit 2
PASS: R11 branch listed as both merged and unmerged -> exit 2
PASS: R12 stored master SHA -> stale; write derives it; repeat is consistent
PASS: R13 gate evidence naming two merged branches -> ambiguous, nothing written
PASS: R14 non-canonical formatting only -> stale; write canonicalizes; repeat is a no-op
PASS: R16 verified_at defaults to the merge commit date, so output is deterministic
PASS: R15 CRLF line endings preserved on write
=== Gate 005E state reconcile: 16 passed, 0 failed ===
```

- The tests build a throwaway git repository in the OS temp directory. It
  contains real `--no-ff` merges, a fast-forward, a double merge created
  with `commit-tree`, and a commit reachable only from a side branch. The
  repository uses an isolated, empty git config. Nothing touches the real
  repository.
- On real `origin` before the write, `cli.ts --check` reported `stale`
  (exit 1) with changes 1, 3 and 5 above. After `--write`, it reported
  `consistent` (exit 0). A second `--write` with a different `--date` left
  the file byte-identical (same sha256).
- Strict `tsc` on the three scripts passed. `npm run build`,
  `git diff --check`, and YAML parsing of `.agents/*.yaml` and the
  workflow also passed (see the checkpoint).

Not exercised:

- The workflow has not run on GitHub. It starts running only once merged
  into `master`.
- `gh pr create` from Actions has not run.
- Whether the repository allows Actions to create PRs has not been checked.

## Squash-merge compatibility (review fix after PRs #29 and #30)

### What the review found

`master` now contains two kinds of GitHub merge:

- PR #29: `03ace4a`, a **squash** commit with a single parent.
- PR #30: `7e27d04`, a **merge commit** with parents `03ace4a` and `1b22624`.

The first version of this gate was replayed against that real history in a
throwaway clone:

- **Merge commits:** handled correctly.
- **Squash merges:** missed silently. Gate 003T stayed "unmerged, local only"
  while the check reported `consistent`. A squash merge of PR #26 itself would
  also have stayed "in progress" forever.
- **Squash, then branch deleted:** failed closed with "cannot decide".

The tool never wrongly marked a branch as merged. The failure was a silent
false negative.

### The fix (fail-closed; never automatic attribution)

1. **Squash detection.** For an unmerged entry whose commit exists but is not
   an ancestor of `master`:
   - the reconciler computes `git patch-id --stable` of the branch's own
     changes (`merge-base..target`);
   - it compares that with every single-parent commit on `master`'s
     first-parent history since the merge-base.

   A match is reported as an **error**, with exit 2 and nothing written: "…
   appears squash-merged into master as `<sha>` … record it with
   `merge_method: squash`". It is **never** recorded automatically, because
   identical patches are evidence, not proof of which PR landed.
2. **Explicit squash records.** A `merged_branches_on_master` entry with
   `merge_method: "squash"` is accepted as consistent only when all of these
   hold:
   - `merge_commit` is on `master`'s first-parent history;
   - it has exactly one parent;
   - `branch_head` is **not** in `master`'s history;
   - the patch-id of `merge_commit^..merge_commit` equals the patch-id of
     `merge-base(branch_head, merge_commit^)..branch_head`.

   Anything else, including an unknown `merge_method`, is exit 2.
3. **PR heads stay fetchable.** Both workflow jobs also fetch
   `refs/pull/*/head` (read-only), so a squash record can still be verified
   after its branch is deleted.
4. **`state.yaml` brought up to date** (explicit, verified records):
   - 003T is recorded as a squash merge: `merge_commit` `03ace4a`,
     `branch_head` `291d81f` (`refs/pull/29/head`);
   - 006A is recorded as merged via `7e27d04`;
   - PRs #29 and #30 are added to `merged_prs_on_master`;
   - gates `003T` and `006A` are set to merged;
   - the agent-framework note records `AGENTS.md` section 20;
   - the fast-scan HTTP 500 blocker is marked **resolved** (kept as
     history);
   - the TLS blocker evidence is re-pointed at `master@7e27d04`.
5. **Tests:**
   - **R17 and R18:** squash detected, through both the branch-head and
     recorded-commit paths. Exit 2, and the file is unchanged.
   - **R19:** a verified squash record is consistent.
   - **R20:** a squash record pointing at an unrelated commit gives a
     patch-id mismatch, exit 2.
   - **R21:** an unknown `merge_method` gives exit 2.
   - **R22:** a GitHub-style merge commit landing after a squash is
     attributed, its gate is updated, and a repeat run is a no-op.

### Remaining limits

- A squash that needed conflict resolution, or that was combined with other
  changes, will not match by patch-id. It stays "unmerged" silently, which is
  the same safe direction as before. Recording it is a manual, founder-reviewed
  `state.yaml` change.
- A rebase merge (a linear replay) also does not match. It is treated the
  same way.

## Limitations

- **Merge style:** merges attribute automatically in two cases:
  - merge commits (local `--no-ff` or GitHub "Create a merge commit");
  - **explicitly recorded** squash merges (`merge_method: squash`), verified
    by patch-id.

  Other cases:
  - **Unrecorded squash merges:** detected, and they fail closed until
    recorded.
  - **Fast-forwards:** ambiguous, and they fail closed.
  - **Squash merges with changed content, and rebase merges:** not detected;
    they stay "unmerged" (see "Remaining limits" above).
- **Deleted branches:** a branch deleted before reconciliation, with no
  recorded `commit`, is ambiguous.
- **Several open PRs:** if `state.yaml` becomes stale in a new way while an
  earlier housekeeping PR is still open, a second draft PR is proposed,
  because the content hash differs. Closing superseded PRs and deleting
  `automation/*` branches is founder-only.
- **Dependency:** the `yaml` package is still only a transitive dependency
  (open since Gate 005A).
- **Action versions:** actions are pinned to major tags (`@v4`), not commit
  SHAs.

## Governance conflicts and founder decisions (nothing bypassed)

The constitution does not authorize the automated **write** path, so
`propose` ships disabled. Only the read-only `check` job runs after merge.

1. **A new automated actor (AGENTS.md section 6.2).** Delegated pushes and
   draft PRs are granted only to Claude Code. A GitHub Actions bot pushing
   `automation/state-reconcile/*` branches and opening draft PRs needs a
   section 19 amendment that names the bot, its branch prefix, and
   "draft PR only".
2. **Section 16 says `state.yaml` is "updated within a gate".** Automated
   housekeeping PRs happen outside a gate. The amendment should define them,
   for example as founder-reviewed housekeeping that is exempt from the gate
   process but never merged automatically.
3. **Enabling the write path is a configuration change (section 6.3,
   founder-only).** It requires both:
   - setting the repository variable `CBC_STATE_RECONCILE_PR=enabled`;
   - allowing GitHub Actions to create pull requests in the repository
     settings.
4. **`GITHUB_TOKEN` (section 11).** The `propose` job uses the ephemeral,
   job-scoped `GITHUB_TOKEN` inside GitHub's runner. No agent reads it and
   no secret is created. Please confirm that section 11 is not engaged, or
   cover it in the amendment.
5. **Merge-method policy.** PR #29 was squash-merged, and PR #30 used a merge
   commit. Merge commits reconcile automatically. Squash merges now need an
   explicit, verified `state.yaml` record. Restricting the repository to
   merge commits only is a founder-only settings change.
6. **Housekeeping cleanup.** Closing superseded PRs and deleting
   `automation/*` branches is founder-only.
7. **Optional:** pin actions to commit SHAs, and make `yaml` a direct
   devDependency.

What merging this gate itself enables: the read-only `check` workflow, on
every push to `master`. Nothing that writes runs until decisions 1–3 are
made.

## Out of scope

- `AGENTS.md` changes.
- Pushing to `master`, auto-merge, auto-approve.
- Production, Azure, Key Vault, database, migration, dependency,
  credential, or deployment changes.
