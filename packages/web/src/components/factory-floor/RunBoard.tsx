'use client';

/**
 * RunBoard — run history as the BOTTOM/secondary surface (KTD7) and, since
 * U6, the archive-aware HISTORY HOST (AE2): the visible runs render live from
 * the shared run-list poll, and a "Show archived" toggle reveals archived
 * runs from a ONE-SHOT `includeArchived` fetch — the shared poller itself
 * stays visible-only by design. Archived rows are visually distinct with an
 * explicit "archived" text badge (never color alone, §7), offer a guarded
 * Unarchive (R13: visibility only — a cancelled run stays cancelled), and a
 * Replay link into the existing run detail view (R7: archived runs stay on
 * disk, searchable, replayable).
 *
 * The pre-U6 ephemeral "Clear view" state was REMOVED: archive is now the
 * real way for a run to leave the floor, and keeping a second, client-only
 * hide would reintroduce the ambiguity archive exists to end.
 *
 * Status carries a severity label, never color alone (§7).
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { RunProjection } from '@software-factory/core';
import { runStatusSeverity } from '../../lib/run-view';
import { fetchRunList, unarchiveRun } from '../../lib/api-client';
import { useSession } from '../session-context';
import { Mono, SeverityBadge } from './primitives';

/** One-shot archived fetch state — §6: loading/empty/error all designed. */
type ArchivedState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly rows: readonly RunProjection[] };

function runTitle(run: RunProjection): string {
  return run.prompt ?? run.prdRef ?? (run.prdText ? 'PRD content attached' : 'Untitled run');
}

