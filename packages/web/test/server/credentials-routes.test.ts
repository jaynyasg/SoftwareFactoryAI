/**
 * U10 — per-user credential routes.
 *
 * Pins the wizard's server contract: validate-then-save with per-kind mint
 * instructions on rejection, G17's "valid but rate-limited" distinction, the
 * 64KB/JSON auth.json cap, the delete confirmation naming active runs (G11),
 * and the presence-only guarantee — a credential value NEVER appears in any
 * response and never lands readable at rest.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createCredentialVault,
  createInMemoryCredentialStore,
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  createSecretBox,
  generateMasterKey,
} from '@software-factory/core';
import type { CredentialStore, CredentialVault, EventStore } from '@software-factory/core';
import { createApp, type ApiRequest, type ApiResponse, type App } from '../../src/server/app';
import { createAuthService, createInMemoryAuthStores } from '../../src/server/auth/service';
import type { Identity } from '../../src/server/auth/records';
import type { CredentialProbeOutcome } from '../../src/server/routes/credentials';

const ORIGIN = 'http://127.0.0.1:5173';
const BOOTSTRAP = 'bootstrap-invite-0123456789abcdef';
const PASSWORD = 'correct-horse-battery';
const CLAUDE_TOKEN = 'sk-ant-oat01-wizard-test-secret';

function req(
  method: string,
  path: string,
  headers: Record<string, string | undefined> = {},
  body?: unknown,
): ApiRequest {
  return { method, path, query: {}, headers, body };
}

function errorOf(res: ApiResponse): unknown {
  return (res.body as { error?: unknown }).error;
}

interface Fixture {
  readonly app: App;
  readonly store: EventStore;
  readonly vault: CredentialVault;
  readonly rawStore: CredentialStore;
  readonly user: Identity;
  headers(mutating?: boolean): Record<string, string | undefined>;
  /** Change the probe outcome the fake prober answers next. */
  setProbe(outcome: CredentialProbeOutcome): void;
}

async function makeFixture(): Promise<Fixture> {
  const rawStore = createInMemoryCredentialStore();
  const vault = createCredentialVault({
    box: createSecretBox({ masterKey: generateMasterKey() }),
    store: rawStore,
  });
  const service = createAuthService({
    stores: createInMemoryAuthStores(),
    bootstrapInvite: BOOTSTRAP,
  });
  let probe: CredentialProbeOutcome = { status: 'valid' };
  let runSeq = 0;
  const store = createInMemoryEventStore();
  const app = createApp({
    store,
    operatorToken: createOperatorTokenProvider({
      store: createInMemoryOperatorTokenStore({ token: 'legacy', createdAt: 0 }),
    }),
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN] },
    planner: null,
    auth: { service },
    credentialVault: vault,
    credentialProber: () => Promise.resolve(probe),
  });
  const admin = await service.redeemInvite({
    token: BOOTSTRAP,
    username: 'wizard-user',
    password: PASSWORD,
    ip: 'test',
  });
  if (!admin.ok) {
    throw new Error('bootstrap failed');
  }
  const session = admin.session;
  return {
    app,
    store,
    vault,
    rawStore,
    user: session.identity,
    headers: (mutating = false) => ({
      cookie: `__Host-sf_session=${encodeURIComponent(session.sessionToken)}`,
      origin: ORIGIN,
      ...(mutating ? { 'x-csrf-token': session.csrfToken } : {}),
    }),
    setProbe: (outcome) => {
      probe = outcome;
    },
  };
}

