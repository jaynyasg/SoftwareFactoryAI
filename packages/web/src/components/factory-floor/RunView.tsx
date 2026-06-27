'use client';

/**
 * RunView — the assembled Factory Floor run surface (DESIGN.md §5/§9).
 *
 * Presentational: the parent owns polling and passes the live projected
 * snapshot, the accumulated ledger rows, the reconnect flag, and a refresh
 * callback. RunView lays out the supervisor, tickets, workers, the trace ledger
 * spine, the review studio, deploy status, and the artifact drawer, and handles
 * the responsive drawer (inline on desktop, overlay on tablet/mobile). All data
 * is projected from events — nothing is invented.
 */
import { useEffect, useState } from 'react';
import type { LedgerRow } from '@software-factory/core';
import type { RunAggregate } from '../../lib/types';
import { runStatusSeverity } from '../../lib/run-view';
import { SupervisorPanel } from './SupervisorPanel';
import { WorkerBoard } from './WorkerBoard';
import { TicketCard } from './TicketCard';
import { TraceLedger } from './TraceLedger';
import { ReviewStudio } from './ReviewStudio';
import { DeployStatus } from './DeployStatus';
import { ArtifactDrawer } from './ArtifactDrawer';
import { Mono, SeverityBadge } from './primitives';

function useIsSmall(): boolean {
  const [small, setSmall] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1279px)');
    const update = (): void => setSmall(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return small;
}

export function RunView({
  snapshot,
  rows,
  reconnecting,
  refresh,
}: {
  readonly snapshot: RunAggregate;
  readonly rows: readonly LedgerRow[];
  readonly reconnecting: boolean;
  readonly refresh: () => void;
}) {
  const { run, tickets, artifacts, operator, deploy, reviews } = snapshot;
  const runId = run.runId ?? 'unknown';
  const reducedTrust = operator.sandboxFallback;
  const [selected, setSelected] = useState<string | null>(null);
  const isSmall = useIsSmall();

  const throttleReasons = operator.alerts
    .filter((alert) => alert.type === 'adapter.capacity_changed')
    .map((alert) => alert.message);

  const drawerArtifacts = selected
    ? artifacts.filter((artifact) => artifact.ticketId === selected)
    : [];
  const drawerRows = selected ? rows.filter((row) => row.ticketId === selected) : [];

  return (
    <div className="stack" style={{ gap: 'var(--space-16)' }}>
      <section className="panel" aria-label="Run summary">
        <header className="panel__header">
          <div className="row" style={{ gap: 'var(--space-8)' }}>
            <h2 className="panel__title">Run</h2>
            <Mono value={runId} max={24} />
          </div>
          <SeverityBadge severity={runStatusSeverity(run.status)} label={run.status} />
        </header>
        <div className="panel__body">
          {run.prompt ? (
            <p style={{ fontSize: 'var(--fs-sm)' }}>{run.prompt}</p>
          ) : run.prdRef ? (
            <div className="row">
              <span className="label">PRD</span>
              <Mono value={run.prdRef} max={40} />
            </div>
          ) : (
            <p className="muted">No prompt or PRD recorded.</p>
          )}
          <div className="row">
            {run.plannedTicketCount !== undefined ? (
              <span className="badge">{run.plannedTicketCount} tickets planned</span>
            ) : null}
            {run.reviewMode ? <span className="badge">review: {run.reviewMode}</span> : null}
            {run.requestedWorkerCap !== undefined ? (
              <span className="badge">cap {run.requestedWorkerCap}</span>
            ) : null}
          </div>
          {reducedTrust ? (
            <div className="banner banner--warn" role="status" data-testid="run-reduced-trust">
              <span className="banner__body">
                Reduced-trust: a sandbox fallback occurred during this run.
              </span>
            </div>
          ) : null}
        </div>
      </section>

      <div className="run-grid">
        <div className="run-grid__main">
          <SupervisorPanel decisions={run.supervisorDecisions} tickets={tickets} />

          <section className="panel" aria-label="Tickets">
            <header className="panel__header">
              <h2 className="panel__title">Tickets</h2>
              <span className="panel__hint">{tickets.length} total</span>
            </header>
            <div className="panel__body">
              {tickets.length === 0 ? (
                <p className="muted">No tickets yet — the supervisor has not planned this run.</p>
              ) : (
                <div className="ticket-grid">
                  {tickets.map((ticket) => (
                    <TicketCard
                      key={ticket.ticketId}
                      ticket={ticket}
                      reducedTrust={reducedTrust}
                      onOpen={setSelected}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>

          <WorkerBoard
            tickets={tickets}
            requestedCap={run.requestedWorkerCap}
            adapterCapacity={operator.adapterCapacity}
            throttleReasons={throttleReasons}
          />
        </div>

        <div className="run-grid__side">
          <TraceLedger
            rows={rows}
            lastSequence={snapshot.lastSequence}
            reconnecting={reconnecting}
            diagnostics={run.diagnostics}
          />
          <ReviewStudio
            runId={runId}
            reviewMode={run.reviewMode ?? 'human'}
            expectedVersion={snapshot.lastSequence}
            reviews={reviews}
            artifacts={artifacts}
            counts={operator.counts}
            reducedTrust={reducedTrust}
            onReload={refresh}
          />
          <DeployStatus deploy={deploy} />
          {!isSmall ? (
            <ArtifactDrawer
              ticketId={selected}
              artifacts={drawerArtifacts}
              rows={drawerRows}
              onClose={() => setSelected(null)}
            />
          ) : null}
        </div>
      </div>

      {isSmall && selected !== null ? (
        <ArtifactDrawer
          ticketId={selected}
          artifacts={drawerArtifacts}
          rows={drawerRows}
          overlay
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
