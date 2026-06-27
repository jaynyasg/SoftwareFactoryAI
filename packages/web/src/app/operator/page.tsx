/**
 * Operator dashboard (server component). The operator-facing surface — distinct
 * from the user run page — loads the operator aggregate (operator projection +
 * computed metrics + per-run diagnostics) for the requested run id (or the latest
 * run) and renders the read-only health / adapter / queue / deploy panels.
 *
 * Scoped to a run id via `?runId=` so the dashboard is deterministic and
 * parallel-safe: it never silently follows a newer run started elsewhere.
 */
import { loadOperatorAggregate } from '../../server/run-data';
import { runStatusSeverity } from '../../lib/run-view';
import { AppShell } from '../../components/AppShell';
import { Mono } from '../../components/factory-floor/primitives';
import { HealthPanel } from '../../components/operator/HealthPanel';
import { AdapterPanel } from '../../components/operator/AdapterPanel';
import { QueuePanel } from '../../components/operator/QueuePanel';
import { DeployPanel } from '../../components/operator/DeployPanel';

export const dynamic = 'force-dynamic';

export default async function OperatorPage({
  searchParams,
}: {
  searchParams: Promise<{ runId?: string }>;
}) {
  const { runId } = await searchParams;
  const data = await loadOperatorAggregate(runId);

  return (
    <AppShell>
      <section className="panel" aria-label="Operator dashboard">
        <header className="panel__header">
          <div className="row" style={{ gap: 'var(--space-8)' }}>
            <h2 className="panel__title">Operator dashboard</h2>
            {data !== null ? <Mono value={data.runId ?? 'unknown'} max={24} /> : null}
          </div>
          {data !== null ? (
            <span className={`badge sev-${runStatusSeverity(data.run.status)}`}>
              <span className="badge__dot" aria-hidden="true" />
              {data.run.status}
            </span>
          ) : null}
        </header>
        <div className="panel__body">
          {data === null ? (
            <p className="muted" data-testid="operator-empty">
              No run to inspect yet. Start a run from the Factory Floor, then open the operator
              dashboard (optionally scope it with <span className="mono">?runId=</span>).
            </p>
          ) : (
            <p className="muted">
              Health, adapters, queue, and deploy diagnostics for this run — projected from the
              ledger, read-only.
            </p>
          )}
        </div>
      </section>

      {data !== null ? (
        <div className="run-grid">
          <div className="run-grid__main">
            <HealthPanel
              metrics={data.metrics}
              operator={data.operator}
              diagnostics={data.diagnostics}
            />
            <QueuePanel metrics={data.metrics} />
          </div>
          <div className="run-grid__side">
            <AdapterPanel metrics={data.metrics} />
            <DeployPanel metrics={data.metrics} />
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
