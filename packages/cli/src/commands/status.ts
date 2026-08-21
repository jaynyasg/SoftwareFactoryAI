/**
 * `software-factory status <runId>` — print a run's projected status and the
 * same artifact-output contract `run` returns, derived purely from the ledger.
 */
import type { ApiClient } from '../api-client';
import type { CliIo } from '../cli-io';
import { formatRunOutputs } from '../cli-io';
import { buildRunOutputs } from '../run-outputs';
import type { RunOutputs } from '../run-outputs';

export interface StatusCommandArgs {
  readonly runId: string;
  readonly json?: boolean;
}

export interface StatusCommandDeps {
  readonly client: ApiClient;
  readonly io: CliIo;
}

export async function statusCommand(
  args: StatusCommandArgs,
  deps: StatusCommandDeps,
): Promise<RunOutputs> {
  // Read-only: a missing run raises ApiError(404), surfaced by the caller.
  const { events } = await deps.client.getEvents(args.runId);
  const outputs = buildRunOutputs(args.runId, events, deps.client.eventsUrl(args.runId));
  deps.io.out(args.json === true ? JSON.stringify(outputs, null, 2) : formatRunOutputs(outputs));
  return outputs;
}
