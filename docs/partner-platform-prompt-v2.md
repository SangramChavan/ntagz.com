# Ntagz Partner Platform: Prompt Validation and v2 Prompt

Part A checks the original "Master Development Prompt" against this repo. Part B is the improved prompt, ready to paste.

---

## Part A: Validation report

### Verdict

The business intent is strong: clear partner tiers, no MLM, no guaranteed income, HQ control, server-verified payments and data isolation. As an engineering prompt it is unsafe as written. It describes a new build, but Ntagz already has a working Cloudflare and D1 system. Followed literally, an agent would duplicate tables, replace the stack and could break live checkout.

### Contradictions with the repo (with evidence)

| # | Prompt says | Repo shows | Risk |
|---|---|---|---|
| 1 | Hosting on Cloudflare Pages | `CNAME`, `_config.yml`, and `admin/README.md` ("public site stays on GitHub Pages"). `wrangler.toml` also has `pages_build_output_dir`, so the current host needs checking | Wrong deploy plan |
| 2 | Preact + TypeScript + Tailwind monorepo | Vanilla HTML/JS/CSS, CommonJS `package.json`, no build step beyond `scripts/build-static.sh` | A rewrite breaks the "don't break existing functionality" rule |
| 3 | Payments: Razorpay or Cashfree | `wrangler.payment.toml` uses PayU **and** Razorpay (`PAYU_KEY`, `RAZORPAY_KEY_*`) | PayU could be dropped |
| 4 | "Create at least" about 60 tables | About 45 tables already exist in `db/schema.sql`, `db/membership-schema.sql` and `admin/migrations/0001–0020` | Parallel duplicate tables |
| 5 | One mobile-OTP identity | `users.email` is `UNIQUE NOT NULL` and `phone` is nullable. Customer auth uses `otp_tokens`/`sessions`, while admin auth is separate (`admin_otps`, `admin_sessions`) | Needs a real data migration, not a fresh table |
| 6 | Separate `auth.` and `api.` subdomains | Live API is `ntagz.com/api/*` (Worker `ntagz-payments`), and admin is its own Worker at `admin.ntagz.com` | CORS and cross-subdomain cookie work, and it breaks existing clients |
| 7 | Nothing listed to preserve | Membership, loyalty tiers and points, CRM (segments, campaigns, journeys), international checkout and quotes, pay links, preorders, custom review stand, fulfilment and tracking, payment alerts, NFC programmer (`programmer.html`), assistant (`functions/api/assistant.js`) | Silent feature loss |

**Duplicate table names to map, not recreate:**

| Prompt table | Existing table |
|---|---|
| `user_sessions` | `sessions` |
| `otp_verifications` | `otp_tokens` |
| `audit_logs` | `audit_log` |
| `refunds` | `order_refunds` |
| `stock_movements` | `inventory_movements` |
| `user_addresses`, `customer_addresses` | `addresses` |
| `notifications`, `shipments`, `products`, `orders`, `payments`, `inventory` | Same names already exist |

**Pre-existing defect the prompt should surface:** migration numbers are duplicated (`0012_notifications`/`0012_rewards`, `0017_*` ×2, `0018_*` ×2). Before adding migrations, confirm what D1 has actually applied (`d1_migrations` table).

### Structural problems in the prompt itself

