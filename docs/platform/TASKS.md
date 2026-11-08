# TASKS (shared status board)

Rule: an item is "Done" only when implemented **and** tested. Update this file in the same PR as the work.

Legend: ☐ not started · ◐ in progress · ✔ done and tested · ⛔ blocked (see Blockers)

## Stage 0: Inspection and contracts

| Item | Owner | Status |
|---|---|---|
| Repo inspection (backend, frontend, infra) | CTO | ✔ |
| Phase 0 report, decisions, open items | CTO | ✔ (needs owner review) |
| CONTRACTS.md v0.1 (DB, auth, roles, API, errors, tokens) | CTO | ✔ (needs owner review) |
| ARCHITECTURE.md v0.1 | CTO | ✔ |
| Owner answers to O1-O6 | Owner | ☐ |

## Stage 1: Foundation (can start after owner review)

| Item | Owner | Depends on | Status |
|---|---|---|---|
| PR #40 merged (test baseline) | Integration/QA | owner | ✔ merged |
| Remove `pages_build_output_dir` from root `wrangler.toml` | DevOps | none | ✔ (PR #42) |
| Repair `admin/test/products.mjs` (expects 17 products; migration 0017 made it 18) so `admin/test/run-all.sh` passes on main | DevOps | none | ☐ |
| Widen CI: seo, schema, pricing, links, site, admin suite | DevOps | repair above | ☐ |
| `packages/platform-core`: errors, validators, audit, `loadAccess`/`requirePermission`/`scopeClause` | Backend + Auth | contracts | ✔ (47 tests, `admin/stage2/test-platform-rbac.cjs`) |
| Migration 0021: roles, permissions, role_permissions, user_roles, login_attempts, users status columns, audit_log entity columns + seed | Backend | contracts | ✔ applied to the live D1 on 2026-11-08 |
| Migration 0022: partner_types (5 seeded), partners, partner_applications, partner_documents, partner_agreements | Backend | 0021 | ✔ applied to the live D1 on 2026-11-08 |
| Design tokens + base components in `packages/ui` | Design | contracts | ☐ |
| `ntagz-site` Worker config and staging deploy | DevOps | owner O2 | ✔ staging live at workers.dev; cutover needs owner go (`CUTOVER-PLAN.md`) |
| Staging D1 + test keys | DevOps | owner O2 | ⛔ |

## Stage 2: P0 build

| Item | Owner | Depends on | Status |
|---|---|---|---|
| Unified sessions and OTP hardening (per-IP limit, hashed session IDs, purge cron) | Auth | platform-core | ☐ |
| Partner apply API (OTP login, draft, documents, submit) | Backend | 0022 | ✔ live (API + portal at partner.ntagz.com) |
| Partner apply UI (6-step wizard, document upload, status timeline, dashboard, sign-in) in `apps/partner-portal` | Partner portal | API above | ✔ live at partner.ntagz.com (clicked through locally at phone and desktop width first) |
| HQ approval API (list, review, approve, reject, request docs, agreement, fee, activate, suspend, reinstate) | Backend | 0022, 0023 | ✔ live in the admin Worker under `/api/v1/admin/` |
| HQ **Partners** screen in the admin UI: queue with stage chips and counts, search, detail panel (applicant, documents, onboarding, history), start review / request documents / reject / approve / record agreement / record fee / activate / suspend / reinstate | HQ admin | API above | ✔ live in admin.ntagz.com (clicked through locally first) |
| Partner ID issue, agreement and activation gates | Backend | above | ✔ (agreement and fee are recorded by HQ; e-sign and gateway fee payment are later) |
| Partner login (email OTP, hashed sessions, per-IP limit) | Auth | platform-core | ✔ API (`/api/v1/auth/*` in `workers/partner`) |
| Partner dashboard: profile + tier-specific list of what the partnership covers (no dead buttons) | Partner portal | auth, partners | ✔ minimal. Real modules (leads, orders, earnings...) are later tasks |
| Wholesale catalogue and partner ordering via existing checkout | Backend + Partner portal | price_lists | ☐ |
| Customer account: invoices, order tracking inside account | Customer portal | invoices table | ☐ |
| Admin: `payment_alerts` screen | HQ admin | none | ☐ |
| Staff roles replace flat `ADMIN_EMAILS`; TOTP MFA | Auth + HQ admin | roles | ☐ |

## Follow-ups found while building the apply/approval API

| Item | Owner | Status |
|---|---|---|
| Emails: application received, documents requested, approved, rejected, activated, suspended, reinstated, plus HQ "new application" notice. Outbox table (0024), atomic with each change, deduped, retried by the admin cron. See `ENVIRONMENT.md` | Backend | ✔ tested with a mocked provider and on real local D1 + cron. **Not tested against real Resend**; needs a key and one real send |
| Customer `getSession` should ignore `portal='partner'` sessions (one-line change on the live checkout path; ship with column feature-check) | Auth | ☐ |
| Remove orphan R2 objects when a DB insert fails after upload (rare); scheduled cleanup | Backend | ☐ |
| Per-IP limit on OTP *verify* (send is limited; verify is limited per code) | Auth | ☐ |
| Regional Manager `region` scope for applications (needs a PIN-to-region map) | Backend | ☐ |
| E-sign for the partner agreement and gateway payment of the joining fee (today HQ records both) | Backend | ☐ owner O5 |
| Create **private** R2 bucket `ntagz-kyc`; set secrets `PAN_HASH_SECRET`, `RESEND_API_KEY` on `ntagz-partner` | DevOps | ✔ bucket created, `PAN_HASH_SECRET` set. ⛔ `RESEND_API_KEY` is the owner's to set (see LIVE.md) |
| Add the `KYC` R2 binding to `admin/wrangler.jsonc` with the bucket | DevOps | ✔ done and deployed |

## Portal follow-ups

| Item | Owner | Status |
|---|---|---|
| Public indexable landing page for partner categories and `/apply` (the app is `noindex`; a client-rendered SPA is a poor SEO page) | Partner portal | ☐ |
| Browser end-to-end tests in CI (Playwright): apply -> approve -> dashboard, documents loop, suspension lockout, wizard validation, 360 px phone | QA | ✔ `tests/e2e`, CI job `e2e`. Customer checkout and other admin screens are not covered |
| Accessibility audit with a screen reader and keyboard-only pass | Design | ☐ |
| Show "Applying as" fee GST wording once owner decides O5 | Partner portal | ⛔ O5 |

## Stage 3: P1

| Item | Owner | Status |
|---|---|---|
| **Leads**: partner registers prospects (one open lead per phone network-wide), works them (notes, calls, visits, contacted/qualified/lost), HQ sees all, reassigns, moves to quotation, marks won **with its order** or lost. Migration 0025, API, partner portal screens, admin Leads tab, 54 backend checks + 2 browser tests | Backend + Portal + HQ admin | ✔ **live** (migration 0025 applied, admin and partner redeployed 2026-11-08; see LIVE.md) |
| **Quotations**: partner (360/Enterprise) drafts a quote for an own open lead, priced by the **checkout engine** (guest pricing, quantity discounts, GST, shipping by state) and frozen as an immutable snapshot; submit; HQ/Operations approve or reject with a reason; approved -> sent -> customer accepted/declined; expiry by date; share text + WhatsApp link; emails to HQ and partner; lead moves to `quotation` on approval. Migration 0026, 54 backend checks, 2 browser tests | Backend + Portal + HQ admin | ✔ **live** (migration 0026 applied, admin and partner redeployed 2026-11-08; see LIVE.md) |
| **Accepted quotation -> payment link -> order -> lead won**: HQ creates a link from the accepted quote (lines, customer and state come from the quote; HQ adds the delivery address), reusing the existing pay-links tool so checkout stays the price authority; the link remembers the quoted total so the customer's page says if prices moved; the quote shows link status (new/sent/opened/paid); once paid, HQ marks the lead won with that order in one click. Migration 0027, admin-only route, 26 backend checks + browser test | Backend + HQ admin | ✔ **live** (migration 0027 applied, admin redeployed 2026-11-08). The "paid" step has only been tested with a simulated paid order; the first real payment through a link is the live proof |
| **Commissions**: rules set by HQ (percent and/or fixed of ex-GST order value, min/max, hold days, refund policy), commission created when HQ wins a lead with a paid order, approval, refund-aware release after the hold, disputes, manual adjustments with a ledger, atomic per-partner settlements with optional TDS, partner Earnings page, HQ Commissions tab. Migration 0028, 78 backend checks, 1 browser test | Backend + Portal + HQ admin | ◐ built, not yet merged or deployed. Owner decisions still open: release window, TDS rate, GST. No rules are seeded, so nothing is earned until HQ adds one |
| Quotation gaps that remain: no stock/availability check; HQ cannot create quotes (only approve); the customer answers through the partner/HQ (no customer-facing quote page); the partner does not see payment status; marking won is a manual confirmation | Backend | ☐ |
| **Partner price lists, wholesale ordering and opening-stock credit**: HQ sets a discount band per partner type and the minimum Ntagz margin (nothing seeded; no cost = no partner price), priced by `priceCart` partner mode; partners (360/Enterprise/Flex/Smile) order from a Wholesale page, paid by stock credit and/or the existing pay link; the opening stock order is a credit ledger with an invariant check; HQ Wholesale tab (bands, margin, per-product price and bulk-tier report, credit and orders per partner). Migration 0030, 47 backend checks, 1 browser test | Backend + Portal + HQ admin | ◐ built, not yet merged or deployed. Open owner decisions: the bands and margin, product costs (COGS Rs 90 is a test fixture only), Smile+ ordering permission, GST on the opening order. Inventory per partner is not built |
| Commission engine, settlements (will attach `partner_id`/`lead_id` to orders; won leads already carry the order) | Backend | ☐ |
| Territories (PIN-to-region map; also enables Regional Manager scope, which fails closed today) | Backend | ☐ |
| Service jobs, shipment tracking APIs | Backend | ☐ |

## Stage 4: P2

WhatsApp automation, advanced analytics, training management, regional warehouses, financial reports, partner staff, automation.

## End-to-end acceptance (all must pass automatically before launch)

| Workflow | Status |
|---|---|
| A Customer: browse → pay → account → tracking → invoice | ☐ (invoice and in-account tracking missing) |
| B Partner: apply → HQ approve → agreement → login → catalogue → leads/orders → earnings | ☐ |
| C HQ: applications, customers, products/prices, orders, inventory, fulfilment, commissions, reports | ☐ |
| D Attribution: lead → order → verified payment → commission → approval → settlement | ☐ |

## Blockers and owner decisions

O1 hosting confirmation and DNS cutover go · O2 Cloudflare access and staging approval · O3 SMS and WhatsApp providers · O4 storefront restyle approval · O5 commercial and legal decisions (**decided 2026-11-08: no refund policy for partner joining fees; no refund flow is built and the portal does not say "non-refundable", since that wording is the owner's/legal's call. Still open: GST on joining fees, commission release window, TDS, KYC retention**) · O6 trademark check. Details in `PHASE0-REPORT.md` section 6.

## Live state
See `LIVE.md`: partner platform deployed 2026-11-08 (migrations 0021-0024, admin redeploy, `partner.ntagz.com`). `ntagz.com` hosting is unchanged.

## Known limitations

Partner login, applications, HQ onboarding, portal and emails are live (see `LIVE.md`). Not yet built: leads, quotations, partner price lists, commissions, territories, service jobs, customer invoices, staff roles/MFA. `ntagz.com` is still on GitHub Pages. Email delivery to a real inbox is unconfirmed until the first real test. Per-step hosts and versions are in `LIVE.md`.
