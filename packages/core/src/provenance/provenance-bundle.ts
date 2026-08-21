/**
 * Provenance bundle: the single, portable record of HOW an artifact was built.
 *
 * `assembleProvenanceBundle` is a PURE assembly over provided inputs (run request,
 * ticket plan, ledger events, gate evidence, generated files, dependency
 * decisions, preview result, deploy config, git destination, and the artifact
 * confidence). It records the source prompt/PRD, derives an event excerpt + gate
 * evidence + adapter metadata + preview result + reduced-trust flag from the
 * ledger when not supplied explicitly, and stamps a version. The bundle is what
 * the repo packager writes as `PROVENANCE.json` and what artifact confidence's
 * provenance-completeness factor is computed from.
 *
 * Everything here is pure: no clocks (a timestamp may be passed in), randomness,
 * or I/O.
 */
import type {
  EventSeverity,
  FactoryEvent,
  FactoryEventType,
  RiskTier,
  TicketState,
} from '../events/event-types';

/** Bump when the bundle shape changes incompatibly. */
export const PROVENANCE_BUNDLE_VERSION = 1 as const;

/** The source request an artifact traces back to. */
export interface ProvenanceSource {
  readonly prompt?: string;
  readonly prdRef?: string;
  readonly prdText?: string;
  readonly title?: string;
  readonly intent?: string;
}

/** One planned ticket recorded in the provenance bundle. */
export interface ProvenanceTicket {
  readonly id: string;
  readonly title: string;
  readonly moduleId?: string;
  readonly dependsOn?: readonly string[];
  readonly riskTier?: RiskTier;
  readonly state?: TicketState;
}

/** A compact, replay-safe excerpt of one ledger event. */
export interface ProvenanceEventExcerpt {
  readonly sequence: number;
  readonly type: FactoryEventType;
  readonly severity: EventSeverity;
  readonly timestamp: number;
  readonly ticketId?: string;
  /** A human-facing detail surfaced from the event payload (no invention). */
  readonly detail?: string;
}

