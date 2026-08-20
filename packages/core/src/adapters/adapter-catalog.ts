/**
 * Adapter catalog + run-settings adapter selection (full-factory U6).
 *
 * The catalog is the ONE lookup surface for configured execution adapters, so
 * preflight (adapter readiness check), the execution daemon's ticket executor,
 * and future setup surfaces all resolve the same adapter set. Selection follows
 * the plan's rule — "select adapters from run settings and setup detection":
 *
 *   - a run that recorded `selectedAdapter` must resolve it from the catalog
 *     (an unknown id is an explicit setup problem, never a silent fallback),
 *   - a run without a selection probes the catalog in registration order and
 *     picks the FIRST adapter whose setup probe reports available+authenticated,
 *   - when nothing is ready, selection still names a representative adapter and
 *     aggregates every candidate's probe detail so the operator sees exactly
 *     what to fix (fail closed, but explainable).
 *
 * Probing never throws: a `detectSetup` rejection is folded into a not-ready
 * setup state carrying the failure detail.
 */
import { createApiAdapter } from './api-adapter';
import { createClaudeCodeCliAdapter } from './claude-code-cli-adapter';
import { createCodexCliAdapter } from './codex-cli-adapter';
import type {
  AdapterSetupState,
  CommandRunner,
  DetectSetupOptions,
  ExecutionAdapter,
} from './execution-adapter';

/** Read API over the configured execution adapters. */
export interface AdapterCatalog {
  /** Every configured adapter, in registration (preference) order. */
  list(): readonly ExecutionAdapter[];
  /** Adapter ids, in registration order. */
  ids(): readonly string[];
  /** Lookup one adapter by its stable id. */
  get(id: string): ExecutionAdapter | undefined;
}

/** Build a catalog from already-constructed adapters (order = preference). */
export function createAdapterCatalog(adapters: readonly ExecutionAdapter[]): AdapterCatalog {
  const byId = new Map<string, ExecutionAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) {
      throw new Error(`Duplicate adapter id in catalog: ${adapter.id}.`);
    }
    byId.set(adapter.id, adapter);
  }
  return {
    list: () => [...byId.values()],
    ids: () => [...byId.keys()],
    get: (id) => byId.get(id),
  };
}

/** Options for the default (real) adapter catalog. */
export interface DefaultAdapterCatalogOptions {
  /** Injected process runner for the CLI adapters (tests inject fakes). */
  readonly runner?: CommandRunner;
  /**
   * Claude Code skills workers may invoke (opt-in; default NONE — fail
   * closed). `['*']` = any locally installed skill; names restrict guidance.
   */
  readonly claudeAllowedSkills?: readonly string[];
  /**
   * Skill names/families workers should PREFER when relevant — adapter-
   * agnostic guidance appended to ticket prompts. For Claude it only takes
   * effect once `claudeAllowedSkills` grants the Skill tool; Codex loads its
   * own skill catalog natively, so the steering always applies there.
   */
  readonly preferredSkills?: readonly string[];
}

/**
 * The default adapter set, in preference order: Codex CLI, Claude Code CLI,
 * then the hosted API stub (which reports needs-config until wired).
 */
export function createDefaultAdapterCatalog(
  options: DefaultAdapterCatalogOptions = {},
): AdapterCatalog {
  return createAdapterCatalog([
    createCodexCliAdapter({
      runner: options.runner,
      preferredSkills: options.preferredSkills,
    }),
    createClaudeCodeCliAdapter({
      runner: options.runner,
      allowedSkills: options.claudeAllowedSkills,
      preferredSkills: options.preferredSkills,
    }),
    createApiAdapter(),
  ]);
}

/** How the selected adapter was chosen. */
export type AdapterSelectionSource = 'run_settings' | 'detected';

/**
 * The outcome of adapter selection. `ready` is `true` only when a concrete
 * adapter's setup probe reported available+authenticated. When not ready the
 * result still carries the best candidate (when any) plus an operator-facing
 * `reason`/`requiredAction`, so callers can fail closed AND explain.
 */
