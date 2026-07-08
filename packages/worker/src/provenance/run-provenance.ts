/**
 * Run provenance derivation (full-factory U8).
 *
 * `deriveRunProvenance` assembles the portable `ProvenanceBundle` + the blended
 * artifact confidence for a COMPLETED run exclusively from replayed state: the
 * run's ledger events, its projected run/ticket views, and an (injectable)
 * listing of the generated workspace files. Nothing is invented — every section
 * traces to a real event, projection, or file on disk:
 *
 *  - source          — the run projection's prompt/PRD/title,
 *  - ticketPlan      — the projected ticket DAG with final states,
 *  - events/adapters/gateEvidence/preview/reducedTrust — derived from the
 *    ledger by core's pure provenance helpers,
 *  - generatedFiles  — the injected workspace listing (`listWorkspaceFiles`
 *    provides a bounded fs walk that skips `.git`/`node_modules`/`.factory`),
 *  - confidence      — `computeArtifactConfidence` over the gate tally, tests
 *    presence, provenance completeness, dependency risk, preview evidence,
 *    and sandbox trust (each derived, not asserted).
 *
 * The derivation is deterministic for identical inputs; the default file lister
 * is the only I/O and is injectable so tests stay hermetic.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assembleProvenanceBundle,
  computeArtifactConfidence,
  deriveGateEvidenceFromEvents,
  derivePreviewFromEvents,
  deriveReducedTrust,
  provenanceCompleteness,
} from '@software-factory/core';
import type {
  ArtifactConfidenceResult,
  FactoryEvent,
  ProvenanceBundle,
  ProvenanceDependencyDecision,
  ProvenanceDeployConfig,
  ProvenanceGeneratedFile,
  ProvenanceGitDestination,
  ProvenanceTicket,
  RiskTier,
  RunProjection,
  TicketProjection,
} from '@software-factory/core';

/** Directories the default workspace lister never descends into. */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.factory', '.next', 'dist']);

/** Bound on the number of files the default lister records. */
export const MAX_GENERATED_FILES = 500;

/** List workspace files (repo-relative, sorted, bounded). Injectable seam. */
export type WorkspaceFileLister = (workspaceDir: string) => Promise<readonly string[]>;

/**
 * Default lister: bounded recursive walk of the workspace directory, skipping
 * VCS/dependency/build directories. Paths are repo-relative with `/` separators
 * so bundles are portable across platforms.
 */
export async function listWorkspaceFiles(workspaceDir: string): Promise<readonly string[]> {
  const files: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (files.length >= MAX_GENERATED_FILES) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable directory yields no entries, never a crash
    }
    // Deterministic order regardless of filesystem enumeration order.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= MAX_GENERATED_FILES) {
        return;
      }
      const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          await walk(join(dir, entry.name), relative);
        }
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  await walk(workspaceDir, '');
  return files;
}

/** Inputs to `deriveRunProvenance`. */
export interface DeriveRunProvenanceInput {
  readonly runId: string;
  readonly artifactId: string;
  /** The run's full ledger events (replayed, never invented). */
  readonly events: readonly FactoryEvent[];
  readonly run: RunProjection;
  readonly tickets: TicketProjection;
  /** Repo-relative generated file paths (from `listWorkspaceFiles`). */
  readonly generatedFiles: readonly string[];
  /** Deploy config summary, when a deploy target is planned. */
  readonly deployConfig?: ProvenanceDeployConfig;
  readonly gitDestination?: ProvenanceGitDestination;
  /** Dependency decisions, when a dependency policy ran (default none). */
  readonly dependencyDecisions?: readonly ProvenanceDependencyDecision[];
  /** Cap on the bundle's event excerpt (default 200 most-recent events). */
  readonly maxEvents?: number;
  readonly generatedAt?: number;
}

/** The derived bundle plus the confidence that was embedded into it. */
export interface DerivedRunProvenance {
  readonly bundle: ProvenanceBundle;
  readonly confidence: ArtifactConfidenceResult;
}

