// Customer notifications: which actions email, no duplicates, skipped without an email, failures never block. Fresh local DB.
import assert from "node:assert/strict";
import { buildMessage, notify, STATUS_EVENT } from "../src/notify.js";
const BASE = process.env.BASE || "http://localhost:8811";
const H = { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" };
let cookie = "", n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const call = (p, b) => fetch(BASE + p, { method: b === undefined ? "GET" : "POST", headers: { ...(b === undefined ? {} : H), Cookie: cookie }, body: b === undefined ? undefined : JSON.stringify(b) });
const key = () => crypto.randomUUID();
const get = async (id) => (await call("/api/orders/" + id)).json();
const status = (id, to, extra = {}) => call(`/api/orders/${id}/status`, { to, idempotency_key: key(), ...extra });
const mails = (o) => o.notifications.map((x) => `${x.event}:${x.status}`);
const ASHA = "11111111-aaaa-bbbb-cccc-000000000001", WALI = "66666666-aaaa-bbbb-cccc-000000000006", UMA = "55555555-aaaa-bbbb-cccc-000000000005";

// ── message content (pure) ──
const o = { id: "abcdef12-0000-0000-0000-000000000000", name: "<b>Asha</b> Rao", track_token: "a".repeat(32), expected_dispatch: "2026-11-15" };
let m = buildMessage("shipped", o, { courier: "Delhivery", awb: "DL123", tracking_url: "https://www.delhivery.com/t/DL123", est_delivery: "2026-10-14" });
assert.match(m.text, /Order: abcdef12/); assert.match(m.text, /AWB: DL123/); assert.match(m.text, /Track your order: https:\/\/ntagz\.com\/track\.html\?o=abcdef12-0000-0000-0000-000000000000&t=a{32}/);
assert.match(m.text, /Courier tracking: https:\/\/www\.delhivery\.com/); assert.match(m.text, /14 Oct 2026 \(an estimate, not a guarantee\)/); assert.ok(!m.html.includes("<b>Asha")); assert.match(m.html, /&lt;b&gt;Asha/); ok("message has order id, AWB, track link, courier link, estimate wording; customer name is HTML-escaped");
m = buildMessage("shipped", o, { courier: "X", awb: "A1", tracking_url: "javascript:alert(1)" }); assert.ok(!/javascript:/.test(m.text + m.html)); m = buildMessage("shipped", o, { awb: "A1", tracking_url: "http://insecure.example.com" }); assert.ok(!/insecure/.test(m.text)); ok("only https courier links are included");
m = buildMessage("dispatch_updated", o); assert.match(m.text, /Expected dispatch: 15 Nov 2026 \(not a delivery date\)/); ok("dispatch email says expected dispatch, not delivery");
assert.deepEqual(Object.keys(STATUS_EVENT).sort(), ["confirmed", "delivered", "delivery_failed", "out_for_delivery", "packed", "preorder_confirmed", "ready_to_pack"].sort()); ok("only meaningful statuses notify (not processing / on hold / cancelled / returned)");
assert.equal(await notify({}, "x", "nope", "k"), "ignored"); assert.equal(await notify({ DB: { prepare() { throw new Error("D1 down"); } } }, "x", "packed", "k"), "error"); ok("unknown event ignored; a database error never throws");

// ── through the admin API ──
let r = await call("/api/auth/request", { email: "admin@example.test" }); r = await call("/api/auth/verify", { email: "admin@example.test", otp: (await r.json()).dev_otp }); cookie = r.headers.get("set-cookie").split(";")[0];
let d = await get(ASHA); assert.deepEqual(d.notifications, []);
assert.equal((await status(ASHA, "processing")).status, 200); d = await get(ASHA); assert.deepEqual(mails(d), []); ok("processing sends nothing");
const k = key(); r = await call(`/api/orders/${ASHA}/status`, { to: "packed", idempotency_key: k }); d = await r.json(); assert.deepEqual(mails(d), ["packed:sent"]); assert.match(d.notifications[0].subject, /packed/i);
await call(`/api/orders/${ASHA}/status`, { to: "packed", idempotency_key: k }); d = await get(ASHA); assert.equal(d.notifications.length, 1); ok("packing emails once; replaying the request sends no second email");
r = await call(`/api/orders/${ASHA}/ship`, { idempotency_key: key(), courier: "Delhivery", awb: "DL1234567890", tracking_url: "https://www.delhivery.com/t/DL1234567890", shipped_on: "2026-10-11" }); d = await r.json(); assert.deepEqual(mails(d), ["packed:sent", "shipped:sent"]);
r = await call(`/api/orders/${ASHA}/ship`, { idempotency_key: key(), courier: "DTDC", awb: "D0011223344", shipped_on: "2026-10-11" }); d = await r.json(); assert.equal(d.notifications.filter((x) => x.event === "shipped").length, 2); ok("shipping emails with the AWB; a second parcel emails its own AWB");
for (const to of ["out_for_delivery", "delivered"]) assert.equal((await status(ASHA, to)).status, 200); d = await get(ASHA); assert.deepEqual(mails(d).slice(-2), ["out_for_delivery:sent", "delivered:sent"]); ok("out for delivery and delivered each email");
r = await status(ASHA, "returned", { confirm: true }); d = await r.json(); assert.equal(d.notifications.length, 5); ok("returns send nothing");

// no customer email: action works, notification is recorded as skipped
r = await status(WALI, "packed"); d = await r.json(); assert.equal(r.status, 200); assert.equal(d.status, "packed"); assert.deepEqual(mails(d), ["packed:skipped"]); assert.equal(d.notifications[0].detail, "no customer email"); ok("order with no email: status change succeeds, notification recorded as skipped");
// race: 4 concurrent identical transitions -> one email
const U2 = "22222222-aaaa-bbbb-cccc-000000000002"; await Promise.all(Array.from({ length: 4 }, () => status(U2, "packed"))); d = await get(U2); assert.equal(d.notifications.filter((x) => x.event === "packed").length, 1); ok("4 concurrent packed requests send exactly one email");
// payment confirmed
r = await call(`/api/orders/${UMA}/payment-received`, { confirm_amount_paise: 23600, method: "upi", reference: "UTR998877", idempotency_key: key() }); d = await r.json(); assert.deepEqual(mails(d), ["payment_confirmed:sent"]); ok("recording a payment emails the customer");
// cancel silent
r = await status(U2, "cancelled", { confirm: true }); d = await r.json(); assert.deepEqual(mails(d), ["packed:sent"]); ok("cancelling sends no automatic email");
console.log(`\nall ${n} notification checks passed`);
