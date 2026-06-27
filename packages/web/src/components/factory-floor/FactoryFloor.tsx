'use client';

/**
 * FactoryFloor — the FIRST screen (DESIGN.md §5): the run surface, not a
 * marketing page. Left: prompt/PRD intake (RunControl) + the setup checklist.
 * Right: the run switcher and, when runs exist, the latest run's live surface;
 * otherwise the actionable empty state (prompt entry + setup status, no fake
 * progress — §6/§8).
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { RunProjection } from '@software-factory/core';
import type { RunAggregate, SetupStatus } from '../../lib/types';
import { runStatusSeverity } from '../../lib/run-view';
import { useRunAggregate } from '../../lib/use-run-aggregate';
import { RunControl } from './RunControl';
import { SetupChecklist } from './SetupChecklist';
import { RunBoard } from './RunBoard';
import { Mono, SeverityBadge, StateBlock } from './primitives';

function ActiveRun({ aggregate }: { readonly aggregate: RunAggregate }) {
  const runId = aggregate.run.runId ?? 'unknown';
  const live = useRunAggregate(runId, aggregate);
  const { run } = live.snapshot;
  return (
    <section className="panel active-run" aria-label="Active run">
      <header className="panel__header">
        <h2 className="panel__title">Active run</h2>
        <SeverityBadge severity={runStatusSeverity(run.status)} label={run.status} />
      </header>
      <div className="panel__body active-run__body">
        <div className="stack" style={{ gap: 'var(--space-4)' }}>
          <span className="active-run__title">{run.prompt ?? run.prdRef ?? 'Untitled run'}</span>
          <Mono value={run.runId ?? runId} max={28} copyable={false} />
        </div>
        <div className="run-metrics" aria-label="Run metrics">
          <span className="run-metric">
            <span className="label">tickets</span>
            <span className="mono">{run.plannedTicketCount ?? live.snapshot.tickets.length}</span>
          </span>
          <span className="run-metric">
            <span className="label">sequence</span>
            <span className="mono">{live.snapshot.lastSequence}</span>
          </span>
          <span className="run-metric">
            <span className="label">cap</span>
            <span className="mono">{run.requestedWorkerCap ?? 'unset'}</span>
          </span>
          <span className="run-metric">
            <span className="label">effort</span>
            <span className="mono">{run.reasoningEffort ?? 'unset'}</span>
          </span>
        </div>
        <div className="row">
          <Link className="btn btn--sm btn--ghost" href={`/runs/${runId}`}>
            Open run
          </Link>
          {live.reconnecting ? <span className="badge">reconnecting</span> : null}
        </div>
      </div>
    </section>
  );
}

export function FactoryFloor({
  initialRuns,
  setup,
  latest,
}: {
  readonly initialRuns: readonly RunProjection[];
  readonly setup: SetupStatus;
  readonly latest: RunAggregate | null;
}) {
  const router = useRouter();
  const [historyCleared, setHistoryCleared] = useState(false);
  const visibleRuns = historyCleared ? [] : initialRuns;

  return (
    <div className="factory-screen">
      <div className="factory-screen__top">
        <RunControl
          defaultLocalFolder={setup.workspace.root}
          onStarted={(runId) => {
            setHistoryCleared(false);
            router.push(`/runs/${runId}`);
          }}
        />
        <SetupChecklist setup={setup} />
        {latest !== null ? (
          <ActiveRun aggregate={latest} />
        ) : (
          <StateBlock
            variant="empty"
            title="No active run"
            action={<span className="muted">Start a run from the control panel.</span>}
          >
            The factory floor is idle. No ticket, worker, ledger, or deploy progress is implied.
          </StateBlock>
        )}
      </div>

      <div className="factory-screen__history">
        <RunBoard
          runs={visibleRuns}
          totalCount={initialRuns.length}
          cleared={historyCleared}
          onClear={() => setHistoryCleared(true)}
          onRestore={() => setHistoryCleared(false)}
        />
      </div>
    </div>
  );
}
