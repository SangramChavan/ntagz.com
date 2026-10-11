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
