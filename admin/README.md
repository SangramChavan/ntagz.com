# NTAGZ admin (Cloudflare Worker + D1)

Separate Worker (`ntagz-admin`) for `admin.ntagz.com`. The public site (GitHub Pages) and the existing
`ntagz-payments` Worker (`ntagz.com/api/*`) are untouched. It shares the existing D1 database `ntagz-db`.

## Local development (local D1 only)
    npx wrangler d1 execute ntagz-db --local --file ../db/schema.sql
    npx wrangler d1 migrations apply ntagz-db --local
    npx wrangler d1 execute ntagz-db --local --file test/fixtures.sql   # fake orders, local only
    printf 'ADMIN_EMAILS=admin@example.test\nDEV_OTP_ECHO=1\n' > .dev.vars
    npx wrangler dev --local --port 8799     # then: node test/smoke.mjs

## Production deploy (needs explicit go-ahead; steps are ordered)
1. `npx wrangler d1 migrations apply ntagz-db --remote`  (additive: 0001_admin.sql, 0002_products.sql — the latter seeds 17 products from js/catalog.js)
2. `npx wrangler secret put ADMIN_EMAILS` (comma-separated allowlist) and `npx wrangler secret put RESEND_API_KEY`
3. `npx wrangler deploy`  (do NOT set DEV_OTP_ECHO)
4. Add DNS + custom domain `admin.ntagz.com` (uncomment `routes` in wrangler.jsonc), then redeploy.

## Rollback
- Code: `npx wrangler rollback` (or deploy the previous commit). Removing the custom domain takes the admin offline instantly.
- DB: migration 0001 only adds columns/tables/trigger. To undo: `DROP TRIGGER trg_orders_payment_defaults;` and drop the
  four new tables; the new `orders` columns are harmless and can stay.

## Products & inventory
Endpoints (all need an admin session): `GET /api/products` (q, category, stock=in|low|out, active, sort, dir, page),
`GET /api/products/summary`, `GET /api/products/:id` (with last 50 stock movements), `POST /api/products` (create),
`POST /api/products/:id` (edit details/price; cannot change stock), `POST /api/products/:id/stock` (in | out | set),
`POST /api/products/:id/active`. There is no delete: products are archived (inactive) so orders and history stay valid.
Tests: `node test/smoke.mjs` then `node test/products.mjs` against a fresh local DB (see Local development).

### Storefront sync (not done yet — needs approval)
The public storefront and checkout still read prices from `js/catalog.js` (and `functions/api/[[path]].js` for member
pricing). Admin price/active/stock edits are therefore stored in D1 only; they do **not** change what customers see or are
charged, and checkout does not decrement stock. Closing that gap means changing public/checkout code (e.g. a read-only
public endpoint on the payments Worker plus server-side price checks), which should be a separate, reviewed change.
Seeded stock is 0 for every product: do a first "Set actual stock" count.

## Pricing & membership (`#/pricing`)
One engine prices everything: `functions/lib/pricing.js`, used by the payments Worker (checkout, offline orders, `POST /api/quote`,
`GET /api/membership/pricing`) and by this Worker (pricing preview and warnings), so a preview is exactly what checkout charges.
Order of discounts per line: regular price (Products) -> bulk tier for everyone (500/1000/5000 pcs: 10/15/25%) -> member %
(`products.member_discount_pct`, active unexpired members only, never on the kit) -> guardrails that only shrink the member part:
combined discount <= `max_total_discount_pct`, and, where a cost price is set, price >= cost / (1 - `min_margin_pct`).
There are no coupons or promotions, so nothing else can stack.

Endpoints (admin session; POSTs need `X-Requested-With: ntagz-admin`): `GET /api/pricing`, `POST /api/pricing/preview`
`{draft, items, state}` (never writes), `POST /api/pricing/publish` `{draft, version, confirm:true}` (refuses stale drafts, blocks
"member pricing on with nothing discounted", one atomic batch + `audit_log` `pricing_publish`), `GET /api/memberships`.
Plan settings live in `membership_config` (`fee_paise`, `duration_days`, `discounts_live`, `max_total_discount_pct`, `min_margin_pct`).

### Deploy order (needs go-ahead)
1. `npx wrangler d1 migrations apply ntagz-db --remote` (0010: adds `products.member_discount_pct`, seeded from the old category
   settings so live member % stays the same, plus `duration_days` / `max_total_discount_pct`). Workers deployed before it keep
   working (no member discount); deploy code after the migration, never before.
2. Deploy the payments Worker (`npx wrangler deploy -c wrangler.payment.toml`) and this Worker (`cd admin && npx wrangler deploy`).
3. Publish the site (order.html, js/order.js, js/membership.js, membership/, account/). `order.html` now calls `/api` on the same
   origin so the sign-in cookie reaches checkout; this relies on the existing `ntagz.com/api/*` and `www.ntagz.com/api/*` routes.
Tests: `npm run test:stage2` (includes `test-member-pricing.cjs`) and `cd admin && npm test`.

