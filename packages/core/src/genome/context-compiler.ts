/**
 * Lightweight worker-context compiler (V1 of wetware-style context assembly).
 *
 * Given a run request, a ticket, its module contract, the artifacts already
 * available, the risk tier, and any gate feedback, `compileContext` produces a
 * deterministic `WorkerContext`. Two guarantees matter most:
 *  - required inputs are RESOLVED from prior artifacts, and any MISSING ones are
 *    reported explicitly (never silently dropped), and
 *  - tools are filtered through the module's allow-list, so a tool that is not
 *    explicitly allowed can never reach the worker (allow-list, not deny-list).
 *
 * This is intentionally the lightweight version: no graph or vector store. The
 * full codebase-intelligence context engine remains deferred (see TODOS P1/P2).
 */
import type { RiskTier } from '../events/event-types';
import type { RunIntent, RunRequest } from '../supervisor/run-request';
import type { ArtifactContract, ModuleContract } from './module-contract';

/** A reference to an artifact available as context, keyed by its context key. */
export interface ArtifactRef {
  readonly key: string;
  readonly artifactId?: string;
  readonly kind?: string;
  readonly path?: string;
  /** Optional inline summary/value carried into context. */
  readonly summary?: string;
}

/** Structured feedback from a failed gate, fed back for a bounded retry. */
export interface GateFeedback {
  readonly gate: string;
  readonly reason: string;
  readonly attempt?: number;
}

/** The minimal ticket shape the compiler reads (a `PlannedTicket` satisfies it). */
export interface ContextTicket {
  readonly id: string;
  readonly title: string;
  readonly moduleId?: string;
  readonly riskTier?: RiskTier;
}

/** A required input successfully resolved from prior artifacts. */
export interface ResolvedInput {
  readonly key: string;
  readonly artifact: ArtifactRef;
}

/** Inputs to `compileContext`. */
export interface CompileContextInput {
  readonly runRequest: RunRequest;
  readonly ticket: ContextTicket;
  readonly moduleContract: ModuleContract;
  /** Artifacts available to this ticket, keyed by context/artifact key. */
  readonly priorArtifacts: Readonly<Record<string, ArtifactRef>>;
  readonly riskTier: RiskTier;
  readonly gateFeedback?: readonly GateFeedback[];
  /**
   * Tools the environment could offer. When provided, the effective tool set is
   * the intersection with the module allow-list; when omitted, the allow-list is
   * used as-is. The output is always a subset of `moduleContract.allowedTools`.
   */
  readonly availableTools?: readonly string[];
}

/** The compiled, deterministic context handed to a worker. */
export interface WorkerContext {
  readonly ticketId: string;
  readonly title: string;
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly intent: RunIntent;
  readonly prompt: string;
  readonly prdRef?: string;
  readonly prdText?: string;
  readonly riskTier: RiskTier;
  /** Required inputs found in `priorArtifacts`. */
  readonly resolvedInputs: readonly ResolvedInput[];
  /** Required inputs NOT found in `priorArtifacts`. */
  readonly missingInputs: readonly string[];
  /** Effective tool allow-list (always a subset of the module's allow-list). */
  readonly allowedTools: readonly string[];
  /** Offered tools excluded because they are not in the allow-list. */
  readonly deniedTools: readonly string[];
  readonly expectedOutputs: readonly string[];
  readonly artifactContracts: readonly ArtifactContract[];
  readonly gateFeedback: readonly GateFeedback[];
  /** `true` when no required inputs are missing. */
  readonly complete: boolean;
}

/**
 * Compile a `WorkerContext`. Pure and deterministic: no clocks, randomness, or
 * I/O — identical inputs yield an identical context.
 */
export function compileContext(input: CompileContextInput): WorkerContext {
  const { moduleContract: module } = input;

  const resolvedInputs: ResolvedInput[] = [];
  const missingInputs: string[] = [];
  for (const key of module.requiredInputs) {
    const artifact = input.priorArtifacts[key];
    if (artifact === undefined) {
      missingInputs.push(key);
    } else {
      resolvedInputs.push({ key, artifact });
    }
  }

  const allowList = new Set(module.allowedTools);
  const offered = input.availableTools ?? module.allowedTools;
  const allowedTools: string[] = [];
  const deniedTools: string[] = [];
  for (const tool of offered) {
    if (allowList.has(tool)) {
      allowedTools.push(tool);
    } else {
      deniedTools.push(tool);
    }
  }

  return {
    ticketId: input.ticket.id,
    title: input.ticket.title,
    moduleId: module.id,
    moduleVersion: module.version,
    intent: input.runRequest.intent,
    prompt: input.runRequest.prompt,
    prdRef: input.runRequest.prdRef,
    prdText: input.runRequest.prdText,
    riskTier: input.riskTier,
    resolvedInputs,
    missingInputs,
    allowedTools,
    deniedTools,
    expectedOutputs: [...module.expectedOutputs],
    artifactContracts: [...module.artifactContracts],
    gateFeedback: input.gateFeedback !== undefined ? [...input.gateFeedback] : [],
    complete: missingInputs.length === 0,
  };
}
