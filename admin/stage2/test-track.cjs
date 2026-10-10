// Public order tracking: GET /api/track?o=&t= . In-memory D1 shim.
const assert = require("node:assert/strict");
const path = require("node:path");
const worker = require(path.join(__dirname, "..", "..", "functions", "api", "[[path]].js"));
const { makeDb } = require("./d1shim.cjs");
const { sqlite, D1, one } = makeDb();
const env = { DB: D1 };
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const call = (qs, e = env, method = "GET") => worker.onRequest({ request: new Request("https://x/api/track" + qs, { method, headers: { Origin: "https://www.ntagz.com" } }), env: e });

const OID = "0a1b2c3d-1111-2222-3333-444455556666";
sqlite.exec(`INSERT INTO orders (id, txn_id, gateway, status, items_json, name, phone, email, address, pincode, state, total, created_at, payment_status, is_preorder)
  VALUES ('${OID}', 'TXN-SECRET-1', 'razorpay', 'shipped', '[{"id":"black-nfc-card","qty":3},{"id":"ghost-id","qty":1}]', 'Asha Test', '9876543210', 'asha@example.test', '1 Secret Street', '411001', 'Maharashtra', 12345, 1000, 'paid', 1)`);
const token = one("SELECT track_token t FROM orders WHERE id=?", OID).t;
assert.match(token, /^[0-9a-f]{32}$/);
sqlite.exec(`INSERT INTO payments (id, order_id, method, amount_paise, recorded_by, idempotency_key, created_at) VALUES ('p1','${OID}','razorpay',12345,'system','k1',1100)`);
sqlite.exec(`INSERT INTO shipments (id, order_id, courier, awb, tracking_url, shipped_on, est_delivery, notes, created_by) VALUES ('s1','${OID}','DTDC','AWB123','https://t.example/AWB123','2026-10-01','2026-10-05','INTERNAL-SHIP-NOTE','admin')`);
const ev = (id, kind, status, note, pub, vis, at) => sqlite.prepare("INSERT INTO order_events (id, order_id, kind, status, note, public_note, customer_visible, actor, idempotency_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, OID, kind, status, note, pub, vis, "admin", id, at);
ev("e1", "status", "confirmed", "INTERNAL-NOTE-1", null, 1, 1200);
ev("e2", "shipment", "shipped", "INTERNAL-NOTE-2", "Handed to DTDC", 1, 1500);
ev("e3", "status", "packed", "INTERNAL-NOTE-3", "HIDDEN-PUBLIC", 0, 1300);
ev("e4", "note", null, "INTERNAL-NOTE-4", "NOTE-KIND-PUBLIC", 1, 1400);

(async () => {
  let r = await call(`?o=${OID}&t=${token}`); assert.equal(r.status, 200);
  const raw = await r.text(), d = JSON.parse(raw);
  assert.equal(d.ref, "0a1b2c3d"); assert.equal(d.status, "shipped"); assert.equal(d.status_label, "Shipped"); assert.equal(d.payment_status, "paid");
  assert.equal(d.is_preorder, true); assert.equal(d.total_paise, 12345); assert.equal(d.placed_at, 1000);
  assert.deepEqual(d.ship_to, { state: "Maharashtra", pincode: "411001" });
  assert.equal(d.items[0].qty, 3); assert.notEqual(d.items[0].name, "black-nfc-card"); assert.deepEqual(d.items[1], { name: "ghost-id", qty: 1 });
  ok("valid token returns the order (names resolved, id fallback)");
  assert.deepEqual(d.shipments, [{ courier: "DTDC", awb: "AWB123", tracking_url: "https://t.example/AWB123", shipped_on: "2026-10-01", est_delivery: "2026-10-05" }]); ok("shipment appears");
  assert.deepEqual(d.journey.map((j) => [j.label, j.at, j.note]), [["Order placed", 1000, null], ["Payment received", 1100, null], ["Confirmed", 1200, null], ["Shipped", 1500, "Handed to DTDC"]]); ok("journey sorted, customer-visible status/shipment events only");
  assert.deepEqual(d.journey.filter((j) => j.status).map((j) => j.status), ["confirmed", "shipped"]); ok("status events carry their status key for the timeline");
  for (const s of ["INTERNAL", "HIDDEN-PUBLIC", "NOTE-KIND", "9876543210", "asha@example.test", "Asha", "Secret Street", "TXN-SECRET", token, OID]) assert.ok(!raw.includes(s), "leaked " + s);
  ok("no phone/email/name/address/token/txn id/internal notes/full id in body");
  assert.equal(r.headers.get("Cache-Control"), "no-store"); ok("no-store");

  const bad = [`?o=${OID}&t=${"0".repeat(32)}`, `?o=0a1b2c3d-1111-2222-3333-000000000000&t=${token}`, "", `?o=${OID}`, `?t=${token}`, `?o=${OID}&t=${token.toUpperCase()}`, `?o=${OID}&t=short`, `?o='%20OR%201=1--&t=${token}`];
  for (const qs of bad) { r = await call(qs); assert.equal(r.status, 404); assert.equal(await r.text(), '{"error":"Not found"}'); assert.equal(r.headers.get("Cache-Control"), "no-store"); }
  ok("wrong token / wrong id / missing / malformed all give the identical 404");

  assert.equal((await call(`?o=${OID}&t=${token}`, env, "POST")).status, 405); ok("read-only");
  assert.equal((await call(`?o=${OID}&t=${token}`, { ...env, DB: undefined })).status, 503); ok("no DB -> 503");
  const broken = { DB: { prepare() { throw new Error("D1 secret detail"); } } };
  r = await call(`?o=${OID}&t=${token}`, broken); assert.equal(r.status, 503); assert.ok(!(await r.text()).includes("secret detail")); assert.equal(r.headers.get("Cache-Control"), "no-store"); ok("query failure -> 503, no detail leaked");
  console.log(`\nall ${n} track checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
