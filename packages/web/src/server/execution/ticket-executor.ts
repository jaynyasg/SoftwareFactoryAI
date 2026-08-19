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
 *      queue lease as ledger writes flow,
 *   7. runs the quality-gate stages (U7) when a gate config is wired:
 *      post-ticket gates + the bounded, ledger-derived repair loop run inside
 *      the scheduler via the gated ticket runner; the POST-RUN gate stage runs
 *      after every ticket completed and must pass before `run.completed` is
 *      emitted (idempotent key `<runId>:run.completed`, so replays and
 *      duplicate attempts converge). Gate failures BLOCK with evidence, raise
 *      a `retry_choice` intervention, and request a stage review
 *      (`review.requested` with `stage: gates|execution`) that a human
 *      approval can resume. Repair-budget exhaustion escalates the same way
 *      instead of looping. Gate-rerun queue jobs re-run the post-run stage for
 *      real, and
 *   8. maps the scheduler outcome onto the executor contract: completed /
 *      failed (retryable, with per-ticket reasons) / blocked (with an
 *      intervention classification) / yielded (pause or shutdown -> requeue).
 *
 * U8 COMPLETION STAGE: packaging, provenance, preview health, and deploy
 * triggering run AFTER the post-run gate stage passes and BEFORE
 * `run.completed` is emitted (see `completion-stage.ts`). Packaging is
 * idempotent per run (replay/retry never re-packages); deploy pauses and
 * failures record retryable deploy state + interventions WITHOUT failing the
 * locally-successful run (R30); the hosted URL appears only after provider
 * success and hosted health pass (R29). Only a packaging error fails the
 * attempt (retryable).
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
  EventEvidence,
  EventStore,
  ExecutionSchedulePlan,
  ModuleRegistry,
  RunProjection,
  TicketProjection,
} from '@software-factory/core';
import {
  createGatedTicketRunner,
  projectGateRepair,
  projectWorkspace,
  runGates,
  runScheduler,
} from '@software-factory/worker';
import type {
  GateFailureContext,
  SchedulerResult,
  TicketRunner,
  WorkspaceProjection,
} from '@software-factory/worker';
import type { ExecutorGateStages } from './gate-stages';
import type { ExecutorCompletionStage } from './completion-stage';
import type { TicketExecutionContext, TicketExecutionResult, TicketExecutor } from './daemon';
import { filterInterventions, projectInterventions, resolveIntervention } from './interventions';
import { highestTicketRisk } from '../../lib/run-view';
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
  /**
   * Quality-gate stage config (U7). When wired (the server entry points pass
   * `createRuntimeGateStages`), post-ticket gates + the bounded repair loop
   * run inside the scheduler and the post-run gate stage must pass before
   * `run.completed`. Omitted = no gate stages (deterministic unit tests and
   * pre-U7 behavior); gate-rerun jobs then block honestly.
   */
  readonly gateStages?: ExecutorGateStages;
  /**
   * Run completion stage (U8). When wired (the server entry points pass
   * `createRuntimeCompletionStage`), preview/package/provenance/deploy run
   * after the post-run gate stage passes and before `run.completed` is
   * emitted. Omitted = no completion stage (deterministic unit tests and
   * pre-U8 behavior).
   */
  readonly completionStage?: ExecutorCompletionStage;
}

function blocked(
  reason: string,
  requiredAction: string,
  interventionKind: TicketExecutionResult['interventionKind'],
  blockingStage?: string,
): TicketExecutionResult {
  return { status: 'blocked', reason, requiredAction, interventionKind, blockingStage };
}