## Ntagz Rewards (spending tiers) — migration 0012
Free loyalty program next to the paid ₹999 membership. Admin → **Rewards**.

**Rules (defaults, all editable in Admin → Rewards, no code change):** Free ₹0 / Silver ₹1,000 (3%) / Gold ₹3,000 (5%) / Platinum ₹10,000 (8%).
- *Qualifying spend* = paid orders, net of discounts, **without GST and shipping**, summed over the customer's lifetime, only for orders placed while signed in. It is **derived from the `orders` table** (`functions/lib/loyalty.js`), never a running counter, so an order cannot be counted twice and cancellations, returns and refunds take effect automatically. Cancelled/returned orders drop out; a refund reduces the order's value in proportion; audited manual corrections add/subtract a signed amount.
- Tier = highest active tier the spend reaches. No expiry. Tier changes are logged with a reason (`loyalty_tier_log`); prices always use the freshly derived tier.
- Discount applies to **eligible** products only (per product: Eligible tick + optional ceiling; fixed-price kits never). With a paid membership the customer gets the **better** of the two by default (`loyalty_combine`: `best_of` | `stack`); the combined-discount cap and minimum margin (Pricing page) always apply.
- Each order stores its own `qualifying_paise`, `shipping_paise`, `discount_paise`, `campaign_*` at creation, so changing settings never rewrites history.
- **Cart milestones** (`cart_campaigns`): explicit reward (free shipping, or ≤20% off), threshold on net product value, audience, dates, redemption limits. A percentage reward does not stack on member/quantity discounts unless "combinable". None are created for you.

