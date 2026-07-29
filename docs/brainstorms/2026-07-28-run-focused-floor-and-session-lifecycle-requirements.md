---
date: 2026-07-28
topic: run-focused-floor-and-session-lifecycle
---

# Run-Focused Floor and Session Lifecycle

## Summary

Refocus the Factory Floor around a single run in focus — a stage pipeline with a "you are here" marker and a one-line status headline saying what the run is doing and what needs the operator — with all other panels behind progressive disclosure. Add two lifecycle actions: New Session (archive everything inactive, open a clean floor) and Factory Reset (explicit destructive wipe for dev machines).

---

## Problem Frame

Real end-to-end use surfaced two operator pains. First, the floor renders every panel for every run simultaneously — supervisor decisions, worker board, trace ledger, tickets, review, deploy — with no visual hierarchy of what matters right now. The operator running the factory could not tell what was going on. Second, there is no way to clear the floor and start fresh: the cancel-all action stops work but, in an append-only ledger world, nothing ever leaves the stage — every past run stays on screen forever, compounding the clutter.

These are one system gap seen from two sides: runs have no lifecycle beyond "created → done/cancelled." There is no notion of focus, dismissal, or a fresh workspace, so clutter is guaranteed by design, and "clear" appears broken because clearing was never defined.

---

## Actors

- A1. Operator: the human running the factory locally; monitors runs, answers interventions, starts sessions.
- A2. Execution daemon: owns the queue, workers, and the drain gate; must cooperate with session resets.
- A3. Connector surfaces: CLI, remote MCP, and ChatGPT Action; expected to keep parity with floor actions.

---

## Key Flows

- F1. Monitor a run
  - **Trigger:** A run starts (or the operator opens the floor while runs exist).
  - **Actors:** A1
  - **Steps:** Floor focuses the most recent active run → the stage pipeline shows where it is and per-stage state → the headline states what the run is doing and what needs the operator → operator expands a stage card only when they want detail.
  - **Outcome:** The operator can answer "what is happening and what needs me" without expanding anything.
  - **Covered by:** R1, R2, R3, R4, R5

- F2. Start a fresh session
  - **Trigger:** Operator wants a clean floor.
  - **Actors:** A1, A2
  - **Steps:** Operator invokes New Session → if runs are still active, confirm cancel-and-archive or abort → all runs archived → drain gate re-held, queued (not-yet-started) work cleared → floor opens empty.
  - **Outcome:** Clean session; history intact and recoverable.
  - **Covered by:** R6, R7, R8, R10

- F3. Dev-machine wipe
  - **Trigger:** Operator wants a true blank slate (dev/testing).
  - **Actors:** A1, A2
  - **Steps:** Operator invokes Factory Reset → typed confirmation naming what will be destroyed → daemon stops workers and releases resources → ledger, run state, and generated workspaces deleted → fresh state records a reset marker.
  - **Outcome:** Factory behaves like first boot.
  - **Covered by:** R9, R12

---

## Requirements

**Run focus and legibility**

- R1. The floor defaults to one focused run; all other runs collapse into a compact strip, and switching focus is a single click.
- R2. The focused run renders as a stage pipeline (intake → research → plan → build → gates → review → package → deploy) with a clear current-stage marker and per-stage status.
- R3. A one-line status headline on the focused run states, in plain words, what the run is doing now and how many items need the operator, with the needs-you items one click away.
- R4. Panels other than the current stage collapse by default and expand on demand; every surfaced state continues to map to real ledger events (no invented or optimistic status).
- R5. When nothing needs the operator, the floor says so explicitly rather than leaving them to infer it from absence of alerts.

**Session lifecycle**

- R6. A New Session action archives all inactive runs and opens a clean floor; if runs are active, it asks once whether to cancel-and-archive them or abort.
- R7. Archiving is reversible and non-destructive: archived runs leave the default view but remain on disk, searchable, and replayable through a history view.
- R8. New Session resets execution state, not just the view: the drain gate returns to held and queued-but-unstarted work is cleared.
- R9. A Factory Reset action destructively wipes runs, ledger, and generated workspaces; it requires a typed confirmation that names what will be destroyed, and it is visually and semantically separated from New Session.
- R10. When a run is cancelled, its visual state updates immediately and the floor offers to archive it in the same moment.

