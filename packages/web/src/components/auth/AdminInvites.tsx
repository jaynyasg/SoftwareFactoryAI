'use client';

/**
 * Admin invite management (multi-user U10). Issuing an invite shows the link
 * exactly once — the token is stored hashed and can never be re-read.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../session-context';
import { createInvite, fetchInvites, revokeInvite } from '../../lib/api-client';
import type { AdminInviteItem } from '../../lib/api-client';

export function AdminInvites() {
  const session = useSession();
  const [invites, setInvites] = useState<readonly AdminInviteItem[]>([]);
  const [mintedLink, setMintedLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setInvites(await fetchInvites());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function issue(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    const result = await createInvite(session);
    setBusy(false);
    if (result.ok) {
      setMintedLink(`${window.location.origin}/invite/${result.data.token}`);
      await refresh();
    }
  }

  async function revoke(inviteId: string): Promise<void> {
    await revokeInvite(session, inviteId);
    await refresh();
  }

  return (
    <div className="admin-invites" data-testid="admin-invites">
      <button type="button" className="button" onClick={() => void issue()} disabled={busy}>
        {busy ? 'Issuing…' : 'Issue invite'}
      </button>
      {mintedLink !== null ? (
        <div className="admin-invites__minted" role="status">
          <p>Hand this link to the invitee — it is shown ONLY once and expires in 7 days:</p>
          <code className="mono" data-testid="invite-link">
            {mintedLink}
          </code>
        </div>
      ) : null}
      <ul className="admin-invites__list">
        {invites.map((invite) => (
          <li key={invite.inviteId} className="admin-invites__row">
            <span className="mono">{invite.inviteId}</span>
            <span className={`badge sev-${invite.status === 'open' ? 'info' : 'warn'}`}>
              {invite.status}
            </span>
            {invite.status === 'open' ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => void revoke(invite.inviteId)}
              >
                Revoke
              </button>
            ) : null}
          </li>
        ))}
        {invites.length === 0 ? <li className="muted">No invites yet.</li> : null}
      </ul>
    </div>
  );
}
