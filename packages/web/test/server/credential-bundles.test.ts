/**
 * U7 — executor-level credential binding at execution time.
 *
 * The resolver decrypts the run OWNER's credentials just-in-time and binds a
 * per-job adapter catalog through the U6 spawn-env seam. Pins:
 *  - per-owner bundles (B's run binds B's values; A's binds A's);
 *  - typed failure classes: missing credentials (owner-directed) and
 *    unreadable master key (ADMIN-directed) — R14/G7;
 *  - ephemeral codex-home lifecycle: OS-temp materialization, cleanup on
 *    release (completion AND failure paths), boot orphan sweep, auth.json
 *    write-back with newer-upload-wins;
 *  - preflight per-owner credential checks incl. GitHub-for-repo-source
 *    (G15) — blocked at rehearsal, never mid-checkout;
 *  - end-to-end executor integration: worker spawns bind the owner bundle,
 *    credential values never appear on the ledger (redaction), and the
 *    binding is released after the run.
 */
import { mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createAdapterCatalog,
  createCredentialVault,
  createInMemoryCredentialStore,
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  createSecretBox,
  generateMasterKey,
  projectRun,
} from '@software-factory/core';
import type {
  AdapterCatalog,
  CredentialVault,
  EventStore,
  ExecutionAdapter,
  RunProjection,
  SpawnEnvBundle,
} from '@software-factory/core';
import { createApp, type ApiRequest, type App } from '../../src/server/app';
import { createAuthService, createInMemoryAuthStores } from '../../src/server/auth/service';
import type { Identity } from '../../src/server/auth/records';
import {
  CODEX_HOME_PREFIX,
  createRunCredentialResolver,
  sweepOrphanCodexHomes,
} from '../../src/server/execution/credential-bundles';
import { createExecutionDaemon } from '../../src/server/execution/daemon';
import { createSchedulerTicketExecutor } from '../../src/server/execution/ticket-executor';
import { createRuntimePreflight } from '../../src/server/execution/preflight';
import { filterInterventions, projectInterventions } from '../../src/server/execution/interventions';

const ORIGIN = 'http://127.0.0.1:5173';
const BOOTSTRAP = 'bootstrap-invite-0123456789abcdef';
const PASSWORD = 'correct-horse-battery';
const B_CLAUDE_TOKEN = 'sk-ant-oat01-user-b-secret-token';
const A_CLAUDE_TOKEN = 'sk-ant-oat01-user-a-different-token';
const B_CODEX_AUTH = JSON.stringify({ OPENAI_API_KEY: null, tokens: { access: 'codex-b-access' } });

function deterministic() {
  let id = 0;
  let now = 1_700_000_000_000;
  return {
    idGenerator: () => `evt-${(id += 1)}`,
    clock: () => (now += 1000),
  };
}

function noopTimers() {
  return { setInterval: () => null, clearInterval: () => undefined };
}

function req(
  method: string,
  path: string,
  headers: Record<string, string | undefined> = {},
  body?: unknown,
): ApiRequest {
  return { method, path, query: {}, headers, body };
}

function makeVault(options: { readonly unreadable?: boolean } = {}): CredentialVault {
  return createCredentialVault({
    box: options.unreadable === true ? null : createSecretBox({ masterKey: generateMasterKey() }),
    store: createInMemoryCredentialStore(),
  });
}

/** A run projection stub for resolver unit tests (only ownerId matters). */
function runOwnedBy(ownerId: string | undefined): RunProjection {
  return { runId: 'run-x', ownerId } as unknown as RunProjection;
}

/** Records every bundle the executor binds; adapters echo the secret. */
function recordingCatalogFactory(secretToEcho?: () => string | undefined): {
  factory: (spawnEnv: SpawnEnvBundle) => AdapterCatalog;
  bundles: SpawnEnvBundle[];
} {
  const bundles: SpawnEnvBundle[] = [];
  const factory = (spawnEnv: SpawnEnvBundle): AdapterCatalog => {
    bundles.push(spawnEnv);
    const adapter: ExecutionAdapter = {
      id: 'bound-fake',
      family: 'claude',
      detectSetup: () =>
        Promise.resolve({ available: true, authenticated: true, capacity: 10 }),
      execute: (task, opts) => {
        const secret = secretToEcho?.();
        if (secret !== undefined) {
          // A leaky CLI: echoes its credential into progress output.
          opts.onEvent({ kind: 'progress', message: `env token=${secret}` });
        }
        return Promise.resolve({
          ok: true,
          output: `done:${task.ticketId}`,
          artifacts: [],
          summary: `Completed ${task.ticketId}.`,
        });
      },
      reportCapacity: () => 10,
    };
    return createAdapterCatalog([adapter]);
  };
  return { factory, bundles };
}

