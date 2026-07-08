/**
 * Research budgets (full-factory U2).
 *
 * Research must never become unbounded browsing. Every pass runs under a
 * budget covering effort (total sources), elapsed time, and per-source-class
 * counts. The tracker is checked BEFORE each source is consulted; when a rule
 * trips, the runner stops consuming that class (or the whole pass) and records
 * an explicit unresolved gap instead of silently truncating.
 *
 * The tracker takes an injected clock so tests are deterministic.
 */
import type { ResearchBudget, ResearchSourceKind } from '@software-factory/core';

/** Full budget configuration (extends the ledger-recorded `ResearchBudget`). */
export interface ResearchBudgetConfig extends ResearchBudget {
  /** Max sources read across the whole pass. */
  readonly maxSources?: number;
  /** Max elapsed wall-clock ms for the whole pass. */
  readonly maxDurationMs?: number;
  /** Per-source-class read caps (e.g. `{ web_search: 3 }`). */
  readonly maxSourcesPerKind?: Readonly<Partial<Record<ResearchSourceKind, number>>>;
}

/** Defaults applied when a budget dimension is not configured. */
export const DEFAULT_RESEARCH_BUDGET: Required<
  Pick<ResearchBudgetConfig, 'maxSources' | 'maxDurationMs'>
> = {
  maxSources: 12,
  maxDurationMs: 120_000,
};

/** Which budget rule stopped further reads. */
export type BudgetStopRule = 'max_sources' | 'max_duration' | 'max_sources_per_kind';

/** A recorded budget stop (unique per rule+detail). */
export interface BudgetStop {
  readonly rule: BudgetStopRule;
  readonly detail: string;
  /**
   * `true` when the whole pass must stop (global rules); `false` when only the
   * offending source class is capped and other classes may continue.
   */
  readonly global: boolean;
}

/** Tracks budget consumption during one research pass. */
export interface ResearchBudgetTracker {
  /** The resolved budget the tracker enforces. */
  readonly budget: ResearchBudgetConfig;
  /** `null` when another source of `kind` may be read, else the tripped stop. */
  canReadSource(kind: ResearchSourceKind): BudgetStop | null;
  /** Record a completed source read of `kind`. */
  noteSourceRead(kind: ResearchSourceKind): void;
  /** Total sources read so far. */
  readonly sourcesRead: number;
  /** Every distinct budget stop encountered so far, in trip order. */
  readonly stops: readonly BudgetStop[];
}

/** Create a budget tracker. Elapsed time is measured from creation. */
export function createBudgetTracker(
  config: ResearchBudgetConfig = {},
  clock: () => number = Date.now,
): ResearchBudgetTracker {
  const maxSources = config.maxSources ?? DEFAULT_RESEARCH_BUDGET.maxSources;
  const maxDurationMs = config.maxDurationMs ?? DEFAULT_RESEARCH_BUDGET.maxDurationMs;
  const perKind = config.maxSourcesPerKind ?? {};
  const startedAt = clock();

  let sourcesRead = 0;
  const readByKind = new Map<ResearchSourceKind, number>();
  const stops: BudgetStop[] = [];

  const recordStop = (stop: BudgetStop): BudgetStop => {
    const seen = stops.some((s) => s.rule === stop.rule && s.detail === stop.detail);
    if (!seen) {
      stops.push(stop);
    }
    return stop;
  };

  return {
    budget: { maxSources, maxDurationMs, maxSourcesPerKind: config.maxSourcesPerKind },
    canReadSource(kind: ResearchSourceKind): BudgetStop | null {
      const elapsed = clock() - startedAt;
      if (elapsed >= maxDurationMs) {
        return recordStop({
          rule: 'max_duration',
          detail: `time budget of ${maxDurationMs}ms exhausted after ${elapsed}ms`,
          global: true,
        });
      }
      if (sourcesRead >= maxSources) {
        return recordStop({
          rule: 'max_sources',
          detail: `source budget of ${maxSources} sources exhausted`,
          global: true,
        });
      }
      const kindCap = perKind[kind];
      if (kindCap !== undefined && (readByKind.get(kind) ?? 0) >= kindCap) {
        return recordStop({
          rule: 'max_sources_per_kind',
          detail: `source-class budget of ${kindCap} '${kind}' sources exhausted`,
          global: false,
        });
      }
      return null;
    },
    noteSourceRead(kind: ResearchSourceKind): void {
      sourcesRead += 1;
      readByKind.set(kind, (readByKind.get(kind) ?? 0) + 1);
    },
    get sourcesRead(): number {
      return sourcesRead;
    },
    get stops(): readonly BudgetStop[] {
      return stops;
    },
  };
}
