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

/** Default tool allow-list for tickets without a registered genome module. */
const FALLBACK_ALLOWED_TOOLS = ['fs.read', 'fs.write', 'shell.exec'] as const;

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

/* ----------------------------------------------------------------------------
 * Projected ticket DAG -> schedulable execution nodes (full-factory U6)
 * ------------------------------------------------------------------------- */

/**
 * The minimal projected-ticket shape the execution compiler reads. A
 * `TicketView` from the ticket projection satisfies it structurally, so the
 * mapping stays pure and replayable (projection in, schedule nodes out).
 */
export interface ExecutableTicket {
  readonly ticketId: string;
  readonly title?: string;
  readonly moduleId?: string;
  readonly dependsOn: readonly string[];
  readonly riskTier?: RiskTier;
  /** Projected ticket state; `completed` tickets are pre-settled on resume. */
  readonly state?: string;
}

/** The lookup surface `compileExecutionNodes` needs (a `ModuleRegistry` fits). */
export interface ModuleContractSource {
  get(id: string): ModuleContract | undefined;
}

/**
 * A schedulable execution node. Structurally satisfies the worker scheduler's
 * `ScheduleNode` (id, dependsOn, title, riskTier, workspaceDir, compileInput,
 * writeScope) without the core package depending on the worker package.
 */
export interface ExecutionScheduleNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly title: string;
  readonly riskTier: RiskTier;
  /** The shared run workspace directory every node executes inside. */
  readonly workspaceDir: string;
  readonly compileInput: CompileContextInput;
  /**
   * Declared write scope, derived from the module's expected-output keys
   * (`outputs/<key>`): two tickets that declare the same output key conflict
   * and are serialized by the scheduler even when worker slots are free.
   */
  readonly writeScope: readonly string[];
  /** The resolved (or fallback) module id backing this node. */
  readonly moduleId: string;
  readonly expectedOutputs: readonly string[];
}

export interface CompileExecutionNodesInput {
  readonly runRequest: RunRequest;
  /** Projected tickets for the run (a `TicketProjection.tickets` fits). */
  readonly tickets: readonly ExecutableTicket[];
  /** Module contract lookup (a `ModuleRegistry` fits). */
  readonly modules: ModuleContractSource;
  /** The materialized (or freshly generated) run workspace directory. */
  readonly workspaceDir: string;
  /** Tools the environment offers (intersected with each module allow-list). */
  readonly availableTools?: readonly string[];
  /** Per-ticket gate feedback for bounded repair retries (U7 seam). */
  readonly gateFeedback?: Readonly<Record<string, readonly GateFeedback[]>>;
}

export interface ExecutionSchedulePlan {
  /** One node per projected ticket, in projection order. */
  readonly nodes: readonly ExecutionScheduleNode[];
  /** Tickets already completed on the ledger (pre-settled on resume). */
  readonly completed: readonly string[];
}

/**
 * Generic module contract for a ticket with no registered genome module. The
 * ticket still executes through the shared adapter contract with a conservative
 * tool allow-list and a single generic expected output.
 */
export function fallbackModuleContract(ticketId: string, title?: string): ModuleContract {
  const outputKey = `ticket.${ticketId}.output`;
  return {
    id: `ticket/${ticketId}`,
    version: '0.0.0',
    title: title ?? `Ticket ${ticketId}`,
    description: `Generic execution contract for ticket "${ticketId}" (no genome module is registered for it).`,
    requiredInputs: [],
    expectedOutputs: [outputKey],
    allowedTools: [...FALLBACK_ALLOWED_TOOLS],
    riskHint: {},
    artifactContracts: [
      {
        key: outputKey,
        kind: 'code',
        description: `Primary output of ticket "${ticketId}" in the shared run workspace.`,
        required: true,
      },
    ],
  };
}

/** Derived write scope for a module's declared outputs. */
function writeScopeForOutputs(expectedOutputs: readonly string[]): string[] {
  return expectedOutputs.map((key) => `outputs/${key}`);
}

/**
 * Convert a projected ticket DAG into schedulable execution nodes: workspace
 * directory, compiled context inputs (required inputs resolved from the
 * producing tickets' declared outputs), risk tiers, expected outputs, and
 * derived write scopes. Pure and deterministic — identical projections yield
 * identical nodes; no state is invented beyond the fallback contract for
 * module-less tickets.
 */
export function compileExecutionNodes(input: CompileExecutionNodesInput): ExecutionSchedulePlan {
  // Resolve each ticket's module (registered contract, else fallback) once.
  const contracts = new Map<string, ModuleContract>();
  for (const ticket of input.tickets) {
    const registered =
      ticket.moduleId !== undefined ? input.modules.get(ticket.moduleId) : undefined;
    contracts.set(
      ticket.ticketId,
      registered ?? fallbackModuleContract(ticket.ticketId, ticket.title),
    );
  }

  // Map each declared output key to the FIRST ticket that produces it, so
  // required inputs resolve to concrete producer references.
  const producers = new Map<string, { ticketId: string; contract?: ArtifactContract }>();
  for (const ticket of input.tickets) {
    const contract = contracts.get(ticket.ticketId);
    if (contract === undefined) {
      continue;
    }
    for (const key of contract.expectedOutputs) {
      if (!producers.has(key)) {
        producers.set(key, {
          ticketId: ticket.ticketId,
          contract: contract.artifactContracts.find((artifact) => artifact.key === key),
        });
      }
    }
  }

  const nodes: ExecutionScheduleNode[] = [];
  const completed: string[] = [];
  for (const ticket of input.tickets) {
    const module = contracts.get(ticket.ticketId);
    if (module === undefined) {
      continue;
    }
    if (ticket.state === 'completed') {
      completed.push(ticket.ticketId);
    }

    const priorArtifacts: Record<string, ArtifactRef> = {};
    for (const key of module.requiredInputs) {
      const producer = producers.get(key);
      if (producer !== undefined && producer.ticketId !== ticket.ticketId) {
        priorArtifacts[key] = {
          key,
          kind: producer.contract?.kind,
          summary: `Expected output "${key}" of ticket "${producer.ticketId}" in the shared run workspace.`,
        };
      }
    }

    const riskTier: RiskTier = ticket.riskTier ?? 'low';
    const title = ticket.title ?? `Ticket ${ticket.ticketId}`;
    nodes.push({
      id: ticket.ticketId,
      dependsOn: [...ticket.dependsOn],
      title,
      riskTier,
      workspaceDir: input.workspaceDir,
      compileInput: {
        runRequest: input.runRequest,
        ticket: { id: ticket.ticketId, title, moduleId: module.id, riskTier },
        moduleContract: module,
        priorArtifacts,
        riskTier,
        gateFeedback: input.gateFeedback?.[ticket.ticketId],
        availableTools: input.availableTools,
      },
      writeScope: writeScopeForOutputs(module.expectedOutputs),
      moduleId: module.id,
      expectedOutputs: [...module.expectedOutputs],
    });
  }

  return { nodes, completed };
}
