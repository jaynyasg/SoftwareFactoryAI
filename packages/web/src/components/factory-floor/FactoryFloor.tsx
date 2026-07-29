'use client';

/**
 * FactoryFloor — the FIRST screen (DESIGN.md §5): the operator's control room,
 * blueprint-first (KTD7). Hierarchy (binding, from the U9 design review):
 *
 *   1. Needs you — the cross-run operator intervention queue (X4). Anything
 *      blocking on a human is always visible first.
 *   2. Blueprint — the FOCUSED run's stage pipeline (headline + lanes) plus
 *      the build-contract / preflight handoff with the compact run commands
 *      adjacent. The run strip switches focus; lanes never mix runs.
 *   3. Run controls — new-run intake (RunControl) and the setup checklist.
 *   4. Run history — bottom/secondary and archive-aware (RunBoard, U6): a
 *      "Show archived" toggle reveals archived runs with unarchive + replay;
 *      the ephemeral "Clear view" is gone — archive is the real lifecycle.
 *
 * Session lifecycle U5 (R14): the run list is LIVE (`useRunList` on the shared
 * poll cadence) — runs started from CLI/MCP appear in the strip without a
 * reload and never steal focus; auto-focus happens ONLY when no run is
 * focused. A focused run archived from another surface refocuses the newest
 * visible run — or, when none remain, the empty state — with an explicit
 * "archived — open in run history" notice either way.
 *
 * Empty factory: the intake + setup remain the actionable empty state (no fake
 * progress), and the empty intervention queue is a designed feature state.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunProjection } from '@software-factory/core';
import type { FloorStatus, RunAggregate, SetupStatus } from '../../lib/types';
import { DISABLED_EXECUTION_OVERVIEW } from '../../lib/execution-overview';
import {
  deriveFactoryNeedsYou,
  deriveFactoryPulse,
  deriveStatusHeadline,
} from '../../lib/run-view';
import { useRunAggregate } from '../../lib/use-run-aggregate';
import { useFloorStatus } from '../../lib/use-floor-status';
import { useRunList } from '../../lib/use-run-list';
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
import { Mono, StateBlock } from './primitives';

/** Safe default when the server provided no floor payload (tests, degraded SSR). */
const EMPTY_FLOOR: FloorStatus = {
  overview: DISABLED_EXECUTION_OVERVIEW,
  interventionQueue: { interventions: [], openCount: 0 },
};

