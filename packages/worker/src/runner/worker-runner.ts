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
  isWaitableAdapterError,
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
import { sleepAbortable } from '../utils/sleep';

/** Evidence label under which nested-agent metadata is recorded. */
export const NESTED_AGENT_EVIDENCE_LABEL = 'nested-agent';

/** Default bounded-retry budget: 1 initial attempt + 2 retries. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Tuning for waiting out a WAITABLE adapter failure (`usage_limited`): the
 * plan/usage window is exhausted, so instead of failing the ticket the runner
 * sleeps and retries once the window may have reset. Waits are budgeted by
 * TIME (`maxTotalWaitMs`), never by the bounded retry count — a usage pause is
 * not a fault, so it must not burn the operator's retry budget.
 */
export interface UsageWaitPolicy {
  /** Sleep between probes when the CLI did not advertise a reset time. */
  readonly defaultDelayMs?: number;
  /** Floor for any single sleep (guards against mis-parsed tiny hints). */
  readonly minDelayMs?: number;
  /** Ceiling for any single sleep (a far-out reset is re-probed in hops). */
  readonly maxDelayMs?: number;
  /** Total sleep budget before the ticket fails as usage_limited anyway. */
  readonly maxTotalWaitMs?: number;
  /**
   * Cross-user fairness (multi-user U8): consulted while a usage wait is in
   * progress — return `true` to YIELD the executor (outcome `yielded` with a
   * `notBefore` resume hint) instead of continuing to sleep in place. When
   * present, each sleep is CHUNKED into hops of at most `yieldCheckIntervalMs`
   * and the callback is re-evaluated per hop, so another owner's queued run
   * starts within roughly one hop of arriving. ABSENT (lone user / local) =
   * today's long in-place sleeps, byte-identical.
   */
  readonly shouldYield?: () => boolean | Promise<boolean>;
  /** Max hop length between yield checks (ms). Defaults to 60s. */
  readonly yieldCheckIntervalMs?: number;
}

/** Default hop length between `shouldYield` checks. */
export const DEFAULT_YIELD_CHECK_INTERVAL_MS = 60_000;

/** The numeric wait tuning with defaults applied (yield fields stay optional). */
type ResolvedUsageWait = Required<
  Pick<UsageWaitPolicy, 'defaultDelayMs' | 'minDelayMs' | 'maxDelayMs' | 'maxTotalWaitMs'>
> &
  Pick<UsageWaitPolicy, 'shouldYield' | 'yieldCheckIntervalMs'>;

/** Defaults sized for Claude/Codex plan windows (5h rolling resets). */
export const DEFAULT_USAGE_WAIT: ResolvedUsageWait = {
  defaultDelayMs: 15 * 60_000,
  minDelayMs: 30_000,
  maxDelayMs: 60 * 60_000,
  maxTotalWaitMs: 12 * 60 * 60_000,
};

/**
 * The outcome of running a ticket. `yielded` (U8) means the ticket gave the
 * executor back mid-usage-wait for cross-user fairness: nothing failed, the
 * ticket simply did not run to completion and should be re-attempted no
 * earlier than the result's `notBefore` hint.
 */
export type RunTicketOutcome = 'completed' | 'failed' | 'cancelled' | 'yielded';

/** Inputs for a single ticket run. */
export interface RunTicketParams {
  readonly runId: string;
  /** Inputs to compile the per-ticket worker context (compiled internally). */
  readonly compileInput: CompileContextInput;
  /** Isolated working directory handed to the adapter. */
  readonly workspaceDir: string;
  /** Ticket-level cancellation signal (composes with the run-level token). */
  readonly signal: AbortSignal;
  /** Explicit model override forwarded to the adapter (absent = adapter default). */
  readonly model?: string;
  /** Family of the agent that invoked the factory, for nested-agent metadata. */
  readonly callerFamily?: AdapterFamily;
  /** Bounded retry budget (total attempts). Defaults to DEFAULT_MAX_ATTEMPTS. */
  readonly maxAttempts?: number;
  /** Soft per-task timeout (ms), forwarded to the adapter. */
  readonly timeoutMs?: number;
  /** Wait-out-the-usage-window tuning. Defaults to DEFAULT_USAGE_WAIT. */
  readonly usageWait?: UsageWaitPolicy;
}

/** Dependencies for a ticket run (the seams that tests substitute). */
export interface RunTicketDeps {
  /** Append-only ledger sink. */
  readonly store: EventStore;
  /** The selected execution adapter. */
  readonly adapter: ExecutionAdapter;
  /** Optional clock for deterministic event timestamps. */
  readonly clock?: () => number;
  /**
   * Per-run credential redactor (multi-user U7): every worker-derived text
   * this runner appends (progress messages, wait notes, retry/failure
   * reasons, completion summaries) passes through it, so an echoed credential
   * never persists on the ledger. Stateful across calls (rolling buffer) —
   * one instance per run. Absent = identity (single-tenant unchanged).
   */
  readonly redact?: (text: string) => string;
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
  /**
   * Resume hint for a `yielded` outcome (epoch ms): the moment the usage
   * window is expected to have reset. Re-attempting earlier just re-hits the
   * limit.
   */
  readonly notBefore?: number;
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
  const scrub = deps.redact ?? ((text: string): string => text);
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
      payload: { state, reason: reason !== undefined ? scrub(reason) : undefined },
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
      payload: { reason: scrub(error.message) },
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
    model: params.model,
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

