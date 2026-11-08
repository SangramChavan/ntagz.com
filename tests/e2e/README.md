# Browser end-to-end tests

Playwright drives the **real** partner portal and HQ admin screen against the **real** Workers (`wrangler dev --local`) on a throwaway local D1 + R2.
Nothing here can reach production: the database is rebuilt under `tests/e2e/.wrangler/state` on every run, and sign-in codes are read from the API response
(`DEV_OTP_ECHO`, local only).

| Spec | Covers |
|---|---|
| `journey.spec.mjs` | Workflow B end to end (apply through the wizard with real uploads, HQ approve, agreement, fee, activate, dashboard, sign out/in); documents-requested loop and rejection reason; suspension locks the partner out at once and reinstating restores access; wizard validation moves focus to the first problem |
| `mobile.spec.mjs` | 360 px phone: no sideways scroll, controls at least 44 px, header on one row |

Run: `npm --prefix apps/partner-portal ci && npm --prefix apps/partner-portal run build`, then in this folder `npm ci`, `npx playwright install chromium`, `npx playwright test`.
CI runs the same in the `e2e` job and uploads traces when it fails.

Notes
- `wrangler` is pinned here (exact version) so CI does not fetch an unpinned one.
- Each applicant gets a unique email and PAN: the server rightly blocks two partners with the same PAN.
- API checks run inside the page (`fetch`) because Playwright's request API will not send a `Secure` cookie over plain http.
- Not covered yet: customer checkout, emails to a real inbox, the admin screens other than Partners.
