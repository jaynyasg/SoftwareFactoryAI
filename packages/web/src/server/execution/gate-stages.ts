/**
 * Executor gate-stage configuration (full-factory U7).
 *
 * Defines HOW the scheduler-backed executor builds its two gate stages:
 *
 *  - POST-TICKET gates run right after a ticket's worker completes and feed
 *    the bounded repair loop (`createGatedTicketRunner`), and
 *  - POST-RUN gates run after every ticket completed and must pass before the
 *    executor emits `run.completed`.
 *
 * `createRuntimeGateStages` is the PRODUCTION wiring used by the server entry
 * points (`instance.ts` / `standalone.ts`): it derives the post-run gate set
 * from the run's recorded build contract (`gateExpectations`) and runs command
 * gates through the policy-enforcing sandbox (Docker preferred, policy-gated
 * reduced-trust local fallback otherwise). Unit tests inject fake stages —
 * `createSchedulerTicketExecutor` runs WITHOUT gates unless a config is given,
 * so no test ever spawns a real lint/typecheck/test subprocess.
 *
 * U8 COMPLETION STAGE: packaging, provenance, preview serving, and deploy
 * triggering run AFTER the post-run gate stage passes — immediately before the
 * executor emits `run.completed` (see `completion-stage.ts`). The
 * `local preview health check` expectation is recognized here (so preflight
 * readiness passes) but deliberately produces no post-run COMMAND gate: the
 * health check needs the preview server the completion stage owns, so the
 * completion stage runs it (`startPreview` + health probe, recording
 * `preview.*` events). Preview health feeds artifact confidence and the deploy
 * preconditions rather than blocking local run completion.
 */
import { createNodeCommandRunner } from '@software-factory/core';
import type { RunProjection } from '@software-factory/core';
import {
  createLintGate,
  createSecretScanGate,
  createSandbox,
  createTestGate,
  createTypecheckGate,
  createInstallGate,
} from '@software-factory/worker';
import type { Gate, GateContext, Sandbox } from '@software-factory/worker';
import type { RuntimeConfig } from '../runtime';

/** Context handed to run-level gate-stage factories. */
export interface RunGateStageContext {
  readonly runId: string;
  readonly workspaceDir: string;
  /** The replayed run projection (build contract, review mode, …). */
  readonly run: RunProjection;
  readonly signal?: AbortSignal;
}

/** Context handed to per-ticket gate-stage factories. */
export interface TicketGateStageInput extends RunGateStageContext {
  readonly ticketId: string;
}

/** How the executor builds gates + gate contexts for a run. */
export interface ExecutorGateStages {
  /** Post-ticket gate set for one ticket (empty array = no stage). */
  postTicket(ctx: TicketGateStageInput): readonly Gate[] | Promise<readonly Gate[]>;
  /** Post-run gate set for the whole workspace (empty array = no stage). */
  postRun(ctx: RunGateStageContext): readonly Gate[] | Promise<readonly Gate[]>;
  /** Gate context (sandbox + workspace) for a stage run. */
  context(
    ctx: RunGateStageContext & { readonly ticketId?: string },
  ): GateContext | Promise<GateContext>;
  /** Per-ticket repair budget (defaults applied by the executor). */
  readonly maxRepairAttempts?: number;
  /** Per-gate retry budget within one stage run. */
  readonly maxAttemptsPerGate?: number;
}

/**
 * Gate builders per build-contract expectation string (the vocabulary
 * `deriveBuildContract` emits). `null` marks an expectation that is KNOWN but
 * not executable until a later unit wires its prerequisite (preview server).
 */
const EXPECTATION_GATES: Readonly<Record<string, (() => Gate) | null>> = {
  lint: () => createLintGate(),
  typecheck: () => createTypecheckGate(),
  'unit and smoke tests': () => createTestGate(),
  'secret scan': () => createSecretScanGate(),
  // Handled by the U8 completion stage (it owns the preview server); see the
  // module doc above.
  'local preview health check': null,
};

/** Whether a build-contract gate expectation maps to a known gate. */
export function isKnownGateExpectation(expectation: string): boolean {
  return expectation in EXPECTATION_GATES;
}

/** Build the executable post-run gate set for a contract's expectations. */
export function gatesForExpectations(expectations: readonly string[]): Gate[] {
  const gates: Gate[] = [];
  let needsInstall = false;
  for (const expectation of expectations) {
    const factory = EXPECTATION_GATES[expectation];
    if (factory === null || factory === undefined) {
      continue;
    }
    if (
      expectation === 'lint' ||
      expectation === 'typecheck' ||
      expectation === 'unit and smoke tests'
    ) {
      needsInstall = true;
    }
    gates.push(factory());
  }
  if (gates.length > 0 && needsInstall) {
    gates.unshift(createInstallGate());
  }
  return gates;
}

export interface RuntimeGateStagesOptions {
  readonly runtime?: RuntimeConfig;
  /** Per-ticket repair budget. */
  readonly maxRepairAttempts?: number;
  /** Per-gate retry budget within a stage run. */
  readonly maxAttemptsPerGate?: number;
}

/**
 * The production gate-stage wiring: post-run gates from the run's build
 * contract, a cheap secret scan after every ticket, and sandboxed command
 * execution (Docker preferred; policy-gated reduced-trust fallback otherwise).
 */
export function createRuntimeGateStages(
  options: RuntimeGateStagesOptions = {},
): ExecutorGateStages {
  const runner = createNodeCommandRunner();
  // One sandbox per (run, workspace): selection probes Docker once per key.
  const sandboxes = new Map<string, Promise<Sandbox>>();

  const sandboxFor = (ctx: RunGateStageContext): Promise<Sandbox> => {
    const key = `${ctx.runId} ${ctx.workspaceDir}`;
    let selection = sandboxes.get(key);
    if (selection === undefined) {
      selection = createSandbox({
        policy: { workspaceDir: ctx.workspaceDir, allowFallback: true },
        runner,
        signal: ctx.signal,
      }).then((selected) => {
        if (!selected.ok) {
          throw new Error(`No sandbox is available for gate execution: ${selected.reason}`);
        }
        return selected.sandbox;
      });
      sandboxes.set(key, selection);
      selection.catch(() => {
        // Allow a later stage run to retry sandbox selection after a failure.
        sandboxes.delete(key);
      });
    }
    return selection;
  };

  return {
    // Cheap, per-ticket: catch committed secrets as soon as a ticket lands.
    postTicket: () => [createSecretScanGate()],
    postRun: (ctx) => gatesForExpectations(ctx.run.buildContract?.gateExpectations ?? []),
    context: async (ctx) => ({
      runId: ctx.runId,
      ticketId: ctx.ticketId,
      workspaceDir: ctx.workspaceDir,
      sandbox: await sandboxFor(ctx),
      signal: ctx.signal,
    }),
    maxRepairAttempts: options.maxRepairAttempts,
    maxAttemptsPerGate: options.maxAttemptsPerGate,
  };
}
