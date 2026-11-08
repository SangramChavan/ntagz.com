import { test, expect } from '@playwright/test';
import { ADMIN, PARTNER, partnerSignIn, adminSignIn, applyThroughUi, activateThroughUi, uniq, openApplication, act, confirmDialog, pill, card } from './helpers.mjs';

// Calls the API from inside the page so the browser sends its real cookies (Playwright's request API will not send a Secure cookie over http).
const status = (page, path) => page.evaluate((p) => fetch(p, { credentials: 'same-origin' }).then((r) => r.status), path);

// Both sides run in separate browser contexts (separate cookies), exactly like two different people.
test('Workflow B: applicant applies, HQ approves and activates, partner reaches the dashboard', async ({ browser }) => {
  const biz = uniq('Journey Co ');
  const email = `${uniq('applicant')}@example.test`;
  const applicant = await (await browser.newContext()).newPage();
  const hq = await (await browser.newContext()).newPage();

  await partnerSignIn(applicant, email);
  await applyThroughUi(applicant, { biz });
  await expect(applicant.locator('.timeline .current')).toContainText('Application received');

  await adminSignIn(hq);
  await hq.getByRole('link', { name: 'Partners' }).click();
  await expect(card(hq, biz)).toBeVisible(); // arrives in HQ's queue
  await activateThroughUi(hq, biz);

  await applicant.getByRole('button', { name: 'Check for updates' }).click();
  await expect(applicant.getByRole('heading', { name: `Welcome, ${biz}` })).toBeVisible();
  await expect(applicant).toHaveURL(`${PARTNER}/dashboard`);
  await expect(applicant.getByText(/NTZ-FLX-\d{4}/)).toBeVisible();
  // Flex covers leads and wholesale orders but NOT quotations or service jobs (permissions come from the server)
  await expect(applicant.getByText('Create and manage customer leads')).toBeVisible();
  await expect(applicant.getByText('Prepare quotations for bulk and corporate customers')).toHaveCount(0);
  await expect(applicant.getByText('Handle NFC programming, QR setup and installation jobs')).toHaveCount(0);

  // signing out and back in lands straight on the dashboard
  await applicant.getByRole('button', { name: 'Sign out' }).click();
  await expect(applicant.getByRole('heading', { name: 'Sign in to the partner portal' })).toBeVisible();
  await partnerSignIn(applicant, email);
  await expect(applicant.getByRole('heading', { name: `Welcome, ${biz}` })).toBeVisible();
});

test('HQ asks for more documents; applicant sees the request, resubmits; HQ rejects with a reason the applicant sees', async ({ browser }) => {
  const biz = uniq('Docs Co ');
  const email = `${uniq('docs')}@example.test`;
  const applicant = await (await browser.newContext()).newPage();
  const hq = await (await browser.newContext()).newPage();

  await partnerSignIn(applicant, email);
  await applyThroughUi(applicant, { type: 'Smile', biz });
  await adminSignIn(hq);

  await openApplication(hq, biz);
  await act(hq, 'Start review').click();
  await act(hq, 'Request documents').click();
  await confirmDialog(hq, 'Send request').click(); // empty note is refused
  await expect(hq.locator('#kdlg .err')).toHaveText('Write at least a few words.');
  await hq.locator('#pnnote').fill('Please add a GST certificate');
  await confirmDialog(hq, 'Send request').click();
  await expect(pill(hq)).toHaveText('Documents requested');

  await applicant.getByRole('button', { name: 'Check for updates' }).click();
  await expect(applicant.getByText('Ntagz needs more from you.')).toBeVisible();
  await expect(applicant.getByText('Please add a GST certificate')).toBeVisible();
  await applicant.getByRole('button', { name: 'Update my application' }).click();
  await expect(applicant.getByRole('heading', { name: 'Review and submit' })).toBeVisible();
  await applicant.getByRole('button', { name: 'Submit application' }).click();
  await expect(applicant.getByRole('heading', { name: 'Your application' })).toBeVisible();

  await openApplication(hq, biz);
  await expect(pill(hq)).toHaveText('New');
  await act(hq, 'Start review').click();
  await act(hq, 'Reject').click();
  await hq.locator('#pnnote').fill('We are not onboarding this category in your city yet');
  await confirmDialog(hq, 'Reject application').click();
  await expect(pill(hq)).toHaveText('Rejected');

  await applicant.getByRole('button', { name: 'Check for updates' }).click();
  await expect(applicant.getByRole('heading', { name: 'Application not approved' })).toBeVisible();
  await expect(applicant.getByText('We are not onboarding this category in your city yet')).toBeVisible();
  await expect(applicant.getByRole('button', { name: 'Start a new application' })).toBeVisible();
});

