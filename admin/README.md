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
