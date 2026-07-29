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
import { useExecutionOverview, useResetGenerationGuard } from '../../lib/use-execution-overview';
import { useRunAggregate } from '../../lib/use-run-aggregate';
import { ResetReloadBanner } from './FactoryCommandBar';
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
  const { overview } = useExecutionOverview(initialExecution);
  const execution = overview.execution;
  // R15: a factory reset from another surface wiped this tab's credentials —
  // the same forced-reload banner the floor shows, with commands locked.
  const resetDetected = useResetGenerationGuard(overview.resetGeneration);

  return (
    <div className="stack" style={{ gap: 'var(--space-16)' }}>
      {resetDetected ? <ResetReloadBanner /> : null}
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
          lastSequence={snapshot.lastSequence}
          preview={snapshot.preview}
          deploy={snapshot.deploy}
          onChanged={live.refresh}
          disabled={resetDetected}
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
