// Fulfilment workflow: transitions, timeline, shipments/AWB, corrections, filters. Run on a fresh local DB after smoke.mjs.
import assert from "node:assert/strict";
const BASE = process.env.BASE || "http://localhost:8799";
const H = { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" };
let cookie = "", n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const call = (p, b) => fetch(BASE + p, { method: b === undefined ? "GET" : "POST", headers: { ...(b === undefined ? {} : H), ...(cookie ? { Cookie: cookie } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
const key = () => crypto.randomUUID();
const ORD = { cash: "22222222-aaaa-bbbb-cccc-000000000002", online: "11111111-aaaa-bbbb-cccc-000000000001", upi: "55555555-aaaa-bbbb-cccc-000000000005", wa: "66666666-aaaa-bbbb-cccc-000000000006", cod: "33333333-aaaa-bbbb-cccc-000000000003", payu: "44444444-aaaa-bbbb-cccc-000000000004" };
const status = (id, to, extra = {}) => call(`/api/orders/${id}/status`, { to, idempotency_key: key(), ...extra });
const get = async (id) => (await call("/api/orders/" + id)).json();

assert.equal((await call(`/api/orders/${ORD.cash}/status`, { to: "processing" })).status, 401);
assert.equal((await call(`/api/orders/${ORD.cash}/ship`, {})).status, 401); ok("status and ship endpoints need a login");
let r = await call("/api/auth/request", { email: "admin@example.test" }); r = await call("/api/auth/verify", { email: "admin@example.test", otp: (await r.json()).dev_otp }); cookie = r.headers.get("set-cookie").split(";")[0];

// actions per state
let d = await get(ORD.cash); assert.equal(d.status, "confirmed");
const to = (o) => o.actions.map((a) => a.to);
assert.deepEqual(to(d), ["processing", "packed", "shipped", "on_hold", "cancelled"]); assert.equal(d.actions.find((a) => a.to === "shipped").form, true); assert.equal(d.actions.find((a) => a.to === "cancelled").confirm, true); ok("confirmed order offers only the relevant actions (ship opens a form, cancel needs confirmation)");
d = await get(ORD.payu); assert.equal(d.status, "delivered"); assert.deepEqual(to(d), ["returned"]); ok("delivered order only offers 'returned'");

// transitions
assert.equal((await status(ORD.cash, "delivered")).status, 409); assert.equal((await status(ORD.payu, "processing")).status, 409); ok("invalid jumps are rejected by the server");
assert.equal((await status(ORD.cash, "shipped")).status, 400); assert.equal((await status(ORD.cash, "banana")).status, 400); assert.equal((await status("00000000-0000-0000-0000-000000000000", "processing")).status, 404); ok("shipping via status, unknown status and unknown order are rejected");
const k1 = key(); r = await call(`/api/orders/${ORD.cash}/status`, { to: "processing", idempotency_key: k1, note: "Picked in warehouse", public_note: "We are preparing your order" }); d = await r.json();
assert.equal(r.status, 200); assert.equal(d.status, "processing"); const ev = d.timeline.filter((t) => t.kind === "status"); assert.equal(ev.length, 1); assert.equal(ev[0].actor, "admin@example.test"); assert.equal(ev[0].public_note, "We are preparing your order"); ok("status change recorded with admin, time, internal and customer notes");
for (let i = 0; i < 3; i++) await call(`/api/orders/${ORD.cash}/status`, { to: "processing", idempotency_key: k1 });
d = await get(ORD.cash); assert.equal(d.timeline.filter((t) => t.kind === "status").length, 1); ok("repeating the same request creates no duplicate timeline event");
const races = await Promise.all(Array.from({ length: 4 }, () => status(ORD.cash, "packed"))); d = await get(ORD.cash);
assert.equal(d.status, "packed"); assert.equal(d.timeline.filter((t) => t.status === "packed").length, 1); ok("4 concurrent 'packed' requests produce exactly one event");
assert.equal(d.payment_status, "unpaid"); assert.equal(d.paid_paise, 0); ok("moving through fulfilment never marks the order paid");
await status(ORD.cash, "on_hold", { note: "Awaiting address check" }); d = await get(ORD.cash); assert.equal(d.status, "on_hold"); assert.deepEqual(to(d), ["confirmed", "processing", "packed", "cancelled"]); ok("on hold can resume or cancel");
assert.equal((await status(ORD.cash, "packed")).status, 200);

// shipping validation
const ship = (id, b) => call(`/api/orders/${id}/ship`, { idempotency_key: key(), courier: "Delhivery", awb: "DL1234567890", shipped_on: "2026-10-11", ...b });
r = await call(`/api/orders/${ORD.cash}/ship`, { idempotency_key: key() }); assert.equal(r.status, 400); let j = await r.json(); assert.ok(j.fields.courier && j.fields.awb && j.fields.shipped_on); ok("courier, AWB and date are required");
for (const [bad, f] of [[{ tracking_url: "http://insecure.example.com/x" }, "tracking_url"], [{ tracking_url: "javascript:alert(1)" }, "tracking_url"], [{ tracking_url: "https://127.0.0.1/x" }, "tracking_url"], [{ tracking_url: "https://user:pw@courier.example.com/x" }, "tracking_url"], [{ awb: "x" }, "awb"], [{ awb: "<script>" }, "awb"], [{ shipped_on: "2026-02-30" }, "shipped_on"], [{ est_delivery: "2026-10-01" }, "est_delivery"]]) {
  r = await ship(ORD.cash, bad); assert.equal(r.status, 400, JSON.stringify(bad)); assert.ok((await r.json()).fields[f], f);
} ok("insecure/odd tracking links, malformed AWB and bad or inconsistent dates are rejected");
assert.equal((await ship(ORD.payu, {})).status, 409); ok("a delivered order cannot be shipped");

// ship
const sk = key(); r = await call(`/api/orders/${ORD.cash}/ship`, { idempotency_key: sk, courier: "Delhivery", awb: "DL1234567890", tracking_url: "https://www.delhivery.com/track/package/DL1234567890", shipped_on: "2026-10-11", est_delivery: "2026-10-14", notes: "Fragile", public_note: "Dispatched with Delhivery" });
d = await r.json(); assert.equal(r.status, 200); assert.equal(d.status, "shipped"); assert.equal(d.courier, "Delhivery"); assert.equal(d.tracking_id, "DL1234567890"); assert.equal(d.shipments.length, 1);
assert.equal(d.shipments[0].tracking_url, "https://www.delhivery.com/track/package/DL1234567890"); assert.equal(d.shipments[0].created_by, "admin@example.test"); ok("shipping saves courier, AWB, tracking link and dates and sets status Shipped");
await call(`/api/orders/${ORD.cash}/ship`, { idempotency_key: sk, courier: "Delhivery", awb: "DL1234567890", shipped_on: "2026-10-11" }); d = await get(ORD.cash); assert.equal(d.shipments.length, 1); assert.equal(d.timeline.filter((t) => t.kind === "shipment").length, 1); ok("replaying the ship request creates no second shipment or event");
r = await ship(ORD.cash, { awb: "dl1234567890" }); assert.equal(r.status, 409); ok("same AWB cannot be added twice to one order");
r = await ship(ORD.cash, { courier: "DTDC", awb: "D9988776655", shipped_on: "2026-10-12" }); d = await r.json(); assert.equal(r.status, 200); assert.equal(d.shipments.length, 2); assert.equal(d.status, "shipped"); ok("a second parcel can be added to an already shipped order");
assert.equal(d.payment_status, "unpaid"); ok("shipping does not change payment status");

// search / filters
let l = await (await call("/api/orders?q=DL1234567890")).json(); assert.equal(l.total, 1); l = await (await call("/api/orders?q=D9988776655")).json(); assert.equal(l.total, 1); assert.equal(l.orders[0].id, ORD.cash); ok("search finds orders by AWB, including secondary parcels");
for (const [view, expect] of [["shipped", (o) => o.status === "shipped"], ["delivered", (o) => o.status === "delivered"], ["payment_pending", (o) => o.payment_status === "unpaid"], ["paid", (o) => o.payment_status === "paid"], ["new", (o) => ["placed", "confirmed"].includes(o.status)]]) {
  l = await (await call("/api/orders?view=" + view)).json(); assert.ok(l.total >= 1, view); assert.ok(l.orders.every(expect), view);
} ok("filter views (shipped, delivered, payment pending, paid, new) return the right orders");
l = await (await call("/api/orders?view=preorders")).json(); assert.equal(l.total, 0); l = await (await call("/api/orders?view=nonsense")).json(); assert.equal(l.total, 6); ok("pre-orders view is empty until used; unknown views are ignored");

// corrections
d = await get(ORD.cash); const sid = d.shipments[1].id;
r = await call(`/api/orders/${ORD.cash}/shipments/${sid}`, { awb: "D1122334455", courier: "DTDC Express" }); d = await r.json(); const sh = d.shipments.find((s) => s.id === sid);
assert.equal(r.status, 200); assert.equal(sh.awb, "D1122334455"); assert.equal(sh.revisions.length, 1); assert.deepEqual(sh.revisions[0].changes.awb, { from: "D9988776655", to: "D1122334455" }); assert.equal(sh.revisions[0].changed_by, "admin@example.test"); ok("AWB/courier correction keeps who, when and old → new");
assert.equal(d.tracking_id, "D1122334455"); assert.equal(d.timeline.filter((t) => t.kind === "shipment_update" && t.customer_visible).length, 0); ok("latest shipment syncs the order list; the correction note stays internal");
r = await call(`/api/orders/${ORD.cash}/shipments/${sid}`, { awb: "DL1234567890" }); assert.equal(r.status, 409); r = await call(`/api/orders/${ORD.cash}/shipments/${sid}`, { tracking_url: "http://bad" }); assert.equal(r.status, 400); ok("corrections are validated too");
d = await (await call(`/api/orders/${ORD.cash}/shipments/${sid}`, { awb: "D1122334455" })).json(); assert.equal(d.shipments.find((s) => s.id === sid).revisions.length, 1); ok("no-op correction adds no history");

// delivery states
d = await get(ORD.cash); assert.deepEqual(to(d), ["out_for_delivery", "delivered", "delivery_failed", "returned"]);
assert.equal((await status(ORD.cash, "out_for_delivery")).status, 200); assert.equal((await status(ORD.cash, "delivery_failed", { public_note: "Customer unavailable" })).status, 200); d = await get(ORD.cash); assert.equal(d.status, "delivery_failed"); ok("delivery failed with a customer-visible reason");
assert.equal((await status(ORD.cash, "out_for_delivery")).status, 200); assert.equal((await status(ORD.cash, "delivered")).status, 200); ok("retry delivery then delivered");
r = await status(ORD.cash, "returned"); assert.equal(r.status, 400); r = await status(ORD.cash, "returned", { confirm: true }); d = await r.json(); assert.equal(d.status, "returned"); assert.deepEqual(d.actions, []); ok("return needs confirmation and ends the workflow");
assert.equal((await status(ORD.cash, "delivered")).status, 409); ok("closed orders cannot change");

// cancel
r = await status(ORD.upi, "cancelled"); assert.equal(r.status, 400); r = await status(ORD.upi, "cancelled", { confirm: true, note: "Customer asked" }); d = await r.json(); assert.equal(d.status, "cancelled"); assert.equal(d.timeline.at(-1).note, "Customer asked"); ok("cancel needs explicit confirmation and keeps the reason");
assert.equal((await ship(ORD.upi, {})).status, 409); ok("cancelled orders cannot be shipped");
assert.equal((await call(`/api/orders/${ORD.online}`)).status, 200); d = await get(ORD.online); assert.equal(d.payment_status, "paid"); assert.equal(d.timeline[0].kind, "placed"); assert.ok(d.timeline.some((t) => t.kind === "payment") === (d.payments.length > 0)); ok("timeline starts with 'Order placed'; payments appear as their own events");
// customer tracking link: detail only
{
  const a = await get(ORD.cash), b = await get(ORD.online);
  const re = /^https:\/\/ntagz\.com\/track\.html\?o=[0-9a-f-]+&t=[0-9a-f]{32}$/;
  assert.match(a.track_url, re); assert.match(b.track_url, re);
  assert.notEqual(a.track_url.split("&t=")[1], b.track_url.split("&t=")[1]);
  const list = await (await call("/api/orders")).text(), csv = await (await call("/api/orders.csv")).text();
  for (const x of [list, csv]) { assert.ok(!x.includes("track_token")); assert.ok(!/[?&]t=/.test(x)); assert.ok(!x.includes(a.track_url.split("&t=")[1])); }
  ok("track_url only on order detail; unique per order; absent from list and CSV");
}
console.log(`\nall ${n} fulfilment checks passed`);
