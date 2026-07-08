/**
 * Scheduler-backed TicketExecutor (full-factory U6).
 *
 * This is the real implementation of the U5 executor seam: it turns ONE
 * claimed `run-execution` queue job into an adaptive-scheduler run over the
 * run's projected ticket DAG. It is invoked ONLY by the execution daemon after
 * queue lease acquisition (KTD3/E1) — API/MCP/CLI handlers never run tickets.
 *
 * Per claimed job the executor:
 *   1. replays the run/ticket/workspace projections from the ledger (never
 *      invents state),
 *   2. fails closed on policy blocks (KTD6: a plan that requires human triage
 *      stays blocked in human AND autonomous modes — review mode changes
 *      nothing outside policy),
 *   3. selects the adapter from run settings + setup detection
 *      (`selectExecutionAdapter`); adapter setup/auth failures stop before any
 *      execution with `adapter.setup_required` / `adapter.auth_failed` events,
 *   4. resolves the workspace: the materialized workspace when the run
 *      requested a source, else a fresh generated workspace directory,
 *   5. compiles the projected ticket DAG into scheduler nodes (workspace dir,
 *      compile inputs, risk tiers, expected outputs, derived write scopes) via
 *      `compileExecutionNodes`, pre-settling tickets already completed on a
 *      previous attempt so duplicate claims/requeues NEVER re-run them,
 *   6. runs the adaptive scheduler with the daemon's abort signal (cancel /
 *      graceful shutdown) and pause hook (`shouldContinue`), heartbeating the
 *      queue lease as ledger writes flow, and
 *   7. maps the scheduler outcome onto the executor contract: completed /
 *      failed (retryable, with per-ticket reasons) / blocked (with an
 *      intervention classification) / yielded (pause or shutdown -> requeue).
 *
 * Gate wiring is U7 (gate-rerun jobs stay honestly blocked); packaging/deploy
 * orchestration is U8 (their tickets execute as ordinary adapter tasks here).
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  compileExecutionNodes,
  createDefaultAdapterCatalog,
  loadModuleRegistry,
  parseRunRequest,
  projectRun,
  projectTickets,
  selectExecutionAdapter,
} from '@software-factory/core';
import type {
  AdapterCatalog,
  AdapterSelection,
  AppendResult,
  AppendableEvent,
  EventStore,
  ExecutionSchedulePlan,
  ModuleRegistry,
  RunProjection,
  TicketProjection,
} from '@software-factory/core';
import { projectWorkspace, runScheduler } from '@software-factory/worker';
import type { SchedulerResult, WorkspaceProjection } from '@software-factory/worker';
import type {
  TicketExecutionContext,
  TicketExecutionResult,
  TicketExecutor,
} from './daemon';
import { resolveGenomeDir } from '../planner';
import { DEFAULT_EXECUTION_RUNTIME_CONFIG, resolveWorkspaceRuntimeConfig } from '../runtime';
import type { RuntimeConfig } from '../runtime';

/** Default worker cap when the run recorded no `requestedWorkerCap`. */
export const DEFAULT_EXECUTION_WORKER_CAP = 4;

/** Default queue-lease heartbeat cadence while the scheduler is running (ms). */
const DEFAULT_HEARTBEAT_INTERVAL_MS = DEFAULT_EXECUTION_RUNTIME_CONFIG.heartbeatMs;

export interface SchedulerTicketExecutorOptions {
  /** Runtime config (workspace checkout root, execution heartbeat cadence). */
  readonly runtime?: RuntimeConfig;
  /** Adapter catalog. Defaults to the real default catalog (Codex/Claude/API). */
  readonly adapters?: AdapterCatalog;
  /** Genome module registry. Defaults to a lazy load from `genomeDir`. */
  readonly moduleRegistry?: ModuleRegistry;
  /** Genome directory for the default registry load. */
  readonly genomeDir?: string;
  /** Root directory fresh generated workspaces are created under. */
  readonly freshWorkspaceRoot?: string;
  /** Directory creation (injectable for tests). Default: `mkdir -p`. */
  readonly ensureWorkspaceDir?: (path: string) => Promise<void>;
  /** Clock for deterministic event timestamps + heartbeat throttling. */
  readonly clock?: () => number;
  /** Bounded per-ticket retry budget forwarded to the worker runner. */
  readonly ticketMaxAttempts?: number;
  /** Soft per-ticket timeout (ms) forwarded to the adapter. */
  readonly ticketTimeoutMs?: number;
  /** Queue-lease heartbeat throttle (ms). Defaults to the runtime cadence. */
  readonly heartbeatIntervalMs?: number;
}

