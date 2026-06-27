/**
 * `software-factory events <runId>` — print a run's ledger events.
 *
 * One-shot by default; `--follow` streams with resume (by `last_sequence`) and
 * reconnect. `--json` emits one JSON object per event (JSONL) on stdout; human
 * mode prints one formatted line per event. `--since <n>` starts after a known
 * sequence so a consumer can resume where it left off.
 */
import type { FactoryEvent } from '@software-factory/core';
import type { ApiClient } from '../api-client';
import type { CliIo } from '../cli-io';
import { formatEventLine } from '../cli-io';
import { streamRunEvents } from '../stream';

export interface EventsCommandArgs {
  readonly runId: string;
  readonly follow?: boolean;
  readonly json?: boolean;
  readonly since?: number;
  readonly pollIntervalMs?: number;
  readonly maxWaitMs?: number;
}

export interface EventsCommandDeps {
  readonly client: ApiClient;
  readonly io: CliIo;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export async function eventsCommand(
  args: EventsCommandArgs,
  deps: EventsCommandDeps,
): Promise<readonly FactoryEvent[]> {
  const { client, io } = deps;
  const print = (event: FactoryEvent): void => {
    io.out(args.json === true ? JSON.stringify(event) : formatEventLine(event));
  };

  if (args.follow === true) {
    const result = await streamRunEvents(client, args.runId, {
      sleep: deps.sleep,
      now: deps.now,
      pollIntervalMs: args.pollIntervalMs,
      maxWaitMs: args.maxWaitMs,
      onEvent: print,
      onReconnect: (attempt, lastSequence) =>
        io.err(`reconnecting (attempt ${attempt}); resuming from sequence ${lastSequence}…`),
    });
    return result.events;
  }

  // One-shot: a missing run raises ApiError(404), surfaced by the caller.
  const { events } = await client.getEvents(args.runId, { sinceSequence: args.since });
  for (const event of events) {
    print(event);
  }
  return events;
}