/* ----------------------------------------------------------------------------
 * Resolver unit behavior
 * ------------------------------------------------------------------------- */

describe('createRunCredentialResolver', () => {
  it('binds each owner their OWN decrypted values (B then A)', async () => {
    const vault = makeVault();
    await vault.setCredential('user-b', 'claude_oauth_token', B_CLAUDE_TOKEN);
    await vault.setCredential('user-a', 'claude_oauth_token', A_CLAUDE_TOKEN);
    const { factory, bundles } = recordingCatalogFactory();
    const resolve = createRunCredentialResolver({ vault, catalog: factory });

    const b = await resolve(runOwnedBy('user-b'));
    const a = await resolve(runOwnedBy('user-a'));
    expect(b.ok && a.ok).toBe(true);
    expect(bundles[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(B_CLAUDE_TOKEN);
    expect(bundles[1].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(A_CLAUDE_TOKEN);
    if (b.ok) {
      await b.binding.release();
    }
    if (a.ok) {
      await a.binding.release();
    }
  });

  it('no stored execution credential → typed missing_credentials with the owner-directed action', async () => {
    const resolve = createRunCredentialResolver({
      vault: makeVault(),
      catalog: recordingCatalogFactory().factory,
    });
    const result = await resolve(runOwnedBy('user-empty'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('missing_credentials');
      expect(result.requiredAction).toContain('Settings');
      expect(result.requiredAction).toContain('YOUR accounts');
    }
  });

  it('a legacy run without an owner blocks honestly (no credential guessing)', async () => {
    const resolve = createRunCredentialResolver({
      vault: makeVault(),
      catalog: recordingCatalogFactory().factory,
    });
    const result = await resolve(runOwnedBy(undefined));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('missing_credentials');
      expect(result.reason).toContain('predates multi-user accounts');
    }
  });

  it('unreadable master key → ADMIN-directed master_key_unreadable (G7)', async () => {
    const resolve = createRunCredentialResolver({
      vault: makeVault({ unreadable: true }),
      catalog: recordingCatalogFactory().factory,
    });
    const result = await resolve(runOwnedBy('user-b'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('master_key_unreadable');
      expect(result.requiredAction).toContain('ADMIN');
      expect(result.requiredAction).toContain('SF_MASTER_KEY');
    }
  });

  it('codex auth.json: ephemeral OS-temp home, 0600 write, cleanup on release (both paths)', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'sfai-test-root-'));
    const vault = makeVault();
    await vault.setCredential('user-b', 'codex_auth_json', B_CODEX_AUTH);
    const { factory, bundles } = recordingCatalogFactory();
    const resolve = createRunCredentialResolver({ vault, catalog: factory, tempRoot });

    const result = await resolve(runOwnedBy('user-b'));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const home = bundles[0].env.CODEX_HOME;
    expect(home).toBeDefined();
    expect(home).toContain(CODEX_HOME_PREFIX);
    expect(home?.startsWith(tempRoot)).toBe(true);
    expect(await readFile(join(home as string, 'auth.json'), 'utf8')).toBe(B_CODEX_AUTH);

    await result.binding.release();
    expect(existsSync(home as string)).toBe(false);
    // Idempotent: a second release (failure-path double call) is a no-op.
    await result.binding.release();
  });

  it('write-back: a refreshed auth.json re-encrypts into the vault on release', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'sfai-test-root-'));
    let now = 1_000_000;
    const vault = createCredentialVault({
      box: createSecretBox({ masterKey: generateMasterKey() }),
      store: createInMemoryCredentialStore(),
      clock: () => (now += 1),
    });
    await vault.setCredential('user-b', 'codex_auth_json', B_CODEX_AUTH);
    const { factory, bundles } = recordingCatalogFactory();
    const resolve = createRunCredentialResolver({
      vault,
      catalog: factory,
      tempRoot,
      clock: () => (now += 1),
    });

    const result = await resolve(runOwnedBy('user-b'));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const home = bundles[0].env.CODEX_HOME as string;
    const refreshed = JSON.stringify({ tokens: { access: 'codex-b-REFRESHED' } });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(home, 'auth.json'), refreshed, 'utf8');

    await result.binding.release();
    const read = await vault.readCredential('user-b', 'codex_auth_json');
    expect(read.ok && read.value).toBe(refreshed);
  });

  it('newer-upload-wins: an upload DURING the run beats the stale write-back', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'sfai-test-root-'));
    let now = 1_000_000;
    const vault = createCredentialVault({
      box: createSecretBox({ masterKey: generateMasterKey() }),
      store: createInMemoryCredentialStore(),
      clock: () => (now += 1),
    });
    await vault.setCredential('user-b', 'codex_auth_json', B_CODEX_AUTH);
    const { factory, bundles } = recordingCatalogFactory();
    // The resolver's bind timestamp precedes the mid-run upload below.
    const resolve = createRunCredentialResolver({
      vault,
      catalog: factory,
      tempRoot,
      clock: () => now,
    });

    const result = await resolve(runOwnedBy('user-b'));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const home = bundles[0].env.CODEX_HOME as string;
    const staleRefresh = JSON.stringify({ tokens: { access: 'stale-mid-run-rotation' } });
    const freshUpload = JSON.stringify({ tokens: { access: 'FRESH-USER-UPLOAD' } });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(home, 'auth.json'), staleRefresh, 'utf8');
    // The user uploads a NEW auth.json while the run is in flight.
    await vault.setCredential('user-b', 'codex_auth_json', freshUpload);

    await result.binding.release();
    const read = await vault.readCredential('user-b', 'codex_auth_json');
    expect(read.ok && read.value).toBe(freshUpload);
  });

  it('boot orphan sweep removes leftover codex homes, leaves everything else', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'sfai-test-root-'));
    const orphanA = join(tempRoot, `${CODEX_HOME_PREFIX}crashed1`);
    const orphanB = join(tempRoot, `${CODEX_HOME_PREFIX}crashed2`);
    const unrelated = join(tempRoot, 'some-other-dir');
    mkdirSync(orphanA);
    mkdirSync(orphanB);
    mkdirSync(unrelated);

    const removed = await sweepOrphanCodexHomes(tempRoot);
    expect([...removed].sort()).toEqual([orphanA, orphanB].sort());
    expect(existsSync(orphanA)).toBe(false);
    expect(existsSync(orphanB)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });
});

