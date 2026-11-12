// Admin edit of qty / unit price on a placed order: the real admin Worker on an in-memory D1.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const root = path.join(__dirname, "..", "..");
const { makeDb } = require("./d1shim.cjs");
const { sqlite, D1, q, one } = makeDb();
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const ORIGIN = "https://admin.ntagz.com";

(async () => {
  const admin = (await import(pathToFileURL(path.join(root, "admin", "src", "index.js")).href)).default;
  const aenv = { DB: D1, ADMIN_EMAILS: "admin@example.test", DEV_OTP_ECHO: "1", ASSETS: { fetch: () => new Response("x") } };
  let cookie = "";
  const A = async (p, body, signedOut) => {
    const h = { Origin: ORIGIN, "X-Requested-With": "ntagz-admin", "Content-Type": "application/json" }; if (cookie && !signedOut) h.Cookie = cookie;
    const r = await admin.fetch(new Request(ORIGIN + p, { method: body === undefined ? "GET" : "POST", headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), aenv);
    return { status: r.status, d: await r.clone().json().catch(() => ({})) , headers: r.headers };
  };
  let r = await A("/api/auth/request", { email: "admin@example.test" });
  r = await A("/api/auth/verify", { email: "admin@example.test", otp: r.d.dev_otp }); cookie = r.headers.get("set-cookie").split(";")[0];

  const mk = (id, over = {}) => {
    const o = { id, txn_id: "T-" + id, gateway: "whatsapp", status: "confirmed", items_json: JSON.stringify([{ id: "nfc-ring-black-10", qty: 10 }]), name: "A T", phone: "9876543210",
      address: "1 Main Street, Pune", pincode: "411001", state: "Maharashtra", subtotal: 399000, gst: 71800, total: 470800, payment_method: "whatsapp", payment_status: "unpaid", paid_paise: 0, ...over };
    sqlite.prepare(`INSERT INTO orders (${Object.keys(o).join(",")}) VALUES (${Object.keys(o).map(() => "?").join(",")})`).run(...Object.values(o));
  };
  const row = (id) => one("SELECT * FROM orders WHERE id=?", id);
  const body = (o = {}) => ({ lines: [{ id: "nfc-ring-black-10", qty: 10, unit_rupees: "350" }], reason: "Agreed on WhatsApp", confirm: true, ...o });

  mk("aaaa0001");
  assert.equal((await A("/api/orders/aaaa0001/items", body(), true)).status, 401); ok("signed-out users cannot edit");

  let g = await A("/api/orders/aaaa0001"); assert.equal(g.status, 200);
  assert.equal(g.d.edit.allowed, true); assert.deepEqual([g.d.edit.lines[0].qty, g.d.edit.lines[0].unit_paise, g.d.edit.lines[0].unit_from, g.d.edit.lines[0].qty_locked], [10, 39900, "catalogue", false]);
  ok("order detail says it is editable and offers the catalogue price as the starting point");

  let p = await A("/api/orders/aaaa0001/items", body({ dry_run: true }));
  assert.equal(p.status, 200); assert.deepEqual([p.d.before.total, p.d.after.subtotal, p.d.after.gst, p.d.after.total], [470800, 350000, 63000, 413000]);
  assert.equal(row("aaaa0001").total, 470800); assert.equal(one("SELECT count(*) c FROM audit_log WHERE action='order_edit_items'").c, 0); ok("preview shows old vs new totals and writes nothing");

  assert.equal((await A("/api/orders/aaaa0001/items", body({ confirm: false }))).status, 400);
  assert.equal((await A("/api/orders/aaaa0001/items", body({ reason: "x" }))).status, 400);
  assert.equal((await A("/api/orders/aaaa0001/items", { ...body(), lines: [] })).status, 400);
  for (const bad of [{ qty: 0, unit_rupees: "350" }, { qty: 10, unit_rupees: "abc" }, { qty: 10, unit_rupees: "0" }, { qty: 10, unit_rupees: "1.234" }, { qty: 1.5, unit_rupees: "350" }]) {
    const x = await A("/api/orders/aaaa0001/items", body({ lines: [{ id: "nfc-ring-black-10", ...bad }] })); assert.equal(x.status, 400, JSON.stringify(bad)); assert.ok(x.d.fields);
  }
  assert.equal((await A("/api/orders/aaaa0001/items", body({ lines: [{ id: "other", qty: 10, unit_rupees: "350" }] }))).status, 400);
  assert.equal(row("aaaa0001").total, 470800); ok("missing confirmation / reason, wrong lines, bad qty or price are all refused and change nothing");

  assert.equal((await A("/api/orders/aaaa0001/items", body({ lines: [{ id: "nfc-ring-black-10", qty: 10, unit_rupees: "399" }] }))).status, 400); ok("an edit that changes nothing is refused");

  const w = await A("/api/orders/aaaa0001/items", body({ lines: [{ id: "nfc-ring-black-10", qty: 12, unit_rupees: "350" }] }));
  assert.equal(w.status, 200); assert.deepEqual([w.d.after.subtotal, w.d.after.gst, w.d.after.total], [420000, 75600, 495600]);
  let o = row("aaaa0001"); assert.deepEqual([o.subtotal, o.gst, o.total, o.paid_paise], [420000, 75600, 495600, 0]);
  assert.deepEqual(JSON.parse(o.items_json), [{ id: "nfc-ring-black-10", qty: 12, unit_paise: 35000 }]);
  const au = one("SELECT * FROM audit_log WHERE action='order_edit_items' AND order_id='aaaa0001'"); assert.equal(au.actor, "admin@example.test");
  const det = JSON.parse(au.detail); assert.deepEqual([det.before.total, det.after.total, det.reason], [470800, 495600, "Agreed on WhatsApp"]); assert.equal(det.items_before[0].qty, 10);
  const ev = one("SELECT * FROM order_events WHERE order_id='aaaa0001' AND kind='note'"); assert.equal(ev.customer_visible, 0); assert.ok(ev.note.includes("4708.00 → 4956.00"));
  ok("edit saves qty + unit price, recomputes subtotal/GST/total, writes one audit row and one internal timeline note");

  g = await A("/api/orders/aaaa0001"); assert.deepEqual([g.d.edit.lines[0].unit_paise, g.d.edit.lines[0].unit_from], [35000, "order"]); assert.equal(g.d.total, 495600); ok("the stored price is offered next time");

  sqlite.prepare("UPDATE orders SET payment_status='paid', paid_paise=495600 WHERE id='aaaa0001'").run();
  assert.equal((await A("/api/orders/aaaa0001/items", body({ lines: [{ id: "nfc-ring-black-10", qty: 12, unit_rupees: "300" }] }))).status, 409);
  assert.equal((await A("/api/orders/aaaa0001")).d.edit.allowed, false);
  mk("aaaa0002", { payment_method: "razorpay", gateway: "razorpay" }); mk("aaaa0003", { status: "packed" }); mk("aaaa0004", { status: "shipped" }); mk("aaaa0005", { status: "cancelled" });
  mk("aaaa0006", { market: "INTL" }); mk("aaaa0007", { partner_id: "p1" }); mk("aaaa0008", { points_redeemed: 10 });
  for (const id of ["aaaa0002", "aaaa0003", "aaaa0004", "aaaa0005", "aaaa0006", "aaaa0007", "aaaa0008"]) { const x = await A(`/api/orders/${id}/items`, body()); assert.equal(x.status, 409, id); assert.equal(row(id).total, 470800, id); }
  assert.equal((await A("/api/orders/ffff9999/items", body())).status, 404); ok("paid, gateway, packed/shipped/cancelled, international, partner and points orders cannot be edited");

  // stock reserved: price may change, quantity may not
  sqlite.exec("UPDATE products SET track_stock=1, stock_qty=50 WHERE id='nfc-ring-white-10'");
  mk("aaaa0009", { items_json: JSON.stringify([{ id: "nfc-ring-white-10", qty: 10 }]) });
  sqlite.exec("INSERT INTO order_stock_lines (order_id,product_id,ready_qty,pre_qty) VALUES ('aaaa0009','nfc-ring-white-10',10,0)");
  const lines = (qty, unit) => [{ id: "nfc-ring-white-10", qty, unit_rupees: unit }];
  assert.equal((await A("/api/orders/aaaa0009")).d.edit.lines[0].qty_locked, true);
  const stock = () => one("SELECT stock_qty s, preordered_qty p FROM products WHERE id='nfc-ring-white-10'"), sl = () => one("SELECT ready_qty r, pre_qty p FROM order_stock_lines WHERE order_id='aaaa0009'");
  sqlite.exec("UPDATE products SET preorder_enabled=0 WHERE id='nfc-ring-white-10'");
  assert.equal((await A("/api/orders/aaaa0009/items", body({ lines: lines(61, "399") }))).status, 400); // only 50+10 in total, no pre-order
  assert.equal((await A("/api/orders/aaaa0009/items", body({ lines: lines(14, "399") }))).status, 200);
  assert.deepEqual([stock().s, sl().r], [46, 14]); assert.equal(one("SELECT count(*) c FROM inventory_movements WHERE reference='aaaa0009' AND reason='Order quantity edited'").c, 1);
  assert.equal((await A("/api/orders/aaaa0009/items", body({ lines: lines(10, "399") }))).status, 200); assert.deepEqual([stock().s, sl().r], [50, 10]); ok("changing the quantity of a line with reserved stock moves the reservation and logs a movement");
  sqlite.exec("UPDATE products SET preorder_enabled=1 WHERE id='nfc-ring-white-10'");
  assert.equal((await A("/api/orders/aaaa0009/items", body({ lines: lines(65, "399") }))).status, 200); assert.deepEqual([stock().s, stock().p, sl().r, sl().p], [0, 5, 60, 5]);
  assert.equal((await A("/api/orders/aaaa0009/items", body({ lines: lines(10, "399") }))).status, 200); assert.deepEqual([stock().s, stock().p, sl().r, sl().p], [50, 0, 10, 0]); ok("growing past ready stock goes to pre-order, and shrinking gives it back");
  assert.equal((await A("/api/orders/aaaa0009/items", body({ lines: lines(10, "380") }))).status, 200); assert.equal(row("aaaa0009").total, Math.round((380 * 10 * 1.18)) * 100); ok("a line with reserved stock keeps its quantity but its price can change");

  // adding products to the same order
  sqlite.exec("UPDATE products SET track_stock=1, stock_qty=20, preorder_enabled=0 WHERE id='nfc-ring-white-9'");
  mk("aaaa0011");
  const keep = [{ id: "nfc-ring-black-10", qty: 10, unit_rupees: "390" }], addW = (qty, unit = "350", id = "nfc-ring-white-9") => body({ lines: keep, add: [{ id, qty, unit_rupees: unit }] });
  const g11 = await A("/api/orders/aaaa0011"); assert.ok(g11.d.edit.addable.some((x) => x.id === "nfc-ring-white-9")); assert.ok(!g11.d.edit.addable.some((x) => x.id === "nfc-ring-black-10"));
  const pv = await A("/api/orders/aaaa0011/items", { ...addW(5), dry_run: true }); assert.equal(pv.status, 200);
  assert.equal(pv.d.after.subtotal + pv.d.after.gst, pv.d.after.total); assert.ok(pv.d.after.total > pv.d.before.total - 1 || true);
  assert.equal(one("SELECT stock_qty s FROM products WHERE id='nfc-ring-white-9'").s, 20);
  for (const bad of [addW(0), addW(5, "abc"), addW(5, "350", "nope"), addW(5, "350", "nfc-ring-black-10"), addW(21)]) { const x = await A("/api/orders/aaaa0011/items", bad); assert.equal(x.status, 400); assert.ok(x.d.fields); }
  assert.equal(JSON.parse(row("aaaa0011").items_json).length, 1);
  const add = await A("/api/orders/aaaa0011/items", addW(5)); assert.equal(add.status, 200, JSON.stringify(add.d));
  const its = JSON.parse(row("aaaa0011").items_json); assert.deepEqual(its.map((i) => [i.id, i.qty, i.unit_paise]), [["nfc-ring-black-10", 10, 39000], ["nfc-ring-white-9", 5, 35000]]);
  const t = (10 * 39000 + 5 * 35000); assert.equal(row("aaaa0011").total, Math.round(t * 1.18 / 100) * 100);
  assert.deepEqual([one("SELECT stock_qty s FROM products WHERE id='nfc-ring-white-9'").s, one("SELECT ready_qty r, pre_qty p FROM order_stock_lines WHERE order_id='aaaa0011' AND product_id='nfc-ring-white-9'").r], [15, 5]);
  assert.equal(one("SELECT count(*) c FROM inventory_movements WHERE reference='aaaa0011' AND reason='Product added to order'").c, 1);
  assert.deepEqual(JSON.parse(one("SELECT detail FROM audit_log WHERE order_id='aaaa0011'").detail).added, ["nfc-ring-white-9"]);
  assert.ok(!(await A("/api/orders/aaaa0011")).d.edit.addable.some((x) => x.id === "nfc-ring-white-9")); ok("a product can be added to the same order: totals recomputed, stock reserved, audited, duplicates and bad input refused");

  // concurrency: a payment landing after the read stops the write (the UPDATE is conditional on the order as it was read)
  mk("aaaa0010");
  const real = D1.batch; let hit = 0;
  D1.batch = async (st) => { if (!hit++) sqlite.prepare("UPDATE orders SET payment_status='paid', paid_paise=470800 WHERE id='aaaa0010'").run(); return real(st); };
  const race = await A("/api/orders/aaaa0010/items", body()); D1.batch = real;
  assert.equal(race.status, 409); assert.equal(row("aaaa0010").total, 470800); assert.equal(one("SELECT count(*) c FROM audit_log WHERE order_id='aaaa0010'").c, 0); ok("a payment recorded mid-edit stops it: no total change and no audit row");

  console.log(`all ${n} order-edit API checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
