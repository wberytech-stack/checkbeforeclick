# Gate 005H - Codex Review Loop (Claude -> Codex -> Claude)

## Goal

Build a local loop that the founder runs. It freezes a gate's uncommitted changes and has Codex review them through
the existing verified runner. It parses the review strictly and hands any findings to a locked-down headless Claude
for fixes, for at most two fix rounds (three review rounds). Every step is archived with SHA-256 verification.

- **What it never does:** commit, push, merge, apply migrations, deploy, change cloud settings, or spend without the
  founder's typed approval.
- **Status:** founder-started on 2026-10-23 with the proposed brief.
  - Commits and pushes happen only after founder approval at Checkpoint 2.
  - The budget is at most 3 review rounds, with a Proof run in every round.
  - Work is done in a separate worktree from `origin/master`.
  - No model calls during the gate.

## Scope and constraints

- **Local tooling and docs only.** Nothing changes in application source, migrations, environment, packages, the
  lockfile, CI workflows or deploy configuration.
- **No model calls during the gate.** Every test uses fake Codex and fake Claude doubles.
- **The first live loop run is a separate founder approval.**
- **Desktop kit untouched.** The existing kit, its archives and the frozen input sets on the Desktop are not modified.
  The kit runner stays the historical record.

## Changed files

| File | Change |
| --- | --- |
| `scripts/review-loop/cbc-codex-trial.ps1` | Copy of the verified kit runner (SHA-256 `e8ad4692...`) with a new `Loop` target. `PR43` and `Gate007A` are unchanged. |
| `scripts/review-loop/review-parse.ps1` | New: strict review classifier that returns clean, findings or ambiguous |
| `scripts/review-loop/cbc-review-loop.ps1` | New: the founder-run loop state machine |
| `scripts/review-loop/loop-common.ps1` | New: process helper, read-only git wrapper, repository state, path guards |
| `scripts/review-loop/freeze.ps1` | New: freezes the repository's uncommitted changes |
| `scripts/review-loop/archive.ps1` | New: write-once archives, trial-path recognition and the guarded clear |
| `scripts/review-loop/verify-archive.ps1` | New: read-only re-hash of any archive, including the older `MANIFEST.md` ones |
| `scripts/review-loop/claude-fix-prompt.md` | New: the fixed prompt for the headless fix session |
| `scripts/review-loop/claude-settings.json` | New: deny rules and `disableAllHooks` for the headless session |
| `scripts/review-loop/gate-tests.json` | New: the local tests run after each fix, per gate (only `007A` so far) |
| `scripts/review-loop/tests/*` | Runner, parser and loop offline suites, fake Codex and fake Claude, offline entries, parser fixtures |
| `docs/gates/gate-005h-codex-review-loop.md` | This document |
| `.agents/state.yaml`, `.agents/claude-handoff.yaml` | Gate state and checkpoint handoff |

## Design

### Runner `Loop` target (Checkpoint 1)

`-Target Loop -InputManifestSha256 <64 hex> -InputBaseSha <40 hex>` freezes from `inputs\loop-current`. The manifest is
the file list. It is accepted only when every guard below holds:

- the base equals the working repository's HEAD, and the base exists on origin (the clone checks it out);
- the manifest equals the repository's uncommitted changes exactly. The fixed exclusion `.agents/claude-handoff.yaml`
  is not frozen. Deletions, renames and quoted paths are refused;
- every path is a safe relative path, with no `.` or `..` segments;
- no path is on the forbidden list:
  - environment files: `.env*`;
  - repository and build folders: `.git/`, `node_modules/`, `.next/`;
  - dependency files: `package.json`, `package-lock.json`;
  - key and credential files: `*.pem`, `*.key`, `*.pfx`, `*.p12`, `.npmrc`, `.pgpass`, `id_*`, `secrets.*`,
    `credentials*`;
  - agent configuration: `.claude/`, `.codex/`, `AGENTS.md`, `CLAUDE.md`;
- there are 1-40 files and no more than 2 MB in total.

Every other runner protection applies unchanged:

- the manifest-hash pin;
- freeze validity against the working repository;
- clone byte checks;
- integrity snapshots, which also hash every frozen working-repository file;
- Proof before Review, by the same runner hash, base and manifest;
- the operating-system sandbox probes and canaries;
- fail-closed exit codes.

### Review parser

`review-parse.ps1` reads one passed Review: `report-Review.md`, `review.md` and `review-events.jsonl`.

