'use client';

/**
 * RunCommandBar — compact guarded execution controls for one run (DESIGN.md
 * §5, U9): start, pause, resume, retry, re-run gates, and cancel, plus the
 * preview/deploy state badges. Which actions render is derived ONLY from the
 * projected run/execution state — never optimistic. Every mutation goes
 * through the command guard (token + CSRF); a stale/guard failure surfaces as
 * an explanatory banner with the state reloaded (§6 stale-command), and a
 * preflight-blocked start explains WHICH checks failed instead of pretending
 * to run. A successful cancel offers archive in the same moment (U6/AE5,
 * R10), keyed to the cancel response's fresh projected version — the visible
 * state still only flips when the next poll confirms it from events.
 */
import { useEffect, useRef, useState } from 'react';
import type { RunExecutionState, RunStatus } from '@software-factory/core';
import type { DeployView, PreviewView } from '../../lib/run-view';
import { useSession } from '../session-context';
import {
  archiveRun,
  cancelRun,
  pauseExecution,
  rerunGates,
  resumeExecution,
  retryExecution,
  startExecution,
} from '../../lib/api-client';
import type { CancelRunResult, MutationResult } from '../../lib/api-client';

const PREVIEW_LABEL: Readonly<Record<PreviewView['status'], string>> = {
  idle: 'not started',
  starting: 'starting…',
  health_pending: 'health pending',
  ready: 'ready',
  failed: 'failed',
};

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly action: string }
  /** AE5: cancel succeeded — offer archive keyed to the RESPONSE's fresh
   *  projected version (the exact `expectedVersion` for the archive guard). */
  | { readonly kind: 'archive-offer'; readonly expectedVersion: number }
  | { readonly kind: 'error'; readonly message: string };

