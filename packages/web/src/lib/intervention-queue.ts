/**
 * Shared wire parsing for the cross-run intervention queue (the interventions
 * half of GET /api/floor). ONE structural parser serves the browser client
 * (api-client `fetchFloorStatus`) and the SSR loader (run-data
 * `loadFloorStatus`), so the two can never drift on shape, validation, or
 * degrade semantics — the exact pattern `execution-overview.ts` established
 * for the overview half. Type-only imports keep this module safe for both
 * server and client bundles.
 */
import type { EventSeverity, InterventionKind } from '@software-factory/core';
import type { InterventionItem, InterventionQueueSnapshot } from './types';

/**
 * Item-level shape check for one wire intervention: every field the UI renders
 * is validated structurally; malformed rows are dropped instead of rendering
 * `undefined` into the queue. `kind`/`severity` are validated as strings and
 * then narrowed — the browser bundle must not import core's runtime member
 * lists, and an unrecognized-but-string value degrades to a labeled badge
 * rather than a dropped intervention.
 */
function toInterventionItem(value: unknown): InterventionItem | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const {
    interventionId,
    runId,
    kind,
    severity,
    blockingStage,
    reason,
    requiredAction,
    raisedAt,
    sequence,
    status,
  } = record;
  if (
    typeof interventionId !== 'string' ||
    typeof runId !== 'string' ||
    typeof kind !== 'string' ||
    typeof severity !== 'string' ||
    typeof blockingStage !== 'string' ||
    typeof reason !== 'string' ||
    typeof requiredAction !== 'string' ||
    typeof raisedAt !== 'number' ||
    typeof sequence !== 'number' ||
    (status !== 'open' && status !== 'resolved')
  ) {
    return null;
  }
  return {
    interventionId,
    runId,
    ticketId: typeof record.ticketId === 'string' ? record.ticketId : undefined,
    kind: kind as InterventionKind,
    severity: severity as EventSeverity,
    blockingStage,
    reason,
    requiredAction,
    raisedAt,
    sequence,
    status,
    resolution: typeof record.resolution === 'string' ? record.resolution : undefined,
    resolutionNote: typeof record.resolutionNote === 'string' ? record.resolutionNote : undefined,
    resolvedAt: typeof record.resolvedAt === 'number' ? record.resolvedAt : undefined,
  };
}

/**
 * Structurally parse an intervention-queue body (`interventions` +
 * `openCount`), dropping malformed rows and degrading missing fields to an
 * empty queue.
 */
export function parseInterventionQueue(body: Record<string, unknown>): InterventionQueueSnapshot {
  const interventions = (Array.isArray(body.interventions) ? body.interventions : [])
    .map(toInterventionItem)
    .filter((item): item is InterventionItem => item !== null);
  return {
    interventions,
    openCount: typeof body.openCount === 'number' ? body.openCount : 0,
  };
}
