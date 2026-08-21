/**
 * Lightweight knowledge-index contract (X1).
 *
 * A knowledge entry is a reusable piece of context — a source reference, a
 * research finding, a repo fact, a gate lesson, or a completed-run reference —
 * recorded on the ledger via `knowledge.entry_recorded` so later planning and
 * research stages can start with prior context instead of from scratch.
 *
 * Engineering hardening E4: every entry carries freshness (`freshUntil`),
 * confidence, retention (`retainUntil`), and redaction/privacy (`sensitivity`,
 * `knowledge.entry_redacted`) metadata so stale or sensitive context is never
 * silently reused:
 *  - redacted and retired entries are NEVER returned by `queryKnowledge`,
 *  - retention-expired entries are NEVER returned by `queryKnowledge`,
 *  - `sensitive` entries require an explicit `includeSensitive` opt-in,
 *  - stale entries require an explicit `includeStale` opt-in and are flagged.
 *
 * The projection that materializes `KnowledgeIndexProjection` from ledger
 * events lives in `knowledge-projection.ts`; this module owns the contract
 * shape and the pure query function over it.
 */
import type {
  EventEvidence,
  KnowledgeEntryKind,
  KnowledgeSensitivity,
} from '../events/event-types';
import type { ProjectionDiagnostic } from '../projections/run-projection';

/** A replayed reusable knowledge entry, with its E4 reuse-safety metadata. */
export interface KnowledgeEntryView {
  readonly entryId: string;
  readonly kind: KnowledgeEntryKind;
  readonly title: string;
  readonly body: string;
  /** Producer confidence, 0..1. */
  readonly confidence: number;
  readonly sensitivity: KnowledgeSensitivity;
  readonly tags: readonly string[];
  readonly locator?: string;
  /** The run whose ledger recorded the entry. */
  readonly runId: string;
  /** The run whose work produced the entry (may differ from `runId`). */
  readonly sourceRunId?: string;
  /** Ledger events (by `eventId`) evidencing this entry. */
  readonly sourceEventIds: readonly string[];
  /** When the entry was recorded (the recording event's timestamp). */
  readonly recordedAt: number;
  /** Epoch ms after which the entry is stale. Absent = never goes stale. */
  readonly freshUntil?: number;
  /** Epoch ms after which retention expires. Absent = retained indefinitely. */
  readonly retainUntil?: number;
  readonly redacted: boolean;
  readonly redactionReason?: string;
  readonly retired: boolean;
  readonly retirementReason?: string;
  readonly evidence: readonly EventEvidence[];
  readonly firstSequence: number;
  readonly lastSequence: number;
}

/** The projected knowledge index: every replayed entry, including redacted
 * and retired ones (visible for audit; excluded from normal queries). */
export interface KnowledgeIndexProjection {
  readonly entries: KnowledgeEntryView[];
  readonly byId: Record<string, KnowledgeEntryView>;
  readonly diagnostics: ProjectionDiagnostic[];
}

/** Query contract used by later planning/research stages (U2/U3). */
export interface KnowledgeQuery {
  /**
   * Evaluation time (epoch ms) for freshness and retention checks. Required —
   * callers supply the clock so queries stay pure and deterministic.
   */
  readonly now: number;
  readonly kinds?: readonly KnowledgeEntryKind[];
  /** Match entries carrying at least one of these tags. */
  readonly tags?: readonly string[];
  /** Case-insensitive substring match against title and body. */
  readonly text?: string;
  readonly minConfidence?: number;
  /** Return stale entries too (explicitly flagged). Default false. */
  readonly includeStale?: boolean;
  /** Return `sensitive`-class entries too. Default false. Redacted entries are
   * never returned regardless of flags. */
  readonly includeSensitive?: boolean;
  readonly limit?: number;
}

/** A query hit: the entry plus reuse-safety context (staleness and age). */
export interface KnowledgeQueryMatch {
  readonly entry: KnowledgeEntryView;
  readonly stale: boolean;
  /** Milliseconds since the entry was recorded, at query `now`. */
  readonly ageMs: number;
}

/** Whether an entry is past its freshness horizon at `now`. */
export function isKnowledgeEntryStale(entry: KnowledgeEntryView, now: number): boolean {
  return entry.freshUntil !== undefined && now >= entry.freshUntil;
}

/** Whether an entry is past its retention horizon at `now`. */
export function isKnowledgeEntryExpired(entry: KnowledgeEntryView, now: number): boolean {
  return entry.retainUntil !== undefined && now >= entry.retainUntil;
}

/**
 * Pure, deterministic query over a projected knowledge index. Results are
 * ordered by confidence (desc), then recency (desc), then entryId (asc), and
 * bounded by `limit` when provided.
 */
export function queryKnowledge(
  index: KnowledgeIndexProjection,
  query: KnowledgeQuery,
): KnowledgeQueryMatch[] {
  const text = query.text?.toLowerCase();
  const kinds = query.kinds !== undefined ? new Set(query.kinds) : undefined;
  const tags = query.tags !== undefined ? new Set(query.tags) : undefined;

  const matches: KnowledgeQueryMatch[] = [];
  for (const entry of index.entries) {
    // Hard exclusions: redaction, retirement, and retention are never bypassed.
    if (entry.redacted || entry.retired || isKnowledgeEntryExpired(entry, query.now)) {
      continue;
    }
    // Sensitive context requires an explicit opt-in (E4 privacy policy).
    if (entry.sensitivity === 'sensitive' && query.includeSensitive !== true) {
      continue;
    }
    const stale = isKnowledgeEntryStale(entry, query.now);
    if (stale && query.includeStale !== true) {
      continue;
    }
    if (kinds !== undefined && !kinds.has(entry.kind)) {
      continue;
    }
    if (tags !== undefined && !entry.tags.some((tag) => tags.has(tag))) {
      continue;
    }
    if (query.minConfidence !== undefined && entry.confidence < query.minConfidence) {
      continue;
    }
    if (
      text !== undefined &&
      !entry.title.toLowerCase().includes(text) &&
      !entry.body.toLowerCase().includes(text)
    ) {
      continue;
    }
    matches.push({ entry, stale, ageMs: query.now - entry.recordedAt });
  }

  matches.sort((a, b) => {
    if (a.entry.confidence !== b.entry.confidence) {
      return b.entry.confidence - a.entry.confidence;
    }
    if (a.entry.recordedAt !== b.entry.recordedAt) {
      return b.entry.recordedAt - a.entry.recordedAt;
    }
    return a.entry.entryId < b.entry.entryId ? -1 : a.entry.entryId > b.entry.entryId ? 1 : 0;
  });

  return query.limit !== undefined ? matches.slice(0, query.limit) : matches;
}
