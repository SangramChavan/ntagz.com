// Storefront sync: admin catalogue (D1) drives live price, availability and stock deduction. In-memory D1 shim.
const assert = require("node:assert/strict");
const path = require("node:path");
const worker = require(path.join(__dirname, "..", "..", "functions", "api", "[[path]].js"));
const { makeDb } = require("./d1shim.cjs");
const { sqlite, D1, q, one } = makeDb();
const env = { DB: D1, RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "rzp_secret" };
const ORIGIN = "https://www.ntagz.com";
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const hmac = async (secret, msg) => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(msg))), (b) => b.toString(16).padStart(2, "0")).join("");
const call = (p, body, extra = {}, e = env) => worker.onRequest({ request: new Request("https://x" + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...extra }, body: body ? JSON.stringify(body) : undefined }), env: e });
const realFetch = global.fetch;
global.fetch = async (url, opts) => String(url).includes("api.razorpay.com/v1/orders")
  ? Response.json({ id: "order_T" + Math.random().toString(36).slice(2, 9), amount: JSON.parse(opts.body).amount, currency: "INR" }) : realFetch(url, opts);
const cust = { name: "Asha Test", phone: "9876543210", address: "1 Main Street, Pune", pincode: "411001", state: "Maharashtra", email: "a@example.test" };
const card = (qty) => [{ id: "black-nfc-card", qty }];
const fresh = () => worker.resetPricingCache();
const pay = async (rzId, pid) => call("/api/verify-payment", { razorpay_order_id: rzId, razorpay_payment_id: pid, razorpay_signature: await hmac("rzp_secret", `${rzId}|${pid}`) });

