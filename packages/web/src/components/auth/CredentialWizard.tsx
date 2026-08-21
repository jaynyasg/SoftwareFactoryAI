'use client';

/**
 * Credential wizard (multi-user U10). One row per credential slot:
 * paste (or upload, for codex auth.json) → live-validate → saved encrypted.
 * Presence + validated-at only — a saved value is NEVER echoed back.
 *
 * Busy discipline mirrors RunControl: while a probe is in flight the row's
 * submit is disabled with an in-flight indicator, so a slow probe can never
 * double-submit. Deleting warns when the caller has active runs (G11): the
 * server answers `confirm_required` naming the runs, and the row asks before
 * re-posting with confirm.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useSession } from '../session-context';
import {
  deleteCredential,
  fetchCredentials,
  saveCredential,
} from '../../lib/api-client';
import type { CredentialPresenceItem, CredentialProbeInfo } from '../../lib/api-client';

interface SlotSpec {
  readonly kind: string;
  readonly label: string;
  readonly hint: string;
  readonly upload?: boolean;
  readonly group: 'execution' | 'source' | 'deploy';
}

const SLOTS: readonly SlotSpec[] = [
  {
    kind: 'claude_oauth_token',
    label: 'Claude Code OAuth token',
    hint: 'Run `claude setup-token` on a signed-in machine and paste the sk-ant-oat… value. Uses YOUR Claude plan.',
    group: 'execution',
  },
  {
    kind: 'anthropic_api_key',
    label: 'Anthropic API key',
    hint: 'console.anthropic.com → API keys. Alternative to the OAuth token (pay-per-use).',
    group: 'execution',
  },
  {
    kind: 'openai_api_key',
    label: 'OpenAI API key',
    hint: 'platform.openai.com → API keys. Lets runs use the Codex CLI on your OpenAI account.',
    group: 'execution',
  },
  {
    kind: 'codex_auth_json',
    label: 'Codex auth.json (ChatGPT plan)',
    hint: 'Upload ~/.codex/auth.json from a machine where `codex login` succeeded. Max 64KB.',
    upload: true,
    group: 'execution',
  },
  {
    kind: 'github_token',
    label: 'GitHub token',
    hint: 'A FINE-GRAINED personal access token scoped to just the repositories the factory may touch, with Contents read/write. Used for your repo checkouts and publishes.',
    group: 'source',
  },
  {
    kind: 'render_api_key',
    label: 'Render API key (optional)',
    hint: 'dashboard.render.com → Account Settings → API Keys. Only needed to DEPLOY the apps your runs build to Render.',
    group: 'deploy',
  },
  {
    kind: 'vercel_token',
    label: 'Vercel token (optional)',
    hint: 'vercel.com → Account Settings → Tokens. Only needed to deploy your built apps to Vercel.',
    group: 'deploy',
  },
];

const GROUP_TITLES: Record<SlotSpec['group'], string> = {
  execution: 'Execution — runs work on YOUR AI accounts (at least one required)',
  source: 'Source — checkout and publish your repositories',
  deploy: 'Deploy targets — optional, for shipping the apps your runs build',
};

interface RowState {
  readonly busy: boolean;
  readonly value: string;
  readonly message?: string;
  readonly messageTone?: 'ok' | 'warn' | 'error';
  readonly confirmDelete?: { readonly runs: readonly { runId: string; title?: string }[] };
}

function probeTone(probe: CredentialProbeInfo | undefined): 'ok' | 'warn' {
  return probe?.status === 'valid' ? 'ok' : 'warn';
}

export function CredentialWizard() {
  const session = useSession();
  const [presence, setPresence] = useState<readonly CredentialPresenceItem[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setPresence(await fetchCredentials());
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rowOf = (kind: string): RowState => rows[kind] ?? { busy: false, value: '' };
  const patchRow = (kind: string, patch: Partial<RowState>): void => {
    setRows((current) => ({ ...current, [kind]: { ...rowOf(kind), ...current[kind], ...patch } }));
  };

  async function save(slot: SlotSpec): Promise<void> {
    const row = rowOf(slot.kind);
    if (row.busy || row.value.trim().length === 0) {
      return; // in-flight or empty: a second submit is a no-op
    }
    patchRow(slot.kind, { busy: true, message: 'Validating…', messageTone: 'warn' });
    const result = await saveCredential(session, slot.kind, row.value);
    if (result.ok) {
      setPresence(result.data.credentials);
      patchRow(slot.kind, {
        busy: false,
        value: '',
        message: result.data.message ?? 'Saved.',
        messageTone: probeTone(result.data.probe),
      });
      return;
    }
    patchRow(slot.kind, {
      busy: false,
      message: result.message ?? 'Could not save the credential.',
      messageTone: 'error',
    });
  }

  async function remove(slot: SlotSpec, confirm: boolean): Promise<void> {
    const row = rowOf(slot.kind);
    if (row.busy) {
      return;
    }
    patchRow(slot.kind, { busy: true });
    const result = await deleteCredential(session, slot.kind, confirm);
    if (result.ok) {
      setPresence(result.data.credentials);
      patchRow(slot.kind, { busy: false, confirmDelete: undefined, message: 'Removed.', messageTone: 'warn' });
      return;
    }
    if (result.status === 409 && result.error === 'confirm_required') {
      // G11: name the active runs before the destructive action fires.
      const res = await fetch('/api/runs', { headers: { accept: 'application/json' } });
      let runs: { runId: string; title?: string }[] = [];
      try {
        const body = (await res.json()) as { runs?: { runId: string; title?: string }[] };
        runs = body.runs ?? [];
      } catch {
        runs = [];
      }
      patchRow(slot.kind, {
        busy: false,
        confirmDelete: { runs },
        message: result.message,
        messageTone: 'warn',
      });
      return;
    }
    patchRow(slot.kind, { busy: false, message: result.message ?? 'Delete failed.', messageTone: 'error' });
  }

  function onUpload(slot: SlotSpec, event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file === undefined) {
      return;
    }
    void file.text().then((text) => patchRow(slot.kind, { value: text }));
  }

  const presenceOf = (kind: string): CredentialPresenceItem | undefined =>
    presence.find((row) => row.kind === kind);

  if (!loaded) {
    return <p className="muted">Loading credentials…</p>;
  }

  const groups: SlotSpec['group'][] = ['execution', 'source', 'deploy'];
  return (
    <div className="credential-wizard" data-testid="credential-wizard">
      {groups.map((group) => (
        <section key={group} className="credential-wizard__group">
          <h3 className="credential-wizard__group-title">{GROUP_TITLES[group]}</h3>
          {SLOTS.filter((slot) => slot.group === group).map((slot) => {
            const row = rowOf(slot.kind);
            const current = presenceOf(slot.kind);
            return (
              <div key={slot.kind} className="credential-row" data-testid={`slot-${slot.kind}`}>
                <div className="credential-row__head">
                  <span className="credential-row__label">{slot.label}</span>
                  {current?.present === true ? (
                    <span className={`badge sev-${current.validatedAt !== undefined ? 'success' : 'warn'}`}>
                      <span className="badge__dot" aria-hidden="true" />
                      {current.validatedAt !== undefined ? 'ready' : 'saved (unverified)'}
                    </span>
                  ) : (
                    <span className="badge sev-info">
                      <span className="badge__dot" aria-hidden="true" />
                      not set
                    </span>
                  )}
                </div>
                <p className="muted credential-row__hint">{slot.hint}</p>
                <div className="credential-row__controls">
                  {slot.upload === true ? (
                    <input
                      type="file"
                      accept="application/json,.json"
                      aria-label={`${slot.label} file`}
                      onChange={(event) => onUpload(slot, event)}
                      disabled={row.busy}
                    />
                  ) : (
                    <input
                      type="password"
                      aria-label={slot.label}
                      placeholder="Paste the value…"
                      value={row.value}
                      onChange={(event) => patchRow(slot.kind, { value: event.target.value })}
                      disabled={row.busy}
                      autoComplete="off"
                    />
                  )}
                  <button
                    type="button"
                    className="button"
                    onClick={() => void save(slot)}
                    disabled={row.busy || row.value.trim().length === 0}
                  >
                    {row.busy ? 'Validating…' : 'Validate & save'}
                  </button>
                  {current?.present === true ? (
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={() => void remove(slot, false)}
                      disabled={row.busy}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                {row.confirmDelete !== undefined ? (
                  <div className="credential-row__confirm" role="alertdialog" aria-label="Confirm delete">
                    <p>
                      Deleting may block the next spawn of your active run(s):{' '}
                      <span className="mono">
                        {row.confirmDelete.runs.map((run) => run.title ?? run.runId).join(', ') ||
                          'active runs'}
                      </span>
                      . They will raise a fix-credentials intervention, not fail silently.
                    </p>
                    <div className="row">
                      <button type="button" className="button" onClick={() => void remove(slot, true)}>
                        Delete anyway
                      </button>
                      <button
                        type="button"
                        className="button button--ghost"
                        onClick={() => patchRow(slot.kind, { confirmDelete: undefined, message: undefined })}
                      >
                        Keep it
                      </button>
                    </div>
                  </div>
                ) : null}
                {row.message !== undefined && row.confirmDelete === undefined ? (
                  <p className={`credential-row__message credential-row__message--${row.messageTone ?? 'ok'}`} role="status">
                    {row.message}
                  </p>
                ) : null}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
