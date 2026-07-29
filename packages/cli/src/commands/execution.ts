/**
 * Execution control verbs (full-factory U5):
 *
 *   software-factory start-run   <runId>  — preflight + enqueue execution
 *   software-factory pause       <runId>  — stop new worker starts
 *   software-factory resume      <runId>  — resume a paused execution
 *   software-factory retry       <runId>  — retry failed/blocked/abandoned work
 *   software-factory rerun-gates <runId>  — enqueue a quality-gate re-run
 *   software-factory interventions        — the operator intervention queue
 *   software-factory resolve <id>         — resolve one intervention
 *
 * Factory-wide drain gate + cancel-all (the daemon boots HELD by default;
 * SF_EXEC_AUTOSTART=1 opts back in — started runs queue but do NOT execute
 * until the gate is released):
 *
 *   software-factory factory-status       — gate state + cross-run queue counts
 *   software-factory factory-resume       — release the gate; queued work starts
 *   software-factory factory-hold         — re-engage the gate; stop claiming new work
 *   software-factory cancel-all           — cancel every cancellable run
 *
 * Session lifecycle (U7 connector parity over the U2/U3/U4 routes):
 *
 *   software-factory cancel <runId> [--archive] — cancel (and optionally
 *                                          archive) one run in ONE command
 *   software-factory archive   <runId>    — reversible: run leaves default views
 *   software-factory unarchive <runId>    — visibility back; never revives work
 *   software-factory new-session          — hold + cancel actives + archive all
 *   software-factory factory-reset        — DESTRUCTIVE wipe; typed phrase
 *
 * All are thin wrappers: business rules (cancel-first archive, ask-once
 * confirmation, the reset phrase + lease refusal) live in the guarded routes.
 * The ONLY client-side logic is factory-reset's local phrase check, which
 * exists so a mistyped phrase aborts without ever sending a request.
 *
 * Commands enqueue or mutate execution state through the guarded HTTP API and
 * print projected state; the execution daemon owns the actual work (E1).
 * Mutating commands resolve a fresh `expectedVersion` automatically (fetching
 * the run first) so the guard's stale-version protection stays effective; pin
 * `--expected-version` to assert against a known ledger version instead.
 * Factory-scoped commands take no expectedVersion: the gate is process-local
 * daemon state and cancel-all is explicitly cross-run (no per-run stale check).
 */
import { ApiError } from '../api-client';
import type {
  ApiClient,
  ArchiveRunResult,
  CancelAllRunsResult,
  CancelRunResult,
  ExecutionCommandResult,
  ExecutionGateResult,
  ExecutionOverviewResult,
  FactoryResetResult,
  ListInterventionsResult,
  NewSessionResult,
  ResolveInterventionResult,
  UnarchiveRunResult,
} from '../api-client';
import type { CliIo } from '../cli-io';

export interface ExecutionCommandArgs {
  readonly runId: string;
  readonly expectedVersion?: number;
  readonly reason?: string;
  /** Retry only: focus the retry on one ticket. */
  readonly ticketId?: string;
  readonly json?: boolean;
}

export interface ExecutionCommandDeps {
  readonly client: ApiClient;
  readonly io: CliIo;
}

async function resolveExpectedVersion(
  client: ApiClient,
  runId: string,
  pinned?: number,
): Promise<number> {
  if (pinned !== undefined) {
    return pinned;
  }
  const run = await client.getRun(runId);
  return run.lastSequence;
}

function reportResult(io: CliIo, args: ExecutionCommandArgs, result: ExecutionCommandResult): void {
  if (args.json === true) {
    io.out(JSON.stringify(result, null, 2));
    return;
  }
  const state = result.execution?.state ?? result.job?.status ?? 'unknown';
  const attempt = result.job !== undefined ? ` (attempt ${result.job.attempt})` : '';
  const note =
    result.alreadyQueued === true
      ? ' — already queued; nothing re-enqueued'
      : result.execution?.reason !== undefined
        ? ` — ${result.execution.reason}`
        : '';
  io.out(`${result.runId ?? args.runId}: execution ${state}${attempt}${note}`);
}

