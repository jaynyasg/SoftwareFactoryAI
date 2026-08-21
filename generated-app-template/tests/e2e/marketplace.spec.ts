import { expect, test } from '@playwright/test';

/**
 * Core flow smoke test against a locally-started app (see playwright.config.ts
 * webServer): customer submits a request -> AI brief generated (deterministic
 * fallback) -> provider submits a proposal -> customer accepts -> status visible
 * on the customer and admin dashboards.
 */
const stamp = Date.now();
const title = `E2E request ${stamp}`;
const customerEmail = `customer+${stamp}@e2e.local`;
const providerEmail = `provider+${stamp}@e2e.local`;

test('customer → AI brief → proposal → accept → status', async ({ page }) => {
  // 1. Customer submits a request.
  await page.goto('/customer');
  await page.getByTestId('req-customer-name').fill('E2E Customer');
  await page.getByTestId('req-customer-email').fill(customerEmail);
  await page.getByTestId('req-title').fill(title);
  await page.getByTestId('req-description').fill('We need an AI assistant to onboard new users.');
  await page.getByTestId('req-category').fill('Conversational AI');
  await page.getByTestId('req-budget').fill('5000');
  await page.getByTestId('req-submit').click();

  // 2. The request card appears with a deterministic AI brief.
  const card = page.getByTestId('request-card').filter({ hasText: title });
  await expect(card).toBeVisible();
  await expect(card.getByTestId('brief-source')).toContainText('deterministic-fallback');

  // 3. Provider submits a proposal for that request.
  await page.goto('/provider');
  await page.getByTestId('prop-request-select').selectOption({ label: title });
  await page.getByTestId('prop-provider-name').fill('E2E Provider');
  await page.getByTestId('prop-provider-email').fill(providerEmail);
  await page.getByTestId('prop-message').fill('We can deliver this in three weeks.');
  await page.getByTestId('prop-price').fill('4200');
  await page.getByTestId('prop-submit').click();
  // Form resets on success.
  await expect(page.getByTestId('prop-provider-name')).toHaveValue('');

  // 4. Customer accepts the proposal.
  await page.goto('/customer');
  const customerCard = page.getByTestId('request-card').filter({ hasText: title });
  await expect(customerCard.getByTestId('proposal-card')).toBeVisible();
  await customerCard.getByTestId('proposal-accept').first().click();

  // 5. Status reflects the acceptance and persists in the timeline.
  await expect(customerCard.getByTestId('request-status')).toHaveText('ACCEPTED');
  await expect(customerCard.getByTestId('proposal-status').first()).toContainText('ACCEPTED');
  await expect(customerCard.getByTestId('status-timeline')).toContainText('PROPOSAL_ACCEPTED');

  // 6. Admin dashboard shows it and reports healthy.
  await page.goto('/admin');
  await expect(page.getByTestId('health-status')).toContainText('OK');
  const adminRow = page.getByTestId('admin-request').filter({ hasText: title });
  await expect(adminRow).toContainText('ACCEPTED');
});
