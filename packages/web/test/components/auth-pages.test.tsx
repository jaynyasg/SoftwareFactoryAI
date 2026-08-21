// @vitest-environment jsdom
/**
 * Auth surface component tests (multi-user U9): the login form, the invite
 * redemption form (incl. the SINGLE designed dead-invite state — G12), the
 * user menu affordance, and the client 401 → login redirect. End-to-end
 * cookie/session behavior is covered by the server suites
 * (auth-routes.test.ts); these tests pin the browser-side contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionProvider } from '../../src/components/session-context';
import { LoginForm } from '../../src/components/auth/LoginForm';
import { InviteRedemptionForm } from '../../src/components/auth/InviteRedemptionForm';
import { UserMenu } from '../../src/components/auth/UserMenu';
import { sameSiteReturnTo } from '../../src/lib/safe-return-to';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Stub fetch and capture calls; each call answers from the queue (last repeats). */
function stubFetch(
  responses: { status: number; body: unknown }[],
): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const next = responses.length > 1 ? responses.shift() : responses[0];
      const { status, body } = next ?? { status: 200, body: {} };
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { calls };
}

/** Capture window.location.assign without navigating jsdom. */
function stubNavigation(): { assigned: string[] } {
  const assigned: string[] = [];
  const original = window.location;
  vi.stubGlobal('location', {
    ...original,
    assign: (url: string) => {
      assigned.push(url);
    },
  });
  return { assigned };
}

describe('LoginForm', () => {
  it('posts credentials with the pre-auth CSRF pair and navigates to the return-to', async () => {
    const { calls } = stubFetch([{ status: 200, body: { identity: { username: 'ada' } } }]);
    const { assigned } = stubNavigation();
    render(<LoginForm returnTo="/runs/run-42" />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'correct-horse-battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(assigned).toEqual(['/runs/run-42']));
    expect(calls[0].url).toBe('/api/auth/login');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-preauth-csrf']).toBeDefined();
    expect(document.cookie).toContain(`sf_preauth=${headers['x-preauth-csrf']}`);
    // The body carries credentials only — never any token.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      username: 'ada',
      password: 'correct-horse-battery',
    });
  });

  it('wrong password → ONE generic failure (no username-exists oracle)', async () => {
    stubFetch([
      { status: 401, body: { error: 'invalid_credentials', message: 'Invalid username or password.' } },
    ]);
    const { assigned } = stubNavigation();
    render(<LoginForm returnTo="/" />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'nobody' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrong-password!' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password.');
    expect(assigned).toEqual([]);
  });

  it('a protocol-relative return-to never leaves the site (open-redirect guard)', async () => {
    stubFetch([{ status: 200, body: {} }]);
    const { assigned } = stubNavigation();
    render(<LoginForm returnTo="//evil.example/phish" />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'correct-horse-battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // "//evil.example" does start with '/', so the FORM itself must not treat
    // it as same-site; the page-level safeReturnTo already normalizes, and the
    // form falls back to '/' for anything scheme-relative.
    await waitFor(() => expect(assigned.length).toBe(1));
    expect(assigned[0]).toBe('/');
  });

  it('a backslash-smuggled return-to (/\\evil.com) never leaves the site (open-redirect guard)', async () => {
    stubFetch([{ status: 200, body: {} }]);
    const { assigned } = stubNavigation();
    // Browsers normalize '\' to '/' in http(s) URLs (WHATWG), so '/\evil.com'
    // resolves off-site if it slips through a naive startsWith('/') check.
    render(<LoginForm returnTo="/\evil.com/phish" />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'correct-horse-battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(assigned.length).toBe(1));
    expect(assigned[0]).toBe('/');
  });

  it('a tab-smuggled return-to (/<TAB>/evil.com) never leaves the site (open-redirect guard)', async () => {
    stubFetch([{ status: 200, body: {} }]);
    const { assigned } = stubNavigation();
    // The WHATWG URL parser strips ASCII tab/LF/CR BEFORE resolving, so
    // "/<TAB>/evil.com" collapses to "//evil.com" (scheme-relative → off-site)
    // at window.location.assign time. A positional "second char" guard can't
    // see past the stripped char; the shared guard rejects the control class.
    const tab = String.fromCharCode(9);
    render(<LoginForm returnTo={`/${tab}/evil.com/phish`} />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'correct-horse-battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(assigned.length).toBe(1));
    expect(assigned[0]).toBe('/');
  });
});

describe('sameSiteReturnTo (shared open-redirect guard — also backs the login page)', () => {
  const tab = String.fromCharCode(9);
  const lf = String.fromCharCode(10);
  const cr = String.fromCharCode(13);

  it('admits genuine same-site absolute paths (and a bare slash)', () => {
    expect(sameSiteReturnTo('/')).toBe('/');
    expect(sameSiteReturnTo('/runs/run-42')).toBe('/runs/run-42');
    expect(sameSiteReturnTo('/settings?tab=credentials')).toBe('/settings?tab=credentials');
  });

  it('falls back to "/" for undefined and non-absolute values', () => {
    expect(sameSiteReturnTo(undefined)).toBe('/');
    expect(sameSiteReturnTo('')).toBe('/');
    expect(sameSiteReturnTo('runs/run-42')).toBe('/');
    expect(sameSiteReturnTo('https://evil.com')).toBe('/');
  });

  it('rejects scheme-relative and backslash-smuggled off-site targets', () => {
    expect(sameSiteReturnTo('//evil.com/phish')).toBe('/');
    expect(sameSiteReturnTo('/\\evil.com/phish')).toBe('/');
  });

  it('rejects control-char (tab/LF/CR) smuggling that the URL parser would strip', () => {
    expect(sameSiteReturnTo(`/${tab}/evil.com`)).toBe('/');
    expect(sameSiteReturnTo(`/${lf}/evil.com`)).toBe('/');
    expect(sameSiteReturnTo(`/${cr}/evil.com`)).toBe('/');
    // A control char anywhere in the value is rejected, not just position 1.
    expect(sameSiteReturnTo(`/runs${tab}/x`)).toBe('/');
  });
});

describe('InviteRedemptionForm (G12)', () => {
  function fill(): void {
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'new-user' } });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: 'a-long-password-12' },
    });
    fireEvent.change(screen.getByLabelText(/confirm/i), {
      target: { value: 'a-long-password-12' },
    });
  }

  it('redeems and lands signed-in in the credential wizard', async () => {
    const { calls } = stubFetch([{ status: 201, body: { identity: { username: 'new-user' } } }]);
    const { assigned } = stubNavigation();
    render(<InviteRedemptionForm token="invite-token-abc" />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(assigned).toEqual(['/onboarding']));
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ token: 'invite-token-abc' });
  });

  it('expired/revoked/redeemed invites all render the ONE generic failure state', async () => {
    stubFetch([{ status: 400, body: { error: 'invalid_invite' } }]);
    render(<InviteRedemptionForm token="dead-token" />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    const dead = await screen.findByTestId('invite-dead');
    expect(dead).toHaveTextContent('This invite is no longer valid — ask your admin for a new one.');
    // The form is gone: one designed state, not a broken page.
    expect(screen.queryByRole('button', { name: /create account/i })).toBeNull();
  });

  it('field-level problems (taken username) stay on the form with the server message', async () => {
    stubFetch([{ status: 400, body: { error: 'username_taken', message: 'That username is taken.' } }]);
    render(<InviteRedemptionForm token="live-token" />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That username is taken.');
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  });
});

