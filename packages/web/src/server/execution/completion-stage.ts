/**
 * Run completion stage: preview, package, provenance, and deploy (U8).
 *
 * This is the stage the scheduler-backed ticket executor runs AFTER the
 * post-run gate stage passes and BEFORE it emits `run.completed` (the seam
 * marked in `ticket-executor.ts` / `gate-stages.ts`). Per completed run it:
 *
 *   1. PREVIEW — when the run planned a `preview` ticket and a preview command
 *      is configured, starts the generated app through the preview server and
 *      records `preview.starting -> health_pending -> ready|failed`. Without a
 *      configured command the preview stays honestly un-attempted (idle): it
 *      lowers artifact confidence and holds the deploy precondition, but never
 *      fails the local run. The `local preview health check` gate expectation
 *      from the build contract is satisfied HERE (not as a post-run command
 *      gate) because the health check needs the preview server this stage owns.
 *   2. PACKAGE + PROVENANCE — when the run planned a `package` ticket, packages
 *      the workspace as a committed git repo with `PROVENANCE.json`,
 *      `HANDOFF.md`, the ledger excerpt, and the tests summary, emitting
 *      `package.created`, `artifact.created`, and `artifact.confidence_computed`.
 *      Packaging is IDEMPOTENT per run (an existing `package.created`
 *      short-circuits), so a restart/replay/deploy-retry never re-packages.
 *   3. DEPLOY — when the run planned a `deploy` ticket, runs the Render deploy
 *      completion: git destination -> push -> provider -> hosted health. The
 *      hosted URL is projected ONLY on `deploy.hosted_ready` (R29). Missing
 *      deploy setup PAUSES the deploy (`deploy.setup_required` + a
 *      `deploy_setup` intervention) and migration/provider/health failures
 *      surface retryable deploy states (`retry_choice` intervention) — neither
 *      ever fails the locally-successful run (R30). Retrying execution
 *      re-enters this stage; packaging is skipped and deploy re-attempts.
 *
 * `createCompletionStage` takes injectable seams (packager, deployer, preview
 * runner) so tests are deterministic with no git/network/processes;
 * `createRuntimeCompletionStage` is the production wiring the server entry
 * points use (real packager, Render client from the environment, preview
 * server when configured).
 */
import {
  createNodeCommandRunner,
  derivePreviewFromEvents,
  projectRun,
  projectTickets,
} from '@software-factory/core';
import type {
  EventStore,
  FactoryEvent,
  ProvenanceDeployConfig,
  TicketProjection,
} from '@software-factory/core';
import {
  completeRunDeploy,
  createCommandGitRemoteClient,
  createRenderClient,
  deriveDeployPreconditions,
  generateRenderConfig,
  packageCompletedRun,
  startPreview,
} from '@software-factory/worker';
import type {
  CompleteRunDeployDeps,
  CompleteRunDeployParams,
  CompleteRunDeployResult,
  PackageCompletedRunDeps,
  PackageCompletedRunParams,
  PackageCompletedRunResult,
} from '@software-factory/worker';
import {
  filterInterventions,
  projectInterventions,
  raiseIntervention,
  resolveIntervention,
} from './interventions';
import { resolveDeployRuntimeConfig } from '../runtime';
import type { DeployRuntimeConfig, RuntimeConfig } from '../runtime';

/** Context the executor hands to the completion stage. */
export interface RunCompletionContext {
  readonly runId: string;
  readonly workspaceDir: string;
  /** The shared ledger store (heartbeat-wrapped by the executor). */
  readonly store: EventStore;
  readonly signal: AbortSignal;
}

/**
 * The completion-stage outcome:
 *  - `ok`     — local completion succeeded; `notes` describe package/deploy
 *    state and join the `run.completed` summary. Deploy pauses/failures land
 *    here (they are retryable deploy STATE, not run failures — R30).
 *  - `failed` — packaging itself failed (retryable; no `run.completed`).
 *  - `yielded`— aborted mid-stage (requeued for a safe resume).
 */
export type RunCompletionResult =
  | { readonly status: 'ok'; readonly notes: readonly string[] }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'yielded'; readonly reason: string };

/** The seam the executor calls; absent = no completion stage (pre-U8 tests). */
export interface ExecutorCompletionStage {
  run(ctx: RunCompletionContext): Promise<RunCompletionResult>;
}

