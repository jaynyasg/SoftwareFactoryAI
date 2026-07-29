/**
 * BlueprintLanes — the FOCUSED run's stage pipeline (DESIGN.md §5, U9 + session
 * lifecycle U5; KTD7 blueprint-first). One lane per factory stage: research,
 * planning, queued tickets, active workers, gates, repair, package, deploy.
 * Every lane folds from replayed projections (`deriveBlueprintLanes`); severity
 * color is always paired with a status label.
 *
 * U5 legibility (R2–R5): the panel opens with the one-line truthful status
 * headline (what the run is doing now + how many items need the operator, the
 * items one expand away — with an explicit designed "nothing needs you in this
 * run" idle state). The lanes carry a current-stage marker (text label +
 * `aria-current="step"`, never color alone) and collapse by default — only the
 * current stage opens — expanding on demand to the EXISTING panels
 * (ResearchBrief, SupervisorPanel, WorkerBoard, PackageHandoff, DeployStatus)
 * or projection-faithful gate/repair rows, so collapsing loses no ledger
 * fidelity. The header pulse row keeps capacity, throttle reason, queue depth,
 * and the currently blocking policy/setup item.
 */
import type { RunProjection } from '@software-factory/core';
import type {
  BlueprintInputs,
  BlueprintLane,
  BlueprintLaneId,
  FactoryPulse,
  StatusHeadline,
} from '../../lib/run-view';
import {
  deriveBlueprintLanes,
  deriveCurrentStage,
  executionStateLabel,
  executionStateSeverity,
} from '../../lib/run-view';
import { Mono, SeverityBadge } from './primitives';
import { ResearchBrief } from './ResearchBrief';
import { SupervisorPanel } from './SupervisorPanel';
import { WorkerBoard } from './WorkerBoard';
import { PackageHandoff } from './PackageHandoff';
import { DeployStatus } from './DeployStatus';