describe('UserMenu', () => {
  it('renders nothing single-tenant (operator-token session)', () => {
    render(
      <SessionProvider session={{ operatorToken: 'tok', csrfToken: 'csrf' }}>
        <UserMenu />
      </SessionProvider>,
    );
    expect(screen.queryByTestId('user-menu')).toBeNull();
  });

  it('shows the signed-in user and signs out through the guarded route', async () => {
    const { calls } = stubFetch([{ status: 200, body: { ok: true } }]);
    const { assigned } = stubNavigation();
    render(
      <SessionProvider
        session={{
          csrfToken: 'session-csrf',
          multiUser: true,
          identity: { userId: 'u1', username: 'ada', role: 'admin' },
        }}
      >
        <UserMenu />
      </SessionProvider>,
    );
    expect(screen.getByTestId('user-menu')).toHaveTextContent('ada · admin');

    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(assigned).toEqual(['/login']));
    expect(calls[0].url).toBe('/api/auth/logout');
    expect((calls[0].init.headers as Record<string, string>)['x-csrf-token']).toBe('session-csrf');
    // NO operator token anywhere near a multi-user mutation.
    expect(JSON.stringify(calls[0].init.headers)).not.toContain('x-operator-token');
  });
});

describe('expired session mid-poll (client 401 handling)', () => {
  it('one 401 unauthenticated → redirected to login with a return-to, no crash', async () => {
    stubFetch([{ status: 401, body: { error: 'unauthenticated' } }]);
    const { assigned } = stubNavigation();
    const { fetchAggregate } = await import('../../src/lib/api-client');

    await expect(fetchAggregate('run-1', 0)).rejects.toThrow('run_fetch_failed:401');
    expect(assigned.length).toBe(1);
    expect(assigned[0]).toContain('/login?returnTo=');
  });
});
