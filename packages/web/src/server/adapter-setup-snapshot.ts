/**
 * Cached, non-blocking adapter setup detection for the setup checklist.
 *
 * `GET /api/setup` is also the hosted health-check path, so it must answer in
 * milliseconds — but real adapter detection shells out to `claude`/`codex`
 * probes with a 10s bound each. The snapshot resolves the tension: the route
 * reads the LAST KNOWN detection instantly, and a stale (or missing) snapshot
 * triggers ONE background refresh whose completion the next poll observes.
 * Errors never escape: a failed probe is folded into the adapter's row, and a
 * failed refresh pass is logged and retried on the next stale read.
 */
import type { AdapterCatalog, AdapterSetupState, ExecutionAdapter } from '@software-factory/core';

/** One adapter's probed row, shaped for the setup checklist (presence only). */
export interface AdapterSetupRow {
  readonly id: string;
  readonly family: string;
  readonly available: boolean;
  readonly authenticated: boolean;
  readonly detail?: string;
}

/** The checklist-facing report. `pending` = first detection still running. */
export interface AdapterSetupReport {
  readonly status: 'pending' | 'ready' | 'attention';
  readonly detected: readonly AdapterSetupRow[];
  /** Ids of adapters whose probe reported available + authenticated. */
  readonly ready: readonly string[];
  /** Epoch ms of the completed detection this report reflects, else null. */
  readonly probedAt: number | null;
}

interface CacheEntry {
  report: AdapterSetupReport;
  refresh: Promise<void> | null;
}

const PENDING: AdapterSetupReport = {
  status: 'pending',
  detected: [],
  ready: [],
  probedAt: null,
};

/** Default snapshot lifetime before a read re-triggers detection. */
export const ADAPTER_SETUP_TTL_MS = 60_000;

// Per-catalog cache: tests inject fake catalogs and must never see each
// other's (or the real catalog's) probes. WeakMap so a discarded catalog
// releases its snapshot with it.
const cache = new WeakMap<AdapterCatalog, CacheEntry>();

async function probe(adapter: ExecutionAdapter): Promise<AdapterSetupRow> {
  let setup: AdapterSetupState;
  try {
    setup = await adapter.detectSetup();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setup = {
      available: false,
      authenticated: false,
      capacity: 0,
      detail: `Setup probe failed: ${message}`,
    };
  }
  return {
    id: adapter.id,
    family: adapter.family,
    available: setup.available,
    authenticated: setup.authenticated,
    detail: setup.detail,
  };
}

async function detect(catalog: AdapterCatalog, clock: () => number): Promise<AdapterSetupReport> {
  // Probes run in parallel: each is internally bounded (~10s), so the whole
  // pass is bounded by the slowest single probe, not their sum.
  const detected = await Promise.all(catalog.list().map(probe));
  const ready = detected.filter((row) => row.available && row.authenticated).map((row) => row.id);
  return {
    status: ready.length > 0 ? 'ready' : 'attention',
    detected,
    ready,
    probedAt: clock(),
  };
}

/**
 * Read the current adapter setup report WITHOUT blocking. A missing or stale
 * snapshot kicks off one background detection (deduplicated while in flight);
 * callers see `pending` (first ever read) or the last completed detection.
 */
export function getAdapterSetupSnapshot(
  catalog: AdapterCatalog,
  options: { readonly ttlMs?: number; readonly clock?: () => number } = {},
): AdapterSetupReport {
  const ttlMs = options.ttlMs ?? ADAPTER_SETUP_TTL_MS;
  const clock = options.clock ?? Date.now;

  let entry = cache.get(catalog);
  if (entry === undefined) {
    entry = { report: PENDING, refresh: null };
    cache.set(catalog, entry);
  }

  const stale = entry.report.probedAt === null || clock() - entry.report.probedAt >= ttlMs;
  if (stale && entry.refresh === null) {
    const current = entry;
    current.refresh = detect(catalog, clock)
      .then((report) => {
        current.report = report;
      })
      .catch((error: unknown) => {
        // detect() folds per-adapter failures already; this only catches an
        // unexpected infrastructure error. Keep the last report, log, retry
        // on the next stale read.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[software-factory] adapter setup detection failed: ${message}`);
      })
      .finally(() => {
        current.refresh = null;
      });
  }

  return entry.report;
}

/** Await one full detection pass (tests and explicit refresh callers). */
export async function refreshAdapterSetupSnapshot(
  catalog: AdapterCatalog,
  options: { readonly clock?: () => number } = {},
): Promise<AdapterSetupReport> {
  const report = await detect(catalog, options.clock ?? Date.now);
  cache.set(catalog, { report, refresh: null });
  return report;
}
