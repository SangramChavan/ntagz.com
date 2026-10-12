# Implementation plan

Scope this session: local code + tests only. No deploys, no remote migrations. Owner of shared money/auth/migration code: main agent. Order = dependency order.

| # | Task | Files | Acceptance |
|---|---|---|---|
| 1 | Tier points rates (Silver 5k/3%, Gold 25k/5%, Diamond 50k/10%), frozen per order | `admin/migrations/0015_tier_points.sql`, `functions/lib/loyalty.js`, `functions/lib/points.js`, `[[path]].js` (intent/order stmts, willEarn), `admin/src` tier validate/save | `test-points.cjs` new cases: ₹5,000→Silver rate 3, ₹25,000→Gold 5, ₹50,000→Diamond 10, cumulative; refund adjusts; replay no double award; old rows keep frozen rate |
| 2 | Stop writing legacy `users.loyalty_spend` (after grep proves no reader) | `[[path]].js` finalizeOrder | all stage2 pass |
| 3 | Membership in checkout (optional, honest comparison, one payment) | `[[path]].js` (`withMembership` in quote/create-order/payu; fee line; activation in `finalizeOrder` batch), `functions/lib/pricing.js` (fee outside discounts), `order.html`, `js/order.js`, migration 0016 | quote returns `withMembership` & `without` totals + net diff; manipulated fee/total rejected; replay callback = 1 membership; active member never charged; refund policy documented |
| 4 | Rules-version snapshot on orders | migration 0016, finalizeOrder | order stores fee/rate/settings snapshot |
| 5 | Admin: tier points-rate field + preview shows points per tier | `admin/src`, `admin/public/rewards.js`, `pricing.js` | invalid rates rejected; preview == engine |
| 6 | Dashboard: points-rate & next-tier copy from API | `js/membership-dashboard.js`, `account/index.html` | progress = spend/threshold from `/rewards/me` |
| 7 | Checkout UX fixes: inline errors not `alert()`, clear pending order, correct failure copy, ≥12px text | `order.html`, `js/order.js`, `css/order.css`, `order/confirm.html` | manual mobile check |
| 8 | Marketing copy from API (index.html ₹999 / tier table) | `index.html` | no divergent numbers |
| 9 | TapInHere cross-links (option A) | both repos static pages | links live, no data shared, TapInHere CI green |
| 10 | Analytics events for offer shown/accepted/declined | existing `/api/ev` | events stored, no PII |
| 11 | A/B, funnel admin view, account linking (option B) | — | **Deferred**: needs traffic baseline / product decision / security review |

## API contracts (new/changed)
- `POST /api/quote` adds request `membership: "add"|undefined`, response `membershipOffer: {state, feePaise, savingsPaise, totalWithout, totalWith, netPaise, show}`. `state` ∈ eligible|active|expired|ineligible.
- `create-order`, `payu/checkout` accept `membership: "add"`; server recomputes; fee never trusted from client.
- `/api/rewards/*` tiers add `pointsPer100`.
Migration rollback: all additive; disable via flags.

## Status (2026-10-12)
- Done + tested locally: task 1 (migration 0015, tier points rates frozen per order, admin field, quote `ratePer100`, schema-tolerant until 0015 is applied). `npm run test:stage2` and `test:payment` green.
- Done + tested locally: task 3 (membership inside checkout, flag `checkout_offer`, migration 0016, 25 checks in `test-checkout-membership.cjs`) and task 4 (rules snapshot `rules_json`) and the checkout card UI + admin toggle (UI checked in a browser against a stubbed API only; not against the real Worker).
- Not started: 2, 5–11. Known limits of task 3: membership fee carries no GST line (same as the existing /membership/ purchase; confirm tax treatment); a refund of an order that bought membership refunds proportionally for spend/points but does not end the membership (use the admin 'end membership' action); renewal of an active membership still happens on /membership/.
- Open decision: members below Silver earn the flat `pts_earn_per_100` (default 5), which is higher than Silver's 3. Set the flat rate lower, or give the Free tier an explicit rate.
