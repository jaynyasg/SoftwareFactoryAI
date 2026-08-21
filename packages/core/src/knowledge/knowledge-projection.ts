/**
 * Knowledge-index projection: folds `knowledge.*` events into the reusable
 * knowledge index defined in `knowledge-index.ts`.
 *
 * Unlike the per-run projections, the knowledge index is CROSS-RUN by default:
 * reusable knowledge exists so future runs start with prior context, so the
 * fold spans every run in the provided ledger. Pass `options.runId` to scope
 * to a single run's contributions.
 *
 * Replay rules:
 *  - deterministic: replaying the same log yields identical output,
 *  - no invention: a redaction/retirement without a recorded entry produces no
 *    entry view,
 *  - redaction and retirement are STICKY: they apply to their entryId
 *    regardless of the order events are observed in (order tolerance across
 *    runs, whose sequences are independent).
 */
import { detectSequenceGaps, validateAndSortEvents } from '../projections/run-projection';
import type {
  EventEvidence,
  KnowledgeEntryKind,
  KnowledgeSensitivity,
} from '../events/event-types';
import type { KnowledgeEntryView, KnowledgeIndexProjection } from './knowledge-index';

export interface KnowledgeProjectionOptions {
  /** Scope the fold to a single run's ledger instead of all runs. */
  readonly runId?: string;
}

interface MutableEntry {
  entryId: string;
  kind: KnowledgeEntryKind;
  title: string;
  body: string;
  confidence: number;
  sensitivity: KnowledgeSensitivity;
  tags: readonly string[];
  locator?: string;
  runId: string;
  sourceRunId?: string;
  sourceEventIds: readonly string[];
  recordedAt: number;
  freshUntil?: number;
  retainUntil?: number;
  redacted: boolean;
  redactionReason?: string;
  retired: boolean;
  retirementReason?: string;
  evidence: EventEvidence[];
  firstSequence: number;
  lastSequence: number;
}

function toView(entry: MutableEntry): KnowledgeEntryView {
  return {
    entryId: entry.entryId,
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    confidence: entry.confidence,
    sensitivity: entry.sensitivity,
    tags: entry.tags,
    locator: entry.locator,
    runId: entry.runId,
    sourceRunId: entry.sourceRunId,
    sourceEventIds: entry.sourceEventIds,
    recordedAt: entry.recordedAt,
    freshUntil: entry.freshUntil,
    retainUntil: entry.retainUntil,
    redacted: entry.redacted,
    redactionReason: entry.redactionReason,
    retired: entry.retired,
    retirementReason: entry.retirementReason,
    evidence: entry.evidence,
    firstSequence: entry.firstSequence,
    lastSequence: entry.lastSequence,
  };
}

export function projectKnowledgeIndex(
  raw: readonly unknown[],
  options: KnowledgeProjectionOptions = {},
): KnowledgeIndexProjection {
  const { events, diagnostics } = validateAndSortEvents(raw);
  const scoped =
    options.runId === undefined ? events : events.filter((e) => e.runId === options.runId);
  diagnostics.push(...detectSequenceGaps(scoped));

  const entries = new Map<string, MutableEntry>();
  // Sticky redactions/retirements observed before (or without) their entry.
  const pendingRedactions = new Map<string, string>();
  const pendingRetirements = new Map<string, string | undefined>();

  for (const event of scoped) {
    switch (event.type) {
      case 'knowledge.entry_recorded': {
        const payload = event.payload;
        const previous = entries.get(payload.entryId);
        const entry: MutableEntry = {
          entryId: payload.entryId,
          kind: payload.kind,
          title: payload.title,
          body: payload.body,
          confidence: payload.confidence,
          sensitivity: payload.sensitivity,
          tags: payload.tags !== undefined ? [...payload.tags] : [],
          locator: payload.locator,
          runId: event.runId,
          sourceRunId: payload.sourceRunId,
          sourceEventIds: payload.sourceEventIds !== undefined ? [...payload.sourceEventIds] : [],
          recordedAt: event.timestamp,
          freshUntil: payload.freshUntil,
          retainUntil: payload.retainUntil,
          // Redaction/retirement stick across re-records: a redacted entryId
          // cannot be resurfaced by appending a fresh record for the same id.
          redacted: previous?.redacted ?? pendingRedactions.has(payload.entryId),
          redactionReason: previous?.redactionReason ?? pendingRedactions.get(payload.entryId),
          retired: previous?.retired ?? pendingRetirements.has(payload.entryId),
          retirementReason: previous?.retirementReason ?? pendingRetirements.get(payload.entryId),
          evidence: [
            ...(previous?.evidence ?? []),
            ...(event.evidence !== undefined ? [...event.evidence] : []),
          ],
          firstSequence: previous?.firstSequence ?? event.sequence,
          lastSequence: event.sequence,
        };
        entries.set(payload.entryId, entry);
        break;
      }
      case 'knowledge.entry_redacted': {
        const entry = entries.get(event.payload.entryId);
        if (entry !== undefined) {
          entry.redacted = true;
          entry.redactionReason = event.payload.reason;
          entry.lastSequence = Math.max(entry.lastSequence, event.sequence);
        } else {
          pendingRedactions.set(event.payload.entryId, event.payload.reason);
        }
        break;
      }
      case 'knowledge.entry_retired': {
        const entry = entries.get(event.payload.entryId);
        if (entry !== undefined) {
          entry.retired = true;
          entry.retirementReason = event.payload.reason ?? entry.retirementReason;
          entry.lastSequence = Math.max(entry.lastSequence, event.sequence);
        } else {
          pendingRetirements.set(event.payload.entryId, event.payload.reason);
        }
        break;
      }
      default:
        break;
    }
  }

  const views = [...entries.values()].map(toView).sort((a, b) => {
    if (a.recordedAt !== b.recordedAt) {
      return a.recordedAt - b.recordedAt;
    }
    return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
  });

  const byId: Record<string, KnowledgeEntryView> = {};
  for (const view of views) {
    byId[view.entryId] = view;
  }

  return { entries: views, byId, diagnostics };
}
