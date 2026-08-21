// @vitest-environment jsdom
/**
 * Credential wizard + settings/admin component tests (multi-user U10).
 * Pins the browser-side contract: busy discipline during probes (no
 * double-submit), G17 rate-limited copy, invalid → mint instructions, the
 * delete confirmation naming active runs (G11), once-only API token display
 * (F8), the AdminUsers revoke confirmation, and the zero-credential floor
 * nudge. Server behavior is pinned in credentials-routes.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SessionProvider } from '../../src/components/session-context';
import { CredentialWizard } from '../../src/components/auth/CredentialWizard';
import { ApiTokenPanel } from '../../src/components/auth/ApiTokenPanel';
import { AdminUsers } from '../../src/components/auth/AdminUsers';
import type { ReactNode } from 'react';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SESSION = {
  csrfToken: 'session-csrf',
  multiUser: true,
  identity: { userId: 'u1', username: 'ada', role: 'admin' as const },
};

function withSession(children: ReactNode) {
  return <SessionProvider session={SESSION}>{children}</SessionProvider>;
}

const EMPTY_PRESENCE = {
  credentials: [
    { kind: 'claude_oauth_token', present: false },
    { kind: 'anthropic_api_key', present: false },
    { kind: 'openai_api_key', present: false },
    { kind: 'codex_auth_json', present: false },
    { kind: 'github_token', present: false },
    { kind: 'render_api_key', present: false },
    { kind: 'vercel_token', present: false },
  ],
};

interface Route {
  readonly match: (url: string, init: RequestInit) => boolean;
  readonly respond: (url: string, init: RequestInit) => Promise<{ status: number; body: unknown }>;
}

function stubRoutes(routes: Route[]): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const route = routes.find((candidate) => candidate.match(url, init));
      const { status, body } = route
        ? await route.respond(url, init)
        : { status: 404, body: { error: 'not_found' } };
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { calls };
}

const listRoute: Route = {
  match: (url, init) => url === '/api/credentials' && (init.method ?? 'GET') === 'GET',
  respond: () => Promise.resolve({ status: 200, body: EMPTY_PRESENCE }),
};

describe('CredentialWizard', () => {
  it('save disables the row during a slow probe (no double-submit) then shows ready', async () => {
    let resolveProbe: (value: { status: number; body: unknown }) => void = () => undefined;
    const probePending = new Promise<{ status: number; body: unknown }>((resolve) => {
      resolveProbe = resolve;
    });
    const { calls } = stubRoutes([
      listRoute,
      {
        match: (url, init) =>
          url === '/api/credentials/claude_oauth_token' && init.method === 'POST',
        respond: () => probePending,
      },
    ]);
    render(withSession(<CredentialWizard />));
    const slot = await screen.findByTestId('slot-claude_oauth_token');

    fireEvent.change(within(slot).getByLabelText('Claude Code OAuth token'), {
      target: { value: 'sk-ant-oat01-abc' },
    });
    const save = within(slot).getByRole('button', { name: /validate & save/i });
    fireEvent.click(save);

    // In flight: busy indicator + disabled submit; a second click is a no-op.
    await waitFor(() => expect(save).toBeDisabled());
    expect(within(slot).getByRole('button', { name: /validating/i })).toBeDisabled();
    fireEvent.click(save);
    const posts = calls.filter((call) => call.url === '/api/credentials/claude_oauth_token');
    expect(posts).toHaveLength(1);

    resolveProbe({
      status: 200,
      body: {
        credentials: [
          { kind: 'claude_oauth_token', present: true, validatedAt: 1000 },
          ...EMPTY_PRESENCE.credentials.slice(1),
        ],
        probe: { status: 'valid' },
        message: 'Credential validated and saved (encrypted at rest).',
      },
    });
    await waitFor(() => expect(within(slot).getByText('ready')).toBeInTheDocument());
    expect(within(slot).getByRole('status')).toHaveTextContent('validated and saved');
  });

  it('G17: a rate-limited-but-valid probe shows the honest copy, never "invalid"', async () => {
    stubRoutes([
      listRoute,
      {
        match: (url, init) => url === '/api/credentials/openai_api_key' && init.method === 'POST',
        respond: () =>
          Promise.resolve({
            status: 200,
            body: {
              credentials: EMPTY_PRESENCE.credentials.map((row) =>
                row.kind === 'openai_api_key' ? { ...row, present: true, validatedAt: 1 } : row,
              ),
              probe: { status: 'valid_rate_limited' },
              message:
                'The credential is valid but currently rate-limited (usage window exhausted) — runs will wait for the window to reset.',
            },
          }),
      },
    ]);
    render(withSession(<CredentialWizard />));
    const slot = await screen.findByTestId('slot-openai_api_key');
    fireEvent.change(within(slot).getByLabelText('OpenAI API key'), {
      target: { value: 'sk-openai-x' },
    });
    fireEvent.click(within(slot).getByRole('button', { name: /validate & save/i }));

    const status = await within(slot).findByRole('status');
    expect(status).toHaveTextContent('valid but currently rate-limited');
    expect(status.textContent).not.toMatch(/invalid/i);
  });

  it('an invalid credential stays unsaved and shows the mint instructions', async () => {
    stubRoutes([
      listRoute,
      {
        match: (url, init) =>
          url === '/api/credentials/claude_oauth_token' && init.method === 'POST',
        respond: () =>
          Promise.resolve({
            status: 422,
            body: {
              error: 'credential_invalid',
              message:
                'The CLI rejected the credential. Mint a long-lived token on a machine where the Claude CLI is signed in: run `claude setup-token` and paste the sk-ant-oat… value here.',
            },
          }),
      },
    ]);
    render(withSession(<CredentialWizard />));
    const slot = await screen.findByTestId('slot-claude_oauth_token');
    fireEvent.change(within(slot).getByLabelText('Claude Code OAuth token'), {
      target: { value: 'sk-ant-oat01-wrong' },
    });
    fireEvent.click(within(slot).getByRole('button', { name: /validate & save/i }));

    const status = await within(slot).findByRole('status');
    expect(status).toHaveTextContent('claude setup-token');
    expect(within(slot).getByText('not set')).toBeInTheDocument();
  });

  it('G11: delete warns naming the active runs; only "Delete anyway" re-posts confirmed', async () => {
    const presentPresence = {
      credentials: EMPTY_PRESENCE.credentials.map((row) =>
        row.kind === 'github_token' ? { ...row, present: true, validatedAt: 1 } : row,
      ),
    };
    let deleteCalls = 0;
    const { calls } = stubRoutes([
      {
        match: (url, init) => url === '/api/credentials' && (init.method ?? 'GET') === 'GET',
        respond: () => Promise.resolve({ status: 200, body: presentPresence }),
      },
      {
        match: (url, init) =>
          url === '/api/credentials/github_token/delete' && init.method === 'POST',
        respond: (url, init) => {
          deleteCalls += 1;
          const body = JSON.parse(String(init.body)) as { confirm?: boolean };
          if (body.confirm !== true) {
            return Promise.resolve({
              status: 409,
              body: {
                error: 'confirm_required',
                message: 'You have 1 active run(s)…',
                activeRuns: [{ runId: 'run-7', title: 'Marketplace build', status: 'running' }],
              },
            });
          }
          return Promise.resolve({ status: 200, body: EMPTY_PRESENCE });
        },
      },
      {
        match: (url) => url === '/api/runs',
        respond: () =>
          Promise.resolve({
            status: 200,
            body: { runs: [{ runId: 'run-7', title: 'Marketplace build', status: 'running' }] },
          }),
      },
    ]);
    render(withSession(<CredentialWizard />));
    const slot = await screen.findByTestId('slot-github_token');
    fireEvent.click(within(slot).getByRole('button', { name: /remove/i }));

    // The confirmation names the run; nothing was deleted yet.
    const dialog = await within(slot).findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Marketplace build');
    expect(deleteCalls).toBe(1);

    fireEvent.click(within(dialog).getByRole('button', { name: /delete anyway/i }));
    await waitFor(() => expect(deleteCalls).toBe(2));
    const confirmed = calls
      .filter((call) => call.url === '/api/credentials/github_token/delete')
      .map((call) => JSON.parse(String(call.init.body)) as { confirm?: boolean });
    expect(confirmed[1].confirm).toBe(true);
  });
});

describe('ApiTokenPanel (F8)', () => {
  it('mints once-visible tokens and flips to rotate wording', async () => {
    stubRoutes([
      {
        match: (url, init) => url === '/api/auth/token' && init.method === 'POST',
        respond: () =>
          Promise.resolve({ status: 201, body: { token: 'sfai_sel_secret', shownOnce: true } }),
      },
    ]);
    render(withSession(<ApiTokenPanel />));
    fireEvent.click(screen.getByRole('button', { name: /mint api token/i }));

    expect(await screen.findByTestId('minted-token')).toHaveTextContent('sfai_sel_secret');
    expect(screen.getByRole('status')).toHaveTextContent('ONLY time');
    expect(screen.getByRole('button', { name: /rotate token/i })).toBeInTheDocument();
  });
});

describe('AdminUsers revoke confirmation', () => {
  it('revoke does nothing unconfirmed; the confirmation names the 2 non-terminal runs', async () => {
    let revokeCalls = 0;
    stubRoutes([
      {
        match: (url) => url === '/api/auth/users',
        respond: () =>
          Promise.resolve({
            status: 200,
            body: {
              users: [
                {
                  userId: 'u2',
                  username: 'bob',
                  role: 'user',
                  createdAt: 1,
                  revoked: false,
                  hasApiToken: true,
                },
              ],
            },
          }),
      },
      {
        match: (url) => url === '/api/runs',
        respond: () =>
          Promise.resolve({
            status: 200,
            body: {
              runs: [
                { runId: 'run-1', title: 'Bob app one', status: 'running', ownerId: 'u2' },
                { runId: 'run-2', title: 'Bob app two', status: 'planned', ownerId: 'u2' },
                { runId: 'run-3', title: 'Done app', status: 'completed', ownerId: 'u2' },
              ],
            },
          }),
      },
      {
        match: (url, init) => url === '/api/auth/users/u2/revoke' && init.method === 'POST',
        respond: () => {
          revokeCalls += 1;
          return Promise.resolve({
            status: 200,
            body: { ok: true, sessionsInvalidated: 1, apiTokensRevoked: 1, runsCancelled: ['run-1', 'run-2'] },
          });
        },
      },
    ]);
    render(withSession(<AdminUsers />));
    const row = await screen.findByTestId('user-bob');
    fireEvent.click(within(row).getByRole('button', { name: /revoke/i }));

    // Confirmation names EXACTLY the two non-terminal runs; nothing fired yet.
    const dialog = await screen.findByRole('alertdialog');
    const named = within(dialog).getByTestId('revoke-named-runs');
    expect(named).toHaveTextContent('Bob app one, Bob app two');
    expect(named.textContent).not.toContain('Done app');
    expect(revokeCalls).toBe(0);

    // Cancel → still nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    expect(revokeCalls).toBe(0);

    // Ask again and CONFIRM → exactly one destructive call.
    fireEvent.click(within(row).getByRole('button', { name: /revoke/i }));
    const dialog2 = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog2).getByRole('button', { name: /revoke user/i }));
    await waitFor(() => expect(revokeCalls).toBe(1));
    expect(await screen.findByRole('status')).toHaveTextContent('2 run(s) cancelled');
  });
});
