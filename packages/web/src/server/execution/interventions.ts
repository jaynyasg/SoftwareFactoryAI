/**
 * Operator intervention queue (full-factory U5, CEO expansion X4).
 *
 * Collects human-needed decisions across runs — approvals, missing
 * credentials, ambiguous source choices, unsafe paths, adapter setup, deploy
 * setup, and retry choices — as `intervention.raised` / `intervention.resolved`
 * ledger events, projected into a filterable queue (by run, kind, severity,
 * blocking stage, and required action).
 *
 * Raising is idempotent per interventionId so repeated preflight attempts and
 * reconciler passes converge on ONE open entry instead of stacking duplicates.
 */
import { validateAndSortEvents } from '@software-factory/core';
import type {
  AppendResult,
  EventSeverity,
  EventStore,
  InterventionKind,
} from '@software-factory/core';

export interface InterventionView {
  readonly interventionId: string;
  readonly runId: string;
  readonly ticketId?: string;
  readonly kind: InterventionKind;
  readonly severity: EventSeverity;
  /** The stage the intervention blocks (e.g. `preflight`, `execution`). */
  readonly blockingStage: string;
  readonly reason: string;
  readonly requiredAction: string;
  readonly raisedAt: number;
  readonly sequence: number;
  readonly status: 'open' | 'resolved';
  readonly resolution?: string;
  readonly resolutionNote?: string;
  readonly resolvedAt?: number;
}

export interface InterventionQueueProjection {
  /** Every intervention observed, in raise order. */
  readonly interventions: InterventionView[];
  /** Unresolved interventions, in raise order. */
  readonly open: InterventionView[];
  readonly byId: Record<string, InterventionView>;
}

/** Filter shape for the operator intervention queue (X4). */
export interface InterventionFilter {
  readonly runId?: string;
  readonly kind?: InterventionKind;
  readonly severity?: EventSeverity;
  readonly blockingStage?: string;
  /** Case-insensitive substring match over the required action. */
  readonly requiredActionText?: string;
  readonly openOnly?: boolean;
}

/** Project the cross-run intervention queue from ledger events. Pure. */
export function projectInterventions(raw: readonly unknown[]): InterventionQueueProjection {
  const { events } = validateAndSortEvents(raw);
  const byId = new Map<string, InterventionView>();

  for (const event of events) {
    if (event.type === 'intervention.raised') {
      if (!byId.has(event.payload.interventionId)) {
        byId.set(event.payload.interventionId, {
          interventionId: event.payload.interventionId,
          runId: event.runId,
          ticketId: event.ticketId,
          kind: event.payload.kind,
          severity: event.severity,
          blockingStage: event.payload.blockingStage,
          reason: event.payload.reason,
          requiredAction: event.payload.requiredAction,
          raisedAt: event.timestamp,
          sequence: event.sequence,
          status: 'open',
        });
      }
    } else if (event.type === 'intervention.resolved') {
      const existing = byId.get(event.payload.interventionId);
      if (existing !== undefined && existing.status === 'open') {
        byId.set(event.payload.interventionId, {
          ...existing,
          status: 'resolved',
          resolution: event.payload.resolution,
          resolutionNote: event.payload.note,
          resolvedAt: event.timestamp,
        });
      }
    }
  }

  const interventions = [...byId.values()].sort((a, b) => a.sequence - b.sequence);
  const open = interventions.filter((item) => item.status === 'open');
  const record: Record<string, InterventionView> = {};
  for (const item of interventions) {
    record[item.interventionId] = item;
  }
  return { interventions, open, byId: record };
}

/** Apply an operator filter over the projected queue. Pure. */
export function filterInterventions(
  projection: InterventionQueueProjection,
  filter: InterventionFilter = {},
): InterventionView[] {
  const source = filter.openOnly === true ? projection.open : projection.interventions;
  const actionText = filter.requiredActionText?.toLowerCase();
  return source.filter(
    (item) =>
      (filter.runId === undefined || item.runId === filter.runId) &&
      (filter.kind === undefined || item.kind === filter.kind) &&
      (filter.severity === undefined || item.severity === filter.severity) &&
      (filter.blockingStage === undefined || item.blockingStage === filter.blockingStage) &&
      (actionText === undefined || item.requiredAction.toLowerCase().includes(actionText)),
  );
}

export interface RaiseInterventionInput {
  readonly runId: string;
  readonly interventionId: string;
  readonly kind: InterventionKind;
  readonly blockingStage: string;
  readonly reason: string;
  readonly requiredAction: string;
  readonly severity?: EventSeverity;
  readonly ticketId?: string;
}

/** Append `intervention.raised`, idempotent per interventionId. */
export function raiseIntervention(
  store: EventStore,
  input: RaiseInterventionInput,
): Promise<AppendResult> {
  return store.append({
    runId: input.runId,
    ticketId: input.ticketId,
    type: 'intervention.raised',
    actor: { kind: 'system', id: 'execution-daemon' },
    subject: { kind: 'intervention', id: input.interventionId },
    severity: input.severity ?? 'warn',
    idempotencyKey: `${input.interventionId}:raised`,
    payload: {
      interventionId: input.interventionId,
      kind: input.kind,
      blockingStage: input.blockingStage,
      reason: input.reason,
      requiredAction: input.requiredAction,
    },
  });
}

export interface ResolveInterventionInput {
  readonly resolution: string;
  readonly note?: string;
  readonly resolvedBy?: string;
}

/** Append `intervention.resolved`, idempotent per interventionId. */
export function resolveIntervention(
  store: EventStore,
  intervention: InterventionView,
  input: ResolveInterventionInput,
): Promise<AppendResult> {
  return store.append({
    runId: intervention.runId,
    type: 'intervention.resolved',
    actor: { kind: 'operator', id: input.resolvedBy ?? 'operator' },
    subject: { kind: 'intervention', id: intervention.interventionId },
    severity: 'info',
    idempotencyKey: `${intervention.interventionId}:resolved`,
    payload: {
      interventionId: intervention.interventionId,
      resolution: input.resolution,
      note: input.note,
    },
  });
}