/** The live blueprint for one focused run (owns the run's polling). */
function LiveBlueprint({
  runId,
  initial,
  onUnpairedReviews,
}: {
  readonly runId: string;
  readonly initial: RunAggregate;
  /**
   * Reports the focused run's UNPAIRED pending-review count upward so the
   * floor's factory-wide needs-you number can include reviews the cross-run
   * intervention poll cannot see (union rule, R3).
   */
  readonly onUnpairedReviews?: (count: number) => void;
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
  const headline = deriveStatusHeadline({
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
    reviews: snapshot.reviews,
    interventions: snapshot.interventions,
  });

  // Lift only the derived COUNT (a stable primitive) so the effect fires when
  // the projected reviews change, not on every poll's new object identities.
  const { unpairedReviewCount } = headline;
  useEffect(() => {
    onUnpairedReviews?.(unpairedReviewCount);
    return () => onUnpairedReviews?.(0);
  }, [onUnpairedReviews, unpairedReviewCount]);

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
        headline={headline}
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
  onUnpairedReviews,
}: {
  readonly runId: string;
  readonly latest: RunAggregate | null;
  readonly onUnpairedReviews?: (count: number) => void;
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
    return (
      <LiveBlueprint
        key={runId}
        runId={runId}
        initial={latest}
        onUnpairedReviews={onUnpairedReviews}
      />
    );
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
  return (
    <LiveBlueprint
      key={runId}
      runId={runId}
      initial={fetched}
      onUnpairedReviews={onUnpairedReviews}
    />
  );
}

export function FactoryFloor({
  initialRuns,
  setup,
  latest,
  initialFloor = EMPTY_FLOOR,
}: {
  readonly initialRuns: readonly RunProjection[];
  readonly setup: SetupStatus;
  readonly latest: RunAggregate | null;
  /** Server-rendered combined floor payload (overview + intervention queue). */
  readonly initialFloor?: FloorStatus;
}) {
  const router = useRouter();
  /**
   * History view open (U6/AE2). Lifted HERE (not RunBoard-local) so the
   * archived-elsewhere notice and the no-visible-runs empty state can open
   * the history directly — the "open it from run history" copy is a real
   * affordance, not a hint. The pre-U6 ephemeral "Clear view" state is gone:
   * archive is the one true way a run leaves the floor.
   */
  const [showArchivedHistory, setShowArchivedHistory] = useState(false);
  const [focusedRunId, setFocusedRunId] = useState<string | null>(
    latest?.run.runId ?? initialRuns[0]?.runId ?? null,
  );
  /** Set when the focused run left the visible list (archived elsewhere, R14). */
  const [archivedElsewhere, setArchivedElsewhere] = useState<string | null>(null);
  /** The focused run's unpaired pending-review count, lifted from the blueprint. */
  const [focusedUnpairedReviews, setFocusedUnpairedReviews] = useState(0);
  // ONE poll loop feeds the command bar AND the intervention queue (the
  // focused blueprint keeps its own run-scoped loop) — one request and one
  // server-side ledger read per tick instead of two. The run LIST polls its
  // own resource on the same cadence (R14 liveness).
  const live = useFloorStatus(initialFloor);
  const runList = useRunList(initialRuns);
  const runs = runList.runs;

  // R14 focus rules: auto-focus ONLY when nothing is focused (empty floor);
  // otherwise external runs appear in the strip without stealing focus. A
  // focused run that LEAVES the visible list (it was there, now it is not)
  // was archived from another surface: refocus the newest visible run, or
  // fall to the empty state — both with an explicit notice. The was-visible
  // check matters twice: a just-started run is focused BEFORE the next list
  // poll can include it, and a failed poll keeps the last good list
  // (usePolledResource) — neither may ever read as "archived".
  const seenRunIds = useRef<ReadonlySet<string>>(
    new Set(initialRuns.map((run) => run.runId).filter((id): id is string => id !== null)),
  );
  useEffect(() => {
    const ids = new Set(runs.map((run) => run.runId).filter((id): id is string => id !== null));
    const wasVisible = seenRunIds.current;
    seenRunIds.current = ids;
    if (focusedRunId === null) {
      const first = runs[0]?.runId;
      if (first !== undefined && first !== null) {
        setFocusedRunId(first);
      }
      return;
    }
    if (!ids.has(focusedRunId) && wasVisible.has(focusedRunId)) {
      setArchivedElsewhere(focusedRunId);
      setFocusedRunId(runs.find((run) => run.runId !== null)?.runId ?? null);
    }
  }, [runs, focusedRunId]);

  const openByRun = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of live.floor.interventionQueue.interventions) {
      if (item.status === 'open') {
        counts[item.runId] = (counts[item.runId] ?? 0) + 1;
      }
    }
    return counts;
  }, [live.floor.interventionQueue.interventions]);

  // Factory-wide needs-you (R3): cross-run open interventions + the focused
  // run's unpaired pending reviews (the union rule — interventions alone lie
  // when a review awaits a decision).
  const factoryNeedsYou = deriveFactoryNeedsYou(live.floor.interventionQueue.interventions, {
    unpairedReviewCount: focusedUnpairedReviews,
  });

  const focusRun = (runId: string) => {
    setArchivedElsewhere(null);
    setFocusedRunId(runId);
  };

  const operatorHref =
    focusedRunId !== null ? `/operator?runId=${encodeURIComponent(focusedRunId)}` : '/operator';

  return (
    <div className="factory-screen">
      {/* Nav + the compact cross-run strip share one row (density, KTD7). */}
      <div className="factory-screen__nav" aria-label="Factory view switcher">
        <span className="label">Factory floor</span>
        {factoryNeedsYou > 0 ? (
          <span
            className="badge sev-warn"
            data-testid="factory-needs-you"
            title="Open interventions across every run plus the focused run's pending reviews"
          >
            {factoryNeedsYou} need{factoryNeedsYou === 1 ? 's' : ''} you
          </span>
        ) : null}
        <RunStrip
          runs={runs}
          focusedRunId={focusedRunId}
          openInterventionsByRun={openByRun}
          onFocus={focusRun}
        />
        <Link className="btn btn--sm btn--ghost factory-screen__nav-link" href={operatorHref}>
          Operator view
        </Link>
      </div>

      {/* 0 — factory-wide controls: the held/resume gate (nothing runs
          automatically on open) and the destructive cancel-all command. */}
      <FactoryCommandBar
        overview={live.floor.overview}
        reconnecting={live.reconnecting}
        onRefresh={() => {
          live.refresh();
          runList.refresh();
        }}
        onChanged={() => {
          // A resume/hold/cancel-all changes every run's projected state:
          // re-render the server-provided props (the floor loop already
          // re-polled via onRefresh).
          router.refresh();
        }}
      />

      {/* 1 — anything blocking on a human, across every run, always first. */}
      <InterventionQueue
        snapshot={live.floor.interventionQueue}
        reconnecting={live.reconnecting}
        focusedRunId={focusedRunId}
        onFocusRun={focusRun}
        onResolved={live.refresh}
      />

      {/* R14: the archived-elsewhere notice is explicit, dismissible, and
          survives the refocus — never a silently vanished run. Since U6 the
          "run history" copy is a REAL affordance: the button opens the
          board's archived history directly. */}
      {archivedElsewhere !== null ? (
        <div className="state-block" role="status" data-testid="archived-elsewhere-notice">
          <span>
            Run <Mono value={archivedElsewhere} max={20} copyable={false} /> was archived from
            another surface — open it from run history.
          </span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setShowArchivedHistory(true)}
          >
            Open run history
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => setArchivedElsewhere(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* 2 — the focused run's blueprint: headline + pipeline lanes + handoff. */}
      <section className="factory-screen__blueprint" aria-label="Blueprint region">
        {focusedRunId !== null ? (
          // Keyed by run id: switching focus must remount FocusedBlueprint so
          // the previous run's fetched/error state can never flash through.
          <FocusedBlueprint
            key={focusedRunId}
            runId={focusedRunId}
            latest={latest}
            onUnpairedReviews={setFocusedUnpairedReviews}
          />
        ) : (
          <StateBlock
            variant="empty"
            title={archivedElsewhere !== null ? 'No visible runs' : 'No active run'}
            action={
              archivedElsewhere !== null ? (
                <span className="row">
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => setShowArchivedHistory(true)}
                  >
                    Open run history
                  </button>
                  <span className="muted">or start a run from the control panel below.</span>
                </span>
              ) : (
                <span className="muted">Start a run from the control panel below.</span>
              )
            }
          >
            {archivedElsewhere !== null
              ? 'The focused run was archived — open it from run history, or start a fresh run.'
              : 'The blueprint lights up lane by lane — research, planning, workers, gates, package, deploy — as soon as a run exists. No progress is implied until events say so.'}
          </StateBlock>
        )}
      </section>

      {/* 3 — run controls: new-run intake + setup readiness. */}
      <div className="factory-screen__controls">
        <RunControl
          defaultLocalFolder={setup.workspace.root}
          onStarted={(runId) => {
            focusRun(runId);
            router.push(`/runs/${runId}`);
          }}
        />
        <SetupChecklist setup={setup} />
      </div>

      {/* 4 — run history: bottom, secondary, archive-aware (U6); focus is
          preserved. Unarchive re-polls the shared list so the returning run
          is confirmed within one round trip, never optimistically. */}
      <div className="factory-screen__history">
        <RunBoard
          runs={runs}
          totalCount={runs.length}
          focusedRunId={focusedRunId}
          onFocus={focusRun}
          showArchived={showArchivedHistory}
          onToggleArchived={() => setShowArchivedHistory((open) => !open)}
          onLifecycleChanged={runList.refresh}
        />
      </div>
    </div>
  );
}
