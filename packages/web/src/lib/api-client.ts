/**
 * Browser API client for the local factory.
 *
 * Reads go to the read-only routes (no token). Mutations attach the loopback
 * `x-operator-token` + `x-csrf-token` and an `expectedVersion` (the run's
 * projected `lastSequence`) so the command guard's auth/origin/CSRF/stale checks
 * are all satisfied for the local operator — and a stale command surfaces as a
 * 409 the caller can recover from. The browser supplies the `Origin` header
 * automatically; tokens therefore never leave loopback.
 */
import type {
  ReviewDecision,
  ReviewMode,
  RiskTier,
  RunProjection,
  compareRunsNewestFirst,
} from '@software-factory/core';
import type { ExecutionOverview, FloorStatus, InterventionItem, RunAggregate } from './types';
import { parseExecutionOverview } from './execution-overview';
import { parseInterventionQueue } from './intervention-queue';
import type { LocalSession } from './session';

export type { RunAggregate } from './types';

/** Discriminated result so callers can branch on stale/guard failures explicitly. */
export type MutationResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly message?: string;
      /**
       * The full parsed error body (session lifecycle U6). Some refusals are
       * structured contracts, not just messages: new-session's 409 carries
       * `activeRuns`, factory-reset's 400/409 carry `requiredPhrase`,
       * `wouldDestroy`, and `leasedJobs`. Callers parse what they need
       * structurally; absent on an unparseable body.
       */
      readonly details?: Record<string, unknown>;
    };

function mutationHeaders(session: LocalSession): HeadersInit {
  return {
    'content-type': 'application/json',
    'x-operator-token': session.operatorToken,
    'x-csrf-token': session.csrfToken,
  };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Hard cap on a single poll fetch. `startPollLoop` only schedules the next
 * tick after the current one settles, so a server that accepts the socket
 * but never responds would otherwise freeze the loop with stale data and
 * `reconnecting` still false — the frozen-but-pretending UI DESIGN.md §6
 * forbids. Timing out fails the tick honestly instead.
 */
const POLL_FETCH_TIMEOUT_MS = 10_000;

/**
 * Strict JSON read for POLLED endpoints. A 200 with an unparseable body
 * (proxy splash page, truncated response) must FAIL the tick — flipping
 * `reconnecting` and keeping the last good data — never degrade to an
 * empty payload that would replace real data as if the factory were idle.
 * Mutations keep the lenient `readJson`: their error paths branch on
 * status, not body shape.
 */
async function readPolledJson(res: Response, what: string): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`${what}_parse_failed`);
  }
}

async function mutate<T>(
  url: string,
  session: LocalSession,
  body: Record<string, unknown>,
): Promise<MutationResult<T>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: mutationHeaders(session),
    body: JSON.stringify(body),
  });
  const json = await readJson(res);
  if (res.ok) {
    return { ok: true, status: res.status, data: json as T };
  }
  return {
    ok: false,
    status: res.status,
    error: typeof json.error === 'string' ? json.error : 'request_failed',
    message: typeof json.message === 'string' ? json.message : undefined,
    details: json,
  };
}

export interface StartRunInput {
  readonly prompt?: string;
  readonly prdRef?: string;
  readonly prdText?: string;
  readonly title?: string;
  readonly localFolder?: string;
  readonly githubRepo?: string;
  readonly selectedAdapter?: string;
  readonly modelProfile?: string;
  readonly reasoningEffort?: string;
  readonly requestedWorkerCap?: number;
  readonly reviewMode?: ReviewMode;
}

export interface StartRunResult {
  readonly runId: string;
  readonly run: RunProjection;
}

export function startRun(
  session: LocalSession,
  input: StartRunInput,
): Promise<MutationResult<StartRunResult>> {
  return mutate<StartRunResult>('/api/runs', session, { ...input });
}

/**
 * Cancel response (session lifecycle U6/AE5): `run` is the FRESH projected
 * run — its `lastSequence` is the exact `expectedVersion` for an immediate
 * archive offer, and `archived` reports whether the optional `archive: true`
 * half already ran, so the offer never renders for an already-archived run.
 */
export interface CancelRunResult {
  readonly runId: string;
  readonly run: RunProjection;
  readonly archived?: boolean;
  readonly alreadyCancelled?: boolean;
  readonly alreadyArchived?: boolean;
}

