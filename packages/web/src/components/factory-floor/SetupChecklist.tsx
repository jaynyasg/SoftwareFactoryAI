/**
 * SetupChecklist — actionable adapter/sandbox/deploy/token readiness from
 * GET /api/setup (DESIGN.md §5). Items are real and actionable, not decorative;
 * when a blocking prerequisite is missing the checklist renders the setup-required
 * blocking state with the exact action to take (§6).
 */
import type { SetupStatus } from '../../lib/types';

type Mark = 'ok' | 'pending' | 'action';

interface ChecklistItem {
  readonly key: string;
  readonly label: string;
  readonly mark: Mark;
  readonly detail: string;
  /** When true, a missing/failed item blocks run progress. */
  readonly blocking?: boolean;
}

function classify(status: string, ok: readonly string[], pending: readonly string[]): Mark {
  if (ok.includes(status)) {
    return 'ok';
  }
  if (pending.includes(status)) {
    return 'pending';
  }
  return 'action';
}

function buildItems(setup: SetupStatus): ChecklistItem[] {
  const runtimeMode = setup.runtime?.mode === 'cloud' ? 'cloud' : 'local';
  const tokenMark: Mark = setup.operatorToken.present ? 'ok' : 'action';
  const sandboxMark = classify(
    setup.sandbox.status,
    ['available', 'docker', 'wsl2', 'ok'],
    ['unknown'],
  );
  const adapterMark = classify(setup.adapters.status, ['ready', 'authenticated'], ['unknown']);
  const deployMark = classify(setup.deploy.status, ['configured', 'ready'], ['unknown']);

  return [
    {
      key: 'operator-token',
      label: runtimeMode === 'cloud' ? 'Cloud operator token' : 'Local operator token',
      mark: tokenMark,
      blocking: tokenMark !== 'ok',
      detail:
        tokenMark === 'ok'
          ? runtimeMode === 'cloud'
            ? 'Hosted operator token is configured; remote CLI and skill calls can authenticate.'
            : 'Loopback operator token is ready; mutating actions are authorized for you.'
          : runtimeMode === 'cloud'
            ? 'Set SF_OPERATOR_TOKEN in the cloud environment before running commands.'
            : 'Start the local server so an operator token is minted before running commands.',
    },
    {
      key: 'sandbox',
      label: 'Sandbox availability',
      mark: sandboxMark,
      detail:
        sandboxMark === 'ok'
          ? 'A sandbox is available for generated-app commands.'
          : sandboxMark === 'pending'
            ? 'Sandbox availability has not been probed yet.'
            : 'No sandbox detected — generated commands would run reduced-trust if you allow fallback.',
    },
    {
      key: 'adapters',
      label: 'Execution adapter',
      mark: adapterMark,
      detail:
        adapterMark === 'ok'
          ? `Detected: ${setup.adapters.detected.join(', ') || 'adapter ready'}.`
          : adapterMark === 'pending'
            ? 'Adapter detection has not run yet.'
            : 'Authenticate a local Codex or Claude Code CLI adapter (or configure the API adapter).',
    },
    {
      key: 'deploy',
      label: 'Deploy target',
      mark: deployMark,
      detail:
        deployMark === 'ok'
          ? 'GitHub + Render destinations are configured.'
          : deployMark === 'pending'
            ? 'Deploy configuration has not been checked yet.'
            : 'Connect a GitHub destination and Render before any hosted deploy.',
    },
  ];
}

const MARK_GLYPH: Readonly<Record<Mark, string>> = { ok: '✓', pending: '·', action: '!' };
const MARK_WORD: Readonly<Record<Mark, string>> = {
  ok: 'ready',
  pending: 'pending',
  action: 'action needed',
};

export function SetupChecklist({ setup }: { readonly setup: SetupStatus }) {
  const items = buildItems(setup);
  const blocking = items.some((item) => item.blocking && item.mark !== 'ok');

  return (
    <section className="panel" aria-label="Setup checklist">
      <header className="panel__header">
        <h2 className="panel__title">Setup</h2>
        <span className="panel__hint">
          {items.filter((i) => i.mark === 'ok').length}/{items.length} ready
        </span>
      </header>
      <div className="panel__body">
        {blocking ? (
          <div className="banner banner--warn" role="alert" data-testid="setup-required">
            <span className="banner__body">
              Setup required — resolve the blocking items below before running the factory.
            </span>
          </div>
        ) : null}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {items.map((item) => (
            <li key={item.key} className="check-item">
              <span
                className={`check-item__mark check-item__mark--${item.mark}`}
                role="img"
                aria-label={MARK_WORD[item.mark]}
              >
                {MARK_GLYPH[item.mark]}
              </span>
              <span className="stack" style={{ gap: 2 }}>
                <span style={{ fontWeight: 'var(--fw-medium)' }}>{item.label}</span>
                <span className="muted" style={{ fontSize: 'var(--fs-2xs)' }}>
                  {item.detail}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
