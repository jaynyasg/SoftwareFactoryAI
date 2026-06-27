'use client';

/**
 * RunControl — prompt/PRD intake plus the run's operating controls
 * (DESIGN.md §5; plan R1/R5). Prompt/PRD text, execution-adapter selector,
 * model + effort controls, review-mode toggle, and an adaptive worker cap (1–10,
 * explicitly labeled as a system-gated upper bound). It also surfaces the local
 * preview status for an active run and the start/cancel actions, all guarded by
 * the operator token + CSRF.
 *
 * Adapter/model/effort are operator inputs captured for the run request; they are
 * selectors, not ledger-derived state, so the anti-slop "no invented state" rule
 * holds. Only fields the U3 API accepts (prompt/prdRef/title/cap/reviewMode) are
 * persisted; worker selection is consumed by the worker runtime (U5).
 */
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { ReviewMode } from '@software-factory/core';
import type { DeployView, PreviewView } from '../../lib/run-view';
import { useSession } from '../session-context';
import { cancelRun, startRun } from '../../lib/api-client';

const ADAPTERS = [
  { id: 'codex-cli', label: 'Codex CLI (local)' },
  { id: 'claude-code-cli', label: 'Claude Code CLI (local)' },
  { id: 'api', label: 'API adapter' },
] as const;

const MODELS = [
  { id: 'default', label: 'Adapter default' },
  { id: 'reasoning-high', label: 'Reasoning (high)' },
  { id: 'reasoning-fast', label: 'Reasoning (fast)' },
] as const;

const EFFORTS = ['low', 'medium', 'high'] as const;

const PREVIEW_LABEL: Readonly<Record<PreviewView['status'], string>> = {
  idle: 'not started',
  starting: 'starting…',
  health_pending: 'health pending',
  ready: 'ready',
  failed: 'failed',
};

export function RunControl({
  activeRun,
  preview,
  deploy,
  onStarted,
  onChanged,
}: {
  readonly activeRun?: {
    readonly runId: string;
    readonly status: string;
    readonly lastSequence: number;
  };
  readonly preview?: PreviewView;
  readonly deploy?: DeployView;
  readonly onStarted?: (runId: string) => void;
  readonly onChanged?: () => void;
}) {
  const session = useSession();
  const fieldId = useId();

  const [prompt, setPrompt] = useState('');
  const [prdRef, setPrdRef] = useState('');
  const [adapter, setAdapter] = useState<string>(ADAPTERS[0].id);
  const [model, setModel] = useState<string>(MODELS[0].id);
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>('medium');
  const [reviewMode, setReviewMode] = useState<ReviewMode>('human');
  const [workerCap, setWorkerCap] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canStart = (prompt.trim().length > 0 || prdRef.trim().length > 0) && !busy;
  const cancellable =
    activeRun !== undefined && ['created', 'planned', 'running'].includes(activeRun.status);

  async function onStart(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canStart) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await startRun(session, {
        prompt: prompt.trim() || undefined,
        prdRef: prdRef.trim() || undefined,
        requestedWorkerCap: workerCap,
        reviewMode,
      });
      if (result.ok) {
        setPrompt('');
        setPrdRef('');
        onStarted?.(result.data.runId);
      } else {
        setError(result.message ?? `Could not start run (${result.error}).`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Network error starting run.');
    } finally {
      setBusy(false);
    }
  }

  async function onCancel(): Promise<void> {
    if (activeRun === undefined) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await cancelRun(
        session,
        activeRun.runId,
        activeRun.lastSequence,
        'operator stop',
      );
      if (!result.ok) {
        setError(result.message ?? `Could not cancel (${result.error}).`);
      } else {
        onChanged?.();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Network error cancelling run.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="Run control">
      <header className="panel__header">
        <h2 className="panel__title">Run control</h2>
        <span className="panel__hint">prompt or PRD → ticket DAG</span>
      </header>
      <form className="panel__body" onSubmit={(e) => void onStart(e)}>
        <div className="field">
          <label className="field__label" htmlFor={`${fieldId}-prompt`}>
            Prompt or PRD
          </label>
          <textarea
            id={`${fieldId}-prompt`}
            className="textarea"
            placeholder="Describe what to build (e.g. an AI services marketplace with providers and proposals)…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`${fieldId}-prd`}>
            PRD reference (path or URL, optional)
          </label>
          <input
            id={`${fieldId}-prd`}
            className="input mono"
            placeholder="docs/PRD.md"
            value={prdRef}
            onChange={(e) => setPrdRef(e.target.value)}
          />
        </div>

        <div className="control-row">
          <div className="field">
            <label className="field__label" htmlFor={`${fieldId}-adapter`}>
              Execution adapter
            </label>
            <select
              id={`${fieldId}-adapter`}
              className="select"
              value={adapter}
              onChange={(e) => setAdapter(e.target.value)}
            >
              {ADAPTERS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor={`${fieldId}-model`}>
              Model
            </label>
            <select
              id={`${fieldId}-model`}
              className="select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <span className="field__label" id={`${fieldId}-effort-label`}>
              Effort
            </span>
            <div className="seg" role="group" aria-labelledby={`${fieldId}-effort-label`}>
              {EFFORTS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="seg__btn"
                  aria-pressed={effort === value}
                  onClick={() => setEffort(value)}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="field__label" id={`${fieldId}-mode-label`}>
              Review mode
            </span>
            <div className="seg" role="group" aria-labelledby={`${fieldId}-mode-label`}>
              {(['human', 'autonomous'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className="seg__btn"
                  aria-pressed={reviewMode === value}
                  onClick={() => setReviewMode(value)}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`${fieldId}-cap`}>
            Worker cap (1–10)
          </label>
          <input
            id={`${fieldId}-cap`}
            className="range"
            type="range"
            min={1}
            max={10}
            step={1}
            value={workerCap}
            onChange={(e) => setWorkerCap(Number(e.target.value))}
            aria-describedby={`${fieldId}-cap-note`}
          />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <output className="mono" htmlFor={`${fieldId}-cap`}>
              {workerCap} worker{workerCap === 1 ? '' : 's'}
            </output>
            <span className="badge" id={`${fieldId}-cap-note`}>
              upper bound · system-gated
            </span>
          </div>
        </div>

        {reviewMode === 'autonomous' ? (
          <div className="banner banner--warn" role="status">
            <span className="banner__body">
              Autonomous mode still stops for medium/high-risk and policy-blocked actions.
            </span>
          </div>
        ) : null}

        {error ? (
          <div className="banner banner--error" role="alert">
            <span className="banner__body">{error}</span>
          </div>
        ) : null}

        <div className="row">
          <button type="submit" className="btn btn--primary" disabled={!canStart}>
            {busy ? 'Working…' : 'Start run'}
          </button>
          {cancellable ? (
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => void onCancel()}
              disabled={busy}
            >
              Cancel run
            </button>
          ) : null}
        </div>

        {activeRun !== undefined ? (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="label">local preview</span>
            <span className="badge" data-testid="preview-status">
              {preview ? PREVIEW_LABEL[preview.status] : 'not started'}
            </span>
            {preview?.status === 'ready' && preview.url ? (
              <a href={preview.url} target="_blank" rel="noreferrer" className="mono">
                {preview.url}
              </a>
            ) : null}
            {deploy ? (
              <span className="badge" data-testid="deploy-summary">
                deploy: {deploy.status.replace(/_/g, ' ')}
              </span>
            ) : null}
          </div>
        ) : null}
      </form>
    </section>
  );
}
