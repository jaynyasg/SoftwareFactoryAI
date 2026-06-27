/**
 * RunBoard — the run switcher. Lists projected runs (status + prompt + id) with
 * links into each run's detail surface. Status carries a severity label, never
 * color alone (§7).
 */
import Link from 'next/link';
import type { RunProjection } from '@software-factory/core';
import { runStatusSeverity } from '../../lib/run-view';
import { Mono, SeverityBadge } from './primitives';

export function RunBoard({
  runs,
  totalCount = runs.length,
  cleared = false,
  onClear,
  onRestore,
}: {
  readonly runs: readonly RunProjection[];
  readonly totalCount?: number;
  readonly cleared?: boolean;
  readonly onClear?: () => void;
  readonly onRestore?: () => void;
}) {
  return (
    <section className="panel run-history" aria-label="Runs">
      <header className="panel__header">
        <h2 className="panel__title">Runs</h2>
        <span className="row" style={{ justifyContent: 'flex-end' }}>
          <span className="panel__hint">{totalCount} total</span>
          {cleared ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={onRestore}>
              Show history
            </button>
          ) : totalCount > 0 ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={onClear}>
              Clear view
            </button>
          ) : null}
        </span>
      </header>
      <div className="panel__body">
        {cleared ? (
          <p className="muted">Run history is hidden for this screen.</p>
        ) : runs.length === 0 ? (
          <p className="muted">No runs yet.</p>
        ) : (
          <ul className="stack run-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
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
