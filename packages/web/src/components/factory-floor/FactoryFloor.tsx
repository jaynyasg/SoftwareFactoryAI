'use client';

/**
 * FactoryFloor — the FIRST screen (DESIGN.md §5): the run surface, not a
 * marketing page. Left: prompt/PRD intake (RunControl) + the setup checklist.
 * Right: the run switcher and, when runs exist, the latest run's live surface;
 * otherwise the actionable empty state (prompt entry + setup status, no fake
 * progress — §6/§8).
 */
import { useRouter } from 'next/navigation';
import type { RunProjection } from '@software-factory/core';
import type { RunAggregate, SetupStatus } from '../../lib/types';
import { useRunAggregate } from '../../lib/use-run-aggregate';
import { RunControl } from './RunControl';
import { SetupChecklist } from './SetupChecklist';
import { RunBoard } from './RunBoard';
import { RunView } from './RunView';
import { StateBlock } from './primitives';

function LatestRun({ aggregate }: { readonly aggregate: RunAggregate }) {
  const runId = aggregate.run.runId ?? 'unknown';
  const live = useRunAggregate(runId, aggregate);
  return (
    <div className="stack" style={{ gap: 'var(--space-8)' }}>
      <span className="label">latest run</span>
      <RunView
        snapshot={live.snapshot}
        rows={live.rows}
        reconnecting={live.reconnecting}
        refresh={live.refresh}
      />
    </div>
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

  return (
    <div className="home-grid">
      <div className="home-grid__intake">
        <RunControl onStarted={(runId) => router.push(`/runs/${runId}`)} />
        <SetupChecklist setup={setup} />
      </div>

      <div className="home-grid__runs">
        {initialRuns.length === 0 ? (
          <StateBlock
            variant="empty"
            title="No runs yet"
            action={
              <span className="muted">Enter a prompt or PRD on the left to start the factory.</span>
            }
          >
            The factory floor is idle. Nothing is running and no progress is implied — start a run
            to populate the supervisor, workers, trace ledger, and review studio.
          </StateBlock>
        ) : (
          <>
            <RunBoard runs={initialRuns} />
            {latest !== null ? <LatestRun aggregate={latest} /> : null}
          </>
        )}
      </div>
    </div>
  );
}
