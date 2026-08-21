/**
 * Golden-run replay (U11).
 *
 * (a) REPLAY DETERMINISM — pure, no browser: load the committed golden JSONL,
 *     project it TWICE through the real core projections + observability, and
 *     assert the run/ticket/artifact/operator/metrics/diagnostics outputs are
 *     deep-equal and carry no unexpected diagnostics. This is the contract that a
 *     recorded event log replays into stable projections.
 *
 * (b) UI — seed the golden run (under a fresh, parallel-safe id) via the dev-only
 *     /data/seed route and assert the run page and the /operator dashboard render
 *     the expected states: capacity throttle, reduced-trust sandbox fallback,
 *     gate failed, the deploy failure states, and the hosted URL — shown ONLY
 *     because hosted health passed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  computeOperatorMetrics,
  computeRunDiagnostics,
  projectArtifacts,
  projectOperator,
  projectRun,
  projectTickets,
} from '@software-factory/core';
import type { FactoryEvent } from '@software-factory/core';
import { seedRun } from './seed-run';

const GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/golden-runs/ai-services-marketplace.jsonl',
);

const GOLDEN_RUN_ID = 'golden-ai-services-marketplace';
/** A fixed clock so metrics are deterministic across the two replay passes. */
const FIXED_NOW = 1_700_000_200_000;

function loadGolden(): FactoryEvent[] {
  return readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FactoryEvent);
}

/** Rebind a golden event log to a fresh run id (keeps ticket ids stable). */
function reidentify(events: readonly FactoryEvent[], runId: string): FactoryEvent[] {
  return events.map((event) => ({
    ...event,
    runId,
    subject: event.subject.kind === 'run' ? { ...event.subject, id: runId } : event.subject,
  }));
}

test.describe('golden run — replay determinism (no browser)', () => {
  test('projects into stable, diagnostic-free run/ticket/artifact/operator projections', () => {
    // Two independent parses == replaying the recorded log twice.
    const a = loadGolden();
    const b = loadGolden();

    expect(projectRun(a, GOLDEN_RUN_ID)).toEqual(projectRun(b, GOLDEN_RUN_ID));
    expect(projectTickets(a, GOLDEN_RUN_ID)).toEqual(projectTickets(b, GOLDEN_RUN_ID));
    expect(projectArtifacts(a, GOLDEN_RUN_ID)).toEqual(projectArtifacts(b, GOLDEN_RUN_ID));
    expect(projectOperator(a, GOLDEN_RUN_ID)).toEqual(projectOperator(b, GOLDEN_RUN_ID));
    expect(computeOperatorMetrics(a, { runId: GOLDEN_RUN_ID, now: FIXED_NOW })).toEqual(
      computeOperatorMetrics(b, { runId: GOLDEN_RUN_ID, now: FIXED_NOW }),
    );
    expect(computeRunDiagnostics(a, { runId: GOLDEN_RUN_ID })).toEqual(
      computeRunDiagnostics(b, { runId: GOLDEN_RUN_ID }),
    );
  });

  test('reconstructs the expected run/ticket/deploy/operator state with no unexpected diagnostics', () => {
    const events = loadGolden();
    const run = projectRun(events, GOLDEN_RUN_ID);
    const tickets = projectTickets(events, GOLDEN_RUN_ID);
    const operator = projectOperator(events, GOLDEN_RUN_ID);
    const metrics = computeOperatorMetrics(events, { runId: GOLDEN_RUN_ID, now: FIXED_NOW });
    const diag = computeRunDiagnostics(events, { runId: GOLDEN_RUN_ID });

    // Stable run + ticket projections.
    expect(run.status).toBe('completed');
    expect(run.plannedTicketCount).toBe(12);
    expect(tickets.tickets).toHaveLength(12);
    expect(tickets.tickets.every((ticket) => ticket.state === 'completed')).toBe(true);

    // No replay-integrity problems anywhere.
    expect(run.diagnostics).toHaveLength(0);
    expect(operator.diagnostics).toHaveLength(0);
    expect(diag.projectionDiagnostics).toHaveLength(0);
    expect(metrics.lag.projectionLagEvents).toBe(0);

    // The full failure taxonomy is exercised and recovers to a healthy deploy.
    expect(metrics.adapter.authFailures).toBeGreaterThan(0);
    expect(metrics.adapter.throttled).toBe(true);
    expect(metrics.sandbox.fallback).toBe(true);
    expect(metrics.gates.failures).toBeGreaterThan(0);
    expect(metrics.deploy.providerFailed).toBeGreaterThan(0);
    expect(metrics.deploy.healthFailed).toBeGreaterThan(0);
    expect(metrics.deploy.status).toBe('hosted_ready');
    expect(metrics.hostedHealth).toBe('ready');

    // Recovered run: only the reduced-trust fallback remains "active", nothing blocking.
    expect(diag.blockingFailures).toHaveLength(0);
    expect(diag.reducedTrust).toBe(true);
    expect(diag.healthy).toBe(true);
  });
});

test.describe('golden run — UI replay', () => {
  test('run page + operator dashboard render the seeded golden states', async ({ page }) => {
    const runId = `golden-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await seedRun(page.request, reidentify(loadGolden(), runId));

    // --- Run page (user surface) ---------------------------------------------
    await page.goto(`/runs/${runId}`);

    // Capacity throttle (requested 5 -> adapter capacity 3) + system-gated cap.
    await expect(page.getByText('capacity 3 / 5')).toBeVisible();
    await expect(page.getByText('cap is system-gated')).toBeVisible();

    // Reduced-trust sandbox fallback is loud + labeled.
    await expect(page.getByTestId('run-reduced-trust')).toBeVisible();

    // Trace ledger carries the failure event.
    const ledger = page.getByRole('log', { name: 'Run event stream' });
    await expect(ledger.getByText('gate.failed')).toBeVisible();

    // Deploy recovered to healthy, so the hosted URL is shown (only after health).
    await expect(page.getByTestId('deploy-phase')).toContainText('Hosted & healthy');
    await expect(page.getByTestId('hosted-url')).toBeVisible();

    // --- Operator dashboard (operator surface) -------------------------------
    await page.goto(`/operator?runId=${runId}`);

    await expect(page.getByRole('heading', { name: 'Operator dashboard' })).toBeVisible();

    // Adapter: unavailable (had auth/setup failures) + capacity throttled.
    await expect(page.getByTestId('adapter-unavailable')).toBeVisible();
    await expect(page.getByTestId('capacity-throttled')).toBeVisible();

    // Health: reduced-trust sandbox fallback.
    await expect(page.getByTestId('sandbox-fallback')).toBeVisible();

    // Queue: a gate failed.
    await expect(page.getByTestId('gate-failed')).toBeVisible();

    // Deploy: setup-required, provider-failed, hosted-health-failed states all shown,
    // and the hosted URL present only because hosted health ultimately passed.
    await expect(page.getByTestId('deploy-setup-required')).toBeVisible();
    await expect(page.getByTestId('deploy-provider-failed')).toBeVisible();
    await expect(page.getByTestId('deploy-health-failed')).toBeVisible();
    await expect(page.getByTestId('hosted-health')).toContainText('ready');
    await expect(page.getByTestId('hosted-url')).toBeVisible();
  });
});
