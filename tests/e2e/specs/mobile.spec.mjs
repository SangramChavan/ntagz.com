import { test, expect } from '@playwright/test';
import { partnerSignIn, uniq } from './helpers.mjs';

// 360 px wide phone: nothing may overflow sideways and tap targets must be usable.
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('portal fits a 360 px phone and controls are at least 44 px', async ({ page }) => {
  await page.goto('http://localhost:8815/');
  await expect(page.getByRole('heading', { name: 'Sign in to the partner portal' })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  expect((await page.getByRole('button', { name: 'Send me a code' }).boundingBox()).height).toBeGreaterThanOrEqual(44);

  await partnerSignIn(page, `${uniq('phone')}@example.test`);
  await expect(page.getByRole('heading', { name: 'Choose your partner category' })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await page.getByText('Ntagz Flex Partner', { exact: true }).click();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Your business' })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  for (const label of ['Business name', 'City', 'PIN code']) expect((await page.getByLabel(label).boundingBox()).height).toBeGreaterThanOrEqual(44);
  // header keeps the brand and Sign out on one row
  const head = await page.locator('.top-in').boundingBox();
  expect(head.height).toBeLessThan(80);
});