function blocked(
  reason: string,
  requiredAction: string,
  interventionKind: TicketExecutionResult['interventionKind'],
): TicketExecutionResult {
  return { status: 'blocked', reason, requiredAction, interventionKind };
}

async function defaultEnsureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Wrap a store so queue-lease heartbeats ride along with ledger writes: every
 * append the scheduler/workers make extends the lease at most once per
 * `intervalMs`. Deterministic under an injected clock (no timers).
 */
function withLeaseHeartbeat(
  store: EventStore,
  heartbeat: () => Promise<void>,
  clock: () => number,
  intervalMs: number,
): EventStore {
  let lastHeartbeatAt = clock();
  return {
    async append(event: AppendableEvent): Promise<AppendResult> {
      const result = await store.append(event);
      const now = clock();
      if (now - lastHeartbeatAt >= intervalMs) {
        lastHeartbeatAt = now;
        await heartbeat();
      }
      return result;
    },
    readRun: (runId) => store.readRun(runId),
    readAll: () => store.readAll(),
    listRuns: () => store.listRuns(),
  };
}

/** Record an unresolvable adapter selection as an explicit setup event. */
async function recordAdapterSelectionFailure(
  ctx: TicketExecutionContext,
  selection: AdapterSelection,
  clock?: () => number,
): Promise<void> {
  const adapterId = selection.adapter?.id ?? 'unselected';
  await ctx.store.append({
    runId: ctx.runId,
    type: 'adapter.setup_required',
    actor: { kind: 'adapter', id: adapterId },
    subject: { kind: 'adapter', id: adapterId },
    severity: 'warn',
    timestamp: clock?.(),
    idempotencyKey: `${ctx.jobId}:adapter.selection:${ctx.attempt}`,
    payload: {
      action:
        selection.requiredAction ?? 'Configure an execution adapter on this instance.',
      reason: selection.reason,
    },
  });
}

/**
 * Build the scheduler-backed executor. Wire it into the daemon via
 * `createExecutionDaemon({ executor })` from each server entry point.
 */
