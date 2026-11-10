# Shared Contracts (v0.11, owned by the CTO agent)

Every agent follows this file. Changes need a CTO-agent review and an entry in the change log at the bottom.

## 1. Database contract

**Rules**
- Additive migrations only, in `admin/migrations/`, numbered from `0021`. One concern per file. No renames or drops of live columns.
- Money is integer paise. Timestamps are unix seconds (`INTEGER`), matching existing tables. IDs are `TEXT` UUIDs unless the table already uses another form.
- Every table has `created_at`. Mutable tables also have `updated_at`.
- Foreign keys declared. Index every FK and every `status` column used in a list view.
- Multi-statement writes use `DB.batch()`. Money-moving writes carry an idempotency key with a `UNIQUE` constraint.
- Code that reads a new column on the checkout path must feature-check it (the existing `pragma_table_info` pattern) or ship the migration first.
- Never create a second table for something that exists.

**Mapping: brief table → decision**

| Brief | Decision |
|---|---|
| users | **Reuse** `users`. Add columns: `status`, `phone_verified_at`, `last_login_at` |
| user_roles, roles, permissions, role_permissions | **New** |
| user_sessions | **Reuse** `sessions`. Add `last_seen_at`, `ip`, `ua`, `revoked_at`. New sessions store a hash of the token (existing rows stay readable until they expire) |
| otp_verifications | **Reuse** `otp_tokens` |
| login_attempts | **New** |
| user_addresses, customer_addresses | **Reuse** `addresses` |
| customers, customer_profiles, customer_preferences | **Not created.** `users` + `crm_customers` view + `marketing_contacts` + `consent_log` already cover this |
| admin sessions | **Reuse** `admin_otps`, `admin_sessions` until staff move to the unified identity (Phase 2) |
| audit_logs | **Reuse** `audit_log` |
| products, product_variants, product_images | **Reuse** `products`. Variants and images only if a real need appears |
| product_categories | **New** only if `products` lacks a usable category field (check in Phase 5) |
| price_lists, partner_prices | **New** |
| carts, cart_items | **Not created.** Cart is client-side (`ntagz_cart_v1`). Partner carts use the same mechanism |
| orders, order_items | **Reuse** `orders` (items live in `items_json`). Add `partner_id`, `lead_id`, `order_channel` (`web`/`partner`/`hq`), `price_snapshot_json` |
| payments, refunds | **Reuse** `payments`, `order_refunds` |
| invoices | **New** (`invoices`: number, order FK, GSTIN, totals, PDF key in R2) |
| shipments | **Reuse** `shipments`, `shipment_revisions`, `order_events` |
| warehouses | **New**, seeded with one row (Pune) |
| inventory, stock_movements | **Reuse** `products.stock`, `inventory_movements` |
| purchase_orders (+items) | **New**, P2 |
| partner_types | **New** (config rows: five types, fee, GST rate, flags) |
| partners, partner_applications, partner_documents, partner_agreements | **New** |
| partner_territories | **New** (with `territory_pincodes`) |
| partner_staff, partner_performance | **New**, P1/P2 |
| leads, lead_assignments, lead_activities | **New** (`leads`; `intl_enquiries` stays separate) |
| corporate_accounts | **New**, P1 |
| quotations, quotation_items | **New** (`intl_quotes` stays separate) |
| commission_rules, commissions, commission_adjustments, partner_wallets, settlements | **New**, P1 |
| service_jobs, installation_records, service_assignments | **New**, P1 |
| support_tickets, ticket_messages | **New** |
| notifications | **Reuse** `notifications` |
| system_settings | **New** |

Names to avoid: `campaigns`, `cart_campaigns`, `loyalty_tiers`, `crm_customers` (view), `intl_*`.

