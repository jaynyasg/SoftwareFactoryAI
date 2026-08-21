/**
 * AI-backed run planner (planner generalization).
 *
 * The deterministic V1 planner recognizes exactly one built-in intent; every
 * other request became a triage-only plan that could never execute. This
 * planner closes that gap: for `unknown` intents with a real prompt/PRD it
 * asks the operator's authenticated Claude Code CLI to PROPOSE a ticket DAG,
 * validates the proposal fail-closed in core (`validateAiPlanProposal`), and
 * emits the accepted plan onto the ledger exactly like any other plan.
 *
 * Safety properties preserved:
 *  - The recognized built-in intent still plans deterministically (unchanged).
 *  - `underspecified` requests never reach the AI — human triage, as before.
 *  - ANY failure (CLI missing, timeout, malformed JSON, invalid DAG, low
 *    confidence) falls back to the human-triage plan with an explicit
 *    `ai-plan-fallback` decision recording WHY — never a guessed build.
 *  - The AI runs ONCE at planning time; the recorded events stay the only
 *    source of truth, so replay is as deterministic as ever.
 */
import { tmpdir } from 'node:os';
import {
  createNodeCommandRunner,
  emitPlan,
  loadModuleRegistry,
  parseRunRequest,
  planFromAiProposal,
  planRun,
  scrubNestedSessionEnv,
  validateAiPlanProposal,
} from '@software-factory/core';
import type {
  AiPlanValidation,
  CommandRunner,
  ModuleRegistry,
  RunPlan,
  RunRequest,
  SupervisorDecision,
} from '@software-factory/core';
import { resolveGenomeDir } from './planner';
import type { RunPlanner } from './planner';

/** Bounded planning-call budget: a hung CLI must not hang run creation. */
const PLAN_TIMEOUT_MS = 240_000;

/** Cap the operator text embedded in the planning prompt. */
const MAX_REQUEST_TEXT = 24_000;

/**
 * Asks an AI supervisor for a raw plan proposal (JSON-parsed, unvalidated).
 * Throws on any transport/parse failure — the planner falls back to triage.
 */
export type AiPlanClient = (request: RunRequest) => Promise<unknown>;

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/** Build the supervisor planning prompt for one normalized run request. */
export function buildPlanningPrompt(request: RunRequest): string {
  const parts = [
    'You are the run supervisor of an autonomous software factory. Decompose the',
    "operator's request into a build-ticket DAG that workers can execute.",
    '',
    'Output ONLY a JSON object (no markdown fences, no commentary) of this exact shape:',
    '{',
    '  "confidence": <number 0..1>,',
    '  "rationale": "<one or two sentences on how you decomposed the request>",',
    '  "tickets": [',
    '    {',
    '      "id": "<kebab-case-unique-id>",',
    '      "title": "<short imperative title>",',
    '      "kind": "<one of: scaffold | data-model | api-contract | marketplace-ui | ai-brief | provider-proposals | review-acceptance | admin-status | tests | preview | package | deploy>",',
    '      "description": "<what the worker must build and how completion is judged>",',
    '      "dependsOn": ["<ids of prerequisite tickets>"],',
    '      "riskTier": "<low | medium | high>"',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- 3 to 16 tickets. Every dependsOn id must reference another ticket in the list. No cycles.',
    '- Kinds are semantic labels: scaffold = project setup, data-model = schemas/storage,',
    '  api-contract = backend endpoints/contracts, marketplace-ui = user-facing UI,',
    '  ai-brief = AI/LLM-powered features, tests = test suites, preview = a runnable',
    '  local preview, package = packaging the deliverable.',
    '- Include a "deploy" ticket ONLY if the request explicitly asks for hosting/deployment.',
    '- If the request lists multiple deliverables, plan them as dependent stages of ONE dag.',
    '- Set confidence below 0.6 only if the request is too vague to decompose safely —',
    '  a human triage will take over in that case.',
    '',
    'Operator request:',
    `Title: ${request.title}`,
  ];
  if (request.prompt.length > 0) {
    parts.push(`Prompt: ${truncate(request.prompt, MAX_REQUEST_TEXT)}`);
  }
  if (request.prdText !== undefined) {
    parts.push(`PRD: ${truncate(request.prdText, MAX_REQUEST_TEXT)}`);
  }
  if (request.prdRef !== undefined) {
    parts.push(`PRD reference (not readable here — plan from the prompt/PRD text): ${request.prdRef}`);
  }
  return parts.join('\n');
}

/**
 * Extract the proposal object from the CLI stdout. `claude --print
 * --output-format json` wraps the answer in a result envelope whose `result`
 * field is the answer text; the text itself should be bare JSON but fences and
 * prose margins are stripped defensively.
 */
