# Cutover plan: ntagz.com from GitHub Pages to Cloudflare

Status: **plan only. Nothing in this document has been run against production.** Every step marked 🔒 changes what customers can reach and needs the owner's explicit "go" in chat at that moment.

## 1. What I verified (read-only)

| Fact | Evidence |
|---|---|
| DNS zone is already on Cloudflare | `NS` = `adi.ns.cloudflare.com`, `max.ns.cloudflare.com` |
| Apex, `www` and `admin` are **proxied** (orange cloud) | all three resolve to Cloudflare addresses (`172.67.x`, `104.21.x`) |
| Site is served from GitHub Pages behind that proxy | `x-github-request-id` and `via: varnish` in live headers |
| `www` → apex 301 comes from GitHub Pages (`CNAME` file) | `www.ntagz.com/order.html` → 301 `https://ntagz.com/order.html` |
| `http://ntagz.com` returns 200 (no HTTP→HTTPS redirect) | `curl -I http://ntagz.com` |
| No MX records on the apex | `dig MX` empty (email is not routed through this zone) |
| Staging Worker serves the same bytes as live | `https://ntagz-site.ambivert.workers.dev`, `scripts/cutover-check.sh` passes |
| Cloudflare picks the **most specific** route when several match | Cloudflare Workers docs, "Routes" |
| A route needs an existing proxied DNS record, and then replaces the origin | same docs |

## 2. Design: cut over with routes, not DNS

Because the records are already proxied, **no DNS record has to change.** Cutover is adding Worker routes:

| Route | Worker |
|---|---|
| `ntagz.com/api/*`, `www.ntagz.com/api/*` | `ntagz-payments` (already exists, **unchanged**) |
| `ntagz.com/*`, `www.ntagz.com/*` | `ntagz-site` (new) |

`/api/*` is more specific than `/*`, so payments and checkout keep reaching the payments Worker. The GitHub origin simply stops receiving traffic.

**Rollback is deleting the two `/*` routes.** Traffic returns to GitHub Pages within seconds because DNS never moved. This is why GitHub Pages stays enabled for a week after cutover.

## 3. Pre-flight (all safe, no go needed)

| # | Item | Status |
|---|---|---|
| P1 | Merge PR #42 (site Worker, publish-leak fixes). **Merge it before PR #41** | ☐ |
| P2 | Merge PR #40 so SEO and schema checks pass | ☐ |
| P3 | Confirm GitHub Pages republished after #42: `RECOVERY.md` should now return 404 on ntagz.com | ☐ |
| P4 | Re-run `scripts/cutover-check.sh https://ntagz-site.ambivert.workers.dev --skip-api` on the final `dist/` | ☐ |
| P5 | Write down current Cloudflare settings for the zone so rollback is exact: Cache Rules, Page Rules, Redirect Rules, Transform Rules, "Always Use HTTPS", SSL mode, Workers routes (screenshot or export). I cannot see these without dashboard or token access | ☐ owner |
| P6 | Pick a low-traffic window (for example early morning IST) and a person watching orders | ☐ owner |
| P7 | Take a D1 Time Travel bookmark: `npx wrangler d1 time-travel info ntagz-db` | ☐ |

## 4. Stages

**Stage A, canary 🔒.** Add exactly one route: `ntagz.com/tools/bulk-quote.html` → `ntagz-site`. This is the least important live page, and it proves the route, the assets and the cache work in production.
- Check: `curl -sI https://ntagz.com/tools/bulk-quote.html` shows the Worker's headers (`x-content-type-options`, `permissions-policy`) and no GitHub headers.
- Hold 30 minutes. Rollback: remove that route.