export async function startRunCommand(
  args: ExecutionCommandArgs,
  deps: ExecutionCommandDeps,
): Promise<ExecutionCommandResult> {
  const expectedVersion = await resolveExpectedVersion(
    deps.client,
    args.runId,
    args.expectedVersion,
  );
  const result = await deps.client.startRun(args.runId, {
    expectedVersion,
    reason: args.reason,
  });
  reportResult(deps.io, args, result);
  return result;
}

export async function pauseRunCommand(
  args: ExecutionCommandArgs,
  deps: ExecutionCommandDeps,
): Promise<ExecutionCommandResult> {
  const expectedVersion = await resolveExpectedVersion(
    deps.client,
    args.runId,
    args.expectedVersion,
  );
  const result = await deps.client.pauseRun(args.runId, {
    expectedVersion,
    reason: args.reason,
  });
  reportResult(deps.io, args, result);
  return result;
}

export async function resumeRunCommand(
  args: ExecutionCommandArgs,
  deps: ExecutionCommandDeps,
): Promise<ExecutionCommandResult> {
  const expectedVersion = await resolveExpectedVersion(
    deps.client,
    args.runId,
    args.expectedVersion,
  );
  const result = await deps.client.resumeRun(args.runId, {
    expectedVersion,
    reason: args.reason,
  });
  reportResult(deps.io, args, result);
  return result;
}

export async function retryRunCommand(
  args: ExecutionCommandArgs,
  deps: ExecutionCommandDeps,
): Promise<ExecutionCommandResult> {
  const expectedVersion = await resolveExpectedVersion(
    deps.client,
    args.runId,
    args.expectedVersion,
  );
  const result = await deps.client.retryRun(args.runId, {
    expectedVersion,
    reason: args.reason,
    ticketId: args.ticketId,
  });
  reportResult(deps.io, args, result);
  return result;
}

export async function rerunGatesCommand(
  args: ExecutionCommandArgs,
  deps: ExecutionCommandDeps,
): Promise<ExecutionCommandResult> {
  const expectedVersion = await resolveExpectedVersion(
    deps.client,
    args.runId,
    args.expectedVersion,
  );
  const result = await deps.client.rerunGates(args.runId, {
    expectedVersion,
    reason: args.reason,
  });
  reportResult(deps.io, args, result);
  return result;
}

export interface InterventionsCommandArgs {
  readonly runId?: string;
  readonly kind?: string;
  readonly severity?: string;
  readonly blockingStage?: string;
  readonly open?: boolean;
  readonly json?: boolean;
}

export async function interventionsCommand(
  args: InterventionsCommandArgs,
  deps: ExecutionCommandDeps,
): Promise<ListInterventionsResult> {
  const result = await deps.client.listInterventions({
    runId: args.runId,
    kind: args.kind,
    severity: args.severity,
    blockingStage: args.blockingStage,
    open: args.open,
  });
  if (args.json === true) {
    deps.io.out(JSON.stringify(result, null, 2));
    return result;
  }
  if (result.interventions.length === 0) {
    deps.io.out('No interventions.');
    return result;
  }
  for (const item of result.interventions) {
    deps.io.out(
      `[${item.status}] ${item.interventionId} (${item.kind}, ${item.severity}, blocks ${item.blockingStage}) run ${item.runId}\n  reason: ${item.reason}\n  action: ${item.requiredAction}`,
    );
  }
  deps.io.out(`${result.openCount} open intervention(s).`);
  return result;
}

export interface ResolveInterventionCommandArgs {
  readonly interventionId: string;
  readonly resolution: string;
  readonly note?: string;
  readonly expectedVersion?: number;
  readonly json?: boolean;
}

export async function resolveInterventionCommand(
  args: ResolveInterventionCommandArgs,
  deps: ExecutionCommandDeps,
): Promise<ResolveInterventionResult> {
  const result = await deps.client.resolveIntervention(args.interventionId, {
    resolution: args.resolution,
    note: args.note,
    expectedVersion: args.expectedVersion,
  });
  if (args.json === true) {
    deps.io.out(JSON.stringify(result, null, 2));
    return result;
  }
  deps.io.out(
    result.alreadyResolved === true
      ? `${args.interventionId}: already resolved.`
      : `${args.interventionId}: resolved (${args.resolution}).`,
  );
  return result;
}

