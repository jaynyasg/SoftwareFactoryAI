/**
 * Remote MCP bridge contract tests (full-factory U5 + U10, multi-user U4).
 *
 * MCP tool shapes are a CONTRACT for hosted web-model callers (Claude.com,
 * ChatGPT.com). These tests pin:
 *   - the complete lifecycle tool list,
 *   - PURE PASS-THROUGH auth (U4): the bridge verifies nothing and injects no
 *     server credentials — the caller's own token is forwarded verbatim and
 *     route-layer 401/403 answers surface as JSON-RPC auth errors,
 *   - single-tenant regression: legacy operator-token mutations still succeed
 *     with NO bridge-injected CSRF (bearer callers are CSRF-exempt),
 *   - multi-user: personal sfai_ tokens act as their user (owned runs,
 *     owner-scoped visibility); revoked/legacy tokens fail with the
 *     route-layer message,
 *   - command-guard/stale-version behavior surfacing through tools,
 *   - idempotent repeats (start/research/resolve return existing state),
 *   - concise run summaries (no full event dumps) plus links/ids for detail,
 *   - the run-outputs artifact contract and setup diagnostics (E5: three
 *     separate credential surfaces, never a secret value).
 */
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  createAdapterCatalog,
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  type EventStore,
  type ExecutionAdapter,
} from '@software-factory/core';
import {
  createApp,
  type App,
  type RunResearcher,
  type RunWorkspaceMaterializer,
} from '../../src/server/app';
import { createExecutionDaemon } from '../../src/server/execution/daemon';
import { handleMcpRequest } from '../../src/server/mcp';
import { resolveRuntimeConfig } from '../../src/server/runtime';
import type { RuntimeConfig } from '../../src/server/runtime';
import { testRuntimeConfig } from '../_helpers/runtime';
import { createAuthService, createInMemoryAuthStores } from '../../src/server/auth/service';

const TOKEN = 'mcp-operator-token';
const CSRF = 'mcp-csrf-token';

const MARKETPLACE_PROMPT = 'Build an AI services marketplace with providers and proposals';

/** Every tool the remote bridge must expose (U5 lifecycle + U10 completion). */
const EXPECTED_TOOLS = [
  'software_factory_create_run',
  'software_factory_list_runs',
  'software_factory_get_run',
  'software_factory_get_events',
  'software_factory_cancel_run',
  'software_factory_cancel_all_runs',
  'software_factory_clear_all_runs',
  'software_factory_review_decide',
  'software_factory_materialize_workspace',
  'software_factory_override_settings',
  'software_factory_publish_workspace',
  'software_factory_get_workspace',
  'software_factory_start_run',
  'software_factory_pause_run',
  'software_factory_resume_run',
  'software_factory_retry_run',
  'software_factory_rerun_gates',
  'software_factory_get_execution',
  'software_factory_get_execution_overview',
  'software_factory_resume_execution',
  'software_factory_hold_execution',
  'software_factory_list_interventions',
  'software_factory_resolve_intervention',
  'software_factory_trigger_research',
  'software_factory_get_research',
  'software_factory_get_contract',
  'software_factory_get_preflight',
  'software_factory_get_outputs',
  'software_factory_get_setup',
] as const;

/** Timers that never fire — no daemon work runs inside these tests. */
function noopTimers(): { setInterval: () => null; clearInterval: () => undefined } {
  return { setInterval: () => null, clearInterval: () => undefined };
}

/** A deterministic, always-ready fake adapter for the preflight catalog. */
function readyFakeAdapter(): ExecutionAdapter {
  return {
    id: 'fake-ready',
    family: 'codex',
    detectSetup: () => Promise.resolve({ available: true, authenticated: true, capacity: 4 }),
    execute: () =>
      Promise.resolve({ ok: false as const, error: AdapterError.unavailable('not used') }),
    reportCapacity: () => 4,
  };
}

/** Deterministic stub researcher: one source, one finding, a completed brief. */
function stubResearcher(): RunResearcher {
  return async (store, runId) => {
    const base = {
      runId,
      actor: { kind: 'researcher' as const, id: 'stub' },
      subject: { kind: 'research', id: runId },
      severity: 'info' as const,
    };
    await store.append({
      ...base,
      type: 'research.requested',
      payload: { objective: 'stub objective' },
    });
    await store.append({
      ...base,
      type: 'research.finding_recorded',
      payload: { findingId: 'f-1', statement: 'Stub finding.', classification: 'verified_fact' },
    });
    await store.append({
      ...base,
      type: 'research.brief_completed',
      payload: { summary: 'Stub research brief.' },
    });
    return {
      status: 'completed' as const,
      briefSummary: 'Stub research brief.',
      sourcesFound: 1,
      sourcesRead: 1,
      findingCount: 1,
      assumptionCount: 0,
      gapCount: 0,
      seededKnowledgeCount: 0,
      recordedKnowledgeEntryIds: [],
      budgetStops: [],
    };
  };
}

