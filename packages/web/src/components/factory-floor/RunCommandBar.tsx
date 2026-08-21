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
import { useEffect, useRef, useState } from 'react';
import type { RunExecutionState, RunStatus } from '@software-factory/core';
import type { DeployView, PreviewView } from '../../lib/run-view';
import { useSession } from '../session-context';
import {
  cancelRun,
  overrideRunSettings,
  pauseExecution,
  rerunGates,
  resumeExecution,
  retryExecution,
  startExecution,
} from '../../lib/api-client';
import type { MutationResult } from '../../lib/api-client';
import { ADAPTERS, MODELS_BY_ADAPTER } from './RunControl';

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
  hasExecutionJob = true,
  selectedAdapter,
  modelProfile,
  lastSequence,
  preview,
  deploy,
  onChanged,
}: {
  readonly runId: string;
  readonly status: RunStatus;
  readonly executionState: RunExecutionState;
  readonly executionReason?: string;
  /**
   * Whether an execution job was ever enqueued (aggregate `executionJob !==
   * null`). A preflight-blocked start never enqueued one, so the honest
   * command there is Start (the server rejects retry with "use start
   * instead"). Defaults to true so untold callers keep the old behavior.
   */
  readonly hasExecutionJob?: boolean;
  /** The run's adapter — selects which model catalog the override offers. */
  readonly selectedAdapter?: string;
  /** The run's CURRENT projected model profile (overrides included). */
  readonly modelProfile?: string;
  /** Current projected version — used by the (destructive) cancel guard. */
  readonly lastSequence: number;
  readonly preview?: PreviewView;
  readonly deploy?: DeployView;
  readonly onChanged?: () => void;
}) {
  const session = useSession();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // Mid-run adapter/model override drafts: null mirrors the projected run, a
  // value is an unapplied selection ("Apply to remaining tickets" records it).
  const [adapterDraft, setAdapterDraft] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const busy = phase.kind === 'busy';

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
    (status === 'planned' &&
      (executionState === 'not_requested' || executionState === 'pending')) ||
    // Blocked/failed WITHOUT a job = a preflight-blocked start that never
    // enqueued execution; Start re-runs the rehearsal (retry would be rejected).
    ((status === 'planned' || status === 'running') &&
      (executionState === 'blocked' || executionState === 'failed') &&
      !hasExecutionJob);
  const canPause = executionState === 'queued' || executionState === 'started';
  const canResume = executionState === 'paused';
  const canRetry =
    (executionState === 'failed' || executionState === 'blocked') && hasExecutionJob;
  const canRerunGates =
    executionState === 'completed' || executionState === 'failed' || executionState === 'blocked';
  const canCancel = status === 'created' || status === 'planned' || status === 'running';

  // Mid-run adapter/model override (recorded as `run.settings_overridden`):
  // already-executed tickets keep their evidence; the rest pick up the new
  // adapter/model on the next execution attempt (usage-pool failover). The
  // current values always appear in the lists even when not in the catalogs.
  const currentAdapter = selectedAdapter ?? '';
  const adapterValue = adapterDraft ?? currentAdapter;
  const adapterDirty = adapterValue !== currentAdapter;
  const adapterChoices = ADAPTERS.some((a) => a.id === currentAdapter)
    ? ADAPTERS
    : [{ id: currentAdapter, label: currentAdapter || '(none)' }, ...ADAPTERS];
  const catalogModels = MODELS_BY_ADAPTER[adapterValue] ?? [];
  const currentModel = modelProfile ?? 'default';
  const modelValue = modelDraft ?? (adapterDirty ? 'default' : currentModel);
  const modelChoices = catalogModels.some((m) => m.id === modelValue)
    ? catalogModels
    : [{ id: modelValue, label: modelValue }, ...catalogModels];
  const modelDirty = modelValue !== currentModel;
  const settingsDirty = adapterDirty || modelDirty;
  const canOverrideModel =
    selectedAdapter !== undefined && status !== 'completed' && status !== 'cancelled';

  async function perform(
    action: string,
    request: () => Promise<MutationResult<unknown>>,
  ): Promise<void> {
    setPhase({ kind: 'busy', action });
    try {
      const result = await request();
      if (cancelledRef.current) {
        return;
      }
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

      {canOverrideModel ? (
        <div className="row" style={{ gap: 'var(--space-4)' }} data-testid="run-model-override">
          <span className="label">adapter</span>
          <select
            className="input"
            style={{ maxWidth: 190 }}
            aria-label={`Adapter for run ${runId}`}
            value={adapterValue}
            disabled={phase.kind === 'busy'}
            onChange={(e) => {
              setAdapterDraft(e.target.value);
              // A new adapter has a different model catalog: reset the model
              // draft to the adapter default instead of carrying a stale id.
              setModelDraft('default');
            }}
          >
            {adapterChoices.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="label">model</span>
          <select
            className="input"
            style={{ maxWidth: 220 }}
            aria-label={`Model for run ${runId}`}
            value={modelValue}
            disabled={phase.kind === 'busy'}
            onChange={(e) => setModelDraft(e.target.value)}
          >
            {modelChoices.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          {settingsDirty ? (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={phase.kind === 'busy'}
              onClick={() =>
                void perform('apply settings', async () => {
                  const result = await overrideRunSettings(session, runId, {
                    selectedAdapter: adapterDirty ? adapterValue : undefined,
                    modelProfile: modelValue,
                    reason: 'operator mid-run override',
                  });
                  if (result.ok) {
                    setAdapterDraft(null);
                    setModelDraft(null);
                  }
                  return result;
                })
              }
            >
              Apply to remaining tickets
            </button>
          ) : null}
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