1. **No approval checkpoint.** The "First Task" asks for every diagram and then says "begin Phase 1" without stopping for review.
2. **No guardrails on irreversible actions.** Nothing forbids remote D1 migrations, deploys, DNS changes or commits to `main`. The repo is on `main` with untracked files.
3. **Internal tension.** It asks for a "modular monolith" but also eight subdomains with separate apps. One API Worker plus thin frontends is the monolith, so the prompt should say so.
4. **Lists instead of acceptance criteria.** Phases name features but never say when a phase is done. "Run tests" doesn't name any tests (`npm test` currently fails by design; the real gates are the `npm run test:*` scripts and `.github/workflows/ci.yml`).
5. **Mixes HQ business decisions with build instructions.** Fees, commission rates and territory rules are rightly configurable, but the prompt never lists the decisions only the owner can make (GST treatment of joining fees, refund policy on fees, commission release window, KYC retention).
6. **Missing Indian compliance items.** It doesn't mention the DPDP Act 2023 (consent, purpose limitation, deletion, breach notice), PAN/Aadhaar handling (masking, encrypted storage, private R2 bucket), GST e-invoicing thresholds, or TDS on commission payouts (Sec 194H).
7. **Brand and legal risk.** The tiers are modelled on DTDC. Check whether any tier names (for example "Smile") match DTDC's own program names, and have a lawyer review franchise agreements and fee refund terms.
8. **Missing integrations not called out.** These don't exist yet: an SMS OTP provider (only Resend email OTP exists), WhatsApp Business API, courier tracking APIs, and Cashfree if wanted.
9. **Scale assumption.** 500 partners is small for D1, so performance isn't the risk. D1 has no multi-statement transactions across requests, so "transaction-safe" must mean `batch()` plus idempotency keys. The prompt should say that.

### Current system health (local test run, 2026-11-08)

| Suite | Result | What it means |
|---|---|---|
| `test:payment`, `test:stage2` (the CI gate) | Pass | Checkout recording and tracking checks are fine |
| `test:programmer-hardening`, `test:links`, `test:pricing`, `test:live-price` | Pass | |
| `npm audit --audit-level=high` | 0 vulnerabilities | |
| `test:seo` | Fail (66 errors) | **All 66 come from the stray `.worktree-*` folders.** The scanner doesn't skip them. Real site errors: 0 |
| `test:schema` | Fail (10 errors, 23 warnings) | **Real.** Product JSON-LD on `index.html` lacks `image` or `offers` (NFC Business Cards, RFID Tags, NFC Coins, Sample Kit, UHF label). `product/google-review-nfc-card-with-qr/` has no Product JSON-LD |
| `test:cutline` | Fail | **Broken test.** It requires `cutline/nest.js`, which isn't in the repo |
| `admin/test/run-all.sh` | Not run | Needs `wrangler dev` with local D1. Run it in Phase 0 |

CI only runs `test:payment` and `test:stage2`, so the schema and SEO regressions above don't block merges.

### Scorecard for this v2 prompt

| Area | Score | Why not 10 |
|---|---|---|
| Grounded in the real repo | 9 | Hosting and the remote migration state are still unverified (Phase 0 confirms them) |
| Safety guardrails | 9.5 | — |
| Business scope | 9 | Now covers partner offboarding, payout KYC and B2B partner invoices. Fee GST treatment and refund policy are owner decisions |
| Measurable quality bar | 9 | Section 14 adds performance, accessibility, reliability and observability targets. These need real traffic to confirm |
| Testability | 9 | Phase 1 now has to make the baseline green and widen CI |
| **Overall** | **9 / 10** | The last point can't be earned on paper. It comes from running Phase 0 and closing the open decisions |

### What to keep unchanged

The partner tiers, the no-MLM and no-income-guarantee rules, HQ control, immutable price snapshots, separate payment/refund/settlement records, commission release only after payment clears, strict partner data isolation, no fake metrics, the noindex rule for private apps, and the visual direction.

---

## Part B: Improved prompt (v2)

> Paste everything below this line.

---

# Ntagz National Partner Platform: Build Brief v2

## 1. Role and goal

Act as the lead engineer and architect for Ntagz (ntagz.com), an NFC and QR products company in Pune. Extend the **existing** Ntagz system into a commerce and channel-partner platform that can run 500+ partners across India. The partner model is inspired by courier franchise networks, but it is not affiliated with any of them.

This is a **brownfield** project. A live store, checkout, admin panel and D1 database already exist and earn revenue. Preserving them takes priority over every new feature.

## 2. Ground rules (non-negotiable)

