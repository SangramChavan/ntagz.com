# Recovery runbook (GitHub-independent)

**What depends on GitHub:** only the static site hosting (GitHub Pages, `CNAME`) and source/deploys. `/api/*`
(Worker `ntagz-payments`), `admin.ntagz.com` and D1 are on Cloudflare and keep working if GitHub is down. *Verified from
the repo; whether apex/www DNS point at Pages is a dashboard fact, not checked.*

## One-time setup (needs a human; staging steps done, cut-over not done)
1. `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` with Workers edit).
2. `npm run build:static && npx wrangler deploy -c workers/site/wrangler.jsonc` publishes Worker `ntagz-site` (assets from `dist/`) to its
   `workers.dev` URL only. Static pages can be checked there (`/api` is relative, so test cart/login on the real domain after cut-over).
3. Cut-over (owner go required): attach `ntagz.com` + `www.ntagz.com` to `ntagz-site` and replace the GitHub A/CNAME records. Confirm the
   `/api/*` routes on `ntagz-payments` still win over the site (verify on a staging hostname first). Keep the old records noted for DNS rollback.

## Deploy / health check
`npm run build:static` (allowlist; aborts if a private file lands in `dist/`) → `npx wrangler deploy -c workers/site/wrangler.jsonc` →
check `/`, `/order.html`, `/api/catalog` (JSON, 200), `/track.html`; `npm run test:site` checks URL routing parity with GitHub Pages.
Never use `pages_build_output_dir = "."` in `wrangler.toml`.

## Rollback
- Frontend: `npx wrangler rollback -c workers/site/wrangler.jsonc`, or redeploy the previous `dist`. No GitHub clone required.
- API / admin Workers: `npx wrangler rollback` (per Worker).
- DNS: re-point to GitHub Pages records noted at cut-over.
- **Database is separate.** Migrations (`admin/migrations`) are additive/forward-only; apply them *before* deploying code that needs
  them, and never roll back by dropping columns. Restore with D1 Time Travel only for data loss:
  `npx wrangler d1 time-travel info ntagz-db` → `... restore ntagz-db --timestamp=<ts>`. Take a bookmark (`info`) before each
  migration, and occasionally `npx wrangler d1 export ntagz-db --remote --output backup.sql`.

## Failure behaviour
If D1/Cloudflare is down, checkout creation and payment recording fail with an error (a payment is only recorded after server-side
verification; no order is marked paid otherwise). There is no offline order queue by design.
