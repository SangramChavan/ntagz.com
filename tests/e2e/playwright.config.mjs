import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs the REAL partner and admin Workers locally (wrangler dev, local D1 + local R2) and drives them in a browser.
// Everything is local: a throwaway database under ./.wrangler/state, built fresh by global-setup. Nothing here can reach production.
const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '../..');
export const STATE = path.join(here, '.wrangler/state');
export const WRANGLER = path.join(here, 'node_modules/.bin/wrangler');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };

// Fresh local database every run: base schema, then every admin migration (the order production was built in).
// Done here, at config load, because Playwright starts the web servers BEFORE any globalSetup would run.
// Guarded: this file is loaded again inside each test worker, which must not rebuild the database.
if (!process.env.E2E_DB_READY) {
  fs.rmSync(STATE, { recursive: true, force: true });
  const run = (...args) => execFileSync(WRANGLER, args, { cwd: path.join(root, 'admin'), stdio: ['ignore', 'pipe', 'pipe'], env });
  run('d1', 'execute', 'ntagz-db', '--local', '--persist-to', STATE, '--file', path.join(root, 'db/schema.sql'));
  run('d1', 'execute', 'ntagz-db', '--local', '--persist-to', STATE, '--file', path.join(root, 'db/membership-schema.sql'));
  run('d1', 'migrations', 'apply', 'ntagz-db', '--local', '--persist-to', STATE);
  process.env.E2E_DB_READY = '1';
}

export default defineConfig({
  testDir: './specs',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1, // one shared local database; the specs create their own uniquely named applicants
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: {} },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } }, testIgnore: /mobile/ },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true }, testMatch: /mobile/ },
  ],
  webServer: [
    {
      // --var supplies local-only settings (no .dev.vars file). DEV_OTP_ECHO returns the sign-in code in the API response so the test can read it.
      command: `${WRANGLER} dev --local --port 8815 --persist-to ${STATE} --var DEV_OTP_ECHO:1 --var PAN_HASH_SECRET:e2e-only-secret --var HQ_NOTIFY_EMAILS:hq@example.test`,
      cwd: path.join(root, 'workers/partner'), url: 'http://localhost:8815/api/v1/partner/types', timeout: 120_000, reuseExistingServer: false, env,
    },
    {
      command: `${WRANGLER} dev --local --port 8812 --persist-to ${STATE} --var ADMIN_EMAILS:admin@example.test --var DEV_OTP_ECHO:1`,
      cwd: path.join(root, 'admin'), url: 'http://localhost:8812/', timeout: 120_000, reuseExistingServer: false, env,
    },
  ],
});