1. **Inspect before you design.** The repo is the source of truth. Where this brief and the repo disagree, report the conflict and ask. Don't silently follow either one.
2. **No irreversible actions without my explicit "yes" in chat:** remote D1 migrations, `wrangler deploy`, secret changes, DNS or route changes, pushes to `main`, or deleting any file or table.
3. **Work on a feature branch.** One PR per phase. Never commit to `main`.
4. **Additive schema only.** New migrations go in `admin/migrations/` with the next free number. Reuse existing tables. Never create a table that duplicates one that exists. Renaming or reshaping a live table needs a written migration plan that I approve.
5. **Keep existing endpoints working.** `ntagz.com/api/*` and `admin.ntagz.com` must keep their current behaviour and pass their existing tests after every change.
6. **Security baseline.** Check permissions on the server for every request. No secrets in frontend code or in git. Verify webhook signatures and use idempotency keys. Payment success only comes from server-side verification. Every financial or permission change goes to the audit log.
7. **Honesty.** No fake data shown as live metrics. No placeholder buttons that do nothing. Report test failures with their output.
8. **Business rules.** No MLM or recruitment commissions, and no income guarantees in UI or copy. All fees, taxes, commissions and eligibility are configurable by HQ.

## 3. Current system (verify, then build on it)

- **Public site:** static HTML/JS/CSS, apparently on GitHub Pages (`CNAME`). Confirm the actual host.
- **Public API:** Worker `ntagz-payments` on `ntagz.com/api/*` (`functions/`, `wrangler.payment.toml`). Payments run through PayU and Razorpay. Customer email OTP uses Resend.
- **Admin:** Worker `ntagz-admin` at `admin.ntagz.com` (`admin/`), with its own admin OTP and sessions, CRM, fulfilment, pricing and cron jobs.
- **Database:** one D1 database `ntagz-db`, with schema in `db/*.sql` and `admin/migrations/0001–0020`.
- **Features to preserve:** cart and checkout, PayU/Razorpay, membership and member pricing, loyalty tiers and points, CRM (segments, campaigns, journeys, consent log), international checkout and quotes, pay links, preorders, custom review stand, fulfilment, shipments and tracking, payment alerts, NFC programmer, assistant, SEO pages and sitemap.
- **Tests:** the `npm run test:*` scripts, `admin/test/`, and `.github/workflows/ci.yml`.

## 4. Target architecture

- **Modular monolith:** one API codebase with domain modules (identity, catalogue, orders, partners, CRM, commissions, services, support). Deploy as few Workers as possible. Extend `ntagz-payments` and `ntagz-admin`, or propose a merge, rather than adding many new Workers.
- **Stack for new apps** (partner portal, customer account v2): Preact + TypeScript + Tailwind is preferred. The public site and existing admin stay vanilla unless I approve a migration. Public product pages stay static or prerendered for SEO.
- **Storage:** D1 for relational data, R2 for files (KYC documents in a **private** bucket with signed URLs, public assets via `cdn.ntagz.com`), and KV only for cache and rate limits.
- **Subdomain plan:** the `ntagz.com` DNS zone is on Cloudflare. Confirm this in Phase 0.

  | Domain | Serves | Cloudflare resource | DNS / route | Indexed | Phase | Status |
  |---|---|---|---|---|---|---|
  | `ntagz.com`, `www.ntagz.com` | Public store, product, SEO and content pages | Current static host (verify: GitHub Pages) | Keep the existing records. `www` redirects to the apex, or the reverse; pick one canonical host | Yes | n/a | Live, must not break |
  | `ntagz.com/api/*` | Public API: checkout, payments, OTP, pricing, tracking | Worker `ntagz-payments` | Existing Worker routes | No | n/a | Live, must not break |
  | `admin.ntagz.com` | HQ admin | Worker `ntagz-admin` (+ assets) | Existing custom domain | No (`noindex` and `Disallow`) | 5 | Live, extend it |
  | `account.ntagz.com` | Customer portal | New Worker with static assets, or a route on an existing Worker | Custom domain | No | 2 | New. `ntagz.com/account/` 301-redirects here once it's live |
  | `partner.ntagz.com` | Partner portal. `/apply` is public | New Worker with static assets | Custom domain | Only `/apply` and the partner landing page | 4 | New |
  | `cdn.ntagz.com` | Public images and marketing assets | R2 public bucket | R2 custom domain | Images only | 1 | New |
  | `docs.ntagz.com` | Partner training and manuals | Static assets | Custom domain | Public manuals yes, partner-only content no | 7 | Optional |
  | `auth.ntagz.com`, `api.ntagz.com` | Central auth and API | — | — | No | — | **Not by default.** Propose them only if they clearly beat path-based APIs, with the CORS and cookie cost spelled out |

  **Rules for the subdomain plan:**
  - **One API codebase.** Each app calls its own host's `/api/*`, routed to the shared API Worker. That keeps requests same-origin and avoids CORS. If a cross-origin call is unavoidable, use an explicit origin allowlist (never `*`) with credentials.
  - **Sessions:**
    - The customer and partner session cookie is `Domain=.ntagz.com; Secure; HttpOnly; SameSite=Lax`, so one login works across `ntagz.com`, `account.` and `partner.`.
    - **Admin keeps a separate host-only `__Host-` cookie** and requires MFA. A stolen customer cookie must never reach admin.
    - Logout revokes the server-side session, so it applies on every subdomain.
  - **CSRF:** require a token or Origin check on every state-changing request, on every host.
  - **TLS:** Universal SSL covers only one subdomain level (`*.ntagz.com`). Name staging hosts `partner-staging.ntagz.com`, not `staging.partner.ntagz.com`, or budget for an Advanced Certificate.
  - **Environments:** local (`wrangler dev`, local D1), staging (`*-staging.ntagz.com` with a separate D1 database and test-mode payment keys), and production. Staging is never indexed and sits behind Cloudflare Access.
  - **SEO:** each host serves its own `robots.txt`. Only `ntagz.com` (plus `partner.ntagz.com/apply` and public docs) appears in sitemaps. Private apps send `X-Robots-Tag: noindex`.
  - **Security headers on every host:** HSTS, CSP, `frame-ancestors 'none'` on the admin and portals, and `Referrer-Policy`.
  - **DNS changes need my "yes"** (ground rule 2). The agent writes the exact records and routes for me to approve.
