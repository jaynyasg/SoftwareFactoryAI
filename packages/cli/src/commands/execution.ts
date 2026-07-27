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
 * Commands enqueue or mutate execution state through the guarded HTTP API and
 * print projected state; the execution daemon owns the actual work (E1).
 * Mutating commands resolve a fresh `expectedVersion` automatically (fetching
 * the run first) so the guard's stale-version protection stays effective; pin
 * `--expected-version` to assert against a known ledger version instead.
 * Factory-scoped commands take no expectedVersion: the gate is process-local
 * daemon state and cancel-all is explicitly cross-run (no per-run stale check).
 */
import type {
  ApiClient,
  CancelAllRunsResult,
  ExecutionCommandResult,
  ExecutionGateResult,
  ExecutionOverviewResult,
  ListInterventionsResult,
  ResolveInterventionResult,
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