export function cancelRun(
  session: LocalSession,
  runId: string,
  expectedVersion: number,
  reason?: string,
): Promise<MutationResult<CancelRunResult>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/cancel`, session, {
    expectedVersion,
    reason,
  });
}

export interface SubmitReviewInput {
  readonly decision: ReviewDecision;
  readonly riskTier: RiskTier;
  readonly expectedVersion: number;
  readonly rationale?: string;
  readonly mode?: ReviewMode;
}

/**
 * Stage-resume outcome attached to an approved review (typed mirror of the
 * server's `StageResumeResult`): which blocked stage the approval resumed,
 * which interventions it resolved, and whether the stage's job was re-queued.
 */
export interface ReviewResumeResult {
  readonly stage: 'gates' | 'execution';
  readonly resolvedInterventions: readonly string[];
  readonly queued: boolean;
  /** True when the re-queued job waits behind the factory drain gate. */
  readonly held?: boolean;
  readonly note?: string;
}

export interface SubmitReviewResult {
  readonly decision: ReviewDecision;
  readonly riskTier: RiskTier;
  readonly requiredApprovals: number;
  readonly run: RunProjection;
  /** `null` unless an approval resumed a blocked stage (server-computed). */
  readonly resumed?: ReviewResumeResult | null;
}

export function submitReview(
  session: LocalSession,
  runId: string,
  input: SubmitReviewInput,
): Promise<MutationResult<SubmitReviewResult>> {
  return mutate<SubmitReviewResult>(`/api/runs/${encodeURIComponent(runId)}/review`, session, {
    ...input,
  });
}

/* ----------------------------------------------------------------------------
 * Execution controls (U5 command surface; U9 operator UI)
 *
 * These commands are idempotent and state-checked SERVER-side (duplicate
 * starts converge on the existing queue job; pause/resume validate the
 * projected execution state), so they deliberately omit `expectedVersion` —
 * on a live run every worker event bumps the version and a stale check would
 * reject nearly every honest click. Cancel keeps its version check because it
 * is destructive.
 * ------------------------------------------------------------------------- */

/** Response shape shared by the execution command routes. */
export interface ExecutionCommandResult {
  readonly runId?: string;
  readonly queued?: boolean;
  readonly alreadyQueued?: boolean;
  /** True when the enqueue landed while the factory drain gate is engaged. */
  readonly held?: boolean;
  readonly paused?: boolean;
  readonly alreadyPaused?: boolean;
  readonly resumed?: boolean;
  readonly execution?: { readonly state: string; readonly reason?: string };
  readonly run?: RunProjection;
}

export function startExecution(
  session: LocalSession,
  runId: string,
  reason?: string,
): Promise<MutationResult<ExecutionCommandResult>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/start`, session, { reason });
}

export function pauseExecution(
  session: LocalSession,
  runId: string,
  reason?: string,
): Promise<MutationResult<ExecutionCommandResult>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/pause`, session, { reason });
}

export function resumeExecution(
  session: LocalSession,
  runId: string,
  reason?: string,
): Promise<MutationResult<ExecutionCommandResult>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/resume`, session, { reason });
}

export function retryExecution(
  session: LocalSession,
  runId: string,
  options: { readonly reason?: string; readonly ticketId?: string } = {},
): Promise<MutationResult<ExecutionCommandResult>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/retry`, session, { ...options });
}

export function rerunGates(
  session: LocalSession,
  runId: string,
  reason?: string,
): Promise<MutationResult<ExecutionCommandResult>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/gates/rerun`, session, { reason });
}

/* ----------------------------------------------------------------------------
 * Factory-wide execution controls (drain gate + cancel-all)
 *
 * The daemon boots HELD: nothing runs automatically when the factory opens.
 * Resume releases the gate for this server process; hold re-engages it; and
 * cancel-all cancels every cancellable run in one guarded command.
 * ------------------------------------------------------------------------- */

/** Poll the factory-wide execution state (read-only, no token). */
export async function fetchExecutionOverview(): Promise<ExecutionOverview> {
  const res = await fetch('/api/execution', {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`execution_fetch_failed:${res.status}`);
  }
  return parseExecutionOverview(await readPolledJson(res, 'execution'));
}

/** Release the drain gate so queued work starts (POST /api/execution/resume). */
export function resumeFactoryExecution(session: LocalSession): Promise<
  MutationResult<{
    resumed?: boolean;
    alreadyActive?: boolean;
    held?: boolean;
    /** False means the gate released but the daemon loop is NOT draining. */
    running?: boolean;
  }>