/* ----------------------------------------------------------------------------
 * Factory-wide drain gate + cancel-all. The execution daemon boots HELD by
 * default (SF_EXEC_AUTOSTART=1 opts back in), so `start-run`/`run --mode
 * research-plan-and-start` queue work that does NOT execute until
 * `factory-resume` releases the gate. These commands operate on the factory
 * scope (no runId, no expectedVersion — the gate is process-local daemon
 * state and cancel-all is explicitly cross-run).
 * ------------------------------------------------------------------------- */

export interface FactoryCommandArgs {
  readonly json?: boolean;
}

export async function factoryStatusCommand(
  args: FactoryCommandArgs,
  deps: ExecutionCommandDeps,
): Promise<ExecutionOverviewResult> {
  const result = await deps.client.getExecutionOverview();
  if (args.json === true) {
    deps.io.out(JSON.stringify(result, null, 2));
    return result;
  }
  if (!result.execution.enabled) {
    deps.io.out('Execution controls are not enabled on this server instance.');
    return result;
  }
  const gate = result.execution.held
    ? 'HELD — queued runs will not execute until factory-resume'
    : 'released';
  deps.io.out(
    `execution gate: ${gate}; daemon ${result.execution.running ? 'running' : 'stopped'}; ` +
      `queue: ${result.queue.queued} queued, ${result.queue.leased} leased`,
  );
  return result;
}

export async function factoryResumeCommand(
  args: FactoryCommandArgs,
  deps: ExecutionCommandDeps,
): Promise<ExecutionGateResult> {
  const result = await deps.client.resumeExecution();
  if (args.json === true) {
    deps.io.out(JSON.stringify(result, null, 2));
    return result;
  }
  deps.io.out(
    result.alreadyActive === true
      ? 'Drain gate already released; queued work is claimable.'
      : 'Drain gate released — queued work will now execute.',
  );
  return result;
}

export async function factoryHoldCommand(
  args: FactoryCommandArgs,
  deps: ExecutionCommandDeps,
): Promise<ExecutionGateResult> {
  const result = await deps.client.holdExecution();
  if (args.json === true) {
    deps.io.out(JSON.stringify(result, null, 2));
    return result;
  }
  deps.io.out(
    result.alreadyHeld === true
      ? 'Drain gate already held; no new work is being claimed.'
      : 'Drain gate held — no NEW work will be claimed (in-flight work finishes).',
  );
  return result;
}

export interface CancelAllCommandArgs {
  readonly reason?: string;
  readonly json?: boolean;
}

export async function cancelAllRunsCommand(
  args: CancelAllCommandArgs,
  deps: ExecutionCommandDeps,
): Promise<CancelAllRunsResult> {
  const result = await deps.client.cancelAllRuns({ reason: args.reason });
  if (args.json === true) {
    deps.io.out(JSON.stringify(result, null, 2));
    return result;
  }
  deps.io.out(
    `Cancelled ${result.cancelledCount} run(s); ` +
      `${result.alreadyCancelled.length} already cancelled; ` +
      `${result.skippedTerminal.length} terminal (kept their recorded outcome).`,
  );
  for (const runId of result.cancelled) {
    deps.io.out(`  cancelled ${runId}`);
  }
  // Per-run failures go to stderr so scripted callers notice partial batches.
  for (const failure of result.errors ?? []) {
    deps.io.err(`  failed ${failure.runId}: ${failure.message}`);
  }
  return result;
}

/* ----------------------------------------------------------------------------
 * Session lifecycle (U7 connector parity over the U2/U3/U4 routes). Thin
 * wrappers: cancel-first archiving, the ask-once active-runs confirmation, and
 * the reset guard all live server-side — the CLI forwards inputs and prints
 * the route-shaped outcome.
 * ------------------------------------------------------------------------- */

export interface CancelRunCommandArgs {
  readonly runId: string;
  readonly expectedVersion?: number;
  readonly reason?: string;
  /** Cancel-and-archive in ONE command (R10): `cancel <runId> --archive`. */
  readonly archive?: boolean;
  readonly json?: boolean;
}