/** Adapter metadata captured for an execution (id, family, free-form extras). */
export interface ProvenanceAdapterMetadata {
  readonly adapterId?: string;
  readonly family?: string;
  readonly model?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A gate's pass/fail evidence, flattened for the bundle. */
export interface ProvenanceGateEvidence {
  readonly gate: string;
  readonly passed: boolean;
  readonly command?: string;
  readonly outputExcerpt?: string;
  readonly summary?: string;
  readonly reason?: string;
}

/** A generated file recorded in the bundle. */
export interface ProvenanceGeneratedFile {
  readonly path: string;
  readonly kind?: string;
  readonly digest?: string;
}

/** A portable dependency decision (mirrors the worker's dependency policy). */
export interface ProvenanceDependencyDecision {
  readonly name: string;
  readonly version?: string;
  readonly status: string;
  readonly riskTier: RiskTier;
  readonly reason?: string;
}

/** The local preview outcome captured in provenance. */
export interface ProvenancePreviewResult {
  readonly status: string;
  readonly url?: string;
  readonly reason?: string;
}

/** The deploy configuration (e.g. the Render blueprint summary). */
export interface ProvenanceDeployConfig {
  readonly provider: string;
  readonly serviceName?: string;
  readonly databaseName?: string;
  readonly healthCheckPath?: string;
  readonly buildCommand?: string;
  readonly startCommand?: string;
  /** The serialized blueprint (e.g. render.yaml), when generated. */
  readonly blueprint?: string;
}

/** The resolved git destination, including temporary-ownership marking. */
export interface ProvenanceGitDestination {
  readonly kind: 'user' | 'temporary';
  readonly owner?: string;
  readonly repo?: string;
  readonly remoteUrl?: string;
  /** `true` when the factory created/owns a TEMPORARY repo (cleanup required). */
  readonly temporary: boolean;
  readonly cleanupNote?: string;
}

/** The artifact confidence embedded in the bundle. */
export interface ProvenanceConfidence {
  readonly confidence: number;
  readonly factors: Readonly<Record<string, number>>;
}

/** The assembled provenance bundle. */
export interface ProvenanceBundle {
  readonly version: number;
  readonly runId: string;
  readonly artifactId: string;
  readonly generatedAt?: number;
  readonly source: ProvenanceSource;
  readonly ticketPlan: readonly ProvenanceTicket[];
  readonly events: readonly ProvenanceEventExcerpt[];
  readonly adapters: readonly ProvenanceAdapterMetadata[];
  readonly gateEvidence: readonly ProvenanceGateEvidence[];
  readonly generatedFiles: readonly ProvenanceGeneratedFile[];
  readonly dependencyDecisions: readonly ProvenanceDependencyDecision[];
  readonly preview: ProvenancePreviewResult;
  readonly deployConfig?: ProvenanceDeployConfig;
  readonly gitDestination?: ProvenanceGitDestination;
  readonly confidence: ProvenanceConfidence;
  /** `true` when any sandbox fallback (reduced trust) occurred during the run. */
  readonly reducedTrust: boolean;
}

/** Inputs to `assembleProvenanceBundle`. */
export interface AssembleProvenanceInput {
  readonly runId: string;
  readonly artifactId: string;
  readonly source: ProvenanceSource;
  readonly ticketPlan: readonly ProvenanceTicket[];
  /** Raw ledger events; an excerpt + several sections are derived from these. */
  readonly events: readonly FactoryEvent[];
  readonly generatedFiles: readonly ProvenanceGeneratedFile[];
  readonly confidence: ProvenanceConfidence;
  readonly adapters?: readonly ProvenanceAdapterMetadata[];
  readonly gateEvidence?: readonly ProvenanceGateEvidence[];
  readonly dependencyDecisions?: readonly ProvenanceDependencyDecision[];
  readonly preview?: ProvenancePreviewResult;
  readonly deployConfig?: ProvenanceDeployConfig;
  readonly gitDestination?: ProvenanceGitDestination;
  readonly reducedTrust?: boolean;
  /** Optional cap on the event excerpt (keeps the most recent N events). */
  readonly maxEvents?: number;
  readonly generatedAt?: number;
}

function detailOf(event: FactoryEvent): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  for (const key of ['reason', 'message', 'rationale', 'summary', 'action'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/** Build the compact event excerpt, optionally keeping only the most recent N. */
export function excerptEvents(
  events: readonly FactoryEvent[],
  maxEvents?: number,
): ProvenanceEventExcerpt[] {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const capped =
    maxEvents !== undefined && maxEvents > 0 && ordered.length > maxEvents
      ? ordered.slice(ordered.length - maxEvents)
      : ordered;
  return capped.map((event) => ({
    sequence: event.sequence,
    type: event.type,
    severity: event.severity,
    timestamp: event.timestamp,
    ticketId: event.ticketId,
    detail: detailOf(event),
  }));
}

/** Derive adapter metadata from `adapter.selected` events (deduped by id). */
export function deriveAdaptersFromEvents(
  events: readonly FactoryEvent[],
): ProvenanceAdapterMetadata[] {
  const byId = new Map<string, ProvenanceAdapterMetadata>();
  for (const event of events) {
    if (event.type === 'adapter.selected') {
      const { adapterId, family } = event.payload;
      if (!byId.has(adapterId)) {
        byId.set(adapterId, { adapterId, family });
      }
    }
  }
  return [...byId.values()];
}

/** Derive flattened gate evidence from `gate.passed` / `gate.failed` events. */
export function deriveGateEvidenceFromEvents(
  events: readonly FactoryEvent[],
): ProvenanceGateEvidence[] {
  const evidence: ProvenanceGateEvidence[] = [];
  for (const event of events) {
    if (event.type === 'gate.passed') {
      const first = event.evidence?.[0];
      evidence.push({
        gate: event.payload.gate,
        passed: true,
        command: first?.ref,
        outputExcerpt: first?.note,
        summary: event.payload.summary,
      });
    } else if (event.type === 'gate.failed') {
      const first = event.evidence?.[0];
      evidence.push({
        gate: event.payload.gate,
        passed: false,
        command: first?.ref,
        outputExcerpt: first?.note,
        reason: event.payload.reason,
      });
    }
  }
  return evidence;
}

/** Derive the latest preview result from `preview.*` events. */
export function derivePreviewFromEvents(events: readonly FactoryEvent[]): ProvenancePreviewResult {
  let result: ProvenancePreviewResult = { status: 'idle' };
  for (const event of events) {
    switch (event.type) {
      case 'preview.starting':
        result = { status: 'starting' };
        break;
      case 'preview.health_pending':
        result = { status: 'health_pending' };
        break;
      case 'preview.ready':
        result = { status: 'ready', url: event.payload.url };
        break;
      case 'preview.failed':
        result = { status: 'failed', reason: event.payload.reason };
        break;
      default:
        break;
    }
  }
  return result;
}

/** Whether any reduced-trust sandbox fallback occurred in the event log. */
export function deriveReducedTrust(events: readonly FactoryEvent[]): boolean {
  return events.some((event) => event.type === 'sandbox.fallback');
}

/**
 * Assemble a `ProvenanceBundle` from provided inputs. Sections not supplied
 * explicitly (adapters, gate evidence, preview, reduced-trust) are derived from
 * the ledger events. Pure assembly — never reads the filesystem or a clock.
 */
export function assembleProvenanceBundle(input: AssembleProvenanceInput): ProvenanceBundle {
  return {
    version: PROVENANCE_BUNDLE_VERSION,
    runId: input.runId,
    artifactId: input.artifactId,
    generatedAt: input.generatedAt,
    source: input.source,
    ticketPlan: input.ticketPlan,
    events: excerptEvents(input.events, input.maxEvents),
    adapters: input.adapters ?? deriveAdaptersFromEvents(input.events),
    gateEvidence: input.gateEvidence ?? deriveGateEvidenceFromEvents(input.events),
    generatedFiles: input.generatedFiles,
    dependencyDecisions: input.dependencyDecisions ?? [],
    preview: input.preview ?? derivePreviewFromEvents(input.events),
    deployConfig: input.deployConfig,
    gitDestination: input.gitDestination,
    confidence: input.confidence,
    reducedTrust: input.reducedTrust ?? deriveReducedTrust(input.events),
  };
}

/** The provenance sections counted toward completeness (a subset of the bundle). */
export interface ProvenanceSections {
  readonly source?: ProvenanceSource;
  readonly ticketPlan?: readonly unknown[];
  readonly events?: readonly unknown[];
  readonly adapters?: readonly unknown[];
  readonly gateEvidence?: readonly unknown[];
  readonly generatedFiles?: readonly unknown[];
  readonly dependencyDecisions?: readonly unknown[];
  readonly preview?: ProvenancePreviewResult;
  readonly deployConfig?: unknown;
}

/** The nine sections that make up a "complete" provenance bundle. */
export const PROVENANCE_SECTION_COUNT = 9;

function hasItems(value: readonly unknown[] | undefined): boolean {
  return value !== undefined && value.length > 0;
}

/**
 * Provenance completeness in 0..1 = fraction of the nine canonical sections that
 * are present and non-empty. A `ProvenanceBundle` structurally satisfies
 * `ProvenanceSections`, so this accepts either a bundle or a partial draft. This
 * is what feeds the `provenanceCompleteness` factor of artifact confidence, so a
 * thinner bundle yields a lower score.
 */
export function provenanceCompleteness(sections: ProvenanceSections): number {
  const checks: readonly boolean[] = [
    Boolean(sections.source?.prompt || sections.source?.prdRef || sections.source?.prdText),
    hasItems(sections.ticketPlan),
    hasItems(sections.events),
    hasItems(sections.adapters),
    hasItems(sections.gateEvidence),
    hasItems(sections.generatedFiles),
    hasItems(sections.dependencyDecisions),
    sections.preview !== undefined &&
      sections.preview.status !== undefined &&
      sections.preview.status !== 'idle',
    sections.deployConfig !== undefined,
  ];
  const present = checks.filter(Boolean).length;
  return Math.round((present / PROVENANCE_SECTION_COUNT) * 10_000) / 10_000;
}
