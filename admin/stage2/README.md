# Stage 2 — trusted order recording (NOT applied to live code yet)

`checkout-recording.patch` changes live checkout code (`functions/api/[[path]].js`, `order.html`, `js/order.js`) and so
needs explicit approval. It was developed and tested against a scratch copy; the live files are untouched.

## What it does
- Razorpay `create-order` and PayU `checkout` store a server-priced **intent** (`checkout_intents`). Nothing is an order yet.
- When the gateway payment is verified server-side (Razorpay signature / PayU hash + PayU verify API, amount must match the
  intent) the Worker creates the **paid** order, the `payments` row and the loyalty update. Repeats are idempotent.
- `POST /api/accounts/orders` (public, unauthenticated, trusted client totals) no longer writes anything; it only returns an
  existing order id so `order/confirm.html` keeps working.
- New `POST /api/orders/offline` (UPI / bank / WhatsApp): server prices the cart with `calculateTotal`, stores an **unpaid**
  order, rate-limited to 5 per 10 minutes per hashed IP. Called from the "Confirm Order via WhatsApp" click; fire-and-forget.
- Database trouble can never block a payment: every recording call is guarded and logged.
- Admin: UPI/bank/WhatsApp orders can be marked received with a method + reference (`/payment-received`); gateway orders never can.

## Tests
    node admin/stage2/test-checkout-recording.cjs        # run against the patched worker (set WORKER=… to a patched copy)
    node scripts/test-payment-worker.js                  # existing test, must still pass
    cd admin && npm test                                 # admin suites against a fresh local D1 (needs wrangler dev, see ../README.md)

## Deploy order (needs approval)
1. `git apply admin/stage2/checkout-recording.patch` and re-run the tests above.
2. `cd admin && npx wrangler d1 migrations apply ntagz-db --remote`  (0003: drops the insert trigger, adds intents/attempts tables)
3. Deploy the payments Worker (`npx wrangler deploy -c wrangler.payment.toml`) and the admin Worker (`cd admin && npx wrangler deploy`),
   push the site files (order.html, js/order.js) via GitHub Pages. Steps 2 and 3 should happen close together: the old Worker
   still works against the new schema, but the new Worker needs the tables.
4. Rollback: redeploy the previous Worker versions; the new tables are additive and can stay.

## Not included (needs a decision)
Storefront price/stock sync: checkout still prices from js/catalog.js + the Worker's PRODUCTS table, and does not decrement stock.
