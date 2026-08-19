'use client';

/**
 * RunControl — prompt/PRD intake plus the new run's operating controls
 * (DESIGN.md §5; plan R1/R5). Prompt/PRD text, local/GitHub destination,
 * execution-adapter selector, model profile + effort budget, review-mode toggle,
 * and an adaptive worker cap (1–20, default 10, explicitly labeled as a
 * system-gated upper bound), all guarded by the operator token + CSRF. An
 * ACTIVE run's execution controls (start/pause/resume/retry/cancel + preview
 * and deploy badges) live in `RunCommandBar` (U9) — this surface only creates
 * runs.
 */
import { useId, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import type { ReviewMode } from '@software-factory/core';
import { useSession } from '../session-context';
import { startRun } from '../../lib/api-client';

const ADAPTERS = [
  { id: 'codex-cli', label: 'Codex CLI (local)' },
  { id: 'claude-code-cli', label: 'Claude Code CLI (local)' },
  { id: 'api', label: 'API adapter' },
] as const;

/**
 * Per-adapter model choices. `default` passes NO model flag (the adapter runs
 * on its own default); every other id is passed verbatim to the adapter's
 * model flag (`claude --model`, `codex exec --model`), so the list is a
 * curated convenience, not a hard allow-list — extend it as models ship.
 */
const MODELS_BY_ADAPTER: Readonly<
  Record<string, readonly { readonly id: string; readonly label: string }[]>
> = {
  'codex-cli': [
    { id: 'default', label: 'Adapter default' },
    { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
    { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
    { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
  ],
  'claude-code-cli': [
    { id: 'default', label: 'Adapter default' },
    { id: 'claude-fable-5', label: 'Claude Fable 5' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  api: [
    { id: 'default', label: 'Adapter default' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
};

const DEFAULT_MODEL_ID = 'default';

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'extra high', 'maximum'] as const;

interface DirectoryHandle {
  readonly name?: string;
}

type WindowWithDirectoryPicker = Window & {
  readonly showDirectoryPicker?: () => Promise<DirectoryHandle>;
};

export function RunControl({
  defaultLocalFolder,
  onStarted,
}: {
  readonly defaultLocalFolder?: string;
  readonly onStarted?: (runId: string) => void;
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
  const [model, setModel] = useState<string>(DEFAULT_MODEL_ID);
  const modelOptions = MODELS_BY_ADAPTER[adapter] ?? MODELS_BY_ADAPTER[ADAPTERS[0].id];
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>('extra high');
  const [reviewMode, setReviewMode] = useState<ReviewMode>('human');
  const [workerCap, setWorkerCap] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canStart =
    (prompt.trim().length > 0 || prdText.trim().length > 0 || prdRef.trim().length > 0) && !busy;

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
              onChange={(e) => {
                // Model lists are adapter-specific: switching adapters resets
                // the model to the new adapter's default so a Claude adapter
                // can never carry a Codex model (and vice versa).
                setAdapter(e.target.value);
                setModel(DEFAULT_MODEL_ID);
              }}
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
              {modelOptions.map((m) => (
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
        </div>
      </form>
    </section>
  );
}