export async function cancelRunCommand(
  args: CancelRunCommandArgs,
  deps: ExecutionCommandDeps,
): Promise<CancelRunResult> {
  const expectedVersion = await resolveExpectedVersion(
    deps.client,
    args.runId,
    args.expectedVersion,
  );
  const result = await deps.client.cancelRun(args.runId, {
    expectedVersion,
    reason: args.reason,
    archive: args.archive,
  });
  if (args.json === true) {
    deps.io.out(JSON.stringify(result, null, 2));
    return result;
  }
  const cancelledPart = result.alreadyCancelled === true ? 'already cancelled' : 'cancelled';
  const archivePart =
    result.archived === true
      ? ' and archived'
      : result.alreadyArchived === true
        ? ' (already archived)'
        : '';
  deps.io.out(`${result.runId}: ${cancelledPart}${archivePart}.`);
  return result;
}

export async function archiveRunCommand(
  args: ExecutionCommandArgs,
  deps: ExecutionCommandDeps,
): Promise<ArchiveRunResult> {
  const expectedVersion = await resolveExpectedVersion(
    deps.client,
    args.runId,
    args.expectedVersion,
  );
  const result = await deps.client.archiveRun(args.runId, {
    expectedVersion,
    reason: args.reason,
  });
  if (args.json === true) {
    deps.io.out(JSON.stringify(result, null, 2));
    return result;
  }
  deps.io.out(
    result.alreadyArchived === true
      ? `${result.runId}: already archived.`
      : `${result.runId}: archived${
          result.cancelled === true ? ' (active run was cancelled first)' : ''
        } — still on disk and replayable; unarchive to restore visibility.`,
  );
  return result;
}

export async function unarchiveRunCommand(
  args: ExecutionCommandArgs,
  deps: ExecutionCommandDeps,
): Promise<UnarchiveRunResult> {
  const expectedVersion = await resolveExpectedVersion(
    deps.client,
    args.runId,
    args.expectedVersion,
  );
  const result = await deps.client.unarchiveRun(args.runId, {
    expectedVersion,
    reason: args.reason,
  });
  if (args.json === true) {
    deps.io.out(JSON.stringify(result, null, 2));
    return result;
  }
  deps.io.out(
    result.alreadyVisible === true
      ? `${result.runId}: already visible.`
      : `${result.runId}: visible again (execution state untouched — cancelled stays terminal).`,
  );
  return result;
}

export interface NewSessionCommandArgs {
  /** Confirm cancelling and archiving ACTIVE runs (the ask-once answer). */
  readonly confirmActive?: boolean;
  readonly reason?: string;
  readonly json?: boolean;
}

export async function newSessionCommand(
  args: NewSessionCommandArgs,
  deps: ExecutionCommandDeps,
): Promise<NewSessionResult> {
  let result: NewSessionResult;
  try {
    result = await deps.client.startNewSession({
      confirmActive: args.confirmActive,
      reason: args.reason,
    });
  } catch (error) {
    // The ask-once refusal (AE1): list the actives with a CLI-flavored hint,
    // then rethrow so the exit code still reports the aborted command.
    if (error instanceof ApiError && error.code === 'active_runs_present') {
      const actives = Array.isArray(error.details?.activeRuns) ? error.details.activeRuns : [];
      for (const entry of actives) {
        const active = entry as { runId?: string; title?: string; executionState?: string };
        deps.io.err(
          `  active: ${active.runId ?? 'unknown'}${
            active.title !== undefined ? ` — ${active.title}` : ''
          } (${active.executionState ?? 'active'})`,
        );
      }
      deps.io.err('Re-run with --confirm-active to cancel and archive them, or cancel first.');
    }
    // Partial failure (500 new_session_partial): the batch DID run — print
    // what landed plus every per-run failure so the operator knows the floor
    // state, then rethrow so the exit code reports the partial command
    // instead of pretending success.
    if (error instanceof ApiError && error.code === 'new_session_partial') {
      const details = error.details ?? {};
      const archivedCount = Array.isArray(details.archived) ? details.archived.length : 0;
      const cancelledCount = Array.isArray(details.cancelled) ? details.cancelled.length : 0;
      deps.io.err(
        `New session PARTIAL: archived ${archivedCount} run(s), cancelled ${cancelledCount} ` +
          'active run(s); some operations failed:',
      );
      for (const entry of Array.isArray(details.errors) ? details.errors : []) {
        const failure = entry as { runId?: string; message?: string };
        deps.io.err(
          `  failed ${failure.runId ?? 'unknown'}: ${failure.message ?? 'unknown error'}`,
        );
      }
    }
    throw error;
  }
  if (args.json === true) {
    deps.io.out(JSON.stringify(result, null, 2));
    return result;
  }
  deps.io.out(
    `New session: archived ${result.archived.length} run(s), cancelled ` +
      `${result.cancelled.length} active run(s); drain gate HELD (queued work will not ` +
      'execute until factory-resume).',
  );
  for (const failure of result.errors ?? []) {
    deps.io.err(`  failed ${failure.runId}: ${failure.message}`);
  }
  return result;
}