describe('credential routes (U10)', () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await makeFixture();
  });

  it('validate-then-save: a passing probe stores the value ENCRYPTED with validatedAt', async () => {
    fx.setProbe({ status: 'valid' });
    const res = await fx.app.handle(
      req('POST', '/api/credentials/claude_oauth_token', fx.headers(true), {
        value: CLAUDE_TOKEN,
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as {
      credentials: { kind: string; present: boolean; validatedAt?: number }[];
      probe: CredentialProbeOutcome;
    };
    const row = body.credentials.find((item) => item.kind === 'claude_oauth_token');
    expect(row?.present).toBe(true);
    expect(row?.validatedAt).toBeDefined();
    // Presence-only guarantee: the VALUE appears nowhere in the response…
    expect(JSON.stringify(res.body)).not.toContain(CLAUDE_TOKEN);
    // …and never readable at rest (the raw store holds only the sealed blob).
    const atRest = JSON.stringify(await fx.rawStore.load(fx.user.userId));
    expect(atRest).not.toContain(CLAUDE_TOKEN);
    // The vault CAN decrypt it (executions need the real value).
    const read = await fx.vault.readCredential(fx.user.userId, 'claude_oauth_token');
    expect(read.ok && read.value).toBe(CLAUDE_TOKEN);
  });

  it('GET /api/credentials returns presence rows only', async () => {
    const res = await fx.app.handle(req('GET', '/api/credentials', fx.headers()));
    expect(res.status).toBe(200);
    const body = res.body as { credentials: { kind: string; present: boolean }[] };
    expect(body.credentials).toHaveLength(7);
    expect(JSON.stringify(res.body)).not.toContain(CLAUDE_TOKEN);
  });

  it('an INVALID probe rejects with the per-kind mint instructions (claude setup-token)', async () => {
    fx.setProbe({ status: 'invalid', detail: 'The CLI rejected the credential.' });
    const res = await fx.app.handle(
      req('POST', '/api/credentials/claude_oauth_token', fx.headers(true), {
        value: 'sk-ant-oat01-wrong',
      }),
    );
    expect(res.status).toBe(422);
    expect(errorOf(res)).toBe('credential_invalid');
    expect((res.body as { message: string }).message).toContain('claude setup-token');
  });

  it('G17: a usage-limited-but-valid credential SAVES with the honest rate-limited copy', async () => {
    fx.setProbe({ status: 'valid_rate_limited', detail: 'window exhausted' });
    const res = await fx.app.handle(
      req('POST', '/api/credentials/openai_api_key', fx.headers(true), { value: 'sk-openai-x' }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { message: string }).message).toContain('currently rate-limited');
    const row = (res.body as { credentials: { kind: string; validatedAt?: number }[] }).credentials.find(
      (item) => item.kind === 'openai_api_key',
    );
    expect(row?.validatedAt).toBeDefined();
  });

  it('an UNVERIFIABLE probe still saves (unvalidated) — preflight re-checks before runs', async () => {
    fx.setProbe({ status: 'unverifiable', detail: 'codex CLI not installed here' });
    const res = await fx.app.handle(
      req('POST', '/api/credentials/github_token', fx.headers(true), { value: 'ghp_abc' }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { message: string }).message).toContain('could not verify');
    const row = (res.body as { credentials: { kind: string; present: boolean; validatedAt?: number }[] }).credentials.find(
      (item) => item.kind === 'github_token',
    );
    expect(row?.present).toBe(true);
    expect(row?.validatedAt).toBeUndefined();
  });

  it('oversized and non-JSON auth.json uploads are rejected with actionable messages', async () => {
    fx.setProbe({ status: 'valid' });
    const oversized = await fx.app.handle(
      req('POST', '/api/credentials/codex_auth_json', fx.headers(true), {
        value: 'x'.repeat(65 * 1024),
      }),
    );
    expect(oversized.status).toBe(422);
    expect((oversized.body as { message: string }).message).toContain('64KB');

    const notJson = await fx.app.handle(
      req('POST', '/api/credentials/codex_auth_json', fx.headers(true), { value: 'not-json{' }),
    );
    expect(notJson.status).toBe(422);
    expect((notJson.body as { message: string }).message).toContain('not valid JSON');
  });

  it('unknown kinds are 400, and the routes 503 without a vault', async () => {
    const unknown = await fx.app.handle(
      req('POST', '/api/credentials/tls_certificate', fx.headers(true), { value: 'x' }),
    );
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown)).toBe('unknown_kind');
  });

  it('G11: deleting with active runs first asks for confirmation NAMING the runs', async () => {
    // Give the user an active (non-terminal) run.
    const created = await fx.app.handle(
      req('POST', '/api/runs', fx.headers(true), { prompt: 'active run for delete warning' }),
    );
    expect(created.status).toBe(201);
    const runId = (created.body as { runId: string }).runId;

    const unconfirmed = await fx.app.handle(
      req('POST', '/api/credentials/claude_oauth_token/delete', fx.headers(true), {}),
    );
    expect(unconfirmed.status).toBe(409);
    expect(errorOf(unconfirmed)).toBe('confirm_required');
    const named = (unconfirmed.body as { activeRuns: { runId: string }[] }).activeRuns;
    expect(named.map((run) => run.runId)).toContain(runId);
    // Unconfirmed = untouched.
    const still = await fx.vault.readCredential(fx.user.userId, 'claude_oauth_token');
    expect(still.ok).toBe(true);

    const confirmed = await fx.app.handle(
      req('POST', '/api/credentials/claude_oauth_token/delete', fx.headers(true), {
        confirm: true,
      }),
    );
    expect(confirmed.status).toBe(200);
    const gone = await fx.vault.readCredential(fx.user.userId, 'claude_oauth_token');
    expect(gone.ok).toBe(false);
  });

  it('/api/setup surfaces the CALLER credential presence for the zero-credential nudge', async () => {
    const res = await fx.app.handle(req('GET', '/api/setup', fx.headers()));
    expect(res.status).toBe(200);
    const body = res.body as {
      userCredentials?: { execution: boolean; github: boolean };
    };
    // claude_oauth_token was deleted above; openai_api_key survives → execution true.
    expect(body.userCredentials?.execution).toBe(true);
    expect(body.userCredentials?.github).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(CLAUDE_TOKEN);
  });

  it('master-key-unreadable vault answers the typed ADMIN-directed 503 on save', async () => {
    const unreadableVault = createCredentialVault({
      box: null,
      store: createInMemoryCredentialStore(),
    });
    const service = createAuthService({
      stores: createInMemoryAuthStores(),
      bootstrapInvite: BOOTSTRAP,
    });
    const app = createApp({
      store: createInMemoryEventStore(),
      operatorToken: createOperatorTokenProvider({
        store: createInMemoryOperatorTokenStore({ token: 'legacy', createdAt: 0 }),
      }),
      config: { allowedOrigins: [ORIGIN] },
      planner: null,
      auth: { service },
      credentialVault: unreadableVault,
      credentialProber: () => Promise.resolve({ status: 'valid' }),
    });
    const admin = await service.redeemInvite({
      token: BOOTSTRAP,
      username: 'locked-admin',
      password: PASSWORD,
      ip: 'test',
    });
    if (!admin.ok) {
      throw new Error('bootstrap failed');
    }
    const res = await app.handle(
      req('POST', '/api/credentials/anthropic_api_key', {
        cookie: `__Host-sf_session=${encodeURIComponent(admin.session.sessionToken)}`,
        origin: ORIGIN,
        'x-csrf-token': admin.session.csrfToken,
      }, { value: 'sk-ant-api-x' }),
    );
    expect(res.status).toBe(503);
    expect(errorOf(res)).toBe('master_key_unreadable');
    expect((res.body as { message: string }).message).toContain('ADMIN');
  }, 60_000);
});
