import { test, expect } from '@playwright/test';
import { ADMIN, adminSignIn, activePartner, closePanels, confirmDialog, uniq } from './helpers.mjs';

const phone = () => '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');

test('quotations: draft with a live checkout price, HQ rejects then approves, partner sends and records the answer', async ({ browser }) => {
  const hq = await (await browser.newContext()).newPage();
  await adminSignIn(hq);
  const P = await activePartner(browser, hq, 'Enterprise', 'Quoter');
  const lead = uniq('Restaurant ');
  const page = P.page;

  // --- a lead to quote
  await page.getByRole('link', { name: 'Leads' }).click();
  await page.getByRole('button', { name: 'Add a lead' }).click();
  await page.getByLabel('Business name').fill(lead);
  await page.getByLabel('Contact person').fill('Ravi Shah');
  await page.getByLabel('Mobile number').fill(phone());
  await page.getByLabel('State (optional)').selectOption('Maharashtra');
  await page.getByRole('button', { name: 'Save lead' }).click();
  await page.getByRole('button', { name: `Open lead ${lead}` }).click();
  await expect(page.getByText('No quotation yet for this lead.')).toBeVisible();
  await page.getByRole('button', { name: 'Prepare quotation' }).click();

  // --- the editor shows the price the checkout engine would charge (never typed by hand)
  await expect(page.getByRole('heading', { name: 'New quotation' })).toBeVisible();
  await page.getByLabel('Product 1').selectOption('black-nfc-card');
  await expect(page.getByLabel('Quantity')).toHaveValue('10'); // fills the product's minimum
  await page.getByLabel('Quantity').fill('100');
  await expect(page.locator('.summary').getByText('₹3,540')).toBeVisible(); // 100 x ₹30 + 18% GST, free shipping
  await page.getByLabel('Quantity').fill('5'); // below the minimum
  await expect(page.getByText(/minimum 10/)).toBeVisible();
  await page.getByLabel('Quantity').fill('100');
  await page.getByLabel('Notes for Ntagz (optional)').fill('Logo on the back');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('heading', { name: /^Q-\d{4}-\d{4}$/ })).toBeVisible();
  const number = (await page.getByRole('heading', { name: /^Q-\d{4}-\d{4}$/ }).textContent()).trim();
  await expect(page.locator('.titlerow .pill')).toHaveText('Draft');
  await page.getByRole('button', { name: 'Send to Ntagz for approval' }).click();
  await expect(page.locator('.titlerow .pill')).toHaveText('Waiting for Ntagz approval');
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0); // frozen while HQ reviews

  // --- HQ rejects with a reason
  await closePanels(hq);
  await hq.goto(ADMIN + '/#/quotes');
  const row = hq.locator('#view-quotes .pn-card', { hasText: number });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Needs approval');
  await row.getByRole('button', { name: 'Review' }).click();
  await expect(hq.locator('#qtpanel')).toContainText('₹3,540');
  await expect(hq.locator('#qtpanel')).toContainText('Logo on the back');
  await hq.locator('#qtactions').getByRole('button', { name: 'Reject', exact: true }).click();
  await confirmDialog(hq, 'Reject quotation').click(); // empty reason refused
  await expect(hq.locator('#kdlg .err')).toHaveText('Write at least a few words.');
  await hq.locator('#qtask').fill('Please confirm the logo file first');
  await confirmDialog(hq, 'Reject quotation').click();
  await expect(hq.locator('#qtpanel .pill').first()).toHaveText('Rejected');

  // --- partner sees why, revises (re-priced), resubmits
  await page.reload();
  await expect(page.locator('.titlerow .pill')).toHaveText('Needs changes');
  await expect(page.getByText('Please confirm the logo file first')).toBeVisible();
  await page.getByRole('button', { name: 'Revise' }).click();
  await expect(page.getByRole('heading', { name: 'Revise quotation' })).toBeVisible();
  await page.getByLabel('Quantity').fill('200');
  await expect(page.locator('.summary').getByText('₹7,080')).toBeVisible(); // 200 x ₹30 + GST
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.titlerow .pill')).toHaveText('Draft');
  await page.getByRole('button', { name: 'Send to Ntagz for approval' }).click();

  // --- HQ approves
  await hq.reload();
  await hq.goto(ADMIN + '/#/orders'); await hq.goto(ADMIN + '/#/quotes');
  await hq.locator('#view-quotes .pn-card', { hasText: number }).getByRole('button', { name: 'Review' }).click();
  await expect(hq.locator('#qtpanel')).toContainText('₹7,080');
  await hq.locator('#qtactions').getByRole('button', { name: 'Approve', exact: true }).click();
  await confirmDialog(hq, 'Approve').click();
  await expect(hq.locator('#qtpanel .pill').first()).toHaveText('Approved');

  // --- partner gets a frozen, ready-to-send summary
  await page.reload();
  await expect(page.locator('.titlerow .pill')).toHaveText('Approved');
  const share = page.locator('#share');
  await expect(share).toHaveValue(new RegExp(`Quotation ${number} from Ntagz`));
  await expect(share).toHaveValue(/Total: ₹7,080/);
  await expect(share).toHaveValue(/Valid until/);
  expect(await page.getByRole('link', { name: 'Open in WhatsApp' }).getAttribute('href')).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);

  // --- sent -> customer accepted; HQ sees it and the lead moved to 'quotation'
  await page.getByRole('button', { name: 'I sent it to the customer' }).click();
  await expect(page.locator('.titlerow .pill')).toHaveText('Sent to customer');
  await page.getByRole('button', { name: 'Customer accepted' }).click();
  await expect(page.locator('.titlerow .pill')).toHaveText('Accepted');
  await expect(page.getByText('The customer accepted this quotation.')).toBeVisible();
  await page.getByRole('button', { name: lead }).click();
  await expect(page.locator('.titlerow .pill').first()).toHaveText('Quotation in progress');
  await expect(page.getByRole('button', { name: new RegExp(number) })).toBeVisible();
  await hq.locator('#qtpanel').getByRole('button', { name: 'Close' }).click();
  await hq.goto(ADMIN + '/#/orders'); await hq.goto(ADMIN + '/#/quotes');
  await expect(hq.locator('#view-quotes .pn-card', { hasText: number })).toContainText('Accepted');
});

test('a Flex partner has no Quotes section and the server refuses', async ({ browser }) => {
  const hq = await (await browser.newContext()).newPage();
  await adminSignIn(hq);
  const F = await activePartner(browser, hq, 'Flex', 'Flexer');
  await expect(F.page.getByRole('link', { name: 'Quotes' })).toHaveCount(0);
  await F.page.goto('http://localhost:8815/quotes');
  await expect(F.page).toHaveURL('http://localhost:8815/dashboard');
  const status = await F.page.evaluate(() => fetch('/api/v1/partner/quotes', { credentials: 'same-origin' }).then((r) => r.status));
  expect(status).toBe(403);
});
