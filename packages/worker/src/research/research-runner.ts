/**
 * Bounded research runner (full-factory U2).
 *
 * Accepts run context plus a set of source adapters and emits the U1 research
 * event families (`research.*`) through the existing event store — the ledger
 * stays the single source of truth and `projectResearch` renders the result.
 *
 * Invariants (KTD2 / hardening E4+E5 / plan R1-R6):
 *  - source policy is applied BEFORE any fetch or index write,
 *  - budgets bound effort, source count, elapsed time, and source class; a
 *    tripped budget records an explicit unresolved gap, never silent truncation,
 *  - missing provider credentials fail CLOSED: an `adapter.setup_required`
 *    event plus a research gap — no fabricated findings,
 *  - every statement/summary/body is redacted (`redactSecrets`) before it is
 *    appended as evidence or knowledge,
 *  - reusable findings are normalized into the lightweight knowledge index
 *    (`knowledge.entry_recorded`) with confidence, freshness, sensitivity, and
 *    originating-run references, and
 *  - prior knowledge can seed the pass WITHOUT hiding source age, staleness,
 *    or confidence (each seeded finding carries them explicitly).
 *
 * Determinism: with deterministic adapters, clock, and id generator the entire
 * emitted ledger (and therefore the enriched brief) is stable across runs.
 */
import { isKnowledgeEntryStale, queryKnowledge } from '@software-factory/core';
import type {
  AppendResult,
  AppendableEvent,
  EventActor,
  EventStore,
  KnowledgeIndexProjection,
  KnowledgeQueryMatch,
  ResearchBudget,
  ResearchSourceKind,
} from '@software-factory/core';
import { errorMessage } from '../utils/error';
import { createBudgetTracker } from './research-budget';
import type { BudgetStop, ResearchBudgetConfig } from './research-budget';
import {
  evaluateSourceClass,
  evaluateSourceSetup,
  redactSecrets,
  resolveSourcePolicy,
} from './source-policy';
import type { ResearchSourcePolicy } from './source-policy';
import type {
  DiscoveredSource,
  ResearchFindingDraft,
  ResearchRunContext,
  ResearchSourceAdapter,
} from './research-contract';

/** Options for one bounded research pass. */
export interface ResearchRunnerOptions {
  /** The append-only event store research events are emitted through. */
  readonly store: EventStore;
  /** Source adapters, consulted in order. */
  readonly adapters: readonly ResearchSourceAdapter[];
  /** Source policy overrides (defaults fail closed on network). */
  readonly policy?: Partial<ResearchSourcePolicy>;
  /** Budget overrides (defaults in `research-budget.ts`). */
  readonly budget?: ResearchBudgetConfig;
  /** Prior knowledge index used to seed the brief (queried, never mutated). */
  readonly priorKnowledge?: KnowledgeIndexProjection;
  /** Max prior-knowledge entries seeded into the pass (default 5). */
  readonly maxSeededKnowledge?: number;
  /** Wall-clock source (epoch ms). Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Cancellation signal; an abort records `research.failed`. */
  readonly signal?: AbortSignal;
}

/** The outcome of a research pass (the ledger carries the full detail). */
export interface ResearchRunResult {
  readonly status: 'completed' | 'failed';
  readonly briefSummary?: string;
  readonly failureReason?: string;
  readonly sourcesFound: number;
  readonly sourcesRead: number;
  readonly findingCount: number;
  readonly assumptionCount: number;
  readonly gapCount: number;
  readonly seededKnowledgeCount: number;
  /** Ids of `knowledge.entry_recorded` entries normalized from this pass. */
  readonly recordedKnowledgeEntryIds: readonly string[];
  /** Human-readable budget stops that bounded the pass (empty when none). */
  readonly budgetStops: readonly string[];
}

/** Default freshness horizon for normalized knowledge entries (30 days). */
export const DEFAULT_KNOWLEDGE_FRESH_FOR_MS = 30 * 24 * 60 * 60 * 1000;

const RESEARCH_ACTOR: EventActor = {
  kind: 'researcher',
  id: 'research-runner',
  display: 'Research runner',
};

/** Confidence defaults by classification when a draft omits one. */
const DEFAULT_CONFIDENCE = { verified_fact: 0.9, inference: 0.6 } as const;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

class ResearchCancelledError extends Error {
  constructor() {
    super('Research was cancelled.');
    this.name = 'ResearchCancelledError';
  }
}

/**
 * Run one bounded, source-backed research pass for a run. Never throws for
 * source/provider/budget problems — those become gaps and setup events; only
 * a store-level failure can escape after a best-effort `research.failed`.
 */
