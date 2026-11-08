import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { STATE, WRANGLER, root } from '../playwright.config.mjs';
import { ADMIN, PARTNER, adminSignIn, activePartner, closePanels, uniq, confirmDialog } from './helpers.mjs';

const phone = () => '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
// Stands in for a paid checkout: this journey is about commissions, not the payment gateway.
const seedPaidOrder = (id, qualPaise) => execFileSync(WRANGLER, ['d1', 'execute', 'ntagz-db', '--local', '--persist-to', STATE, '--command',
  `INSERT INTO orders (id, txn_id, gateway, status, total, subtotal, payment_status, paid_paise, refunded_paise, qualifying_paise, created_at) VALUES ('${id}', 'txn-${id}', 'razorpay', 'confirmed', ${Math.round(qualPaise * 1.18)}, ${qualPaise}, 'paid', ${Math.round(qualPaise * 1.18)}, 0, ${qualPaise}, unixepoch())`],
  { cwd: path.join(root, 'admin'), stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });

test('commissions: rule, won lead, approval, partner sees it, dispute, HQ resolves; hold window blocks payout', async ({ browser }) => {
  const hq = await (await browser.newContext()).newPage();
  await adminSignIn(hq);
  const A = await activePartner(browser, hq, 'Flex', 'Comm');
  await closePanels(hq);

  // --- before any rule exists, the partner has nothing and is told so honestly
  await A.page.getByRole('link', { name: 'Earnings' }).click();
  await expect(A.page.getByText('Ntagz does not guarantee any income')).toBeVisible();
  await expect(A.page.getByText('No earnings yet.')).toBeVisible();

  // --- HQ defines a rule (5% of order value before GST, 7-day hold) from the Terms tab
  await hq.goto(ADMIN + '/#/orders'); await hq.goto(ADMIN + '/#/commissions');
  await hq.getByRole('button', { name: 'Terms' }).click();
  await hq.getByRole('button', { name: 'Add a rule' }).click();
  await hq.locator('#cmf0').fill('E2E lead conversion');
  await hq.locator('#cmf2').fill('5');
  await hq.locator('#cmf6').fill('7');
  await confirmDialog(hq, 'Add rule').click();
  await expect(hq.locator('#view-commissions')).toContainText('E2E lead conversion');

  // --- partner registers a lead; HQ wins it with a paid order
  const lead = uniq('Hotel Sunrise ');
  await A.page.getByRole('link', { name: 'Leads' }).click();
  await A.page.getByRole('button', { name: 'Add a lead' }).click();
  await A.page.getByLabel('Business name').fill(lead);
  await A.page.getByLabel('Contact person').fill('Meera Joshi');
  await A.page.getByLabel('Mobile number').fill(phone());
  await A.page.getByRole('button', { name: 'Save lead' }).click();
  await expect(A.page.getByRole('button', { name: `Open lead ${lead}` })).toBeVisible();
  const orderId = uniq('ord-e2e-').replace(/[^a-z0-9-]/g, '');
  seedPaidOrder(orderId, 200000); // ₹2,000 before GST -> ₹100 at 5%
  await hq.goto(ADMIN + '/#/orders'); await hq.goto(ADMIN + '/#/leads');
  await hq.locator('#view-leads .pn-card', { hasText: lead }).getByRole('button').first().click();
  await hq.locator('#ldactions').getByRole('button', { name: 'Mark won' }).click();
  await hq.locator('#ldask').fill(orderId);
  await confirmDialog(hq, 'Mark won').click();
  await expect(hq.locator('#ldpanel .pill').first()).toHaveText('Won');
  await expect(hq.locator('#ldpanel')).toContainText('Commission of ₹100');
  await closePanels(hq);

  // --- HQ approves it; the order is new, so it waits out the hold
  await hq.goto(ADMIN + '/#/orders'); await hq.goto(ADMIN + '/#/commissions');
  const row = hq.locator('#view-commissions .pn-card', { hasText: lead });
  await expect(row).toContainText('₹100');
  await expect(row).toContainText('Needs approval');
  await row.getByRole('button', { name: 'Review' }).click();
  await expect(hq.locator('#cmpanel')).toContainText('E2E lead conversion');
  await hq.locator('#cmpanel').getByRole('button', { name: 'Approve', exact: true }).click();
  await confirmDialog(hq, 'Approve').click();
  await expect(hq.locator('#cmpanel .pill').first()).toHaveText('Approved, in window'); // not payable during the refund window
  await expect(hq.locator('#cmpanel')).toContainText('Payable after');
  await hq.locator('#cmpanel').getByRole('button', { name: 'Close' }).click();

  // --- partner sees it with the hold date, not as payable money
  await A.page.getByRole('link', { name: 'Earnings' }).click();
  await A.page.reload();
  await expect(A.page.getByText('₹100 · ' + lead)).toBeVisible();
  await expect(A.page.getByText('Approved, in refund window').first()).toBeVisible();
  await expect(A.page.locator('dl.summary')).toContainText('Ready to be paid₹0');
  await A.page.getByRole('button', { name: /Open earning ₹100/ }).click();
  await expect(A.page.getByText('Payable after')).toBeVisible();

  // --- partner disputes with a reason (required); HQ sees and lets it stand
  await A.page.getByRole('button', { name: 'Raise with Ntagz' }).click();
  await expect(A.page.getByText('Say what looks wrong.')).toBeVisible();
  await A.page.getByLabel('Tell Ntagz what looks wrong').fill('The order had a bigger quantity');
  await A.page.getByRole('button', { name: 'Raise with Ntagz' }).click();
  await expect(A.page.getByText('Ntagz is reviewing this')).toBeVisible();
  await hq.goto(ADMIN + '/#/orders'); await hq.goto(ADMIN + '/#/commissions');
  await hq.getByRole('button', { name: /^Disputed/ }).click();
  await hq.locator('#view-commissions .pn-card', { hasText: lead }).getByRole('button', { name: 'Review' }).click();
  await expect(hq.locator('#cmpanel')).toContainText('The order had a bigger quantity');
  await hq.locator('#cmpanel').getByRole('button', { name: 'Let it stand' }).click();
  await hq.locator('#cmf0').fill('Checked the order, the amount is right');
  await confirmDialog(hq, 'Let it stand').click();
  await expect(hq.locator('#cmpanel .pill').first()).toHaveText('Approved, in window');

  // --- Payouts: nothing payable (still inside the hold window)
  await hq.locator('#cmpanel').getByRole('button', { name: 'Close' }).click();
  await hq.getByRole('button', { name: 'Payouts' }).click();
  await expect(hq.getByText('Nothing is payable right now.')).toBeVisible();

  // --- another partner cannot see this commission through the API
  const B = await activePartner(browser, hq, 'Enterprise', 'CommB');
  const list = await B.page.evaluate(() => fetch('/api/v1/partner/commissions', { credentials: 'same-origin' }).then((r) => r.json()));
  expect(list.data.items).toHaveLength(0);
  // a Smile partner has the Earnings page too (every partner type does) but only ever sees their own: nothing here
  const smile = await activePartner(browser, hq, 'Smile', 'CommS');
  await smile.page.getByRole('link', { name: 'Earnings' }).click();
  await expect(smile.page.getByText('No earnings yet.')).toBeVisible();
  // and a signed-out request is refused
  const anon = await (await browser.newContext()).newPage(); await anon.goto(PARTNER + '/');
  expect(await anon.evaluate(() => fetch('/api/v1/partner/commissions', { credentials: 'same-origin' }).then((r) => r.status))).toBe(401);
});