/* ----------------------------------------------------------------------------
 * Multi-user integration: preflight checks + the executor end-to-end
 * ------------------------------------------------------------------------- */

interface MultiUserFixture {
  readonly app: App;
  readonly store: EventStore;
  readonly vault: CredentialVault;
  readonly userB: Identity;
  readonly userA: Identity;
  /** Admin session headers for admin-route calls (revocation test). */
  readonly adminHeaders: Record<string, string | undefined>;
  createRunAs(identity: 'a' | 'b', body?: Record<string, unknown>): Promise<string>;
}

async function makeMultiUserFixture(vault: CredentialVault): Promise<MultiUserFixture> {
  const det = deterministic();
  const store = createInMemoryEventStore(det);
  const service = createAuthService({
    stores: createInMemoryAuthStores(),
    bootstrapInvite: BOOTSTRAP,
  });
  let runSeq = 0;
  const app = createApp({
    store,
    operatorToken: createOperatorTokenProvider({
      store: createInMemoryOperatorTokenStore({ token: 'legacy', createdAt: 0 }),
    }),
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN] },
    auth: { service },
    credentialVault: vault,
  });
  const admin = await service.redeemInvite({
    token: BOOTSTRAP,
    username: 'the-admin',
    password: PASSWORD,
    ip: 'test',
  });
  if (!admin.ok) {
    throw new Error('bootstrap failed');
  }
  const redeem = async (username: string) => {
    const invite = await service.issueInvite(admin.session.identity.userId);
    const result = await service.redeemInvite({
      token: invite.token,
      username,
      password: PASSWORD,
      ip: 'test',
    });
    if (!result.ok) {
      throw new Error('redeem failed');
    }
    return result.session;
  };
  const sessionA = await redeem('user-a');
  const sessionB = await redeem('user-b');
  const cookieName = '__Host-sf_session';

  const createRunAs = async (
    who: 'a' | 'b',
    body: Record<string, unknown> = {},
  ): Promise<string> => {
    const session = who === 'a' ? sessionA : sessionB;
    const res = await app.handle(
      req(
        'POST',
        '/api/runs',
        {
          cookie: `${cookieName}=${encodeURIComponent(session.sessionToken)}`,
          origin: ORIGIN,
          'x-csrf-token': session.csrfToken,
        },
        { prompt: 'Build an AI services marketplace with providers and proposals', ...body },
      ),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return (res.body as { runId: string }).runId;
  };

  return {
    app,
    store,
    vault,
    userA: sessionA.identity,
    userB: sessionB.identity,
    adminHeaders: {
      cookie: `${cookieName}=${encodeURIComponent(admin.session.sessionToken)}`,
      origin: ORIGIN,
      'x-csrf-token': admin.session.csrfToken,
    },
    createRunAs,
  };
}

