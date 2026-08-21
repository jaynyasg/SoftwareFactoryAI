'use client';

/**
 * Invite redemption form (multi-user U9). The invitee chooses their username
 * and password; success creates the account, signs them in (HttpOnly cookie),
 * and lands on the credential wizard route ('/' until U10 mounts the wizard).
 *
 * G12: an expired, revoked, or already-redeemed invite renders ONE designed
 * failure state with a single generic message — the server never distinguishes
 * the causes, and neither do we.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { preauthPost } from './preauth';

const GENERIC_INVITE_FAILURE = 'This invite is no longer valid — ask your admin for a new one.';

export function InviteRedemptionForm({ token }: { readonly token: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [inviteDead, setInviteDead] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await preauthPost('/api/auth/invite/redeem', { token, username, password });
      if (res.ok) {
        window.location.assign('/');
        return;
      }
      if (res.body.error === 'invalid_invite') {
        setInviteDead(true);
        return;
      }
      setError(
        typeof res.body.message === 'string'
          ? res.body.message
          : 'Could not create the account — check the fields and try again.',
      );
    } catch {
      setError('Could not reach the server — try again.');
    } finally {
      setBusy(false);
    }
  }

  if (inviteDead) {
    return (
      <div className="auth-form" data-testid="invite-dead" role="alert">
        <p>{GENERIC_INVITE_FAILURE}</p>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={submit} aria-label="Create your account">
      <label className="auth-form__field">
        <span>Username</span>
        <input
          name="username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
          minLength={3}
          maxLength={32}
        />
      </label>
      <label className="auth-form__field">
        <span>Password (12+ characters)</span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          minLength={12}
        />
      </label>
      <label className="auth-form__field">
        <span>Confirm password</span>
        <input
          name="confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          required
          minLength={12}
        />
      </label>
      {error !== null ? (
        <p className="auth-form__error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="button" disabled={busy}>
        {busy ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  );
}
