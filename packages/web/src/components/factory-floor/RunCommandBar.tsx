'use client';

/**
 * RunCommandBar — compact guarded execution controls for one run (DESIGN.md
 * §5, U9): start, pause, resume, retry, re-run gates, and cancel, plus the
 * preview/deploy state badges. Which actions render is derived ONLY from the
 * projected run/execution state — never optimistic. Every mutation goes
 * through the command guard (token + CSRF); a stale/guard failure surfaces as
 * an explanatory banner with the state reloaded (§6 stale-command), and a
 * preflight-blocked start explains WHICH checks failed instead of pretending
 * to run.
 */
import { useState } from 'react';
import type { RunExecutionState, RunStatus } from '@software-factory/core';
import type { DeployView, PreviewView } from '../../lib/run-view';
import { useSession } from '../session-context';
import {
  cancelRun,
  pauseExecution,
  rerunGates,
  resumeExecution,
  retryExecution,
  startExecution,
} from '../../lib/api-client';
import type { MutationResult } from '../../lib/api-client';

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
}) {
  const session = useSession();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const busy = phase.kind === 'busy';

  const canStart =
    status === 'planned' && (executionState === 'not_requested' || executionState === 'pending');
  const canPause = executionState === 'queued' || executionState === 'started';
  const canResume = executionState === 'paused';
  const canRetry = executionState === 'failed' || executionState === 'blocked';
  const canRerunGates =
    executionState === 'completed' || executionState === 'failed' || executionState === 'blocked';
  const canCancel = status === 'created' || status === 'planned' || status === 'running';

  async function perform(
    action: string,
    request: () => Promise<MutationResult<unknown>>,
  ): Promise<void> {
    setPhase({ kind: 'busy', action });
    try {
      const result = await request();
      if (result.ok) {
        setPhase({ kind: 'idle' });
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
              void perform('cancel', () => cancelRun(session, runId, lastSequence, 'operator stop'))
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