export interface AdapterSelection {
  /** `true` when `adapter` is set and its setup probe reported ready. */
  readonly ready: boolean;
  /** The selected (or representative not-ready) adapter, when resolvable. */
  readonly adapter?: ExecutionAdapter;
  /** The setup state probed for `adapter`, when one was probed. */
  readonly setup?: AdapterSetupState;
  readonly source: AdapterSelectionSource;
  /** Why selection is not ready (unknown id, or no candidate passed setup). */
  readonly reason?: string;
  /** What the operator must do before selection can succeed. */
  readonly requiredAction?: string;
  /** Every adapter id the catalog offers. */
  readonly candidates: readonly string[];
}

/** Probe an adapter without throwing: a rejected probe is a not-ready state. */
async function probeSetup(
  adapter: ExecutionAdapter,
  options?: DetectSetupOptions,
): Promise<AdapterSetupState> {
  try {
    return await adapter.detectSetup(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      authenticated: false,
      capacity: 0,
      detail: `Setup probe failed: ${message}`,
    };
  }
}

function isReady(setup: AdapterSetupState): boolean {
  return setup.available && setup.authenticated;
}

function notReadyDetail(adapter: ExecutionAdapter, setup: AdapterSetupState): string {
  const state = !setup.available ? 'unavailable' : 'unauthenticated';
  return `${adapter.id} (${state}${setup.detail !== undefined ? `: ${setup.detail}` : ''})`;
}

/**
 * Select the execution adapter for a run from its recorded settings plus setup
 * detection. Never throws; a not-ready selection carries the reason and the
 * concrete operator action.
 */
export async function selectExecutionAdapter(
  catalog: AdapterCatalog,
  selectedAdapterId?: string,
  options?: DetectSetupOptions,
): Promise<AdapterSelection> {
  const candidates = catalog.ids();

  if (selectedAdapterId !== undefined && selectedAdapterId.length > 0) {
    const adapter = catalog.get(selectedAdapterId);
    if (adapter === undefined) {
      return {
        ready: false,
        source: 'run_settings',
        reason: `The run selected adapter "${selectedAdapterId}", which is not configured on this instance (available: ${
          candidates.length > 0 ? candidates.join(', ') : 'none'
        }).`,
        requiredAction:
          candidates.length > 0
            ? `Re-create or retry the run with one of the configured adapters (${candidates.join(', ')}), or configure "${selectedAdapterId}" on this instance.`
            : 'Configure at least one execution adapter on this instance, then retry.',
        candidates,
      };
    }
    const setup = await probeSetup(adapter, options);
    if (isReady(setup)) {
      return { ready: true, adapter, setup, source: 'run_settings', candidates };
    }
    return {
      ready: false,
      adapter,
      setup,
      source: 'run_settings',
      reason: `Selected adapter ${notReadyDetail(adapter, setup)} is not ready.`,
      requiredAction:
        setup.setupActions !== undefined && setup.setupActions.length > 0
          ? setup.setupActions.map((action) => action.title).join('; ')
          : `Complete the ${adapter.id} setup (install + authenticate), then retry.`,
      candidates,
    };
  }

  if (candidates.length === 0) {
    return {
      ready: false,
      source: 'detected',
      reason: 'No execution adapters are configured on this instance.',
      requiredAction: 'Configure at least one execution adapter, then retry.',
      candidates,
    };
  }

  const probed: { adapter: ExecutionAdapter; setup: AdapterSetupState }[] = [];
  for (const adapter of catalog.list()) {
    const setup = await probeSetup(adapter, options);
    if (isReady(setup)) {
      return { ready: true, adapter, setup, source: 'detected', candidates };
    }
    probed.push({ adapter, setup });
  }

  const first = probed[0];
  return {
    ready: false,
    adapter: first.adapter,
    setup: first.setup,
    source: 'detected',
    reason: `No configured execution adapter is ready: ${probed
      .map(({ adapter, setup }) => notReadyDetail(adapter, setup))
      .join('; ')}.`,
    requiredAction: `Complete setup for one of the configured adapters (${candidates.join(', ')}), then retry.`,
    candidates,
  };
}
