# Phase 0 Report: Repository Inspection and Decisions

Status: inspection only, no code or schema changed. Sources: three read-only inspections of this repo (backend and database, frontend, infrastructure and CI). Nothing here has been checked against the live Cloudflare or GitHub dashboards.

## 1. What exists today

| Layer | Reality | Evidence |
|---|---|---|
| Public site | Static HTML/CSS/vanilla JS. **Probably GitHub Pages, about 85% sure.** Unverified | `CNAME`, `_config.yml`, `admin/wrangler.jsonc` comment, `RECOVERY.md` |
| Public API | Worker `ntagz-payments` on `ntagz.com/api/*` and `www.ntagz.com/api/*`. Source `functions/api/[[path]].js` (1,779 lines) wrapped by `payment-worker.mjs`. Deploy: `wrangler deploy -c wrangler.payment.toml` | `wrangler.payment.toml` |
| Admin | Worker `ntagz-admin` at `admin.ntagz.com`, vanilla-JS UI, cron every 15 min | `admin/wrangler.jsonc`, `admin/src/index.js` |
| Database | One D1 `ntagz-db`, shared by both Workers. About 45 tables. Base schema in `db/*.sql` is **applied by hand**, not by migrations | `db/`, `admin/migrations/0001-0020` |
| Payments | PayU and Razorpay, both verified server-side. Orders created only by `finalizeOrder`, idempotent, failures recorded in `payment_alerts` | `functions/api/[[path]].js` |
| Customer auth | Email OTP, 7-day `ntagz_session` cookie (HttpOnly, Secure, SameSite=Lax, **host-only**), sign-up on first login, no passwords | same file, lines 590-640 |
| Admin auth | `ADMIN_EMAILS` allowlist, email OTP, 12 h `ntagz_admin` cookie (SameSite=Strict), CSRF header, audit log. **No MFA beyond email** | `admin/src/index.js` |
| Roles | **None.** No `roles` or `permissions` tables. Only env allowlists for four CRM permissions | `admin/src/crm/common.js` |
| CI | `npm ci`, audit, `test:payment`, `test:stage2` only. No deploy step | `.github/workflows/ci.yml` |
| Secrets | In Worker secrets and gitignored `.dev.vars`. None found committed | infra report |

## 2. Features that must keep working

Checkout and quotes (GST, shipping, MOQ, bulk tiers), PayU and Razorpay and offline payments, cart (`ntagz_cart_v1`), live catalogue from D1 with static fallback, membership and member pricing, rewards and points, customer account (orders, profile, addresses, consent), order confirmation and tracking, pay links, international storefront and quotes, preorders, custom review stand, NFC programmer and checker, bulk quote tool, assistant, analytics events, all SEO assets, the whole admin Worker (orders, products, pricing, customers, CRM, membership, rewards, intl, pay links).

The existing tests are the regression gate: every `npm run test:*` script and `admin/test/run-all.sh`.

## 3. Conflicts between the go-ahead brief and the repo, and what I decided

