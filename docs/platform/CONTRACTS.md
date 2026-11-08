# Shared Contracts (v0.1, owned by the CTO agent)

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
