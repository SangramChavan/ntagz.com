import { test, expect } from '@playwright/test';
import { ADMIN, PARTNER, partnerSignIn, adminSignIn, applyThroughUi, activateThroughUi, uniq, confirmDialog } from './helpers.mjs';

const phone = () => '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');

// Brings a new partner of the given type all the way to an active dashboard through the real UI.
async function activePartner(browser, hq, type, label) {
  const biz = uniq(`${label} `);
  const page = await (await browser.newContext()).newPage();
  await partnerSignIn(page, `${uniq(label.toLowerCase())}@example.test`);
  await applyThroughUi(page, { type, biz });
  await activateThroughUi(hq, biz);
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByRole('heading', { name: `Welcome, ${biz}` })).toBeVisible();
  return { page, biz };
}

test('leads: register, one owner per number, HQ sees the conflict, reassign moves access, close as lost', async ({ browser }) => {
  const hq = await (await browser.newContext()).newPage();
  await adminSignIn(hq);
  const A = await activePartner(browser, hq, 'Flex', 'Alpha');
  const B = await activePartner(browser, hq, 'Enterprise', 'Beta');
  const num = phone();
  const lead = uniq('Cafe Aroma ');

  // --- partner A registers a lead
  await A.page.getByRole('link', { name: 'Leads' }).click();
  await expect(A.page.getByRole('heading', { name: 'Leads' })).toBeVisible();
  await A.page.getByRole('button', { name: 'Add a lead' }).click();
  await A.page.getByRole('button', { name: 'Save lead' }).click(); // empty -> field errors, focus on the first
  await expect(A.page.getByText('Enter the business name.')).toBeVisible();
  await expect(A.page.getByLabel('Business name')).toBeFocused();
  await A.page.getByLabel('Business name').fill(lead);
  await A.page.getByLabel('Contact person').fill('Ravi Shah');
  await A.page.getByLabel('Mobile number').fill(num);
  await A.page.getByLabel('What do they need? (optional)').fill('100 NFC review stands');
  await A.page.getByLabel('Roughly how many pieces? (optional)').fill('100');
  await A.page.getByRole('button', { name: 'Save lead' }).click();
  await expect(A.page.getByRole('button', { name: `Open lead ${lead}` })).toBeVisible();
  await expect(A.page.getByRole('button', { name: 'New (1)' })).toBeVisible();

  // --- A works the lead
  await A.page.getByRole('button', { name: `Open lead ${lead}` }).click();
  await expect(A.page.getByRole('heading', { name: lead })).toBeVisible();
  await A.page.getByRole('button', { name: 'Mark contacted' }).click();
  await expect(A.page.locator('.titlerow .pill')).toHaveText('Contacted');
  await A.page.getByRole('button', { name: 'Call', exact: true }).click();
  await A.page.getByLabel('What happened?').fill('Called, wants a demo on Friday');
  await A.page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(A.page.getByText('Called, wants a demo on Friday')).toBeVisible();
  await expect(A.page.getByRole('button', { name: /Mark won|Quotation/ })).toHaveCount(0); // partners cannot win a lead

  // --- partner B cannot register the same number and is not told who owns it
  await B.page.getByRole('link', { name: 'Leads' }).click();
  await B.page.getByRole('button', { name: 'Add a lead' }).click();
  await B.page.getByLabel('Business name').fill(uniq('Cafe Aroma copy '));
  await B.page.getByLabel('Contact person').fill('Someone');
  await B.page.getByLabel('Mobile number').fill(num);
  await B.page.getByRole('button', { name: 'Save lead' }).click();
  await expect(B.page.getByText('This contact is already registered with Ntagz').first()).toBeVisible();
  await expect(B.page.getByText(A.biz)).toHaveCount(0);
  await B.page.getByRole('button', { name: 'Close' }).click();
  await expect(B.page.getByText('No leads yet.')).toBeVisible();

  // --- HQ sees it all, including the attempted conflict
  if (await hq.locator('#pnpanel[open]').count()) await hq.locator('#pnpanel').getByRole('button', { name: 'Close' }).click(); // left open by the activations
  await hq.goto(ADMIN + '/#/leads');
  const row = hq.locator('#view-leads .pn-card', { hasText: lead });
  await expect(row).toBeVisible();
  await expect(row).toContainText(A.biz);
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(hq.locator('#ldpanel h2')).toHaveText(lead);
  await expect(hq.locator('#ldpanel')).toContainText('another partner tried to register this number');
  await expect(hq.locator('#ldpanel')).toContainText('Called, wants a demo on Friday');

  // --- HQ reassigns to B: A loses access, B gets it
  const val = await hq.locator('#ldto option', { hasText: B.biz }).getAttribute('value');
  await hq.locator('#ldto').selectOption(val);
  await hq.locator('#ldpanel').getByRole('button', { name: 'Reassign', exact: true }).click();
  await confirmDialog(hq, 'Reassign').click();
  await expect(hq.locator('#ldpanel')).toContainText(B.biz);
  await A.page.getByRole('link', { name: 'Leads' }).click();
  await A.page.reload();
  await expect(A.page.getByText('No leads yet.')).toBeVisible();
  await B.page.reload();
  await expect(B.page.getByRole('button', { name: `Open lead ${lead}` })).toBeVisible();

  // --- HQ closes it as lost (reason required); the new owner sees the reason
  await hq.locator('#ldactions').getByRole('button', { name: 'Mark lost' }).click();
  await confirmDialog(hq, 'Mark lost').click(); // empty reason refused
  await expect(hq.locator('#kdlg .err')).toHaveText('Write at least a few words.');
  await hq.locator('#ldask').fill('Customer chose another supplier');
  await confirmDialog(hq, 'Mark lost').click();
  await expect(hq.locator('#ldpanel .pill').first()).toHaveText('Lost');
  await B.page.getByRole('button', { name: `Open lead ${lead}` }).click();
  await expect(B.page.locator('.titlerow .pill')).toHaveText('Lost');
  await expect(B.page.getByText('Customer chose another supplier').first()).toBeVisible();

  // --- once lost, the number is free again: A can register it
  await A.page.goto(PARTNER + '/leads');
  await A.page.getByRole('button', { name: 'Add a lead' }).click();
  await A.page.getByLabel('Business name').fill(uniq('Cafe Aroma again '));
  await A.page.getByLabel('Contact person').fill('Ravi Shah');
  await A.page.getByLabel('Mobile number').fill(num);
  await A.page.getByRole('button', { name: 'Save lead' }).click();
  await expect(A.page.getByRole('button', { name: /Open lead Cafe Aroma again/ })).toBeVisible();
});

test('a Smile partner has no Leads section and cannot reach it', async ({ browser }) => {
  const hq = await (await browser.newContext()).newPage();
  await adminSignIn(hq);
  const S = await activePartner(browser, hq, 'Smile', 'Gamma');
  await expect(S.page.getByRole('link', { name: 'Leads' })).toHaveCount(0);
  await S.page.goto(PARTNER + '/leads');
  await expect(S.page).toHaveURL(`${PARTNER}/dashboard`); // bounced back
  const status = await S.page.evaluate(() => fetch('/api/v1/partner/leads', { credentials: 'same-origin' }).then((r) => r.status));
  expect(status).toBe(403); // and the server refuses regardless of the UI
});
