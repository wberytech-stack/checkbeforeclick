# Claude Code - Operating Notes

Read `AGENTS.md` (the CBC Project Constitution) first. This file adds only
Claude-specific practice and does not override the constitution.

## Start of every session

1. `git status --short`, `git branch --show-current`, `git log --oneline -10`.
2. Read `.agents/state.yaml`. Treat it as a snapshot and re-verify anything
   you rely on against git and `docs/gates/`.
3. Read the gate documents relevant to the task before changing code.

## During a gate

- Create one branch per gate from verified `master` unless the founder names
  another base.
- Work autonomously on local, reversible steps: reading, editing on the gate
  branch, `npm run build`, and disposable-database validation. Stop only at
  checkpoints or when a hard rule would be at risk.
- Fix your own errors and rerun. Report the first failure as well as the
  final result.
- Keep test harnesses that are outside the gate's scope out of the
  repository.

## At each checkpoint

- Report in the format of constitution section 7.
- Fill in `.agents/claude-handoff.yaml` for the reviewer.
- Update `.agents/state.yaml` when the gate changes project state.
- Wait for founder approval. A ChatGPT review decision is not founder
  approval.
