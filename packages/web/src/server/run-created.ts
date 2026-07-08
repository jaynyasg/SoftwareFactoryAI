/**
 * Shared reader for a run's recorded `run.created` payload.
 *
 * The runtime researcher (U2) and runtime workspace materializer (U4) both
 * derive their source context (prompt, PRD, local folder, GitHub repo) from
 * this payload. A run without one — or with a malformed payload — yields the
 * empty payload, so both wrappers fail closed on absent sources.
 */
import type { FactoryEvent, RunCreatedPayload } from '@software-factory/core';

export function runCreatedPayload(events: readonly FactoryEvent[]): RunCreatedPayload {
  const created = events.find((event) => event.type === 'run.created');
  return created !== undefined && typeof created.payload === 'object' && created.payload !== null
    ? (created.payload as RunCreatedPayload)
    : {};
}