| # | Brief says | Repo says | Decision |
|---|---|---|---|
| 1 | Monorepo `ntagz-platform` with `apps/`, `workers/`, `packages/` | One repo, flat layout, live site served from root | Add `apps/`, `workers/`, `packages/` **inside this repo**. Move nothing that is live |
| 2 | Cloudflare hosting | Public site is probably on GitHub Pages; API and admin are already Cloudflare Workers | **Owner decision: host everything on Cloudflare only.** GitHub stays as source control and CI. Public site moves to a Cloudflare Worker with static assets (same pattern as `ntagz-admin`), built from `dist/`. See section 9 for the cutover plan. **Open item O1** |
| 3 | `auth.ntagz.com` central auth, `api.ntagz.com` | Auth lives in each Worker; API is `ntagz.com/api/*` | No `auth.`/`api.` for now. One shared auth module used by all Workers. Revisit after Phase 2 |
| 4 | One identity, single login across portals | Customer cookie is host-only; admin is a separate allowlist | One `users` table and one `sessions` table. **Each portal issues its own host-only cookie** from the same identity. A domain-wide cookie is a Phase 2 option, because changing the live cookie could log out customers |
| 5 | Mobile OTP | Email OTP only; no SMS provider | P0 uses email OTP, and the phone number is collected and stored. Mobile OTP waits for an SMS provider (**O3**) |
| 6 | MFA for administrators | Email OTP is the only factor | Add TOTP for all staff roles in Phase 2 |
| 7 | Create about 60 tables | About 45 exist | New tables only where nothing exists; see `CONTRACTS.md` section 1 |
| 8 | Preact/TS/Tailwind | Vanilla everywhere | New partner portal uses Preact + TypeScript. Tailwind only if the design system needs it. Existing site and admin stay vanilla |
| 9 | Razorpay or Cashfree | PayU and Razorpay | Keep both. Cashfree not planned |
| 10 | Palette `#FF6A21` / `#1F1C20` | Site uses `#FF4500` / `#1A1714`, neumorphic. Membership dashboard already uses the target palette | Partner portal uses the target palette. **Restyling the live storefront needs your approval (O4)** |

## 4. Defects and risks found (not yet fixed)

**Security (customer and admin Workers):**
1. Customer `send-otp` has no per-IP limit, only 3 codes per email per 15 minutes.
2. Customer session IDs are stored in plain text in D1 (admin tokens are hashed). Expired sessions and OTP rows are never purged.
3. Customer cookie mutations rely on an Origin check that is skipped when no `Origin` header is sent.
4. `throttled()` fails open when D1 errors or the client IP is missing.
5. Admin endpoints `/api/auth/request` and `/verify` have no per-IP limit. Every allowlisted admin can refund, delete products and change prices (no finer roles).
6. Weak validation on addresses (pincode, phone) and GSTIN.
7. No admin screen for `payment_alerts`, so an unrecorded payment is only visible in logs.
8. Segment SQL builder in the CRM uses template-literal SQL with bound parameters. It looks safe but needs a targeted review before anyone extends it.