interface McpTestContext {
  readonly app: App;
  readonly store: EventStore;
}

/**
 * A deterministic stub materializer: binds a fake repo checkout for any run with
 * a `githubRepo`, otherwise records the source as unavailable. Exercises the MCP
 * workspace tools without real git/network.
 */
function stubMaterializer(): RunWorkspaceMaterializer {
  return async (store, runId) => {
    const created = (await store.readRun(runId)).find((event) => event.type === 'run.created');
    const githubRepo =
      created !== undefined && created.type === 'run.created'
        ? created.payload.githubRepo
        : undefined;
    const base = {
      runId,
      actor: { kind: 'system' as const, id: 'stub-materializer' },
      subject: { kind: 'workspace', id: runId },
    };
    if (githubRepo === undefined) {
      await store.append({
        ...base,
        type: 'workspace.unavailable',
        severity: 'warn',
        payload: {
          source: 'none',
          reason: 'No source input to materialize.',
          requiredAction: 'Provide a GitHub repository.',
        },
      });
      return {
        ok: false,
        outcome: 'unavailable',
        source: 'none',
        reason: 'No source input to materialize.',
        requiredAction: 'Provide a GitHub repository.',
        securityBlocked: false,
      };
    }
    const checkoutPath = `/tmp/checkouts/${runId}`;
    await store.append({
      ...base,
      type: 'workspace.checkout_started',
      severity: 'info',
      payload: { repo: githubRepo, requestedBranch: 'main', checkoutPath, attempt: 1 },
    });
    await store.append({
      ...base,
      type: 'workspace.checkout_completed',
      severity: 'success',
      payload: {
        repo: githubRepo,
        branch: 'main',
        commit: 'stubcommit123',
        checkoutPath,
        dirtyStatePolicy: 'clean_checkout',
      },
    });
    return {
      ok: true,
      converged: false,
      workspace: {
        kind: 'repo_checkout',
        repo: githubRepo,
        branch: 'main',
        commit: 'stubcommit123',
        checkoutPath,
        dirtyStatePolicy: 'clean_checkout',
      },
    };
  };
}

function makeMcp(
  options: {
    readonly researcher?: RunResearcher | null;
    readonly materializer?: RunWorkspaceMaterializer | null;
    readonly runtime?: RuntimeConfig;
  } = {},
): McpTestContext {
  const store = createInMemoryEventStore();
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  let runSeq = 0;
  let leaseSeq = 0;
  const daemon = createExecutionDaemon({
    store,
    idGenerator: () => `mcp-lease-${(leaseSeq += 1)}`,
    ownerId: 'daemon-mcp-test',
    timers: noopTimers(),
  });
  const app = createApp({
    store,
    operatorToken: provider,
    idGenerator: () => `mcp-run-${(runSeq += 1)}`,
    config: { allowedOrigins: [], csrfToken: CSRF, runtime: options.runtime },
    execution: daemon,
    researcher: options.researcher ?? null,
    materializer: options.materializer ?? null,
    // Deterministic ready catalog: these tests exercise the MCP contract, not
    // real CLI setup probing (covered by execution-worker tests).
    adapterCatalog: createAdapterCatalog([readyFakeAdapter()]),
  });
  return { app, store };
}

function mcpDeps(ctx: McpTestContext): { app: App } {
  return { app: ctx.app };
}

interface ToolCallResult {
  readonly isError?: boolean;
  readonly body: Record<string, unknown>;
  /** Present when the route refused the caller's credentials (JSON-RPC error). */
  readonly rpcError?: { code: number; message: string; data?: unknown };
}

