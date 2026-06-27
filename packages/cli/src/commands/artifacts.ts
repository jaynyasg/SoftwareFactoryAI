/**
 * `software-factory artifacts <runId>` — list a run's artifacts and the key
 * delivery references (repo path, handoff, preview, hosted url), derived from
 * the ledger via the shared run-output contract.
 */
import type { ApiClient } from '../api-client';
import type { CliIo } from '../cli-io';
import { buildRunOutputs } from '../run-outputs';
import type { ArtifactOutput } from '../run-outputs';

export interface ArtifactsCommandArgs {
  readonly runId: string;
  readonly json?: boolean;
}

export interface ArtifactsCommandDeps {
  readonly client: ApiClient;
  readonly io: CliIo;
}

export interface ArtifactsResult {
  readonly runId: string;
  readonly artifacts: readonly ArtifactOutput[];
  readonly repoPath?: string;
  readonly handoffRef?: string;
  readonly previewUrl?: string;
  readonly hostedUrl?: string;
}

export async function artifactsCommand(
  args: ArtifactsCommandArgs,
  deps: ArtifactsCommandDeps,
): Promise<ArtifactsResult> {
  const { client, io } = deps;
  const { events } = await client.getEvents(args.runId);
  const outputs = buildRunOutputs(args.runId, events, client.eventsUrl(args.runId));
  const result: ArtifactsResult = {
    runId: args.runId,
    artifacts: outputs.artifacts,
    repoPath: outputs.repoPath,
    handoffRef: outputs.handoffRef,
    previewUrl: outputs.previewUrl,
    hostedUrl: outputs.hostedUrl,
  };

  if (args.json === true) {
    io.out(JSON.stringify(result, null, 2));
    return result;
  }

  io.out(`Artifacts for run ${args.runId}:`);
  if (result.artifacts.length === 0) {
    io.out('  (no artifacts recorded yet)');
  }
  for (const artifact of result.artifacts) {
    const confidence =
      artifact.confidence !== undefined ? ` (${Math.round(artifact.confidence * 100)}% confidence)` : '';
    io.out(`  - ${artifact.artifactId} [${artifact.kind ?? 'artifact'}]${confidence} ${artifact.path ?? ''}`);
  }
  io.out(`  repo path:   ${result.repoPath ?? '(pending)'}`);
  io.out(`  handoff:     ${result.handoffRef ?? '(pending)'}`);
  io.out(`  preview url: ${result.previewUrl ?? '(pending)'}`);
  io.out(`  hosted url:  ${result.hostedUrl ?? '(pending)'}`);
  return result;
}
