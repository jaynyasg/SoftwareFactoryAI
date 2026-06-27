/**
 * Gate runner: run quality gates as BLOCKING checks, in order.
 *
 * The plan's gate set runs in this order: install, lint, typecheck, unit test,
 * secret-scan, dependency-audit, preview-health. For each gate the runner emits
 * `gate.started`, runs it, and on success emits `gate.passed` (with evidence) and
 * proceeds. A gate may be retried up to a bounded budget (`maxAttemptsPerGate`);
 * each attempt re-emits `gate.started`, so the attempt count is observable and
 * there is NO infinite retry. When the budget is exhausted the runner emits
 * `gate.failed` (with evidence), STOPS the pipeline, and returns a STRUCTURED
 * `GateFailureContext` (gate, command, output excerpt, reason, attempt) suitable
 * for the worker runner to fold into a retry's context.
 *
 * Evidence flows onto every `gate.*` event so an in-memory store + `projectRun`
 * surfaces the command/output behind each pass/fail.
 */
import type {
  AppendableEvent,
  EventActor,
  EventEvidence,
  EventStore,
} from '@software-factory/core';
import type { Gate, GateContext, GateEvidence, GateResult } from './command-gate';
import { createCommandGate } from './command-gate';
import { createLintGate } from './lint-gate';
import { createTypecheckGate } from './typecheck-gate';
import { createTestGate } from './test-gate';
import { createSecretScanGate } from './secret-scan-gate';
import type { WorkspaceFiles } from './secret-scan-gate';
import { createPreviewHealthGate } from './preview-health-gate';
import type { PreviewHealthProbe } from './preview-health-gate';
import { evaluateDependencies } from '../sandbox/dependency-policy';
import type { DeclaredDependency, DependencyPolicy } from '../sandbox/dependency-policy';
import { errorMessage } from '../utils/error';

/** The canonical blocking-gate order. */
export const DEFAULT_GATE_ORDER = [
  'install',
  'lint',
  'typecheck',
  'unit-test',
  'secret-scan',
  'dependency-audit',
  'preview-health',
] as const;

/** Structured failure context returned for the worker runner's retry loop. */
export interface GateFailureContext {
  readonly gate: string;
  readonly command?: string;
  readonly outputExcerpt?: string;
  readonly reason: string;
  /** The attempt on which the gate finally failed (>= 1). */
  readonly attempt: number;
  readonly evidence: readonly GateEvidence[];
}

/** The outcome of running a gate pipeline. */
export interface GateRunnerResult {
  readonly passed: boolean;
  /** Results for gates that ran, in order (the failing one is last on failure). */
  readonly results: readonly GateResult[];
  /** The blocking failure, when the pipeline stopped early. */
  readonly failure?: GateFailureContext;
  /** Total gate attempts made across the pipeline (proves the budget held). */
  readonly attempts: number;
  /** `true` only when every gate passed. */
  readonly ranToCompletion: boolean;
}

/** Inputs for a gate-pipeline run. */
export interface RunGatesParams {
  readonly runId: string;
  readonly ticketId?: string;
  /** Ordered gates to run. */
  readonly gates: readonly Gate[];
  /** Shared gate context (sandbox + workspace). */
  readonly context: GateContext;
  /** Per-gate retry budget (total attempts per gate). Default 1. */
  readonly maxAttemptsPerGate?: number;
  readonly clock?: () => number;
}

/** Dependencies for the gate runner. */
export interface RunGatesDeps {
  readonly store: EventStore;
}

function toEventEvidence(evidence: readonly GateEvidence[]): EventEvidence[] {
  return evidence.map((item) => {
    const note =
      item.outputExcerpt !== undefined && item.outputExcerpt.length > 0
        ? item.outputExcerpt
        : item.detail;
    return {
      label: item.label,
      ref: item.command ?? item.ref,
      note,
    };
  });
}

/**
 * Run gates in order with a bounded per-gate retry budget. Stops on the first
 * gate that fails its whole budget, returning structured retry context.
 */
