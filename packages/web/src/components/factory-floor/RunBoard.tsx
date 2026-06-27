/**
 * RunBoard — the run switcher. Lists projected runs (status + prompt + id) with
 * links into each run's detail surface. Status carries a severity label, never
 * color alone (§7).
 */
import Link from 'next/link';
import type { RunProjection } from '@software-factory/core';
import { runStatusSeverity } from '../../lib/run-view';
import { Mono, SeverityBadge } from './primitives';

export function RunBoard({ runs }: { readonly runs: readonly RunProjection[] }) {
  return (
    <section className="panel" aria-label="Runs">
      <header className="panel__header">
        <h2 className="panel__title">Runs</h2>
        <span className="panel__hint">{runs.length} total</span>
      </header>
      <div className="panel__body">
        {runs.length === 0 ? (
          <p className="muted">No runs yet.</p>
        ) : (
          <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {runs.map((run) =>
              run.runId === null ? null : (
                <li key={run.runId} className="run-list__item">
                  <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                    <span style={{ fontWeight: 'var(--fw-medium)' }}>
                      {run.prompt ?? run.prdRef ?? 'Untitled run'}
                    </span>
                    <Mono value={run.runId} max={22} copyable={false} />
                  </span>
                  <span className="row" style={{ flex: 'none' }}>
                    <SeverityBadge severity={runStatusSeverity(run.status)} label={run.status} />
                    <Link className="btn btn--sm btn--ghost" href={`/runs/${run.runId}`}>
                      Open
                    </Link>
                  </span>
                </li>
              ),
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
