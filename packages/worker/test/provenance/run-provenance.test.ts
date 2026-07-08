/**
 * run-provenance (U8) — provenance bundle + confidence derived from replayed
 * run state only.
 *
 * Asserts: gate evidence/adapters/preview/reduced-trust come from ledger
 * events (never invented), the gate tally counts the LATEST outcome per gate
 * (a repaired gate counts once, as passed), confidence drops for missing
 * tests / failed preview / sandbox fallback, and identical inputs derive an
 * identical bundle (replay determinism).
 */
import { describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  projectRun,
  projectTickets,
} from '@software-factory/core';
import type { AppendableEvent, EventStore, FactoryEvent } from '@software-factory/core';
import { deriveRunProvenance } from '../../src/index';

const RUN_ID = 'run-prov';

function deterministic(): { idGenerator: () => string; clock: () => number } {
  let id = 0;
  let now = 1_700_000_000_000;
  return { idGenerator: () => `evt-${(id += 1)}`, clock: () => (now += 1000) };
}

async function append(store: EventStore, partial: Partial<AppendableEvent> & Pick<AppendableEvent, 'type' | 'payload'>): Promise<void> {
  await store.append({
    runId: RUN_ID,
    actor: { kind: 'system', id: 'test' },
    subject: { kind: 'run', id: RUN_ID },
    severity: 'info',
    ...partial,
  } as AppendableEvent);
}

async function seedBaseRun(store: EventStore): Promise<void> {
  await append(store, {
    type: 'run.created',
    payload: { prompt: 'Build an AI services marketplace', title: 'Marketplace' },
  });
  await append(store, {
    type: 'ticket.created',
    ticketId: 'scaffold',
    subject: { kind: 'ticket', id: 'scaffold' },
    payload: { title: 'Scaffold the app', riskTier: 'low' },
  });
  await append(store, {
    type: 'ticket.created',
    ticketId: 'tests',
    subject: { kind: 'ticket', id: 'tests' },
    payload: { title: 'Quality gates', dependsOn: ['scaffold'], riskTier: 'medium' },
  });
  await append(store, { type: 'adapter.selected', payload: { adapterId: 'codex-cli', family: 'codex' } });
}

async function derive(store: EventStore, generatedFiles: readonly string[] = ['package.json', 'app/page.tsx']) {
  const events: FactoryEvent[] = await store.readRun(RUN_ID);
  return deriveRunProvenance({
    runId: RUN_ID,
    artifactId: 'app',
    events,
    run: projectRun(events, RUN_ID),
    tickets: projectTickets(events, RUN_ID),
    generatedFiles,
  });
}

describe('deriveRunProvenance', () => {
  it('derives every section from ledger evidence and embeds the confidence', async () => {
    const store = createInMemoryEventStore(deterministic());
    await seedBaseRun(store);
    await append(store, { type: 'gate.passed', payload: { gate: 'lint', summary: 'clean', stage: 'post_run' } });
    await append(store, { type: 'gate.passed', payload: { gate: 'unit-test', summary: 'green', stage: 'post_run' } });
    await append(store, { type: 'preview.ready', payload: { url: 'http://127.0.0.1:4311' } });

    const { bundle, confidence } = await derive(store);

    expect(bundle.runId).toBe(RUN_ID);
    expect(bundle.source.prompt).toContain('marketplace');
    expect(bundle.ticketPlan.map((t) => t.id)).toEqual(['scaffold', 'tests']);
    expect(bundle.adapters).toEqual([{ adapterId: 'codex-cli', family: 'codex' }]);
    expect(bundle.gateEvidence.map((g) => g.gate)).toEqual(['lint', 'unit-test']);
    expect(bundle.generatedFiles.map((f) => f.path)).toEqual(['package.json', 'app/page.tsx']);
    expect(bundle.preview).toEqual({ status: 'ready', url: 'http://127.0.0.1:4311' });
    expect(bundle.reducedTrust).toBe(false);
    expect(bundle.confidence.confidence).toBe(confidence.confidence);
    // Tests ran, both gates passed, preview healthy: confidence is strong.
    expect(confidence.factors.gatePassRate).toBe(1);
    expect(confidence.factors.previewEvidence).toBe(1);
    expect(confidence.factors.sandboxTrust).toBe(1);
  });

  it('counts the LATEST outcome per gate so a repaired gate is not double-counted', async () => {
    const store = createInMemoryEventStore(deterministic());
    await seedBaseRun(store);
    await append(store, { type: 'gate.failed', payload: { gate: 'unit-test', reason: 'red', stage: 'post_ticket' } });
    await append(store, { type: 'gate.passed', payload: { gate: 'unit-test', summary: 'green after repair', stage: 'post_ticket' } });

    const { confidence } = await derive(store);
    expect(confidence.factors.gatePassRate).toBe(1); // 1/1 latest-pass
  });

  it('drops confidence for missing tests, failed preview, and sandbox fallback', async () => {
    const strong = createInMemoryEventStore(deterministic());
    await seedBaseRun(strong);
    await append(strong, { type: 'gate.passed', payload: { gate: 'unit-test', summary: 'green' } });
    await append(strong, { type: 'preview.ready', payload: { url: 'http://127.0.0.1:4311' } });
    const strongResult = await derive(strong);

    const weak = createInMemoryEventStore(deterministic());
    await seedBaseRun(weak);
    // Only a lint gate (no tests), a failed preview, and a sandbox fallback.
    await append(weak, { type: 'gate.passed', payload: { gate: 'lint', summary: 'clean' } });
    await append(weak, { type: 'preview.failed', payload: { reason: 'crashed on boot' } });
    await append(weak, { type: 'sandbox.fallback', severity: 'warn', payload: { reason: 'docker unavailable', reducedTrust: true } });
    const weakResult = await derive(weak);

    expect(weakResult.confidence.confidence).toBeLessThan(strongResult.confidence.confidence);
    expect(weakResult.bundle.reducedTrust).toBe(true);
    expect(weakResult.confidence.factors.sandboxTrust).toBeLessThan(1);
    expect(weakResult.confidence.factors.previewEvidence).toBeLessThan(1);
  });

  it('is deterministic: identical inputs derive an identical bundle', async () => {
    const store = createInMemoryEventStore(deterministic());
    await seedBaseRun(store);
    await append(store, { type: 'gate.passed', payload: { gate: 'unit-test', summary: 'green' } });

    const events = await store.readRun(RUN_ID);
    const input = {
      runId: RUN_ID,
      artifactId: 'app',
      events,
      run: projectRun(events, RUN_ID),
      tickets: projectTickets(events, RUN_ID),
      generatedFiles: ['package.json'],
    };
    const first = deriveRunProvenance(input);
    const second = deriveRunProvenance(input);
    expect(second).toEqual(first);
  });
});
