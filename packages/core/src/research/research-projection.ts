/**
 * Research projection: folds `research.*` events into a per-run research view
 * with status, sources, findings, assumptions, unresolved gaps, and evidence
 * links.
 *
 * Like every projection it is a pure function `events[] -> state`:
 *  - it never invents research state (a run with no research events projects
 *    to status `none`, keeping planning-only V1 runs fully compatible),
 *  - it sorts by sequence before folding (tolerating out-of-order reads),
 *  - it is deterministic (replaying the same log yields identical output), and
 *  - it surfaces diagnostics for gaps / corrupt / unknown events rather than
 *    throwing.
 *
 * A failed research pass keeps every partial source/finding/assumption/gap
 * folded before the failure, so operators still see useful partial output.
 */
import {
  detectSequenceGaps,
  resolveTargetRunId,
  validateAndSortEvents,
} from '../projections/run-projection';
import type { ProjectionDiagnostic } from '../projections/run-projection';
import type {
  EventEvidence,
  FactoryEvent,
  ResearchBudget,
  ResearchFindingClassification,
  ResearchSourceKind,
} from '../events/event-types';

/**
 * Lifecycle of a run's research stage. `none` means the ledger contains no
 * research events at all (e.g. a planning-only V1 run).
 */
export type ResearchStatus = 'none' | 'requested' | 'in_progress' | 'completed' | 'failed';

