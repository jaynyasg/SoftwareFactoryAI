'use client';

/**
 * FactoryFloor — the FIRST screen (DESIGN.md §5): the operator's control room,
 * blueprint-first (KTD7). Hierarchy (binding, from the U9 design review):
 *
 *   1. Needs you — the cross-run operator intervention queue (X4). Anything
 *      blocking on a human is always visible first.
 *   2. Blueprint — the FOCUSED run's pipeline lanes plus the build-contract /
 *      preflight handoff with the compact run commands adjacent. The run strip
 *      switches focus; lanes never mix runs.
 *   3. Run controls — new-run intake (RunControl) and the setup checklist.
 *   4. Run history — collapsed/secondary and clearable (RunBoard); clearing
 *      the view never drops the focused blueprint.
 *
 * Empty factory: the intake + setup remain the actionable empty state (no fake
 * progress), and the empty intervention queue is a designed feature state.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { RunProjection } from '@software-factory/core';
import type {
  ExecutionOverview,
  InterventionQueueSnapshot,
  RunAggregate,
  SetupStatus,
} from '../../lib/types';
import { DISABLED_EXECUTION_OVERVIEW } from '../../lib/execution-overview';
import { deriveFactoryPulse } from '../../lib/run-view';
import { useRunAggregate } from '../../lib/use-run-aggregate';
import { useInterventionQueue } from '../../lib/use-intervention-queue';
import { fetchAggregate } from '../../lib/api-client';
import { RunControl } from './RunControl';
import { SetupChecklist } from './SetupChecklist';
import { RunBoard } from './RunBoard';
import { RunStrip } from './RunStrip';
import { BlueprintLanes } from './BlueprintLanes';
import { ContractHandoff } from './ContractHandoff';
import { RunCommandBar } from './RunCommandBar';
import { FactoryCommandBar } from './FactoryCommandBar';
import { InterventionQueue } from './InterventionQueue';
import { StateBlock } from './primitives';

const EMPTY_QUEUE: InterventionQueueSnapshot = { interventions: [], openCount: 0 };

/** The live blueprint for one focused run (owns the run's polling). */
function LiveBlueprint({
  runId,
  initial,
}: {
  readonly runId: string;
  readonly initial: RunAggregate;
}) {
  const live = useRunAggregate(runId, initial);
  const { snapshot } = live;
  const pulse = deriveFactoryPulse({
    run: snapshot.run,
    tickets: snapshot.tickets,
    operator: snapshot.operator,
    preflight: snapshot.preflight,
    interventions: snapshot.interventions,
  });

  return (
    <div className="blueprint-grid">
      <BlueprintLanes
        inputs={{
          run: snapshot.run,
          tickets: snapshot.tickets,
          research: snapshot.research,
          preflight: snapshot.preflight,
          executionJob: snapshot.executionJob,
          gates: snapshot.gates,
          repairs: snapshot.repairs,
          packageView: snapshot.packageView,
          deploy: snapshot.deploy,
          operator: snapshot.operator,
        }}
        pulse={pulse}
      />
      <ContractHandoff
        contract={snapshot.run.buildContract}
        preflight={snapshot.preflight}
        actions={
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
        }
      />
      <div className="row blueprint-grid__foot">
        <Link className="btn btn--sm btn--ghost" href={`/runs/${encodeURIComponent(runId)}`}>
          Open full run
        </Link>
        {live.reconnecting ? (
          <span className="badge sev-warn" data-testid="blueprint-reconnecting">
            reconnecting
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Loads the focused run's aggregate when it is not the server-provided latest
 * (focus switched to an older run), then hands off to the live blueprint.
 */
function FocusedBlueprint({
  runId,
  latest,
}: {
  readonly runId: string;
  readonly latest: RunAggregate | null;
}) {
  const matchesLatest = latest !== null && latest.run.runId === runId;
  const [fetched, setFetched] = useState<RunAggregate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (matchesLatest) {
      return;
    }
    let active = true;
    setFetched(null);
    setError(null);
    fetchAggregate(runId, 0).then(
      (aggregate) => {
        if (active) {
          setFetched(aggregate);
        }
      },
      (caught: unknown) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : 'Could not load the run.');
        }
      },
    );
    return () => {
      active = false;
    };
  }, [runId, matchesLatest, attempt]);

  if (matchesLatest) {
    return <LiveBlueprint key={runId} runId={runId} initial={latest} />;
  }
  if (error !== null) {
    return (
      <StateBlock
        variant="error"
        title="Could not load the focused run"
        action={
          <button type="button" className="btn btn--sm" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        }
      >
        {error}
      </StateBlock>
    );
  }
  if (fetched === null) {
    return (
      <StateBlock variant="loading" title={`Loading run ${runId}…`} testId="blueprint-loading" />
    );
  }
  return <LiveBlueprint key={runId} runId={runId} initial={fetched} />;
}

