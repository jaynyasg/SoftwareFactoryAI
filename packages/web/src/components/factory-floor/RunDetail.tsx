'use client';

/**
 * RunDetail — a single run's detail surface. Owns live polling and pairs the
 * COMPACT run command bar (U9: start/pause/resume/retry/cancel + preview and
 * deploy badges — the detail page is about THIS run, not new-run intake) with
 * the assembled RunView.
 */
import Link from 'next/link';
import type { RunAggregate } from '../../lib/types';
import { useRunAggregate } from '../../lib/use-run-aggregate';
import { RunCommandBar } from './RunCommandBar';
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
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="row" style={{ flex: 'none' }}>
          <Link className="btn btn--sm btn--ghost" href="/">
            ← Factory floor
          </Link>
          <Link
            className="btn btn--sm btn--ghost"
            href={`/operator?runId=${encodeURIComponent(runId)}`}
          >
            Operator view
          </Link>
        </span>
        <RunCommandBar
          runId={runId}
          status={snapshot.run.status}
          executionState={snapshot.run.executionState}
          executionReason={snapshot.run.executionReason}
          lastSequence={snapshot.lastSequence}
          preview={snapshot.preview}
          deploy={snapshot.deploy}
          onChanged={live.refresh}
        />
      </div>
      <RunView
        snapshot={snapshot}
        rows={live.rows}
        reconnecting={live.reconnecting}
        refresh={live.refresh}
      />
    </div>
  );
}
