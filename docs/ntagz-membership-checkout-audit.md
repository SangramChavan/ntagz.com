# Ntagz membership, checkout & rewards — audit

Branch `feat/membership-rewards`, audited 2026-10-12. Baseline: `npm run test:stage2` = 366 checks, all passing.
Items marked *(reported)* came from a read-only sub-agent and were not re-read by me; verify before relying on them.

## 1. Existing architecture
- Static storefront (GitHub Pages, `CNAME`; Cloudflare Pages path documented in `RECOVERY.md`). Cart = `localStorage['ntagz_cart_v1']` `{id: qty}` (`js/cart.js`), no server cart.
- Payments Worker `ntagz-payments`: `functions/api/[[path]].js` (routes `ntagz.com/api/*`), PayU + Razorpay, D1 `ntagz-db`.
- Admin Worker `ntagz-admin` (`admin/src/index.js`, `admin.ntagz.com`), same D1, cron every 15 min (CRM, expiry notices).
- Shared libs in `functions/lib/`: `pricing.js` (pure engine), `loyalty.js` (spend tiers), `points.js` (ledger), `crm*.js`.
- Migrations `admin/migrations/0001–0014` are additive; tests in `admin/stage2/*.cjs`.
- TapInHere: separate Cloudflare Pages project, **own D1/KV, own sessions, no shared identity** (details §10).

## 2. Reusable (already built — do not rebuild)
| Need | Exists |
|---|---|
| Single server-side price engine | `priceCart` — used by quote, Razorpay, PayU, offline orders, admin preview |
| Member price per product | `products.member_discount_pct`, guardrails: cap, min margin from `cost_paise` |
| Membership fee/duration config | `membership_config` (`fee_paise`, `duration_days`, `discounts_live`) |
| Membership purchase/renewal | `/api/membership/create-order|verify-payment` (Razorpay, idempotent on `razorpay_order_id`, renewal window) |
| Points ledger | append-only `points_ledger`, unique `idem_key`, `reconcileOrder` (refund/cancel safe), expiry sweep, reservation |
| Spend tiers | `loyalty_tiers`, spend **derived** from orders (net of refunds) + audited adjustments |
| Admin | rewards/points settings, milestones, tier editor, pricing preview + publish, customers/CRM, campaigns, audit log |
| Dashboard | `/account` + `/membership/` fetch settings from API (fee not hardcoded) |
| Quote with what-if member price | `POST /api/quote {compare:true}` returns guest vs member totals + fee |

## 3. Gaps and defects
Ranked.
1. **Membership cannot be bought inside checkout.** It is a separate Razorpay order on `/membership/`. Checkout (`order.js`) has no membership offer; `?membership=activated` is not handled *(reported)*. The honest with/without comparison exists only as an API (`compare`) and a calculator.
2. **Tier model differs from the product spec.** Seeded tiers are Silver ₹1,000 / Gold ₹3,000 / Platinum ₹10,000 giving **price discounts** (3/5/8%, off by default). Spec: Silver ₹5,000 / Gold ₹25,000 / Diamond ₹50,000 earning **points** at 3/5/10%. Points today are a flat `pts_earn_per_100 = 5` for any member regardless of tier.
3. **Legacy counter still written.** `finalizeOrder` updates `users.loyalty_spend` and sets `loyalty_tier='pro'` at ₹10,000 (`[[path]].js` ~L873). Not read by pricing (derived spend is), but it is a second, conflicting source of truth.
4. **Member price display.** `index.html:1334` hardcodes "₹999/year, 10%/12% off"; tier table in `index.html` says 40% at 5,000 pcs while `catalog.js`/engine give 25% *(reported)*. Marketing copy can contradict checkout.
5. **Client-side totals for guests** (`order.js` `calculateQuote`, QR amount). Server re-prices payments, so money is safe, but the UPI/QR amount and the printed quote are client numbers *(reported)*.
6. Checkout UX *(reported)*: page reads as a "QUOTATION" with 4 payment tabs; `alert()` errors ×5; `confirm.html` says "no amount charged" on a verify failure that can occur after payment; `ntagz_pending_order` never cleared; first-add-to-cart member modal adds friction; sub-12px text in `order.css`; no `<main>`/skip link.
7. No funnel analytics for membership offer/checkout in admin beyond `/api/ev` events *(reported; verify what `/api/ev` stores)*. No A/B mechanism.
8. Order snapshots hold frozen amounts (`qualifying_paise`, `points_basis_paise`, `member_saving_paise`, …) but **not rule versions** (rates, fee) — a later settings change cannot be reconstructed.
9. Combined merchandise+membership payment: not supported.
10. Rewards expiry-by-membership, tier-rate and "members only vs all" for tier benefits are not configurable.

## 4. Admin settings dependency map
`membership_config` (key/value, D1) is the hub; read by `loadMemberSettings` (payments Worker, 30 s cache) and by the admin Worker; changes apply within ≤30 s, only to **future** orders (orders freeze amounts).

