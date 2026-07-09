'use client';

/**
 * RunStrip — the compact cross-run strip (DESIGN.md §5, U9). One chip per
 * projected run: status severity + label, middle-truncated id, and an open
 * intervention count when the run needs a human. Pressing a chip FOCUSES the
 * blueprint on that run — the lanes always render exactly one run, never a
 * mixed view. This is a switcher, not a dashboard: dense, single row, wraps.
 */
import type { RunProjection } from '@software-factory/core';
import { middleTruncate, runStatusSeverity, severityClass } from '../../lib/run-view';

/** Keep the strip a strip: newest runs only; the run board holds the rest. */
const MAX_CHIPS = 6;

export function RunStrip({
  runs,
  focusedRunId,
  openInterventionsByRun = {},
  onFocus,
}: {
  readonly runs: readonly RunProjection[];
  readonly focusedRunId: string | null;
  /** Open intervention count per run id (from the cross-run queue). */
  readonly openInterventionsByRun?: Readonly<Record<string, number>>;
  readonly onFocus: (runId: string) => void;
}) {
  if (runs.length === 0) {
    return null;
  }
  // Newest-first slice, but never hide the FOCUSED run from its own switcher.
  const visible = runs.slice(0, MAX_CHIPS);
  const focused = runs.find((run) => run.runId === focusedRunId);
  if (focused !== undefined && !visible.includes(focused)) {
    visible[visible.length - 1] = focused;
  }
  const hiddenCount = runs.length - visible.length;
  return (
    <div className="run-strip" role="group" aria-label="Focus run">
      {visible.map((run) => {
        if (run.runId === null) {
          return null;
        }
        const runId = run.runId;
        const focused = runId === focusedRunId;
        const needsYou = openInterventionsByRun[runId] ?? 0;
        return (
          <button
            key={runId}
            type="button"
            className={`run-chip${focused ? ' run-chip--focused' : ''}`}
            aria-pressed={focused}
            aria-label={`Focus run ${runId}`}
            title={run.prompt ?? run.prdRef ?? runId}
            onClick={() => onFocus(runId)}
          >
            <span
              className={`badge__dot ${severityClass(runStatusSeverity(run.status))}`}
              aria-hidden="true"
            />
            <span className="mono run-chip__id" data-full={runId}>
              {middleTruncate(runId, 12)}
            </span>
            <span className={`run-chip__status ${severityClass(runStatusSeverity(run.status))}`}>
              {run.status}
            </span>
            {needsYou > 0 ? (
              <span className="badge sev-warn" title={`${needsYou} open intervention(s)`}>
                {needsYou} open
              </span>
            ) : null}
          </button>
        );
      })}
      {hiddenCount > 0 ? (
        <span className="muted" style={{ fontSize: 'var(--fs-2xs)', alignSelf: 'center' }}>
          +{hiddenCount} more in run history
        </span>
      ) : null}
    </div>
  );
}