export async function runGates(
  params: RunGatesParams,
  deps: RunGatesDeps,
): Promise<GateRunnerResult> {
  const maxAttempts = Math.max(1, Math.trunc(params.maxAttemptsPerGate ?? 1));
  const actor: EventActor = { kind: 'gate', id: 'gate-runner', display: 'gate-runner' };
  const results: GateResult[] = [];
  let totalAttempts = 0;

  const append = (event: Omit<AppendableEvent, 'runId' | 'ticketId'>): Promise<unknown> =>
    deps.store.append({
      ...event,
      runId: params.runId,
      ticketId: params.ticketId,
      timestamp: params.clock?.(),
    } as AppendableEvent);

  for (const gate of params.gates) {
    let lastResult: GateResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      totalAttempts += 1;
      await append({
        type: 'gate.started',
        actor,
        subject: { kind: 'gate', id: gate.name },
        severity: 'info',
        payload: { gate: gate.name },
      });

      let result: GateResult;
      try {
        result = await gate.run(params.context);
      } catch (error) {
        result = {
          gate: gate.name,
          passed: false,
          reason: `Gate "${gate.name}" threw: ${errorMessage(error)}`,
          evidence: [{ label: `${gate.name}:error`, detail: errorMessage(error) }],
        };
      }
      lastResult = result;

      if (result.passed) {
        await append({
          type: 'gate.passed',
          actor,
          subject: { kind: 'gate', id: gate.name },
          severity: 'success',
          evidence: toEventEvidence(result.evidence),
          payload: { gate: gate.name, summary: result.summary },
        });
        break;
      }

      // Failed this attempt. Retry silently until the budget is exhausted.
      if (attempt < maxAttempts) {
        continue;
      }

      // Budget exhausted: terminal, blocking failure — stop the pipeline.
      const reason = result.reason ?? `${gate.name} failed.`;
      await append({
        type: 'gate.failed',
        actor,
        subject: { kind: 'gate', id: gate.name },
        severity: 'error',
        evidence: toEventEvidence(result.evidence),
        payload: { gate: gate.name, reason },
      });
      results.push(result);
      return {
        passed: false,
        results,
        attempts: totalAttempts,
        ranToCompletion: false,
        failure: {
          gate: gate.name,
          command: result.command,
          outputExcerpt: result.outputExcerpt,
          reason,
          attempt,
          evidence: result.evidence,
        },
      };
    }

    if (lastResult !== undefined) {
      results.push(lastResult);
    }
  }

  return { passed: true, results, attempts: totalAttempts, ranToCompletion: true };
}

/* ----------------------------------------------------------------------------
 * Optional/composite gates + default ordered set
 * ------------------------------------------------------------------------- */

/** Override for a command-backed gate in `createDefaultGates`. */
export interface CommandGateOverride {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

/** Create the install gate (defaults to `pnpm install`). */
export function createInstallGate(options: CommandGateOverride = {}): Gate {
  return createCommandGate({
    name: 'install',
    command: options.command ?? 'pnpm',
    args: options.args ?? ['install'],
    timeoutMs: options.timeoutMs,
  });
}

/** Options for the dependency-audit gate. */
export interface DependencyAuditGateOptions {
  readonly policy: DependencyPolicy;
  readonly dependencies: readonly DeclaredDependency[];
}

/**
 * Create the dependency-audit gate. It fails (blocking) when a dependency is
 * blocked or any addition is above LOW risk; the caller can independently call
 * `evaluateDependencies` to emit `review.requested` with the decision's tier.
 */
export function createDependencyAuditGate(options: DependencyAuditGateOptions): Gate {
  return {
    name: 'dependency-audit',
    run(): Promise<GateResult> {
      const decision = evaluateDependencies(options.policy, options.dependencies);
      const evidence: GateEvidence[] = decision.classifications.map((classification) => ({
        label: `dep:${classification.name}`,
        ref: classification.version,
        detail: `${classification.status} (${classification.riskTier}): ${classification.reason}`,
      }));

      if (decision.blocked.length > 0) {
        return Promise.resolve({
          gate: 'dependency-audit',
          passed: false,
          reason: `Blocked dependencies: ${decision.blocked.join(', ')}.`,
          evidence,
        });
      }
      if (decision.reviewRequired) {
        return Promise.resolve({
          gate: 'dependency-audit',
          passed: false,
          reason: `Dependency additions require review (${decision.riskTier} risk): ${decision.needsReview.join(', ')}.`,
          evidence,
        });
      }
      return Promise.resolve({
        gate: 'dependency-audit',
        passed: true,
        summary: decision.summary,
        evidence,
      });
    },
  };
}

/** Configuration for the default ordered gate set. */
export interface DefaultGatesConfig {
  readonly install?: CommandGateOverride;
  readonly lint?: CommandGateOverride;
  readonly typecheck?: CommandGateOverride;
  readonly test?: CommandGateOverride;
  readonly secretScan?: { readonly files?: WorkspaceFiles };
  readonly dependencyAudit?: DependencyAuditGateOptions;
  readonly previewHealth?: {
    readonly url: string;
    readonly probe: PreviewHealthProbe;
    readonly attempts?: number;
    readonly pollIntervalMs?: number;
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  };
}

/**
 * Build the canonical, ordered gate set. The always-on gates (install, lint,
 * typecheck, unit-test, secret-scan) are included; dependency-audit and
 * preview-health are included only when their inputs are configured.
 */
export function createDefaultGates(config: DefaultGatesConfig = {}): Gate[] {
  const gates: Gate[] = [
    createInstallGate(config.install),
    createLintGate(config.lint),
    createTypecheckGate(config.typecheck),
    createTestGate(config.test),
    createSecretScanGate({ files: config.secretScan?.files }),
  ];
  if (config.dependencyAudit !== undefined) {
    gates.push(createDependencyAuditGate(config.dependencyAudit));
  }
  if (config.previewHealth !== undefined) {
    gates.push(createPreviewHealthGate(config.previewHealth));
  }
  return gates;
}
