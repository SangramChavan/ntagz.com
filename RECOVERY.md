# Recovery runbook (GitHub-independent)

**What depends on GitHub:** only the static site hosting (GitHub Pages, `CNAME`) and source/deploys. `/api/*`
(Worker `ntagz-payments`), `admin.ntagz.com` and D1 are on Cloudflare and keep working if GitHub is down. *Verified from
the repo; whether apex/www DNS point at Pages is a dashboard fact, not checked.*

## One-time setup (needs a human, not yet done)
1. `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` with Pages edit).
2. Create the Pages project: `npx wrangler pages project create ntagz-site`.
3. `npm run build:static && npx wrangler pages deploy dist --project-name ntagz-site --branch main`, verify on the `*.pages.dev` URL
   (static pages only; `/api` is relative, so test cart/login on the real domain after cut-over).
4. Cut-over: attach `ntagz.com` + `www.ntagz.com` to the Pages project and replace the GitHub A/CNAME records. Confirm the
   `/api/*` Worker routes still win (Worker routes take priority over Pages on the same zone). Keep the old records noted for DNS rollback.

## Deploy / health check
`npm run build:static` (allowlist; aborts if a private file lands in `dist/`) → `wrangler pages deploy dist` →
check `/`, `/order.html`, `/api/catalog` (JSON, 200), `/track.html`. Never use `pages_build_output_dir = "."` in `wrangler.toml`.

## Rollback
- Frontend: Dashboard → Workers & Pages → ntagz-site → Deployments → *Rollback*, or redeploy the previous `dist`.
  List: `npx wrangler pages deployment list --project-name ntagz-site`. No GitHub clone required.
- API / admin Workers: `npx wrangler rollback` (per Worker).
- DNS: re-point to GitHub Pages records noted at cut-over.
- **Database is separate.** Migrations (`admin/migrations`) are additive/forward-only; apply them *before* deploying code that needs
  them, and never roll back by dropping columns. Restore with D1 Time Travel only for data loss:
  `npx wrangler d1 time-travel info ntagz-db` → `... restore ntagz-db --timestamp=<ts>`. Take a bookmark (`info`) before each
  migration, and occasionally `npx wrangler d1 export ntagz-db --remote --output backup.sql`.

## Failure behaviour
If D1/Cloudflare is down, checkout creation and payment recording fail with an error (a payment is only recorded after server-side
verification; no order is marked paid otherwise). There is no offline order queue by design.
