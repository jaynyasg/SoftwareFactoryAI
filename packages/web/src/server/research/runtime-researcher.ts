/**
 * Runtime researcher (full-factory U2): builds the source-adapter set for a
 * run from the runtime configuration + the run's `run.created` payload, then
 * executes the bounded research runner from `@software-factory/worker`.
 *
 * Cloud/local boundary handling (KTD5): in cloud mode a laptop-local folder is
 * NOT readable — instead of pretending, an inline "unavailable" adapter reports
 * not-configured so the runner records a setup requirement + gap.
 *
 * Workspace materialization (full-factory U4): when the run's workspace has
 * been materialized (`workspace.checkout_completed` / `workspace.local_bound`
 * on the ledger), repo/folder research scans the REAL checkout/bound path —
 * contained inside it, traversal rejected. An un-materialized GitHub repo
 * keeps the honest "materialize first" unavailable shape.
 *
 * Fail-closed defaults: no web-search provider is bundled in U2, so hosted
 * search research reports setup-required instead of fabricating results; the
 * documentation adapter only activates when SF_RESEARCH_DOC_URLS is set AND
 * the policy allows network sources.
 */
import { projectKnowledgeIndex } from '@software-factory/core';
import type { EventStore, ResearchBudget, RunCreatedPayload } from '@software-factory/core';
import {
  createDocumentationAdapter,
  createHttpResearchFetcher,
  createPrdAdapter,
  createRepoScanAdapter,
  createWebSearchAdapter,
  projectWorkspace,
  runResearch,
} from '@software-factory/worker';
import type {
  ResearchAdapterSetup,
  ResearchFetcher,
  ResearchRunResult,
  ResearchSourceAdapter,
  WebSearchProvider,
} from '@software-factory/worker';
import { runCreatedPayload } from '../run-created';
import { resolveResearchRuntimeConfig } from '../runtime';
import type { RuntimeConfig } from '../runtime';

/** Input accepted by the research trigger (route body / U3 run flow). */
export interface ResearchTriggerInput {
  /** Objective override; defaults to the run's title/prompt/PRD reference. */
  readonly objective?: string;
  /** Budget overrides for this pass. */
  readonly budget?: ResearchBudget;
}

/**
 * A researcher bound to the server runtime: executes one research pass for a
 * run, emitting research/knowledge events into the given store.
 */
export type RunResearcher = (
  store: EventStore,
  runId: string,
  input: ResearchTriggerInput,
) => Promise<ResearchRunResult>;

/** Options for building the runtime researcher (hooks injectable for tests). */
export interface RuntimeResearcherOptions {
  /** Runtime config (mode + research policy/budget defaults). */
  readonly runtime?: RuntimeConfig;
  readonly clock?: () => number;
  /** Injectable web-search provider (default: none — fail closed). */
  readonly searchProvider?: WebSearchProvider;
  /** Injectable documentation fetcher (default: `fetch`-backed). */
  readonly fetcher?: ResearchFetcher;
}

/** An adapter that honestly reports a source as unavailable on this runtime. */
function createUnavailableSourceAdapter(
  id: string,
  kind: ResearchSourceAdapter['kind'],
  detail: string,
  actionTitle: string,
): ResearchSourceAdapter {
  const setup: ResearchAdapterSetup = {
    configured: false,
    requiresCredentials: false,
    credentialsPresent: true,
    detail,
    setupAction: { id: `${id}.setup`, title: actionTitle, description: detail },
  };
  return {
    id,
    kind,
    detectSetup: () => Promise.resolve(setup),
    discover: () => Promise.reject(new Error(detail)),
    read: () => Promise.reject(new Error(detail)),
  };
}

/**
 * Build the default runtime researcher. Reads the run's `run.created` payload
 * for source context, assembles adapters, seeds prior cross-run knowledge, and
 * runs the bounded research pass.
 */
