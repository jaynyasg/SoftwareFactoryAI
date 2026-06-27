/**
 * QueuePanel — scheduling + queue health for operators: active vs effective
 * worker capacity (a system-gated upper bound, never a promise), queued tickets,
 * queue wait, and the gate-retry churn / gate-failure tally that drives
 * re-queueing. Read-only; values come from the operator metrics.
 */
import type { OperatorMetrics } from '@software-factory/core';
import { formatDurationMs } from '../../lib/run-view';

export function QueuePanel({ metrics }: { readonly metrics: OperatorMetrics }) {
  const { workers, queue, gates } = metrics;

  return (
    <section className="panel" aria-label="Queue">
      <header className="panel__header">
        <h2 className="panel__title">Queue & scheduling</h2>
        <span className="panel__hint">
          {workers.active} active · {workers.queued} queued
        </span>
      </header>
      <div className="panel__body">
        <div className="stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="label">
              workers {workers.active} / {workers.effectiveCap}
            </span>
            <span className="badge" title="The worker cap is an upper bound, not a guarantee.">
              cap is system-gated
            </span>
          </div>
          {workers.throttled ? (
            <p className="sev-warn" style={{ fontSize: 'var(--fs-2xs)' }} data-testid="queue-throttled">
              Effective capacity {workers.effectiveCap} is below the requested cap{' '}
              {workers.requestedCap ?? '—'}.
            </p>
          ) : null}
        </div>

        <div className="control-row">
          <div className="stack" style={{ gap: 2 }}>
            <span className="label">queued tickets</span>
            <span className="metric mono">{queue.queuedTickets}</span>
          </div>
          <div className="stack" style={{ gap: 2 }}>
            <span className="label">queue wait</span>
            <span className="metric mono">{formatDurationMs(queue.waitMs)}</span>
          </div>
          <div className="stack" style={{ gap: 2 }}>
            <span className="label">gate retries</span>
            <span className="metric mono" data-testid="gate-retries">
              {gates.retries}
            </span>
          </div>
        </div>

        {gates.failures > 0 ? (
          <div className="banner banner--error" role="alert" data-testid="gate-failed">
            <span className="banner__body">
              {gates.failures} gate failure(s); {gates.retries} bounded retry/retries; {gates.passed}{' '}
              passed.
            </span>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
            No gate failures — {gates.passed} gate pass(es).
          </p>
        )}
      </div>
    </section>
  );
}
