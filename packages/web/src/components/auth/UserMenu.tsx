'use client';

/**
 * Current-user affordance for the AppShell header (multi-user U9). Renders
 * nothing single-tenant (or outside a session provider, e.g. the read-only
 * operator dashboard). Logout posts through the guarded route with the
 * per-session CSRF, then navigates to the login screen.
 */
import { useState } from 'react';
import { useOptionalSession } from '../session-context';

export function UserMenu() {
  const session = useOptionalSession();
  const [busy, setBusy] = useState(false);
  if (session === null || session.multiUser !== true || session.identity === undefined) {
    return null;
  }
  const { username, role } = session.identity;

  async function logout(): Promise<void> {
    setBusy(true);
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': session?.csrfToken ?? '',
        },
      });
    } finally {
      window.location.assign('/login');
    }
  }

  return (
    <span className="app-header__user" data-testid="user-menu">
      <span className="mono" title={role === 'admin' ? 'Admin account' : 'Account'}>
        {username}
        {role === 'admin' ? ' · admin' : ''}
      </span>
      <button
        type="button"
        className="button button--ghost"
        onClick={() => void logout()}
        disabled={busy}
      >
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </span>
  );
}