export interface ResearchSourceView {
  readonly sourceId: string;
  /** Absent when only a `source_read` was observed — the kind is not invented. */
  readonly kind?: ResearchSourceKind;
  readonly title?: string;
  readonly locator?: string;
  /** Latest summary from `source_found` / `source_read`. */
  readonly summary?: string;
  readonly read: boolean;
  readonly contentDigest?: string;
  readonly evidence: readonly EventEvidence[];
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export interface ResearchFindingView {
  readonly findingId: string;
  readonly statement: string;
  readonly classification: ResearchFindingClassification;
  readonly confidence?: number;
  readonly sourceIds: readonly string[];
  readonly resolvesGapId?: string;
  readonly evidence: readonly EventEvidence[];
  readonly sequence: number;
  readonly timestamp: number;
}

export interface ResearchAssumptionView {
  readonly assumptionId: string;
  readonly statement: string;
  readonly reason?: string;
  readonly sourceIds: readonly string[];
  readonly evidence: readonly EventEvidence[];
  readonly sequence: number;
}

export interface ResearchGapView {
  readonly gapId: string;
  readonly question: string;
  readonly impact?: string;
  readonly blocking: boolean;
  readonly resolved: boolean;
  /** The finding that resolved this gap, when one exists. */
  readonly resolvedByFindingId?: string;
  readonly evidence: readonly EventEvidence[];
  readonly sequence: number;
}

export interface ResearchProjection {
  readonly runId: string | null;
  readonly status: ResearchStatus;
  readonly objective?: string;
  readonly requestedSources?: readonly ResearchSourceKind[];
  readonly budget?: ResearchBudget;
  readonly sources: ResearchSourceView[];
  readonly sourceCount: number;
  readonly readSourceCount: number;
  readonly findings: ResearchFindingView[];
  readonly assumptions: ResearchAssumptionView[];
  readonly gaps: ResearchGapView[];
  readonly unresolvedGapCount: number;
  /** Summary from `research.brief_completed`, when research finished. */
  readonly briefSummary?: string;
  readonly briefRef?: string;
  readonly briefEvidence?: readonly EventEvidence[];
  readonly failureReason?: string;
  readonly requestedAt?: number;
  /** Timestamp of `research.brief_completed` or `research.failed`. */
  readonly completedAt?: number;
  readonly lastSequence: number;
  readonly diagnostics: ProjectionDiagnostic[];
}

interface MutableSource {
  sourceId: string;
  kind?: ResearchSourceKind;
  title?: string;
  locator?: string;
  summary?: string;
  read: boolean;
  contentDigest?: string;
  evidence: EventEvidence[];
  firstSequence: number;
  lastSequence: number;
}

interface MutableGap {
  gapId: string;
  question: string;
  impact?: string;
  blocking: boolean;
  resolved: boolean;
  resolvedByFindingId?: string;
  evidence: EventEvidence[];
  sequence: number;
}

function toSourceView(source: MutableSource): ResearchSourceView {
  return {
    sourceId: source.sourceId,
    kind: source.kind,
    title: source.title,
    locator: source.locator,
    summary: source.summary,
    read: source.read,
    contentDigest: source.contentDigest,
    evidence: source.evidence,
    firstSequence: source.firstSequence,
    lastSequence: source.lastSequence,
  };
}

function toGapView(gap: MutableGap): ResearchGapView {
  return {
    gapId: gap.gapId,
    question: gap.question,
    impact: gap.impact,
    blocking: gap.blocking,
    resolved: gap.resolved,
    resolvedByFindingId: gap.resolvedByFindingId,
    evidence: gap.evidence,
    sequence: gap.sequence,
  };
}

const TERMINAL_STATUSES: ReadonlySet<ResearchStatus> = new Set(['completed', 'failed']);

export function projectResearch(raw: readonly unknown[], runId?: string): ResearchProjection {
  const { events, diagnostics } = validateAndSortEvents(raw);
  const targetRunId = resolveTargetRunId(events, runId);
  const runEvents = targetRunId === null ? [] : events.filter((e) => e.runId === targetRunId);
  diagnostics.push(...detectSequenceGaps(runEvents));

  const sources = new Map<string, MutableSource>();
  const findings = new Map<string, ResearchFindingView>();
  const assumptions = new Map<string, ResearchAssumptionView>();
  const gaps = new Map<string, MutableGap>();
  // Findings that resolve a gap recorded later in the fold (order tolerance).
  const pendingGapResolutions = new Map<string, string>();

  let status: ResearchStatus = 'none';
  let objective: string | undefined;
  let requestedSources: readonly ResearchSourceKind[] | undefined;
  let budget: ResearchBudget | undefined;
  let briefSummary: string | undefined;
  let briefRef: string | undefined;
  let briefEvidence: readonly EventEvidence[] | undefined;
  let failureReason: string | undefined;
  let requestedAt: number | undefined;
  let completedAt: number | undefined;
  let lastSequence = 0;

  const markProgress = (): void => {
    if (!TERMINAL_STATUSES.has(status)) {
      status = 'in_progress';
    }
  };

  const upsertSource = (sourceId: string, event: FactoryEvent): MutableSource => {
    const existing = sources.get(sourceId);
    if (existing !== undefined) {
      existing.lastSequence = event.sequence;
      if (event.evidence !== undefined) {
        existing.evidence.push(...event.evidence);
      }
      return existing;
    }
    const created: MutableSource = {
      sourceId,
      read: false,
      evidence: event.evidence !== undefined ? [...event.evidence] : [],
      firstSequence: event.sequence,
      lastSequence: event.sequence,
    };
    sources.set(sourceId, created);
    return created;
  };

  for (const event of runEvents) {
    if (event.sequence > lastSequence) {
      lastSequence = event.sequence;
    }
    switch (event.type) {
      case 'research.requested': {
        objective = event.payload.objective;
        requestedSources = event.payload.requestedSources ?? requestedSources;
        budget = event.payload.budget ?? budget;
        requestedAt = event.timestamp;
        // Only lift from `none`: progress or terminal states are never demoted.
        if (status === 'none') {
          status = 'requested';
        }
        break;
      }
      case 'research.source_found': {
        const source = upsertSource(event.payload.sourceId, event);
        source.kind = event.payload.kind;
        source.title = event.payload.title ?? source.title;
        source.locator = event.payload.locator ?? source.locator;
        source.summary = event.payload.summary ?? source.summary;
        markProgress();
        break;
      }
      case 'research.source_read': {
        const source = upsertSource(event.payload.sourceId, event);
        source.read = true;
        source.summary = event.payload.summary ?? source.summary;
        source.contentDigest = event.payload.contentDigest ?? source.contentDigest;
        markProgress();
        break;
      }
      case 'research.finding_recorded': {
        const payload = event.payload;
        findings.set(payload.findingId, {
          findingId: payload.findingId,
          statement: payload.statement,
          classification: payload.classification,
          confidence: payload.confidence,
          sourceIds: payload.sourceIds !== undefined ? [...payload.sourceIds] : [],
          resolvesGapId: payload.resolvesGapId,
          evidence: event.evidence !== undefined ? [...event.evidence] : [],
          sequence: event.sequence,
          timestamp: event.timestamp,
        });
        if (payload.resolvesGapId !== undefined) {
          const gap = gaps.get(payload.resolvesGapId);
          if (gap !== undefined) {
            gap.resolved = true;
            gap.resolvedByFindingId = payload.findingId;
          } else {
            pendingGapResolutions.set(payload.resolvesGapId, payload.findingId);
          }
        }
        markProgress();
        break;
      }
      case 'research.assumption_recorded': {
        const payload = event.payload;
        assumptions.set(payload.assumptionId, {
          assumptionId: payload.assumptionId,
          statement: payload.statement,
          reason: payload.reason,
          sourceIds: payload.sourceIds !== undefined ? [...payload.sourceIds] : [],
          evidence: event.evidence !== undefined ? [...event.evidence] : [],
          sequence: event.sequence,
        });
        markProgress();
        break;
      }
      case 'research.gap_recorded': {
        const payload = event.payload;
        const resolvedBy = pendingGapResolutions.get(payload.gapId);
        gaps.set(payload.gapId, {
          gapId: payload.gapId,
          question: payload.question,
          impact: payload.impact,
          blocking: payload.blocking ?? false,
          resolved: resolvedBy !== undefined,
          resolvedByFindingId: resolvedBy,
          evidence: event.evidence !== undefined ? [...event.evidence] : [],
          sequence: event.sequence,
        });
        markProgress();
        break;
      }
      case 'research.brief_completed': {
        status = 'completed';
        briefSummary = event.payload.summary;
        briefRef = event.payload.briefRef ?? briefRef;
        briefEvidence = event.evidence ?? briefEvidence;
        completedAt = event.timestamp;
        break;
      }
      case 'research.failed': {
        status = 'failed';
        failureReason = event.payload.reason;
        completedAt = event.timestamp;
        break;
      }
      default:
        break;
    }
  }

  const bySequence = <T extends { readonly sequence: number }>(a: T, b: T): number =>
    a.sequence - b.sequence;

  const sourceViews = [...sources.values()]
    .sort((a, b) => a.firstSequence - b.firstSequence)
    .map(toSourceView);
  const gapViews = [...gaps.values()].map(toGapView).sort(bySequence);

  return {
    runId: targetRunId,
    status,
    objective,
    requestedSources,
    budget,
    sources: sourceViews,
    sourceCount: sourceViews.length,
    readSourceCount: sourceViews.filter((source) => source.read).length,
    findings: [...findings.values()].sort(bySequence),
    assumptions: [...assumptions.values()].sort(bySequence),
    gaps: gapViews,
    unresolvedGapCount: gapViews.filter((gap) => !gap.resolved).length,
    briefSummary,
    briefRef,
    briefEvidence,
    failureReason,
    requestedAt,
    completedAt,
    lastSequence,
    diagnostics,
  };
}