**Stage B, full site on apex 🔒.** Add `ntagz.com/*` → `ntagz-site`. Leave `www` on GitHub Pages for now.
1. `scripts/cutover-check.sh https://ntagz.com` must print `ALL CHECKS PASSED`.
2. Purge the zone cache once (so nothing from GitHub's version lingers).
3. Manual test on a phone: home page, add to cart, open `order.html`, start a **test-mode or ₹1 pay-link** payment end to end, `track.html`, `account/login.html`, `membership/`.
4. Watch `payment_alerts` (D1) and Worker logs for `ntagz-payments` for 30 minutes.

**Stage C, `www` 🔒.** Add `www.ntagz.com/*` → `ntagz-site` (the Worker redirects `www` to the apex, matching today's behaviour). Test `https://www.ntagz.com/order.html` → 301 → apex.

**Stage D, hold one week.** GitHub Pages stays enabled as the instant rollback. During the week: Search Console coverage and crawl errors, Core Web Vitals, orders per day against the previous week, payment success rate.

**Stage E, retire GitHub Pages 🔒.** After a clean week: turn off Pages in the repo settings, remove `CNAME` and `_config.yml`, update `RECOVERY.md`. Only then does making the repo private lose nothing. (If you have a paid GitHub plan, the repo can go private earlier without affecting Pages, but the plan above does not depend on that.)

## 5. Verification checklist (run at every stage)

`scripts/cutover-check.sh <base-url>` covers: 28 sitemap URLs return 200, private paths return 404, ten key files are byte-identical to `dist/`, and `/api/catalog` and `/api/quote` respond. Manually: one real or test payment per gateway you use (PayU and Razorpay), order confirmation page, tracking link from the confirmation email, admin login.

## 6. Rollback

| Situation | Action | Time |
|---|---|---|
| Any page wrong or missing | Delete the `ntagz.com/*` and `www.ntagz.com/*` routes for `ntagz-site` (dashboard → Workers & Pages → `ntagz-site` → Domains & Routes, or `wrangler`) | seconds |
| Bad deploy of the site Worker | `npx wrangler rollback -c workers/site/wrangler.jsonc` | seconds |
| Payments misbehave | This change does not touch `ntagz-payments`. Investigate there; routes for `/api/*` are unchanged | n/a |
| Cache serving stale pages | Purge cache, bump `?v=` on `catalog.js` tags | minutes |

## 7. Risks and how they are handled

| Risk | Handling |
|---|---|
| `/api/*` accidentally served by the site Worker | Most-specific-route rule, plus `cutover-check.sh` hits `/api/catalog` and `/api/quote` on the real domain at Stage A and B |
| Existing Cache Rules, Redirect Rules or Page Rules behave differently in front of a Worker | P5 records them; Stage A canary shows the effect on one page first |
| URL differences from GitHub Pages | Router replicates `.html`, extensionless, trailing-slash and `www` behaviour; unit-tested; all sitemap URLs checked |
| Files that GitHub Pages published but `dist/` does not | Compared in Phase 0: only `tools/bulk-quote.html` was missing (now included). Internal files (`docs/`, `test/`, `RECOVERY.md`) are intentionally not carried over |
| Search engines see a changed site | Content is byte-identical, URLs unchanged, canonical tags unchanged |
| Worker request limits | Static asset requests are free and unlimited. Only directory-style URLs (for example `/product/x/`) invoke the Worker script, which is tiny. Confirm the account's Workers plan at P5 |
| HTTP not redirected to HTTPS today | Optional improvement after Stage D: turn on "Always Use HTTPS" (dashboard setting, owner approval) |

## 8. What I need from you

1. A "go" for each 🔒 stage, at the time, in chat.
2. The P5 export or screenshots of the zone's Rules (Cache, Redirect, Page Rules) and SSL mode, or a Cloudflare API token limited to **Zone: Read** and **Workers Routes: Edit** for this zone so I can read the rules and add the routes myself. I will not create a token; you would.
3. Merge PRs #42 then #40 (and then #41).

## 9. Not part of this cutover

Partner portal subdomains, `cdn.ntagz.com`, the payments Worker, the admin Worker, the database. None are touched.