/**
 * The typed confirmation phrase, mirrored from the server contract
 * (`FACTORY_RESET_PHRASE` in packages/web/src/server/factory-reset.ts). The
 * SERVER enforces the real contract on every request; this local copy only
 * lets the CLI abort a mistyped phrase WITHOUT sending a request. Both sides
 * pin the same literal in their tests, so a drift fails a build, not an
 * operator.
 */
export const FACTORY_RESET_PHRASE = 'reset the factory';

export interface FactoryResetCommandArgs {
  /** Non-interactive confirmation: `--confirm "reset the factory"`. */
  readonly confirm?: string;
  readonly json?: boolean;
}

export interface FactoryResetCommandDeps extends ExecutionCommandDeps {
  /**
   * Interactive prompt for the typed phrase (stdin/readline in the real CLI;
   * injected in tests). Only consulted when `--confirm` was not given.
   */
  readonly promptLine?: (question: string) => Promise<string>;
}

/**
 * DESTRUCTIVE factory reset. Returns `null` when aborted locally (phrase not
 * matched or no way to ask) — in that case NO request was sent. On a match the
 * phrase is forwarded verbatim; the server re-verifies it and refuses while
 * queue-job leases are active.
 */
export async function factoryResetCommand(
  args: FactoryResetCommandArgs,
  deps: FactoryResetCommandDeps,
): Promise<FactoryResetResult | null> {
  let phrase = args.confirm;
  if (phrase === undefined) {
    if (deps.promptLine === undefined) {
      deps.io.err(
        'factory-reset requires confirmation: pass --confirm ' +
          `"${FACTORY_RESET_PHRASE}" or run interactively.`,
      );
      return null;
    }
    deps.io.err(
      'DESTRUCTIVE: this wipes the event ledger (every run, visible or archived), ' +
        'factory-managed workspaces, and the operator token. It cannot be undone.',
    );
    phrase = await deps.promptLine(`Type "${FACTORY_RESET_PHRASE}" to proceed: `);
  }
  if (phrase !== FACTORY_RESET_PHRASE) {
    // Local abort: nothing was sent — a mistyped phrase must not even reach
    // the server (the server would refuse it too; this spares the round trip).
    deps.io.err(`Confirmation did not match "${FACTORY_RESET_PHRASE}". Nothing was sent.`);
    return null;
  }
  const result = await deps.client.factoryReset({ confirm: phrase });
  if (args.json === true) {
    deps.io.out(JSON.stringify(result, null, 2));
    return result;
  }
  const destroyed = result.destroyed;
  const runCount = typeof destroyed?.runCount === 'number' ? destroyed.runCount : undefined;
  const archivedRunCount =
    typeof destroyed?.archivedRunCount === 'number' ? destroyed.archivedRunCount : undefined;
  const counts =
    runCount !== undefined && archivedRunCount !== undefined
      ? ` Destroyed ${runCount} visible + ${archivedRunCount} archived run(s).`
      : '';
  deps.io.out(
    `Factory reset complete (generation ${result.resetGeneration ?? '?'}); drain gate HELD.` +
      counts,
  );
  return result;
}