describe('preflight per-owner credential checks (U7)', () => {
  let fixture: MultiUserFixture;

  beforeAll(async () => {
    fixture = await makeMultiUserFixture(makeVault());
  });

  it('R14: an owner without execution credentials fails the credentials check, owner-directed', async () => {
    const runId = await fixture.createRunAs('b');
    const preflight = createRuntimePreflight({ vault: fixture.vault });
    const result = await preflight(fixture.store, runId);
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('credentials');
    const failure = result.checks.find((check) => check.check === 'credentials');
    expect(failure?.reason).toContain('No execution credential');
    expect(failure?.requiredAction).toContain('Settings');
    // The failure raised an owner-actionable intervention.
    const open = filterInterventions(
      projectInterventions(await fixture.store.readRun(runId)),
      { runId, kind: 'missing_credentials', openOnly: true },
    );
    expect(open.length).toBeGreaterThan(0);
  });

  it('G15: a repo-source run without the owner GitHub token fails at preflight, never mid-checkout', async () => {
    await fixture.vault.setCredential(
      fixture.userB.userId,
      'claude_oauth_token',
      B_CLAUDE_TOKEN,
    );
    const runId = await fixture.createRunAs('b', { githubRepo: 'octo/app' });
    const preflight = createRuntimePreflight({ vault: fixture.vault });
    const result = await preflight(fixture.store, runId);
    expect(result.failedChecks).toContain('credentials');
    const failure = result.checks.find((check) => check.check === 'credentials');
    expect(failure?.reason).toContain('YOUR GitHub token');
    expect(failure?.requiredAction).toContain('fine-grained PAT');

    // With the token stored, the credentials check passes on the next attempt.
    await fixture.vault.setCredential(fixture.userB.userId, 'github_token', 'ghp_userB');
    const retry = await preflight(fixture.store, runId);
    expect(retry.failedChecks).not.toContain('credentials');
  });

  it('G7: an unreadable master key fails the credentials check with the ADMIN-directed message', async () => {
    const unreadable = await makeMultiUserFixture(makeVault({ unreadable: true }));
    const runId = await unreadable.createRunAs('b');
    const preflight = createRuntimePreflight({ vault: unreadable.vault });
    const result = await preflight(unreadable.store, runId);
    expect(result.failedChecks).toContain('credentials');
    const failure = result.checks.find((check) => check.check === 'credentials');
    expect(failure?.requiredAction).toContain('ADMIN');
    expect(failure?.requiredAction).toContain('SF_MASTER_KEY');
  });
});