export function RunCommandBar({
  runId,
  status,
  executionState,
  executionReason,
  lastSequence,
  preview,
  deploy,
  onChanged,
  disabled = false,
}: {
  readonly runId: string;
  readonly status: RunStatus;
  readonly executionState: RunExecutionState;
  readonly executionReason?: string;
  /** Current projected version — used by the (destructive) cancel guard. */
  readonly lastSequence: number;
  readonly preview?: PreviewView;
  readonly deploy?: DeployView;
  readonly onChanged?: () => void;
  /** Lock every command (R15: the factory was reset — reload first). */
  readonly disabled?: boolean;
}) {
  const session = useSession();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const busy = phase.kind === 'busy' || disabled;

  // Cancellation guard: an in-flight command that settles after unmount must
  // not set state or trigger the parent refresh (reset on mount so StrictMode's
  // mount/cleanup/mount cycle leaves the flag false).
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const canStart =
    status === 'planned' && (executionState === 'not_requested' || executionState === 'pending');
  const canPause = executionState === 'queued' || executionState === 'started';
  const canResume = executionState === 'paused';
  const canRetry = executionState === 'failed' || executionState === 'blocked';
  const canRerunGates =
    executionState === 'completed' || executionState === 'failed' || executionState === 'blocked';
  const canCancel = status === 'created' || status === 'planned' || status === 'running';

  async function perform<T>(
    action: string,
    request: () => Promise<MutationResult<T>>,
    /** Optional phase for a success; `undefined` returns quietly to idle.
     *  Success is still event-confirmed: `onChanged` re-polls either way. */
    nextPhase?: (data: T) => Phase,
  ): Promise<void> {
    setPhase({ kind: 'busy', action });
    try {
      const result = await request();
      if (cancelledRef.current) {
        return;
      }
      if (result.ok) {
        setPhase(nextPhase?.(result.data) ?? { kind: 'idle' });
        onChanged?.();
        return;
      }
      // Guard/state denials come back with an explanatory message (preflight
      // failures name the failed checks); reload projected state either way.
      onChanged?.();
      setPhase({
        kind: 'error',
        message: result.message ?? `${action} was not accepted (${result.error}).`,
      });
    } catch (error) {
      if (cancelledRef.current) {
        return;
      }
      const message = error instanceof Error ? error.message : `Network error during ${action}.`;
      setPhase({ kind: 'error', message });
    }
  }

  return (
    <div className="cmd-bar" data-testid="run-command-bar">
      <div className="cmd-bar__actions" role="group" aria-label={`Run controls for ${runId}`}>
        {canStart ? (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={busy}
            onClick={() => void perform('start', () => startExecution(session, runId))}
            aria-label={`Start execution for run ${runId}`}
          >
            {phase.kind === 'busy' && phase.action === 'start' ? 'Starting…' : 'Start'}
          </button>
        ) : null}
        {canPause ? (
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy}
            onClick={() => void perform('pause', () => pauseExecution(session, runId))}
            aria-label={`Pause execution for run ${runId}`}
          >
            Pause
          </button>
        ) : null}
        {canResume ? (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={busy}
            onClick={() => void perform('resume', () => resumeExecution(session, runId))}
            aria-label={`Resume execution for run ${runId}`}
          >
            Resume
          </button>
        ) : null}
        {canRetry ? (
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy}
            onClick={() => void perform('retry', () => retryExecution(session, runId))}
            aria-label={`Retry execution for run ${runId}`}
          >
            Retry
          </button>
        ) : null}
        {canRerunGates ? (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={busy}
            onClick={() => void perform('gate re-run', () => rerunGates(session, runId))}
            aria-label={`Re-run gates for run ${runId}`}
          >
            Re-run gates
          </button>
        ) : null}
        {canCancel ? (
          <button
            type="button"
            className="btn btn--sm btn--danger"
            disabled={busy}
            onClick={() =>
              void perform(
                'cancel',
                () => cancelRun(session, runId, lastSequence, 'operator stop'),
                // AE5/R10: the cancel confirmed — offer archive in the same
                // moment, keyed to the RESPONSE run's fresh `lastSequence`
                // (never the pre-cancel prop, which the cancel event just
                // outdated). No offer when the run is already archived.
                (data: CancelRunResult) =>
                  typeof data.run?.lastSequence === 'number' && data.run.archived !== true
                    ? { kind: 'archive-offer', expectedVersion: data.run.lastSequence }
                    : { kind: 'idle' },
              )
            }
            aria-label={`Cancel run ${runId}`}
          >
            Cancel
          </button>
        ) : null}
        {!canStart && !canPause && !canResume && !canRetry && !canRerunGates && !canCancel ? (
          <span className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
            No commands apply — the run is {status} / execution {executionState.replace(/_/g, ' ')}.
          </span>
        ) : null}
      </div>

      {phase.kind === 'archive-offer' ? (
        <div className="banner banner--info" role="status" data-testid="archive-offer">
          <span className="banner__body">
            Run cancelled. Archive it now? It leaves the floor and stays in run history.
          </span>
          <button
            type="button"
            className="btn btn--sm"
            disabled={disabled}
            data-testid="archive-offer-accept"
            onClick={() =>
              void perform('archive', () =>
                archiveRun(session, runId, phase.expectedVersion, 'archived after cancel'),
              )
            }
          >
            Archive run
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            data-testid="archive-offer-dismiss"
            onClick={() => setPhase({ kind: 'idle' })}
          >
            Keep it visible
          </button>
        </div>
      ) : null}

      {executionReason ? (
        <p className="cmd-bar__reason sev-warn" data-testid="execution-reason">
          {executionReason}
        </p>
      ) : null}

      {preview !== undefined || deploy !== undefined ? (
        <div className="row" style={{ gap: 'var(--space-8)' }}>
          {preview !== undefined ? (
            <>
              <span className="label">preview</span>
              <span className="badge" data-testid="preview-status">
                {PREVIEW_LABEL[preview.status]}
              </span>
              {preview.status === 'ready' && preview.url ? (
                <a href={preview.url} target="_blank" rel="noreferrer" className="mono">
                  {preview.url}
                </a>
              ) : null}
            </>
          ) : null}
          {deploy !== undefined ? (
            <span className="badge" data-testid="deploy-summary">
              deploy: {deploy.status.replace(/_/g, ' ')}
            </span>
          ) : null}
        </div>
      ) : null}

      {phase.kind === 'error' ? (
        <div className="banner banner--error" role="alert" data-testid="command-error">
          <span className="banner__body">{phase.message}</span>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => setPhase({ kind: 'idle' })}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