export function parsePlanClientOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error('The planning CLI produced no output.');
  }
  let text = trimmed;
  try {
    const envelope: unknown = JSON.parse(trimmed);
    if (typeof envelope === 'object' && envelope !== null) {
      const result = (envelope as Record<string, unknown>).result;
      if (typeof result === 'string') {
        text = result.trim();
      } else if ((envelope as Record<string, unknown>).tickets !== undefined) {
        return envelope;
      }
    }
  } catch {
    // stdout was not a JSON envelope — treat it as the answer text itself.
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('The planning output contains no JSON object.');
  }
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

export interface ClaudeCliPlanClientOptions {
  readonly runner?: CommandRunner;
  /** Executable name (defaults to `claude`). */
  readonly command?: string;
  readonly timeoutMs?: number;
}

/**
 * The default plan client: the operator's authenticated Claude Code CLI in
 * non-interactive mode. The prompt rides on stdin (no argv length/quoting
 * limits) and the call runs from the OS temp dir so the factory's own repo
 * context never leaks into planning.
 */
export function createClaudeCliPlanClient(options: ClaudeCliPlanClientOptions = {}): AiPlanClient {
  const runner = options.runner ?? createNodeCommandRunner();
  const command = options.command ?? 'claude';
  const timeoutMs = options.timeoutMs ?? PLAN_TIMEOUT_MS;

  return async (request) => {
    const result = await runner.run(command, ['--print', '--output-format', 'json'], {
      cwd: tmpdir(),
      input: buildPlanningPrompt(request),
      timeoutMs,
      // Nested-session guard: a server started from inside a Claude Code
      // session must not hand the planning CLI the host's proxy/session env.
      env: scrubNestedSessionEnv(),
    });
    if (result.code !== 0) {
      throw new Error(
        `Planning CLI exited ${result.code}: ${truncate(result.stderr.trim() || result.stdout.trim(), 400)}`,
      );
    }
    return parsePlanClientOutput(result.stdout);
  };
}

export interface AiRunPlannerOptions {
  /** Genome directory for the deterministic registry. */
  readonly genomeDir?: string;
  /** Injected plan client (tests). Defaults to the Claude CLI client. */
  readonly client?: AiPlanClient;
  /** Label recorded in the classify-intent decision. */
  readonly plannerSource?: string;
}

/** Compose the triage fallback plan with an explicit ai-plan-fallback decision. */
function withFallbackDecision(plan: RunPlan, reason: string): RunPlan {
  const decision: SupervisorDecision = {
    decision: 'ai-plan-fallback',
    rationale: `AI planning did not produce an executable plan (${reason}); routing to human triage instead.`,
    confidence: 0.2,
  };
  return { ...plan, decisions: [...plan.decisions, decision] };
}

/**
 * The AI-backed `RunPlanner`: deterministic for the built-in intent, triage
 * for underspecified requests, AI-proposed (validated, fail-closed) for
 * everything else.
 */
export function createAiRunPlanner(options: AiRunPlannerOptions = {}): RunPlanner {
  const client = options.client ?? createClaudeCliPlanClient();
  const plannerSource = options.plannerSource ?? 'claude-code-cli';
  let registryPromise: Promise<ModuleRegistry> | undefined;

  const loadRegistry = (): Promise<ModuleRegistry> => {
    if (registryPromise === undefined) {
      const genomeDir = options.genomeDir ?? resolveGenomeDir();
      registryPromise = loadModuleRegistry(genomeDir).then((loaded) => loaded.registry);
      registryPromise.catch(() => {
        registryPromise = undefined;
      });
    }
    return registryPromise;
  };

  return async (sink, runId, input) => {
    const registry = await loadRegistry();
    const request = parseRunRequest({
      prompt: input.prompt,
      prdRef: input.prdRef,
      prdText: input.prdText,
      title: input.title,
      requestedWorkerCap: input.requestedWorkerCap,
      reviewMode: input.reviewMode,
      mode: input.mode,
    });

    // Built-in intent and underspecified requests: unchanged deterministic paths.
    if (request.intent !== 'unknown') {
      await emitPlan(sink, runId, planRun(request, registry, input.research));
      return;
    }

    let plan: RunPlan;
    try {
      const raw = await client(request);
      const validation: AiPlanValidation = validateAiPlanProposal(raw);
      if (!validation.ok) {
        plan = withFallbackDecision(planRun(request, registry, input.research), validation.reason);
      } else {
        const aiPlan = planFromAiProposal(request, validation.proposal, plannerSource);
        plan =
          aiPlan !== null
            ? aiPlan
            : withFallbackDecision(
                planRun(request, registry, input.research),
                `proposal confidence ${validation.proposal.confidence} is below the execution threshold`,
              );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      plan = withFallbackDecision(planRun(request, registry, input.research), message);
    }
    await emitPlan(sink, runId, plan);
  };
}
