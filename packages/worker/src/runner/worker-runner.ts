/**
 * Worker runner: execute ONE ticket through a selected adapter.
 *
 * `runTicket` compiles the per-ticket context, runs the adapter while streaming
 * `worker.progress`, retries a bounded number of times on RETRYABLE adapter
 * errors (`worker.retry` with attempt + reason), and writes the lifecycle to the
 * ledger: `adapter.selected` -> `worker.started` -> (`worker.progress` |
 * `worker.retry`)* -> `worker.completed` | `worker.failed` | `worker.cancelled`,
 * each paired with a `ticket.state_changed`. Cancellation (the injected signal)
 * always wins over retries and produces `worker.cancelled`.
 *
 * When the caller's agent family equals the selected adapter's family, the run is
 * recorded as a NESTED agent execution: the metadata is attached as event
 * evidence on `worker.started`/`worker.completed` (and carried on the result).
 *
 * Adapter failures are normalized and returned as data; only unexpected
 * infrastructure errors (e.g. the store rejecting) propagate — nothing is
 * fire-and-forget.
 */
import {
  compileContext,
  isCancellation,
  isRetryableAdapterError,
  normalizeAdapterError,
} from '@software-factory/core';
import type {
  AdapterError,
  AdapterExecuteOptions,
  AdapterFamily,
  AdapterResult,
  AdapterTask,
  AppendableEvent,
  CompileContextInput,
  EventActor,
  EventEvidence,
  EventSeverity,
  EventStore,
  ExecutionAdapter,
  TicketState,
  WorkerContext,
} from '@software-factory/core';

/** Evidence label under which nested-agent metadata is recorded. */
export const NESTED_AGENT_EVIDENCE_LABEL = 'nested-agent';

/** Default bounded-retry budget: 1 initial attempt + 2 retries. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** The terminal outcome of running a ticket. */
export type RunTicketOutcome = 'completed' | 'failed' | 'cancelled';

/** Inputs for a single ticket run. */
export interface RunTicketParams {
  readonly runId: string;
  /** Inputs to compile the per-ticket worker context (compiled internally). */
  readonly compileInput: CompileContextInput;
  /** Isolated working directory handed to the adapter. */
  readonly workspaceDir: string;
  /** Ticket-level cancellation signal (composes with the run-level token). */
  readonly signal: AbortSignal;
  /** Family of the agent that invoked the factory, for nested-agent metadata. */
  readonly callerFamily?: AdapterFamily;
  /** Bounded retry budget (total attempts). Defaults to DEFAULT_MAX_ATTEMPTS. */
  readonly maxAttempts?: number;
  /** Soft per-task timeout (ms), forwarded to the adapter. */
  readonly timeoutMs?: number;
}

/** Dependencies for a ticket run (the seams that tests substitute). */
export interface RunTicketDeps {
  /** Append-only ledger sink. */
  readonly store: EventStore;
  /** The selected execution adapter. */
  readonly adapter: ExecutionAdapter;
  /** Optional clock for deterministic event timestamps. */
  readonly clock?: () => number;
}

/** The structured result of a ticket run. */
export interface RunTicketResult {
  readonly ticketId: string;
  readonly outcome: RunTicketOutcome;
  /** Attempts actually made (>= 1 when execution started). */
  readonly attempts: number;
  /** The adapter result for the final attempt, when execution ran. */
  readonly result?: AdapterResult;
  /** The normalized error for a failed/cancelled outcome. */
  readonly error?: AdapterError;
  /** `true` when this was recorded as a nested-agent execution. */
  readonly nested: boolean;
}

function nestedEvidence(callerFamily: AdapterFamily, adapter: ExecutionAdapter): EventEvidence[] {
  return [
    {
      label: NESTED_AGENT_EVIDENCE_LABEL,
      ref: adapter.family,
      note: `caller=${callerFamily}; adapter=${adapter.family}; adapterId=${adapter.id}`,
    },
  ];
}

const STATE_SEVERITY: Readonly<Record<TicketState, EventSeverity>> = {
  created: 'info',
  queued: 'info',
  running: 'info',
  blocked: 'warn',
  retrying: 'warn',
  completed: 'success',
  failed: 'error',
  dead_lettered: 'error',
  cancelled: 'warn',
};

/**
 * Run a single ticket end-to-end. Never throws for adapter failures (they are
 * normalized into the result); infrastructure errors propagate.
 */
