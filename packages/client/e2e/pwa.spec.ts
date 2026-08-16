import { expect, test } from '@playwright/test';

test('serves the application shell after the browser goes offline', async ({ context, page }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Strata' })).toBeVisible();
  await expect(page.getByText('43 layers loaded.')).toBeVisible();
});