/* ----------------------------------------------------------------------------
 * Injectable seams
 * ------------------------------------------------------------------------- */

/** Packager seam (production: `packageCompletedRun` with a real git runner). */
export type CompletionPackager = (
  params: PackageCompletedRunParams,
  deps: Pick<PackageCompletedRunDeps, 'store'>,
) => Promise<PackageCompletedRunResult>;

/** Deployer seam (production: `completeRunDeploy` with a real Render client). */
export type CompletionDeployer = (
  params: CompleteRunDeployParams,
  deps: Pick<CompleteRunDeployDeps, 'store' | 'signal'>,
) => Promise<CompleteRunDeployResult>;

/** Preview outcome the (injectable) preview runner reports. */
export interface CompletionPreviewOutcome {
  readonly attempted: boolean;
  readonly healthy: boolean;
  readonly url?: string;
  readonly reason?: string;
}

/** Preview seam (production: `startPreview` when a command is configured). */
export type CompletionPreviewRunner = (
  ctx: RunCompletionContext,
) => Promise<CompletionPreviewOutcome>;

export interface CompletionStageOptions {
  /** Deploy runtime config (default: resolved from the environment). */
  readonly deployConfig?: DeployRuntimeConfig;
  readonly packager: CompletionPackager;
  /** Absent = deploy never attempted (records setup-required when planned). */
  readonly deployer: CompletionDeployer;
  /** Absent = preview honestly un-attempted. */
  readonly preview?: CompletionPreviewRunner;
  readonly clock?: () => number;
}

/* ----------------------------------------------------------------------------
 * Stage implementation
 * ------------------------------------------------------------------------- */

function plansTicket(tickets: TicketProjection, ticketId: string): boolean {
  return tickets.byId[ticketId] !== undefined;
}

/**
 * Ledger-derived deploy attempt counter: how many deploy pause/failure events
 * the run has recorded so far. Deploy interventions are scoped by this count
 * so a recurring failure AFTER an earlier resolved intervention opens a NEW
 * entry (the raise/resolve appends are idempotent per interventionId).
 */
function countDeployFailureEvents(events: readonly FactoryEvent[]): number {
  let count = 0;
  for (const event of events) {
    switch (event.type) {
      case 'deploy.setup_required':
      case 'deploy.config_invalid':
      case 'deploy.provider_failed':
      case 'deploy.migration_failed':
      case 'deploy.health_failed':
        count += 1;
        break;
      default:
        break;
    }
  }
  return count;
}

/** Human summary of a deploy outcome for the run-completed note. */
function deployNote(result: CompleteRunDeployResult): string {
  const outcome = result.outcome;
  switch (outcome.status) {
    case 'hosted_ready':
      return `Deploy hosted and healthy at ${outcome.url}.`;
    case 'setup_required':
      return `Deploy paused (setup required): ${outcome.action}`;
    case 'config_invalid':
      return `Deploy blocked on invalid config: ${outcome.reason}`;
    case 'provider_failed':
    case 'migration_failed':
    case 'timeout':
    case 'health_failed':
      return `Deploy did not reach hosted-ready (${outcome.status}): ${outcome.reason} Retry execution to re-attempt the deploy.`;
    default: {
      const exhaustive: never = outcome;
      return String(exhaustive);
    }
  }
}

