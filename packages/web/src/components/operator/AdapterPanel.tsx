/**
 * AdapterPanel — execution-adapter health for operators: capacity (and whether
 * it was throttled below the requested cap), plus the adapter setup/auth/error
 * occurrences that make the adapter "unavailable". Read-only; values come from
 * the operator metrics. The unavailable/throttled states are surfaced even after
 * the adapter recovers, so operators can see what happened during the run.
 */
import type { OperatorMetrics } from '@software-factory/core';

export function AdapterPanel({ metrics }: { readonly metrics: OperatorMetrics }) {
  const { adapter, workers } = metrics;
  const issues = adapter.setupRequired + adapter.authFailures + adapter.errors;
  const requestedCap = workers.requestedCap;

  return (
    <section className="panel" aria-label="Adapters">
      <header className="panel__header">
        <h2 className="panel__title">Adapters</h2>
        <span className={`badge sev-${issues > 0 ? 'error' : 'success'}`} data-testid="adapter-state">
          <span className="badge__dot" aria-hidden="true" />
          {issues > 0 ? 'unavailable' : 'ready'}
        </span>
      </header>
      <div className="panel__body">
        {issues > 0 ? (
          <div className="banner banner--error" role="alert" data-testid="adapter-unavailable">
            <span className="banner__body">
              Adapter unavailable — {adapter.setupRequired} setup, {adapter.authFailures} auth,{' '}
              {adapter.errors} error event(s).
              {adapter.lastReason ? ` Latest: ${adapter.lastReason}` : ''}
            </span>
          </div>
        ) : null}

        <div className="stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="label">
              capacity {adapter.capacity ?? '—'}
              {requestedCap !== undefined ? ` / ${requestedCap}` : ''}
            </span>
            <span className="badge" title="Adapter capacity is a system-gated upper bound.">
              cap is system-gated
            </span>
          </div>
          {adapter.throttled ? (
            <p className="sev-warn" style={{ fontSize: 'var(--fs-2xs)' }} data-testid="capacity-throttled">
              Capacity throttled from {adapter.previousCapacity ?? requestedCap ?? '—'} to{' '}
              {adapter.capacity ?? '—'} by system constraints.
            </p>
          ) : (
            <p className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
              Capacity is at the requested ceiling.
            </p>
          )}
        </div>

        <div className="control-row">
          <div className="stack" style={{ gap: 2 }}>
            <span className="label">setup required</span>
            <span className="metric mono">{adapter.setupRequired}</span>
          </div>
          <div className="stack" style={{ gap: 2 }}>
            <span className="label">auth failures</span>
            <span className="metric mono">{adapter.authFailures}</span>
          </div>
          <div className="stack" style={{ gap: 2 }}>
            <span className="label">errors</span>
            <span className="metric mono">{adapter.errors}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