/** Map structured gate evidence onto ledger event evidence. */
function gateFailureEvidence(failure: GateFailureContext | undefined): EventEvidence[] | undefined {
  if (failure === undefined) {
    return undefined;
  }
  return failure.evidence.map((item) => ({
    label: item.label,
    ref: item.command ?? item.ref,
    note: item.outputExcerpt ?? item.detail,
  }));
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
    deleteRuns: (runIds) => store.deleteRuns(runIds),
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
      action: selection.requiredAction ?? 'Configure an execution adapter on this instance.',
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
  const gateStages = options.gateStages;
  const completionStage = options.completionStage;
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

    // KTD6: policy-blocked actions stay blocked in human AND autonomous modes
    // and for EVERY job kind (a review approval or gate re-run cannot bypass
    // policy either). A triage plan means the request needs human
    // clarification before any build execution.
    if (tickets.byId['triage'] !== undefined) {
      return blocked(
        `The plan requires human triage before any build execution (review mode "${
          run.reviewMode ?? 'human'
        }" does not bypass policy).`,
        'Complete triage for this run (clarify the request scope), re-plan, and start again.',
        'policy_block',
      );
    }

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

    // Extend the lease before any long stage, then let heartbeats ride along
    // with ledger writes (scheduler AND gate stages).
    await ctx.heartbeat();
    const heartbeatingStore = withLeaseHeartbeat(
      ctx.store,
      () => ctx.heartbeat(),
      clock ?? Date.now,
      heartbeatIntervalMs,
    );

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

    /**
     * Request a stage review a human approval can resume (U7). Idempotent per
     * job attempt, so replays and duplicate blocked reports converge.
     */
    const emitStageReview = async (
      stage: 'gates' | 'execution',
      summary: string,
      evidence: EventEvidence[] | undefined,
    ): Promise<void> => {
      await ctx.store.append({
        runId: ctx.runId,
        type: 'review.requested',
        actor: { kind: 'gate', id: 'gate-stage', display: 'gate-stage' },
        subject: { kind: 'run', id: ctx.runId },
        severity: 'warn',
        timestamp: clock?.(),
        idempotencyKey: `${ctx.jobId}:review.requested:${ctx.attempt}`,
        evidence,
        payload: { riskTier: highestTicketRisk(tickets.tickets) ?? 'low', summary, stage },
      });
    };

    /**
     * Run the POST-RUN gate stage. Resolves `null` when the stage passed (or
     * no gates are configured for the run); otherwise resolves the blocked (or
     * yielded, on abort) executor result — with the stage review requested and
     * the gate evidence already on the ledger.
     */
    const runPostRunStage = async (): Promise<TicketExecutionResult | null> => {
      if (gateStages === undefined) {
        return null;
      }
      const currentRun = projectRun(await ctx.store.readRun(ctx.runId), ctx.runId);
      const stageCtx = { runId: ctx.runId, workspaceDir, run: currentRun, signal: ctx.signal };
      const gates = await gateStages.postRun(stageCtx);
      if (gates.length === 0) {
        return null;
      }
      const gateContext = await gateStages.context(stageCtx);
      const stage = await runGates(
        {
          runId: ctx.runId,
          gates,
          context: gateContext,
          maxAttemptsPerGate: gateStages.maxAttemptsPerGate,
          stage: 'post_run',
          clock,
        },
        { store: heartbeatingStore },
      );
      if (stage.passed) {
        // A PASSED post-run stage resolves the open gates-stage interventions
        // (mirrors the deploy-success resolution in completion-stage.ts):
        // a successful gate re-run or execution retry must not leave stale
        // "gates blocked" entries in the operator queue.
        const openGates = filterInterventions(
          projectInterventions(await ctx.store.readRun(ctx.runId)),
          { runId: ctx.runId, blockingStage: 'gates', openOnly: true },
        );
        for (const intervention of openGates) {
          await resolveIntervention(ctx.store, intervention, {
            resolution: 'gates_passed',
            note: 'The post-run gate stage passed on re-run.',
          });
        }
        return null;
      }
      if (ctx.signal.aborted) {
        // Cancellation/shutdown raced the gate stage: yield instead of
        // recording a misleading gate block.
        return {
          status: 'yielded',
          reason: 'Execution aborted while the post-run gate stage was running.',
        };
      }
      const failure = stage.failure;
      const reason = `Post-run gate "${failure?.gate ?? 'gate'}" failed: ${
        failure?.reason ?? 'the gate stage did not pass'
      }`;
      await emitStageReview('gates', reason, gateFailureEvidence(failure));
      return blocked(
        reason,
        'Read the recorded gate evidence, fix the cause, then re-run gates (POST /api/runs/:id/gates/rerun) or approve the pending stage review to re-run them.',
        'retry_choice',
        'gates',
      );
    };

    /**
     * Run the U8 completion stage (preview -> package/provenance -> deploy)
     * after post-run gates pass and before `run.completed`. Resolves the
     * summary notes on success; otherwise the failed/yielded executor result.
     * A missing stage is a no-op (pre-U8 behavior; unit tests without wiring).
     */
    const runCompletionStage = async (): Promise<
      { readonly notes: readonly string[] } | TicketExecutionResult
    > => {
      if (completionStage === undefined) {
        return { notes: [] };
      }
      const completion = await completionStage.run({
        runId: ctx.runId,
        workspaceDir,
        store: heartbeatingStore,
        signal: ctx.signal,
      });
      if (completion.status === 'ok') {
        return { notes: completion.notes };
      }
      if (completion.status === 'yielded') {
        return { status: 'yielded', reason: completion.reason };
      }
      return { status: 'failed', reason: completion.reason };
    };

    /** Join the run summary with the completion-stage notes. */
    const withNotes = (summary: string, notes: readonly string[]): string =>
      notes.length > 0 ? `${summary} ${notes.join(' ')}` : summary;

    /**
     * Finish a run whose tickets and post-run gates all passed: run the U8
     * completion stage, join its notes into the summary, emit `run.completed`
     * (idempotent), and resolve the completed executor result. A failed or
     * yielded completion stage resolves that result instead.
     */
    const finishRun = async (baseSummary: string): Promise<TicketExecutionResult> => {
      const completion = await runCompletionStage();
      if (!('notes' in completion)) {
        return completion;
      }
      // A cancellation (or graceful shutdown) that landed while the post-run
      // gate/completion stages were running wins: yield instead of recording
      // a `run.completed` that would race the terminal `run.cancelled`.
      if (ctx.signal.aborted) {
        return {
          status: 'yielded',
          reason: 'Execution aborted after the post-run stages, before run completion.',
        };
      }
      const summary = withNotes(baseSummary, completion.notes);
      await emitRunCompleted(summary);
      return { status: 'completed', summary };
    };

    /* ------------------------------------------------------------------
     * Gate re-run jobs (U7): re-run the post-run gate stage for REAL.
     * ---------------------------------------------------------------- */
    if (ctx.jobKind === 'gate-rerun') {
      if (gateStages === undefined) {
        return blocked(
          'Gate stages are not configured on this server instance, so gates cannot be re-run.',
          'Enable the gate-stage wiring (createRuntimeGateStages) on this instance, then re-run gates.',
          'retry_choice',
          'gates',
        );
      }
      const stageResult = await runPostRunStage();
      if (stageResult !== null) {
        return stageResult;
      }
      // Gates passed (or the run expects none): the run counts as complete
      // only when every planned ticket is also complete.
      const after = projectTickets(await ctx.store.readRun(ctx.runId), ctx.runId);
      const allDone = after.tickets.every((ticket) => ticket.state === 'completed');
      if (allDone) {
        // U8: gates finally passed — the completion stage (package/provenance/
        // deploy) still runs before run.completed, idempotently.
        return finishRun(
          `Post-run gates passed on re-run; all ${after.tickets.length} ticket(s) complete.`,
        );
      }
      return {
        status: 'completed',
        summary:
          'Post-run gates passed on re-run, but not every ticket is complete; retry execution to finish the remaining tickets.',
      };
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

    // Compile the projected ticket DAG into scheduler nodes. Prior gate
    // failures recorded on the ledger feed each ticket's compile input, so a
    // resumed repair sees the failure context it is fixing (U7).
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
    const priorGateState = projectGateRepair(events, ctx.runId);
    const plan: ExecutionSchedulePlan = compileExecutionNodes({
      runRequest,
      tickets: tickets.tickets,
      modules: registry,
      workspaceDir,
      gateFeedback: priorGateState.gateFeedback,
    });

    if (plan.completed.length === plan.nodes.length) {
      // Every ticket already completed on a previous attempt; the run still
      // only counts as complete once the post-run gate stage passes. The U8
      // completion stage then resumes idempotently: a run that already
      // packaged skips packaging and re-attempts only the pending deploy.
      const stageResult = await runPostRunStage();
      if (stageResult !== null) {
        return stageResult;
      }
      return finishRun(
        `All ${plan.nodes.length} ticket(s) were already completed on a previous attempt.`,
      );
    }

    // Post-ticket gates + bounded repair loop (U7): wrap the plain ticket
    // runner when a gate config is wired; otherwise the scheduler uses the
    // default `runTicket` unchanged.
    const ticketRunner: TicketRunner | undefined =
      gateStages === undefined
        ? undefined
        : createGatedTicketRunner({
            gates: (stageCtx) =>
              gateStages.postTicket({
                runId: stageCtx.runId,
                ticketId: stageCtx.ticketId,
                workspaceDir: stageCtx.workspaceDir,
                run,
                signal: ctx.signal,
              }),
            gateContext: (stageCtx) =>
              gateStages.context({
                runId: stageCtx.runId,
                ticketId: stageCtx.ticketId,
                workspaceDir: stageCtx.workspaceDir,
                run,
                signal: ctx.signal,
              }),
            maxRepairAttempts: gateStages.maxRepairAttempts,
            maxAttemptsPerGate: gateStages.maxAttemptsPerGate,
            clock,
          });

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
        ticketRunner,
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
      const afterEvents = await ctx.store.readRun(ctx.runId);
      const after = projectTickets(afterEvents, ctx.runId);

      // U7 escalation: a ticket that exhausted its bounded repair budget
      // BLOCKS with an intervention + stage review instead of looping through
      // blind retries. Retry counters are ledger-derived (`repair.started`
      // counts), so this stays true across restarts.
      const repairState = projectGateRepair(afterEvents, ctx.runId);
      const exhausted = result.failed.filter((id) => repairState.exhaustedTickets.includes(id));
      if (exhausted.length > 0) {
        const details = exhausted.map((id) => {
          const repair = repairState.repairs[id];
          return `${id} (gate "${repair?.lastGate ?? 'gate'}" after ${
            repair?.attemptsUsed ?? 0
          } repair attempt(s): ${repair?.lastReason ?? 'still failing'})`;
        });
        const reason = `Repair budget exhausted for ${exhausted.length} ticket(s): ${details.join('; ')}.`;
        const evidence: EventEvidence[] = exhausted.map((id) => ({
          label: `repair:${id}`,
          ref: repairState.repairs[id]?.lastGate,
          note: repairState.repairs[id]?.lastReason,
        }));
        await emitStageReview('execution', reason, evidence);
        return blocked(
          reason,
          'Read the recorded gate/repair evidence, fix the cause, then approve the pending stage review or retry execution (POST /api/runs/:id/retry).',
          'retry_choice',
          'execution',
        );
      }

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

    // Every ticket completed (post-ticket gates included). The run counts as
    // complete only once the POST-RUN gate stage also passes (U7).
    const stageResult = await runPostRunStage();
    if (stageResult !== null) {
      return stageResult;
    }
    // U8: preview/package/provenance/deploy run here — after post-run gates
    // pass and before run.completed is emitted. Deploy pauses/failures add
    // notes + interventions without failing the locally-successful run.
    return finishRun(
      `${result.completed.length}/${plan.nodes.length} ticket(s) completed via adapter "${adapter.id}".`,
    );
  };
}
