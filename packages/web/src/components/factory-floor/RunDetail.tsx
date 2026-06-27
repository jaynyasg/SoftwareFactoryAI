'use client';

/**
 * RunDetail — a single run's detail surface. Owns live polling and shares the
 * snapshot between RunControl (active-run controls: preview status, deploy
 * summary, cancel) and the assembled RunView.
 */
import Link from 'next/link';
import type { RunAggregate } from '../../lib/types';
import { useRunAggregate } from '../../lib/use-run-aggregate';
import { RunControl } from './RunControl';
import { RunView } from './RunView';

export function RunDetail({
  runId,
  initial,
}: {
  readonly runId: string;
  readonly initial: RunAggregate;
}) {
  const live = useRunAggregate(runId, initial);
  const { snapshot } = live;

  return (
    <div className="stack" style={{ gap: 'var(--space-16)' }}>
      <div className="row">
        <Link className="btn btn--sm btn--ghost" href="/">
          ← Factory floor
        </Link>
      </div>
      <RunControl
        activeRun={{
          runId,
          status: snapshot.run.status,
          lastSequence: snapshot.lastSequence,
        }}
        preview={snapshot.preview}
        deploy={snapshot.deploy}
        onChanged={live.refresh}
        onStarted={(newRunId) => {
          window.location.href = `/runs/${newRunId}`;
        }}
      />
      <RunView
        snapshot={snapshot}
        rows={live.rows}
        reconnecting={live.reconnecting}
        refresh={live.refresh}
      />
    </div>
  );
}