> {
  return mutate('/api/execution/resume', session, {});
}

/** Re-engage the drain gate: stop starting new work (POST /api/execution/hold). */
export function holdFactoryExecution(
  session: LocalSession,
): Promise<MutationResult<{ held?: boolean; alreadyHeld?: boolean; running?: boolean }>> {
  return mutate('/api/execution/hold', session, {});
}

/** Outcome lists from the guarded cancel-all command. */
export interface CancelAllRunsResult {
  readonly cancelled: readonly string[];
  readonly alreadyCancelled: readonly string[];
  readonly skippedTerminal: readonly string[];
  readonly cancelledCount: number;
  /** Per-run failures, present only when part of the batch could not cancel. */
  readonly errors?: readonly { readonly runId: string; readonly message: string }[];
}

/** Cancel every cancellable run (POST /api/runs/cancel-all). */
export function cancelAllRuns(
  session: LocalSession,
  reason?: string,
): Promise<MutationResult<CancelAllRunsResult>> {
  return mutate('/api/runs/cancel-all', session, { reason });
}

/* ----------------------------------------------------------------------------
 * Session lifecycle (U6): archive/unarchive, New Session, Factory Reset
 *
 * Archive is a visibility lifecycle, never a storage one (R7): archived runs
 * stay on disk, searchable, and replayable. Every wrapper here is guarded
 * (token + CSRF) and NEVER optimistic — callers confirm from the next poll.
 * ------------------------------------------------------------------------- */

/** Archive/unarchive response: convergence flags + the fresh projected run. */
export interface ArchiveRunResult {
  readonly runId: string;
  readonly run: RunProjection;
  /** True when R16 cancelled a non-terminal run inside the same command. */
  readonly cancelled?: boolean;
  readonly alreadyArchived?: boolean;
  readonly alreadyVisible?: boolean;
}

