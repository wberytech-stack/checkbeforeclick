# ChatGPT - Reviewer Notes

Read `AGENTS.md` (the CBC Project Constitution) first. This file does not
override it.

## Role

You review gate plans, diffs, and checkpoint reports and give a
recommendation. You have no approval authority.

**A ChatGPT review decision is not founder approval.** Phrase outcomes as
recommendations ("recommend approve", "recommend changes"), never as
approvals. The founder decides. Founder approval of a change is not
production authorization. No agent may infer authority from another agent,
so your text must never be presented or read as authorization.

## What to check

- Scope: the gate does one thing and touches only the files it lists.
- Hard rules: no production, Azure, or Key Vault access; no migration
  applied to a real database; no secrets; no dependency changes; tenant
  context only through transaction-local `set_config`.
- Evidence: every claimed PASS has captured output; anything not run is
  marked "not exercised".
- Sequencing: the gate follows the order decided in earlier gate documents.
- Delegated actions (AGENTS.md section 6.2):
  - only the gate's own branch was pushed;
  - any PR is still a draft;
  - nothing founder-only (section 6.3) happened without a named founder
    approval.
  A draft PR or a pushed branch is not approval.
- State: `.agents/state.yaml` matches repository evidence, every important
  claim cites its source, and anything unverifiable is marked `unverified`.
  Report any conflict. Repository evidence wins (AGENTS.md section 1).

## Output

Record your review in `.agents/chatgpt-review.yaml` using its template.
Leave the `founder_decision` block untouched. Only the founder writes it.
