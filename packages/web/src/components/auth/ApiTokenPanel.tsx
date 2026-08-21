'use client';

/**
 * Personal API token panel (multi-user U10, F8). Minting shows the value
 * EXACTLY ONCE — it is stored hashed server-side and can never be re-read.
 * Rotating mints a new token and revokes the old in one operation.
 */
import { useState } from 'react';
import { useSession } from '../session-context';
import { mintApiToken } from '../../lib/api-client';

export function ApiTokenPanel({ hasToken }: { readonly hasToken?: boolean }) {
  const session = useSession();
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState(hasToken === true);

  async function mint(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await mintApiToken(session);
    setBusy(false);
    if (result.ok) {
      setMinted(result.data.token);
      setExisting(true);
      return;
    }
    setError(result.message ?? 'Could not mint the token.');
  }

  return (
    <div className="api-token-panel" data-testid="api-token-panel">
      <p className="muted">
        Your personal API token authenticates the CLI, the MCP connector, and the ChatGPT Action
        as YOU (header slot <span className="mono">x-operator-token</span> or{' '}
        <span className="mono">Authorization: Bearer</span>).
      </p>
      {minted !== null ? (
        <div className="api-token-panel__minted" role="status">
          <p>
            Copy it now — this is the ONLY time it is shown (stored hashed server-side):
          </p>
          <code className="mono" data-testid="minted-token">
            {minted}
          </code>
        </div>
      ) : null}
      {error !== null ? (
        <p className="auth-form__error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" className="button" onClick={() => void mint()} disabled={busy}>
        {busy ? 'Minting…' : existing ? 'Rotate token (revokes the old one)' : 'Mint API token'}
      </button>
    </div>
  );
}
