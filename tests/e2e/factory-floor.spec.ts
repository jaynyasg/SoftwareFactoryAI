/**
 * Factory Floor e2e (U8 + U9) — drives the real Next app over the loopback
 * baseURL.
 *
 * U8 coverage: the home intake/empty affordances with no fake progress; an
 * active run rendered entirely from seeded ledger events (supervisor, tickets,
 * worker capacity, trace ledger, review studio, artifact confidence, deploy,
 * reduced-trust, preview); the system-gated 1..20 worker cap; and the trace
 * ledger reconnect-from-last_sequence behavior under a failing poll.
 *
 * U9 coverage: the blueprint-first operator floor — focused-run pipeline
 * lanes, the build-contract/preflight handoff with the command bar adjacent,
 * the cross-run intervention queue (filters, ledger links, focus), viewport
 * fit at 1440x900 / 1280x800, focus preservation across clear-view, and
 * mobile/tablet behavior. Screenshots are written to
 * test-results/screenshots/ for the mandated visual review.
 *
 * NOTE: specs share one dev server and may run in parallel, so every U9 test
 * focuses ITS OWN seeded run through the run board instead of assuming the
 * latest run is its own.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { seedFullFactoryRun, seedMarketplaceRun } from './seed-run';

/** Focus a specific seeded run from the (always-complete) run board. */
async function focusRun(page: Page, runId: string): Promise<void> {
  const marker = page.getByTestId('blueprint-run').locator(`[data-full="${runId}"]`);
  if ((await marker.count()) === 0) {
    // Not already focused (another spec's run may be the latest) — focus ours.
    await page
      .getByLabel('Runs')
      .getByRole('button', { name: `Focus run ${runId}` })
      .click();
  }
  // A non-latest run fetches its aggregate first; wait out the loading state
  // so slow CI never races FocusedBlueprint's fetch (hidden = absent or gone).
  await expect(page.getByTestId('blueprint-loading')).toBeHidden({ timeout: 10_000 });
  await expect(marker).toBeVisible({ timeout: 10_000 });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** Scroll to the top so viewport-relative bounding boxes measure the fold. */
async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
}

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

