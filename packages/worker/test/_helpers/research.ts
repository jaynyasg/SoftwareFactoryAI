/**
 * Deterministic fake research source adapters + clocks for the U2 research
 * tests. No network, no filesystem — every source and read result is declared
 * up front, and the fakes record how they were called so tests can assert that
 * policy/budget refusals really prevented adapter I/O.
 */
import type { ResearchSourceKind } from '@software-factory/core';
import type {
  DiscoveredSource,
  ResearchAdapterSetup,
  ResearchSourceAdapter,
  SourceReadResult,
} from '../../src/index';

/** One scripted source: what discovery returns + what reading it yields. */
export interface ScriptedSource {
  readonly source: DiscoveredSource;
  /** The read result, or an Error to throw when the source is read. */
  readonly result: SourceReadResult | Error;
}

export interface FakeAdapterOptions {
  readonly id?: string;
  readonly kind?: ResearchSourceKind;
  readonly setup?: Partial<ResearchAdapterSetup>;
  readonly sources?: readonly ScriptedSource[];
  /** When set, `discover` throws this error. */
  readonly discoverError?: Error;
}

export interface FakeResearchAdapter extends ResearchSourceAdapter {
  readonly detectSetupCalls: number;
  readonly discoverCalls: number;
  /** Source ids read, in order. */
  readonly readCalls: readonly string[];
}

/** Build a deterministic fake adapter that records its calls. */
export function createFakeAdapter(options: FakeAdapterOptions = {}): FakeResearchAdapter {
  const kind = options.kind ?? 'model_synthesis';
  const id = options.id ?? `fake-${kind}`;
  const scripted = options.sources ?? [];
  let detectSetupCalls = 0;
  let discoverCalls = 0;
  const readCalls: string[] = [];

  return {
    id,
    kind,
    detectSetup(): Promise<ResearchAdapterSetup> {
      detectSetupCalls += 1;
      return Promise.resolve({
        configured: options.setup?.configured ?? true,
        requiresCredentials: options.setup?.requiresCredentials ?? false,
        credentialsPresent: options.setup?.credentialsPresent ?? true,
        setupAction: options.setup?.setupAction,
        detail: options.setup?.detail,
      });
    },
    discover(_context, discoverOptions): Promise<readonly DiscoveredSource[]> {
      discoverCalls += 1;
      if (options.discoverError !== undefined) {
        return Promise.reject(options.discoverError);
      }
      return Promise.resolve(
        scripted.slice(0, Math.max(discoverOptions.limit, 0)).map((entry) => entry.source),
      );
    },
    read(source): Promise<SourceReadResult> {
      readCalls.push(source.sourceId);
      const entry = scripted.find((candidate) => candidate.source.sourceId === source.sourceId);
      if (entry === undefined) {
        return Promise.reject(new Error(`Unknown scripted source "${source.sourceId}".`));
      }
      if (entry.result instanceof Error) {
        return Promise.reject(entry.result);
      }
      return Promise.resolve(entry.result);
    },
    get detectSetupCalls(): number {
      return detectSetupCalls;
    },
    get discoverCalls(): number {
      return discoverCalls;
    },
    get readCalls(): readonly string[] {
      return readCalls;
    },
  };
}

/** A simple scripted source with a one-finding read result. */
export function scriptedSource(
  sourceId: string,
  kind: ResearchSourceKind,
  statement: string,
): ScriptedSource {
  return {
    source: {
      sourceId,
      kind,
      title: sourceId,
      locator: `fake://${sourceId}`,
      summary: `about ${sourceId}`,
    },
    result: {
      summary: `read ${sourceId}`,
      contentDigest: `digest-${sourceId}`,
      findings: [{ statement, classification: 'verified_fact', confidence: 0.9 }],
    },
  };
}

/** Deterministic clock advancing `stepMs` per call, starting at `start`. */
export function steppingClock(start = 1_700_000_000_000, stepMs = 1000): () => number {
  let now = start;
  return () => {
    const current = now;
    now += stepMs;
    return current;
  };
}

/** Deterministic event-id generator (`evt-1`, `evt-2`, ...). */
export function steppingIds(prefix = 'evt'): () => string {
  let seq = 0;
  return () => `${prefix}-${(seq += 1)}`;
}
