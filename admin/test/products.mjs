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
for (const [bad, field] of [[{ price: "abc" }, "price"], [{ price: "" }, "price"], [{ price: "-5" }, "price"], [{ price: "10.555" }, "price"], [{ name: "" }, "name"], [{ opening_stock: -3 }, "opening_stock"], [{ mrp: "5", price: "10" }, "mrp"], [{ gst_rate: 7 }, "gst_rate"], [{ image_url: "http://evil.test/x.png" }, "image_url"]]) {
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

// ── redesign additions: cost price, auto SKU, duplicate, safe delete, category search, newest sort ──
r = await call("/api/products", { name: "Smart Plaque Large", category: "review", price: "120", cost: "70", opening_stock: 5 }); p = await r.json();
assert.equal(r.status, 201); assert.match(p.sku, /^SPL-\d{3}$/); assert.equal(p.cost_paise, 7000); assert.equal(p.id, "smart-plaque-large"); ok("add product with only name/price/stock: SKU auto-generated, cost price saved");
r = await call("/api/products", { name: "Smart Plaque Large", category: "review", price: "125" }); const p2 = await r.json(); assert.equal(r.status, 201); assert.equal(p2.id, "smart-plaque-large-2"); assert.notEqual(p2.sku, p.sku); ok("same name gets a unique id and a different SKU");
r = await call("/api/products", { name: "Cost Test", sku: "ct-1", category: "nfc", price: "10", cost: "-4" }); assert.equal(r.status, 400); assert.ok((await r.json()).fields.cost); ok("invalid cost price rejected");
r = await call("/api/products/" + p.id, { cost: "" }); assert.equal((await r.json()).cost_paise, null); ok("cost price can be cleared");
d = await (await call("/api/products?q=review")).json(); assert.ok(d.total >= 2); ok("search matches category");
d = await (await call("/api/products?sort=newest&dir=desc")).json(); assert.equal(d.products[0].created_at >= d.products[d.products.length - 1].created_at, true); ok("sort by newest");

r = await call(`/api/products/${p.id}/duplicate`, {}); const dup = await r.json();
assert.equal(r.status, 201); assert.equal(dup.stock_qty, 0); assert.equal(dup.active, false); assert.equal(dup.price_paise, p.price_paise); assert.equal(dup.cost_paise, null); assert.notEqual(dup.sku, p.sku); assert.equal(dup.name, "Smart Plaque Large (copy)"); assert.equal(dup.movements.length, 0); ok("duplicate copies details, new SKU, stock 0, inactive");
assert.equal((await call("/api/products/nope-nothing/duplicate", {})).status, 404); ok("duplicating a missing product is a 404");

r = await call(`/api/products/${dup.id}/delete`, {}); assert.equal((await r.json()).deleted, true); assert.equal((await call("/api/products/" + dup.id)).status, 404); ok("unused product is deleted");
r = await call(`/api/products/${p.id}/delete`, {}); let del = await r.json(); assert.equal(del.deleted, true); ok("product with only an opening-stock entry is deleted with its history");
r = await call("/api/products", { name: "Moved Item", sku: "mv-1", category: "nfc", price: "10", opening_stock: 5 }); const mv2 = await r.json();
await call(`/api/products/${mv2.id}/stock`, { type: "out", quantity: 1, reason: "Damaged", idempotency_key: crypto.randomUUID() });
r = await call(`/api/products/${mv2.id}/delete`, {}); del = await r.json(); assert.equal(del.deactivated, true); assert.equal((await (await call("/api/products/" + mv2.id)).json()).active, false); ok("product with stock history is deactivated, not deleted");
r = await call("/api/products/black-nfc-card/delete", {}); assert.equal(r.status, 409); assert.equal((await (await call("/api/products/black-nfc-card")).json()).built_in, true); ok("built-in storefront products cannot be deleted");
assert.equal((await call("/api/products/black-nfc-card/delete")).status, 404); ok("delete requires POST");

// ── pre-orders ──
r = await call("/api/products", { name: "Pre Item", sku: "pre-1", category: "nfc", price: "10", opening_stock: 3 }); let pp = await r.json();
assert.equal(pp.preorder_enabled, false); assert.equal(pp.preorder_message, null); assert.equal(pp.preorder_max, null); assert.equal(pp.preordered_qty, 0); ok("new products default to pre-orders off with preordered_qty 0");
r = await call("/api/products/" + pp.id, { preorder_enabled: true }); assert.equal(r.status, 400); assert.equal((await r.json()).fields.preorder_enabled, "Turn on stock tracking first"); ok("cannot enable pre-orders without stock tracking");
r = await call("/api/products", { name: "Pre Bad", sku: "pre-2", category: "nfc", price: "10", preorder_enabled: true }); assert.equal(r.status, 400); assert.ok((await r.json()).fields.preorder_enabled); ok("create with pre-orders but no tracking is rejected");
r = await call("/api/products/" + pp.id, { track_stock: true, preorder_enabled: true, preorder_message: " Ships after the next batch ", preorder_dispatch: "Within 7-10 business days", preorder_max: "25" }); pp = await r.json();
assert.equal(r.status, 200); assert.equal(pp.preorder_enabled, true); assert.equal(pp.preorder_message, "Ships after the next batch"); assert.equal(pp.preorder_dispatch, "Within 7-10 business days"); assert.equal(pp.preorder_max, 25); ok("pre-order fields round-trip (tracking and pre-order enabled together)");
d = await (await call("/api/products?q=pre item")).json(); assert.equal(d.products[0].preorder_enabled, true); ok("list exposes pre-order fields");
r = await call("/api/products/" + pp.id, { track_stock: false }); assert.equal(r.status, 400); assert.ok((await r.json()).fields.preorder_enabled); assert.equal((await (await call("/api/products/" + pp.id)).json()).track_stock, true); ok("cannot turn tracking off while pre-orders are on");
r = await call("/api/products/" + pp.id, { track_stock: false, preorder_enabled: false }); pp = await r.json(); assert.equal(r.status, 200); assert.equal(pp.track_stock, false); assert.equal(pp.preorder_enabled, false); assert.equal(pp.preorder_message, "Ships after the next batch"); ok("turning both off together is allowed and keeps the message");
for (const [bad, f] of [[{ preorder_max: "-1" }, "preorder_max"], [{ preorder_max: "abc" }, "preorder_max"], [{ preorder_max: 1.5 }, "preorder_max"], [{ preorder_message: "x".repeat(201) }, "preorder_message"], [{ preorder_dispatch: "y".repeat(101) }, "preorder_dispatch"], [{ preorder_message: 5 }, "preorder_message"]]) {
  r = await call("/api/products/" + pp.id, bad); assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 60)); assert.ok((await r.json()).fields[f], f);
} ok("pre-order max / message / dispatch validated");
r = await call("/api/products/" + pp.id, { preorder_max: "" }); assert.equal((await r.json()).preorder_max, null); r = await call("/api/products/" + pp.id, { preorder_max: 0 }); assert.equal((await r.json()).preorder_max, 0); ok("empty max means no cap; 0 is allowed");
r = await call("/api/products/" + pp.id, { preordered_qty: 99 }); pp = await r.json(); assert.equal(r.status, 200); assert.equal(pp.preordered_qty, 0); ok("preordered_qty cannot be written through the API");
r = await call("/api/products", { name: "Pre Two", sku: "pre-3", category: "nfc", price: "10", track_stock: true, preorder_enabled: true, preorder_max: 5, preordered_qty: 7 }); const pp2 = await r.json(); assert.equal(r.status, 201); assert.equal(pp2.preorder_enabled, true); assert.equal(pp2.preordered_qty, 0); ok("create with pre-orders enabled works; preordered_qty ignored");
const nc = await (await call("/api/products/nfc-coin")).json(); assert.equal(nc.preordered_qty, 3); r = await call("/api/products/nfc-coin", { preorder_enabled: false }); pp = await r.json(); assert.equal(r.status, 200); assert.equal(pp.preorder_enabled, false); assert.equal(pp.preordered_qty, 3); ok("disabling pre-orders keeps existing preordered_qty");
await call("/api/products/nfc-coin", { preorder_enabled: true });
console.log(`\nall ${n} product checks passed`);
