/**
 * Minimal deterministic event-envelope builder for tests (session lifecycle
 * U5): hand-build small ledgers — or extend fixture ledgers — with contiguous
 * sequences, mirroring the marketplace fixture's envelope shape so the core
 * validators accept every event. The mapped-union spec type keeps the
 * type/payload correlation compile-checked per event.
 */
import type {
  EventPayloadMap,
  EventSeverity,
  FactoryEvent,
  FactoryEventType,
} from '@software-factory/core';

/** One event to append: type/payload correlation enforced per member. */
export type TestEventSpec = {
  [T in FactoryEventType]: {
    readonly type: T;
    readonly payload: EventPayloadMap[T];
    readonly severity?: EventSeverity;
    readonly ticketId?: string;
  };
}[FactoryEventType];

/** Build a ledger for `runId` with contiguous sequences from `startSequence`. */
export function buildEvents(
  runId: string,
  specs: readonly TestEventSpec[],
  startSequence = 1,
): FactoryEvent[] {
  return specs.map((spec, index) => {
    const sequence = startSequence + index;
    return {
      version: 1,
      eventId: `evt-${sequence}`,
      runId,
      ticketId: spec.ticketId,
      actor: { kind: 'system', id: 'test' },
      subject: { kind: 'run', id: runId },
      type: spec.type,
      sequence,
      timestamp: 1_700_000_000_000 + sequence * 1000,
      severity: spec.severity ?? 'info',
      payload: spec.payload,
      // The precise per-member correlation is checked by TestEventSpec above;
      // the single localized widening to the discriminated union mirrors the
      // marketplace fixture's builder.
    } as FactoryEvent;
  });
}

/** Extend an existing ledger, continuing its sequence numbering. */
export function appendEvents(
  base: readonly FactoryEvent[],
  runId: string,
  specs: readonly TestEventSpec[],
): FactoryEvent[] {
  const last = base[base.length - 1];
  return [...base, ...buildEvents(runId, specs, (last?.sequence ?? 0) + 1)];
}

/**
 * AE4's exact shape: a failed post-run gate emits BOTH a `retry_choice`
 * intervention and a pending stage review (the ticket-executor pairing) — one
 * operator decision recorded twice on the ledger. The needs-you union rule
 * must render it as ONE item.
 */
export function buildRetryPendingEvents(runId: string): FactoryEvent[] {
  const base = buildEvents(runId, [
    { type: 'run.created', payload: { prompt: 'Small app', reviewMode: 'human' } },
    { type: 'ticket.created', payload: { title: 'Build the app' }, ticketId: 't1' },
    { type: 'run.planned', payload: { ticketCount: 1 } },
    { type: 'run.started', payload: {} },
    { type: 'gate.started', payload: { gate: 'unit-test', stage: 'post_run' }, ticketId: 't1' },
    {
      type: 'gate.failed',
      payload: { gate: 'unit-test', reason: '2 tests failed', stage: 'post_run' },
      severity: 'error',
      ticketId: 't1',
    },
  ]);
  return appendEvents(base, runId, [
    {
      type: 'intervention.raised',
      severity: 'warn',
      payload: {
        interventionId: `${runId}:gates:blocked:1`,
        kind: 'retry_choice',
        blockingStage: 'gates',
        reason: 'Post-run gate "unit-test" failed.',
        requiredAction: 'Fix the cause, then re-run gates or approve the stage review.',
      },
    },
    {
      type: 'review.requested',
      severity: 'warn',
      payload: {
        riskTier: 'low',
        summary: 'Post-run gate "unit-test" failed.',
        stage: 'gates',
      },
    },
  ]);
}

/** `buildRetryPendingEvents` with the decision made and the pair resolved. */
export function buildRetryResolvedEvents(runId: string): FactoryEvent[] {
  return appendEvents(buildRetryPendingEvents(runId), runId, [
    {
      type: 'review.decided',
      payload: { riskTier: 'low', decision: 'approved', rationale: 'Retry the gates.' },
    },
    {
      type: 'intervention.resolved',
      payload: { interventionId: `${runId}:gates:blocked:1`, resolution: 'approved' },
    },
  ]);
}
