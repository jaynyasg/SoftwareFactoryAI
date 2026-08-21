/**
 * U5 — run ownership in the ledger and owner-scoped surfaces.
 *
 * Two users (A, B) plus the admin on one multi-user factory:
 *  - runs durably carry the creating account (`ownerId` + actor id on
 *    `run.created`);
 *  - every read surface (list, detail, events, execution, workspace, outputs,
 *    research, interventions) shows users their OWN runs only — foreign run
 *    ids answer the same 404 as unknown ids; admins see everything with owner
 *    labels;
 *  - mutations are owner-or-admin: a foreign caller gets 403 and the attempt
 *    is audited as `security.command_rejected`; an admin acting on a user's
 *    run records the ADMIN as the event actor (G16);
 *  - legacy runs without an ownerId are admin-owned (G5);
 *  - credential interventions are owner-actionable only.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  type EventStore,
  type FactoryEvent,
} from '@software-factory/core';
import { createApp, type ApiRequest, type ApiResponse, type App } from '../../src/server/app';
import { createAuthService, createInMemoryAuthStores } from '../../src/server/auth/service';
import type { Identity } from '../../src/server/auth/records';
import { raiseIntervention } from '../../src/server/execution/interventions';

const ORIGIN = 'http://127.0.0.1:5173';
const BOOTSTRAP = 'bootstrap-invite-0123456789abcdef';
const PASSWORD = 'correct-horse-battery';

function deterministic() {
  let id = 0;
  let now = 1_700_000_000_000;
  return {
    idGenerator: () => `evt-${(id += 1)}`,
    clock: () => (now += 1000),
  };
}

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

interface SessionFixture {
  readonly cookie: string;
  readonly csrf: string;
  readonly identity: Identity;
}

/** Session-authenticated request headers (mutations carry the CSRF). */
function authed(session: SessionFixture, mutating = false): Record<string, string | undefined> {
  return {
    cookie: session.cookie,
    origin: ORIGIN,
    ...(mutating ? { 'x-csrf-token': session.csrf } : {}),
  };
}