test('review studio surfaces gate outcomes with pass/fail evidence from ledger events (U7)', async ({
  page,
}) => {
  const runId = await seedMarketplaceRun(page.request, 'e2e-gates');
  await page.goto(`/runs/${runId}`);

  // Gate visibility: the latest outcome per gate renders from projections —
  // the seeded run recorded a lint pass (scaffold) and a test failure
  // (data-model) — without opening raw JSON.
  const gates = page.getByLabel('gate evidence');
  await expect(gates).toBeVisible();
  const rows = gates.getByTestId('gate-row');
  await expect(rows).toHaveCount(2);

  const lintRow = rows.filter({ hasText: 'lint' });
  await expect(lintRow.getByText('passed')).toBeVisible();
  await expect(lintRow.getByText('no lint errors')).toBeVisible();

  const testRow = rows.filter({ hasText: 'failed' });
  await expect(testRow).toHaveCount(1);
  await expect(testRow.getByText('test', { exact: true })).toBeVisible();
  await expect(testRow.getByText(/2 unit tests failing/)).toBeVisible();
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

/* ----------------------------------------------------------------------------
 * U9 — blueprint-first operator floor
 * ------------------------------------------------------------------------- */

test('blueprint lanes, contract/preflight handoff, and command bar fit at 1440x900', async ({
  page,
}) => {
  const runId = await seedFullFactoryRun(page.request, 'e2e-bp');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await focusRun(page, runId);

  // All eight pipeline lanes render for the FOCUSED run.
  for (const lane of [
    'research',
    'planning',
    'queue',
    'workers',
    'gates',
    'repair',
    'package',
    'deploy',
  ]) {
    await expect(page.getByTestId(`lane-${lane}`)).toBeVisible();
  }
  await expect(page.getByTestId('lane-research')).toContainText('brief complete');
  await expect(page.getByTestId('lane-gates')).toContainText('failing');

  // Research findings + source evidence readable without raw JSON.
  await page.getByTestId('lane-research').getByText('evidence').click();
  await expect(page.getByText(/repo already contains a provider\/request scaffold/)).toBeVisible();
  await expect(page.getByText('generated/ai-services-marketplace/apps/web')).toBeVisible();

  // Contract handoff: structured rows + preflight checks + adjacent commands.
  const contract = page.getByTestId('build-contract');
  await expect(contract).toContainText('12 tickets from scaffold through hosted deploy');
  await expect(contract).toContainText('render:ai-services-marketplace');
  await expect(page.getByTestId('preflight-check')).toHaveCount(8);
  await expect(page.getByText('preflight passed · attempt 1')).toBeVisible();
  const commandBar = page.getByTestId('run-command-bar');
  await expect(commandBar.getByRole('button', { name: /pause execution/i })).toBeVisible();

  // Pulse: capacity, throttle reason, and the blocking setup item are explicit.
  await expect(page.getByTestId('pulse-throttle')).toContainText(/CPU budget reached/);
  await expect(page.getByTestId('pulse-blocking')).toContainText(/deploy:/);

  // Viewport fit (KTD7): the lanes and the command bar sit inside one screen.
  await page.getByTestId('lane-research').getByText('evidence').click(); // collapse again
  await scrollToTop(page);
  const laneBox = await page.getByTestId('lane-deploy').boundingBox();
  const barBox = await commandBar.boundingBox();
  expect(laneBox).not.toBeNull();
  expect(barBox).not.toBeNull();
  expect(laneBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect(barBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((laneBox?.y ?? 0) + (laneBox?.height ?? 0)).toBeLessThanOrEqual(900);
  expect((barBox?.y ?? 0) + (barBox?.height ?? 0)).toBeLessThanOrEqual(900);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  await page.screenshot({
    path: 'test-results/screenshots/u9-blueprint-desktop-1440x900.png',
  });
  await page.screenshot({
    path: 'test-results/screenshots/u9-blueprint-desktop-1440x900-full.png',
    fullPage: true,
  });
});

test('blueprint and core controls still fit at 1280x800 (laptop)', async ({ page }) => {
  const runId = await seedFullFactoryRun(page.request, 'e2e-laptop');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await focusRun(page, runId);

  await scrollToTop(page);
  // The always-visible drain-gate banner joined the fold (decision D7,
  // 2026-07 review): it is itself a core control, so the laptop budget is
  // the viewport plus the gate section's real footprint (height + the
  // section stack gap) — core controls may sit below 800px by exactly that
  // amount, and no more.
  const gateBox = await page.getByTestId('factory-held-banner').boundingBox();
  const foldBudget = 800 + (gateBox?.height ?? 0) + 8;
  const laneBox = await page.getByTestId('lane-deploy').boundingBox();
  const barBox = await page.getByTestId('run-command-bar').boundingBox();
  expect(laneBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect(barBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((laneBox?.y ?? 0) + (laneBox?.height ?? 0)).toBeLessThanOrEqual(foldBudget);
  expect((barBox?.y ?? 0) + (barBox?.height ?? 0)).toBeLessThanOrEqual(foldBudget);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  await page.screenshot({
    path: 'test-results/screenshots/u9-blueprint-laptop-1280x800.png',
  });
});

test('intervention queue spans runs, filters, focuses, and links to ledger evidence', async ({
  page,
}) => {
  const runA = await seedFullFactoryRun(page.request, 'e2e-iq-a');
  const runB = await seedFullFactoryRun(page.request, 'e2e-iq-b');
  await page.goto('/');

  const queue = page.getByLabel('Operator interventions');
  const itemA = queue.locator(`[data-run-id="${runA}"]`);
  const itemB = queue.locator(`[data-run-id="${runB}"]`);
  await expect(itemA).toBeVisible();
  await expect(itemB).toBeVisible();

  // Focus run B first so run A's item definitely offers a Focus action.
  await focusRun(page, runB);
  await itemA.getByRole('button', { name: `Focus run ${runA}` }).click();
  await expect(page.getByTestId('blueprint-run').locator(`[data-full="${runA}"]`)).toBeVisible({
    timeout: 10_000,
  });
  // Cross-run: the OTHER run's intervention stays visible after focusing.
  await expect(itemB).toBeVisible();

  // Filter by run narrows the queue; back to all + action text keeps both.
  await queue.getByLabel('Filter interventions by run').selectOption(runA);
  await expect(itemB).toHaveCount(0);
  await expect(itemA).toBeVisible();
  await queue.getByLabel('Filter interventions by run').selectOption('all');
  await queue.getByLabel('Filter interventions by required action').fill('render credentials');
  await expect(itemA).toBeVisible();
  await expect(itemB).toBeVisible();

  // Every item links back to its run's ledger evidence.
  await expect(itemA.getByRole('link', { name: /open ledger evidence/i })).toHaveAttribute(
    'href',
    `/runs/${runA}`,
  );
  await scrollToTop(page);
  await page.screenshot({
    path: 'test-results/screenshots/u9-intervention-queue-desktop.png',
  });
});

test('focus run switches the blueprint and the history toggle preserves focus', async ({
  page,
}) => {
  const runA = await seedFullFactoryRun(page.request, 'e2e-focus-a');
  const runB = await seedMarketplaceRun(page.request, 'e2e-focus-b');
  await page.goto('/');

  await focusRun(page, runA);
  await focusRun(page, runB);

  // U6 replaced the ephemeral "Clear view" with the real archive lifecycle:
  // RunBoard hosts history behind a "Show archived" toggle. Toggling the
  // history host never drops the focused blueprint.
  await page.getByTestId('history-toggle').click();
  await expect(page.getByTestId('archived-history')).toBeVisible();
  await expect(page.getByTestId('blueprint-run').locator(`[data-full="${runB}"]`)).toBeVisible();

  // Collapsing the archived section keeps the list and focus intact.
  await page.getByTestId('history-toggle').click();
  await expect(page.getByTestId('blueprint-run').locator(`[data-full="${runB}"]`)).toBeVisible();
});

test('mobile 390x844: interventions first, lanes stack, no horizontal scroll', async ({ page }) => {
  const runId = await seedFullFactoryRun(page.request, 'e2e-mobile');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await focusRun(page, runId);

  // Interventions render ABOVE the blueprint (reachable without hunting).
  await scrollToTop(page);
  const queueBox = await page.getByLabel('Operator interventions').boundingBox();
  const blueprintBox = await page.getByLabel('Factory blueprint').boundingBox();
  expect(queueBox).not.toBeNull();
  expect(blueprintBox).not.toBeNull();
  expect((queueBox?.y ?? 0) + (queueBox?.height ?? 0)).toBeLessThanOrEqual(
    (blueprintBox?.y ?? 0) + 1,
  );

  // No horizontal scroll and the command bar stays operable (§9).
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  const pauseButton = page.getByRole('button', { name: /pause execution/i });
  await pauseButton.scrollIntoViewIfNeeded();
  await expect(pauseButton).toBeVisible();

  await scrollToTop(page);
  await page.screenshot({
    path: 'test-results/screenshots/u9-blueprint-mobile-390x844.png',
  });
  await page.screenshot({
    path: 'test-results/screenshots/u9-blueprint-mobile-390x844-full.png',
    fullPage: true,
  });
});

/* ----------------------------------------------------------------------------
 * Factory-wide drain gate (the daemon boots HELD; the operator resumes)
 * ------------------------------------------------------------------------- */

test('factory drain gate: held banner shows on open and cancel-all arm backs out safely', async ({
  page,
}) => {
  await page.goto('/');

  // The daemon boots HELD: the banner says nothing runs automatically and
  // offers the single explicit Resume affordance. This spec deliberately
  // NEVER clicks Resume: the gate is process-local on the SHARED dev server,
  // so releasing it here would drain every other spec's seeded queued work
  // through the real executor mid-suite (fullyParallel). The resume/hold
  // flip is covered in isolation by factory-gate.spec.ts (ephemeral server)
  // and at the component level in factory-floor.test.tsx.
  const heldBanner = page.getByTestId('factory-held-banner');
  await expect(heldBanner).toBeVisible({ timeout: 10_000 });
  await expect(heldBanner).toContainText('Execution is held');
  await expect(page.getByTestId('factory-resume')).toBeVisible();

  // Arm cancel-all, then back out: 'Keep running' must fire NO cancel request.
  const cancelAllRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/runs/cancel-all')) {
      cancelAllRequests.push(request.url());
    }
  });
  await page.getByTestId('cancel-all-tasks').click();
  await expect(page.getByTestId('cancel-all-confirm')).toBeVisible();
  await page.getByTestId('cancel-all-keep').click();
  await expect(page.getByTestId('cancel-all-confirm')).toBeHidden();
  await expect(page.getByTestId('cancel-all-tasks')).toBeVisible();
  expect(cancelAllRequests).toEqual([]);
});

test('tablet 900x768: lanes stack without horizontal scroll', async ({ page }) => {
  const runId = await seedFullFactoryRun(page.request, 'e2e-tablet');
  await page.setViewportSize({ width: 900, height: 768 });
  await page.goto('/');
  await focusRun(page, runId);

  await expect(page.getByTestId('lane-deploy')).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  await scrollToTop(page);
  await page.screenshot({
    path: 'test-results/screenshots/u9-blueprint-tablet-900x768.png',
  });
});