- **What it checks:**
  - the runner's PASS header;
  - exactly one final agent message, and it equals `review.md`;
  - findings only in Codex's exact format: `- [P0-3] <title> <em dash> <path>:<line>[-<line>]`, each with an indented
    body, after a single `Review comment:` header;
  - every `[P<digit>` marker belongs to a parsed finding;
  - every finding path is inside the clone and in the frozen set;
  - a clean result has an explicit no-defects statement.
- **Anything else is ambiguous,** and an ambiguous result stops the loop.
- **Caveats** such as "not exercised" are recorded separately; they are not findings.

### Loop flow (`cbc-review-loop.ps1 -Gate <NNNX> [-MaxRounds 1..3]`)

1. **Refusals at start.** The loop refuses to run without an interactive console. It then pins copies of the runner,
   the parser, the helper scripts, the prompt, the settings and `gate-tests.json` into the session archive, and runs
   only those copies.
2. **Occupied trial paths.** These are cleared only when every file in them is byte-identical to an existing archive.
   This includes the run evidence, the canaries, the temp canary, the clone's `.next` files and frozen files, and the
   clone status. The founder must also type `CLEAR <run id>`.
3. **Freeze** the repository's changes with the same guards. The existing `inputs\loop-current` is replaced only if
   an identical copy is archived.
4. **Founder approval** of `APPROVE ROUND <n> <manifest prefix>`. The prompt shows the gate, round, base, branch,
   frozen files, manifest hash, pinned runner hash and the call budget.
5. **Runner Proof, then Review** (target `Loop`). A runner failure archives the evidence and stops the loop.
6. **Archive the round:** copies only, each SHA-256 verified. Then parse the review:
   - clean: the loop finishes;
   - ambiguous: the loop stops;
   - findings in the last round: the loop stops with the result `open-findings`.
7. **Fix round** with headless Claude (described below). After the fix:
   - the founder sees the fix summary, Claude's exact edits (`diff.patch`), and the test commands with a warning that
     they run unsandboxed;
   - the founder types `RUN TESTS <n> <diff.patch SHA-256 prefix>`. Until then no gate test has run, so code Claude
     edited has not executed;
   - the repository must still match the shown diff (HEAD, branch, refs, stashes, status and every file hash);
     otherwise nothing runs;
   - the gate's tests from `gate-tests.json` then run and must pass;
   - the next round starts at step 2, and its approval prompt repeats the fix summary with the test results.
8. **Final screen:** the result, the archive path and its `MANIFEST.sha256`, and the founder-only actions the loop
   cannot perform:
   - commit;
   - push;
   - draft PR;
   - merge, which is a Vercel production deployment while Vercel is live;
   - applying a migration;
   - deploying;
   - any cloud change.

### Headless Claude fix session

`claude.exe -p --output-format stream-json --verbose --input-format text --permission-mode dontAsk --setting-sources project --settings claude-settings.json --strict-mcp-config --mcp-config <empty> --no-session-persistence --disable-slash-commands --tools Read,Grep,Glob,Edit --allowedTools Read Grep Glob Edit(./<each frozen file>) --disallowedTools Bash Write NotebookEdit WebFetch WebSearch Task`

The prompt arrives on stdin.

- **Permissions:**
  - there is no `--bare` flag, so the founder's existing Claude Code sign-in is used and no API key is needed;
  - there is no Bash tool, so Claude cannot run commands; the loop runs the tests itself;
  - user and local settings are not loaded;
  - the project's `.claude/settings.json` must not contain `permissions`, `hooks`, `env`, `apiKeyHelper` or
    `statusLine`.
- **The prompt** marks the findings as untrusted data and lists the frozen files. It requires a JSON reply with one
  decision per finding: `fixed`, `rejected` or `founder_only`.
- **The loop stops** on any of the following:
  - a change to HEAD, branch, refs or stashes;
  - a change to which files are modified;
  - a changed file outside the frozen set;
  - a timeout or a non-zero exit;
  - other than exactly one successful result event;
  - a reply that is not the JSON object;
  - decisions that do not cover each finding exactly once, or that do not match the files that actually changed;
  - any `founder_only` decision;
  - no fix applied at all;
  - the founder not typing the `RUN TESTS` phrase (nothing is executed);
  - any repository change between showing the diff and running the tests;
  - failing gate tests;
  - gate tests that changed the repository.
- **The diff** is Claude's edits only: the round's frozen copy against the current file, through read-only
  `git diff --no-index`. It covers tracked and new files alike.
