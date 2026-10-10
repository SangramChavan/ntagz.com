// Local-only checks for products + inventory. Run after test/smoke.mjs setup (wrangler dev --local on :8799).
import assert from "node:assert/strict";
const BASE = process.env.BASE || "http://localhost:8799";
const H = { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" };
let cookie = "";
const call = (path, body) => fetch(BASE + path, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : H), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const key = () => crypto.randomUUID();

assert.equal((await call("/api/products")).status, 401); assert.equal((await call("/api/products/summary")).status, 401);
assert.equal((await call("/api/products", { name: "x" })).status, 401);
assert.equal((await call("/products.js")).status, 404); ok("unauthenticated users cannot reach product APIs or script");

let r = await call("/api/auth/request", { email: "admin@example.test" });
r = await call("/api/auth/verify", { email: "admin@example.test", otp: (await r.json()).dev_otp }); cookie = r.headers.get("set-cookie").split(";")[0];

let s = await (await call("/api/products/summary")).json();
assert.equal(s.total, 17); assert.equal(s.out, 17); assert.ok(s.categories.includes("nfc")); ok("catalogue seeded from catalog.js (17 products, all start at 0 stock)");
let d = await (await call("/api/products?q=black")).json(); assert.equal(d.products[0].id, "black-nfc-card"); assert.equal(d.products[0].price_paise, 3000); ok("search by name; price matches catalog.js");
d = await (await call("/api/products?q=BNC30")).json(); assert.equal(d.total, 1); ok("search by SKU (case-insensitive)");

// orders snapshot to prove history is untouched
const ordersBefore = JSON.stringify((await (await call("/api/orders?sort=name&dir=asc")).json()).orders);

// create + validation + duplicate SKU
r = await call("/api/products", { name: "Test Keychain", sku: "kc-001", category: "nfc", price: "49.50", mrp: "60", gst_rate: 18, opening_stock: 20, low_stock_threshold: 5, description: "demo" });
assert.equal(r.status, 201); let p = await r.json(); assert.equal(p.sku, "KC-001"); assert.equal(p.price_paise, 4950); assert.equal(p.stock_qty, 20); assert.equal(p.movements[0].type, "opening"); ok("add product with opening stock + opening movement");
d = await (await call("/api/products?q=keychain")).json(); assert.equal(d.total, 1); ok("new product appears in catalogue");
r = await call("/api/products", { name: "Dup", sku: "kc-001", category: "nfc", price: "10" }); assert.equal(r.status, 409); assert.ok((await r.json()).fields.sku); ok("duplicate SKU rejected (case-insensitive)");
for (const [bad, field] of [[{ price: "abc" }, "price"], [{ price: "-5" }, "price"], [{ price: "10.555" }, "price"], [{ name: "" }, "name"], [{ opening_stock: -3 }, "opening_stock"], [{ mrp: "5", price: "10" }, "mrp"], [{ gst_rate: 7 }, "gst_rate"], [{ image_url: "http://evil.test/x.png" }, "image_url"]]) {
  r = await call("/api/products", { name: "Valid", sku: "OK-" + key().slice(0, 6), category: "nfc", price: "10", ...bad }); const j = await r.json();
  assert.equal(r.status, 400, JSON.stringify(bad)); assert.ok(j.fields[field], field);
} ok("invalid price, name, negative opening stock, MRP<price, GST, image URL all rejected server-side");

// edit price
r = await call("/api/products/" + p.id, { price: "55" }); assert.equal(r.status, 200); p = await r.json(); assert.equal(p.price_paise, 5500); assert.equal(p.stock_qty, 20); ok("price edit saved; stock untouched");
r = await call("/api/products/" + p.id, { stock_qty: 999 }); assert.equal(r.status, 400); ok("product edit cannot change stock directly");
r = await call("/api/products/black-nfc-card", { price: "31" }); assert.equal(r.status, 200);
assert.equal(JSON.stringify((await (await call("/api/orders?sort=name&dir=asc")).json()).orders), ordersBefore); ok("existing orders and their totals unchanged by price edits");
r = await call("/api/products/black-nfc-card", { price: "30" });

// stock
const adj = (id, b) => call(`/api/products/${id}/stock`, { idempotency_key: key(), reason: "test", ...b });
r = await adj(p.id, { type: "in", quantity: 50, reason: "Supplier delivery", reference: "PO-1" }); p = await r.json(); assert.equal(r.status, 200); assert.equal(p.stock_qty, 70); ok("stock in: 20 + 50 = 70");
r = await adj(p.id, { type: "out", quantity: 8, reason: "Damaged" }); p = await r.json(); assert.equal(p.stock_qty, 62);
assert.deepEqual(p.movements.slice(0, 2).map((m) => [m.type, m.qty_change, m.prev_stock, m.new_stock, m.admin]), [["out", -8, 70, 62, "admin@example.test"], ["in", 50, 20, 70, "admin@example.test"]]); ok("stock out recorded with prev/new/admin in history");
r = await adj(p.id, { type: "out", quantity: 63 }); assert.equal(r.status, 409); assert.equal((await (await call("/api/products/" + p.id)).json()).stock_qty, 62); ok("cannot remove more than available (no negative stock)");
r = await adj(p.id, { type: "in", quantity: 0 }); assert.equal(r.status, 400); r = await adj(p.id, { type: "in", quantity: -4 }); assert.equal(r.status, 400); r = await adj(p.id, { type: "in", quantity: 1.5 }); assert.equal(r.status, 400); ok("zero / negative / fractional quantities rejected");
r = await adj(p.id, { type: "in", quantity: 1, reason: "" }); assert.equal(r.status, 400); ok("reason required");
r = await adj(p.id, { type: "set", quantity: 40, expected_stock: 10, reason: "Count" }); assert.equal(r.status, 409); ok("set-actual refuses stale current stock");
r = await adj(p.id, { type: "set", quantity: 40, expected_stock: 62, reason: "Physical count" }); p = await r.json(); assert.equal(p.stock_qty, 40); assert.equal(p.movements[0].qty_change, -22); ok("set actual stock: 62 → 40, change -22 recorded");
const k = key(); const one = () => call(`/api/products/${p.id}/stock`, { idempotency_key: k, type: "in", quantity: 5, reason: "retry" });
const dbl = await Promise.all([one(), one(), one()]); assert.equal(dbl.filter((x) => x.status === 200).length, 1); assert.equal((await (await call("/api/products/" + p.id)).json()).stock_qty, 45); ok("repeated submit with same key applies once");
const race = await Promise.all(Array.from({ length: 10 }, () => adj(p.id, { type: "out", quantity: 10 })));
const won = race.filter((x) => x.status === 200).length; p = await (await call("/api/products/" + p.id)).json();
assert.equal(won, 4); assert.equal(p.stock_qty, 5); assert.ok(p.stock_qty >= 0); ok("10 concurrent stock-outs of 10 from 45: exactly 4 succeed, stock ends at 5");
const sum = p.movements.reduce((a, m) => a + m.qty_change, 0); assert.equal(sum, p.stock_qty); ok("movement history sums to current stock");

// indicators
assert.equal(p.stock_status, "low"); await adj(p.id, { type: "out", quantity: 5 }); p = await (await call("/api/products/" + p.id)).json(); assert.equal(p.stock_status, "out");
await adj(p.id, { type: "in", quantity: 100 }); p = await (await call("/api/products/" + p.id)).json(); assert.equal(p.stock_status, "in");
assert.ok((await (await call("/api/products?stock=out")).json()).total >= 17); assert.equal((await (await call("/api/products?stock=low")).json()).total, 0); ok("low / out / in stock indicators and filters");

// storefront tracking flag
r = await call("/api/products/" + p.id, { track_stock: true }); p = await r.json(); assert.equal(p.track_stock, true);
d = await (await call("/api/products?q=keychain")).json(); assert.equal(d.products[0].track_stock, true);
r = await call("/api/products/" + p.id, { track_stock: false }); assert.equal((await r.json()).track_stock, false); ok("track_stock flag round-trips");
// active
r = await call(`/api/products/${p.id}/active`, { active: false }); p = await r.json(); assert.equal(p.active, false);
assert.equal((await (await call("/api/products?active=0")).json()).total, 1); ok("deactivate / filter inactive (archived, never deleted)");
assert.equal((await call(`/api/products/${p.id}/active`, { active: "no" })).status, 400);
r = await call("/api/products?sort=name;DROP&dir=asc&page=abc"); assert.equal(r.status, 200); ok("unsafe sort/page values safely ignored");
s = await (await call("/api/products/summary")).json(); assert.equal(s.total, 18); assert.equal(s.active, 17); ok("summary counts");
console.log(`\nall ${n} product checks passed`);