export function createSchedulerTicketExecutor(
  options: SchedulerTicketExecutorOptions = {},
): TicketExecutor {
  const catalog = options.adapters ?? createDefaultAdapterCatalog();
  const workspaceConfig = options.runtime?.workspace ?? resolveWorkspaceRuntimeConfig();
  const freshWorkspaceRoot = options.freshWorkspaceRoot ?? workspaceConfig.checkoutRoot;
  const ensureWorkspaceDir = options.ensureWorkspaceDir ?? defaultEnsureDir;
  const clock = options.clock;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ??
    options.runtime?.execution.heartbeatMs ??
    DEFAULT_HEARTBEAT_INTERVAL_MS;

  // Lazy, cached genome registry load (mirrors createGenomePlanner): a failed
  // load clears the cache so a later attempt can retry after setup changes.
  let registryPromise: Promise<ModuleRegistry> | undefined;
  const loadRegistry = (): Promise<ModuleRegistry> => {
    if (options.moduleRegistry !== undefined) {
      return Promise.resolve(options.moduleRegistry);
    }
    if (registryPromise === undefined) {
      const genomeDir = options.genomeDir ?? resolveGenomeDir();
      registryPromise = loadModuleRegistry(genomeDir).then((loaded) => loaded.registry);
      registryPromise.catch(() => {
        registryPromise = undefined;
      });
    }
    return registryPromise;
  };

  return async (ctx: TicketExecutionContext): Promise<TicketExecutionResult> => {
    if (ctx.jobKind !== 'run-execution') {
      // Gate re-runs are U7; block honestly instead of pretending to re-gate.
      return blocked(
        'Gate re-run execution is not available yet (planned unit U7).',
        'Wait for the gate/repair-loop integration (U7); the queued gate re-run stays recorded and can be retried once it lands.',
        'retry_choice',
      );
    }

    const events = await ctx.store.readRun(ctx.runId);
    const run: RunProjection = projectRun(events, ctx.runId);
    const tickets: TicketProjection = projectTickets(events, ctx.runId);
    const workspace: WorkspaceProjection = projectWorkspace(events, ctx.runId);

    if (tickets.tickets.length === 0) {
      return blocked(
        'The run has no planned tickets, so there is nothing to execute.',
        'Re-create or re-plan the run so a ticket DAG exists, then start again.',
        'approval',
      );
    }

    // KTD6: policy-blocked actions stay blocked in human AND autonomous modes.
    // A triage plan means the request needs human clarification before any
    // build execution; autonomous mode cannot bypass this policy block.
    if (tickets.byId['triage'] !== undefined) {
      return blocked(
        `The plan requires human triage before any build execution (review mode "${
          run.reviewMode ?? 'human'
        }" does not bypass policy).`,
        'Complete triage for this run (clarify the request scope), re-plan, and start again.',
        'policy_block',
      );
    }

    // Adapter selection from run settings + setup detection.
    const selection = await selectExecutionAdapter(catalog, run.selectedAdapter, {
      signal: ctx.signal,
    });
    if (selection.adapter === undefined) {
      await recordAdapterSelectionFailure(ctx, selection, clock);
      return blocked(
        selection.reason ?? 'No execution adapter could be selected.',
        selection.requiredAction ?? 'Configure an execution adapter, then retry.',
        'adapter_setup',
      );
    }
    const adapter = selection.adapter;

    // Workspace resolution: materialized workspace for source-backed runs,
    // fresh generated workspace for prompt/PRD-only runs. Source-backed runs
    // whose workspace is not ready fail closed (preflight normally catches
    // this; a stale/duplicate enqueue must not bypass it).
    const wantsSource =
      (run.localFolder !== undefined && run.localFolder.length > 0) ||
      (run.githubRepo !== undefined && run.githubRepo.length > 0);
    let workspaceDir: string;
    if (workspace.status === 'ready' && workspace.workspace !== undefined) {
      workspaceDir =
        workspace.workspace.kind === 'local_folder'
          ? workspace.workspace.path
          : workspace.workspace.checkoutPath;
    } else if (wantsSource) {
      return blocked(
        `The requested source workspace is not ready (status "${workspace.status}"${
          workspace.unavailableReason !== undefined
            ? `: ${workspace.unavailableReason}`
            : workspace.failureReason !== undefined
              ? `: ${workspace.failureReason}`
              : ''
        }).`,
        workspace.requiredAction ??
          'Materialize the workspace (POST /api/runs/:id/workspace), then retry execution.',
        'source_choice',
      );
    } else {
      workspaceDir = join(freshWorkspaceRoot, ctx.runId);
      await ensureWorkspaceDir(workspaceDir);
    }

    // Compile the projected ticket DAG into scheduler nodes.
    const registry = await loadRegistry();
    const runRequest = parseRunRequest({
      prompt: run.prompt,
      prdRef: run.prdRef,
      prdText: run.prdText,
      title: run.title,
      requestedWorkerCap: run.requestedWorkerCap,
      reviewMode: run.reviewMode,
      mode: run.mode,
    });
    const plan: ExecutionSchedulePlan = compileExecutionNodes({
      runRequest,
      tickets: tickets.tickets,
      modules: registry,
      workspaceDir,
    });

    const emitRunCompleted = async (summary: string): Promise<void> => {
      await ctx.store.append({
        runId: ctx.runId,
        type: 'run.completed',
        actor: { kind: 'system', id: 'ticket-executor' },
        subject: { kind: 'run', id: ctx.runId },
        severity: 'success',
        timestamp: clock?.(),
        idempotencyKey: `${ctx.runId}:run.completed`,
        payload: { summary },
      });
    };

    if (plan.completed.length === plan.nodes.length) {
      const summary = `All ${plan.nodes.length} ticket(s) were already completed on a previous attempt.`;
      await emitRunCompleted(summary);
      return { status: 'completed', summary };
    }

    // Extend the lease before the (potentially long) scheduler run, then let
    // heartbeats ride along with ledger writes.
    await ctx.heartbeat();
    const heartbeatingStore = withLeaseHeartbeat(
      ctx.store,
      () => ctx.heartbeat(),
      clock ?? Date.now,
      heartbeatIntervalMs,
    );

    let result: SchedulerResult;
    try {
      result = await runScheduler({
        runId: ctx.runId,
        tickets: plan.nodes,
        adapter,
        store: heartbeatingStore,
        config: {
          requestedCap: run.requestedWorkerCap ?? DEFAULT_EXECUTION_WORKER_CAP,
          callerFamily: run.callerFamily,
          maxAttempts: options.ticketMaxAttempts,
          timeoutMs: options.ticketTimeoutMs,
          clock,
        },
        completed: plan.completed,
        cancellation: ctx.signal,
        shouldContinue: () => ctx.shouldContinue(),
      });
    } catch (error) {
      // buildTicketDag (invalid planned dependencies) or an infrastructure
      // error. Fail closed with an explainable reason; the ledger already
      // carries any worker events that were written.
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.signal.aborted) {
        return { status: 'yielded', reason: `Execution aborted: ${message}` };
      }
      return { status: 'failed', reason: `Ticket execution failed: ${message}` };
    }

    if (result.setupFailed) {
      const detail = selection.setup?.detail;
      return blocked(
        `Adapter "${adapter.id}" (${adapter.family}) failed its setup/auth probe${
          detail !== undefined ? `: ${detail}` : ''
        }; no ticket execution ran.`,
        'Complete the adapter setup actions recorded on the ledger (adapter.setup_required), then retry execution.',
        'adapter_setup',
      );
    }
    if (result.cancelledRun) {
      // Abort signal (run cancellation or graceful shutdown): the daemon
      // resolves the fate — cancelled runs release as cancelled, shutdowns
      // requeue this yield for a safe resume.
      return {
        status: 'yielded',
        reason: `Execution aborted with ${result.completed.length}/${plan.nodes.length} ticket(s) completed; in-flight tickets were cancelled safely.`,
      };
    }
    if (result.yielded) {
      return {
        status: 'yielded',
        reason: `Execution paused with ${result.completed.length}/${plan.nodes.length} ticket(s) completed; the remaining work resumes on resume/restart.`,
      };
    }
    if (result.failed.length > 0) {
      // Re-project so failure reasons come from the recorded worker events.
      const after = projectTickets(await ctx.store.readRun(ctx.runId), ctx.runId);
      const failures = result.failed.map((id) => {
        const reason = after.byId[id]?.failureReason;
        return reason !== undefined ? `${id} (${reason})` : id;
      });
      const blockedNote =
        result.unfinished.length > 0
          ? ` ${result.unfinished.length} dependent ticket(s) did not run: ${result.unfinished.join(', ')}.`
          : '';
      return {
        status: 'failed',
        reason: `${result.failed.length} ticket(s) failed: ${failures.join('; ')}.${blockedNote}`,
      };
    }
    if (result.stalled) {
      return blocked(
        'Ready tickets could not start: a capacity constraint (adapter/sandbox/resource/write-scope/review policy) is holding effective capacity at zero.',
        'Inspect the recorded adapter.capacity_changed reason, fix the binding constraint, then retry execution.',
        'adapter_setup',
      );
    }
    if (result.unfinished.length > 0 || result.cancelled.length > 0) {
      // Defensive: tickets neither completed nor failed (e.g. cancelled by a
      // ticket-level token without a run-level abort).
      return {
        status: 'failed',
        reason: `Execution ended with ${result.unfinished.length} unfinished and ${result.cancelled.length} cancelled ticket(s): ${[...result.cancelled, ...result.unfinished].join(', ')}.`,
      };
    }

    const summary = `${result.completed.length}/${plan.nodes.length} ticket(s) completed via adapter "${adapter.id}".`;
    await emitRunCompleted(summary);
    return { status: 'completed', summary };
  };
}
