'use client';

/**
 * RunDetail — a single run's detail surface. Owns live polling and pairs the
 * COMPACT run command bar (U9: start/pause/resume/retry/cancel + preview and
 * deploy badges — the detail page is about THIS run, not new-run intake) with
 * the assembled RunView. A compact badge surfaces the factory-wide drain gate
 * (queued work on THIS run waits behind it), polled from the same execution
 * overview the factory floor uses.
 */
import Link from 'next/link';
import type { ExecutionOverview, RunAggregate } from '../../lib/types';
import { DISABLED_EXECUTION_OVERVIEW } from '../../lib/execution-overview';
import { useExecutionOverview } from '../../lib/use-execution-overview';
import { useRunAggregate } from '../../lib/use-run-aggregate';
import { RunCommandBar } from './RunCommandBar';
import { RunView } from './RunView';

export function RunDetail({
  runId,
  initial,
  initialExecution = DISABLED_EXECUTION_OVERVIEW,
}: {
  readonly runId: string;
  readonly initial: RunAggregate;
  readonly initialExecution?: ExecutionOverview;
}) {
  const live = useRunAggregate(runId, initial);
  const { snapshot } = live;
  const execution = useExecutionOverview(initialExecution).overview.execution;

  return (
    <div className="stack" style={{ gap: 'var(--space-16)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="row" style={{ flex: 'none' }}>
          <Link className="btn btn--sm" href="/">
            ← Factory floor
          </Link>
          <Link className="btn btn--sm" href={`/operator?runId=${encodeURIComponent(runId)}`}>
            Status view
          </Link>
          {execution.enabled && execution.held ? (
            <span className="badge sev-warn" data-testid="factory-held-badge">
              factory execution held
            </span>
          ) : null}
        </span>
        <RunCommandBar
          runId={runId}
          status={snapshot.run.status}
          executionState={snapshot.run.executionState}
          executionReason={snapshot.run.executionReason}
          hasExecutionJob={snapshot.executionJob !== null}
          selectedAdapter={snapshot.run.selectedAdapter}
          modelProfile={snapshot.run.modelProfile}
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