export function RunBoard({
  runs,
  totalCount = runs.length,
  focusedRunId = null,
  onFocus,
  showArchived = false,
  onToggleArchived,
  onLifecycleChanged,
}: {
  readonly runs: readonly RunProjection[];
  readonly totalCount?: number;
  readonly focusedRunId?: string | null;
  readonly onFocus?: (runId: string) => void;
  /** History view open (lifted so floor notices can open it directly). */
  readonly showArchived?: boolean;
  /** Omitted = no history affordance (e.g. embedded read-only usage). */
  readonly onToggleArchived?: () => void;
  /** Fired after unarchive succeeds so the parent's live list re-polls. */
  readonly onLifecycleChanged?: () => void;
}) {
  const session = useSession();
  const [archived, setArchived] = useState<ArchivedState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  /** The runId with an unarchive in flight (one at a time, never optimistic). */
  const [unarchiving, setUnarchiving] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // One-shot archived fetch, re-run on open and after each lifecycle action —
  // NOT a poll: history is a reading surface, and the shared run-list poller
  // deliberately stays visible-only (U5 contract).
  useEffect(() => {
    if (!showArchived) {
      return;
    }
    let active = true;
    setArchived({ kind: 'loading' });
    fetchRunList({ includeArchived: true }).then(
      (rows) => {
        if (active) {
          setArchived({ kind: 'ready', rows: rows.filter((row) => row.archived) });
        }
      },
      (error: unknown) => {
        if (active) {
          setArchived({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Could not load archived runs.',
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [showArchived, attempt]);

  async function performUnarchive(run: RunProjection): Promise<void> {
    if (run.runId === null || unarchiving !== null) {
      return;
    }
    setUnarchiving(run.runId);
    setActionError(null);
    try {
      const result = await unarchiveRun(session, run.runId, run.lastSequence);
      if (result.ok) {
        // Confirmed from the command response; the run reappears in the
        // visible list on the parent's next round trip (never optimistic).
        onLifecycleChanged?.();
      } else {
        // §6 stale-command: explain, then reload the projected history state.
        setActionError(
          result.message ?? `Unarchive was not accepted (${result.error}). History reloaded.`,
        );
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Network error during unarchive.');
    } finally {
      setUnarchiving(null);
      // Either way the archived snapshot is stale — refetch it.
      setAttempt((n) => n + 1);
    }
  }

  return (
    <section className="panel run-history" aria-label="Runs">
      <header className="panel__header">
        <h2 className="panel__title">Runs</h2>
        <span className="row" style={{ justifyContent: 'flex-end' }}>
          <span className="panel__hint">{totalCount} visible</span>
          {onToggleArchived !== undefined ? (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              data-testid="history-toggle"
              aria-pressed={showArchived}
              onClick={onToggleArchived}
            >
              {showArchived ? 'Hide archived' : 'Show archived'}
            </button>
          ) : null}
        </span>
      </header>
      <div className="panel__body">
        {runs.length === 0 ? (
          <p className="muted">No visible runs. Archived runs live under “Show archived”.</p>
        ) : (
          <ul className="stack run-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {runs.map((run) =>
              run.runId === null ? null : (
                <li key={run.runId} className="run-list__item">
                  <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                    <span style={{ fontWeight: 'var(--fw-medium)' }}>{runTitle(run)}</span>
                    <Mono value={run.runId} max={22} copyable={false} />
                  </span>
                  <span className="row" style={{ flex: 'none' }}>
                    <SeverityBadge severity={runStatusSeverity(run.status)} label={run.status} />
                    {onFocus !== undefined ? (
                      run.runId === focusedRunId ? (
                        <span className="badge" data-testid="run-focused">
                          focused
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          onClick={() => onFocus(run.runId as string)}
                          aria-label={`Focus run ${run.runId}`}
                        >
                          Focus
                        </button>
                      )
                    ) : null}
                    <Link className="btn btn--sm btn--ghost" href={`/runs/${run.runId}`}>
                      Open
                    </Link>
                  </span>
                </li>
              ),
            )}
          </ul>
        )}

        {showArchived ? (
          <section
            className="stack"
            aria-label="Archived runs"
            data-testid="archived-history"
            style={{ marginTop: 'var(--space-8)', gap: 'var(--space-4)' }}
          >
            <span className="label">Archived</span>
            {actionError !== null ? (
              <p className="sev-error" role="alert" data-testid="history-action-error">
                {actionError}
              </p>
            ) : null}
            {archived.kind === 'loading' ? (
              <p className="muted">Loading archived runs…</p>
            ) : archived.kind === 'error' ? (
              <p className="sev-error" role="alert">
                {archived.message}{' '}
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setAttempt((n) => n + 1)}
                >
                  Retry
                </button>
              </p>
            ) : archived.rows.length === 0 ? (
              <p className="muted" data-testid="archived-empty">
                No archived runs. Archiving keeps a finished run on disk and out of the way —
                nothing is archived yet.
              </p>
            ) : (
              <ul className="stack run-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {archived.rows.map((run) =>
                  run.runId === null ? null : (
                    <li
                      key={run.runId}
                      className="run-list__item"
                      data-testid="archived-run"
                      data-run-id={run.runId}
                    >
                      <span className="stack muted" style={{ gap: 2, minWidth: 0 }}>
                        <span>{runTitle(run)}</span>
                        <Mono value={run.runId} max={22} copyable={false} />
                      </span>
                      <span className="row" style={{ flex: 'none' }}>
                        <SeverityBadge
                          severity={runStatusSeverity(run.status)}
                          label={run.status}
                        />
                        {/* Explicit TEXT marker — archived is a visibility state,
                            never encoded by dimming alone (§7). */}
                        <span className="badge">archived</span>
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          disabled={unarchiving !== null}
                          aria-label={`Unarchive run ${run.runId}`}
                          onClick={() => void performUnarchive(run)}
                        >
                          {unarchiving === run.runId ? 'Unarchiving…' : 'Unarchive'}
                        </button>
                        <Link
                          className="btn btn--sm btn--ghost"
                          href={`/runs/${run.runId}`}
                          aria-label={`Replay run ${run.runId}`}
                        >
                          Replay
                        </Link>
                      </span>
                    </li>
                  ),
                )}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </section>
  );
}
