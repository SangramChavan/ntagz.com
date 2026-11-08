import { test, expect } from '@playwright/test';
import { ADMIN, adminSignIn, activePartner, closePanels } from './helpers.mjs';

// HQ sets the price list through the real Wholesale screen; an Enterprise partner orders at the partner price and the order is paid from the opening stock credit
// (a gateway payment cannot be driven locally, so the part-payment path is covered by admin/stage2/test-wholesale.cjs). A Smile+ partner has credit and can order.
test('wholesale: HQ price list, partner orders from stock credit, Smile+ cannot order', async ({ browser }) => {
  const hq = await (await browser.newContext()).newPage();
  await adminSignIn(hq);
  await hq.goto(ADMIN + '/#/wholesale');

  // Nothing is set yet: HQ is told products have no cost, and partners have no prices.
  await expect(hq.getByRole('heading', { name: 'Wholesale' })).toBeVisible();
  await expect(hq.getByText(/active products? with no cost price/)).toBeVisible();

  // The owner's cost is entered in Products (here through the same admin API the Products screen uses).
  const costed = await hq.evaluate(async () => {
    const post = (p, b) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ntagz-admin' }, body: JSON.stringify(b) }).then((r) => r.status);
    return post('/api/products/black-nfc-card', { cost: 9 });
  });
  expect(costed).toBe(200);

  await hq.locator('#whm').fill('20');
  await hq.getByRole('button', { name: 'Save margin' }).click();
  await expect(hq.getByText('Floor price = cost × (1 + margin). Currently 20%.')).toBeVisible();
  const ent = hq.locator('#wholesale-root .card', { hasText: 'Ntagz Enterprise Partner' }).first();
  await ent.getByLabel('Ntagz Enterprise Partner discount in percent').fill('30');
  await ent.getByRole('button', { name: 'Save' }).click();
  await expect(hq.locator('#wholesale-root .card', { hasText: 'Ntagz Enterprise Partner' }).first()).toContainText('discount 30%');
  const plusCard = hq.locator('#wholesale-root .card', { hasText: 'Ntagz Smile+ Partner' }).first();
  await expect(plusCard).toContainText('Can order'); // Smile+ has orders.place.own (migration 0031)

  // The resulting price: card ₹30 retail, 30% off = ₹21, floor ₹10.80.
  await hq.getByRole('button', { name: 'Ntagz Enterprise Partner', exact: true }).last().click();
  const row = hq.locator('#wholesale-root .card', { hasText: 'Black NFC' }).first();
  await expect(row).toContainText('partner ₹21');
  await expect(row).toContainText('Priced');

  // An Enterprise partner: opening stock order becomes credit; orders at the partner price.
  const P = await activePartner(browser, hq, 'Enterprise', 'Wholesaler');
  const page = P.page;
  await page.getByRole('link', { name: 'Wholesale' }).click();
  await expect(page.getByRole('heading', { name: 'Wholesale orders', exact: true })).toBeVisible();
  await expect(page.locator('.summary').first()).toContainText('₹49,999'); // the opening stock order, as credit
  await expect(page.getByText('Your price ₹21 each (retail ₹30)')).toBeVisible();
  await expect(page.getByText('Price not available yet.').first()).toBeVisible(); // other products have no cost yet

  await page.locator('#q-black-nfc-card').fill('10');
  await expect(page.locator('.summary').nth(1)).toContainText('₹288'); // 10 x ₹21 + 18% GST + ₹40 shipping
  await expect(page.locator('.summary').nth(1)).toContainText('To pay now');
  await page.getByLabel('Delivery address').fill('12 MG Road, Camp, Pune');
  await page.getByLabel('PIN code').fill('411001');
  await page.getByLabel('State', { exact: true }).fill('Maharashtra');
  await page.getByLabel('Mobile number for delivery').fill('9820000011');
  await page.getByRole('button', { name: 'Place order with stock credit' }).click();
  await expect(page.getByText(/placed and paid from your stock credit/)).toBeVisible();
  await expect(page.locator('.summary').first()).toContainText('₹49,711'); // 49,999 - 288
  await expect(page.getByRole('heading', { name: 'Your wholesale orders', exact: true })).toBeVisible();
  await expect(page.locator('.leadcard').first()).toContainText('₹288');

  // HQ sees the credit used and the order.
  await closePanels(hq);
  await hq.goto(ADMIN + '/#/orders'); await hq.goto(ADMIN + '/#/wholesale');
  await hq.getByRole('button', { name: 'Partner credit and orders' }).click();
  const prow = hq.locator('#wholesale-root .pn-card', { hasText: P.biz });
  await expect(prow).toContainText('Credit ₹49,711 available of ₹49,999');
  await prow.getByRole('button', { name: 'Orders' }).click();
  await expect(hq.locator('#cmpanel')).toContainText('₹288');
  await hq.locator('#cmpanel').getByRole('button', { name: 'Close' }).click();

  // Smile+: credit exists, but no Wholesale in the menu and the page redirects.
  const S = await activePartner(browser, hq, 'Smile+', 'Plus');
  await expect(S.page.getByRole('link', { name: 'Wholesale' })).toHaveCount(0);
  await S.page.goto(S.page.url().replace(/\/[^/]*$/, '/wholesale'));
  await expect(S.page.getByRole('heading', { name: /^Welcome,/ })).toBeVisible();
});
