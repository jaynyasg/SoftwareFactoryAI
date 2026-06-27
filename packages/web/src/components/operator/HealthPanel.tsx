/**
 * HealthPanel — overall run health for operators: event/projection lag, severity
 * alert counts, the reduced-trust sandbox-fallback state, live health samples,
 * any projection-integrity diagnostics, and the active failures joined to their
 * failure-registry rescue actions. Read-only; every value comes from the
 * operator metrics + projection + run diagnostics (no invented state).
 */
import type { OperatorMetrics, OperatorProjection, RunDiagnosticsReport } from '@software-factory/core';
import { formatDurationMs } from '../../lib/run-view';

function lagSeverity(events: number): 'success' | 'warn' {
  return events > 0 ? 'warn' : 'success';
}

export function HealthPanel({
  metrics,
  operator,
  diagnostics,
}: {
  readonly metrics: OperatorMetrics;
  readonly operator: OperatorProjection;
  readonly diagnostics: RunDiagnosticsReport;
}) {
  const samples = Object.values(operator.latestByMetric);
  const { lag, alerts } = metrics;

  return (
    <section className="panel" aria-label="Health">
      <header className="panel__header">
        <h2 className="panel__title">Health</h2>
        <span
          className={`badge sev-${diagnostics.healthy ? 'success' : 'warn'}`}
          data-testid="health-status"
        >
          <span className="badge__dot" aria-hidden="true" />
          {diagnostics.healthy ? 'healthy' : 'needs attention'}
        </span>
      </header>
      <div className="panel__body">
        {metrics.sandbox.fallback ? (
          <div className="banner banner--warn" role="status" data-testid="sandbox-fallback">
            <span className="banner__body">
              Sandbox fallback — generated commands ran reduced-trust
              {metrics.sandbox.reason ? `: ${metrics.sandbox.reason}` : '.'}
            </span>
          </div>
        ) : null}

        <div className="control-row">
          <div className="stack" style={{ gap: 2 }}>
            <span className="label">event lag</span>
            <span className="metric mono">{formatDurationMs(lag.eventLagMs)}</span>
          </div>
          <div className="stack" style={{ gap: 2 }}>
            <span className="label">projection lag</span>
            <span
              className={`metric mono sev-${lagSeverity(lag.projectionLagEvents)}`}
              data-testid="projection-lag"
            >
              {lag.projectionLagEvents} events
            </span>
          </div>
          <div className="stack" style={{ gap: 2 }}>
            <span className="label">last sequence</span>
            <span className="metric mono">{lag.lastSequence}</span>
          </div>
        </div>

        <div className="row">
          <span className="badge sev-warn">{alerts.warn} warn</span>
          <span className="badge sev-error">{alerts.error} error</span>
          <span className="badge sev-critical">{alerts.critical} critical</span>
        </div>

        <div className="stack">
          <span className="label">health samples</span>
          {samples.length === 0 ? (
            <p className="muted">No health samples recorded.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {samples.map((sample) => (
                <li key={sample.metric} className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="mono">{sample.metric}</span>
                  <span className="metric mono">
                    {sample.value}
                    {sample.unit ? ` ${sample.unit}` : ''}
                    {sample.status ? ` · ${sample.status}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {diagnostics.projectionDiagnostics.length > 0 ? (
          <div className="banner banner--error" role="alert" data-testid="projection-diagnostics">
            <span className="banner__body">
              {diagnostics.projectionDiagnostics.length} projection integrity issue(s): replay is
              missing or has corrupt events.
            </span>
          </div>
        ) : null}

        <div className="stack">
          <span className="label">active failures</span>
          {diagnostics.activeFailures.length === 0 ? (
            <p className="muted">No active failures.</p>
          ) : (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 8 }}>
              {diagnostics.activeFailures.map((failure) => (
                <li key={`${failure.type}-${failure.sequence}`} className="stack" style={{ gap: 2 }}>
                  <span className="row">
                    <span className={`badge sev-${failure.severity}`}>
                      <span className="badge__dot" aria-hidden="true" />
                      {failure.type}
                    </span>
                    {failure.blocking ? <span className="badge sev-error">blocking</span> : null}
                    <span className="badge">{failure.retryable ? 'retryable' : 'not retryable'}</span>
                  </span>
                  <span className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
                    Rescue: {failure.rescueAction}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