/** Build the completion stage from injectable seams. */
export function createCompletionStage(options: CompletionStageOptions): ExecutorCompletionStage {
  const clock = options.clock;

  return {
    async run(ctx: RunCompletionContext): Promise<RunCompletionResult> {
      const deployConfig = options.deployConfig ?? resolveDeployRuntimeConfig();
      const notes: string[] = [];
      const events = await ctx.store.readRun(ctx.runId);
      const tickets: TicketProjection = projectTickets(events, ctx.runId);

      /* 1. Preview (only when planned; only when a runner is wired). */
      const plansPreview = plansTicket(tickets, 'preview');
      const alreadyPreviewed = derivePreviewFromEvents(events).status === 'ready';
      if (plansPreview && !alreadyPreviewed && options.preview !== undefined) {
        const preview = await options.preview(ctx);
        if (preview.attempted) {
          notes.push(
            preview.healthy
              ? `Local preview healthy at ${preview.url ?? 'the configured URL'}.`
              : `Local preview did not pass health: ${preview.reason ?? 'unknown reason'}.`,
          );
        }
      }
      if (ctx.signal.aborted) {
        return { status: 'yielded', reason: 'Execution aborted during the preview stage.' };
      }

      /* 2. Package + provenance (idempotent per run). */
      const plansPackage = plansTicket(tickets, 'package');
      const plansDeploy = plansTicket(tickets, 'deploy');
      let packagePath: string | undefined;
      let packageCommit: string | undefined;
      if (plansPackage) {
        // Re-read so preview events recorded above feed provenance/confidence.
        const currentEvents = await ctx.store.readRun(ctx.runId);
        const previewView = derivePreviewFromEvents(currentEvents);
        const deployConfigSummary: ProvenanceDeployConfig | undefined = plansDeploy
          ? summarizeDeployConfig()
          : undefined;
        let packaged: PackageCompletedRunResult;
        try {
          packaged = await options.packager(
            {
              runId: ctx.runId,
              workspaceDir: ctx.workspaceDir,
              run: projectRun(currentEvents, ctx.runId),
              tickets: projectTickets(currentEvents, ctx.runId),
              events: currentEvents,
              deployConfig: deployConfigSummary,
              previewStatus: { status: previewView.status, url: previewView.url },
              signal: ctx.signal,
              clock,
            },
            { store: ctx.store },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.signal.aborted) {
            return { status: 'yielded', reason: `Execution aborted while packaging: ${message}` };
          }
          return { status: 'failed', reason: `Packaging the completed run failed: ${message}` };
        }
        packagePath = packaged.descriptor.path;
        packageCommit = packaged.descriptor.commit;
        notes.push(
          packaged.alreadyPackaged
            ? `Package already exists at ${packaged.descriptor.path} (packaging skipped).`
            : `Packaged ${packaged.artifactId} at ${packaged.descriptor.path} (commit ${packaged.descriptor.commit}).`,
        );
      }

      /* 3. Deploy (only when planned; pauses/failures never fail the run). */
      if (plansDeploy && packagePath !== undefined) {
        const deployEvents = await ctx.store.readRun(ctx.runId);
        const preconditions = deriveDeployPreconditions(deployEvents);
        const github =
          deployConfig.githubOwner !== undefined && deployConfig.githubRepo !== undefined
            ? { owner: deployConfig.githubOwner, repo: deployConfig.githubRepo }
            : undefined;
        const result = await options.deployer(
          {
            runId: ctx.runId,
            artifactId: 'app',
            packagePath,
            commit: packageCommit ?? 'unknown',
            preconditions,
            github,
            allowTemporaryRepo: deployConfig.allowTemporaryRepo,
            render: {
              serviceId: deployConfig.renderServiceId,
              apiKeyPresent: deployConfig.renderApiKeyPresent,
            },
            hostedUrl: deployConfig.hostedUrl,
            clock,
          },
          { store: ctx.store, signal: ctx.signal },
        );
        notes.push(deployNote(result));
        const outcome = result.outcome;
        if (outcome.status === 'hosted_ready') {
          // A successful deploy resolves any deploy-stage interventions a
          // previous paused/failed attempt raised, so the queue never carries
          // stale entries for a hosted-and-healthy run.
          const openDeploy = filterInterventions(
            projectInterventions(await ctx.store.readRun(ctx.runId)),
            { runId: ctx.runId, blockingStage: 'deploy', openOnly: true },
          );
          for (const intervention of openDeploy) {
            await resolveIntervention(ctx.store, intervention, {
              resolution: 'deploy_succeeded',
              note: `Deploy reached hosted-ready at ${outcome.url}.`,
            });
          }
        } else {
          // Interventions are scoped by a LEDGER-DERIVED deploy attempt
          // counter (the attempt-scoped pattern the daemon/preflight use):
          // a recurring deploy failure after a resolved earlier one raises a
          // NEW open entry instead of deduplicating into the resolved id and
          // becoming invisible to the operator.
          const deployAttempt = countDeployFailureEvents(await ctx.store.readRun(ctx.runId));
          if (outcome.status === 'setup_required') {
            await raiseIntervention(ctx.store, {
              runId: ctx.runId,
              interventionId: `${ctx.runId}:deploy:setup:${deployAttempt}`,
              kind: 'deploy_setup',
              blockingStage: 'deploy',
              reason:
                'Deploy is paused pending setup; the local build, package, and provenance are complete and preserved.',
              requiredAction: `${outcome.action} Then retry execution (POST /api/runs/:id/retry) to re-attempt the deploy.`,
            });
          } else {
            await raiseIntervention(ctx.store, {
              runId: ctx.runId,
              interventionId: `${ctx.runId}:deploy:retry:${deployAttempt}`,
              kind: 'retry_choice',
              blockingStage: 'deploy',
              reason: `Deploy did not reach hosted-ready (${outcome.status}): ${outcome.reason}`,
              requiredAction:
                'Read the recorded deploy evidence, fix the cause, then retry execution (POST /api/runs/:id/retry) to re-attempt the deploy. The local package and provenance are preserved.',
            });
          }
        }
      }
      if (ctx.signal.aborted) {
        return { status: 'yielded', reason: 'Execution aborted during the completion stage.' };
      }

      return { status: 'ok', notes };
    },
  };
}