**Key relationships (new tables)**
```
users 1─* user_roles *─1 roles *─* permissions (via role_permissions)
users 1─0..1 partners 1─1 partner_applications 1─* partner_documents
partners *─1 partner_types
partners 1─* partner_agreements
partners 1─* partner_territories *─* pincodes
partners 1─* leads 1─* lead_activities
leads 1─* quotations 1─* quotation_items
leads 0..1─* orders ; orders *─0..1 partners   (attribution)
orders 1─* commissions *─1 commission_rules ; commissions UNIQUE(order_id, earning_type, partner_id)
partners 1─1 partner_wallets ; settlements 1─* commissions (via settlement_id)
partners 1─* service_jobs ; support_tickets 1─* ticket_messages
price_lists 1─* partner_prices *─1 products
```

## 2. Authentication contract

- One identity: `users.id`. A person who is a customer and a partner has one row and several `user_roles`.
- **Login:** `POST /api/auth/otp/send {email}` then `POST /api/auth/otp/verify {email, code}` on each portal host. Same OTP rules as today (6 digits, hashed, 10 min, 5 attempts, 3 codes per 15 min), plus a per-IP limit.
- **Session cookie per host:** `ntagz_session` on `ntagz.com` (unchanged). Partner portal uses `__Host-ntagz_partner` (Secure, HttpOnly, SameSite=Lax, Path=/, no Domain). Admin keeps `ntagz_admin`. All reference the same identity.
- Session lifetime: customer 7 days, partner 12 hours idle, staff 12 hours. Refresh-token rotation is Phase 2.
- **CSRF:** all state-changing requests need `X-Requested-With: ntagz` and an `Origin` that matches the host. A missing `Origin` on a mutating request is rejected on new endpoints.
- **Authorisation:** every handler calls `requirePermission(ctx, 'perm.key', resource?)` from `packages/platform-core`. Handlers never read roles directly. Frontend checks are cosmetic only.
- **Partner access gate:** a partner role is granted only when `partners.status = 'active'`. Suspending a partner revokes their sessions.
- **MFA (Phase 2):** TOTP, mandatory for every staff role.
- **Audit:** every role change, approval, price change, refund, commission and settlement action writes to `audit_log` with actor, action, entity, before/after.

## 3. Permission keys and role matrix

Format `module.action`. `own` means only records linked to the caller's `partner_id`.

| Permission | Customer | 360 | Ent. | Flex | Smile | Smile+ | HQ Admin | Ops | Finance | Inventory | Support | Regional |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| catalog.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| catalog.wholesale.read | | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ | ✓ | ✓ | | ✓ |
| orders.place.own | ✓ | ✓ | ✓ | ✓ | ✓ | | | | | | | |
| orders.read.own | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | | | | |
| orders.read.all | | | | | | | ✓ | ✓ | ✓ | ✓ | ✓ | region |
| orders.fulfil | | | | | | | ✓ | ✓ | | ✓ | | |
| orders.refund | | | | | | | ✓ | | ✓ | | | |
| partners.apply | ✓ | | | | | | | | | | | |
| partners.review | | | | | | | ✓ | ✓ | | | | region |
| partners.activate | | | | | | | ✓ | | | | | |
| partners.suspend | | | | | | | ✓ | ✓ | | | | |
| leads.manage.own | | ✓ | ✓ | ✓ | | ✓ | | | | | | |
| leads.read.all | | | | | | | ✓ | ✓ | | | | region |
| leads.assign | | | | | | | ✓ | ✓ | | | | region |
| quotes.create | | ✓ | ✓ | | | | ✓ | ✓ | | | | |
| quotes.approve | | | | | | | ✓ | ✓ | | | | |
| pricing.manage | | | | | | | ✓ | | ✓ | | | |
| inventory.manage | | ✓ (outlet) | | | | | ✓ | | | ✓ | | |
| commissions.read.own | | ✓ | ✓ | ✓ | ✓ | ✓ | | | | | | |
| commissions.approve | | | | | | | ✓ | | ✓ | | | |
| settlements.manage | | | | | | | ✓ | | ✓ | | | |
| service_jobs.manage.own | | | | | ✓ | ✓ | | | | | | |
| service_jobs.assign | | | | | | | ✓ | ✓ | | | | region |
| territories.manage | | | | | | | ✓ | | | | | region (view) |
| tickets.create | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | | | | |
| tickets.manage | | | | | | | ✓ | ✓ | | | ✓ | |
| staff.manage | | | | | | | ✓ | | | | | |
| settings.manage | | | | | | | ✓ | | | | | |
| audit.read | | | | | | | ✓ | | ✓ | | | |
| reports.read | | own | own | own | own | own | ✓ | ✓ | ✓ | ✓ | | region |