/** Archive one run (POST /api/runs/:id/archive) — guarded per-run + version. */
export function archiveRun(
  session: LocalSession,
  runId: string,
  expectedVersion: number,
  reason?: string,
): Promise<MutationResult<ArchiveRunResult>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/archive`, session, {
    expectedVersion,
    reason,
  });
}

/** Restore a run to the default view (POST /api/runs/:id/unarchive) — R13:
 *  visibility only; a cancelled run stays cancelled. */
export function unarchiveRun(
  session: LocalSession,
  runId: string,
  expectedVersion: number,
  reason?: string,
): Promise<MutationResult<ArchiveRunResult>> {
  return mutate(`/api/runs/${encodeURIComponent(runId)}/unarchive`, session, {
    expectedVersion,
    reason,
  });
}

/** New Session 200 body: what actually archived/cancelled; the gate is held. */
export interface NewSessionResult {
  readonly archived: readonly string[];
  readonly cancelled: readonly string[];
  readonly held: boolean;
  readonly errors?: readonly { readonly runId: string; readonly message: string }[];
}

/** One active run from the New Session 409 ask-once refusal. */
export interface NewSessionActiveRun {
  readonly runId: string;
  readonly title?: string;
  readonly status: string;
  readonly executionState: string;
}

/**
 * Open a new session (POST /api/execution/new-session): hold the gate, cancel
 * actives, clear the queue, archive every visible run, record the marker —
 * atomically server-side. Without `confirmActive` the server answers 409
 * `active_runs_present` when active runs exist (ask-once, AE1); the caller
 * re-sends with `confirmActive: true` only after explicit user confirmation.
 * The 409's `activeRuns` list arrives on the failure branch's `details`.
 */
export function startNewSession(
  session: LocalSession,
  options: { readonly confirmActive?: boolean; readonly reason?: string } = {},
): Promise<MutationResult<NewSessionResult>> {
  return mutate('/api/execution/new-session', session, { ...options });
}

/** What a factory reset would destroy (pre-flight) or destroyed (success). */
export interface FactoryResetEnumeration {
  readonly runCount: number;
  readonly archivedRunCount: number;
  readonly eventCount: number;
  readonly paths: readonly string[];
  readonly workspacePaths: readonly string[];
  readonly resetGeneration: number;
}

export interface FactoryResetResult {
  readonly reset: boolean;
  readonly resetGeneration: number;
  readonly held: boolean;
  readonly destroyed: FactoryResetEnumeration;
}

/**
 * Factory reset (POST /api/execution/factory-reset) — destructive; the server
 * requires the exact typed phrase in `confirm` and answers a mismatch with 400
 * `confirmation_mismatch` carrying `requiredPhrase` + the `wouldDestroy`
 * enumeration, NOTHING deleted. The UI's pre-flight deliberately sends an
 * empty `confirm` and renders that 400's enumeration — no extra read endpoint
 * exists, and the mismatch path is contractually non-destructive (AE3).
 */
export function factoryReset(
  session: LocalSession,
  confirm: string,
): Promise<MutationResult<FactoryResetResult>> {
  return mutate('/api/execution/factory-reset', session, { confirm });
}

/* ----------------------------------------------------------------------------
 * Operator intervention queue (X4)
 * ------------------------------------------------------------------------- */

/**
 * Poll the combined floor status (read-only, no token): the execution
 * overview and the intervention queue in ONE request. The body is the exact
 * union of GET /api/execution and GET /api/interventions, so each half goes
 * through the same structural parser as its standalone endpoint.
 */
export async function fetchFloorStatus(): Promise<FloorStatus> {
  const res = await fetch('/api/floor', {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`floor_fetch_failed:${res.status}`);
  }
  const body = await readPolledJson(res, 'floor');
  return {
    overview: parseExecutionOverview(body),
    interventionQueue: parseInterventionQueue(body),
  };
}

export function resolveInterventionItem(
  session: LocalSession,
  interventionId: string,
  input: { readonly resolution: string; readonly note?: string },
): Promise<MutationResult<{ alreadyResolved: boolean; intervention: InterventionItem }>> {
  return mutate(`/api/interventions/${encodeURIComponent(interventionId)}/resolve`, session, {
    ...input,
  });
}

/**
 * Row-level structural check for one wire run projection (session lifecycle
 * U5). The list poll only needs the identity/status/recency fields the strip
 * and board render; a malformed row drops instead of rendering `undefined`.
 */
function isRunListRow(value: unknown): value is RunProjection {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.runId === 'string' &&
    typeof row.status === 'string' &&
    typeof row.lastSequence === 'number'
  );
}

/**
 * Fetch the run list (read-only, no token) — the live feed behind the run
 * strip and run board (R14), and (with `includeArchived`) the one-shot fetch
 * behind the RunBoard history view (U6/AE2). By DEFAULT archived rows are
 * re-filtered client-side (defense-in-depth — the default route already
 * excludes them, R7); the shared poller stays visible-only, and the history
 * host opts in per fetch. A missing/non-array `runs` key FAILS the tick
 * (reconnecting, last good data kept) rather than degrading to an empty
 * list: an empty list is a real state ("floor is empty") that drives focus
 * changes, so it must never be synthesized from a malformed body. Sorted
 * newest-first exactly like the SSR `loadRunList`, so "newest visible run"
 * means the same thing on every tick.
 */
export async function fetchRunList(
  options: { readonly includeArchived?: boolean } = {},
): Promise<readonly RunProjection[]> {
  const includeArchived = options.includeArchived === true;
  const res = await fetch(includeArchived ? '/api/runs?includeArchived=1' : '/api/runs', {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`runs_fetch_failed:${res.status}`);
  }
  const body = await readPolledJson(res, 'runs');
  if (!Array.isArray(body.runs)) {
    throw new Error('runs_parse_failed');
  }
  return body.runs
    .filter(isRunListRow)
    .filter((row) => includeArchived || row.archived !== true)
    .sort(compareNewestFirst);
}

/**
 * Newest-first ordering, TYPE-pinned to core's `compareRunsNewestFirst`. The
 * browser bundle must never VALUE-import `@software-factory/core` (its barrel
 * pulls node:fs/child_process), so the comparator body lives here while the
 * erased `import type` keeps the signature locked to the single core
 * definition the SSR `loadRunList` sorts with — a core signature drift fails
 * this file's compile.
 */
const compareNewestFirst: typeof compareRunsNewestFirst = (a, b) =>
  (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.lastSequence - a.lastSequence;

/** Poll the projected run view, resuming the ledger from `afterSequence`. */
export async function fetchAggregate(runId: string, afterSequence: number): Promise<RunAggregate> {
  const res = await fetch(
    `/data/runs/${encodeURIComponent(runId)}?after=${encodeURIComponent(String(afterSequence))}`,
    {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    throw new Error(`run_fetch_failed:${res.status}`);
  }
  return (await readPolledJson(res, 'run')) as unknown as RunAggregate;
}