- **D1 consistency:** use `db.batch()` for multi-row writes, idempotency keys on payment, order and commission writes, and unique constraints to block double attribution.

## 5. Identity and roles

- One user record per person. A customer who becomes a partner keeps the same user ID and gains a role.
- Login by mobile OTP (new: needs an SMS provider) and by email OTP (exists). Passwords are optional.
- **Migration decision required:** `users.email` is currently `NOT NULL UNIQUE`. Propose how phone-only users and the separate admin auth tables fold into one identity, with a backfill plan and no lost sessions.
- Roles: Customer, the five partner roles, HQ Admin, Operations, Finance, Inventory, Support, Regional Manager. A user can hold several roles. Permissions are data (`roles`, `permissions`, `role_permissions`).
- HttpOnly, Secure, SameSite cookies, CSRF tokens on state-changing requests, rotating refresh tokens, session expiry, logout across subdomains, rate-limited OTP, a login-attempt log, account suspension, and **MFA required for all HQ roles**.

## 6. Partner model

| Tier | Proposed fee (configurable) | Core scope |
|---|---|---|
| Ntagz360 | ₹99,999 | Branded outlet: retail, demos, local B2B, staff accounts, local resellers, outlet inventory |
| Enterprise | ₹49,999 | Corporate accounts, bulk quotations, custom projects |
| Flex | ₹24,999 | Independent reseller: wholesale ordering, referrals, leads |
| Smile | ₹19,999 | Technical service: NFC programming, QR setup, installations |
| Smile+ | ₹9,999 | Field associate: assigned leads, visits, demos |

Before building, check that no tier name conflicts with another company's trademarked program names, and flag any match to me.

**Application flow** at `partner.ntagz.com/apply`: a multi-step form that saves a draft. It collects identity, business, KYC (PAN; never store full Aadhaar), location and PIN, preferred tier, capacity questions and documents.

Statuses: Draft → Submitted → Under Review → (Documents Required) → Approved / Rejected → Agreement Pending → Payment Pending → Onboarding → Active. Suspended can be applied at any point.

The Partner ID is issued on approval. Access unlocks only at Active.