export async function runTicket(
  params: RunTicketParams,
  deps: RunTicketDeps,
): Promise<RunTicketResult> {
  const { store, adapter } = deps;
  const context: WorkerContext = compileContext(params.compileInput);
  const ticketId = context.ticketId;
  const maxAttempts = Math.max(1, Math.trunc(params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const nested = params.callerFamily !== undefined && params.callerFamily === adapter.family;
  const evidence = nested
    ? nestedEvidence(params.callerFamily as AdapterFamily, adapter)
    : undefined;

  const workerActor: EventActor = { kind: 'worker', id: adapter.id, display: adapter.family };
  const adapterActor: EventActor = { kind: 'adapter', id: adapter.id, display: adapter.family };

  const append = (event: Omit<AppendableEvent, 'runId' | 'ticketId'>): Promise<unknown> =>
    store.append({
      ...event,
      runId: params.runId,
      ticketId,
      timestamp: deps.clock?.(),
    } as AppendableEvent);

  const emitTicketState = (state: TicketState, reason?: string): Promise<unknown> =>
    append({
      type: 'ticket.state_changed',
      actor: workerActor,
      subject: { kind: 'ticket', id: ticketId },
      severity: STATE_SEVERITY[state],
      payload: { state, reason },
    });

  // Record which adapter will run this ticket before doing any work.
  await append({
    type: 'adapter.selected',
    actor: adapterActor,
    subject: { kind: 'ticket', id: ticketId },
    severity: 'info',
    evidence,
    payload: { adapterId: adapter.id, family: adapter.family },
  });

  // Cancellation before we ever start: emit cancelled, never worker.started.
  if (params.signal.aborted) {
    const error = makeCancelled(params.signal);
    await append({
      type: 'worker.cancelled',
      actor: workerActor,
      subject: { kind: 'ticket', id: ticketId },
      severity: 'warn',
      evidence,
      payload: { reason: error.message },
    });
    await emitTicketState('cancelled', error.message);
    return { ticketId, outcome: 'cancelled', attempts: 0, error, nested };
  }

  const task: AdapterTask = {
    runId: params.runId,
    ticketId,
    title: context.title,
    context,
    workspaceDir: params.workspaceDir,
    callerFamily: params.callerFamily,
  };

  await append({
    type: 'worker.started',
    actor: workerActor,
    subject: { kind: 'ticket', id: ticketId },
    severity: 'info',
    evidence,
    payload: { adapterId: adapter.id },
  });
  await emitTicketState('running');

  let attempts = 0;
  let lastError: AdapterError | undefined;
  let lastResult: AdapterResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;

    if (params.signal.aborted) {
      lastError = makeCancelled(params.signal);
      break;
    }

    // Stream progress appends; await them before any terminal event so ledger
    // ordering stays monotonic and no append is left unobserved.
    const pending: Promise<unknown>[] = [];
    const execOptions: AdapterExecuteOptions = {
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      onEvent: (event) => {
        if (event.kind === 'progress') {
          pending.push(
            append({
              type: 'worker.progress',
              actor: workerActor,
              subject: { kind: 'ticket', id: ticketId },
              severity: 'info',
              payload: { message: event.message, percent: event.percent },
            }),
          );
        }
      },
    };

    let result: AdapterResult;
    try {
      result = await adapter.execute(task, execOptions);
    } catch (error) {
      result = { ok: false, error: normalizeAdapterError(error) };
    }
    await Promise.all(pending);
    lastResult = result;

    if (result.ok) {
      await append({
        type: 'worker.completed',
        actor: workerActor,
        subject: { kind: 'ticket', id: ticketId },
        severity: 'success',
        evidence,
        payload: { summary: result.summary ?? truncate(result.output) },
      });
      await emitTicketState('completed');
      return { ticketId, outcome: 'completed', attempts, result, nested };
    }

    lastError = result.error;

    // Cancellation always wins over retry.
    if (isCancellation(result.error) || params.signal.aborted) {
      lastError = params.signal.aborted ? makeCancelled(params.signal) : result.error;
      break;
    }

    if (isRetryableAdapterError(result.error) && attempt < maxAttempts) {
      await append({
        type: 'worker.retry',
        actor: workerActor,
        subject: { kind: 'ticket', id: ticketId },
        severity: 'warn',
        payload: { attempt: attempt + 1, reason: `${result.error.kind}: ${result.error.message}` },
      });
      await emitTicketState('retrying', result.error.message);
      continue;
    }

    // Terminal failure (non-retryable, or retry budget exhausted).
    await append({
      type: 'worker.failed',
      actor: workerActor,
      subject: { kind: 'ticket', id: ticketId },
      severity: 'error',
      payload: { reason: `${result.error.kind}: ${result.error.message}` },
    });
    await emitTicketState('failed', result.error.message);
    return { ticketId, outcome: 'failed', attempts, result, error: result.error, nested };
  }

  // Reached only via the cancellation break paths.
  const error = lastError ?? makeCancelled(params.signal);
  await append({
    type: 'worker.cancelled',
    actor: workerActor,
    subject: { kind: 'ticket', id: ticketId },
    severity: 'warn',
    evidence,
    payload: { reason: error.message },
  });
  await emitTicketState('cancelled', error.message);
  return { ticketId, outcome: 'cancelled', attempts, result: lastResult, error, nested };
}

function makeCancelled(signal: AbortSignal): AdapterError {
  const reason = typeof signal.reason === 'string' ? signal.reason : undefined;
  return normalizeAdapterError(
    Object.assign(new Error(reason ?? 'Worker cancelled.'), { name: 'AbortError' }),
  );
}

function truncate(text: string, max = 200): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