/** The deploy-config summary recorded into provenance (no secrets). */
function summarizeDeployConfig(): ProvenanceDeployConfig {
  const generated = generateRenderConfig();
  const web = generated.blueprint.services[0];
  return {
    provider: 'render',
    serviceName: web?.name,
    databaseName: generated.blueprint.databases[0]?.name,
    healthCheckPath: web?.healthCheckPath,
    buildCommand: web?.buildCommand,
    startCommand: web?.startCommand,
    blueprint: generated.yaml,
  };
}

/* ----------------------------------------------------------------------------
 * Production wiring
 * ------------------------------------------------------------------------- */

export interface RuntimeCompletionStageOptions {
  readonly runtime?: RuntimeConfig;
  readonly clock?: () => number;
}

/**
 * The production completion stage: real git packaging, a Render client
 * authenticated from the environment (the key value never enters config or
 * evidence), a command-backed git remote client, and — when a preview command
 * is configured — the real preview server with a fetch health probe.
 */
export function createRuntimeCompletionStage(
  options: RuntimeCompletionStageOptions = {},
): ExecutorCompletionStage {
  const deployConfig = options.runtime?.deploy ?? resolveDeployRuntimeConfig();
  const runner = createNodeCommandRunner();

  const packager: CompletionPackager = (params, deps) =>
    packageCompletedRun(params, { store: deps.store, runner });

  const deployer: CompletionDeployer = async (params, deps) => {
    const apiKey = process.env.SF_RENDER_API_KEY ?? process.env.RENDER_API_KEY;
    // TODO: surface `provenanceDestinationOf(result.gitDestination)` in the
    // (already-written) provenance package once a provenance-update seam
    // exists; the resolved destination is available on the returned result.
    return completeRunDeploy(params, {
      store: deps.store,
      signal: deps.signal,
      renderClient: createRenderClient({ apiKey }),
      gitClient: createCommandGitRemoteClient(runner),
    });
  };

  const preview: CompletionPreviewRunner | undefined =
    deployConfig.previewCommand !== undefined && deployConfig.previewUrl !== undefined
      ? async (ctx) => {
          const [command, ...args] = (deployConfig.previewCommand ?? '').split(/\s+/);
          const url = deployConfig.previewUrl ?? '';
          const result = await startPreview(
            {
              runId: ctx.runId,
              command,
              args,
              cwd: ctx.workspaceDir,
              url,
              healthCheck: async ({ signal }) => {
                try {
                  const response = await fetch(url, { signal });
                  return response.ok;
                } catch {
                  return false;
                }
              },
            },
            { store: ctx.store, runner, clock: options.clock },
          );
          // The preview evidence lives on the ledger; the long-running process
          // is stopped once health is recorded (deploy health is hosted-side).
          await result.stop();
          return result.ok
            ? { attempted: true, healthy: true, url: result.url }
            : { attempted: true, healthy: false, reason: result.reason };
        }
      : undefined;

  return createCompletionStage({
    deployConfig,
    packager,
    deployer,
    preview,
    clock: options.clock,
  });
}