**Deploy order** (rewards ship OFF; deploying changes no price):
1. `npx wrangler d1 time-travel info ntagz-db` (note the bookmark), then `npx wrangler d1 migrations apply ntagz-db --remote` (applies 0012, additive only; existing paid orders are backfilled so customers keep their standing; shipping for old orders is estimated from the store's rule).
2. `cd admin && npx wrangler deploy`, then from the repo root `npx wrangler deploy -c wrangler.payment.toml`. Without 0012 the Workers keep working on the old statements.
3. Static site (GitHub Pages): push `main`.
4. In Admin → Rewards review the tiers, add milestones if wanted, then switch **Rewards ON**.

**Rollback / recovery:** switch Rewards OFF (instant, no deploy); `wrangler rollback` the Workers; the new columns/tables are harmless if left. Data loss only: D1 Time Travel restore to the bookmark from step 1. Never drop the new tables: orders reference them.
Known limits: spend only counts orders placed while signed in; refunds are *recorded* here (money is returned outside the system); a redemption limit is soft under simultaneous checkouts.

## Customers / CRM (`#/customers`) — migration 0013
Customer directory, profiles, analytics, segments, consent-based email campaigns and journeys. Code: `src/crm/*` (API under `/api/crm/`), UI `public/customers.js`, `crm-analytics.js`, `crm-campaigns.js`, `crm.css`; storefront endpoints in `functions/lib/crm-public.js` (mounted in the payments Worker); shared primitives in `functions/lib/crm.js`; storefront script `js/nz-analytics.js`.
Tests: `npm run test:stage2` (`test-crm-core`, `-analytics`, `-campaigns`).

**Identity.** `crm_customers` view: a registered user (`u:<id>`) or a guest keyed by normalised email (`g:<email>`). A guest order joins a registered customer only when the email is identical; names/phones/IPs never match. Orders with no email stay out of per-customer views but still count in revenue totals.
**Money.** Only `crm_orders.counts = 1` orders (paid, amount > 0, not cancelled/returned) are revenue; refunds reduce GST/shipping/product value proportionally; unpaid, cancelled and returned are 0. Days are IST, ranges inclusive, orders dated by creation time. Formulas are in `src/crm/common.js` (`DEFS`) and shown as tooltips. Qualifying (membership) spend is derived by `functions/lib/loyalty.js` and shown separately.
**Permissions.** `view`/`manage`: every allow-listed admin unless `CRM_VIEW_EMAILS`/`CRM_MANAGE_EMAILS` is set. `export` (CSV, per-customer data, erasure) and `send` (campaigns, journeys): only the first `ADMIN_EMAILS` entry unless `CRM_EXPORT_EMAILS`/`CRM_SEND_EMAILS` list others. Checked server-side on every route; sensitive actions are in `audit_log`.
**Consent.** Marketing eligibility = explicit current opt-in in `marketing_contacts` (account page checkbox, off by default). Ordering never subscribes anyone; admins can unsubscribe/suppress but never opt anyone in; a suppression (bounce/complaint/manual) cannot be overridden by the customer. Unsubscribe: `https://ntagz.com/api/unsubscribe` (GET confirms, POST/one-click performs). Needs `UNSUB_SECRET` on **both** Workers' secrets (payments Worker for the link, admin Worker to sign it).
**Tracking.** Off by default (Customers → Settings). When on, the storefront shows a consent bar; only after "yes" are page/product views, search, cart add/remove, checkout start and membership views sent (path only, no query strings; search text containing an email/phone-like value is dropped). The server sets time and the signed-in user; browsers cannot submit purchases/revenue. `purchase`, `refund`, `membership_tier_changed` come from orders/refunds/tier log. Honors Do-Not-Track/GPC. Events are purged after the retention setting (default 180 days) by the cron. No history is back-filled: before enabling, the timeline shows order/consent/campaign records only.
**Email.** Reuses Resend. Secrets/vars: `RESEND_API_KEY`, `MARKETING_SEND_ENABLED=1`, `MARKETING_FROM`, `MARKETING_POSTAL_ADDRESS`, `UNSUB_SECRET`, `RESEND_WEBHOOK_SECRET` (point a Resend webhook at `https://admin.ntagz.com/webhooks/resend`: delivered, bounced, complained). Missing config → sending is refused, nothing is marked sent. Journeys ship OFF and in test mode. Offers are limited to what checkout supports (announcement, membership upgrade, an existing cart milestone, new product, reorder reminder). **Coupons / product, bundle, bulk discounts are not built: checkout has no coupon engine** — that needs a separate reviewed checkout change.
**Cron.** `*/15 * * * *` on the admin Worker: due campaigns, journeys, retention purge.
**Known limits.** Open tracking is intentionally absent; clicks may include security scanners; attributed revenue is last-click within 7 days, not incremental; the directory/analytics scan the orders table per request (fine for thousands of orders; add a summary table refreshed by cron if it grows); D1 allows ≤5 terms per compound SELECT (the timeline is split accordingly); a privacy-notice page is still needed (the consent bar links to Terms).

### Deploy order (needs go-ahead; nothing here has been deployed)
1. `npx wrangler d1 time-travel info ntagz-db`, then `npx wrangler d1 migrations apply ntagz-db --remote` (0013, additive).
2. Secrets: `wrangler secret put UNSUB_SECRET` (admin) and `wrangler secret put UNSUB_SECRET -c ../wrangler.payment.toml` (payments); email vars above when ready to send.
3. `cd admin && npx wrangler deploy`, then from repo root `npx wrangler deploy -c wrangler.payment.toml`, then publish the static site (`npm run build:static`).
4. Customers → Settings: review, then switch tracking on if wanted. Keep journeys off until a test campaign is verified.
Rollback: `wrangler rollback`; tracking off in Settings; tables are inert if left.

## Ntagz Rewards Membership (points wallet) — migration 0014
Paid ₹999/year membership + a points wallet and spending milestones for members. Ships **OFF** (`pts_live=0`): deploying changes no price. Admin → **Membership** (`#/membership`). Code: `functions/lib/points.js` (rules), pricing in `functions/lib/pricing.js` (`redeemPaise`, `pointsBasisPaise`), checkout wiring in `functions/api/[[path]].js` (`pricedCart`), admin API `src/membership.js`, UI `public/membership.js`; storefront `membership/`, `js/membership*.js`, account Membership panel, checkout points control. Tests: `test-points.cjs`.
**Rules (all editable; defaults).** 5 points per ₹100 of net eligible merchandise spend (after every discount incl. points, without GST/shipping), 1 point = ₹1, min redeem 50, max 10% of eligible value per order, points valid 365 days, earned when the order is **delivered**, minimum qualifying order ₹0. Members only (active, unexpired paid membership); per-product opt-out (`products.points_eligible`).
**Integrity.** `points_ledger` is append-only with a unique `idem_key`; balances are always derived (never stored). Earning is *reconciled* from the order after payment, status change and refund, so retries/late refunds can't double-pay or lose points. Spending is recorded in the same batch as the order; an open checkout holds its points (only the newest checkout holds; holds lapse after 3 h). Expired, unspent points are excluded from the balance at once and recorded by the daily sweep (oldest points are spent first). If refunds reverse points already spent the balance can go "owed" and redemption resumes once earned again.
**Policies.** Cancel/return reverses earned points and restores spent points (`pts_restore_on_cancel`). Partial refunds reverse the matching share of earned points; points spent are not restored. A milestone pays once per membership term from delivered eligible spend; editing a milestone never rewrites past awards; with `pts_clawback` on, a refund that drops spend under a milestone takes that bonus back (never below zero). A renewal bought within `renew_window_days` of expiry starts when the current term ends. Expiry emails (`renew_notice_days`, default 30,7) are one per membership per threshold, via the existing Resend setup (service notices, not marketing).
**Not built.** Referrals (no rules were specified), coupons (checkout has none), points on UPI/bank/WhatsApp orders, automatic recurring renewal. Contribution/profit is shown only when every product sold has a cost price, and always before shipping/payment fees.
**Deploy order (needs go-ahead).** `wrangler d1 time-travel info ntagz-db` → `d1 migrations apply ntagz-db --remote` (0014) → deploy admin Worker → deploy payments Worker → publish static site → Admin → Membership: review settings and warnings, then switch rewards ON. Rollback: switch OFF (instant); `wrangler rollback`.