**Parity and audit**

- R11. New Session, archive, and Factory Reset are available with parity across the floor UI, CLI, and MCP connector, matching the existing cancel-all parity convention.
- R12. Lifecycle actions are audit-visible: archive and new-session are recorded as events; a factory reset records a reset marker in the fresh state so the discontinuity is explainable.

---

## Acceptance Examples

- AE1. **Covers R6, R8.** Given three completed runs and one active run, when the operator invokes New Session and confirms cancel-and-archive, then all four runs are archived, the floor is empty, the drain gate is held, and the queue has no pending work.
- AE2. **Covers R7.** Given archived runs, when the operator opens the history view, they can open any archived run and replay its ledger.
- AE3. **Covers R9.** Given a Factory Reset prompt, when the operator dismisses it or mistypes the confirmation, nothing is deleted and the current state is untouched.
- AE4. **Covers R3, R5.** Given a run waiting on a gate-retry decision, the headline shows one needs-you item naming the decision; once resolved with nothing else pending, the floor explicitly shows that nothing needs the operator.
- AE5. **Covers R10.** Given an active run, when the operator cancels it, the run's card reflects cancellation immediately and offers one-click archive.

---

## Success Criteria

- An operator glancing at a busy floor can answer "what is happening and what needs me" within seconds, without expanding panels — the original "everything clumped together" complaint no longer reproduces.
- One action takes the floor from cluttered to clean with history preserved; the original "cancel didn't clear anything" complaint no longer reproduces.
- Planning can proceed without inventing product behavior: states, confirmations, archive semantics, and parity surfaces are defined here.

---

## Scope Boundaries

- Full attention-queue redesign (top level as an operator inbox) — only its status headline is adopted; revisit if multi-run operation becomes the norm.
- Session as a first-class entity scoping runs, views, and workspaces — archive-by-default approximates it; graduate later if parallel work streams become real.
- Poll-loop consolidation — already tracked in `TODOS.md` (P2); adjacent performance work, not this change.
- Ledger compaction, pruning, or storage optimization — archive is a view/lifecycle concept, not a storage one.
- Multi-user, hosted, or team session semantics.
- Any change to gate, review, or deploy semantics themselves.

---

## Key Decisions

- Archive-by-default plus explicit destructive reset ("Both"): the default fresh start preserves the provenance story the product is built on; the true wipe exists for dev machines behind a deliberately scarier door.
- Stage-focused floor with the attention headline (approach A stealing B's headline): fixes both reported pains with the least new machinery; the full attention-queue redesign and session-entity model were considered and deferred.
- New Session resets execution state (gate re-held, queue cleared), not just the view — a "fresh session" that silently keeps executing would be a lie.
- Lifecycle actions get CLI/MCP parity from day one, consistent with the factory's existing connector-parity convention.

---

## Dependencies / Assumptions

- The drain gate and factory-wide cancel-all already exist across UI/CLI/MCP (verified: recent commits and runbooks).
- The ledger is append-only with pure-function projections, so "clearing" must be modeled as archive events plus default-view filtering (verified architecture).
- Assumption (unverified): existing projections expose enough per-stage state to derive the pipeline marker and "waiting on" headline without new event types. If they don't, planning should prefer adding projection fields over inventing UI-side state.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R2][Technical] Exact mapping from event taxonomy to the displayed stage pipeline (which events advance which stage, how retries render).
- [Affects R3][Technical] Derivation rules for the status headline and needs-you count from existing projections.
- [Affects R7][Technical] Where the history view lives (dedicated view vs filter on the existing floor) and how archived runs are listed at scale.
- [Affects R9][Technical] Wipe mechanics while the daemon is running (stop order, workspace cleanup, port/lock release).