describe('executor end-to-end with owner credential binding (U7)', () => {
  it("B's run binds B's decrypted bundle; values never reach the ledger; the binding is released", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'sfai-test-root-'));
    const vault = makeVault();
    const fixture = await makeMultiUserFixture(vault);
    await vault.setCredential(fixture.userB.userId, 'claude_oauth_token', B_CLAUDE_TOKEN);
    await vault.setCredential(fixture.userB.userId, 'codex_auth_json', B_CODEX_AUTH);
    await vault.setCredential(fixture.userA.userId, 'claude_oauth_token', A_CLAUDE_TOKEN);

    const { factory, bundles } = recordingCatalogFactory(() => B_CLAUDE_TOKEN);
    const resolver = createRunCredentialResolver({ vault, catalog: factory, tempRoot });
    const det = deterministic();
    let leaseSeq = 0;
    const daemon = createExecutionDaemon({
      store: fixture.store,
      clock: det.clock,
      idGenerator: () => `lease-${(leaseSeq += 1)}`,
      ownerId: 'daemon-u7',
      timers: noopTimers(),
      executor: createSchedulerTicketExecutor({
        adapters: createAdapterCatalog([]),
        credentials: resolver,
        freshWorkspaceRoot: '/virtual/workspaces',
        ensureWorkspaceDir: () => Promise.resolve(),
        clock: det.clock,
      }),
    });

    const runId = await fixture.createRunAs('b');
    await fixture.store.append({
      runId,
      type: 'queue.enqueued',
      actor: { kind: 'system', id: 'test' },
      subject: { kind: 'queue-job', id: `${runId}:execution` },
      severity: 'info',
      payload: { jobId: `${runId}:execution`, jobKind: 'run-execution', attempt: 1 },
    });
    const tick = await daemon.tick();
    expect(tick.claimed).toBe(1);

    // The bound catalog was constructed with B's decrypted values (probes and
    // spawns all go through it), including the ephemeral codex home.
    expect(bundles.length).toBeGreaterThan(0);
    expect(bundles[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(B_CLAUDE_TOKEN);
    expect(bundles[0].env.CODEX_HOME).toContain(CODEX_HOME_PREFIX);

    // The run completed, the leaky progress line was redacted, and NO ledger
    // event carries any credential value (grep-style negative assertion).
    const events = await fixture.store.readRun(runId);
    expect(projectRun(events, runId).status).toBe('completed');
    const raw = JSON.stringify(events);
    expect(raw).not.toContain(B_CLAUDE_TOKEN);
    expect(raw).not.toContain('codex-b-access');
    expect(raw).toContain('[redacted]');

    // Release ran on the completion path: the ephemeral home is gone.
    expect(existsSync(bundles[0].env.CODEX_HOME as string)).toBe(false);

    // A's subsequent run binds A's values.
    const runA = await fixture.createRunAs('a');
    await fixture.store.append({
      runId: runA,
      type: 'queue.enqueued',
      actor: { kind: 'system', id: 'test' },
      subject: { kind: 'queue-job', id: `${runA}:execution` },
      severity: 'info',
      payload: { jobId: `${runA}:execution`, jobKind: 'run-execution', attempt: 1 },
    });
    await daemon.tick();
    const last = bundles[bundles.length - 1];
    expect(last.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(A_CLAUDE_TOKEN);
    expect(last.env.CODEX_HOME).toBeUndefined();
  }, 120_000);

  it('an owner with NO credentials blocks with a missing_credentials intervention (F5/G11)', async () => {
    const vault = makeVault();
    const fixture = await makeMultiUserFixture(vault);
    const { factory } = recordingCatalogFactory();
    const resolver = createRunCredentialResolver({ vault, catalog: factory });
    const det = deterministic();
    let leaseSeq = 0;
    const daemon = createExecutionDaemon({
      store: fixture.store,
      clock: det.clock,
      idGenerator: () => `lease-${(leaseSeq += 1)}`,
      ownerId: 'daemon-u7b',
      timers: noopTimers(),
      executor: createSchedulerTicketExecutor({
        adapters: createAdapterCatalog([]),
        credentials: resolver,
        freshWorkspaceRoot: '/virtual/workspaces',
        ensureWorkspaceDir: () => Promise.resolve(),
        clock: det.clock,
      }),
    });

    const runId = await fixture.createRunAs('b');
    await fixture.store.append({
      runId,
      type: 'queue.enqueued',
      actor: { kind: 'system', id: 'test' },
      subject: { kind: 'queue-job', id: `${runId}:execution` },
      severity: 'info',
      payload: { jobId: `${runId}:execution`, jobKind: 'run-execution', attempt: 1 },
    });
    await daemon.tick();

    const events = await fixture.store.readRun(runId);
    const run = projectRun(events, runId);
    expect(run.status).not.toBe('completed');
    const open = filterInterventions(projectInterventions(events), {
      runId,
      kind: 'missing_credentials',
      openOnly: true,
    });
    expect(open.length).toBeGreaterThan(0);
    expect(open[0].requiredAction).toContain('Settings');
  }, 120_000);
});

