/**
 * Ledger-backed execution queue (full-factory U5, KTD4/E2).
 *
 * The queue is DURABLE and single-instance: queue state is nothing but a fold
 * over `queue.*` ledger events, so a restart replays the same queue and never
 * loses or invents work. The semantics borrow BullMQ's lock/stalled-job shape
 * without the dependency:
 *
 *   enqueue -> claim (lease with expiry) -> heartbeat (extend lease)
 *           -> release (completed | failed | blocked | cancelled | requeued)
 *   crash   -> lease expires -> reconciler marks the lease ABANDONED and
 *              escalates to the operator intervention queue (never re-runs
 *              ambiguous in-flight work silently).
 *
 * All append helpers are idempotent per (jobId, attempt) so client retries and
 * repeated reconciler passes converge instead of duplicating queue state. The
 * database-backed queue replacement seam (U11) must preserve exactly these
 * invariants: append atomicity plus a unique idempotency-key constraint give
 * store-level claim arbitration, per-run sequence monotonicity gives fold
 * ordering, and `projectExecutionQueue` stays the single reader. Nothing in
 * this module holds queue state in process memory. See daemon.ts (invariants
 * list) and ARCHITECTURE.md ("Hosted Scale Migration Seam").
 */
import { resolveTargetRunId, validateAndSortEvents } from '@software-factory/core';
import type {
  AppendResult,
  EventStore,
  QueueJobKind,
  QueueReleaseOutcome,
} from '@software-factory/core';

/** Projected status of one queue job (latest attempt wins). */
export type QueueJobStatus =
  | 'queued'
  | 'leased'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'abandoned';

export interface QueueJobView {
  readonly jobId: string;
  readonly runId: string;
  readonly jobKind: QueueJobKind;
  /** Latest attempt observed for this job (1-based). */
  readonly attempt: number;
  readonly status: QueueJobStatus;
  readonly leaseId?: string;
  readonly ownerId?: string;
  readonly leaseExpiresAt?: number;
  readonly enqueuedAt: number;
  /** Ticket focus recorded on a retry-ticket enqueue (consumed by U6). */
  readonly ticketId?: string;
  readonly reason?: string;
  readonly lastSequence: number;
}

export interface ExecutionQueueProjection {
  /** All jobs, ordered by first appearance on the ledger. */
  readonly jobs: QueueJobView[];
  readonly byJobId: Record<string, QueueJobView>;
}

interface MutableJob {
  jobId: string;
  runId: string;
  jobKind: QueueJobKind;
  attempt: number;
  status: QueueJobStatus;
  leaseId?: string;
  ownerId?: string;
  leaseExpiresAt?: number;
  enqueuedAt: number;
  ticketId?: string;
  reason?: string;
  firstSequence: number;
  lastSequence: number;
}

/** The stable run-execution job id for a run (one execution job per run). */
export function executionJobId(runId: string): string {
  return `${runId}:execution`;
}

/** The stable gate-rerun job id for a run. */
export function gateRerunJobId(runId: string): string {
  return `${runId}:gate-rerun`;
}

/**
 * Project queue jobs from ledger events. Pure and replay-deterministic; when
 * `runId` is given only that run's jobs are folded, otherwise all runs.
 */
export function projectExecutionQueue(
  raw: readonly unknown[],
  runId?: string,
): ExecutionQueueProjection {
  const { events } = validateAndSortEvents(raw);
  const scoped =
    runId === undefined
      ? events
      : events.filter((event) => event.runId === (resolveTargetRunId(events, runId) ?? runId));

  const map = new Map<string, MutableJob>();
  for (const event of scoped) {
    switch (event.type) {
      case 'queue.enqueued': {
        const existing = map.get(event.payload.jobId);
        if (existing === undefined) {
          map.set(event.payload.jobId, {
            jobId: event.payload.jobId,
            runId: event.runId,
            jobKind: event.payload.jobKind,
            attempt: event.payload.attempt,
            status: 'queued',
            enqueuedAt: event.timestamp,
            ticketId: event.payload.ticketId,
            reason: event.payload.reason,
            firstSequence: event.sequence,
            lastSequence: event.sequence,
          });
        } else if (event.payload.attempt >= existing.attempt) {
          existing.attempt = event.payload.attempt;
          existing.status = 'queued';
          existing.leaseId = undefined;
          existing.ownerId = undefined;
          existing.leaseExpiresAt = undefined;
          existing.enqueuedAt = event.timestamp;
          existing.ticketId = event.payload.ticketId ?? existing.ticketId;
          existing.reason = event.payload.reason;
          existing.lastSequence = event.sequence;
        }
        break;
      }
      case 'queue.claimed': {
        const job = map.get(event.payload.jobId);
        if (job !== undefined && event.payload.attempt === job.attempt) {
          job.status = 'leased';
          job.leaseId = event.payload.leaseId;
          job.ownerId = event.payload.ownerId;
          job.leaseExpiresAt = event.payload.leaseExpiresAt;
          job.lastSequence = event.sequence;
        }
        break;
      }
      case 'queue.heartbeat': {
        const job = map.get(event.payload.jobId);
        if (
          job !== undefined &&
          event.payload.attempt === job.attempt &&
          job.leaseId === event.payload.leaseId
        ) {
          job.leaseExpiresAt = event.payload.leaseExpiresAt;
          job.lastSequence = event.sequence;
        }
        break;
      }
      case 'queue.released': {
        const job = map.get(event.payload.jobId);
        if (job !== undefined && event.payload.attempt === job.attempt) {
          job.status =
            event.payload.outcome === 'requeued'
              ? 'queued'
              : (event.payload.outcome satisfies QueueJobStatus);
          job.reason = event.payload.reason ?? job.reason;
          if (event.payload.outcome !== 'requeued') {
            job.leaseId = undefined;
            job.ownerId = undefined;
          }
          job.leaseExpiresAt = undefined;
          job.lastSequence = event.sequence;
        }
        break;
      }
      case 'queue.lease_abandoned': {
        const job = map.get(event.payload.jobId);
        if (job !== undefined && event.payload.attempt === job.attempt) {
          job.status = 'abandoned';
          job.reason = event.payload.reason;
          job.leaseExpiresAt = undefined;
          job.lastSequence = event.sequence;
        }
        break;
      }
      default:
        break;
    }
  }

  const jobs = [...map.values()]
    .sort((a, b) => a.firstSequence - b.firstSequence)
    .map((job): QueueJobView => {
      const { firstSequence: _first, ...view } = job;
      return view;
    });
  const byJobId: Record<string, QueueJobView> = {};
  for (const job of jobs) {
    byJobId[job.jobId] = job;
  }
  return { jobs, byJobId };
}

