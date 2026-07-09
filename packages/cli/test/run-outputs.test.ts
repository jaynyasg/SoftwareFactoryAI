/**
 * run-outputs + artifacts command (U8) — the CLI artifact contract over
 * package/provenance/gate/deploy events.
 *
 * Asserts: package paths + handoff + provenance references surface from
 * `package.created`, gate evidence folds into the tests summary, the deploy
 * state is projected with retryability, the hosted URL is ABSENT until
 * `deploy.hosted_ready` (R29), and a paused deploy leaves the local artifacts
 * visible (R30). Events are built inline (no network, no server).
 */
import { describe, expect, it } from 'vitest';
import type { FactoryEvent } from '@software-factory/core';
import { buildRunOutputs } from '../src/run-outputs';
import { artifactsCommand } from '../src/commands/artifacts';
import type { CliIo } from '../src/cli-io';

const RUN_ID = 'run-outputs-u8';
const EVENTS_URL = `http://127.0.0.1:3000/api/runs/${RUN_ID}/events`;

interface EventSpec {
  readonly type: FactoryEvent['type'];
  readonly payload: Record<string, unknown>;
  readonly severity?: FactoryEvent['severity'];
  readonly ticketId?: string;
}

function buildEvents(specs: readonly EventSpec[]): FactoryEvent[] {
  return specs.map(
    (spec, index) =>
      ({
        version: 1,
        eventId: `evt-${index + 1}`,
        runId: RUN_ID,
        ticketId: spec.ticketId,
        actor: { kind: 'system', id: 'test' },
        subject: { kind: 'run', id: RUN_ID, version: index },
        type: spec.type,
        sequence: index + 1,
        timestamp: 1_700_000_000_000 + index * 1000,
        severity: spec.severity ?? 'info',
        payload: spec.payload,
      }) as FactoryEvent,
  );
}

const BASE: readonly EventSpec[] = [
  { type: 'run.created', payload: { prompt: 'Build an AI services marketplace' } },
  { type: 'ticket.created', ticketId: 'scaffold', payload: { title: 'Scaffold' } },
  {
    type: 'gate.passed',
    payload: { gate: 'unit-test', summary: 'green', stage: 'post_run' },
    severity: 'success',
  },
  { type: 'preview.ready', payload: { url: 'http://127.0.0.1:4311' }, severity: 'success' },
  {
    type: 'package.created',
    severity: 'success',
    payload: {
      repoPath: 'C:/factory/workspaces/run-outputs-u8',
      handoffRef: 'HANDOFF.md',
      provenanceRef: 'PROVENANCE.json',
      artifactId: 'app',
      commit: 'abc123',
      summary: 'Packaged app as a git repo at commit abc123.',
    },
  },
  {
    type: 'artifact.created',
    payload: { artifactId: 'app', kind: 'repo', path: 'C:/factory/workspaces/run-outputs-u8' },
  },
  {
    type: 'artifact.confidence_computed',
    payload: { artifactId: 'app', confidence: 0.87, factors: { gatePassRate: 1 } },
  },
];

