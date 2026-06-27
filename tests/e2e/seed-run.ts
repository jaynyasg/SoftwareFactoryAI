/**
 * E2E seed helper. The Factory Floor renders an active run purely from ledger
 * events, but the U4–U7 runtime that produces those events is not wired into the
 * web dev server (U8 is the UI unit). To exercise a rich active run end to end,
 * these specs POST a fully-formed event log to the dev-only `/data/seed` route,
 * which appends it THROUGH the singleton store in-process (so the store cache
 * reflects it immediately). Each spec uses a unique run id and seeds BEFORE
 * navigating.
 */
import type { APIRequestContext } from '@playwright/test';
import type { FactoryEvent } from '@software-factory/core';
import { buildMarketplaceRunEvents } from '../fixtures/marketplace-run';

/** Append a run's event log to the dev server via the in-process seed route. */
export async function seedRun(
  request: APIRequestContext,
  events: readonly FactoryEvent[],
): Promise<void> {
  const response = await request.post('/data/seed', { data: { events } });
  if (!response.ok()) {
    throw new Error(`seed failed: ${response.status()} ${await response.text()}`);
  }
}

/** Seed a full marketplace run and return its id. */
export async function seedMarketplaceRun(
  request: APIRequestContext,
  prefix: string,
): Promise<string> {
  const runId = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await seedRun(request, buildMarketplaceRunEvents(runId));
  return runId;
}
