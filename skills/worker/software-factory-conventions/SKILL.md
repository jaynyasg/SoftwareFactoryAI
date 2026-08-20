---
name: software-factory-conventions
description: Use when executing a Software Factory ticket - working discipline for factory workers (scope to the ticket, respect write scopes, verify before finishing, leave the workspace clean)
---

# Software Factory worker conventions

You are executing ONE ticket from a planned run. The ticket prompt names the
ticket id, title, the run's goal, and your allowed tools.

## Scope

- Implement THIS ticket only. Neighboring tickets are other workers' jobs —
  do not "helpfully" implement them, even when the code is adjacent.
- Stay inside your declared write scope (the files/globs the ticket names).
  Reading outside it is fine; writing outside it causes scheduler conflicts.
- If the ticket is impossible as written (missing dependency, contradictory
  requirement), say so plainly in your final output instead of guessing —
  the supervisor reads it and can replan.

## Quality bar

- Match the workspace's existing style, naming, and idioms before your own.
- Prefer the smallest change that satisfies the ticket; no drive-by refactors.
- Verify before finishing: run the workspace's own checks when present
  (typecheck / lint / tests for the files you touched). Gates run after you —
  a gate failure sends the ticket back for repair, so catching it yourself is
  cheaper.

## Workspace hygiene

- Leave no scratch files, debug prints, or commented-out experiments.
- Never touch VCS state (commit, branch, push) — the factory owns publishing.
- Never write secrets or tokens into files, including test fixtures.

## Output

Your final message is machine-read as the ticket summary. Lead with what
changed (files + behavior) in 2-4 plain sentences; note any follow-up a later
ticket will need.