export function createRuntimeResearcher(options: RuntimeResearcherOptions = {}): RunResearcher {
  const research = options.runtime?.research ?? resolveResearchRuntimeConfig();
  const mode = options.runtime?.mode ?? 'local';
  const clock = options.clock ?? Date.now;

  return async (store, runId, input) => {
    const events = await store.readRun(runId);
    const payload: RunCreatedPayload = runCreatedPayload(events);

    const objective =
      input.objective ??
      payload.title ??
      payload.prompt ??
      payload.prdRef ??
      'Research the requested build.';

    const adapters: ResearchSourceAdapter[] = [];

    // Materialized workspace state (U4): a completed checkout / bound folder
    // lets research scan the REAL workspace instead of reporting unavailable.
    const workspaceState = projectWorkspace(events, runId);
    const materialized =
      workspaceState.status === 'ready' ? workspaceState.workspace : undefined;

    // Local folder: readable only in local mode, and only as its own boundary.
    // A U4-bound folder scans the resolved bound path (boundary-checked at
    // bind time); an unbound folder keeps the pre-U4 direct-scan behavior.
    if (payload.localFolder !== undefined && payload.localFolder.length > 0) {
      if (mode === 'cloud') {
        adapters.push(
          createUnavailableSourceAdapter(
            'local-folder',
            'local_folder',
            `Local folder "${payload.localFolder}" is not readable from the cloud runtime. Provide a GitHub repository or upload the PRD content instead.`,
            'Provide a cloud-readable source',
          ),
        );
      } else {
        adapters.push(
          createRepoScanAdapter({
            workspaceRoot:
              materialized?.kind === 'local_folder' ? materialized.path : payload.localFolder,
            kind: 'local_folder',
          }),
        );
      }
    }

    // GitHub repos: a materialized checkout (U4) is scanned for real evidence;
    // otherwise the repo honestly needs workspace materialization first.
    if (payload.githubRepo !== undefined && payload.githubRepo.length > 0) {
      if (materialized?.kind === 'repo_checkout') {
        adapters.push(
          createRepoScanAdapter({
            workspaceRoot: materialized.checkoutPath,
            kind: 'repo_scan',
          }),
        );
      } else {
        adapters.push(
          createUnavailableSourceAdapter(
            'github-repo',
            'repo_scan',
            `GitHub repository "${payload.githubRepo}" is not materialized as a workspace on this instance yet; repository checkout happens during workspace materialization (POST /api/runs/:id/workspace).`,
            'Materialize the repository workspace',
          ),
        );
      }
    }

    // PRD text / reference metadata.
    if (
      (payload.prdText !== undefined && payload.prdText.length > 0) ||
      (payload.prdRef !== undefined && payload.prdRef.length > 0)
    ) {
      adapters.push(createPrdAdapter({ prdText: payload.prdText, prdRef: payload.prdRef }));
    }

    // Configured documentation URLs (network class — gated by policy below).
    if (research.documentationUrls.length > 0) {
      adapters.push(
        createDocumentationAdapter({
          urls: research.documentationUrls,
          fetcher: options.fetcher ?? createHttpResearchFetcher(),
        }),
      );
    }

    // External web search: always present so a missing provider is VISIBLE as
    // a setup requirement/gap (fail closed) rather than silently absent.
    adapters.push(createWebSearchAdapter({ provider: options.searchProvider }));

    // Seed cross-run prior knowledge from the whole ledger.
    const priorKnowledge = projectKnowledgeIndex(await store.readAll());

    return runResearch(
      {
        runId,
        objective,
        prompt: payload.prompt,
        prdText: payload.prdText,
        prdRef: payload.prdRef,
        localFolder: payload.localFolder,
        githubRepo: payload.githubRepo,
      },
      {
        store,
        adapters,
        policy: { allowNetwork: research.allowNetwork },
        budget: {
          maxSources: input.budget?.maxSources ?? research.maxSources,
          maxDurationMs: input.budget?.maxDurationMs ?? research.maxDurationMs,
        },
        priorKnowledge,
        clock,
      },
    );
  };
}