/** Whether a job is active: queued, leased, or abandoned-awaiting-resolution. */
export function isActiveJobStatus(status: QueueJobStatus): boolean {
  return status === 'queued' || status === 'leased';
}

const QUEUE_ACTOR = { kind: 'system', id: 'execution-daemon' } as const;

function subjectFor(jobId: string): { kind: string; id: string } {
  return { kind: 'queue-job', id: jobId };
}

export interface EnqueueJobInput {
  readonly runId: string;
  readonly jobId: string;
  readonly jobKind: QueueJobKind;
  readonly attempt: number;
  readonly reason?: string;
  readonly ticketId?: string;
}

/** Append `queue.enqueued`, idempotent per (jobId, attempt). */
export function enqueueJob(store: EventStore, input: EnqueueJobInput): Promise<AppendResult> {
  return store.append({
    runId: input.runId,
    type: 'queue.enqueued',
    actor: QUEUE_ACTOR,
    subject: subjectFor(input.jobId),
    severity: 'info',
    idempotencyKey: `${input.jobId}:enqueued:${input.attempt}`,
    payload: {
      jobId: input.jobId,
      jobKind: input.jobKind,
      attempt: input.attempt,
      reason: input.reason,
      ticketId: input.ticketId,
    },
  });
}

export interface ClaimJobInput {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly leaseExpiresAt: number;
}

/** Append `queue.claimed`, idempotent per (jobId, attempt). */
export function claimJob(
  store: EventStore,
  job: QueueJobView,
  input: ClaimJobInput,
): Promise<AppendResult> {
  return store.append({
    runId: job.runId,
    type: 'queue.claimed',
    actor: { kind: 'system', id: input.ownerId },
    subject: subjectFor(job.jobId),
    severity: 'info',
    idempotencyKey: `${job.jobId}:claimed:${job.attempt}`,
    payload: {
      jobId: job.jobId,
      jobKind: job.jobKind,
      attempt: job.attempt,
      leaseId: input.leaseId,
      ownerId: input.ownerId,
      leaseExpiresAt: input.leaseExpiresAt,
    },
  });
}

/** Append `queue.heartbeat`, extending the lease. Not idempotent by design. */
export function heartbeatJob(
  store: EventStore,
  job: QueueJobView,
  input: ClaimJobInput,
): Promise<AppendResult> {
  return store.append({
    runId: job.runId,
    type: 'queue.heartbeat',
    actor: { kind: 'system', id: input.ownerId },
    subject: subjectFor(job.jobId),
    severity: 'info',
    payload: {
      jobId: job.jobId,
      jobKind: job.jobKind,
      attempt: job.attempt,
      leaseId: input.leaseId,
      ownerId: input.ownerId,
      leaseExpiresAt: input.leaseExpiresAt,
    },
  });
}

/** Append `queue.released`, idempotent per (jobId, attempt). */
export function releaseJob(
  store: EventStore,
  job: QueueJobView,
  outcome: QueueReleaseOutcome,
  reason?: string,
): Promise<AppendResult> {
  return store.append({
    runId: job.runId,
    type: 'queue.released',
    actor: QUEUE_ACTOR,
    subject: subjectFor(job.jobId),
    severity: outcome === 'failed' ? 'error' : outcome === 'completed' ? 'success' : 'info',
    idempotencyKey: `${job.jobId}:released:${job.attempt}:${outcome}`,
    payload: {
      jobId: job.jobId,
      jobKind: job.jobKind,
      attempt: job.attempt,
      leaseId: job.leaseId,
      outcome,
      reason,
    },
  });
}

/** Append `queue.lease_abandoned`, idempotent per (jobId, attempt). */
export function abandonLease(
  store: EventStore,
  job: QueueJobView,
  reason: string,
): Promise<AppendResult> {
  return store.append({
    runId: job.runId,
    type: 'queue.lease_abandoned',
    actor: QUEUE_ACTOR,
    subject: subjectFor(job.jobId),
    severity: 'warn',
    idempotencyKey: `${job.jobId}:abandoned:${job.attempt}`,
    payload: {
      jobId: job.jobId,
      jobKind: job.jobKind,
      attempt: job.attempt,
      leaseId: job.leaseId ?? 'unknown-lease',
      ownerId: job.ownerId,
      reason,
    },
  });
}
