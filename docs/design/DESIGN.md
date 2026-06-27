# Software Factory — Design System (Source of Truth)

This document is the design-system contract for the factory shell (`packages/web`).
It is the authority referenced by U8 (Factory Floor UI), U11 (operator dashboard),
and any future surface. Implementation must match these tokens, surfaces, states,
and accessibility criteria. When a design question is not answered here, update this
document first, then implement.

Approved direction: **B2 — Control Room Ledger** (see
[factory-floor-approved-direction.md](./factory-floor-approved-direction.md)).

---

## 1. Design Principles

1. **Truth over decoration.** Every pixel maps to a real ledger event or projection.
   The UI never shows progress, status, or confidence that is not backed by an event.
2. **Operator-grade density.** This is a control room, not a marketing page. Favor
   information density, scannability, and stable layout over whitespace and hero art.
3. **Machine data is monospace.** Run IDs, ticket IDs, sequence numbers, hashes,
   file paths, commands, and log lines use the mono family. Human prose uses the sans family.
4. **Severity is a first-class signal.** Color, weight, and an icon/label together
   encode severity — never color alone (accessibility) and never decoration alone.
5. **Calm by default, loud on risk.** The resting state is quiet dark neutrals.
   Saturated color is reserved for state that needs a human: risk, failure, review-needed,
   reduced-trust, stale-command.
6. **No fake motion.** Animation communicates real state change (a new event arriving,
   a gate flipping). No decorative loops, parallax, or gradient drift.

---

## 2. Color Tokens

Defined as CSS custom properties in `packages/web/src/styles/tokens.css` (created in U8).
The palette is dark-first but **not one-note**: layered neutrals give depth, and a restrained
accent set carries meaning. All text/background pairings below meet WCAG AA (>= 4.5:1 for body,
>= 3:1 for large text and UI affordances).

### Surface / neutral ramp

| Token | Value | Use |
| --- | --- | --- |
| `--bg-base` | `#0b0e14` | App background (deepest layer) |
| `--bg-raised` | `#11151f` | Panels, cards |
| `--bg-overlay` | `#171c28` | Drawers, popovers, modals |
| `--bg-inset` | `#0a0d12` | Ledger/log wells, code blocks |
| `--border-subtle` | `#1f2733` | Hairline dividers |
| `--border-strong` | `#2c3645` | Card edges, focus targets |
| `--text-primary` | `#e6e9ef` | Primary text |
| `--text-secondary` | `#a4adbd` | Secondary text, labels |
| `--text-muted` | `#6b7686` | Metadata, timestamps |

### Brand / accent

| Token | Value | Use |
| --- | --- | --- |
| `--accent` | `#5b8cff` | Primary action, selected, links |
| `--accent-quiet` | `#1b2740` | Accent-tinted backgrounds |

### Semantic severity (used by trace ledger, gates, events)

| Token | Value | Meaning |
| --- | --- | --- |
| `--sev-info` | `#5b8cff` | Informational event |
| `--sev-success` | `#37b87c` | Gate passed, healthy, deployed |
| `--sev-warn` | `#e0a93b` | Degraded, reduced-trust, retry |
| `--sev-error` | `#e5604d` | Gate failed, adapter error |
| `--sev-critical` | `#ff3d6e` | Security block, data-loss risk, dead-letter |

### Risk tiers (Ash risk-tiered review)

| Token | Value | Meaning |
| --- | --- | --- |
| `--risk-low` | `#37b87c` | Low risk — eligible for autonomous/auto-merge under policy |
| `--risk-medium` | `#e0a93b` | Medium risk — 1 reviewer |
| `--risk-high` | `#e5604d` | High risk — 2 approvers, never autonomous |

Every semantic/risk color must be paired with a text label and/or icon. Color is an
accelerator, not the sole carrier of meaning.

---

## 3. Typography

| Role | Family | Notes |
| --- | --- | --- |
| UI / prose | **Geist Sans** (fallback: `system-ui, -apple-system, sans-serif`) | Headings, labels, body |
| Machine data | **IBM Plex Mono** (fallback: `ui-monospace, "SF Mono", Menlo, monospace`) | IDs, paths, commands, log lines, sequence numbers, hashes |

Type scale (rem): `0.75 / 0.8125 / 0.875 / 1 / 1.125 / 1.375 / 1.75`.
Line-height: `1.5` for prose, `1.45` for dense ledger rows.
Weights: 400 (body), 500 (labels/emphasis), 600 (headings). Avoid 700+; this is a calm surface.

---

## 4. Spacing, Radius, Elevation

- **Spacing scale (px):** `2, 4, 8, 12, 16, 24, 32, 48`. Default gutter `16`. Dense rows `8`.
- **Radius:** `--radius-sm: 4px` (chips, inputs), `--radius-md: 8px` (cards, panels),
  `--radius-lg: 12px` (drawers/modals). No fully-rounded pills for data chips.
