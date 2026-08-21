/**
 * Gate + repair projection (U7): pure fold over the gate and repair event
 * families.
 *
 * Proves the two invariants the repair loop depends on: repair budgets are
 * LEDGER-DERIVED (replaying the same events yields the same consumed budget —
 * a restart never resets counters), and gate feedback reflects the latest
 * failure per gate with later passes clearing it.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryEventStore } from '@software-factory/core';
import type { EventStore } from '@software-factory/core';
import { projectGateRepair, RUN_GATE_SCOPE } from '../../src/index';

const RUN = 'run-gate-proj';

async function seed(store: EventStore): Promise<void> {
  const gateActor = { kind: 'gate', id: 'gate-runner' } as const;
  const subject = { kind: 'gate', id: 'lint' } as const;
  await store.append({
    runId: RUN,
    ticketId: 'data-model',
    type: 'gate.started',
    actor: gateActor,
    subject,
    severity: 'info',
    payload: { gate: 'lint', stage: 'post_ticket', attempt: 1 },
  });
  await store.append({
    runId: RUN,
    ticketId: 'data-model',
    type: 'gate.failed',
    actor: gateActor,
    subject,
    severity: 'error',
    payload: { gate: 'lint', reason: '3 lint problems', stage: 'post_ticket' },
  });
  await store.append({
    runId: RUN,
    ticketId: 'data-model',
    type: 'repair.started',
    actor: { kind: 'gate', id: 'repair-loop' },
    subject: { kind: 'ticket', id: 'data-model' },
    severity: 'warn',
    payload: { attempt: 1, gate: 'lint', reason: '3 lint problems' },
  });
}

describe('projectGateRepair', () => {
  it('projects consumed repair budget and open gate feedback from the ledger', async () => {
    const store = createInMemoryEventStore();
    await seed(store);

    const projection = projectGateRepair(await store.readRun(RUN), RUN);
    expect(projection.repairs['data-model']?.attemptsUsed).toBe(1);
    expect(projection.repairs['data-model']?.exhausted).toBe(false);
    expect(projection.gateFeedback['data-model']).toEqual([
      { gate: 'lint', reason: '3 lint problems' },
    ]);
    expect(projection.outcomes).toHaveLength(1);
    expect(projection.outcomes[0]).toMatchObject({
      scope: 'data-model',
      gate: 'lint',
      stage: 'post_ticket',
      status: 'failed',
      attempts: 1,
    });

    // Replay determinism: projecting the same events again is identical.
    const replayed = projectGateRepair(await store.readRun(RUN), RUN);
    expect(replayed).toEqual(projection);
  });

  it('clears feedback when the gate later passes and records repair success', async () => {
    const store = createInMemoryEventStore();
    await seed(store);
    await store.append({
      runId: RUN,
      ticketId: 'data-model',
      type: 'gate.started',
      actor: { kind: 'gate', id: 'gate-runner' },
      subject: { kind: 'gate', id: 'lint' },
      severity: 'info',
      payload: { gate: 'lint', stage: 'post_ticket', attempt: 1 },
    });
    await store.append({
      runId: RUN,
      ticketId: 'data-model',
      type: 'gate.passed',
      actor: { kind: 'gate', id: 'gate-runner' },
      subject: { kind: 'gate', id: 'lint' },
      severity: 'success',
      payload: { gate: 'lint', summary: 'lint clean', stage: 'post_ticket' },
    });
    await store.append({
      runId: RUN,
      ticketId: 'data-model',
      type: 'repair.succeeded',
      actor: { kind: 'gate', id: 'repair-loop' },
      subject: { kind: 'ticket', id: 'data-model' },
      severity: 'success',
      payload: { attempt: 1, gate: 'lint' },
    });

    const projection = projectGateRepair(await store.readRun(RUN), RUN);
    expect(projection.gateFeedback['data-model']).toBeUndefined();
    expect(projection.outcomes[0]).toMatchObject({ status: 'passed', attempts: 2 });
    expect(projection.repairs['data-model']).toMatchObject({
      attemptsUsed: 1,
      exhausted: false,
    });
    expect(projection.exhaustedTickets).toEqual([]);
  });

  it('marks a ticket exhausted after repair.failed and scopes run-level gates separately', async () => {
    const store = createInMemoryEventStore();
    await seed(store);
    await store.append({
      runId: RUN,
      ticketId: 'data-model',
      type: 'repair.failed',
      actor: { kind: 'gate', id: 'repair-loop' },
      subject: { kind: 'ticket', id: 'data-model' },
      severity: 'error',
      payload: { attempt: 1, gate: 'lint', reason: 'still failing' },
    });
    // Run-level (post_run) gate events carry no ticketId.
    await store.append({
      runId: RUN,
      type: 'gate.started',
      actor: { kind: 'gate', id: 'gate-runner' },
      subject: { kind: 'gate', id: 'secret-scan' },
      severity: 'info',
      payload: { gate: 'secret-scan', stage: 'post_run', attempt: 1 },
    });
    await store.append({
      runId: RUN,
      type: 'gate.passed',
      actor: { kind: 'gate', id: 'gate-runner' },
      subject: { kind: 'gate', id: 'secret-scan' },
      severity: 'success',
      payload: { gate: 'secret-scan', summary: 'no secrets', stage: 'post_run' },
    });

    const projection = projectGateRepair(await store.readRun(RUN), RUN);
    expect(projection.exhaustedTickets).toEqual(['data-model']);
    expect(projection.repairs['data-model']?.lastReason).toBe('still failing');
    const runScope = projection.outcomes.find((o) => o.scope === RUN_GATE_SCOPE);
    expect(runScope).toMatchObject({ gate: 'secret-scan', stage: 'post_run', status: 'passed' });
    // Run-scope gate feedback is never attributed to a ticket.
    expect(Object.keys(projection.gateFeedback)).toEqual(['data-model']);
  });
});