function PulseRow({ pulse }: { readonly pulse: FactoryPulse }) {
  return (
    <div className="pulse" data-testid="factory-pulse" aria-label="Factory pulse">
      <span className="pulse__item">
        <span className="label">workers</span>
        <span className="mono">{pulse.activeWorkers} active</span>
      </span>
      <span className="pulse__item">
        <span className="label">queued</span>
        <span className="mono">{pulse.queuedTickets}</span>
      </span>
      <span className="pulse__item">
        <span className="label">capacity</span>
        <span className="mono">
          {pulse.effectiveCapacity}/{pulse.requestedCap}
        </span>
      </span>
      {pulse.throttleReason ? (
        <span className="pulse__item pulse__item--wide sev-warn" data-testid="pulse-throttle">
          <span className="label">throttle</span>
          <span className="pulse__text" title={pulse.throttleReason}>
            {pulse.throttleReason}
          </span>
        </span>
      ) : null}
      {pulse.blocking ? (
        <span className="pulse__item pulse__item--wide sev-error" data-testid="pulse-blocking">
          <span className="label">blocking</span>
          <span className="pulse__text" title={pulse.blocking}>
            {pulse.blocking}
          </span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The one-line truthful headline (R3) + explicit idle state (R5/AE4): when
 * nothing needs the operator IN THIS RUN, the floor says so as a designed
 * state — never absence of content. Needs-you items are one expand away.
 */
function HeadlineRow({ headline }: { readonly headline: StatusHeadline }) {
  return (
    <div className="blueprint__headline" data-testid="status-headline">
      <span className="blueprint__headline-text">{headline.text}</span>
      {headline.needsYou > 0 ? (
        <details className="blueprint__needs-you" data-testid="headline-needs-you">
          <summary>
            <SeverityBadge
              severity="warn"
              label={`${headline.needsYou} need${headline.needsYou === 1 ? 's' : ''} you`}
            />
          </summary>
          <ul className="blueprint__needs-you-items">
            {headline.items.map((item) => (
              <li key={`${item.kind}:${item.label}`} data-testid="needs-you-item">
                <span className="label">{item.kind}</span> {item.label}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <span className="blueprint__idle" data-testid="headline-idle">
          <SeverityBadge severity="success" label="nothing needs you in this run" />
        </span>
      )}
    </div>
  );
}

/**
 * The expanded body of one lane card: the EXISTING panel for stages that have
 * one, or projection-faithful rows (gates/repair) — identical data to what the
 * run detail surfaces render, so collapsing costs no ledger fidelity. Stages
 * whose lane detail already carries the full projected state (queue) render
 * only that detail.
 */
function LaneContent({
  lane,
  inputs,
}: {
  readonly lane: BlueprintLaneId;
  readonly inputs: BlueprintInputs;
}) {
  switch (lane) {
    case 'research':
      return inputs.research.status !== 'none' ? (
        <ResearchBrief research={inputs.research} compact />
      ) : null;
    case 'planning':
      return inputs.run.supervisorDecisions.length > 0 || inputs.tickets.length > 0 ? (
        <SupervisorPanel decisions={inputs.run.supervisorDecisions} tickets={inputs.tickets} />
      ) : null;
    case 'queue':
      return null;
    case 'workers':
      return (
        <WorkerBoard
          tickets={inputs.tickets}
          requestedCap={inputs.run.requestedWorkerCap}
          adapterCapacity={inputs.operator.adapterCapacity}
        />
      );
    case 'gates':
      return inputs.gates.length > 0 ? (
        <ul className="lane__rows" data-testid="lane-gate-rows">
          {inputs.gates.map((gate) => (
            <li key={`${gate.ticketId ?? 'run'}:${gate.gate}`} className="lane__row">
              <span className="mono">{gate.gate}</span>
              <SeverityBadge
                severity={
                  gate.status === 'failed' ? 'error' : gate.status === 'passed' ? 'success' : 'info'
                }
                label={gate.status}
              />
              <span className="mono">{gate.attempts} attempt(s)</span>
              {gate.detail ? (
                <span className="lane__detail" title={gate.detail}>
                  {gate.detail}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null;
    case 'repair':
      return inputs.repairs.length > 0 ? (
        <ul className="lane__rows" data-testid="lane-repair-rows">
          {inputs.repairs.map((repair) => (
            <li key={repair.ticketId} className="lane__row">
              <Mono value={repair.ticketId} max={20} copyable={false} />
              <SeverityBadge
                severity={
                  repair.status === 'exhausted'
                    ? 'error'
                    : repair.status === 'repairing'
                      ? 'warn'
                      : 'success'
                }
                label={repair.status}
              />
              <span className="mono">{repair.attempts} attempt(s)</span>
              {repair.reason ? (
                <span className="lane__detail" title={repair.reason}>
                  {repair.reason}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null;
    case 'package':
      return <PackageHandoff pkg={inputs.packageView} />;
    case 'deploy':
      return <DeployStatus deploy={inputs.deploy} />;
    default: {
      // Exhaustiveness: a new lane id must fail compile until it gets content.
      const exhaustive: never = lane;
      return exhaustive;
    }
  }
}

function LaneCard({
  lane,
  inputs,
  current,
}: {
  readonly lane: BlueprintLane;
  readonly inputs: BlueprintInputs;
  readonly current: boolean;
}) {
  return (
    <div
      role="listitem"
      className={`lane${current ? ' lane--current' : ''}`}
      data-testid={`lane-${lane.id}`}
      aria-label={`${lane.label} lane`}
      aria-current={current ? 'step' : undefined}
    >
      <span className="lane__name">{lane.label}</span>
      {current ? (
        <span className="badge lane__current" data-testid="current-stage">
          current stage
        </span>
      ) : null}
      <SeverityBadge severity={lane.severity} label={lane.status} />
      {lane.metric ? <span className="lane__metric mono">{lane.metric}</span> : null}
      {/* Collapsed by default (R4); the CURRENT stage opens. React only syncs
          `open` when the prop value changes, so operator toggles survive
          re-renders from the poll loop. */}
      <details className="lane__expand" open={current || undefined}>
        <summary>{lane.id === 'research' ? 'evidence' : 'details'}</summary>
        {lane.detail ? (
          <span className="lane__detail" title={lane.detail}>
            {lane.detail}
          </span>
        ) : null}
        <LaneContent lane={lane.id} inputs={inputs} />
      </details>
    </div>
  );
}

export function BlueprintLanes({
  inputs,
  pulse,
  headline,
}: {
  readonly inputs: BlueprintInputs;
  readonly pulse: FactoryPulse;
  /** The derived truthful headline (see `deriveStatusHeadline`). */
  readonly headline: StatusHeadline;
}) {
  const lanes = deriveBlueprintLanes(inputs);
  const currentStage = deriveCurrentStage(inputs);
  const run: RunProjection = inputs.run;
  const runId = run.runId ?? 'unknown';

  return (
    <section className="panel blueprint" aria-label="Factory blueprint">
      <header className="panel__header blueprint__header">
        <div className="row" style={{ gap: 'var(--space-8)' }}>
          <h2 className="panel__title">Blueprint</h2>
          <span data-testid="blueprint-run">
            <Mono value={runId} max={26} />
          </span>
        </div>
        <div className="row" style={{ flex: 'none' }}>
          {inputs.operator.sandboxFallback ? (
            <SeverityBadge severity="warn" label="reduced trust" />
          ) : null}
          <SeverityBadge
            severity={executionStateSeverity(run.executionState)}
            label={`execution ${executionStateLabel(run.executionState)}`}
          />
        </div>
      </header>
      <div className="panel__body blueprint__body">
        <HeadlineRow headline={headline} />
        <PulseRow pulse={pulse} />
        <div className="lanes" role="list" aria-label="Blueprint lanes">
          {lanes.map((lane) => (
            <LaneCard
              key={lane.id}
              lane={lane}
              inputs={inputs}
              current={lane.id === currentStage}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