export function FactoryFloor({
  initialRuns,
  setup,
  latest,
  initialInterventions = EMPTY_QUEUE,
  initialExecution = DISABLED_EXECUTION_OVERVIEW,
}: {
  readonly initialRuns: readonly RunProjection[];
  readonly setup: SetupStatus;
  readonly latest: RunAggregate | null;
  readonly initialInterventions?: InterventionQueueSnapshot;
  readonly initialExecution?: ExecutionOverview;
}) {
  const router = useRouter();
  const [historyCleared, setHistoryCleared] = useState(false);
  const [focusedRunId, setFocusedRunId] = useState<string | null>(
    latest?.run.runId ?? initialRuns[0]?.runId ?? null,
  );
  const queue = useInterventionQueue(initialInterventions);

  const visibleRuns = historyCleared ? [] : initialRuns;
  const openByRun = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of queue.snapshot.interventions) {
      if (item.status === 'open') {
        counts[item.runId] = (counts[item.runId] ?? 0) + 1;
      }
    }
    return counts;
  }, [queue.snapshot.interventions]);

  const operatorHref =
    focusedRunId !== null ? `/operator?runId=${encodeURIComponent(focusedRunId)}` : '/operator';

  return (
    <div className="factory-screen">
      {/* Nav + the compact cross-run strip share one row (density, KTD7). */}
      <div className="factory-screen__nav" aria-label="Factory view switcher">
        <span className="label">Factory floor</span>
        <RunStrip
          runs={initialRuns}
          focusedRunId={focusedRunId}
          openInterventionsByRun={openByRun}
          onFocus={setFocusedRunId}
        />
        <Link className="btn btn--sm btn--ghost factory-screen__nav-link" href={operatorHref}>
          Operator view
        </Link>
      </div>

      {/* 0 — factory-wide controls: the held/resume gate (nothing runs
          automatically on open) and the destructive cancel-all command. */}
      <FactoryCommandBar
        initial={initialExecution}
        onChanged={() => {
          // A resume/hold/cancel-all changes every run's projected state:
          // re-render the server-provided props and re-poll the queue.
          queue.refresh();
          router.refresh();
        }}
      />

      {/* 1 — anything blocking on a human, across every run, always first. */}
      <InterventionQueue
        snapshot={queue.snapshot}
        reconnecting={queue.reconnecting}
        focusedRunId={focusedRunId}
        onFocusRun={setFocusedRunId}
        onResolved={queue.refresh}
      />

      {/* 2 — the focused run's blueprint: lanes + contract/preflight handoff. */}
      <section className="factory-screen__blueprint" aria-label="Blueprint region">
        {focusedRunId !== null ? (
          // Keyed by run id: switching focus must remount FocusedBlueprint so
          // the previous run's fetched/error state can never flash through.
          <FocusedBlueprint key={focusedRunId} runId={focusedRunId} latest={latest} />
        ) : (
          <StateBlock
            variant="empty"
            title="No active run"
            action={<span className="muted">Start a run from the control panel below.</span>}
          >
            The blueprint lights up lane by lane — research, planning, workers, gates, package,
            deploy — as soon as a run exists. No progress is implied until events say so.
          </StateBlock>
        )}
      </section>

      {/* 3 — run controls: new-run intake + setup readiness. */}
      <div className="factory-screen__controls">
        <RunControl
          defaultLocalFolder={setup.workspace.root}
          onStarted={(runId) => {
            setHistoryCleared(false);
            setFocusedRunId(runId);
            router.push(`/runs/${runId}`);
          }}
        />
        <SetupChecklist setup={setup} />
      </div>

      {/* 4 — run history: bottom, secondary, clearable; focus is preserved. */}
      <div className="factory-screen__history">
        <RunBoard
          runs={visibleRuns}
          totalCount={initialRuns.length}
          cleared={historyCleared}
          focusedRunId={focusedRunId}
          onFocus={setFocusedRunId}
          onClear={() => setHistoryCleared(true)}
          onRestore={() => setHistoryCleared(false)}
        />
      </div>
    </div>
  );
}