test('suspending a partner locks them out at once; reinstating restores access', async ({ browser }) => {
  const biz = uniq('Lock Co ');
  const email = `${uniq('lock')}@example.test`;
  const applicant = await (await browser.newContext()).newPage();
  const hq = await (await browser.newContext()).newPage();

  await partnerSignIn(applicant, email);
  await applyThroughUi(applicant, { biz });
  await adminSignIn(hq);
  await activateThroughUi(hq, biz);
  await applicant.getByRole('button', { name: 'Check for updates' }).click();
  await expect(applicant.getByRole('heading', { name: `Welcome, ${biz}` })).toBeVisible();

  await act(hq, 'Suspend').click();
  await hq.locator('#pnnote').fill('Policy breach under review');
  await confirmDialog(hq, 'Suspend partner').click();
  await expect(pill(hq)).toHaveText('Suspended');

  await applicant.reload(); // the old partner session was revoked server-side
  await expect(applicant.getByRole('heading', { name: 'Sign in to the partner portal' })).toBeVisible();
  expect(await status(applicant, '/api/v1/partner/dashboard')).toBe(401);

  // signing in again works, but only as a customer: no dashboard
  await partnerSignIn(applicant, email);
  await expect(applicant.getByRole('heading', { name: `Welcome, ${biz}` })).toHaveCount(0);
  expect(await status(applicant, '/api/v1/partner/dashboard')).toBe(403);
  expect(await status(applicant, '/api/v1/me')).toBe(200); // still signed in, just not a partner

  await act(hq, 'Reinstate').click(); await confirmDialog(hq, 'Reinstate').click();
  await expect(pill(hq)).toHaveText('Active');
  await applicant.reload();
  await expect(applicant.getByRole('heading', { name: `Welcome, ${biz}` })).toBeVisible();
});

test('wizard: an empty business step shows field errors and moves focus to the first problem', async ({ browser }) => {
  const applicant = await (await browser.newContext()).newPage();
  await partnerSignIn(applicant, `${uniq('val')}@example.test`);
  await applicant.getByText('Ntagz Flex Partner', { exact: true }).click();
  await applicant.getByRole('button', { name: 'Save and continue' }).click();
  await expect(applicant.getByRole('heading', { name: 'Your business' })).toBeVisible();
  await applicant.getByRole('button', { name: 'Save and continue' }).click();
  await expect(applicant.getByText('Enter your business name.')).toBeVisible();
  await expect(applicant.getByText('Enter a 6-digit PIN code.')).toBeVisible();
  await expect(applicant.getByLabel('Business name')).toBeFocused();
  await expect(applicant.getByLabel('Business name')).toHaveAttribute('aria-invalid', 'true');
  await applicant.getByLabel('PIN code').pressSequentially('41a1x001');
  await expect(applicant.getByLabel('PIN code')).toHaveValue('411001'); // non-digits are dropped as you type
});

test('a plan chosen on ntagz.com/partner/ is pre-selected in the wizard after sign-in', async ({ page }) => {
  await page.goto(PARTNER + '/?plan=enterprise');
  await partnerSignIn(page, `${uniq('plan')}@example.test`);
  await expect(page.getByRole('heading', { name: 'Choose your partner category' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Ntagz Enterprise Partner/ })).toBeChecked();
});