- **Recorded evidence:** `claude-prompt.txt`, `claude-argv.txt`, `claude-transcript.jsonl`, `claude-response.json`,
  `diff.patch`, `after\` copies and `tests.txt`.

### Evidence

- **Session archive:** each session writes `codex-trial\results\loop-<gate>-<timestamp>\` with `tools\`,
  `round-<n>\{input, run, canary, temp, clone, results-copy, findings.json, runner and parse console, fix\}`,
  `loop-log.txt`, `loop-summary.json` and a machine-checkable `MANIFEST.sha256`.
- **Write-once:** archives are never overwritten. An existing file or manifest is refused.
- **Re-verification:** `verify-archive.ps1 -Path <archive>` or `-All <results>` re-hashes any archive read-only.
- **Trial paths:** the loop leaves them in place at the end.

## Validation

All suites run offline (PowerShell 5.1, Node 24.14.0):

| Command | Result |
| --- | --- |
| `powershell -File scripts/review-loop/tests/cbc-codex-trial-test.ps1` | `offline tests: 296 checks, 0 failed` (the 208 existing checks, 2 of them with updated labels, plus 88 for `Loop`) |
| `powershell -File scripts/review-loop/tests/test-review-parse.ps1` | `review-parse tests: 47 checks, 0 failed` |
| `powershell -File scripts/review-loop/tests/test-loop.ps1` | `loop tests: 123 checks, 0 failed` |
| `powershell -File scripts/review-loop/verify-archive.ps1 -All <Desktop>\chatgpt-review\codex-trial\results` | `archives: 9, failed: 0` (read-only, all existing archives) |

**What the loop suite covers:**

- **Successful runs:** a clean round; a finding, a fix and then a clean round; and a second session that recognizes the
  previous archive, clears the trial paths and replaces the archived input.
- **Stops before or around the review:**
  - the round limit reached with findings open;
  - an ambiguous review;
  - a finding outside the frozen set;
  - a wrong or missing approval;
  - unrecognized trial-path or input content, left untouched;
  - a `.env` file or a deletion among the changes;
  - a runner Proof failure, with its evidence archived;
  - a gate without tests;
  - project Claude settings that grant permissions.
- **The 13 headless-Claude failure modes:**
  - an edit outside the frozen set;
  - a tracked-file edit;
  - a new file;
  - a git ref change;
  - a `founder_only` decision;
  - all findings rejected;
  - a malformed reply;
  - a fix claimed but not made;
  - a change not listed under any decision;
  - a missing decision;
  - an error result;
  - a crash;
  - failing tests.
- **Test approval (added after the security review handoff):**
  - the diff is shown, then `RUN TESTS` is requested, then the test runs, in that order;
  - the phrase carries the `diff.patch` hash prefix;
  - the prompt warns that the tests run unsandboxed;
  - the diff contains only Claude's edits, including for a new (untracked) file;
  - the test runs exactly once;
  - a declined or empty approval runs no test, not even with deliberately breaking code, starts no round 2, and keeps
    the diff archived.
- **Units:**
  - 16 git write commands refused by the read-only wrapper;
  - write-once archives;
  - `verify-archive` failing on a changed or unlisted file;
  - the guarded clear refusing a wrong path.
- **Static checks:**
  - the scripts parse and are ASCII only;
  - no shell is started;
  - git is called only through the wrapper;
  - `TestMode` cannot be set from the command line;
  - there are no permission-bypass or `--bare` flags;
  - the loop and the runner use the identical forbidden list.

**Not exercised:** any real Codex or Claude call. That includes how real headless Claude 2.1.185 enforces
`dontAsk`, `--setting-sources project` and the per-file `Edit(./path)` rules. The offline tests verify that the flags
are passed; the live behaviour is checked at the first founder-approved live run.

## Out of scope

- Any model call. The first live loop run needs separate founder approval.
- Application code. That includes the Gate 007A files.
- Changing the Desktop kit, its archives or its input sets.
- Dependencies and CI workflows.
- An amendment recording Codex findings as section 6.4-style directives, which would need its own docs-only gate.

## Known limits

- **The base must be pushed.** The clone checks the base out from origin, so work committed locally but not pushed
  cannot be reviewed. It fails closed at checkout.
- **Some gates cannot use the loop.** A gate that changes forbidden paths (for example `package*.json`, `.claude/` or
  `AGENTS.md`) cannot use it.
- **Fix rounds need a gate entry.** They need a `gate-tests.json` entry, which is reviewed like any code. Without one,
  only `-MaxRounds 1` works.
- **Approved tests run unsandboxed.** Gate tests run with the founder's user rights, but only after the founder has
  seen and approved Claude's diff. When a gate's own test files are in the frozen set, the prompt says so explicitly,
  and Codex re-reviews the change in the next round.
- **Claude can still read most files.** Headless Claude can read files outside the repository except those the deny
  rules cover. It has no Bash or network tools, and its transcript is archived.
