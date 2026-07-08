/**
 * Research source-adapter contract (full-factory U2).
 *
 * The bounded research runner (`research-runner.ts`) never talks to a file
 * system, repo, PRD, or network provider directly — it talks to
 * `ResearchSourceAdapter`s. The same interface is implemented by the repo/local
 * scan adapter, the PRD adapter, the documentation-URL adapter, and the
 * external web-search provider hook, so the runner stays agnostic to where
 * evidence actually comes from (mirroring the `ExecutionAdapter` pattern in
 * `@software-factory/core`).
 *
 * Fail-closed by design:
 *  - `detectSetup` reports configuration/credential PRESENCE only — never the
 *    credential values themselves (hardening E5), and
 *  - an adapter that is not configured (or lacks credentials) is never asked to
 *    discover or read; the runner records a setup requirement / gap instead of
 *    fabricating research.
 */
import type {
  KnowledgeEntryKind,
  KnowledgeSensitivity,
  ResearchFindingClassification,
  ResearchSourceKind,
  SetupAction,
} from '@software-factory/core';

/** The run context a research pass receives (a slice of `run.created`). */
export interface ResearchRunContext {
  readonly runId: string;
  /** What the research pass is trying to learn. */
  readonly objective: string;
  readonly prompt?: string;
  readonly prdText?: string;
  readonly prdRef?: string;
  readonly localFolder?: string;
  readonly githubRepo?: string;
  /** When present, only adapters of these source kinds are consulted. */
  readonly requestedSources?: readonly ResearchSourceKind[];
}

/**
 * The normalized setup state a research source adapter reports BEFORE any
 * discovery or fetch happens. Credential fields are booleans by contract:
 * secret values must never appear here (they would end up in ledger evidence).
 */
export interface ResearchAdapterSetup {
  /** The adapter has enough configuration to discover sources at all. */
  readonly configured: boolean;
  /** Whether this adapter needs provider credentials before any fetch. */
  readonly requiresCredentials: boolean;
  /** Whether the required credentials are PRESENT (presence only, never values). */
  readonly credentialsPresent: boolean;
  /** Remediation to surface when not configured / credentials are missing. */
  readonly setupAction?: SetupAction;
  /** Human-facing detail (e.g. why the adapter is not configured). */
  readonly detail?: string;
}

/** A candidate source an adapter discovered (no content fetched yet). */
export interface DiscoveredSource {
  /** Stable id unique within the research pass, e.g. `repo:README.md`. */
  readonly sourceId: string;
  readonly kind: ResearchSourceKind;
  readonly title?: string;
  /** Source-agnostic locator: URL, workspace-relative path, doc ref, upload ref. */
  readonly locator?: string;
  readonly summary?: string;
}

/** A finding proposed by an adapter; the runner assigns ids and redacts text. */
export interface ResearchFindingDraft {
  readonly statement: string;
  readonly classification: ResearchFindingClassification;
  /** Producer confidence 0..1 (defaults by classification when omitted). */
  readonly confidence?: number;
  /** Normalize into the reusable knowledge index (`knowledge.entry_recorded`). */
  readonly reusable?: boolean;
  /** Knowledge-entry kind when reusable (default `finding`). */
  readonly knowledgeKind?: KnowledgeEntryKind;
  /** Knowledge-entry privacy class when reusable (default `internal`). */
  readonly sensitivity?: KnowledgeSensitivity;
  readonly tags?: readonly string[];
  /** Freshness horizon (ms from record time) when reusable. */
  readonly freshForMs?: number;
}

/** An assumption proposed by an adapter (unverified working premise). */
export interface ResearchAssumptionDraft {
  readonly statement: string;
  readonly reason?: string;
}

/** An open question the adapter could not answer from this source. */
export interface ResearchGapDraft {
  readonly question: string;
  readonly impact?: string;
  /** Whether the gap should block execution-capable run modes. */
  readonly blocking?: boolean;
}

/** What reading one source produced. */
export interface SourceReadResult {
  /** Short human summary of what was read (redacted again by the runner). */
  readonly summary: string;
  /** Content digest of what was read, for provenance/staleness checks. */
  readonly contentDigest?: string;
  readonly findings?: readonly ResearchFindingDraft[];
  readonly assumptions?: readonly ResearchAssumptionDraft[];
  readonly gaps?: readonly ResearchGapDraft[];
}

/** Options for `discover`. `limit` is the remaining source budget. */
export interface DiscoverOptions {
  readonly limit: number;
  readonly signal?: AbortSignal;
}

/** Options for `read`. */
export interface ReadOptions {
  readonly signal?: AbortSignal;
}

/**
 * The single contract every research source backend implements.
 *
 * Lifecycle per research pass: `detectSetup` (policy + credential check, no
 * I/O against the source) -> `discover` (list candidate sources within the
 * budget) -> `read` per source (fetch + summarize + propose findings).
 */
export interface ResearchSourceAdapter {
  /** Stable adapter id, e.g. `repo-scan`, `prd`, `docs`, `web-search`. */
  readonly id: string;
  /** The source class every source from this adapter belongs to. */
  readonly kind: ResearchSourceKind;
  /** Probe configuration/credential PRESENCE without fetching anything. */
  detectSetup(): Promise<ResearchAdapterSetup>;
  /** Discover candidate sources for the context (no content fetch). */
  discover(
    context: ResearchRunContext,
    options: DiscoverOptions,
  ): Promise<readonly DiscoveredSource[]>;
  /** Read one discovered source's content. */
  read(source: DiscoveredSource, options: ReadOptions): Promise<SourceReadResult>;
}