describe('revocation cascade completion (U7)', () => {
  it("revoking a user cancels their runs, closes their interventions, and wipes their vault", async () => {
    const vault = makeVault();
    const fixture = await makeMultiUserFixture(vault);
    await vault.setCredential(fixture.userB.userId, 'claude_oauth_token', B_CLAUDE_TOKEN);

    const runId = await fixture.createRunAs('b');
    const { raiseIntervention } = await import('../../src/server/execution/interventions');
    await raiseIntervention(fixture.store, {
      runId,
      interventionId: 'iv-b-open',
      kind: 'retry_choice',
      blockingStage: 'execution',
      severity: 'warn',
      reason: 'attempt stopped early',
      requiredAction: 'retry or cancel',
    });

    const res = await fixture.app.handle(
      req('POST', `/api/auth/users/${fixture.userB.userId}/revoke`, fixture.adminHeaders),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as { runsCancelled: string[] }).runsCancelled).toContain(runId);

    const events = await fixture.store.readRun(runId);
    expect(projectRun(events, runId).status).toBe('cancelled');
    const stillOpen = filterInterventions(projectInterventions(events), {
      runId,
      openOnly: true,
    });
    expect(stillOpen).toEqual([]);

    // Vault wiped: no credential can ever bind for this account again.
    const presence = await vault.getPresence(fixture.userB.userId);
    expect(presence.every((row) => !row.present)).toBe(true);
  }, 120_000);
});

/* ----------------------------------------------------------------------------
 * U8 — usage-wait yielding for cross-user fairness
 * ------------------------------------------------------------------------- */