(async () => {
  // ── public catalogue endpoint ──
  let r = await call("/api/catalog"); assert.equal(r.status, 200); let cat = await r.json();
  assert.equal(cat.length, 17); const bc = cat.find((c) => c.id === "black-nfc-card");
  assert.deepEqual(Object.keys(bc).sort(), ["active", "available", "id", "low", "price"]); assert.equal(bc.price, 30); assert.equal(bc.available, true); ok("GET /api/catalog: 17 products, price + availability only (no stock counts)");
  assert.equal(r.headers.get("Cache-Control"), "public, max-age=60"); ok("catalogue is cacheable for 60s");
  assert.equal((await call("/api/catalog", { x: 1 })).status, 405); ok("catalogue is read-only");

  // ── price from admin changes what is charged ──
  r = await call("/api/create-order", { items: card(10), ...cust, quoteRef: "QT-P1" }); assert.equal((await r.json()).amount, 39400); ok("seeded D1 prices equal today's prices (394.00 for 10 black cards)");
  sqlite.exec("UPDATE products SET price_paise=3100 WHERE id='black-nfc-card'"); fresh();
  r = await call("/api/create-order", { items: card(10), ...cust, quoteRef: "QT-P2" }); const d = await r.json(); assert.equal(d.amount, 40600); ok("admin price ₹30 → ₹31 changes the charged amount (₹310 + GST ₹56 + shipping ₹40 = ₹406)");
  assert.equal(one("SELECT amount_paise a FROM checkout_intents WHERE txn_id=?", d.id).a, 40600); ok("order intent stores the same server-priced amount");
  cat = await (await call("/api/catalog")).json(); assert.equal(cat.find((c) => c.id === "black-nfc-card").price, 31); ok("catalogue endpoint shows the new price");
  sqlite.exec("UPDATE products SET price_paise=3000 WHERE id='black-nfc-card'"); fresh();

  // ── inactive / stock ──
  sqlite.exec("UPDATE products SET active=0 WHERE id='black-nfc-card'"); fresh();
  r = await call("/api/create-order", { items: card(10), ...cust }); assert.equal(r.status, 409); assert.match((await r.json()).error, /currently unavailable/); ok("inactive product cannot be ordered");
  r = await call("/api/orders/offline", { method: "upi", items: card(10), ...cust, quoteRef: "QT-I1" }, { "CF-Connecting-IP": "7.7.7.7" }); assert.equal(r.status, 409); ok("…nor via the offline route");
  assert.equal((await (await call("/api/catalog")).json()).find((c) => c.id === "black-nfc-card").active, false); sqlite.exec("UPDATE products SET active=1 WHERE id='black-nfc-card'"); fresh();

  r = await call("/api/create-order", { items: card(10), ...cust }); assert.equal(r.status, 200); ok("untracked product ignores stock (seeded stock 0 does not block sales)");
  sqlite.exec("UPDATE products SET track_stock=1, stock_qty=5, low_stock_threshold=10 WHERE id='black-nfc-card'"); fresh();
  r = await call("/api/create-order", { items: card(10), ...cust }); assert.equal(r.status, 409); assert.match((await r.json()).error, /Only 5 of Black NFC 215 Card available/); ok("tracked product: quantity above stock is rejected with a clear message");
  cat = await (await call("/api/catalog")).json(); assert.equal(cat.find((c) => c.id === "black-nfc-card").low, true); assert.equal(cat.find((c) => c.id === "black-nfc-card").available, true); ok("low-stock flag exposed");
  sqlite.exec("UPDATE products SET stock_qty=0 WHERE id='black-nfc-card'"); fresh();
  r = await call("/api/create-order", { items: card(10), ...cust }); assert.match((await r.json()).error, /out of stock/); assert.equal((await (await call("/api/catalog")).json()).find((c) => c.id === "black-nfc-card").available, false); ok("out of stock rejected and shown as unavailable");

  // ── stock deduction on paid order, idempotent ──
  sqlite.exec("UPDATE products SET stock_qty=100 WHERE id='black-nfc-card'"); fresh();
  r = await call("/api/create-order", { items: card(10), ...cust, quoteRef: "QT-S1" }); const o1 = await r.json();
  assert.equal(one("SELECT stock_qty s FROM products WHERE id='black-nfc-card'").s, 100); ok("stock is not touched until payment is verified");
  await pay(o1.id, "pay_s1"); assert.equal(one("SELECT stock_qty s FROM products WHERE id='black-nfc-card'").s, 90);
  const mv = one("SELECT * FROM inventory_movements WHERE product_id='black-nfc-card' AND type='out'"); assert.equal(mv.qty_change, -10); assert.equal(mv.prev_stock, 100); assert.equal(mv.new_stock, 90); assert.equal(mv.admin, "system"); assert.equal(mv.reference, o1.id); ok("verified payment deducts 10, with a movement row (100 → 90)");
  await pay(o1.id, "pay_s1"); assert.equal(one("SELECT stock_qty s FROM products WHERE id='black-nfc-card'").s, 90); assert.equal(q("SELECT * FROM inventory_movements WHERE type='out'").length, 1); ok("verifying again deducts nothing");

  // ── offline order deducts once ──
  const off = (quote) => call("/api/orders/offline", { method: "upi", items: card(10), ...cust, quoteRef: quote }, { "CF-Connecting-IP": "8.8.8.8" });
  assert.equal((await off("QT-O1")).status, 200); assert.equal(one("SELECT stock_qty s FROM products WHERE id='black-nfc-card'").s, 80);
  assert.equal((await off("QT-O1")).status, 200); assert.equal(one("SELECT stock_qty s FROM products WHERE id='black-nfc-card'").s, 80); assert.equal(one("SELECT count(*) c FROM orders WHERE txn_id LIKE 'OFF-QT-O1%'").c, 1); ok("offline order deducts stock once; repeated submit deducts nothing");

  // ── clamp at zero when stock fell between checkout start and payment ──
  r = await call("/api/create-order", { items: card(10), ...cust, quoteRef: "QT-C1" }); const o2 = await r.json();
  sqlite.exec("UPDATE products SET stock_qty=3 WHERE id='black-nfc-card'"); await pay(o2.id, "pay_c1");
  assert.equal(one("SELECT stock_qty s FROM products WHERE id='black-nfc-card'").s, 0); const last = one("SELECT * FROM inventory_movements WHERE reference=?", o2.id); assert.equal(last.qty_change, -3); assert.equal(last.new_stock, 0); ok("stock never goes negative; movement records the real deduction (-3)");
  assert.equal(one("SELECT count(*) c FROM orders WHERE txn_id=?", o2.id).c, 1); ok("the paid order is still recorded");

  // ── fallback ──
  sqlite.exec("UPDATE products SET price_paise=9999 WHERE id='anti-metal-tag'"); fresh();
  r = await call("/api/create-order", { items: [{ id: "anti-metal-tag", qty: 10 }], ...cust }, {}, { ...env, DB: undefined }); assert.equal(r.status, 200); assert.equal((await r.json()).amount, 27600); ok("no database: falls back to built-in prices (₹200 + GST ₹36 + shipping ₹40)");
  const broken = { ...env, DB: { prepare() { throw new Error("D1 down"); }, batch() { throw new Error("D1 down"); } } }; fresh();
  r = await call("/api/create-order", { items: [{ id: "anti-metal-tag", qty: 10 }], ...cust }, {}, broken); assert.equal(r.status, 200); assert.equal((await r.json()).amount, 27600); ok("database error: falls back to built-in prices instead of failing checkout");
  r = await call("/api/catalog", undefined, {}, broken); assert.equal(r.status, 503); ok("catalogue endpoint reports 503 (clients keep static prices)");
  global.fetch = realFetch; console.log(`\nall ${n} storefront-sync checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
