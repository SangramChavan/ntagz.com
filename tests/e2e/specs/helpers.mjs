import { expect } from '@playwright/test';

export const PARTNER = 'http://localhost:8815';
export const ADMIN = 'http://localhost:8812';
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n');
export const uniq = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
// A valid-looking PAN that is different every time (the server blocks two partners with the same PAN).
const L = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
export const uniquePan = () => `${L()}${L()}${L()}${L()}${L()}${String(Math.floor(1000 + Math.random() * 9000))}${L()}`;

// The UI never shows the sign-in code, so read it from the API response (the local Workers run with DEV_OTP_ECHO).
export async function partnerSignIn(page, email) {
  await page.goto(PARTNER + '/');
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/otp/send'));
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send me a code' }).click();
  const { data } = await (await sent).json();
  await page.getByLabel('6-digit code').fill(data.dev_otp);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible(); // signed in: the session cookie is set
}

export async function adminSignIn(page) {
  await page.goto(ADMIN + '/');
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/auth/request'));
  await page.locator('#email').fill('admin@example.test');
  await page.getByRole('button', { name: 'Send code' }).click();
  const body = await (await sent).json();
  await page.locator('#otp').fill(body.dev_otp);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Partners' })).toBeVisible();
}

// Fills the whole wizard through the real UI and submits.
export async function applyThroughUi(page, { type = 'Flex', biz, name = 'E2E Applicant' }) {
  await expect(page.getByRole('heading', { name: 'Choose your partner category' })).toBeVisible();
  await page.getByText(`Ntagz ${type} Partner`, { exact: true }).click();
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await expect(page.getByRole('heading', { name: 'Your business' })).toBeVisible();
  await page.getByLabel('Business name').fill(biz);
  await page.getByLabel('Type of business').selectOption('Retail shop');
  await page.getByLabel('City').fill('Pune');
  await page.getByLabel('State').selectOption('Maharashtra');
  await page.getByLabel('PIN code').fill('411001');
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await expect(page.getByRole('heading', { name: 'About you' })).toBeVisible();
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Mobile number').fill('+91 99601 60016');
  await page.getByLabel('PAN', { exact: true }).fill(uniquePan());
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await expect(page.getByRole('heading', { name: 'Capacity' })).toBeVisible();
  await page.getByLabel('How much can you invest to start?').selectOption({ label: '₹1 – 3 lakh' });
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
  await page.locator('#doc-pan').setInputFiles({ name: 'pan.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('Uploaded · PNG')).toBeVisible();
  await page.locator('#doc-address_proof').setInputFiles({ name: 'bill.pdf', mimeType: 'application/pdf', buffer: PDF });
  await expect(page.getByText('Uploaded · PDF')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Review and submit' })).toBeVisible();
  await page.getByRole('button', { name: 'Submit application' }).click();
  await expect(page.getByRole('heading', { name: 'Your application' })).toBeVisible();
}

// ---- HQ side (admin > Partners) ----
export const card = (page, biz) => page.locator('.pn-card', { hasText: biz });
export async function openApplication(page, biz) {
  if (await page.locator('#pnpanel[open]').count()) await page.locator('#pnpanel').getByRole('button', { name: 'Close' }).click();
  await page.goto(ADMIN + '/#/orders'); // leaving and re-entering the Partners tab reloads the queue
  await page.goto(ADMIN + '/#/partners');
  await card(page, biz).getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('#pnpanel h2')).toHaveText(biz);
}
export const act = (page, name) => page.locator('#pnactions').getByRole('button', { name, exact: true });
export const confirmDialog = (page, name) => page.locator('#kdlg').getByRole('button', { name, exact: true });
export const pill = (page) => page.locator('#pnpanel .pn-body .pill').first();

// start review -> approve -> agreement -> fee -> activate, all through the HQ screen
export async function activateThroughUi(page, biz) {
  await openApplication(page, biz);
  await act(page, 'Start review').click();
  await expect(pill(page)).toHaveText('In review');
  await act(page, 'Approve').click(); await confirmDialog(page, 'Approve').click();
  await expect(pill(page)).toHaveText('Agreement pending');
  await act(page, 'Record agreement signed').click(); await confirmDialog(page, 'Agreement is signed').click();
  await expect(pill(page)).toHaveText('Fee pending');
  await page.locator('#pnref').fill(uniq('UPI-E2E-'));
  await page.getByRole('button', { name: 'Record fee payment' }).click(); await confirmDialog(page, 'Record fee').click();
  await expect(pill(page)).toHaveText('Final checks');
  await act(page, 'Activate partner').click(); await confirmDialog(page, 'Activate').click();
  await expect(pill(page)).toHaveText('Active');
}
