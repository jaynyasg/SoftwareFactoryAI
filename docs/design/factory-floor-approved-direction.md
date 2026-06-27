# Factory Floor — Approved Visual Direction

**Direction: B2 — Control Room Ledger.** Approved during `/plan-design-review`.
This document records the approved direction and maps the **Ash SWF operating model**
(`Ash SWF.png`) onto factory surfaces and ledger events. It is a companion to the
design-system contract in [DESIGN.md](./DESIGN.md).

> The Ash diagram is an **operating model**, not a literal canvas to reproduce. We
> preserve its relationships (supervisor → workers → CI gate → risk-tiered review →
> human reviewers → feedback memory), not its boxes-and-arrows aesthetic.

## Why Control Room Ledger

The product is UI-heavy and trust-sensitive: a human is deciding whether to trust
machine-generated software. The interface must read like an operations console —
dense, factual, scannable, append-only — so the operator can answer "what happened,
what is happening, and what needs me" at a glance. A generic SaaS dashboard or a
decorative workflow canvas would undermine that trust.

## Ash operating model → factory mapping

| Ash element | Factory surface | Backing events (U2 taxonomy) |
| --- | --- | --- |
| Supervisor — claims tickets, spawns workers, enforces budgets | `SupervisorPanel` | `supervisor.decision`, `run.planned`, `ticket.created` |
| Worker agents (N tickets in parallel) | `WorkerBoard`, `TicketCard` | `worker.started`, `worker.progress`, `ticket.state_changed` |
| Skill library (PM / Frontend / Backend / QA) | Genome modules + adapter/skill selection in `RunControl` | `genome.module_selected`, `adapter.selected` |
| QA agent verify vs criteria, fail → retry | Gate runner + retry loop | `gate.started`, `gate.passed`, `gate.failed`, `worker.retry` |
| CI gate (lint · tests · build · security) | `DeployStatus` precondition + gates in trace | `gate.*`, `security.block` |
| Risk-tiered PR review (low auto-merge / medium 1 / high 2) | `ReviewStudio`, `DecisionCard` | `review.requested`, `review.decided`, `risk.tier_assigned` |
| Human reviewers | `DecisionCard` (command-guarded) | `review.decided`, `command.rejected` |
| Work queues — Backlog / In-Progress / Dead-letter (stuck → human) | Queue views (operator U11) + run/ticket projections | `ticket.queued`, `ticket.dead_lettered` |
| Feedback memory → skill updates | Deferred to `TODOS.md` (P2 human-approved genome updates) | `genome.update_proposed` (future) |
| Rebase vs main / Main | Package + deploy (U9) | `package.created`, `deploy.*` |

## Signature visual moves

- **The ledger is the spine.** A persistent, append-only `TraceLedger` with severity
  coloring runs down the run view. New events stream in (SSE/polling), reconnect via
  `last_sequence`, and surface projection-gap states honestly.
- **Decision cards demand a human.** Risk-tiered review renders as cards with the risk
  tier, evidence, and guarded approve/reject. High risk never auto-merges.
- **Confidence is computed, shown, and explained.** `ArtifactConfidence` blends gate
  pass rate, provenance completeness, dependency risk, and preview evidence — with the
  breakdown visible, never a vanity number.
- **Reduced-trust is loud.** Sandbox fallback marks artifacts with a `--sev-warn`
  treatment and a label everywhere they appear.

## States to design for

Empty run (prompt entry + setup status), active run (tickets/workers/gates/ledger/preview),
review/failure (decision cards + failed gates + retry context), and tablet/mobile
supervision. See DESIGN.md §6 for the full mandatory state list.

## Open follow-up

A concrete high-fidelity visual artifact (mockup) for the run page is tracked in
`TODOS.md` ("P1: Factory Floor Visual Artifact"). The gstack designer binary was
unavailable during plan design review; this document plus DESIGN.md are the binding
contract until that artifact exists.