describe('owner-scoped surfaces (U5)', () => {
  let app: App;
  let store: EventStore;
  let admin: SessionFixture;
  let userA: SessionFixture;
  let userB: SessionFixture;
  let runA: string;
  let runB: string;

  async function redeem(token: string, username: string): Promise<SessionFixture> {
    const res = await app.handle(
      req('POST', '/api/auth/invite/redeem', {}, { token, username, password: PASSWORD }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const raw = res.headers?.['set-cookie'] as string;
    const body = res.body as { identity: Identity; csrfToken: string };
    return { cookie: raw.split(';')[0], csrf: body.csrfToken, identity: body.identity };
  }

  async function createRunAs(session: SessionFixture, prompt: string): Promise<string> {
    const res = await app.handle(req('POST', '/api/runs', authed(session, true), { prompt }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return (res.body as { runId: string }).runId;
  }

  beforeAll(async () => {
    store = createInMemoryEventStore(deterministic());
    const service = createAuthService({
      stores: createInMemoryAuthStores(),
      bootstrapInvite: BOOTSTRAP,
    });
    let runSeq = 0;
    app = createApp({
      store,
      operatorToken: createOperatorTokenProvider({
        store: createInMemoryOperatorTokenStore({ token: 'legacy', createdAt: 0 }),
      }),
      idGenerator: () => `run-${(runSeq += 1)}`,
      config: { allowedOrigins: [ORIGIN] },
      planner: null,
      auth: { service },
    });
    admin = await redeem(BOOTSTRAP, 'the-admin');
    const inviteA = await service.issueInvite(admin.identity.userId);
    userA = await redeem(inviteA.token, 'user-a');
    const inviteB = await service.issueInvite(admin.identity.userId);
    userB = await redeem(inviteB.token, 'user-b');
    runA = await createRunAs(userA, 'build A');
    runB = await createRunAs(userB, 'build B');
  });

  it('run.created durably records the creating account as ownerId AND actor', async () => {
    const events = (await store.readRun(runA)) as FactoryEvent[];
    const created = events.find((event) => event.type === 'run.created');
    expect(created).toBeDefined();
    expect((created?.payload as { ownerId?: string }).ownerId).toBe(userA.identity.userId);
    expect(created?.actor).toEqual({ kind: 'operator', id: userA.identity.userId });
  });

  it('AE4: each user lists only their runs; the admin sees all with owner labels', async () => {
    const listB = await app.handle(req('GET', '/api/runs', authed(userB)));
    const runsB = (listB.body as { runs: { runId: string; ownerId?: string }[] }).runs;
    expect(runsB.map((run) => run.runId)).toEqual([runB]);

    const listAdmin = await app.handle(req('GET', '/api/runs', authed(admin)));
    const runsAdmin = (listAdmin.body as { runs: { runId: string; ownerId?: string }[] }).runs;
    expect(runsAdmin.map((run) => run.runId).sort()).toEqual([runA, runB].sort());
    expect(runsAdmin.find((run) => run.runId === runA)?.ownerId).toBe(userA.identity.userId);
    expect(runsAdmin.find((run) => run.runId === runB)?.ownerId).toBe(userB.identity.userId);
  });

  it("every per-run read surface answers 404 for another user's run — same as an unknown id", async () => {
    for (const path of [
      `/api/runs/${runA}`,
      `/api/runs/${runA}/events`,
      `/api/runs/${runA}/execution`,
      `/api/runs/${runA}/workspace`,
      `/api/runs/${runA}/outputs`,
      `/api/runs/${runA}/research`,
    ]) {
      const asB = await app.handle(req('GET', path, authed(userB)));
      const unknown = await app.handle(req('GET', path.replace(runA, 'run-nope'), authed(userB)));
      expect(asB.status, path).toBe(404);
      expect(errorOf(asB), path).toBe('not_found');
      expect(unknown.status, path).toBe(404);

      const asAdmin = await app.handle(req('GET', path, authed(admin)));
      expect(asAdmin.status, path).toBe(200);
      const asOwner = await app.handle(req('GET', path, authed(userA)));
      expect(asOwner.status, path).toBe(200);
    }
  });

  it("B mutating A's run → 403 not_owner + security.command_rejected on A's ledger", async () => {
    const res = await app.handle(
      req('POST', `/api/runs/${runA}/cancel`, authed(userB, true), { reason: 'nope' }),
    );
    expect(res.status).toBe(403);
    expect(errorOf(res)).toBe('not_owner');

    const events = (await store.readRun(runA)) as FactoryEvent[];
    const rejected = events.find((event) => event.type === 'security.command_rejected');
    expect(rejected).toBeDefined();
    expect((rejected?.payload as { reason?: string }).reason).toBe('not_owner');
    expect(rejected?.actor.id).toBe(userB.identity.userId);
    // The run itself is untouched.
    expect(events.some((event) => event.type === 'run.cancelled')).toBe(false);
  });

  it("admin mutating B's run succeeds and records the ADMIN as the actor (G16)", async () => {
    const res = await app.handle(
      req('POST', `/api/runs/${runB}/cancel`, authed(admin, true), { reason: 'admin cleanup' }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const events = (await store.readRun(runB)) as FactoryEvent[];
    const cancelled = events.find((event) => event.type === 'run.cancelled');
    expect(cancelled?.actor).toEqual({ kind: 'operator', id: admin.identity.userId });
  });

  it('a legacy run without ownerId is ADMIN-owned: invisible to users, visible to the admin', async () => {
    await store.append({
      runId: 'run-legacy',
      type: 'run.created',
      actor: { kind: 'operator', id: 'operator' },
      subject: { kind: 'run', id: 'run-legacy', version: 0 },
      severity: 'info',
      payload: { prompt: 'created before multi-user existed' },
    });
    const asA = await app.handle(req('GET', '/api/runs/run-legacy', authed(userA)));
    expect(asA.status).toBe(404);
    const asAdmin = await app.handle(req('GET', '/api/runs/run-legacy', authed(admin)));
    expect(asAdmin.status).toBe(200);
    const list = await app.handle(req('GET', '/api/runs', authed(userA)));
    expect(
      (list.body as { runs: { runId: string }[] }).runs.some((run) => run.runId === 'run-legacy'),
    ).toBe(false);
  });

  it('interventions: owner-scoped queue; admin resolves retry_choice; credential kind stays owner-only', async () => {
    await raiseIntervention(store, {
      runId: runA,
      interventionId: 'iv-retry-a',
      kind: 'retry_choice',
      blockingStage: 'execution',
      severity: 'warn',
      reason: 'attempt stopped early',
      requiredAction: 'retry or cancel',
    });
    await raiseIntervention(store, {
      runId: runA,
      interventionId: 'iv-creds-a',
      kind: 'missing_credentials',
      blockingStage: 'preflight',
      severity: 'error',
      reason: 'no usable execution adapter for this account',
      requiredAction: 'add credentials in Settings',
    });

    // B sees NEITHER (both are on A's run); A sees both; admin sees both.
    const asB = await app.handle(req('GET', '/api/interventions', authed(userB)));
    const bIds = (asB.body as { interventions: { interventionId: string }[] }).interventions.map(
      (item) => item.interventionId,
    );
    expect(bIds).not.toContain('iv-retry-a');
    expect(bIds).not.toContain('iv-creds-a');

    const asA = await app.handle(req('GET', '/api/interventions', authed(userA)));
    const aIds = (asA.body as { interventions: { interventionId: string }[] }).interventions.map(
      (item) => item.interventionId,
    );
    expect(aIds).toEqual(expect.arrayContaining(['iv-retry-a', 'iv-creds-a']));

    // B cannot resolve A's intervention (403 + audit); the ADMIN can resolve
    // the retry_choice…
    const bResolve = await app.handle(
      req('POST', '/api/interventions/iv-retry-a/resolve', authed(userB, true), {
        resolution: 'retry',
      }),
    );
    expect(bResolve.status).toBe(403);
    expect(errorOf(bResolve)).toBe('not_owner');

    const adminResolve = await app.handle(
      req('POST', '/api/interventions/iv-retry-a/resolve', authed(admin, true), {
        resolution: 'retry',
      }),
    );
    expect(adminResolve.status, JSON.stringify(adminResolve.body)).toBe(200);

    // …but NOT the credential intervention — only the owner can fix their own
    // credentials.
    const adminCreds = await app.handle(
      req('POST', '/api/interventions/iv-creds-a/resolve', authed(admin, true), {
        resolution: 'added',
      }),
    );
    expect(adminCreds.status).toBe(403);
    expect(errorOf(adminCreds)).toBe('owner_action_required');

    const ownerCreds = await app.handle(
      req('POST', '/api/interventions/iv-creds-a/resolve', authed(userA, true), {
        resolution: 'added credentials',
      }),
    );
    expect(ownerCreds.status, JSON.stringify(ownerCreds.body)).toBe(200);
  });
});
