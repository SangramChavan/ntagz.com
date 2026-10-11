// Pre-orders: ready stock ships now, quantity beyond it is a pre-order. In-memory D1 shim.
const assert = require("node:assert/strict");
const path = require("node:path");
const worker = require(path.join(__dirname, "..", "..", "functions", "api", "[[path]].js"));
const { makeDb } = require("./d1shim.cjs");
const { sqlite, D1, q, one } = makeDb();
const env = { DB: D1, RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "rzp_secret" };
const ORIGIN = "https://www.ntagz.com";
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const hmac = async (secret, msg) => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(msg))), (b) => b.toString(16).padStart(2, "0")).join("");
const call = (p, body, extra = {}) => { worker.resetPricingCache(); return worker.onRequest({ request: new Request("https://x" + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...extra }, body: body ? JSON.stringify(body) : undefined }), env }); };
const realFetch = global.fetch;
global.fetch = async (url, opts) => String(url).includes("api.razorpay.com/v1/orders")
  ? Response.json({ id: "order_T" + Math.random().toString(36).slice(2, 11), amount: JSON.parse(opts.body).amount, currency: "INR" }) : realFetch(url, opts);
const cust = { name: "Asha Test", phone: "9876543210", address: "1 Main Street, Pune", pincode: "411001", state: "Maharashtra", email: "a@example.test" };
const P = "uhf-rfid-label", U = "anti-metal-tag";
const items = (qty, id = P) => [{ id, qty }];
const fresh = () => worker.resetPricingCache();
const prod = (id = P) => one("SELECT * FROM products WHERE id=?", id);
const setP = (sql, id = P) => { sqlite.prepare(`UPDATE products SET ${sql} WHERE id=?`).run(id); fresh(); };
const start = async (qty, id = P) => { const r = await call("/api/create-order", { items: items(qty, id), ...cust, quoteRef: "Q" + Math.random().toString(36).slice(2, 8) }); return { r, d: await r.clone().json() }; };
const pay = async (rzId, pid) => call("/api/verify-payment", { razorpay_order_id: rzId, razorpay_payment_id: pid, razorpay_signature: await hmac("rzp_secret", `${rzId}|${pid}`) });
const buy = async (qty, pid, id = P) => { const { d } = await start(qty, id); if (!d.id) throw new Error(JSON.stringify(d)); await pay(d.id, pid); return one("SELECT * FROM orders WHERE txn_id=?", d.id); };
const lines = (oid) => q("SELECT product_id,ready_qty,pre_qty FROM order_stock_lines WHERE order_id=?", oid).map((x) => ({ ...x }));
const cat = async () => (await (await call("/api/catalog")).json());
let pi = 0; const pid = () => "pay_po" + ++pi;

