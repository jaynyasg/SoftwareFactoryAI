'use client';

/**
 * RunControl — prompt/PRD intake plus the run's operating controls
 * (DESIGN.md §5; plan R1/R5). Prompt/PRD text, local/GitHub destination,
 * execution-adapter selector, model profile + effort budget, review-mode toggle,
 * and an adaptive worker cap (1–20, default 10, explicitly labeled as a system-gated upper
 * bound). It also surfaces the local preview status for an active run and the
 * start/cancel actions, all guarded by the operator token + CSRF.
 */
import { useId, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
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
  { id: 'codex-default', label: 'Codex default' },
  { id: 'claude-default', label: 'Claude default' },
  { id: 'api-override', label: 'API override' },
] as const;

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'extra high', 'maximum'] as const;

const PREVIEW_LABEL: Readonly<Record<PreviewView['status'], string>> = {
  idle: 'not started',
  starting: 'starting…',
  health_pending: 'health pending',
  ready: 'ready',
  failed: 'failed',
};

interface DirectoryHandle {
  readonly name?: string;
}

type WindowWithDirectoryPicker = Window & {
  readonly showDirectoryPicker?: () => Promise<DirectoryHandle>;
};

export function RunControl({
  activeRun,
  preview,
  deploy,
  defaultLocalFolder,
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
  readonly defaultLocalFolder?: string;
  readonly onStarted?: (runId: string) => void;
  readonly onChanged?: () => void;
}) {
  const session = useSession();
  const fieldId = useId();
  const prdFileRef = useRef<HTMLInputElement>(null);

  const [prompt, setPrompt] = useState('');
  const [prdRef, setPrdRef] = useState('');
  const [prdText, setPrdText] = useState('');
  const [localFolder, setLocalFolder] = useState(defaultLocalFolder ?? '');
  const [folderBrowseStatus, setFolderBrowseStatus] = useState<string | null>(null);
  const [githubRepo, setGithubRepo] = useState('');
  const [adapter, setAdapter] = useState<string>(ADAPTERS[0].id);
  const [model, setModel] = useState<string>(MODELS[0].id);
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>('extra high');
  const [reviewMode, setReviewMode] = useState<ReviewMode>('human');
  const [workerCap, setWorkerCap] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canStart =
    (prompt.trim().length > 0 || prdText.trim().length > 0 || prdRef.trim().length > 0) && !busy;
  const cancellable =
    activeRun !== undefined && ['created', 'planned', 'running'].includes(activeRun.status);

  async function onPrdFileSelected(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (file === undefined) {
      return;
    }
    setError(null);
    try {
      const text = await file.text();
      setPrdText(text);
      setPrdRef(file.name);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read the PRD file.');
    } finally {
      event.target.value = '';
    }
  }

  async function onBrowseLocalFolder(): Promise<void> {
    setFolderBrowseStatus(null);
    const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker;
    if (picker === undefined) {
      setFolderBrowseStatus('Folder picker unavailable; paste the absolute path instead.');
      return;
    }
    try {
      const folder = await picker();
      setFolderBrowseStatus(
        `${folder.name ?? 'Folder'} selected. Browser keeps absolute paths private; verify the path field.`,
      );
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') {
        return;
      }
      setFolderBrowseStatus('Could not open the folder picker; paste the path instead.');
    }
  }

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
        prdText: prdText.trim() || undefined,
        localFolder: localFolder.trim() || undefined,
        githubRepo: githubRepo.trim() || undefined,
        selectedAdapter: adapter,
        modelProfile: model,
        reasoningEffort: effort,
        requestedWorkerCap: workerCap,
        reviewMode,
      });
      if (result.ok) {
        setPrompt('');
        setPrdRef('');
        setPrdText('');
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
        <span className="panel__hint">prompt and/or PRD → ticket DAG</span>
      </header>
      <form className="panel__body" onSubmit={(e) => void onStart(e)}>
        <div className="field">
          <label className="field__label" htmlFor={`${fieldId}-prompt`}>
            Prompt (optional)
          </label>
          <textarea
            id={`${fieldId}-prompt`}
            className="textarea"
            placeholder="Describe what to build, or add context for the PRD…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        <div className="field field--with-actions">
          <div className="field__top">
            <label className="field__label" htmlFor={`${fieldId}-prd-text`}>
              PRD (optional)
            </label>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => prdFileRef.current?.click()}
            >
              Browse PRD
            </button>
          </div>
          <textarea
            id={`${fieldId}-prd-text`}
            className="textarea textarea--compact"
            placeholder="Paste PRD content, or import a .md/.txt PRD…"
            value={prdText}
            onChange={(e) => setPrdText(e.target.value)}
          />
          <input
            ref={prdFileRef}
            type="file"
            accept=".md,.markdown,.txt,.prd,.json,.yaml,.yml"
            hidden
            onChange={(e) => void onPrdFileSelected(e)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`${fieldId}-prd-ref`}>
            PRD reference (path, URL, or imported file)
          </label>
          <input
            id={`${fieldId}-prd-ref`}
            className="input mono"
            placeholder="docs/PRD.md"
            value={prdRef}
            onChange={(e) => setPrdRef(e.target.value)}
          />
        </div>

        <div className="control-row control-row--destinations">
          <div className="field">
            <div className="field__top">
              <label className="field__label" htmlFor={`${fieldId}-folder`}>
                Local folder
              </label>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => void onBrowseLocalFolder()}
              >
                Browse
              </button>
            </div>
            <input
              id={`${fieldId}-folder`}
              className="input mono"
              value={localFolder}
              onChange={(e) => setLocalFolder(e.target.value)}
              aria-describedby={
                folderBrowseStatus !== null ? `${fieldId}-folder-status` : undefined
              }
            />
            {folderBrowseStatus !== null ? (
              <span className="field__note" id={`${fieldId}-folder-status`} role="status">
                {folderBrowseStatus}
              </span>
            ) : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor={`${fieldId}-github`}>
              GitHub repository
            </label>
            <input
              id={`${fieldId}-github`}
              className="input mono"
              placeholder="owner/repo or https://github.com/owner/repo"
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
            />
          </div>
        </div>

        <div className="control-row control-row--runtime">
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
              Model profile
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
            <label className="field__label" htmlFor={`${fieldId}-effort`}>
              Effort budget
            </label>
            <select
              id={`${fieldId}-effort`}
              className="select"
              value={effort}
              onChange={(e) => setEffort(e.target.value as (typeof EFFORTS)[number])}
            >
              {EFFORTS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
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
            Worker cap (1–20)
          </label>
          <input
            id={`${fieldId}-cap`}
            className="range"
            type="range"
            min={1}
            max={20}
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
