/**
 * BlueprintLanes — the FOCUSED run's pipeline as dense status strips
 * (DESIGN.md §5, U9; KTD7 blueprint-first). One lane per factory stage:
 * research, planning, queued tickets, active workers, gates, repair, package,
 * deploy. Every lane folds from replayed projections (deriveBlueprintLanes);
 * severity color is always paired with a status label. The research lane
 * carries an inline expand so findings and source evidence are readable
 * without raw JSON. The header pulse row shows capacity, throttle reason,
 * queue depth, and the currently blocking policy/setup item.
 */
import type { RunProjection } from '@software-factory/core';
import type { BlueprintInputs, FactoryPulse } from '../../lib/run-view';
import {
  deriveBlueprintLanes,
  executionStateLabel,
  executionStateSeverity,
} from '../../lib/run-view';
import { Mono, SeverityBadge } from './primitives';
import { ResearchBrief } from './ResearchBrief';

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

export function BlueprintLanes({
  inputs,
  pulse,
}: {
  readonly inputs: BlueprintInputs;
  readonly pulse: FactoryPulse;
}) {
  const lanes = deriveBlueprintLanes(inputs);
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
        <PulseRow pulse={pulse} />
        <div className="lanes" role="list" aria-label="Blueprint lanes">
          {lanes.map((lane) => (
            <div
              key={lane.id}
              role="listitem"
              className="lane"
              data-testid={`lane-${lane.id}`}
              aria-label={`${lane.label} lane`}
            >
              <span className="lane__name">{lane.label}</span>
              <SeverityBadge severity={lane.severity} label={lane.status} />
              {lane.metric ? <span className="lane__metric mono">{lane.metric}</span> : null}
              {lane.id === 'research' && inputs.research.status !== 'none' ? (
                <details className="lane__expand">
                  <summary>evidence</summary>
                  <ResearchBrief research={inputs.research} compact />
                </details>
              ) : lane.detail ? (
                <span className="lane__detail" title={lane.detail}>
                  {lane.detail}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
