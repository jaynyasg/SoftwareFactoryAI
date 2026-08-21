'use client';

/**
 * Admin user management (multi-user U10). Revoking is the most destructive
 * admin action and has no undo, so it is ALWAYS confirmed first — the
 * confirmation names the user's non-terminal runs (they will be cancelled)
 * before the action fires (mirrors the credential-delete warning, G11).
 */
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../session-context';
import { fetchRunsList, fetchUsers, revokeUser } from '../../lib/api-client';
import type { AdminUserItem } from '../../lib/api-client';

interface PendingRevoke {
  readonly user: AdminUserItem;
  readonly activeRuns: readonly { runId: string; title?: string }[];
}

export function AdminUsers() {
  const session = useSession();
  const [users, setUsers] = useState<readonly AdminUserItem[]>([]);
  const [pending, setPending] = useState<PendingRevoke | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setUsers(await fetchUsers());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Step 1: gather what the revoke WILL destroy, then ask. */
  async function askRevoke(user: AdminUserItem): Promise<void> {
    const runs = await fetchRunsList();
    const activeRuns = runs
      .filter(
        (run) =>
          run.runId !== null &&
          run.ownerId === user.userId &&
          run.status !== 'completed' &&
          run.status !== 'failed' &&
          run.status !== 'cancelled',
      )
      .map((run) => ({ runId: run.runId ?? '', title: run.title }));
    setPending({ user, activeRuns });
  }

  /** Step 2: only a confirmed dialog fires the destructive action. */
  async function confirmRevoke(): Promise<void> {
    if (pending === null || busy) {
      return;
    }
    setBusy(true);
    const result = await revokeUser(session, pending.user.userId);
    setBusy(false);
    setPending(null);
    if (result.ok) {
      setNote(
        `Revoked ${pending.user.username}: ${result.data.sessionsInvalidated} session(s) and ` +
          `${result.data.apiTokensRevoked} API token(s) invalidated, ` +
          `${result.data.runsCancelled.length} run(s) cancelled.`,
      );
      await refresh();
      return;
    }
    setNote(result.message ?? 'Revoke failed.');
  }

  return (
    <div className="admin-users" data-testid="admin-users">
      <ul className="admin-users__list">
        {users.map((user) => (
          <li key={user.userId} className="admin-users__row" data-testid={`user-${user.username}`}>
            <span className="mono">{user.username}</span>
            <span className={`badge sev-${user.revoked ? 'error' : 'info'}`}>
              {user.revoked ? 'revoked' : user.role}
            </span>
            {!user.revoked && user.role !== 'admin' ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => void askRevoke(user)}
                disabled={busy}
              >
                Revoke…
              </button>
            ) : null}
          </li>
        ))}
        {users.length === 0 ? <li className="muted">No users yet — issue an invite.</li> : null}
      </ul>

      {pending !== null ? (
        <div className="admin-users__confirm" role="alertdialog" aria-label="Confirm revoke">
          <p>
            Revoke <span className="mono">{pending.user.username}</span>? Their sessions and API
            tokens die immediately, their stored credentials are wiped, and{' '}
            {pending.activeRuns.length > 0 ? (
              <>
                these {pending.activeRuns.length} non-terminal run(s) are CANCELLED:{' '}
                <span className="mono" data-testid="revoke-named-runs">
                  {pending.activeRuns.map((run) => run.title ?? run.runId).join(', ')}
                </span>
                .
              </>
            ) : (
              'they have no non-terminal runs.'
            )}{' '}
            There is no undo.
          </p>
          <div className="row">
            <button type="button" className="button" onClick={() => void confirmRevoke()} disabled={busy}>
              {busy ? 'Revoking…' : 'Revoke user'}
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setPending(null)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {note !== null ? (
        <p className="muted" role="status">
          {note}
        </p>
      ) : null}
    </div>
  );
}
