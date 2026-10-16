# Gate 005B - Agent Loop Smoke Test

## Goal

Prove the CBC review loop end to end on real infrastructure, using a
harmless documentation change. The loop runs Claude Code, then the Gate 005A
orchestrator, then a ChatGPT review. This gate stops at `awaiting_review`.
The ChatGPT review is produced outside this gate and is never written by
Claude Code.

## Change

This document is the only change. It has no effect on application behavior.

## Procedure

1. Branch `gate-005b-agent-loop-smoke` from verified `master`.
2. Commit this document and push the gate branch to `origin`.
3. Fill in a local `.agents/claude-handoff.yaml` using schema v4 with
   `status: ready_for_review`, the gate ID `005B`, the branch, the base
   commit, and the pushed head commit.
   - The handoff is **not committed**. Committing it would create a new
     commit, so the handoff could never name the branch's own head. The
     handoff is a local working artifact that describes the pushed head.
4. Run the Gate 005A orchestrator, unchanged, against that handoff and the
   real `origin`, without `--remote-fixture`.
5. Expected result: `awaiting_review`, with `review-request.json` written
   to `.agents/outbox/`.

## Constraints

- Docs only.
- No application source, migrations, dependencies, environment files, or
  deploy config.
- No production, Azure, Key Vault, or real database access.
- No merge. A draft PR is created only if it is permitted and the tooling is
  available.
- Claude Code does not write `.agents/chatgpt-review.yaml`.

## Out of scope

- Generating or simulating the ChatGPT review.
- Any founder-only action (AGENTS.md section 6.3 on
  `docs/agent-operating-files`).
