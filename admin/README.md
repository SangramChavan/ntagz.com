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
1. `npx wrangler d1 migrations apply ntagz-db --remote`  (additive; see migrations/0001_admin.sql)
2. `npx wrangler secret put ADMIN_EMAILS` (comma-separated allowlist) and `npx wrangler secret put RESEND_API_KEY`
3. `npx wrangler deploy`  (do NOT set DEV_OTP_ECHO)
4. Add DNS + custom domain `admin.ntagz.com` (uncomment `routes` in wrangler.jsonc), then redeploy.

## Rollback
- Code: `npx wrangler rollback` (or deploy the previous commit). Removing the custom domain takes the admin offline instantly.
- DB: migration 0001 only adds columns/tables/trigger. To undo: `DROP TRIGGER trg_orders_payment_defaults;` and drop the
  four new tables; the new `orders` columns are harmless and can stay.
