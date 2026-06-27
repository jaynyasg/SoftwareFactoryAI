/**
 * Artifact projection: folds artifact lifecycle events into per-artifact views,
 * including the computed confidence and its contributing factors.
 */
import { detectSequenceGaps, resolveTargetRunId, validateAndSortEvents } from './run-projection';
import type { ProjectionDiagnostic } from './run-projection';
import type { FactoryEvent } from '../events/event-types';

export interface ArtifactView {
  readonly artifactId: string;
  readonly kind?: string;
  readonly path?: string;
  readonly ticketId?: string;
  readonly confidence?: number;
  readonly confidenceFactors?: Readonly<Record<string, number>>;
  readonly createdAt?: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export interface ArtifactProjection {
  readonly runId: string | null;
  readonly artifacts: ArtifactView[];
  readonly byId: Record<string, ArtifactView>;
  readonly diagnostics: ProjectionDiagnostic[];
}

interface MutableArtifact {
  artifactId: string;
  kind?: string;
  path?: string;
  ticketId?: string;
  confidence?: number;
  confidenceFactors?: Readonly<Record<string, number>>;
  createdAt?: number;
  firstSequence: number;
  lastSequence: number;
}

function artifactIdFor(event: FactoryEvent): string | undefined {
  if (event.type === 'artifact.created' || event.type === 'artifact.confidence_computed') {
    return event.payload.artifactId;
  }
  return undefined;
}

function toView(artifact: MutableArtifact): ArtifactView {
  return {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    path: artifact.path,
    ticketId: artifact.ticketId,
    confidence: artifact.confidence,
    confidenceFactors: artifact.confidenceFactors,
    createdAt: artifact.createdAt,
    firstSequence: artifact.firstSequence,
    lastSequence: artifact.lastSequence,
  };
}

export function projectArtifacts(raw: readonly unknown[], runId?: string): ArtifactProjection {
  const { events, diagnostics } = validateAndSortEvents(raw);
  const targetRunId = resolveTargetRunId(events, runId);
  const runEvents = targetRunId === null ? [] : events.filter((e) => e.runId === targetRunId);
  diagnostics.push(...detectSequenceGaps(runEvents));

  const map = new Map<string, MutableArtifact>();
  for (const event of runEvents) {
    const artifactId = artifactIdFor(event);
    if (artifactId === undefined) {
      continue;
    }
    const artifact =
      map.get(artifactId) ??
      ({
        artifactId,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
      } satisfies MutableArtifact);
    artifact.lastSequence = event.sequence;
    if (event.ticketId !== undefined) {
      artifact.ticketId = event.ticketId;
    }
    if (event.type === 'artifact.created') {
      artifact.kind = event.payload.kind;
      artifact.path = event.payload.path ?? artifact.path;
      artifact.createdAt = event.timestamp;
    } else if (event.type === 'artifact.confidence_computed') {
      artifact.confidence = event.payload.confidence;
      artifact.confidenceFactors = event.payload.factors ?? artifact.confidenceFactors;
    }
    map.set(artifactId, artifact);
  }

  const artifacts = [...map.values()]
    .sort((a, b) => {
      if (a.firstSequence !== b.firstSequence) {
        return a.firstSequence - b.firstSequence;
      }
      return a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0;
    })
    .map(toView);

  const byId: Record<string, ArtifactView> = {};
  for (const artifact of artifacts) {
    byId[artifact.artifactId] = artifact;
  }

  return { runId: targetRunId, artifacts, byId, diagnostics };
}