- **Elevation:** depth comes primarily from the surface ramp, not heavy shadows.
  Drawers/modals may use a single soft shadow `0 8px 24px rgba(0,0,0,0.45)`.
- **Borders:** 1px. Hairlines `--border-subtle`; interactive/edge `--border-strong`.

---

## 5. Core Surfaces

These are the named components U8/U11 must implement. Each reads exclusively from
ledger projections.

| Surface | Component | Responsibility |
| --- | --- | --- |
| Run control | `RunControl` | Prompt/PRD intake, local folder selector, adapter selector, model + effort controls, review-mode toggle, worker-cap (1–10), start/cancel/retry |
| Supervisor | `SupervisorPanel` | Supervisor decisions with rationale + confidence; ticket DAG overview |
| Worker board | `WorkerBoard` | Active/queued workers (up to cap), each mapped to a ticket; capacity + throttle reasons |
| Ticket | `TicketCard` | Ticket state, risk tier, dependencies, assigned worker, gate summary |
| Decision | `DecisionCard` | Human approve/reject with command guard; shows risk tier + evidence; handles stale subject version |
| Confidence | `ArtifactConfidence` | Blended score from gate pass rate, provenance completeness, dependency risk, preview evidence |
| Trace ledger | `TraceLedger` | Append-only event stream with severity; reconnect via `last_sequence`/polling; projection-gap state |
| Artifact drawer | `ArtifactDrawer` | Diffs, logs, files, provenance for a selected ticket/artifact |
| Review studio | `ReviewStudio` | Risk tier, decision cards, trace severity, confidence, diffs/logs, provenance |
| Setup checklist | `SetupChecklist` | Adapter auth/setup, sandbox availability, GitHub/Render setup; actionable, not decorative |
| Deploy status | `DeployStatus` | Render config validity, deploy phases, hosted health; hosted URL only after health success |
| Operator (U11) | `HealthPanel`, `AdapterPanel`, `QueuePanel`, `DeployPanel` | Operator-facing health/resource/queue/deploy diagnostics |

**First screen is the Factory Floor run surface, not a marketing landing page.**

---

## 6. Interaction States (mandatory coverage)

Every data surface must explicitly handle all of these. A missing state is a defect.

| State | UI requirement |
| --- | --- |
| Loading | Skeleton or quiet spinner with context; never blank |
| Empty | Actionable empty state (e.g., prompt entry + setup status); no fake progress |
| Error | Human-readable message + rescue action + severity color/label |
| Success | Confirmed from event, not optimistic |
| Partial | Some tickets/gates done, others pending — show both honestly |
| Reduced-trust | Distinct `--sev-warn` treatment + label when sandbox fallback was used |
| Setup-required | Blocking checklist with the exact action to take |
| Stale-command | Detect outdated subject version, reload current projected state, explain |
| Reconnecting | Trace ledger shows reconnecting + resumes from `last_sequence` |

---

## 7. Accessibility (acceptance criteria for U8 a11y tests)

- **Contrast:** body text >= 4.5:1; large text and UI affordances >= 3:1.
- **Color independence:** severity/risk always carry a text label or icon, never color alone.
- **Keyboard:** all review actions (approve/reject, open drawer, switch ticket, start/cancel)
  are fully keyboard operable in a logical tab order.
- **Focus:** visible focus ring (`2px` `--accent`, 2px offset) on every interactive element.
- **Screen reader:** decision cards expose role, risk tier, and outcome via accessible names;
  the trace ledger uses an appropriate live-region for new events (polite, not assertive).
- **Motion:** respect `prefers-reduced-motion`; disable non-essential transitions.

---

## 8. Anti-Slop Rules

The following are prohibited; reviewers should reject PRs that introduce them.

- No fake or optimistic progress bars, fake percentages, or "AI is thinking…" theater.
- No decorative gradients, glows, or blur used to imply data.
- No emoji as the sole status indicator.
- No generic SaaS hero/landing layout on the run surface.
- No prose where machine data belongs (IDs/paths/commands must be mono, copyable).
- No truncation that hides meaning without a tooltip/expand affordance.
- No layout that produces horizontal scroll from long file paths or URLs — wrap or
  middle-truncate with full value available on hover/expand.

---

## 9. Responsive Behavior

| Breakpoint | Target | Layout |
| --- | --- | --- |
| `>= 1280px` | Desktop control room | Multi-column: worker board + trace ledger + drawer side-by-side |
| `768–1279px` | Tablet supervision | Two columns; drawer becomes overlay |
| `< 768px` | Mobile triage | Single column; review actions and trace remain reachable; no horizontal scroll |

Long identifiers, paths, and URLs must never cause horizontal scroll at any breakpoint
(middle-truncate + copy/expand). Verified by `tests/e2e/responsive-a11y.spec.ts`.
