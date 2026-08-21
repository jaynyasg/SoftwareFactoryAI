/**
 * Event streaming with resume + reconnect.
 *
 * The backend exposes the ledger as a read-only JSON log (no SSE), so the CLI
 * "streams" by polling `GET /api/runs/:id/events` and resuming from the highest
 * sequence it has already seen (`sinceSequence`) — never re-printing an event.
 * A failed poll is treated as a transient disconnect: it backs off and retries
 * up to `maxReconnects`, surfacing a reconnect notice, then resumes from the
 * same sequence cursor.
 */
import { projectRun } from '@software-factory/core';
import type { FactoryEvent, RunStatus } from '@software-factory/core';
import type { ApiClient } from './api-client';

export function isTerminalStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export interface StreamOptions {
  /** Called once per newly-observed event, in sequence order. */
  readonly onEvent?: (event: FactoryEvent) => void;
  /** Called with a 1-based attempt number when a poll fails and will retry. */
  readonly onReconnect?: (attempt: number, lastSequence: number) => void;
  /** Stop predicate. Defaults to: terminal status, or `planned` once idle. */
  readonly shouldStop?: (events: readonly FactoryEvent[], hadNew: boolean) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly maxWaitMs?: number;
  readonly maxReconnects?: number;
}

export interface StreamResult {
  readonly events: readonly FactoryEvent[];
  readonly lastSequence: number;
  readonly settled: boolean;
  readonly timedOut: boolean;
}

function defaultShouldStop(events: readonly FactoryEvent[], hadNew: boolean): boolean {
  const status = projectRun([...events]).status;
  if (isTerminalStatus(status)) {
    return true;
  }
  // V1 run flow is planning-only: once planned and the log is idle, it's settled.
  return status === 'planned' && !hadNew;
}

/**
 * Poll a run's event log until the stop predicate fires, the wait budget is
 * exceeded, or reconnect attempts are exhausted. Returns every observed event.
 */
export async function streamRunEvents(
  client: ApiClient,
  runId: string,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const maxReconnects = options.maxReconnects ?? 5;
  const shouldStop = options.shouldStop ?? defaultShouldStop;

  const all: FactoryEvent[] = [];
  let lastSequence = 0;
  let reconnects = 0;
  const deadline = now() + maxWaitMs;

  for (;;) {
    let hadNew = false;
    try {
      const batch = await client.getEvents(runId, { sinceSequence: lastSequence });
      reconnects = 0;
      for (const event of batch.events) {
        all.push(event);
        if (event.sequence > lastSequence) {
          lastSequence = event.sequence;
        }
        options.onEvent?.(event);
        hadNew = true;
      }
    } catch (error) {
      reconnects += 1;
      if (reconnects > maxReconnects) {
        throw error;
      }
      options.onReconnect?.(reconnects, lastSequence);
      await sleep(pollIntervalMs);
      continue;
    }

    if (shouldStop(all, hadNew)) {
      return { events: all, lastSequence, settled: true, timedOut: false };
    }
    if (now() >= deadline) {
      return { events: all, lastSequence, settled: false, timedOut: true };
    }
    await sleep(pollIntervalMs);
  }
}
