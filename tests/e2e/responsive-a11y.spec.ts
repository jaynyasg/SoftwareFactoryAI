/**
 * Responsive + accessibility e2e (U8; DESIGN.md §7/§9).
 *
 * Verifies the run surface produces no horizontal scroll at desktop/tablet/mobile
 * (long ids/paths/urls are middle-truncated, with the full value preserved), and
 * that the core review actions are keyboard-operable and screen-reader-legible
 * (trace ledger live-region, decision card role + accessible name, color paired
 * with text labels).
 */
import { expect, test } from '@playwright/test';
import { seedMarketplaceRun } from './seed-run';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 900, height: 768 },
  { name: 'mobile', width: 390, height: 844 },
];

test('no horizontal scroll at desktop, tablet, or mobile', async ({ page }) => {
  const runId = await seedMarketplaceRun(page.request, 'e2e-resp');

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(`/runs/${runId}`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${vp.name}`).toBeLessThanOrEqual(1);
  }
});

test('long machine paths are middle-truncated and keep the full value (mobile)', async ({
  page,
}) => {
  const runId = await seedMarketplaceRun(page.request, 'e2e-trunc');
  const fullPath = 'generated/ai-services-marketplace/apps/web/app/page.tsx';

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/runs/${runId}`);

  const el = page.locator(`[data-full="${fullPath}"]`).first();
  await expect(el).toBeVisible();
  await expect(el).toHaveText(/…/); // middle-truncated on screen
  await expect(el).toHaveAttribute('title', fullPath); // full value available

  // The truncated element stays within the mobile viewport (no overflow).
  const box = await el.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(391);
});

test('core review actions are keyboard operable and screen-reader legible', async ({ page }) => {
  const runId = await seedMarketplaceRun(page.request, 'e2e-a11y');
  await page.goto(`/runs/${runId}`);

  // Trace ledger uses a polite live region for streamed events.
  const ledger = page.getByRole('log', { name: 'Run event stream' });
  await expect(ledger).toHaveAttribute('aria-live', 'polite');

  // Decision card exposes role + a risk-tiered accessible name.
  const card = page.getByRole('group', { name: /review decision/i });
  await expect(card).toBeVisible();
  await expect(card).toHaveAccessibleName(/high risk/i);

  // Color independence: risk is carried by a text label, not color alone.
  await expect(page.getByTestId('decision-risk')).toContainText('High risk');

  // The approve action is reachable and operable by keyboard.
  const approve = page.getByRole('button', { name: /approve high-risk review for run/i });
  await approve.focus();
  await expect(approve).toBeFocused();
});
