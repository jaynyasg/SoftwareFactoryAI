/**
 * Factory Floor e2e (U8) — drives the real Next app over the loopback baseURL.
 *
 * Covers: the home intake/empty affordances with no fake progress; an active run
 * rendered entirely from seeded ledger events (supervisor, tickets, worker
 * capacity, trace ledger, review studio, artifact confidence, deploy, reduced-
 * trust, preview); the system-gated 1..20 worker cap; and the trace ledger
 * reconnect-from-last_sequence behavior under a failing poll.
 */
import { expect, test } from '@playwright/test';
import { seedMarketplaceRun } from './seed-run';

test('home offers prompt/PRD intake and setup status with no fake progress', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByLabel('Prompt (optional)')).toBeVisible();
  await expect(page.getByLabel('PRD (optional)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Browse PRD' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Browse$/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Operator view' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible();

  // Anti-slop: the run surface never shows a fake/decorative progress bar.
  await expect(page.getByRole('progressbar')).toHaveCount(0);
});

test('worker cap control allows 1..20, defaults to 10, and is labeled system-gated', async ({
  page,
}) => {
  await page.goto('/');

  const cap = page.getByLabel('Worker cap (1–20)');
  await expect(cap).toHaveAttribute('type', 'range');
  await expect(cap).toHaveAttribute('min', '1');
  await expect(cap).toHaveAttribute('max', '20');
  await expect(cap).toHaveValue('10');
  await expect(page.getByText('upper bound · system-gated')).toBeVisible();
});

test('active run renders supervisor, tickets, workers, ledger, review, confidence, and deploy from events', async ({
  page,
}) => {
  const runId = await seedMarketplaceRun(page.request, 'e2e-ff');
  await page.goto(`/runs/${runId}`);

  // Supervisor decisions + ticket DAG
  await expect(page.getByText('classify-intent')).toBeVisible();
  await expect(page.getByText('Scaffold the marketplace app')).toBeVisible();
  await expect(page.getByText('high risk').first()).toBeVisible();

  // Worker board: throttled capacity + system-gated cap label
  await expect(page.getByText('cap is system-gated')).toBeVisible();
  await expect(page.getByText('capacity 3 / 5')).toBeVisible();

  // Trace ledger spine (severity-coded event stream)
  const ledger = page.getByRole('log', { name: 'Run event stream' });
  await expect(ledger.getByText('run.created')).toBeVisible();
  await expect(ledger.getByText('gate.failed')).toBeVisible();

  // Review studio with a pending high-risk decision card
  await expect(page.getByRole('heading', { name: 'Review studio' })).toBeVisible();
  await expect(page.getByTestId('decision-risk')).toContainText('2 approvers in human mode');

  // Artifact confidence: blended score AND the factor breakdown
  await expect(page.getByTestId('confidence-score')).toHaveText('72%');
  await expect(page.getByText('Gate pass rate')).toBeVisible();
  await expect(page.getByText('Provenance completeness')).toBeVisible();

  // Deploy: phase shown, hosted URL withheld until hosted_ready
  await expect(page.getByTestId('deploy-phase')).toContainText('Setup required');
  await expect(page.getByTestId('hosted-url')).toHaveCount(0);

  // Reduced-trust (sandbox fallback) is loud + labeled
  await expect(page.getByTestId('run-reduced-trust')).toBeVisible();

  // Local preview status surfaced in the run control
  await expect(page.getByTestId('preview-status')).toContainText('ready');
});

test('trace ledger shows reconnecting and resumes from last_sequence when polling fails', async ({
  page,
}) => {
  const runId = await seedMarketplaceRun(page.request, 'e2e-reconnect');

  // Force the live poll to fail so the ledger enters the reconnecting state.
  await page.route('**/data/runs/**', (route) => route.abort());
  await page.goto(`/runs/${runId}`);

  const reconnecting = page.getByTestId('ledger-reconnecting');
  await expect(reconnecting).toBeVisible({ timeout: 10_000 });
  await expect(reconnecting).toContainText('resuming the stream from sequence');

  // Restore connectivity; the next poll succeeds and the banner clears.
  await page.unroute('**/data/runs/**');
  await expect(reconnecting).toBeHidden({ timeout: 10_000 });
});