  const usageWait: ResolvedUsageWait = { ...DEFAULT_USAGE_WAIT, ...params.usageWait };
  let usageWaitedMs = 0;
  let attempts = 0;
  let lastError: AdapterError | undefined;
  let lastResult: AdapterResult | undefined;

  // Bounded in every branch: retryable failures by `maxAttempts`, waitable
  // (usage-window) failures by `usageWait.maxTotalWaitMs` with each sleep
  // >= minDelayMs, everything else exits the loop on its first occurrence.
  for (let attempt = 1; ; attempt += 1) {
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
              payload: { message: scrub(event.message), percent: event.percent },
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
        payload: { summary: scrubOptional(scrub, result.summary ?? truncate(result.output)) },
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
        payload: {
          attempt: attempt + 1,
          reason: scrub(`${result.error.kind}: ${result.error.message}`),
        },
      });
      await emitTicketState('retrying', result.error.message);
      // Honor a server-suggested backoff (e.g. rate-limit `retryAfterMs`) before
      // the next attempt; the wait is cancellable via the ticket signal.
      const retryAfterMs = result.error.retryAfterMs;
      if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
        await sleepAbortable(retryAfterMs, params.signal);
      }
      continue;
    }

    // WAITABLE failure (usage window exhausted): sleep until the window may
    // have reset, then retry. Budgeted by total wait time — NOT by the bounded
    // retry count, because a usage pause is expected behavior, not a fault.
    if (isWaitableAdapterError(result.error) && usageWaitedMs < usageWait.maxTotalWaitMs) {
      const hinted = result.error.retryAfterMs;
      const remaining = usageWait.maxTotalWaitMs - usageWaitedMs;
      const delay = Math.min(
        Math.max(hinted ?? usageWait.defaultDelayMs, usageWait.minDelayMs),
        usageWait.maxDelayMs,
        remaining,
      );
      const notBefore = (deps.clock?.() ?? Date.now()) + delay;
      const resumeAt = new Date(notBefore);
      const waitNote =
        `usage limit reached — waiting ${formatDelay(delay)} (until ~${resumeAt.toISOString()}) ` +
        `for the usage window to reset, then retrying automatically`;
      await append({
        type: 'worker.retry',
        actor: workerActor,
        subject: { kind: 'ticket', id: ticketId },
        severity: 'warn',
        payload: { attempt: attempt + 1, reason: scrub(`${result.error.kind}: ${waitNote}`) },
      });
      await emitTicketState('retrying', waitNote);

      if (usageWait.shouldYield === undefined) {
        // Lone user / local: today's long in-place sleep, byte-identical.
        await sleepAbortable(delay, params.signal);
        usageWaitedMs += delay;
        continue;
      }

      // Cross-user fairness (U8): CHUNK the sleep into short hops and consult
      // the yield callback per hop, so another owner's queued run starts
      // within roughly one hop — never the full (up to 60-minute) delay.
      const hopMs = Math.max(1, usageWait.yieldCheckIntervalMs ?? DEFAULT_YIELD_CHECK_INTERVAL_MS);
      let slept = 0;
      let yielded = await usageWait.shouldYield();
      while (!yielded && slept < delay && !params.signal.aborted) {
        const hop = Math.min(hopMs, delay - slept);
        await sleepAbortable(hop, params.signal);
        slept += hop;
        if (slept < delay) {
          yielded = await usageWait.shouldYield();
        }
      }
      usageWaitedMs += slept;
      if (params.signal.aborted) {
        lastError = makeCancelled(params.signal);
        break;
      }
      if (yielded) {
        const yieldNote =
          `usage limit reached — yielded the executor to other queued work; ` +
          `resumes no earlier than ~${resumeAt.toISOString()}`;
        await emitTicketState('queued', yieldNote);
        return {
          ticketId,
          outcome: 'yielded',
          attempts,
          result,
          error: result.error,
          nested,
          notBefore,
        };
      }
      continue;
    }

    // Terminal failure (non-retryable, or retry/wait budget exhausted).
    const budgetNote =
      isWaitableAdapterError(result.error) && usageWaitedMs >= usageWait.maxTotalWaitMs
        ? ` (waited ${formatDelay(usageWaitedMs)} for a usage-window reset without recovery)`
        : '';
    await append({
      type: 'worker.failed',
      actor: workerActor,
      subject: { kind: 'ticket', id: ticketId },
      severity: 'error',
      payload: { reason: scrub(`${result.error.kind}: ${result.error.message}${budgetNote}`) },
    });
    await emitTicketState('failed', `${result.error.message}${budgetNote}`);
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

function scrubOptional(
  scrub: (text: string) => string,
  text: string | undefined,
): string | undefined {
  return text !== undefined ? scrub(text) : undefined;
}

function makeCancelled(signal: AbortSignal): AdapterError {
  const reason = typeof signal.reason === 'string' ? signal.reason : undefined;
  return normalizeAdapterError(
    Object.assign(new Error(reason ?? 'Worker cancelled.'), { name: 'AbortError' }),
  );
}

/** Human-facing duration for wait notes: "45s", "15m", "1h30m". */
function formatDelay(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) {
    return `${Math.max(1, Math.round(ms / 1_000))}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes}m`;
  }
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}

function truncate(text: string, max = 200): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
