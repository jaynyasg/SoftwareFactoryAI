/**
 * The marketplace's own lightweight status timeline. Each significant action
 * (request created, brief generated, proposal submitted / accepted / rejected)
 * appends an immutable StatusEvent row; dashboards read them back in order.
 *
 * Functions accept an optional `db` so they can run inside an interactive
 * transaction (passed by repository.ts) or standalone against the singleton.
 */
import { getPrisma } from './repository';
import type { DbClient } from './repository';
import type { StatusEvent } from '@prisma/client';

export const STATUS_EVENT_TYPES = [
  'REQUEST_CREATED',
  'BRIEF_GENERATED',
  'PROPOSAL_SUBMITTED',
  'PROPOSAL_ACCEPTED',
  'PROPOSAL_REJECTED',
] as const;

export type StatusEventType = (typeof STATUS_EVENT_TYPES)[number];

export interface AppendStatusEventInput {
  requestId: string;
  type: StatusEventType;
  message: string;
  proposalId?: string;
}

export async function appendStatusEvent(
  input: AppendStatusEventInput,
  db: DbClient = getPrisma(),
): Promise<StatusEvent> {
  return db.statusEvent.create({
    data: {
      requestId: input.requestId,
      type: input.type,
      message: input.message,
      proposalId: input.proposalId ?? null,
    },
  });
}

export async function listStatusEvents(
  requestId?: string,
  db: DbClient = getPrisma(),
): Promise<StatusEvent[]> {
  return db.statusEvent.findMany({
    where: requestId ? { requestId } : undefined,
    // Tie-break on id so events created in the same millisecond keep insertion
    // order (cuid ids are monotonic within a process).
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}
