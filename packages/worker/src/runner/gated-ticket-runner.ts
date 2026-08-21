/**
 * Gated ticket runner: post-ticket quality gates + a bounded repair loop
 * (full-factory U7).
 *
 * Wraps the plain `runTicket` so a completed worker run must ALSO pass its
 * post-ticket gate stage before the ticket counts as completed:
 *
 *   runTicket -> runGates(stage: post_ticket)
 *     pass  -> completed (repair.succeeded when a repair attempt fixed it)
 *     fail  -> repair budget left?
 *       yes -> repair.started (attempt N) + ticket retrying
 *              -> re-run the ticket WITH the gate failure compiled into its
 *                 context (`gateFeedback`) -> gates again -> loop
 *       no  -> repair.failed (budget exhausted) + ticket failed -> ESCALATE
 *              (the executor raises the operator intervention; no more loops)
 *
 * REPLAY-SAFE BUDGET: repair attempt counters are derived from the ledger
 * (`projectGateRepair` counts prior `repair.started` events), never from
 * memory — a process restart mid-repair resumes the SAME budget. Prior gate
 * failures recorded on the ledger are also merged into the first attempt's
 * context, so a resumed repair sees the failure it is fixing.
 *
 * Gates and the gate context (sandbox) are injected, so unit tests use
 * deterministic fake gates — no real lint/test subprocesses.
 */
import type { GateFeedback, GateStage } from '@software-factory/core';
import type { Gate, GateContext } from '../gates/command-gate';
import { runGates } from '../gates/gate-runner';
import type { GateFailureContext } from '../gates/gate-runner';
import { projectGateRepair } from '../gates/gate-projection';
import { runTicket } from './worker-runner';
import type { RunTicketDeps, RunTicketParams, RunTicketResult } from './worker-runner';

/** The pluggable single-ticket runner the scheduler invokes (U7 seam). */
export type TicketRunner = (
  params: RunTicketParams,
  deps: RunTicketDeps,
) => Promise<RunTicketResult>;

/** Context handed to the per-ticket gate factories. */
export interface TicketGateStageContext {
  readonly runId: string;
  readonly ticketId: string;
  readonly workspaceDir: string;
}

export interface GatedTicketRunnerOptions {
  /** Build the post-ticket gate set for one ticket. Empty = no gate stage. */
  readonly gates: (ctx: TicketGateStageContext) => readonly Gate[] | Promise<readonly Gate[]>;
  /** Build the gate context (sandbox + workspace) for one ticket. */
  readonly gateContext: (ctx: TicketGateStageContext) => GateContext | Promise<GateContext>;
  /** Total repair attempts allowed per ticket across the RUN's whole ledger. */
  readonly maxRepairAttempts?: number;
  /** Per-gate retry budget forwarded to the gate runner. Default 1. */
  readonly maxAttemptsPerGate?: number;
  readonly clock?: () => number;
}

/** Default per-ticket repair budget: 2 repair attempts after the first failure. */
export const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

const REPAIR_STAGE: GateStage = 'post_ticket';

const REPAIR_ACTOR = { kind: 'gate', id: 'repair-loop', display: 'repair-loop' } as const;

function mergeFeedback(
  compiled: readonly GateFeedback[] | undefined,
  ledger: readonly GateFeedback[] | undefined,
  latest?: GateFeedback,
): GateFeedback[] {
  const merged = new Map<string, GateFeedback>();
  for (const item of compiled ?? []) {
    merged.set(item.gate, item);
  }
  for (const item of ledger ?? []) {
    merged.set(item.gate, item);
  }
  if (latest !== undefined) {
    merged.set(latest.gate, latest);
  }
  return [...merged.values()];
}

/**
 * Build a `TicketRunner` that runs post-ticket gates with a bounded,
 * ledger-derived repair loop. Plug it into the scheduler via
 * `runScheduler({ ticketRunner })`.
 */