A staff member needs `settings.manage` or `staff.manage` before MFA is required to be switched off. Nobody gets that. Customers and partners never see another person's leads, orders, commissions or documents.

## 4. API contract

- Base: same host, `/api/v1/...` for new endpoints. Existing `/api/...` endpoints are untouched.
- JSON only. Request bodies validated against a schema in `packages/shared-types`.
- Success: `{ "ok": true, "data": ... }`. List responses add `"page": {"cursor": "...", "limit": 50}`.
- Error: `{ "ok": false, "error": { "code": "VALIDATION_FAILED", "message": "...", "fields": {"pincode": "must be 6 digits"}, "requestId": "..." } }`. Never include SQL, stack traces or secrets.
- Status codes: 400 validation, 401 not signed in, 403 forbidden, 404 not found (also used when a record belongs to someone else), 409 conflict or duplicate, 429 rate limited, 500 generic.
- Money in paise as integers. Dates as unix seconds.
- Mutations accept `Idempotency-Key` where money or stock moves.

**First endpoints (P0)**

| Method | Path | Permission |
|---|---|---|
| GET | /api/v1/me | signed in |
| POST | /api/v1/partner/applications | partners.apply |
| GET/PUT | /api/v1/partner/applications/mine | partners.apply |
| POST | /api/v1/partner/applications/mine/submit | partners.apply |
| POST | /api/v1/partner/documents (signed upload URL) | partners.apply |
| GET | /api/v1/partner/dashboard | partner role |
| GET | /api/v1/partner/catalog | catalog.wholesale.read |
| POST | /api/v1/partner/orders | orders.place.own |
| GET | /api/v1/partner/orders | orders.read.own |
| GET | /api/v1/admin/partner-applications | partners.review |
| POST | /api/v1/admin/partner-applications/:id/{approve,reject,request-documents} | partners.review / partners.activate |
| POST | /api/v1/admin/partners/:id/{activate,suspend} | partners.activate / partners.suspend |
| GET/PUT | /api/v1/admin/partner-types | settings.manage |

## 5. Partner application state machine

`draft → submitted → under_review ⇄ documents_required → approved → agreement_pending → payment_pending → onboarding → active`, with `rejected` from review, and `suspended` from `active`. Only HQ moves a record past `submitted`. The Partner ID (`NTZ-<type>-<nnnn>`) is issued at `approved`. Partner role is granted at `active`. Every transition writes a row to `audit_log`.

## 6. Design tokens (partner portal and new apps)

`--ink #1F1C20`, `--accent #FF6A21`, `--paper #FFFFFF`, `--surface #F4F6F8`, plus semantic success, warning and danger colours (to be fixed with contrast checks in the design system). Base 4 px spacing. Radius 6 px. System font stack first. Touch targets 44 px. No gradients.