describe('usage-wait yielding for cross-user fairness (U8)', () => {
  const FAST_USAGE_WAIT = {
    minDelayMs: 1,
    defaultDelayMs: 50,
    maxDelayMs: 50,
    maxTotalWaitMs: 5_000,
    yieldCheckIntervalMs: 2,
  };

  function fairnessHarness(vault: CredentialVault, store: EventStore) {
    let bLimitedRemaining = 1;
    const executions: string[] = [];
    const factory = (spawnEnv: SpawnEnvBundle): AdapterCatalog => {
      const isB = spawnEnv.env.CLAUDE_CODE_OAUTH_TOKEN === B_CLAUDE_TOKEN;
      const adapter: ExecutionAdapter = {
        id: 'bound-fake',
        family: 'claude',
        detectSetup: () =>
          Promise.resolve({ available: true, authenticated: true, capacity: 10 }),
        execute: async (task) => {
          if (isB && bLimitedRemaining > 0) {
            bLimitedRemaining -= 1;
            const { AdapterError } = await import('@software-factory/core');
            return {
              ok: false as const,
              error: AdapterError.usageLimited('usage limit reached', { retryAfterMs: 50 }),
            };
          }
          executions.push(`${spawnEnv.env.CLAUDE_CODE_OAUTH_TOKEN}:${task.ticketId}`);
          return { ok: true as const, output: `done:${task.ticketId}`, artifacts: [] };
        },
        reportCapacity: () => 10,
      };
      return createAdapterCatalog([adapter]);
    };
    const resolver = createRunCredentialResolver({ vault, catalog: factory });
    const det = deterministic();
    let leaseSeq = 0;
    const daemon = createExecutionDaemon({
      store,
      clock: det.clock,
      idGenerator: () => `lease-${(leaseSeq += 1)}`,
      ownerId: 'daemon-u8',
      timers: noopTimers(),
      executor: createSchedulerTicketExecutor({
        adapters: createAdapterCatalog([]),
        credentials: resolver,
        freshWorkspaceRoot: '/virtual/workspaces',
        ensureWorkspaceDir: () => Promise.resolve(),
        clock: det.clock,
        ticketUsageWait: FAST_USAGE_WAIT,
      }),
    });
    return { daemon, executions };
  }

  async function enqueue(store: EventStore, runId: string, notBefore?: number): Promise<void> {
    await store.append({
      runId,
      type: 'queue.enqueued',
      actor: { kind: 'system', id: 'test' },
      subject: { kind: 'queue-job', id: `${runId}:execution` },
      severity: 'info',
      payload: {
        jobId: `${runId}:execution`,
        jobKind: 'run-execution',
        attempt: 1,
        ...(notBefore !== undefined ? { notBefore } : {}),
      },
    });
  }

  it("AE5: B's usage-waiting run yields, C's run executes, B resumes after notBefore", async () => {
    const vault = makeVault();
    const fixture = await makeMultiUserFixture(vault);
    await vault.setCredential(fixture.userB.userId, 'claude_oauth_token', B_CLAUDE_TOKEN);
    await vault.setCredential(fixture.userA.userId, 'claude_oauth_token', A_CLAUDE_TOKEN);
    const { daemon, executions } = fairnessHarness(vault, fixture.store);

    const runB = await fixture.createRunAs('b');
    const runC = await fixture.createRunAs('a');
    await enqueue(fixture.store, runB);
    await enqueue(fixture.store, runC);

    // Tick 1: B claims first, hits the usage limit, sees C's owner waiting,
    // and YIELDS within a hop; C then executes in the SAME pass.
    const tick1 = await daemon.tick();
    expect(tick1.requeued).toBe(1);
    expect(tick1.completed).toBe(1);

    const eventsB = await fixture.store.readRun(runB);
    expect(projectRun(eventsB, runB).status).not.toBe('completed');
    expect(projectRun(await fixture.store.readRun(runC), runC).status).toBe('completed');
    // C executed before ANY of B's tickets completed.
    expect(executions[0]?.startsWith(A_CLAUDE_TOKEN)).toBe(true);

    // The requeue carries the resume hint, and the owner's view is honest.
    const requeued = eventsB.filter((event) => event.type === 'queue.enqueued');
    const withHint = requeued.find(
      (event) => (event.payload as { notBefore?: number }).notBefore !== undefined,
    );
    expect(withHint).toBeDefined();
    const raw = JSON.stringify(eventsB);
    expect(raw).toContain('yielded the executor');

    // Tick 2: the deterministic clock has advanced past notBefore — B resumes
    // and completes (the usage window "reset").
    const tick2 = await daemon.tick();
    expect(tick2.completed).toBe(1);
    expect(projectRun(await fixture.store.readRun(runB), runB).status).toBe('completed');
  }, 120_000);

  it('a not-yet-due requeue idles (no claim, no busy loop); a far-future hint folds cleanly', async () => {
    const vault = makeVault();
    const fixture = await makeMultiUserFixture(vault);
    await vault.setCredential(fixture.userB.userId, 'claude_oauth_token', B_CLAUDE_TOKEN);
    const { daemon } = fairnessHarness(vault, fixture.store);

    const runB = await fixture.createRunAs('b');
    await enqueue(fixture.store, runB, Date.now() + 10 ** 12);

    const tick = await daemon.tick();
    expect(tick.claimed).toBe(0);
    expect(tick.completed).toBe(0);
  }, 120_000);

  it('a yield-requeued run cancelled while waiting is released cancelled, never re-claimed', async () => {
    const vault = makeVault();
    const fixture = await makeMultiUserFixture(vault);
    await vault.setCredential(fixture.userB.userId, 'claude_oauth_token', B_CLAUDE_TOKEN);
    const { daemon } = fairnessHarness(vault, fixture.store);

    const runB = await fixture.createRunAs('b');
    await enqueue(fixture.store, runB, Date.now() + 10 ** 12);
    await fixture.store.append({
      runId: runB,
      type: 'run.cancelled',
      actor: { kind: 'operator', id: fixture.userB.userId },
      subject: { kind: 'run', id: runB },
      severity: 'warn',
      payload: { reason: 'owner cancelled while usage-waiting' },
    });

    const tick = await daemon.tick();
    expect(tick.cancelled).toBe(1);
    expect(tick.claimed).toBe(0);

    // Nothing left queued: a later tick never re-claims the dead job.
    const again = await daemon.tick();
    expect(again.claimed).toBe(0);
  }, 120_000);
});