**Partner lifecycle beyond activation:**
- **Payout KYC:** verify the partner's bank account (penny-drop or the gateway's verification API) before the first settlement.
- **Partner as buyer:** wholesale orders use the partner's GSTIN and produce B2B tax invoices, so the partner can claim input tax credit. Credit limits are off by default.
- **Renewal:** handle renewal or annual fee if HQ enables it, and the agreement expiry date.
- **Offboarding:** suspension or termination freezes access. Open leads and customers are reassigned by HQ. Pending commissions are settled or reversed by rule. Partner documents follow the retention policy.

**Partner dashboard:** shared modules, plus tier-gated modules driven by permissions, never by frontend checks. A partner sees only their own leads, customers, orders, commissions and documents. Test this with cross-tenant access tests.

## 7. Commerce, fulfilment and commissions

- Guests can browse and build a cart. At checkout: phone OTP, address, optional GSTIN, shipping and tax calculation, and payment. The order then links to an existing user or creates a new one.
- Order items store **immutable price and tax snapshots**.
- Order statuses: Pending Payment, Paid, Processing, Awaiting Customisation, Production, Quality Check, Packed, Shipped, Delivered, Cancelled, Refunded, Returned. Every transition is written to `order_events`, which exists today. Partners can never change payment or fulfilment status.
- Lead → quotation → customer approval → payment → order → fulfilment → commission.
- **Commission engine:** rules are configurable by type (resale margin, qualified sale, lead conversion, installation, NFC setup, subscription referral, enterprise project), by tier, and by product category. Each rule sets percent or fixed amount, conditions and a release delay.
  - Commission statuses: Pending → Approved → Payable → Paid, with Reversed and Disputed as exceptions.
  - Release only after the payment clears and the refund window has closed.
  - A unique constraint on (order, earning type) prevents double attribution.
  - Payments, refunds, commissions, adjustments and settlements are separate ledgers. Settlements record TDS where it applies.
- **Inventory:** one central warehouse, using the existing `inventory_movements`. The schema allows regional warehouses (Pune, Delhi NCR, Bengaluru, Kolkata), but allocation stays off until HQ enables it.
- **Territories:** state, city and PIN mapping. Multiple partners per city are allowed. Lead ownership, conflict alerts and HQ-configured protection rules. No automatic permanent exclusivity.

## 8. HQ admin

Extend the existing admin. Don't rebuild it. Add Partners, Applications, Territories, Price Lists and Partner Prices, Quotations, Leads, Commissions, Settlements, Service Jobs, Support, Training, Staff and Roles, and Reports. Every sensitive action requires an audit-log entry. Exports are CSV and permission-checked.

## 9. Compliance and privacy (India)

- Follow the DPDP Act 2023: consent records (extend `consent_log`), purpose-limited data use, data export and deletion workflows, and a breach response runbook.
- KYC documents go in a private R2 bucket, PAN is masked in the UI, and every document access is logged.
- GST-compliant invoices. Flag where e-invoicing or the GST treatment of partner fees needs my accountant's input.
- Partner agreements and fee refund terms need legal review. Generate templates, not final contracts.

## 10. UI direction

Simple, Swiss-influenced, enterprise-usable and mobile-first. Palette: `#1F1C20` dark, `#FF6A21` accent (used only for primary actions and status), `#FFFFFF`, `#F4F6F8`. Avoid gradients, glassmorphism, oversized cards and decorative charts. Empty states should say "no data yet", never show sample numbers. Authenticated apps are `noindex`. Public pages have unique titles and meta, canonical URLs, Open Graph tags, one H1, and Product, Organisation and Breadcrumb JSON-LD, plus sitemap entries.

## 11. Integrations and credentials I must supply

List each with its status (exists, missing or needs a decision). The env var names go in `.dev.vars.example`. The values never go in chat or git.

- Exist: PayU, Razorpay, Resend.
- Missing: SMS OTP provider, WhatsApp Business API, courier tracking API(s).
- Needs a decision: Cashfree, GST invoicing tool.

## 12. Phases and exit criteria

Each phase follows the same loop: plan → build → test → fix → document → regression-check → PR. A phase isn't done until it also meets the quality bar in section 14. **Stop after each phase for my review.**

