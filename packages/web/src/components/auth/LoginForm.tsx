'use client';

/**
 * Login form (multi-user U9). Posts username+password with the pre-auth CSRF
 * pair; success sets the HttpOnly session cookie server-side and the browser
 * navigates to the return-to (a full navigation so server components re-read
 * the fresh cookie). Failures show ONE generic message — no username-exists
 * oracle — except an explicit lockout, which is safe to name.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { preauthPost } from './preauth';

export function LoginForm({ returnTo }: { readonly returnTo: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await preauthPost('/api/auth/login', { username, password });
      if (res.ok) {
        // Same-site relative paths only ('//host' is scheme-relative — never
        // follow it): the login redirect must not become an open redirect.
        const safe = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
        window.location.assign(safe);
        return;
      }
      setError(
        res.body.error === 'locked_out'
          ? 'Too many attempts — try again in a few minutes.'
          : 'Invalid username or password.',
      );
    } catch {
      setError('Could not reach the server — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit} aria-label="Sign in">
      <label className="auth-form__field">
        <span>Username</span>
        <input
          name="username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
      </label>
      <label className="auth-form__field">
        <span>Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>
      {error !== null ? (
        <p className="auth-form__error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="button" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
