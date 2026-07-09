/**
 * run-packaging (U8) — idempotent completed-run packaging.
 *
 * Uses a REAL temp dir + a FAKE git runner (no real git). Asserts:
 *  - a completed run packages the workspace and emits `package.created`,
 *    `artifact.created`, and `artifact.confidence_computed` tied to the ledger,
 *  - the `package.created` payload carries the artifact id, commit, and
 *    provenance reference the CLI/UI surface,
 *  - packaging is IDEMPOTENT: a second call (replay/restart/deploy-retry)
 *    short-circuits on the existing `package.created` — zero git calls, no
 *    duplicate events, and
 *  - a git failure propagates as an observable error with no fake
 *    `package.created`.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryEventStore, projectRun, projectTickets } from '@software-factory/core';
import type { AppendableEvent, EventStore, FactoryEvent } from '@software-factory/core';
import { packageCompletedRun } from '../../src/index';
import { createFakeRunner } from '../_helpers/fake-runner';

const RUN_ID = 'run-pack';
const COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';

function deterministic(): { idGenerator: () => string; clock: () => number } {
  let id = 0;
  let now = 1_700_000_000_000;
  return { idGenerator: () => `evt-${(id += 1)}`, clock: () => (now += 1000) };
}

function gitRunner() {
  return createFakeRunner({
    responses: { 'git rev-parse': { code: 0, stdout: `${COMMIT}\n`, stderr: '' } },
    fallback: { code: 0, stdout: '', stderr: '' },
  });
}

async function append(
  store: EventStore,
  partial: Partial<AppendableEvent> & Pick<AppendableEvent, 'type' | 'payload'>,
): Promise<void> {
  await store.append({
    runId: RUN_ID,
    actor: { kind: 'system', id: 'test' },
    subject: { kind: 'run', id: RUN_ID },
    severity: 'info',
    ...partial,
  } as AppendableEvent);
}

async function seedCompletedRun(store: EventStore): Promise<void> {
  await append(store, {
    type: 'run.created',
    payload: { prompt: 'Build an AI services marketplace', title: 'Marketplace' },
  });
  await append(store, {
    type: 'ticket.created',
    ticketId: 'scaffold',
    subject: { kind: 'ticket', id: 'scaffold' },
    payload: { title: 'Scaffold', riskTier: 'low' },
  });
  await append(store, {
    type: 'gate.passed',
    payload: { gate: 'unit-test', summary: 'green', stage: 'post_run' },
  });
  await append(store, { type: 'preview.ready', payload: { url: 'http://127.0.0.1:4311' } });
}

async function runPackaging(store: EventStore, dir: string, runner = gitRunner()) {
  const events: FactoryEvent[] = await store.readRun(RUN_ID);
  const result = await packageCompletedRun(
    {
      runId: RUN_ID,
      workspaceDir: dir,
      run: projectRun(events, RUN_ID),
      tickets: projectTickets(events, RUN_ID),
      events,
    },
    { store, runner, listFiles: () => Promise.resolve(['package.json', 'app/page.tsx']) },
  );
  return { result, runner };
}

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sf-run-pack-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('packageCompletedRun', () => {
  it('packages a completed run: provenance + handoff on disk, package/artifact/confidence events', async () => {
    const store = createInMemoryEventStore(deterministic());
    await seedCompletedRun(store);

    const { result } = await runPackaging(store, dir);
    expect(result.alreadyPackaged).toBe(false);
    expect(result.artifactId).toBe('app');
    expect(result.descriptor.commit).toBe(COMMIT);
    expect(result.provenance?.bundle.generatedFiles.map((f) => f.path)).toEqual([
      'package.json',
      'app/page.tsx',
    ]);

    // Files exist on disk (real temp dir writes).
    const provenanceJson = JSON.parse(await readFile(join(dir, 'PROVENANCE.json'), 'utf8'));
    expect(provenanceJson.runId).toBe(RUN_ID);
    const handoff = await readFile(join(dir, 'HANDOFF.md'), 'utf8');
    expect(handoff).toContain('Handoff: Marketplace');
    expect(handoff).toContain('PROVENANCE.json');

    // Events: package.created carries artifactId/commit/provenanceRef; the
    // repo artifact + its confidence are recorded and tied to the run.
    const events = await store.readRun(RUN_ID);
    const pkg = events.find((e) => e.type === 'package.created');
    expect(pkg?.payload).toMatchObject({
      repoPath: dir,
      handoffRef: 'HANDOFF.md',
      artifactId: 'app',
      commit: COMMIT,
      provenanceRef: 'PROVENANCE.json',
    });
    const artifact = events.find((e) => e.type === 'artifact.created');
    expect(artifact?.payload).toMatchObject({ artifactId: 'app', kind: 'repo', path: dir });
    const confidence = events.find((e) => e.type === 'artifact.confidence_computed');
    expect(confidence?.payload).toMatchObject({ artifactId: 'app' });
    expect((confidence?.payload as { confidence: number }).confidence).toBeGreaterThan(0);
  });

  it('is idempotent: a second call skips packaging with ZERO git calls and no duplicate events', async () => {
    const store = createInMemoryEventStore(deterministic());
    await seedCompletedRun(store);
    await runPackaging(store, dir);

    const secondRunner = gitRunner();
    const events = await store.readRun(RUN_ID);
    const second = await packageCompletedRun(
      {
        runId: RUN_ID,
        workspaceDir: dir,
        run: projectRun(events, RUN_ID),
        tickets: projectTickets(events, RUN_ID),
        events,
      },
      { store, runner: secondRunner, listFiles: () => Promise.resolve([]) },
    );

    expect(second.alreadyPackaged).toBe(true);
    expect(second.descriptor.path).toBe(dir);
    expect(second.descriptor.commit).toBe(COMMIT);
    expect(secondRunner.calls.length).toBe(0); // no git re-run

    const after = await store.readRun(RUN_ID);
    expect(after.filter((e) => e.type === 'package.created').length).toBe(1);
    expect(after.filter((e) => e.type === 'artifact.created').length).toBe(1);
    expect(after.filter((e) => e.type === 'artifact.confidence_computed').length).toBe(1);
  });

  it('propagates git failures observably without a fake package.created', async () => {
    const store = createInMemoryEventStore(deterministic());
    await seedCompletedRun(store);
    const failingRunner = createFakeRunner({
      responses: { 'git init': { code: 128, stdout: '', stderr: 'fatal: cannot init' } },
      fallback: { code: 0, stdout: '', stderr: '' },
    });
    // Ensure the workspace exists (the packager writes metadata files first).
    await writeFile(join(dir, 'app.ts'), 'export {};\n', 'utf8');

    const events = await store.readRun(RUN_ID);
    await expect(
      packageCompletedRun(
        {
          runId: RUN_ID,
          workspaceDir: dir,
          run: projectRun(events, RUN_ID),
          tickets: projectTickets(events, RUN_ID),
          events,
        },
        { store, runner: failingRunner, listFiles: () => Promise.resolve([]) },
      ),
    ).rejects.toThrow(/cannot init/);

    expect((await store.readRun(RUN_ID)).some((e) => e.type === 'package.created')).toBe(false);
  });
});