| Admin setting | Storage | Read by | Effect |
|---|---|---|---|
| `fee_paise`, `duration_days`, `discounts_live` | membership_config | `settingsFrom`, `/membership/pricing`, create-order | fee charged (server-side only), term, member prices on/off |
| `max_total_discount_pct`, `min_margin_pct` | membership_config | `memberPctFor` | caps member part of discount |
| product `member_discount_pct`, `cost_paise`, `loyalty_eligible`, `loyalty_max_pct`, `points_eligible` | products | `loadPricing` → `priceCart` | per-line price |
| `loyalty_live`, `loyalty_combine`, `loyalty_tiers.*` | membership_config / loyalty_tiers | `loyaltyContext` | tier **discount** (off by default) |
| `pts_*`, `renew_*` | membership_config | `points.js settingsFrom` | earn rate, value, redemption limits, expiry, notices |
| `reward_milestones` | table | `reconcileUser` | bonus points per membership year |
| cart campaigns | table | `loadCampaigns` | free-shipping / % milestones |
Flow: Admin setting → D1 → `loadPricing/loadMemberSettings` → `/api/quote` → order.js totals → `create-order` re-price → `checkout_intents` → `finalizeOrder` → `orders` snapshot → `/api/membership/me`. Hardcoded (not admin-controlled): GST 18%, shipping thresholds (`SHIPPING`), bulk tiers, `MAX_MEMBER_PCT=50`, product structure (`PRODUCTS` table must list a product to be sellable). Admin Products price → live via `/api/catalog`.

## 5. Current checkout flow
Cart (localStorage) → order.html → guest form (no login gate) → client estimate → if signed-in member/tier, `/api/quote` (350 ms debounce) replaces numbers → optional points redemption → pay: Razorpay / PayU (server prices & stores `checkout_intents`) or offline UPI/bank/WhatsApp (`/api/orders/offline`, unpaid) → gateway verify (signature / PayU hash+verify API, amount must equal intent) → `finalizeOrder` (atomic batch: order, payment, stock, points) → `confirm.html`. Failures write `payment_alerts`.

## 6. Proposed checkout flow
Cart → order.html shows summary → **compact optional membership card** (non-members, only when eligible savings > 0 or user has history): savings today, fee, total without / with, net difference, [Add membership] [Continue without] → server re-quote on toggle → one payment: merchandise + fee as separate lines → `finalizeOrder` activates membership in the same batch → confirmation shows membership + points pending. Non-member path always present, nothing preselected.

## 7. Pricing & rewards rules
Per line, deterministic: base price → bulk tier (qty) → member % (membership) or tier discount (`best_of` default, `stack` opt-in) → guardrails shrink only the member part → milestone campaign (one, non-stacking unless combinable) → points redemption (≤ `pts_max_redeem_pct`, after all discounts, never below free-shipping decision) → GST 18% on non-inclusive → shipping → **+ membership fee (new, outside discounts, not points-eligible)**. Integer paise for points; totals round to whole rupees (existing behaviour).
Points: `earn = floor(points_basis × (paid−refunded)/paid × rate/10000)`; **new: rate = the tier's `points_per_100` frozen on the order**; 1 point = ₹1 (`pts_value_paise=100`, so 3 points per ₹100 = 3%, consistent and configurable). Tier thresholds are cumulative on derived spend.

## 8. Database changes required
`0015_tier_points.sql` (additive): `loyalty_tiers.points_per_100`, `orders.points_rate_x100` (frozen), `checkout_intents.points_rate_x100`; re-seed tiers Silver 5,000 / Gold 25,000 / Diamond 50,000 at 3/5/10 with `discount_pct = 0` (data is disposable test data — saved project note). Later: `membership_fee_paise` on orders/intents + `membership_id` link; `rules_version` JSON snapshot column; `analytics` table only if `/api/ev` is insufficient. Rollback: new columns inert; revert code, leave columns.

## 9. Security & migration risks
- Combined payment touches `finalizeOrder` (money path): must stay atomic/idempotent; membership row keyed by `txn_id` unique to prevent double activation on callback replays.
- Fee must come from server config; client may only send `withMembership: true`.
- Tier-rate freeze must not read mutable state at reconcile time.
- Removing `users.loyalty_spend` write: confirm no reader (grep) before deletion.
- Migrations are forward-only; apply before deploy (RECOVERY.md). **No remote migration or deploy in this session.**

## 10. TapInHere integration options (verified facts, *reported*)
Separate Pages project, own D1/KV; session cookie host-only (`tih_session`, no Domain); ULID account ids (non-secret); **password signups do not verify email**; no OTP; Google sign-in verifies `sub`; no CORS/API-key surface; no existing ntagz references; CSRF double-submit cookie.
- **A (do now):** plain cross-links both ways (footer/nav; `/account` card "TapInHere"). No data shared. Needs TapInHere static-page edits + its `npm run ci`/docs rules (`AGENTS.md`).
- **B (design only):** user-consented linking: logged-in on both sites, short-TTL single-use signed state in KV (reuse `lib/oauth-state.ts`), consent screen both sides, stable external id stored with unlink. Never link on email match. Server-to-server events need an HMAC endpoint (CSRF-exempt, rate-limited). Cross-platform points stay off by default.

## 11. Test & deployment strategy
`npm run test:stage2`, `npm run test:payment`; new pricing/points cases per §7 in `admin/stage2`. Local D1 shim only. Deploy order (human): backup bookmark → migration → payments Worker → admin Worker → static site; flags: `pts_live`, `loyalty_live`, new `checkout_membership_offer` (default 0). Rollback: `wrangler rollback`, flag off.