async function callTool(
  ctx: McpTestContext,
  name: string,
  args: Record<string, unknown>,
  token: string = TOKEN,
): Promise<ToolCallResult> {
  const res = await handleMcpRequest(
    {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      headers: { authorization: `Bearer ${token}` },
    },
    mcpDeps(ctx),
  );
  expect(res.status).toBe(200);
  const envelope = res.body as {
    result?: { isError?: boolean; content: { text: string }[] };
    error?: { code: number; message: string; data?: unknown };
  };
  if (envelope.error !== undefined) {
    // Auth refusals surface as JSON-RPC errors, never tool results (U4).
    return {
      isError: true,
      body: (envelope.error.data ?? {}) as Record<string, unknown>,
      rpcError: envelope.error,
    };
  }
  const result = envelope.result as { isError?: boolean; content: { text: string }[] };
  return {
    isError: result.isError,
    body: JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}

async function createRunViaTool(
  ctx: McpTestContext,
  args: Record<string, unknown> = {},
): Promise<string> {
  const res = await callTool(ctx, 'software_factory_create_run', {
    prompt: MARKETPLACE_PROMPT,
    ...args,
  });
  expect(res.isError).toBe(false);
  return res.body.runId as string;
}

function record(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

/* ----------------------------------------------------------------------------
 * Tool listing and auth
 * ------------------------------------------------------------------------- */

describe('remote MCP bridge', () => {
  it('lists every Software Factory lifecycle tool without requiring auth', async () => {
    const ctx = makeMcp();
    const res = await handleMcpRequest(
      { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: {} },
      mcpDeps(ctx),
    );

    expect(res.status).toBe(200);
    const body = res.body as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((tool) => tool.name);
    for (const expected of EXPECTED_TOOLS) {
      expect(names, `missing tool ${expected}`).toContain(expected);
    }
    expect(names).toHaveLength(EXPECTED_TOOLS.length);
  });

  it('creates a planned run through tools/call with a bearer operator token', async () => {
    const ctx = makeMcp();
    const res = await callTool(ctx, 'software_factory_create_run', {
      prompt: MARKETPLACE_PROMPT,
      requestedWorkerCap: 10,
    });

    expect(res.isError).toBe(false);
    expect(res.body.runId).toBe('mcp-run-1');
    expect(record(res.body.run).status).toBe('planned');
    expect((await ctx.store.readRun('mcp-run-1')).map((event) => event.type)).toContain(
      'run.planned',
    );
  });

  it('rejects tools/call with an invalid token as a JSON-RPC auth error (route-layer verdict)', async () => {
    const ctx = makeMcp();
    const res = await callTool(ctx, 'software_factory_create_run', { prompt: 'x' }, 'wrong-token');

    expect(res.isError).toBe(true);
    // U4: the bridge verified nothing — the route's 401 surfaced as -32001.
    expect(res.rpcError?.code).toBe(-32001);
    expect(res.body.error).toBe('invalid_token');
    // The refusal is AUDITED on the candidate run's stream (security.block),
    // and no run was created.
    const events = await ctx.store.readRun('mcp-run-1');
    expect(events.map((event) => event.type)).toEqual(['security.block']);
  });

  it('single-tenant regression pin: legacy-token mutations succeed with NO bridge-injected CSRF', async () => {
    // The bridge used to attach the server's CSRF token; U3 made bearer
    // callers CSRF-exempt, so the pass-through bridge needs no CSRF at all.
    // makeMcp configures csrfToken on the app — this run would 403 if the
    // exemption regressed.
    const ctx = makeMcp();
    const res = await callTool(ctx, 'software_factory_create_run', { prompt: MARKETPLACE_PROMPT });
    expect(res.isError).toBe(false);
    expect(res.body.runId).toBe('mcp-run-1');
  });
});

/* ----------------------------------------------------------------------------
 * Research-enabled run creation (U10: projected research/planning state)
 * ------------------------------------------------------------------------- */

describe('MCP create-run with research enabled', () => {
  it('returns the projected research and planning state, not an event dump', async () => {
    const ctx = makeMcp({ researcher: stubResearcher() });
    const res = await callTool(ctx, 'software_factory_create_run', {
      prompt: MARKETPLACE_PROMPT,
      mode: 'research-and-plan',
    });

    expect(res.isError).toBe(false);
    const research = record(res.body.research);
    expect(research.status).toBe('completed');
    expect(research.briefSummary).toBe('Stub research brief.');

    const run = record(res.body.run);
    expect(run.status).toBe('planned');
    expect(run.mode).toBe('research-and-plan');
    // Build contract (X3) is generated after research + planning.
    expect(run.buildContract).toBeDefined();
    // Concise summary: the ledger is summarized to a count, never inlined.
    expect(run.ledger).toBeUndefined();
    expect(typeof run.ledgerEventCount).toBe('number');
  });
});

/* ----------------------------------------------------------------------------
 * Command guard and stale-version checks
 * ------------------------------------------------------------------------- */

describe('MCP lifecycle commands obey the command guard', () => {
  it('rejects a stale start command and enqueues nothing', async () => {
    const ctx = makeMcp();
    const runId = await createRunViaTool(ctx);

    const res = await callTool(ctx, 'software_factory_start_run', { runId, expectedVersion: 1 });
    expect(res.isError).toBe(true);
    expect(res.body.error).toBe('stale_subject_version');

    const seen = (await ctx.store.readRun(runId)).map((event) => event.type);
    expect(seen).toContain('security.command_rejected');
    expect(seen).not.toContain('queue.enqueued');
  });

  it('rejects a stale cancel command', async () => {
    const ctx = makeMcp();
    const runId = await createRunViaTool(ctx);
    const res = await callTool(ctx, 'software_factory_cancel_run', { runId, expectedVersion: 1 });
    expect(res.isError).toBe(true);
    expect(res.body.error).toBe('stale_subject_version');
  });

  it('rejects unauthorized pause before side effects, then pauses and resumes', async () => {
    const ctx = makeMcp();
    const runId = await createRunViaTool(ctx);
    const started = await callTool(ctx, 'software_factory_start_run', { runId });
    expect(started.isError).toBe(false);
    expect(started.body.queued).toBe(true);

    const denied = await callTool(ctx, 'software_factory_pause_run', { runId }, 'wrong-token');
    expect(denied.isError).toBe(true);
    expect(denied.rpcError?.code).toBe(-32001);
    // The refusal is audited (security.block) but has NO side effects.
    const afterDenial = (await ctx.store.readRun(runId)).map((event) => event.type);
    expect(afterDenial).toContain('security.block');
    expect(afterDenial).not.toContain('execution.paused');

    const paused = await callTool(ctx, 'software_factory_pause_run', { runId });
    expect(paused.isError).toBe(false);
    expect(record(paused.body.execution).state).toBe('paused');

    const resumed = await callTool(ctx, 'software_factory_resume_run', { runId });
    expect(resumed.isError).toBe(false);
    // `execution.resumed` folds to `started`: the daemon may claim again.
    expect(record(resumed.body.execution).state).toBe('started');
  });
});

/* ----------------------------------------------------------------------------
 * Idempotent repeats (U10: existing state, never duplicated work)
 * ------------------------------------------------------------------------- */

describe('MCP repeated commands return existing state', () => {
  it('repeated start returns the existing queue state without double-enqueueing', async () => {
    const ctx = makeMcp();
    const runId = await createRunViaTool(ctx);

    const first = await callTool(ctx, 'software_factory_start_run', { runId });
    expect(first.isError).toBe(false);
    expect(first.body.queued).toBe(true);

    const second = await callTool(ctx, 'software_factory_start_run', { runId });
    expect(second.isError).toBe(false);
    expect(second.body.alreadyQueued).toBe(true);

    const enqueued = (await ctx.store.readRun(runId)).filter(
      (event) => event.type === 'queue.enqueued',
    );
    expect(enqueued).toHaveLength(1);
  });

  it('repeated research trigger returns the existing projected research', async () => {
    const ctx = makeMcp({ researcher: stubResearcher() });
    const runId = await createRunViaTool(ctx);

    const first = await callTool(ctx, 'software_factory_trigger_research', { runId });
    expect(first.isError).toBe(false);
    expect(first.body.alreadyResearched).toBe(false);
    expect(record(first.body.research).status).toBe('completed');

    const second = await callTool(ctx, 'software_factory_trigger_research', { runId });
    expect(second.isError).toBe(false);
    expect(second.body.alreadyResearched).toBe(true);

    const requested = (await ctx.store.readRun(runId)).filter(
      (event) => event.type === 'research.requested',
    );
    expect(requested).toHaveLength(1);
  });

  it('repeated intervention resolve reports the already-resolved state', async () => {
    const ctx = makeMcp();
    // A repo-sourced run whose workspace was never materialized: preflight
    // fails and raises interventions instead of partial worker execution.
    const runId = await createRunViaTool(ctx, { githubRepo: 'octo/app' });
    const blocked = await callTool(ctx, 'software_factory_start_run', { runId });
    expect(blocked.isError).toBe(true);
    expect(blocked.body.error).toBe('preflight_failed');

    const list = await callTool(ctx, 'software_factory_list_interventions', { open: true });
    expect(list.isError).toBe(false);
    const interventions = list.body.interventions as { interventionId: string }[];
    expect(interventions.length).toBeGreaterThan(0);
    const target = interventions[0].interventionId;

    const resolved = await callTool(ctx, 'software_factory_resolve_intervention', {
      interventionId: target,
      resolution: 'approved',
    });
    expect(resolved.isError).toBe(false);
    expect(resolved.body.alreadyResolved).toBe(false);

    const again = await callTool(ctx, 'software_factory_resolve_intervention', {
      interventionId: target,
      resolution: 'approved',
    });
    expect(again.isError).toBe(false);
    expect(again.body.alreadyResolved).toBe(true);
  });
});

/* ----------------------------------------------------------------------------
 * Factory-wide drain gate + cancel-all (connector parity): the daemon boots
 * HELD by default, so a remote agent must be able to inspect and release the
 * gate — and cancel everything — through the SAME guarded routes as the UI.
 * ------------------------------------------------------------------------- */

describe('MCP factory-wide execution gate tools', () => {
  it('reads the execution overview (gate state + cross-run queue counts)', async () => {
    const ctx = makeMcp();
    const res = await callTool(ctx, 'software_factory_get_execution_overview', {});
    expect(res.isError).toBe(false);
    const execution = record(res.body.execution);
    expect(execution.enabled).toBe(true);
    expect(typeof execution.held).toBe('boolean');
    const queue = record(res.body.queue);
    expect(queue.queued).toBe(0);
    expect(queue.leased).toBe(0);
  });

  it('hold engages the drain gate and resume releases it; repeats converge', async () => {
    const ctx = makeMcp();
    const held = await callTool(ctx, 'software_factory_hold_execution', {});
    expect(held.isError).toBe(false);
    expect(held.body.held).toBe(true);

    const heldAgain = await callTool(ctx, 'software_factory_hold_execution', {});
    expect(heldAgain.isError).toBe(false);
    expect(heldAgain.body.alreadyHeld).toBe(true);

    const overview = await callTool(ctx, 'software_factory_get_execution_overview', {});
    expect(record(overview.body.execution).held).toBe(true);

    const resumed = await callTool(ctx, 'software_factory_resume_execution', {});
    expect(resumed.isError).toBe(false);
    expect(resumed.body.resumed).toBe(true);
    expect(resumed.body.held).toBe(false);

    const resumedAgain = await callTool(ctx, 'software_factory_resume_execution', {});
    expect(resumedAgain.isError).toBe(false);
    expect(resumedAgain.body.alreadyActive).toBe(true);
  });

  it('rejects an unauthorized hold before the gate is touched', async () => {
    const ctx = makeMcp();
    const denied = await callTool(ctx, 'software_factory_hold_execution', {}, 'wrong-token');
    expect(denied.isError).toBe(true);
    expect(denied.rpcError?.code).toBe(-32001);
    expect(denied.body.error).toBe('invalid_token');

    const overview = await callTool(ctx, 'software_factory_get_execution_overview', {});
    expect(record(overview.body.execution).held).toBe(false);
  });
});

describe('MCP cancel-all tool', () => {
  it('cancels every cancellable run and converges on repeat', async () => {
    const ctx = makeMcp();
    const first = await createRunViaTool(ctx);
    const second = await createRunViaTool(ctx);

    const res = await callTool(ctx, 'software_factory_cancel_all_runs', { reason: 'shutdown' });
    expect(res.isError).toBe(false);
    expect(res.body.cancelled).toEqual(expect.arrayContaining([first, second]));
    expect(res.body.cancelledCount).toBe(2);
    expect(res.body.alreadyCancelled).toEqual([]);
    expect(res.body.skippedTerminal).toEqual([]);

    // Repeat converges: nothing is re-cancelled, no duplicate run.cancelled.
    const again = await callTool(ctx, 'software_factory_cancel_all_runs', {});
    expect(again.isError).toBe(false);
    expect(again.body.cancelledCount).toBe(0);
    expect(again.body.alreadyCancelled).toEqual(expect.arrayContaining([first, second]));

    const cancelledEvents = (await ctx.store.readRun(first)).filter(
      (event) => event.type === 'run.cancelled',
    );
    expect(cancelledEvents).toHaveLength(1);
  });

  it('rejects an unauthorized cancel-all before any run is touched', async () => {
    const ctx = makeMcp();
    const runId = await createRunViaTool(ctx);
    const denied = await callTool(ctx, 'software_factory_cancel_all_runs', {}, 'wrong-token');
    expect(denied.isError).toBe(true);
    expect((await ctx.store.readRun(runId)).map((event) => event.type)).not.toContain(
      'run.cancelled',
    );
  });
});

describe('MCP clear-all tool', () => {
  it('cancels then permanently deletes every terminal run ledger', async () => {
    const ctx = makeMcp();
    const first = await createRunViaTool(ctx);
    const second = await createRunViaTool(ctx);

    const res = await callTool(ctx, 'software_factory_clear_all_runs', { reason: 'purge' });
    expect(res.isError).toBe(false);
    expect(res.body.cancelled).toEqual(expect.arrayContaining([first, second]));
    expect(res.body.cleared).toEqual(expect.arrayContaining([first, second]));
    expect(res.body.clearedCount).toBe(2);
    expect(res.body.skipped).toEqual([]);
    // The ledgers are gone, not just re-projected.
    expect(await ctx.store.readRun(first)).toEqual([]);
    expect(await ctx.store.readRun(second)).toEqual([]);

    // Repeat converges on the now-empty ledger.
    const again = await callTool(ctx, 'software_factory_clear_all_runs', {});
    expect(again.isError).toBe(false);
    expect(again.body.clearedCount).toBe(0);
  });

  it('rejects an unauthorized clear-all before any ledger is touched', async () => {
    const ctx = makeMcp();
    const runId = await createRunViaTool(ctx);
    const denied = await callTool(ctx, 'software_factory_clear_all_runs', {}, 'wrong-token');
    expect(denied.isError).toBe(true);
    expect((await ctx.store.readRun(runId)).length).toBeGreaterThan(0);
  });
});

/* ----------------------------------------------------------------------------
 * Review + workspace parity tools (connector parity): every lifecycle action in
 * the UI/CLI is reachable over MCP through the SAME guarded route.
 * ------------------------------------------------------------------------- */

describe('MCP review decide tool', () => {
  it('records a review decision through the guarded route (resumes nothing when idle)', async () => {
    const ctx = makeMcp();
    const runId = await createRunViaTool(ctx);

    const res = await callTool(ctx, 'software_factory_review_decide', {
      runId,
      decision: 'approved',
      rationale: 'looks good',
    });
    expect(res.isError).toBe(false);
    expect(res.body.runId).toBe(runId);
    expect(res.body.decision).toBe('approved');
    // A planned run with no pending stage review resumes nothing.
    expect(res.body.resumed).toBeNull();
    expect((await ctx.store.readRun(runId)).map((event) => event.type)).toContain('review.decided');
  });

  it('rejects a stale review decision and appends no review.decided', async () => {
    const ctx = makeMcp();
    const runId = await createRunViaTool(ctx);

    const res = await callTool(ctx, 'software_factory_review_decide', {
      runId,
      decision: 'approved',
      expectedVersion: 1,
    });
    expect(res.isError).toBe(true);
    expect(res.body.error).toBe('stale_subject_version');

    const seen = (await ctx.store.readRun(runId)).map((event) => event.type);
    expect(seen).toContain('security.command_rejected');
    expect(seen).not.toContain('review.decided');
  });

  it('dedups a concurrent double-submit at the same run version (idempotency guard)', async () => {
    const ctx = makeMcp();
    const runId = await createRunViaTool(ctx);
    // Pin the SAME expectedVersion on both calls: a genuine retry/replay of the
    // identical guarded request. The idempotency key (decision + anchor version)
    // collapses the second append instead of recording a duplicate decision.
    const run = record((await callTool(ctx, 'software_factory_get_run', { runId })).body.run);
    const expectedVersion = run.lastSequence as number;

    const first = await callTool(ctx, 'software_factory_review_decide', {
      runId,
      decision: 'approved',
      expectedVersion,
    });
    expect(first.isError).toBe(false);
    // The replayed request carries the ORIGINAL (now-stale) version. The guard
    // rejects it as stale — but even absent the guard, the idempotency key would
    // dedup it; either way NO second review.decided is recorded.
    const second = await callTool(ctx, 'software_factory_review_decide', {
      runId,
      decision: 'approved',
      expectedVersion,
    });
    expect(second.body.error).toBe('stale_subject_version');

    const decided = (await ctx.store.readRun(runId)).filter(
      (event) => event.type === 'review.decided',
    );
    expect(decided).toHaveLength(1);
  });
});

describe('MCP workspace tools', () => {
  it('materializes a github-repo workspace and reads it back', async () => {
    const ctx = makeMcp({ materializer: stubMaterializer() });
    const runId = await createRunViaTool(ctx, { githubRepo: 'octo/app' });

    const materialized = await callTool(ctx, 'software_factory_materialize_workspace', { runId });
    expect(materialized.isError).toBe(false);
    expect(record(materialized.body.workspace).status).toBe('ready');

    const status = await callTool(ctx, 'software_factory_get_workspace', { runId });
    expect(status.isError).toBe(false);
    expect(record(status.body.workspace).status).toBe('ready');

    expect((await ctx.store.readRun(runId)).map((event) => event.type)).toContain(
      'workspace.checkout_completed',
    );
  });

  it('rejects a stale materialize command and appends no workspace events', async () => {
    const ctx = makeMcp({ materializer: stubMaterializer() });
    const runId = await createRunViaTool(ctx, { githubRepo: 'octo/app' });

    const res = await callTool(ctx, 'software_factory_materialize_workspace', {
      runId,
      expectedVersion: 1,
    });
    expect(res.isError).toBe(true);
    expect(res.body.error).toBe('stale_subject_version');

    const seen = (await ctx.store.readRun(runId)).map((event) => event.type);
    expect(seen).toContain('security.command_rejected');
    expect(seen.some((type) => type.startsWith('workspace.'))).toBe(false);
  });

  it('returns 503 when workspace materialization is disabled on the instance', async () => {
    const ctx = makeMcp();
    const runId = await createRunViaTool(ctx, { githubRepo: 'octo/app' });
    const res = await callTool(ctx, 'software_factory_materialize_workspace', { runId });
    expect(res.isError).toBe(true);
    expect(res.body.error).toBe('workspace_disabled');
  });
});

/* ----------------------------------------------------------------------------
 * Contract, preflight, outputs, and concise summaries (U10)
 * ------------------------------------------------------------------------- */

describe('MCP contract/preflight/outputs reads', () => {
  it('get_contract returns the build contract for research-enabled runs', async () => {
    const ctx = makeMcp({ researcher: stubResearcher() });
    const runId = await createRunViaTool(ctx, { mode: 'research-and-plan' });

    const res = await callTool(ctx, 'software_factory_get_contract', { runId });
    expect(res.isError).toBe(false);
    expect(res.body.runId).toBe(runId);
    expect(res.body.contract).not.toBeNull();
    expect(typeof record(res.body.contract).digest === 'string' || res.body.contract !== null).toBe(
      true,
    );
  });

  it('get_contract is explicit when no contract exists (plan-only run)', async () => {
    const ctx = makeMcp();
    const runId = await createRunViaTool(ctx);
    const res = await callTool(ctx, 'software_factory_get_contract', { runId });
    expect(res.isError).toBe(false);
    expect(res.body.contract).toBeNull();
    expect(String(res.body.message)).toMatch(/no build contract/i);
  });

  it('get_preflight returns the latest rehearsal outcome with its interventions', async () => {
    const ctx = makeMcp();
    const runId = await createRunViaTool(ctx, { githubRepo: 'octo/app' });
    await callTool(ctx, 'software_factory_start_run', { runId });

    const res = await callTool(ctx, 'software_factory_get_preflight', { runId });
    expect(res.isError).toBe(false);
    const preflight = record(res.body.preflight);
    expect(preflight.status).toBe('failed');
    expect(preflight.failedChecks).toContain('workspace');
    const interventions = res.body.interventions as { blockingStage: string }[];
    expect(interventions.length).toBeGreaterThan(0);
    expect(interventions.every((entry) => entry.blockingStage === 'preflight')).toBe(true);
  });

  it('get_outputs returns the run artifact contract with a strict hosted URL', async () => {
    const ctx = makeMcp({
      runtime: testRuntimeConfig({ publicBaseUrl: 'https://factory.example.test' }),
    });
    const runId = await createRunViaTool(ctx);

    const res = await callTool(ctx, 'software_factory_get_outputs', { runId });
    expect(res.isError).toBe(false);
    const outputs = record(res.body.outputs);
    expect(outputs.status).toBe('planned');
    expect((outputs.tickets as unknown[]).length).toBeGreaterThan(0);
    // No deploy ran: deploy state is honest and the hosted URL is ABSENT.
    expect(record(outputs.deploy)).toEqual({ status: 'idle', retryable: false });
    expect(outputs.hostedUrl).toBeUndefined();
    expect(outputs.eventsUrl).toBe(`https://factory.example.test/api/runs/${runId}/events`);
  });

  it('returns concise run summaries plus links instead of full event dumps', async () => {
    const ctx = makeMcp();
    const runId = await createRunViaTool(ctx);

    const res = await callTool(ctx, 'software_factory_get_run', { runId });
    expect(res.isError).toBe(false);
    const run = record(res.body.run);
    expect(run.ledger).toBeUndefined();
    expect(run.ledgerEventCount as number).toBeGreaterThan(0);
    const links = record(res.body.links);
    expect(links.events).toBe(`/api/runs/${runId}/events`);
    expect(links.outputs).toBe(`/api/runs/${runId}/outputs`);
    expect(links.execution).toBe(`/api/runs/${runId}/execution`);

    // The detail read is still available on demand.
    const events = await callTool(ctx, 'software_factory_get_events', { runId });
    expect(events.isError).toBe(false);
    expect((events.body.events as unknown[]).length).toBeGreaterThan(0);
  });
});

/* ----------------------------------------------------------------------------
 * Setup diagnostics (U10 + E5): separated surfaces, no secret values
 * ------------------------------------------------------------------------- */

describe('MCP setup diagnostics', () => {
  it('surfaces missing cloud credentials as separated setup-required surfaces', async () => {
    const ctx = makeMcp({ runtime: testRuntimeConfig({ mode: 'cloud' }) });
    const res = await callTool(ctx, 'software_factory_get_setup', {});
    expect(res.isError).toBe(false);

    // Source checkout credentials (surface 1).
    const materialization = record(record(res.body.workspace).materialization);
    expect(record(materialization.checkoutCredentials)).toEqual({ present: false });
    // Deploy credentials (surface 2).
    const deploy = record(res.body.deploy);
    expect(deploy.status).toBe('required');
    expect(String(deploy.missing)).toMatch(/Render API key/);
    // Research provider credentials (surface 3).
    const research = record(res.body.research);
    expect(record(research.searchCredentials)).toEqual({ present: false });
    // Persistent storage: cloud without an explicit SF_FACTORY_DIR is flagged.
    const storage = record(res.body.storage);
    expect(storage.status).toBe('attention');
    expect(String(storage.missing)).toMatch(/SF_FACTORY_DIR/);
    // Cloud source rules stay explicit (KTD5).
    expect(record(materialization.localFolders).status).toBe('unavailable');
  });

  it('reports credential presence only — secret values never appear (E5)', async () => {
    const checkoutSecret = 'ghp_McpSecretCheckout111';
    const researchSecret = 'sk_McpSecretResearch222';
    const deploySecret = 'rnd_McpSecretDeploy333';
    const runtime = resolveRuntimeConfig(
      {
        SF_RUNTIME: 'cloud',
        SF_FACTORY_DIR: '/var/data/.factory',
        SF_GIT_CHECKOUT_TOKEN: checkoutSecret,
        SF_RESEARCH_SEARCH_API_KEY: researchSecret,
        SF_RENDER_API_KEY: deploySecret,
        SF_RESEARCH_SEARCH_PROVIDER: 'tavily',
      },
      'C:\\repo',
    );
    const ctx = makeMcp({ runtime });
    const res = await callTool(ctx, 'software_factory_get_setup', {});
    expect(res.isError).toBe(false);

    const materialization = record(record(res.body.workspace).materialization);
    expect(record(materialization.checkoutCredentials)).toEqual({ present: true });
    const research = record(res.body.research);
    expect(record(research.searchCredentials)).toEqual({ present: true });
    expect(research.provider).toBe('tavily');
    // Persistent storage is ready when SF_FACTORY_DIR is explicit.
    expect(record(res.body.storage).status).toBe('ready');

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(checkoutSecret);
    expect(raw).not.toContain(researchSecret);
    expect(raw).not.toContain(deploySecret);
  });
});

/* ----------------------------------------------------------------------------
 * Multi-user pass-through (U4): personal sfai_ tokens act as their user; the
 * bridge injects nothing and the route layer is the single verifier.
 * ------------------------------------------------------------------------- */

describe('MCP multi-user pass-through (U4)', () => {
  const BOOTSTRAP = 'bootstrap-invite-0123456789abcdef';
  const PASSWORD = 'correct-horse-battery';

  async function makeMultiUserMcp(): Promise<{
    ctx: McpTestContext;
    tokenA: string;
    tokenB: string;
    userAId: string;
    userBId: string;
    revoke: (userId: string) => Promise<void>;
  }> {
    const store = createInMemoryEventStore();
    const provider = createOperatorTokenProvider({
      store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
    });
    const service = createAuthService({
      stores: createInMemoryAuthStores(),
      bootstrapInvite: BOOTSTRAP,
    });
    let runSeq = 0;
    const app = createApp({
      store,
      operatorToken: provider,
      idGenerator: () => `mu-run-${(runSeq += 1)}`,
      config: { allowedOrigins: [], csrfToken: CSRF },
      planner: null,
      auth: { service },
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
    const inviteA = await service.issueInvite(admin.session.identity.userId);
    const userA = await service.redeemInvite({
      token: inviteA.token,
      username: 'user-a',
      password: PASSWORD,
      ip: 'test',
    });
    const inviteB = await service.issueInvite(admin.session.identity.userId);
    const userB = await service.redeemInvite({
      token: inviteB.token,
      username: 'user-b',
      password: PASSWORD,
      ip: 'test',
    });
    if (!userA.ok || !userB.ok) {
      throw new Error('invite redemption failed');
    }
    const tokenA = (await service.mintApiToken(userA.session.identity.userId))?.token ?? '';
    const tokenB = (await service.mintApiToken(userB.session.identity.userId))?.token ?? '';
    return {
      ctx: { app, store },
      tokenA,
      tokenB,
      userAId: userA.session.identity.userId,
      userBId: userB.session.identity.userId,
      revoke: async (userId) => {
        await service.revokeUser(userId);
      },
    };
  }

  it("B's token creates a run OWNED by B; B's tools cannot see A's runs", { timeout: 30_000 }, async () => {
    const { ctx, tokenA, tokenB, userAId, userBId } = await makeMultiUserMcp();

    const aRun = await callTool(ctx, 'software_factory_create_run', { prompt: 'A app' }, tokenA);
    expect(aRun.isError).toBe(false);
    const bRun = await callTool(ctx, 'software_factory_create_run', { prompt: 'B app' }, tokenB);
    expect(bRun.isError).toBe(false);

    const created = (await ctx.store.readRun(bRun.body.runId as string)).find(
      (event) => event.type === 'run.created',
    );
    expect((created?.payload as { ownerId?: string }).ownerId).toBe(userBId);
    expect(created?.actor.id).toBe(userBId);

    // B's list excludes A's run; B's detail read of A's run is a 404 body.
    const list = await callTool(ctx, 'software_factory_list_runs', {}, tokenB);
    expect(list.isError).toBe(false);
    const ids = (list.body.runs as { runId: string }[]).map((run) => run.runId);
    expect(ids).toEqual([bRun.body.runId]);

    const foreign = await callTool(
      ctx,
      'software_factory_get_run',
      { runId: aRun.body.runId },
      tokenB,
    );
    expect(foreign.isError).toBe(true);
    expect(foreign.body.error).toBe('not_found');
    expect(userAId).not.toBe(userBId);
  });

  it('a REVOKED token fails with a JSON-RPC auth error from the route layer', { timeout: 30_000 }, async () => {
    const { ctx, tokenB, userBId, revoke } = await makeMultiUserMcp();

    const before = await callTool(ctx, 'software_factory_list_runs', {}, tokenB);
    expect(before.isError).toBe(false);

    await revoke(userBId);

    const after = await callTool(ctx, 'software_factory_list_runs', {}, tokenB);
    expect(after.isError).toBe(true);
    expect(after.rpcError?.code).toBe(-32001);
    expect(after.body.error).toBe('unauthenticated');
  });

  it('the legacy operator token on a multi-user factory fails with the migration message', { timeout: 30_000 }, async () => {
    const { ctx } = await makeMultiUserMcp();
    const res = await callTool(ctx, 'software_factory_list_runs', {}, TOKEN);
    expect(res.isError).toBe(true);
    expect(res.rpcError?.code).toBe(-32001);
    expect(res.body.error).toBe('multi_user_enabled');
    expect(res.rpcError?.message).toContain('personal API token');
  });
});