describe('buildRunOutputs (U8 package/provenance/deploy)', () => {
  it('surfaces package, handoff, provenance, gates, and confidence from the ledger', () => {
    const outputs = buildRunOutputs(RUN_ID, buildEvents(BASE), EVENTS_URL);

    expect(outputs.repoPath).toBe('C:/factory/workspaces/run-outputs-u8');
    expect(outputs.handoffRef).toBe('HANDOFF.md');
    expect(outputs.provenanceRef).toBe('PROVENANCE.json');
    expect(outputs.handoffSummary).toContain('Packaged app');
    expect(outputs.previewUrl).toBe('http://127.0.0.1:4311');
    expect(outputs.tests.passed).toBe(1);
    expect(outputs.tests.gates[0]).toEqual({
      gate: 'unit-test',
      status: 'passed',
      detail: 'green',
    });
    expect(outputs.artifacts[0]).toMatchObject({
      artifactId: 'app',
      kind: 'repo',
      confidence: 0.87,
    });
  });

  it('keeps the hosted URL ABSENT until deploy.hosted_ready and marks failures retryable', () => {
    const paused = buildRunOutputs(
      RUN_ID,
      buildEvents([
        ...BASE,
        {
          type: 'deploy.setup_required',
          severity: 'warn',
          payload: { action: 'Configure Render (RENDER_API_KEY, service).' },
        },
      ]),
      EVENTS_URL,
    );
    expect(paused.hostedUrl).toBeUndefined();
    expect(paused.deploy).toEqual({
      status: 'setup_required',
      action: 'Configure Render (RENDER_API_KEY, service).',
      retryable: true,
    });
    // Local artifacts stay visible while the deploy is paused (R30).
    expect(paused.repoPath).toBeDefined();
    expect(paused.provenanceRef).toBeDefined();

    const healthFailed = buildRunOutputs(
      RUN_ID,
      buildEvents([
        ...BASE,
        { type: 'deploy.health_pending', payload: {} },
        {
          type: 'deploy.health_failed',
          severity: 'error',
          payload: { reason: 'health never passed' },
        },
      ]),
      EVENTS_URL,
    );
    expect(healthFailed.hostedUrl).toBeUndefined();
    expect(healthFailed.deploy.status).toBe('health_failed');
    expect(healthFailed.deploy.retryable).toBe(true);

    const hosted = buildRunOutputs(
      RUN_ID,
      buildEvents([
        ...BASE,
        { type: 'deploy.health_pending', payload: {} },
        {
          type: 'deploy.hosted_ready',
          severity: 'success',
          payload: { url: 'https://app.onrender.com' },
        },
      ]),
      EVENTS_URL,
    );
    expect(hosted.hostedUrl).toBe('https://app.onrender.com');
    expect(hosted.deploy).toEqual({
      status: 'hosted_ready',
      url: 'https://app.onrender.com',
      retryable: false,
    });
  });

  it('reports an idle deploy for planning-only V1 ledgers (replay compatible)', () => {
    const outputs = buildRunOutputs(
      RUN_ID,
      buildEvents([
        { type: 'run.created', payload: { prompt: 'Build an AI services marketplace' } },
        { type: 'run.planned', payload: { ticketCount: 12 } },
      ]),
      EVENTS_URL,
    );
    expect(outputs.deploy).toEqual({ status: 'idle', retryable: false });
    expect(outputs.hostedUrl).toBeUndefined();
    expect(outputs.repoPath).toBeUndefined();
    expect(outputs.provenanceRef).toBeUndefined();
  });
});

describe('artifacts command (U8 surface)', () => {
  function fakeIo(): { io: CliIo; lines: () => readonly string[] } {
    const out: string[] = [];
    return {
      lines: () => out,
      io: {
        out: (line) => {
          out.push(line);
        },
        err: () => undefined,
      },
    };
  }

  it('includes package, provenance, gates, deploy state — and hosted url only when present', async () => {
    const { io, lines } = fakeIo();
    const events = buildEvents([
      ...BASE,
      {
        type: 'deploy.setup_required',
        severity: 'warn',
        payload: { action: 'Connect a GitHub destination before deploy.' },
      },
    ]);
    const result = await artifactsCommand(
      { runId: RUN_ID },
      {
        io,
        client: {
          getEvents: () => Promise.resolve({ events }),
          eventsUrl: () => EVENTS_URL,
        } as never,
      },
    );

    expect(result.provenanceRef).toBe('PROVENANCE.json');
    expect(result.deploy.status).toBe('setup_required');
    expect(result.gates.length).toBe(1);
    expect(result.hostedUrl).toBeUndefined();

    const text = lines().join('\n');
    expect(text).toContain('provenance:  PROVENANCE.json');
    expect(text).toContain('deploy:      setup_required (retryable)');
    expect(text).toContain('hosted url:  (pending)');
    expect(text).toContain('1/1 gate checks passed');
  });

  it('shows the hosted url after hosted_ready in --json output', async () => {
    const { io, lines } = fakeIo();
    const events = buildEvents([
      ...BASE,
      {
        type: 'deploy.hosted_ready',
        severity: 'success',
        payload: { url: 'https://app.onrender.com' },
      },
    ]);
    const result = await artifactsCommand(
      { runId: RUN_ID, json: true },
      {
        io,
        client: {
          getEvents: () => Promise.resolve({ events }),
          eventsUrl: () => EVENTS_URL,
        } as never,
      },
    );

    expect(result.hostedUrl).toBe('https://app.onrender.com');
    const parsed = JSON.parse(lines().join('\n')) as Record<string, unknown>;
    expect(parsed.hostedUrl).toBe('https://app.onrender.com');
    expect((parsed.deploy as Record<string, unknown>).status).toBe('hosted_ready');
  });
});