export async function runResearch(
  context: ResearchRunContext,
  options: ResearchRunnerOptions,
): Promise<ResearchRunResult> {
  const { store, adapters } = options;
  const clock = options.clock ?? Date.now;
  const policy = resolveSourcePolicy(options.policy);
  const redact = (text: string): string => redactSecrets(text, policy.redactionPatterns);
  const tracker = createBudgetTracker(options.budget, clock);
  const runId = context.runId;
  const subject = { kind: 'research', id: runId } as const;

  const append = (event: Omit<AppendableEvent, 'runId' | 'timestamp'>): Promise<AppendResult> =>
    store.append({ ...event, runId, timestamp: clock() } as AppendableEvent);

  const checkCancelled = (): void => {
    if (options.signal?.aborted === true) {
      throw new ResearchCancelledError();
    }
  };

  // Counters + collected views for the deterministic brief.
  let sourcesFound = 0;
  let sourcesRead = 0;
  let findingCount = 0;
  let verifiedCount = 0;
  let assumptionCount = 0;
  let gapCount = 0;
  const topFindings: string[] = [];
  const openGaps: string[] = [];
  const seededLines: string[] = [];
  const recordedKnowledgeEntryIds: string[] = [];

  const recordGap = async (
    gapId: string,
    question: string,
    impact: string | undefined,
    blocking: boolean,
  ): Promise<void> => {
    gapCount += 1;
    openGaps.push(clip(question, 160));
    await append({
      type: 'research.gap_recorded',
      actor: RESEARCH_ACTOR,
      subject,
      severity: 'warn',
      payload: { gapId, question: redact(question), impact, blocking },
    });
  };

  const recordFinding = async (
    findingId: string,
    draft: ResearchFindingDraft,
    sourceIds: readonly string[],
    evidence?: AppendableEvent['evidence'],
  ): Promise<void> => {
    const statement = redact(draft.statement);
    const confidence = draft.confidence ?? DEFAULT_CONFIDENCE[draft.classification];
    findingCount += 1;
    if (draft.classification === 'verified_fact') {
      verifiedCount += 1;
    }
    if (topFindings.length < 5) {
      topFindings.push(clip(statement, 160));
    }
    const result = await append({
      type: 'research.finding_recorded',
      actor: RESEARCH_ACTOR,
      subject,
      severity: 'info',
      evidence,
      payload: {
        findingId,
        statement,
        classification: draft.classification,
        confidence,
        sourceIds,
      },
    });
    if (draft.reusable === true) {
      const entryId = `k-${runId}-${findingId}`;
      const now = clock();
      await append({
        type: 'knowledge.entry_recorded',
        actor: RESEARCH_ACTOR,
        subject: { kind: 'knowledge', id: entryId },
        severity: 'info',
        payload: {
          entryId,
          kind: draft.knowledgeKind ?? 'finding',
          title: clip(statement, 80),
          body: statement,
          confidence,
          sensitivity: draft.sensitivity ?? 'internal',
          tags: draft.tags !== undefined ? [...draft.tags, 'research'] : ['research'],
          sourceRunId: runId,
          sourceEventIds: [result.event.eventId],
          freshUntil: now + (draft.freshForMs ?? DEFAULT_KNOWLEDGE_FRESH_FOR_MS),
        },
      });
      recordedKnowledgeEntryIds.push(entryId);
    }
  };

  try {
    checkCancelled();

    // 1. research.requested — the recorded budget is the ledger-facing subset.
    const requestedBudget: ResearchBudget = {
      maxSources: tracker.budget.maxSources,
      maxDurationMs: tracker.budget.maxDurationMs,
    };
    const requestedKinds = adapters
      .map((adapter) => adapter.kind)
      .filter(
        (kind, index, all) =>
          all.indexOf(kind) === index &&
          (context.requestedSources === undefined || context.requestedSources.includes(kind)),
      );
    await append({
      type: 'research.requested',
      actor: RESEARCH_ACTOR,
      subject,
      severity: 'info',
      payload: {
        objective: redact(context.objective),
        requestedSources: requestedKinds,
        budget: requestedBudget,
      },
    });

    // 2. Seed prior knowledge — age, staleness, and confidence stay VISIBLE on
    //    every seeded finding (they are part of the statement + evidence).
    if (options.priorKnowledge !== undefined) {
      const now = clock();
      const matches: readonly KnowledgeQueryMatch[] = queryKnowledge(options.priorKnowledge, {
        now,
        includeStale: true,
        limit: options.maxSeededKnowledge ?? 5,
      });
      for (const match of matches) {
        checkCancelled();
        const entry = match.entry;
        const stale = isKnowledgeEntryStale(entry, now);
        const ageNote = `recorded ${new Date(entry.recordedAt).toISOString()}, age ${Math.round(match.ageMs / 1000)}s, confidence ${entry.confidence}${stale ? ', STALE' : ''}`;
        seededLines.push(`${clip(entry.title, 80)} (${ageNote})`);
        await recordFinding(
          `prior-${entry.entryId}`,
          {
            statement: `Prior knowledge (${entry.kind}, ${ageNote}): ${entry.body}`,
            classification: 'inference',
            confidence: entry.confidence,
            // Already in the index — never re-normalized (no duplicate entries).
            reusable: false,
          },
          [],
          [
            {
              label: 'prior-knowledge',
              ref: entry.entryId,
              note: ageNote,
            },
          ],
        );
      }
    }

    // 3. Consult adapters in order, policy first, then setup, then budget.
    let passStopped = false;
    for (const adapter of adapters) {
      checkCancelled();
      if (passStopped) {
        break;
      }
      if (
        context.requestedSources !== undefined &&
        !context.requestedSources.includes(adapter.kind)
      ) {
        continue;
      }

      // 3a. Source policy BEFORE any adapter I/O.
      const classDecision = evaluateSourceClass(policy, adapter.kind);
      if (!classDecision.allowed) {
        await recordGap(
          `g-policy-${adapter.id}`,
          `Research source '${adapter.id}' (${adapter.kind}) was not consulted: ${classDecision.reason} Enable the source class in the research source policy if it is needed.`,
          'Evidence from this source class is missing from the brief.',
          false,
        );
        continue;
      }

      // 3b. Setup/credentials — fail closed with setup event + gap.
      const setup = await adapter.detectSetup();
      const setupDecision = evaluateSourceSetup(setup);
      if (!setupDecision.allowed) {
        await append({
          type: 'adapter.setup_required',
          actor: RESEARCH_ACTOR,
          subject: { kind: 'adapter', id: adapter.id },
          severity: 'warn',
          evidence:
            setup.setupAction !== undefined
              ? [
                  {
                    label: setup.setupAction.title,
                    ref: setup.setupAction.id,
                    note: setup.setupAction.description,
                  },
                ]
              : undefined,
          payload: {
            action: setup.setupAction?.title ?? `Configure research source '${adapter.id}'.`,
            reason: setupDecision.reason,
          },
        });
        await recordGap(
          `g-setup-${adapter.id}`,
          `Research source '${adapter.id}' (${adapter.kind}) requires setup before it can be used: ${setupDecision.reason}`,
          'Research proceeded without this source; findings that depend on it are missing.',
          false,
        );
        continue;
      }

      // 3c. Budget precheck for this class before paying for discovery.
      const preStop = tracker.canReadSource(adapter.kind);
      if (preStop !== null) {
        if (preStop.global) {
          passStopped = true;
        }
        continue;
      }

      // 3d. Discover, bounded by the remaining global budget PLUS ONE — the
      // extra candidate lets the read loop detect that the budget truncated
      // available sources and record an explicit gap instead of silence.
      const remaining = Math.max(
        (tracker.budget.maxSources ?? Number.MAX_SAFE_INTEGER) - tracker.sourcesRead,
        0,
      );
      let discovered: readonly DiscoveredSource[];
      try {
        discovered = await adapter.discover(context, {
          limit: remaining + 1,
          signal: options.signal,
        });
      } catch (error) {
        checkCancelled();
        await recordGap(
          `g-discover-${adapter.id}`,
          `Source discovery failed for '${adapter.id}' (${adapter.kind}): ${redact(errorMessage(error))}`,
          'Sources from this adapter are missing from the brief.',
          false,
        );
        continue;
      }

      // 3e. Read each source within budget.
      for (const source of discovered) {
        checkCancelled();
        const stop = tracker.canReadSource(adapter.kind);
        if (stop !== null) {
          if (stop.global) {
            passStopped = true;
          }
          break;
        }
        sourcesFound += 1;
        await append({
          type: 'research.source_found',
          actor: RESEARCH_ACTOR,
          subject,
          severity: 'info',
          payload: {
            sourceId: source.sourceId,
            kind: source.kind,
            title: source.title !== undefined ? redact(source.title) : undefined,
            locator: source.locator,
            summary: source.summary !== undefined ? redact(source.summary) : undefined,
          },
        });
        try {
          const readResult = await adapter.read(source, { signal: options.signal });
          tracker.noteSourceRead(adapter.kind);
          sourcesRead += 1;
          await append({
            type: 'research.source_read',
            actor: RESEARCH_ACTOR,
            subject,
            severity: 'info',
            payload: {
              sourceId: source.sourceId,
              summary: redact(readResult.summary),
              contentDigest: readResult.contentDigest,
            },
          });
          let findingSeq = 0;
          for (const draft of readResult.findings ?? []) {
            findingSeq += 1;
            await recordFinding(`f-${source.sourceId}-${findingSeq}`, draft, [source.sourceId]);
          }
          let assumptionSeq = 0;
          for (const draft of readResult.assumptions ?? []) {
            assumptionSeq += 1;
            assumptionCount += 1;
            await append({
              type: 'research.assumption_recorded',
              actor: RESEARCH_ACTOR,
              subject,
              severity: 'info',
              payload: {
                assumptionId: `a-${source.sourceId}-${assumptionSeq}`,
                statement: redact(draft.statement),
                reason: draft.reason !== undefined ? redact(draft.reason) : undefined,
                sourceIds: [source.sourceId],
              },
            });
          }
          let sourceGapSeq = 0;
          for (const draft of readResult.gaps ?? []) {
            sourceGapSeq += 1;
            await recordGap(
              `g-${source.sourceId}-${sourceGapSeq}`,
              draft.question,
              draft.impact,
              draft.blocking ?? false,
            );
          }
        } catch (error) {
          checkCancelled();
          await recordGap(
            `g-read-${source.sourceId}`,
            `Source '${source.sourceId}' (${source.locator ?? adapter.kind}) could not be read: ${redact(errorMessage(error))}`,
            'Evidence from this source is missing from the brief.',
            false,
          );
        }
      }
    }

    // 4. Budget stops become explicit unresolved gaps — bounded, not silent.
    for (const stop of tracker.stops) {
      await recordGap(
        `g-budget-${stop.rule}`,
        `Research budget exhausted (${stop.detail}); remaining sources were not read. Raise the budget or re-run research if more evidence is needed.`,
        'The brief is based on a bounded subset of available sources.',
        false,
      );
    }

    // 5. Deterministic enriched brief.
    const briefLines: string[] = [
      `Research brief: ${clip(redact(context.objective), 160)}`,
      `Sources: ${sourcesFound} found, ${sourcesRead} read. Findings: ${findingCount} (${verifiedCount} verified, ${findingCount - verifiedCount} inferred). Assumptions: ${assumptionCount}. Gaps: ${gapCount}.`,
    ];
    if (seededLines.length > 0) {
      briefLines.push(`Seeded prior knowledge: ${seededLines.join(' | ')}`);
    }
    if (topFindings.length > 0) {
      briefLines.push(`Top findings: ${topFindings.join(' | ')}`);
    }
    if (openGaps.length > 0) {
      briefLines.push(`Open gaps: ${openGaps.join(' | ')}`);
    }
    if (tracker.stops.length > 0) {
      briefLines.push(
        `Budget stops: ${tracker.stops.map((stop: BudgetStop) => stop.detail).join(' | ')}`,
      );
    }
    const briefSummary = briefLines.join('\n');
    await append({
      type: 'research.brief_completed',
      actor: RESEARCH_ACTOR,
      subject,
      severity: 'success',
      payload: { summary: briefSummary },
    });

    return {
      status: 'completed',
      briefSummary,
      sourcesFound,
      sourcesRead,
      findingCount,
      assumptionCount,
      gapCount,
      seededKnowledgeCount: seededLines.length,
      recordedKnowledgeEntryIds,
      budgetStops: tracker.stops.map((stop) => stop.detail),
    };
  } catch (error) {
    // Partial findings/gaps stay replayable on the ledger; record the failure.
    const reason = redact(errorMessage(error));
    await append({
      type: 'research.failed',
      actor: RESEARCH_ACTOR,
      subject,
      severity: 'error',
      payload: { reason },
    });
    return {
      status: 'failed',
      failureReason: reason,
      sourcesFound,
      sourcesRead,
      findingCount,
      assumptionCount,
      gapCount,
      seededKnowledgeCount: seededLines.length,
      recordedKnowledgeEntryIds,
      budgetStops: tracker.stops.map((stop) => stop.detail),
    };
  }
}

/** The source kinds a set of adapters can serve (unique, in adapter order). */
export function adapterSourceKinds(
  adapters: readonly ResearchSourceAdapter[],
): readonly ResearchSourceKind[] {
  return adapters
    .map((adapter) => adapter.kind)
    .filter((kind, index, all) => all.indexOf(kind) === index);
}
