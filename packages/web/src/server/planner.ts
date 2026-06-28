/**
 * Run-creation planner (the U10 "run flow").
 *
 * After a run's `run.created` event is appended, the backend plans the run into
 * the SAME store so that `software-factory run` and the web UI both show a real
 * ticket DAG. Planning is the U4 supervisor pipeline:
 *
 *   parseRunRequest(input) -> planRun(request, registry) -> emitPlan(sink, ...)
 *
 * `emitPlan` is idempotent (stable idempotency keys), so re-creating a run with
 * the same idempotency key never duplicates supervisor/ticket/plan events.
 *
 * The genome directory is resolved from the server (walk up to the workspace
 * root, then `factory-genome/v1`), overridable via `SF_GENOME_DIR` or an
 * explicit `genomeDir` option, and the registry is loaded once and cached. This
 * keeps live worker execution OUT of the run flow: V1 creates a planned DAG and
 * stops there; running Codex/Claude adapters stays optional/manual (U5).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_GENOME_VERSION,
  GENOME_DIRNAME,
  emitPlan,
  loadModuleRegistry,
  parseRunRequest,
  planRun,
} from '@software-factory/core';
import type { ModuleRegistry, PlanEventSink, ReviewMode } from '@software-factory/core';

/** The intake fields a plan needs (a subset of the `run.created` payload). */
export interface RunPlanInput {
  readonly prompt?: string;
  readonly prdRef?: string;
  readonly prdText?: string;
  readonly title?: string;
  readonly requestedWorkerCap?: number;
  readonly reviewMode?: ReviewMode;
}

/**
 * Plans a freshly-created run into the store. Implementations MUST be idempotent
 * with respect to `runId` (re-planning the same run appends no duplicate events).
 */
export type RunPlanner = (sink: PlanEventSink, runId: string, input: RunPlanInput) => Promise<void>;

/**
 * Resolve the genome directory: `SF_GENOME_DIR` wins; otherwise walk up from the
 * current working directory to the pnpm workspace root and append
 * `factory-genome/v1` (mirrors how the runtime `.factory/` dir is resolved).
 */
export function resolveGenomeDir(version: string = DEFAULT_GENOME_VERSION): string {
  const override = process.env.SF_GENOME_DIR;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return join(dir, GENOME_DIRNAME, version);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return join(process.cwd(), GENOME_DIRNAME, version);
}

export interface GenomePlannerOptions {
  /** Genome directory to load. Defaults to `resolveGenomeDir()`. */
  readonly genomeDir?: string;
}

/**
 * The default genome-backed planner. Loads + validates the genome registry once
 * (lazily, on first run creation) and caches it; every subsequent plan reuses
 * the cached registry. A failed genome load rejects the returned promise so the
 * caller can surface the error rather than silently skipping planning.
 */
export function createGenomePlanner(options: GenomePlannerOptions = {}): RunPlanner {
  let registryPromise: Promise<ModuleRegistry> | undefined;

  const loadRegistry = (): Promise<ModuleRegistry> => {
    if (registryPromise === undefined) {
      const genomeDir = options.genomeDir ?? resolveGenomeDir();
      registryPromise = loadModuleRegistry(genomeDir).then((loaded) => loaded.registry);
      // If the load fails, clear the cache so a later attempt can retry.
      registryPromise.catch(() => {
        registryPromise = undefined;
      });
    }
    return registryPromise;
  };

  return async (sink, runId, input) => {
    const registry = await loadRegistry();
    const request = parseRunRequest(input);
    const plan = planRun(request, registry);
    await emitPlan(sink, runId, plan);
  };
}