**Operations:**
1. Root `wrangler.toml` has `pages_build_output_dir = "."`. Deploying it would publish `admin/`, `db/` and `functions/`. Remove that line.
2. Base schema is not in migrations, so a fresh database cannot be rebuilt from migrations alone.
3. CI runs 2 of about 15 test groups. The SEO, schema, pricing, link and admin suites do not gate merges (PR #40 repairs the SEO and schema ones).
4. `express` is an unused dependency. Test runner uses unpinned `npx wrangler@4`.
5. Migration numbers 0012, 0017, 0018 are duplicated. Harmless, since wrangler orders by filename. **New migrations start at 0021.**
6. `bulk-quote.html` is not copied by `build-static.sh`. `google-review-nfc-card-with-qr` is a `noindex` placeholder.
7. `.mcp.json` is untracked and may hold tokens. Check before committing.

## 5. Gap analysis against the four workflows

| Workflow | Already works | Missing |
|---|---|---|
| A Customer | Browse, cart, checkout, payment, confirmation, OTP login, order list, order detail, reorder, public tracking | Mobile-number OTP, tracking inside the account, **invoice download**, support tickets, NFC/QR management, `account.ntagz.com` |
| B Partner | Nothing | Everything: apply, verify, review, approve, agreement, login, catalogue, leads, orders, earnings |
| C HQ | Orders, products, pricing, inventory, customers, CRM, refunds, shipments, audit log | Partner applications and approvals, territories, commissions, settlements, partner price lists, quotations, staff roles and MFA |
| D Attribution | Nothing (`orders` has no partner column) | Leads, order-to-partner link, commission engine, approval, settlement |

## 6. Open items that need you

| # | Item | Needed by |
|---|---|---|
| O1 | Confirm current hosting (`dig ntagz.com`, GitHub Pages setting, Cloudflare dashboard) and give me the go for the **DNS cutover** in section 9, step 6. I will not change DNS before that | Cutover |
| O2 | Cloudflare access for the agent (read-only first), plus approval for `partner.ntagz.com` and `cdn.ntagz.com` DNS and custom domains | Phase 4 deploy |
| O3 | SMS OTP provider choice (for example MSG91 or Twilio), and a WhatsApp Business API account | Phase 7, but start approval early |
| O4 | Approve restyling the live storefront to the new palette, or keep it as is | Before any storefront CSS change |
| O5 | Commercial decisions: GST treatment of joining fees, refund policy on fees, commission release window, TDS on payouts, KYC retention. Draft agreement text needs legal review | Before Phase 4 goes live |
| O6 | Check that tier names (especially "Smile") don't clash with another company's programme names | Before launch |

## 7. Staging plan

There is no staging environment today. Plan: a separate D1 `ntagz-db-staging` and test-mode payment keys, with Worker names ending `-staging`. Creating these is a Cloudflare change, so I will ask first (O2).

## 8. Honest estimate

The brief's scope is a multi-month programme. Realistic first usable release (P0): identity and roles, partner apply to approve to login to dashboard, HQ partner approvals, basic wholesale catalogue and ordering. Orders for partners run through the existing checkout. P1 adds leads, quotations, commissions, territories and shipments. P2 follows. Parallel agents shorten the build, but they do not remove the review and testing time, and nothing goes to production without your sign-off.

## 9. Cloudflare-only hosting: cutover plan

Target: every hostname served by Cloudflare. GitHub is used only for source control and CI.

| Host | Target on Cloudflare |
|---|---|
| `ntagz.com`, `www.ntagz.com` | New Worker `ntagz-site` with static assets from `dist/` (built by `scripts/build-static.sh`). `/api/*` stays on `ntagz-payments` |
| `admin.ntagz.com` | `ntagz-admin` (already there) |
| `partner.ntagz.com` | New Worker `ntagz-partner` (assets + `/api/v1`) |
| `account.ntagz.com` | Later; `/account/` stays on the main site until then |
| `cdn.ntagz.com` | R2 bucket with custom domain |

Why a Worker with assets and not Pages: `ntagz-admin` already uses it, one deploy tool (`wrangler`) covers everything, and it avoids the dangerous `pages_build_output_dir = "."` setting. `RECOVERY.md` plans a Pages project; it will be updated to match whichever is chosen.

**Steps. Steps 1 to 5 are safe; step 6 and later change what customers see.**
1. Remove `pages_build_output_dir` from the root `wrangler.toml`. Add `wrangler.site.jsonc` (`ntagz-site`, assets dir `dist`, no routes yet).
2. Add `tools/` and any other missing public paths to `build-static.sh`. Add a check that `dist/` matches the live site file list.
3. Deploy `ntagz-site` to its `workers.dev` URL (or a staging host) and run a full check: every sitemap URL returns 200, `/order.html`, `/track.html` and `/api/catalog` work, `robots.txt`, `sitemap.xml`, `llms.txt` and headers are correct, redirects (`www` and old paths) match today.
4. Confirm that routing precedence between `ntagz.com/*` (site) and `ntagz.com/api/*` (payments) behaves as expected on a staging hostname. If not, route the site by exact paths instead.
5. Add security headers and caching rules (HSTS, CSP, long cache for hashed assets, short for HTML) and a rollback command to the runbook.
6. **Needs your go:** lower DNS TTL, attach `ntagz.com` and `www.ntagz.com` to `ntagz-site`, verify, keep GitHub Pages enabled as a quick rollback for one week.
7. After a stable week: disable GitHub Pages, delete `CNAME` and `_config.yml`, update `RECOVERY.md`.
8. Add a CI deploy job that deploys only from `main` with a scoped Cloudflare API token held as a GitHub secret. I need that token from you; I will never create or store one myself.

Risk to watch: the 4-hour edge cache on `catalog.js` and the `?v=` convention. Keep the same cache rules after cutover, or purge on deploy.
