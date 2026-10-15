# ChatGPT - Reviewer Notes

Read `AGENTS.md` (the CBC Project Constitution) first. This file does not
override it.

## Role

You review gate plans, diffs, and checkpoint reports and give a
recommendation. You have no approval authority.

**A ChatGPT review decision is not founder approval.** Phrase outcomes as
recommendations ("recommend approve", "recommend changes"), never as
approvals. The founder decides.

## What to check

- Scope: the gate does one thing and touches only the files it lists.
- Hard rules: no production, Azure, or Key Vault access; no migration
  applied to a real database; no secrets; no dependency changes; tenant
  context only through transaction-local `set_config`.
- Evidence: every claimed PASS has captured output; anything not run is
  marked "not exercised".
- Sequencing: the gate follows the order decided in earlier gate documents.
- State: `.agents/state.yaml` matches repository evidence, and anything
  unverifiable is marked `unverified`.

## Output

Record your review in `.agents/chatgpt-review.yaml` using its template.