| Phase | Scope | Done when |
|---|---|---|
| 0 | Inspection only (section 13) | I approve the report |
| 1 | Foundations: branch, migration numbering fix plan, roles/permissions schema, environment config, **baseline repair** (SEO scanner skips `.worktree-*`; fix the 10 Product JSON-LD errors; fix or remove the broken `test:cutline`), and add `test:seo`, `test:schema`, `test:pricing`, `test:links` and the admin suite to CI | Every test script and the widened CI pass, and migrations apply cleanly to **local** D1 |
| 2 | Unified identity: phone OTP, roles, MFA for HQ, customer account v2 | Existing customers and admins can still log in, and RBAC tests pass |
| 3 | Commerce upgrades: snapshots, order events, quotations | Existing checkout passes all payment tests |
| 4 | Partner apply → approve → activate, five tiers, partner dashboard | Cross-partner isolation tests pass |
| 5 | HQ admin modules, CRM/leads, partner pricing, inventory | Every sensitive action is audited, with tests |
| 6 | Commission engine, settlements, territories, service jobs | Ledger reconciliation tests pass, and there's no double attribution |
| 7 | WhatsApp, courier, SMS, reports, security review, production rollout plan | I have a rollback-tested deployment guide |

## 13. First task (Phase 0): inspect and report, write no code

Produce one Markdown report on a feature branch containing:

1. **Inventory:** current hosting, Workers, routes, D1 tables (including which migrations are actually applied remotely, read-only check), tests, and every feature from section 3, each with its file paths.
2. **Table mapping:** every table this brief needs → the existing table it maps to, or "new". Include proposed new columns.
3. **Conflicts and decisions:** each place where this brief and the repo disagree, with your recommendation. At minimum cover hosting, identity (email NOT NULL), stack for new apps, API subdomains and the duplicate migration numbers.
4. **Diagrams (Mermaid):** system architecture, ER diagram (existing tables plus new ones), and request and auth flow across subdomains.
5. **Role-permission matrix:** roles × permissions as a table.
6. **Deployment plan:** confirm or correct the subdomain table in section 4 against the live Cloudflare zone (read-only). Give the exact DNS records, Worker routes and custom domains, cookie scopes, and secrets per environment (local, staging, production).
7. **Credentials list** from section 11.
8. **Phase 1 checklist** with estimates and risks.

Then **stop** and wait for my approval. Don't start Phase 1.

## 14. Quality bar (every phase must meet it)

| Area | Target |
|---|---|
| Public page speed | Mobile Lighthouse Performance ≥ 90. LCP < 2.5 s, INP < 200 ms, CLS < 0.1 on 4G. No public page ships more than 100 KB of JS |
| Portal speed | Dashboard interactive < 3 s on mid-range Android over 4G. API p95 < 300 ms for reads and < 800 ms for writes, measured at the Worker |
| Accessibility | WCAG 2.2 AA: keyboard navigation, visible focus, 4.5:1 contrast, labelled inputs, touch targets ≥ 44 px |
| Mobile | Every flow, including apply, checkout and partner orders, works at 360 px width with no horizontal scroll |
| Reliability | Payment webhooks are idempotent and retried with backoff. Failed notifications are queued and retried, never lost silently. Errors return generic messages and never leak SQL or stack details |
| Observability | Structured Worker logs with a request ID. Alerts for payment-verification failures, webhook signature failures, cron failures and 5xx spikes. A daily reconciliation report of gateway payments against orders |
| Backup and recovery | D1 Time Travel is the restore point (document the retention window). Weekly D1 export to a private R2 bucket. Restore tested on staging once per phase. R2 KYC bucket versioning on |
| Security testing | Run the security-audit checklist on each phase's diff. Automated tests cover: cross-partner access is denied, a partner can't change order or payment status, admin endpoints reject non-admin sessions, and no-MFA sessions can't reach admin |
| Testing | Unit tests for pricing, tax, commission and territory rules. Integration tests against local D1. Playwright end-to-end tests for checkout, apply-to-activate, and lead-to-commission |
| Data retention | Documented per table (OTP, sessions, login attempts, KYC, audit log), enforced by the existing cron |
| Cost | Stays within Workers Paid plan limits at 500 partners. Report expected monthly D1, R2, KV and Worker usage each phase |