export function createGatedTicketRunner(options: GatedTicketRunnerOptions): TicketRunner {
  const maxRepairAttempts = Math.max(
    0,
    Math.trunc(options.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS),
  );

  return async (params: RunTicketParams, deps: RunTicketDeps): Promise<RunTicketResult> => {
    const ticketId = params.compileInput.ticket.id;
    const stageCtx: TicketGateStageContext = {
      runId: params.runId,
      ticketId,
      workspaceDir: params.workspaceDir,
    };
    const gates = await options.gates(stageCtx);

    // Ledger-derived repair state: prior attempts consumed + open gate feedback.
    const before = projectGateRepair(await deps.store.readRun(params.runId), params.runId);
    let attemptsUsed = before.repairs[ticketId]?.attemptsUsed ?? 0;
    const ledgerFeedback = before.gateFeedback[ticketId];

    const repairEnvelope = (
      type: 'repair.started' | 'repair.succeeded' | 'repair.failed',
      severity: 'warn' | 'success' | 'error',
      attempt: number,
    ) =>
      ({
        runId: params.runId,
        ticketId,
        actor: REPAIR_ACTOR,
        subject: { kind: 'ticket', id: ticketId },
        severity,
        timestamp: options.clock?.(),
        idempotencyKey: `${params.runId}:${ticketId}:${type}:${attempt}`,
      }) as const;

    const emitRepairStarted = (attempt: number, gate: string, reason: string): Promise<unknown> =>
      deps.store.append({
        ...repairEnvelope('repair.started', 'warn', attempt),
        type: 'repair.started',
        payload: { attempt, gate, reason },
      });
    const emitRepairSucceeded = (attempt: number, gate: string): Promise<unknown> =>
      deps.store.append({
        ...repairEnvelope('repair.succeeded', 'success', attempt),
        type: 'repair.succeeded',
        payload: { attempt, gate },
      });
    const emitRepairFailed = (attempt: number, gate: string, reason: string): Promise<unknown> =>
      deps.store.append({
        ...repairEnvelope('repair.failed', 'error', attempt),
        type: 'repair.failed',
        payload: { attempt, gate, reason },
      });

    const emitTicketState = (state: 'retrying' | 'failed', reason: string): Promise<unknown> =>
      deps.store.append({
        runId: params.runId,
        ticketId,
        type: 'ticket.state_changed',
        actor: REPAIR_ACTOR,
        subject: { kind: 'ticket', id: ticketId },
        severity: state === 'failed' ? 'error' : 'warn',
        timestamp: options.clock?.(),
        payload: { state, reason },
      });

    let feedback = mergeFeedback(params.compileInput.gateFeedback, ledgerFeedback);
    let repairedThisInvocation = false;
    // The gate whose failure triggered the LAST repair attempt. Recorded on
    // repair.succeeded — never positionally derived from the merged feedback
    // (Map insertion order keeps an earlier-seen gate in place, so the last
    // array entry is not necessarily the last failed gate).
    let lastFailedGate: string | undefined;

    // The loop is bounded by the repair budget; each iteration is one worker
    // run followed by one gate-stage run.
    for (;;) {
      const result = await runTicket(
        {
          ...params,
          compileInput: { ...params.compileInput, gateFeedback: feedback },
        },
        deps,
      );
      if (result.outcome !== 'completed' || gates.length === 0) {
        return result;
      }

      const gateContext = await options.gateContext(stageCtx);
      const gateResult = await runGates(
        {
          runId: params.runId,
          ticketId,
          gates,
          context: gateContext,
          maxAttemptsPerGate: options.maxAttemptsPerGate,
          stage: REPAIR_STAGE,
          clock: options.clock,
        },
        { store: deps.store },
      );

      if (gateResult.passed) {
        if (repairedThisInvocation) {
          await emitRepairSucceeded(attemptsUsed, lastFailedGate ?? 'gate');
        }
        return result;
      }

      const failure: GateFailureContext | undefined = gateResult.failure;
      const failedGate = failure?.gate ?? 'gate';
      const reason = failure?.reason ?? `Post-ticket gate stage failed for ${ticketId}.`;

      // Cancellation always wins over another repair round.
      if (params.signal.aborted) {
        return { ...result, outcome: 'cancelled' };
      }

      if (attemptsUsed >= maxRepairAttempts) {
        // Budget exhausted: ESCALATE instead of looping. The repair.failed
        // event carries the terminal evidence; the executor raises the
        // operator intervention from it.
        await emitRepairFailed(attemptsUsed, failedGate, reason);
        await emitTicketState(
          'failed',
          `gate "${failedGate}" still failing after ${attemptsUsed} repair attempt(s): ${reason}`,
        );
        return {
          ...result,
          outcome: 'failed',
        };
      }

      attemptsUsed += 1;
      repairedThisInvocation = true;
      lastFailedGate = failedGate;
      await emitRepairStarted(attemptsUsed, failedGate, reason);
      await emitTicketState(
        'retrying',
        `repair attempt ${attemptsUsed}/${maxRepairAttempts} for gate "${failedGate}"`,
      );
      feedback = mergeFeedback(feedback, undefined, {
        gate: failedGate,
        reason,
        attempt: attemptsUsed,
      });
    }
  };
}
