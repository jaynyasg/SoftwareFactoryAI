/**
 * Review Studio e2e (U8) — the command-guarded human review flow over real HTTP.
 *
 * Proves an approve/reject goes through the U3 command guard (the same-origin
 * browser supplies the operator token + CSRF + an expectedVersion and the
 * `review.decided` event is appended), and that a stale subject version is
 * rejected (409) with the decision card reloading current state and explaining,
 * then recovering on retry.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { seedMarketplaceRun } from './seed-run';

async function eventTypes(page: Page, runId: string): Promise<string[]> {
  const res = await page.request.get(`/api/runs/${runId}/events`);
  if (!res.ok()) {
    return [];
  }
  return ((await res.json()).events as Array<{ type: string }>).map((e) => e.type);
}

test('approving a high-risk review passes the command guard and records the decision', async ({
  page,
}) => {
  const runId = await seedMarketplaceRun(page.request, 'e2e-rs-approve');
  await page.goto(`/runs/${runId}`);

  await page.getByRole('button', { name: /approve high-risk review for run/i }).click();

  // The decision went through the command guard and was appended to the ledger.
  await expect
    .poll(async () => eventTypes(page, runId), { timeout: 10_000 })
    .toContain('review.decided');
  // The UI reflects the approved outcome.
  await expect(page.getByText(/approved/i).first()).toBeVisible();
});

test('rejecting a review records the rejected outcome', async ({ page }) => {
  const runId = await seedMarketplaceRun(page.request, 'e2e-rs-reject');
  await page.goto(`/runs/${runId}`);

  await page.getByRole('button', { name: /reject high-risk review for run/i }).click();

  await expect
    .poll(async () => eventTypes(page, runId), { timeout: 10_000 })
    .toContain('review.decided');
  await expect(page.getByText(/rejected/i).first()).toBeVisible();
});

test('a stale review decision is rejected, reloads current state, then recovers', async ({
  page,
}) => {
  const runId = await seedMarketplaceRun(page.request, 'e2e-rs-stale');
  await page.goto(`/runs/${runId}`);

  // Rewrite the outgoing expectedVersion to an outdated value so the command
  // guard rejects it as stale (409).
  await page.route(`**/api/runs/${runId}/review`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...body, expectedVersion: 1 }) });
  });

  await page.getByRole('button', { name: /approve high-risk review for run/i }).click();
  await expect(page.getByTestId('decision-stale')).toBeVisible();
  await expect(page.getByTestId('decision-stale')).toContainText(/stale/i);

  // The guard recorded the rejection in the ledger (no side effects beyond it).
  await expect
    .poll(async () => eventTypes(page, runId), { timeout: 10_000 })
    .toContain('security.command_rejected');

  // Stop tampering and let the reloaded state (new current version) flow back in;
  // the trace ledger streaming the rejection confirms the projection refreshed.
  await page.unroute(`**/api/runs/${runId}/review`);
  const ledger = page.getByRole('log', { name: 'Run event stream' });
  await expect(ledger.getByText('security.command_rejected')).toBeVisible({ timeout: 10_000 });

  // A fresh approval now succeeds against the reloaded version.
  await page.getByRole('button', { name: /approve high-risk review for run/i }).click();
  await expect
    .poll(async () => eventTypes(page, runId), { timeout: 10_000 })
    .toContain('review.decided');
});
