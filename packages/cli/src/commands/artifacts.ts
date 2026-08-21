/**
 * `software-factory artifacts <runId>` — list a run's artifacts and the key
 * delivery references (repo path, handoff, provenance, gates, preview, deploy
 * state, hosted url), derived from the ledger via the shared run-output
 * contract. The hosted URL is present ONLY after `deploy.hosted_ready`
 * (provider success AND hosted health pass — R29); deploy pauses/failures
 * surface as retryable deploy state without hiding the local artifacts (R30).
 */
import type { ApiClient } from '../api-client';
import type { CliIo } from '../cli-io';
import { buildRunOutputs } from '../run-outputs';
import type { ArtifactOutput, DeployOutput, GateOutput } from '../run-outputs';

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
  /** Provenance bundle reference (repo-relative), when packaged (U8). */
  readonly provenanceRef?: string;
  /** Human handoff summary, when packaged/completed (U8). */
  readonly handoffSummary?: string;
  readonly previewUrl?: string;
  /** Present ONLY after provider success and hosted health pass (R29). */
  readonly hostedUrl?: string;
  /** Projected deploy state (retryable until hosted-ready) (U8/R30). */
  readonly deploy: DeployOutput;
  /** Gate evidence rows (pass/fail with detail) (U8/R26). */
  readonly gates: readonly GateOutput[];
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
    provenanceRef: outputs.provenanceRef,
    handoffSummary: outputs.handoffSummary,
    previewUrl: outputs.previewUrl,
    hostedUrl: outputs.hostedUrl,
    deploy: outputs.deploy,
    gates: outputs.tests.gates,
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
      artifact.confidence !== undefined
        ? ` (${Math.round(artifact.confidence * 100)}% confidence)`
        : '';
    io.out(
      `  - ${artifact.artifactId} [${artifact.kind ?? 'artifact'}]${confidence} ${artifact.path ?? ''}`,
    );
  }
  io.out(`  repo path:   ${result.repoPath ?? '(pending)'}`);
  io.out(`  handoff:     ${result.handoffRef ?? '(pending)'}`);
  io.out(`  provenance:  ${result.provenanceRef ?? '(pending)'}`);
  io.out(`  gates:       ${outputs.tests.summary}`);
  io.out(`  preview url: ${result.previewUrl ?? '(pending)'}`);
  if (result.deploy.status !== 'idle') {
    const detail = result.deploy.action ?? result.deploy.reason;
    io.out(
      `  deploy:      ${result.deploy.status}${result.deploy.retryable ? ' (retryable)' : ''}${
        detail !== undefined ? ` — ${detail}` : ''
      }`,
    );
  }
  io.out(`  hosted url:  ${result.hostedUrl ?? '(pending)'}`);
  if (result.handoffSummary !== undefined) {
    io.out(`  summary:     ${result.handoffSummary}`);
  }
  return result;
}