const DEFAULT_MAX_EVENTS = 200;

function toProvenanceTickets(tickets: TicketProjection): ProvenanceTicket[] {
  return tickets.tickets.map((ticket) => ({
    id: ticket.ticketId,
    title: ticket.title ?? ticket.ticketId,
    moduleId: ticket.moduleId,
    dependsOn: ticket.dependsOn.length > 0 ? [...ticket.dependsOn] : undefined,
    riskTier: ticket.riskTier,
    state: ticket.state === 'unknown' ? undefined : ticket.state,
  }));
}

/** Highest projected ticket risk tier — the aggregate dependency-risk input. */
function aggregateRisk(tickets: TicketProjection): RiskTier {
  let highest: RiskTier = 'low';
  for (const ticket of tickets.tickets) {
    if (ticket.riskTier === 'high') {
      return 'high';
    }
    if (ticket.riskTier === 'medium') {
      highest = 'medium';
    }
  }
  return highest;
}

/**
 * Derive the provenance bundle + artifact confidence for a completed run.
 * Pure over its inputs (the caller supplies the file listing).
 */
export function deriveRunProvenance(input: DeriveRunProvenanceInput): DerivedRunProvenance {
  const gateEvidence = deriveGateEvidenceFromEvents(input.events);
  const preview = derivePreviewFromEvents(input.events);
  const reducedTrust = deriveReducedTrust(input.events);
  const ticketPlan = toProvenanceTickets(input.tickets);
  const generatedFiles: ProvenanceGeneratedFile[] = input.generatedFiles.map((path) => ({
    path,
  }));

  // Gate tally over the LATEST outcome per gate (a repaired gate that finally
  // passed counts as passed, not as one pass + one fail).
  const latestByGate = new Map<string, boolean>();
  let testsPresent = false;
  for (const evidence of gateEvidence) {
    latestByGate.set(evidence.gate, evidence.passed);
    if (/test/i.test(evidence.gate)) {
      testsPresent = true;
    }
  }
  const gateTotal = latestByGate.size;
  let gatePassed = 0;
  for (const passed of latestByGate.values()) {
    if (passed) {
      gatePassed += 1;
    }
  }

  // Provenance completeness is computed over the DRAFT sections so the
  // confidence factor reflects what the final bundle will actually contain.
  const completeness = provenanceCompleteness({
    source: {
      prompt: input.run.prompt,
      prdRef: input.run.prdRef,
      prdText: input.run.prdText,
    },
    ticketPlan,
    events: input.events,
    adapters: input.events.filter((event) => event.type === 'adapter.selected'),
    gateEvidence,
    generatedFiles,
    dependencyDecisions: input.dependencyDecisions,
    preview,
    deployConfig: input.deployConfig,
  });

  const confidence = computeArtifactConfidence({
    gates: { passed: gatePassed, total: gateTotal },
    testsPresent,
    provenanceCompleteness: completeness,
    dependencyRisk: aggregateRisk(input.tickets),
    sandboxFallback: reducedTrust,
    previewInspected: preview.status === 'ready' || preview.status === 'failed',
    previewHealthy: preview.status === 'ready',
  });

  const bundle = assembleProvenanceBundle({
    runId: input.runId,
    artifactId: input.artifactId,
    source: {
      prompt: input.run.prompt,
      prdRef: input.run.prdRef,
      prdText: input.run.prdText,
      title: input.run.title,
    },
    ticketPlan,
    events: input.events,
    generatedFiles,
    confidence: { confidence: confidence.confidence, factors: confidence.factors },
    gateEvidence,
    dependencyDecisions: input.dependencyDecisions,
    preview,
    deployConfig: input.deployConfig,
    gitDestination: input.gitDestination,
    reducedTrust,
    maxEvents: input.maxEvents ?? DEFAULT_MAX_EVENTS,
    generatedAt: input.generatedAt,
  });

  return { bundle, confidence };
}