## Change log
- v0.9 (quote to payment; migration 0027): `quotations.pay_link_id` (nullable). `POST /api/v1/admin/quotes/:id/payment-link` (admin Worker only, HQ/Operations; body `{address, pincode, state?, gstin?, expiresInHours?}`) works only for an **accepted** quotation and reuses the pay-links `create` (so its validation, pricing check and audit apply). Lines, customer name/phone/email and state come from the quotation; the link note is the quotation number; `pay_links.quoted_paise` is set to the **quotation total** so the customer's page says if prices moved (the payments Worker still prices and collects, so checkout stays the authority). One open link at a time (cancelled/expired ones can be replaced); a paid quotation gets no further link. `GET /api/v1/admin/quotes/:id` now includes `payLink` `{id, url, status: new|sent|opened|expired|cancelled|paid, expiresAt, quotedPaise, paidOrderId, paidTotalPaise}`; the partner view never includes it. Payment does not win the lead: HQ confirms with `POST /api/v1/admin/leads/:id/status {status:'won', orderId}`. `PAY_BASE` in quotes.js must equal `BASE` in admin/src/paylinks.js (a test enforces).
- v0.8 (quotations; migration 0026; `OTP_IP_LIMIT`): tables `quotations`, `quotation_items`. **Price = `functions/lib/pricing.js` `priceCart` with guest pricing** (the engine checkout and the admin preview use), so a quote equals what checkout would charge; there is no manual price or discount. Totals and every line are an **immutable snapshot** taken on save; editing (draft or rejected only) re-prices and replaces them. Number `Q-<year>-<nnnn>`. Status machine: `draft -> pending_approval -> approved | rejected`; `rejected -> draft` (revise); `approved -> sent -> accepted | declined`; `approved|sent -> expired` by `valid_until` (lazy); `draft|pending_approval|rejected|approved -> cancelled`. Validity 1-60 days (default 15). Rights: partner `quotes.create` (360, Enterprise; own scope; own open lead only), HQ/Operations `quotes.approve` (scope all). Drafts are private to the partner. Approval moves the lead to `quotation` and notes it on the lead; accepting does not win the lead (HQ marks won with an order). Emails: `quotation_submitted` (HQ inbox), `quotation_approved`, `quotation_rejected`. Routes: `/api/v1/partner/quote-products`, `/quote-price`, `/quotes[/:id[/items|/submit|/cancel|/sent|/response]]`, `/api/v1/admin/quotes[/:id[/approve|/reject|/response]]`. `OTP_IP_LIMIT` (optional var) sets sign-in codes per IP per 15 min; default 10.
- v0.7 (leads; migration 0025): tables `leads`, `lead_activities`. Statuses `new, contacted, qualified, quotation, won, lost` (`quotation` reserved for the quotations module because SQLite cannot alter a CHECK later). **One open lead per phone across the network** (partial unique index); a second partner is refused with a generic message and the attempt is written to `audit_log` as `lead.conflict` (last 4 digits only). Partners see and change only their own leads (`partner_id` in every WHERE; another partner's id is 404), move `new → contacted → qualified` or to `lost` (reason required), and can **never** set `quotation` or `won`. HQ (`leads.read.all` + `leads.assign`, scope `all`; Regional fails closed) can list, open, add notes, reassign to an **active** partner, move to `contacted/qualified/quotation`, mark `won` only with an existing `orders.id` (unique: one order credits one lead) or `lost` with a reason. Partner view never exposes `orderId`, `partnerId` or HQ admin emails (HQ notes show as "Ntagz"). Routes: `/api/v1/partner/leads[/:id[/activity|/status]]`, `/api/v1/admin/leads[/:id[/assign|/status|/note]]`, `/api/v1/admin/active-partners`.
- v0.6 (emails; migration 0024): `email_outbox` (unique `dedupe_key`, status `pending|sending|sent|failed|skipped`, attempts, backoff). A row is queued in the same `db.batch()` as the change that causes it, so a change and its email commit together or not at all. Dedupe key = `template:record:revision` where revision is the record's audit-log count (race-safe; `updated_at` has only 1-second resolution). Sent after the response (`waitUntil`) and retried by the admin cron every 15 minutes; an email failure never fails or rolls back the action. Templates: `application_received`, `documents_requested`, `application_approved`, `application_rejected`, `partner_activated`, `partner_suspended`, `partner_reinstated`, `hq_new_application`. Agreement and fee recording send nothing. Provider call uses an `Idempotency-Key` equal to the outbox id. No ID numbers or secrets are stored in the outbox.
- v0.5 (HQ Partners screen): `GET /api/v1/admin/partner-applications` accepts `stage` (`new|review|docs|onboarding|active|suspended|rejected`, fixed map, unknown values ignored) and `q` (business, city, Partner ID, email; LIKE wildcards escaped), and returns `counts` per stage that ignore filters. Rows include `partnerCode`, `partnerStatus`, `email`. Detail returns `partner` (status, fee due, agreement, fee payments), applicant `email`, and `history` (applicant actions are labelled `Applicant`). New error code `UNAVAILABLE` (503) when document storage is not bound. PDFs are served as downloads, images inline, both with a sandbox CSP. Fee errors are written in rupees.
- v0.4: `GET /api/v1/partner/applications/mine` also returns `partner: { partnerCode, status } | null` (the caller's own partner record from approval on), so the portal can show the onboarding stage before access is active.
- v0.1 initial.
- v0.3 (apply/approval API implemented; migration 0023):
  - **Approving** an application needs `partners.activate` (HQ only). Operations and Regional can start review, request documents and reject, but cannot approve.
  - Approval creates the `partners` row (Partner ID `NTZ-<TYPE>-<nnnn>`, status `agreement_pending`) and a pending agreement, and grants **no** access. Order is fixed: `agreement_pending → payment_pending → onboarding → active`.
  - Joining fees go in their own table `partner_fee_payments` (unique reference). Amount must be at least the type's `fee_paise`. HQ records agreement and payment for now.
  - Partner role is granted only by `activate`, and revoked access comes from suspending the partner (sessions with `portal='partner'` are revoked at once) or the user.
  - Partner-portal sessions: cookie `__Host-ntagz_partner`, 12 h, `sessions.id` = SHA-256 of the token, `portal='partner'`. Login: `POST /api/v1/auth/otp/send|verify`, `POST /api/v1/auth/logout`.
  - Documents are uploaded **through the Worker** (`POST /api/v1/partner/documents`, body = file, header `X-Doc-Type`), max 5 MB, PDF/PNG/JPEG decided by file bytes, stored in a private bucket under random keys. HQ opens them via `/api/v1/admin/partner-documents/:id` (no-store, sandboxed, audited).
  - Mutating requests need `X-Requested-With: ntagz` **and** a matching `Origin` (missing Origin is rejected).
  - Admin routes live under `/api/v1/admin/` inside the admin Worker, behind its existing session and CSRF checks; the allowlist maps to `hq_admin` until staff roles move to the unified identity.
- v0.2 (migrations 0021/0022 implemented):
  - Added permission `territories.read` (HQ, Operations, Regional=region). `territories.manage` stays HQ only. This makes "Regional: view" in the matrix explicit.
  - `audit_log` gains nullable `entity_type`, `entity_id` (order rows keep `order_id`). New code writes through `auditStmt` in `packages/platform-core`.
  - `users` gains `status` (NULL means active), `phone_verified_at`, `last_login_at`.
  - Partner applications store **no raw PAN**: `pan_last4` plus `pan_hash` (HMAC with a Worker secret) for duplicate detection. The document image sits in the private R2 bucket.
  - `partner_types.gst_rate_bp` is NULL until the owner decides GST treatment of joining fees (O5). Nothing is guessed.
  - One open application per person is enforced by a partial unique index. A rejected one can be followed by a new one.
  - Partner roles grant nothing until `partners.status = 'active'`. Suspending a user or partner removes access on the next request.
  - Scope semantics: handlers receive `all`, `region` or `own` from `requirePermission` and must apply it with `scopeClause` in the SQL WHERE.
- v0.10 (migration 0028 commissions):
  - New tables `system_settings`, `commission_rules`, `commissions`, `commission_adjustments`, `settlements`. All money is integer paise. **Nothing is seeded**: with no active rule, winning a lead creates no commission, and with no TDS rate no TDS is withheld.
  - Only one earning type exists: `lead_conversion` (a partner's own lead, won with a paid order). The database refuses any other type, so recruitment/downline commission cannot be created.
  - Base is the order's `qualifying_paise` (ex-GST, after discounts). Amount = `floor(base x pct_bp / 10000) + fixed_paise`, capped by `max_paise`. The most specific active rule wins (partner type, then minimum order). The rule's terms are frozen onto the commission; editing a rule never changes existing commissions.
  - One commission per order (`UNIQUE(order_id, earning_type)`).
  - Lifecycle: `pending` -> (Finance/HQ approve) `approved` -> `payable` -> (settlement) `paid`; `reversed` and `disputed` are side states. A commission becomes `payable` only when its hold (default 30 days, per rule or setting, counted from the order date) has passed, the order is `paid`, and `refunded_paise = 0`. The pass runs on the 15-minute cron and on every read.
  - Refunds: `proportional` reduces the commission by the refunded share, `reverse_all` reverses it. Passes are relative to refund adjustments already applied, so manual corrections stand. A full refund always reverses. A refund after payout never edits the paid amount: the commission is flagged `disputed` (prior `paid`) for Finance.
  - Invariant: `amount_paise = original_amount_paise + SUM(commission_adjustments.delta_paise)`.
  - Settlements pay **every payable commission of one partner** atomically: total comes from the rows marked paid, TDS = `floor(total x rate / 10000)` from the setting, and the bank reference is unique. Ntagz records payouts; it does not move money.
  - Permissions: partners `commissions.read.own` (read and dispute only their own; another partner's is 404). Finance/HQ `commissions.approve` and `settlements.manage`. Rules and settings are HQ only (`settings.manage`). Operations has no access.
  - Routes: partner `GET /commissions`, `GET /commissions/:id`, `POST /commissions/:id/dispute`, `GET /settlements`. Admin `GET /commissions`, `GET /commissions/:id`, `POST /commissions/:id/{approve,reverse,adjust,resolve}`, `GET|POST /commission-rules`, `POST /commission-rules/:id`, `POST /commission-settings`, `GET /payables`, `GET|POST /settlements`.
- v0.11 (partner price lists, wholesale ordering, opening stock credit; migration 0030; **not applied to production, not deployed**):
  - **Price list.** One discount band per partner type (`partner_price_bands.discount_bp`, 0 to 9000) off the **ex-GST** retail price, and one HQ setting `system_settings.partner_min_margin_bp` (basis points of COST). Partner unit price = `max(retail x (1 - band), cost x (1 + margin))`, never above retail, rounded **up** to the paisa. If retail itself is under the floor the partner pays retail (limit `retail`). **Nothing is seeded**: no band, no margin and no cost is written by any migration, and a product with no `cost_paise`, a type with no band, or no margin has **no partner price** (refused, never guessed). The margin is its own setting; it is not `membership_config.min_margin_pct` (that guardrail is `cost / (1 - m)`).
  - **One engine.** Wholesale is `priceCart(items, { ..., partner: { discountBp, minMarginBp } })` in `functions/lib/pricing.js`. The band REPLACES bulk, member, loyalty, campaign and points discounts (nothing stacks; callers pass none). Wholesale lines are priced ex-GST with 18% GST and normal shipping added on top (an all-inclusive retail line is converted to its ex-GST price first). `partnerUnit` and `partnerPriceReport` are exported for HQ.
  - **Public bulk tiers (10/15/25% at 500/1000/5000 pieces).** Not stacked and not "lowest of both". HQ sees, per product and partner type, every tier where a retail customer pays at or below the partner price, and every tier below the partner floor (`GET /api/v1/admin/wholesale/config`). With COGS Rs 90 and a 20% margin the floor is Rs 108 ex-GST; the 5x5 stand (retail 102 ex-GST against a 108 floor) is retail-only and every public bulk tier sits under the floor.
  - **Who can order.** `orders.place.own` **and** the partner's own type role carries it (`wholesale.canOrder`; also returned as `wholesale` by `GET /api/v1/me`). The generic `customer` role also carries `orders.place.own` and anyone can hold it, so the permission alone is not a gate. Today 360, Enterprise, Flex and Smile can order; **Smile+ cannot** (it pays an opening stock order but has no ordering permission; open owner question, not granted here).
  - **Stock credit.** `partner_stock_credit` is an append-only ledger (`grant` / `consume`). A grant is created in the same batch as the `partner_fee_payments` row (amount received **minus recorded GST**, one per fee payment, `UNIQUE(fee_payment_id)`; migration 0030 back-fills existing payments). A consume is created with its order (`UNIQUE(order_id)`). Balance = `SUM(delta_paise)`. Credit reserved by an open pay link is **derived** (links with `credit_paise > 0`, active, unexpired, unpaid), so expiry and cancellation release it with no job: `available = balance - reserved`. Nothing is refunded in cash except a joining fee refunded by HQ (migration 0032, `refundFee`): full amount only, only while onboarding or suspended, and only if no stock credit was used or held; the fee's credit is reversed in the ledger and the partner can never be activated or reinstated afterwards. Credit is a **payment, not a discount**: the order, its GST and GSTIN carry the full value; credit appears as a `payments` row with method `stock_credit`, and `orders.stock_credit_paise`.
  - **Ordering.** `GET /api/v1/partner/wholesale/catalogue` (partner price only; cost and floor are never sent), `POST .../price`, `POST .../orders` (`{items:[{productId,qty}], address, pincode, state, phone, gstin?, useCredit?}`; address is required because partners have no street address on file), `GET .../orders`, `GET .../credit`, `POST .../orders/:linkId/cancel`. Credit covers all of it: the order is created immediately in one guarded batch (`orders.gateway = 'stock_credit'`, `txn_id = CRD-...`, stock deducted through the shared `functions/lib/stock.js`). Otherwise a pay link is created (`pay_links.partner_id`, `credit_paise`; the insert is conditional on the available balance, so two requests cannot reserve the same credit) and the existing pay page and Razorpay flow collect only the remainder (never under Rs 1). `pay_links.source` has a CHECK that cannot be widened additively, so a partner link is identified by `partner_id`.
  - **Payments Worker.** A link with `partner_id` is re-priced on every open and pay by the same engine for that partner's type (a viewer's member context is ignored; stale or missing band/margin/cost shows "can no longer be priced"), has no nudges or adjust, and its intent carries `partner_id`, `credit_paise`; the intent amount is the gateway remainder. Finalising creates the order at full value tagged `orders.partner_id` (never a customer `user_id`, so no loyalty or points), adds the `stock_credit` payment and the ledger consume, all keyed on the new order id so replays and races consume once.
  - **Invariant** (`wholesale.creditProblems`, run by the test and shown to HQ): balance never negative; grants = opening payments net of GST; every consume equals its order's `stock_credit_paise` and its `stock_credit` payment; every order showing stock credit has a consume. Known ceiling: a payment verified after its link expired consumes credit unconditionally (money was taken), so the balance could dip below zero in that race; the invariant check reports it.
  - **GST.** How GST on the opening stock order is treated (credit = amount net of recorded GST today, `gst_rate_bp` still unset) is an owner/accountant decision. There is no server-side invoice generator in this repository: a wholesale order carries the same fields as any order (`subtotal`, `gst`, `total`, `gstin`, `payments`), so whatever produces an order's GST invoice covers it.
  - **Admin** (`pricing.manage` for changes, `orders.read.all` for views): `GET /api/v1/admin/wholesale/config`, `POST .../bands` (`{partnerType, discountBp|null}`), `POST .../margin` (`{minMarginBp|null}`), `GET .../partners`, `GET .../partners/:id/orders`. Band and margin changes are audited. Another partner's data is 404.
  - Note for all D1 code: on `orders`, `meta.changes` includes the AFTER INSERT triggers' updates, so a guarded INSERT must be verified by reading the row, not by `changes === 1`.