(async () => {
  // normal order, stock suffices
  setP("track_stock=1, stock_qty=20, low_stock_threshold=5, preorder_enabled=1, preorder_message='Restocking', preorder_dispatch='7-10 days'");
  let o = await buy(10, pid());
  assert.equal(o.is_preorder, 0); assert.notEqual(o.status, "preorder_confirmed"); assert.equal(prod().stock_qty, 10); assert.equal(prod().preordered_qty, 0);
  assert.deepEqual(lines(o.id), [{ product_id: P, ready_qty: 10, pre_qty: 0 }]); ok("stock suffices: no pre-order, status unchanged");

  // split order
  setP("stock_qty=5, preordered_qty=0");
  o = await buy(8, pid());
  assert.deepEqual(lines(o.id), [{ product_id: P, ready_qty: 5, pre_qty: 3 }]);
  assert.equal(prod().stock_qty, 0); assert.equal(prod().preordered_qty, 3); assert.equal(o.is_preorder, 1); assert.equal(o.status, "preorder_confirmed");
  const mv = one("SELECT * FROM inventory_movements WHERE reference=?", o.txn_id); assert.equal(mv.qty_change, -5); ok("stock 5 + order 8: ready 5 / pre 3, stock 0, preordered 3, order is pre-order");

  // disabled + exceeding blocked
  setP("preorder_enabled=0, stock_qty=5, preordered_qty=0");
  let r = await call("/api/create-order", { items: items(8), ...cust }); assert.equal(r.status, 409); assert.match((await r.json()).error, /^Only 5 of .* available$/);
  setP("stock_qty=0"); r = await call("/api/create-order", { items: items(1), ...cust }); assert.match((await r.json()).error, /out of stock/); ok("pre-order disabled: over-stock blocked, old messages");

  // cap across orders
  setP("preorder_enabled=1, preorder_max=10, stock_qty=0, preordered_qty=0");
  o = await buy(8, pid()); assert.equal(prod().preordered_qty, 8); assert.deepEqual(lines(o.id), [{ product_id: P, ready_qty: 0, pre_qty: 8 }]);
  r = await call("/api/create-order", { items: items(3), ...cust }); assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "Only 2 of UHF RFID Label Sticker 27×15mm available (0 ready to ship, 2 for pre-order)");
  r = await call("/api/orders/offline", { method: "upi", items: items(3), ...cust, quoteRef: "QT-CAP" }, { "CF-Connecting-IP": "1.1.1.1" }); assert.equal(r.status, 409); ok("preorder_max enforced across orders with remaining message (also offline)");
  assert.equal((await call("/api/create-order", { items: items(2), ...cust })).status, 200); ok("remaining 2 still accepted");

  // untracked ignores everything
  const un = await buy(10, pid(), U);
  assert.equal(q("SELECT * FROM order_stock_lines WHERE order_id=?", un.id).length, 0); assert.equal(un.is_preorder, 0); assert.equal(prod(U).preordered_qty, 0); ok("untracked product: no stock lines, no pre-order");
  setP("preorder_enabled=1, preorder_max=5", U); assert.equal((await start(10, U)).r.status, 200);
  assert.equal((await cat()).find((c) => c.id === U).preorder, null); ok("untracked product with preorder flag set is ignored");

  // catalog
  setP("track_stock=1, stock_qty=4, low_stock_threshold=5, preorder_enabled=1, preorder_max=10, preordered_qty=7, preorder_message='M', preorder_dispatch='D'");
  let c = (await cat()).find((x) => x.id === P);
  assert.deepEqual(c.preorder, { message: "M", dispatch: "D", ready_qty: 4, max_qty: 3 }); assert.equal(c.left, 4); assert.equal(c.low, true); assert.equal(c.available, true);
  setP("stock_qty=50"); c = (await cat()).find((x) => x.id === P); assert.equal(c.left, null); assert.equal(c.preorder.ready_qty, 50);
  setP("stock_qty=0, preordered_qty=10"); c = (await cat()).find((x) => x.id === P); assert.equal(c.available, false); assert.equal(c.preorder.max_qty, 0);
  setP("stock_qty=0, preordered_qty=3"); assert.equal((await cat()).find((x) => x.id === P).available, true);
  setP("preorder_max=NULL"); c = (await cat()).find((x) => x.id === P); assert.equal(c.preorder.max_qty, null);
  setP("preorder_enabled=0, stock_qty=50"); c = (await cat()).find((x) => x.id === P); assert.equal(c.preorder, null); assert.equal(c.left, null);
  assert.deepEqual(Object.keys(c).sort(), ["active", "available", "id", "left", "low", "preorder", "price"]); assert.ok(!JSON.stringify(c).includes("50")); ok("catalog: preorder object, left only when low, available semantics, no stock leakage");

  // concurrency
  setP("track_stock=1, stock_qty=6, preorder_enabled=1, preorder_max=NULL, preordered_qty=0");
  sqlite.exec("DELETE FROM order_stock_lines");
  const flows = await Promise.all([4, 3, 5, 2, 6].map((qty, i) => buy(qty, "pay_cc" + i)));
  const sum = one("SELECT sum(pre_qty) p, sum(ready_qty) r FROM order_stock_lines");
  assert.ok(prod().stock_qty >= 0); assert.equal(prod().stock_qty, 0); assert.equal(prod().preordered_qty, sum.p); assert.equal(sum.r, 6); assert.equal(sum.p, 14);
  assert.equal(q("SELECT 1 FROM orders WHERE is_preorder=1 AND id IN (SELECT order_id FROM order_stock_lines WHERE pre_qty>0)").length, flows.filter((x) => lines(x.id)[0].pre_qty > 0).length); ok("concurrent checkouts: stock never < 0, preordered_qty == sum(pre_qty)");

  // replayed verify
  setP("stock_qty=2, preordered_qty=0"); sqlite.exec("DELETE FROM order_stock_lines");
  const { d } = await start(5); await pay(d.id, "pay_rp"); await pay(d.id, "pay_rp"); await pay(d.id, "pay_rp");
  assert.equal(prod().preordered_qty, 3); assert.equal(prod().stock_qty, 0); assert.equal(q("SELECT * FROM order_stock_lines").length, 1); ok("replayed verify-payment allocates once");

  // offline path
  setP("stock_qty=3, preordered_qty=0"); sqlite.exec("DELETE FROM order_stock_lines");
  const off = () => call("/api/orders/offline", { method: "upi", items: items(5), ...cust, quoteRef: "QT-OFF" }, { "CF-Connecting-IP": "2.2.2.2" });
  assert.equal((await off()).status, 200); assert.equal((await off()).status, 200);
  o = one("SELECT * FROM orders WHERE txn_id LIKE 'OFF-QT-OFF%'");
  assert.deepEqual(lines(o.id), [{ product_id: P, ready_qty: 3, pre_qty: 2 }]); assert.equal(prod().preordered_qty, 2); assert.equal(prod().stock_qty, 0); assert.equal(o.status, "preorder_confirmed"); assert.equal(o.is_preorder, 1); ok("offline order allocates once, repeat submit does nothing");

  // track
  sqlite.prepare("UPDATE orders SET expected_dispatch='2026-11-01' WHERE id=?").run(o.id);
  sqlite.prepare("INSERT INTO order_events (id,order_id,kind,status,note,public_note,customer_visible,actor,idempotency_key,created_at) VALUES ('d1',?,'dispatch',NULL,'INTERNAL-X','Now 1 Nov',1,'admin','d1',9999999999)").run(o.id);
  const t = await (await call(`/api/track?o=${o.id}&t=${o.track_token}`)).text(), td = JSON.parse(t);
  assert.equal(td.expected_dispatch, "2026-11-01"); assert.equal(td.status_label, "Pre-order confirmed");
  assert.deepEqual(td.items, [{ name: "UHF RFID Label Sticker 27×15mm", qty: 5, ready_qty: 3, pre_qty: 2 }]);
  const j = td.journey.at(-1); assert.equal(j.label, "Expected dispatch updated"); assert.equal(j.note, "Now 1 Nov"); assert.equal(j.status, null);
  for (const s of ["INTERNAL", "9876543210", "a@example.test", "Asha", "Main Street", o.track_token, o.txn_id, "stock_qty", "preordered"]) assert.ok(!t.includes(s), "leaked " + s);
  const plain = await buy(10, pid(), U); const tp = await (await call(`/api/track?o=${plain.id}&t=${plain.track_token}`)).json();
  assert.equal(tp.expected_dispatch, null); assert.deepEqual(Object.keys(tp.items[0]), ["name", "qty"]); ok("track: expected_dispatch, per-item ready/pre, dispatch event, no private data");

  global.fetch = realFetch; console.log(`\nall ${n} preorder checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
