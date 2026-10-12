// Priority custom-order processing: every order is made to order and carries a working-day target and the date it
// is promised to dispatch. A paid member (or buying membership now) gets the shorter priority target. Priority is
// granted only at a verified payment, never from the cart alone. The business calendar is admin-owned; the engine is pure.
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");
const payments = require(path.join(root, "functions", "api", "[[path]].js"));
const D = require(path.join(root, "functions", "lib", "dispatch.js"));
const { makeDb } = require("./d1shim.cjs");
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const NOW = Math.floor(Date.now() / 1000), DAY = 86400;
const realFetch = global.fetch;
global.fetch = async (url, opts) => String(url).includes("api.razorpay.com") ? Response.json({ id: "order_T" + Math.random().toString(36).slice(2, 11), amount: JSON.parse(opts.body).amount, currency: "INR" }) : realFetch(url, opts);
const hmac = async (secret, msg) => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(msg)))).map((b) => b.toString(16).padStart(2, "0")).join("");

(async () => {
  // ── the engine (pure): weekends, holidays, cut-off, time zone, bad input ──
  const cal = D.fromCfg({ business_timezone: "Asia/Kolkata", business_days: "1,2,3,4,5", business_cutoff: "14:00", business_holidays: "2026-10-20", dispatch_days_standard: "3", dispatch_days_member: "1" });
  assert.equal(D.promisedDispatch(Date.parse("2026-10-16T04:30:00Z"), 1, cal).date, "2026-10-19"); // Fri 10:00 IST, before cut-off -> 1 working day -> Mon (weekend skipped)
  assert.equal(D.promisedDispatch(Date.parse("2026-10-16T04:30:00Z"), 3, cal).date, "2026-10-22"); // 3 working days, skipping the Tue 20 holiday
  assert.equal(D.promisedDispatch(Date.parse("2026-10-16T09:30:00Z"), 1, cal).date, "2026-10-21"); // Fri after 14:00 IST -> counts from Sat -> Mon, +1 (Tue is the holiday) -> Wed
  assert.equal(D.fromCfg({}).standardDays, 3); assert.equal(D.fromCfg({}).memberDays, 1);
  assert.equal(D.fromCfg({ business_timezone: "Bad/Zone" }).timezone, "Asia/Kolkata"); // a bad zone falls back, never throws
  ok("engine: working days skip weekends and holidays; a bad zone/time falls back to safe defaults");

  const run = async (exclude) => {
    const { sqlite, D1, one } = makeDb({ exclude });
    const env = { DB: D1, RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "rzp_secret", PAYU_KEY: "k", PAYU_SALT: "s", PAYU_ENV: "test" };
    const P = (p, body, cookie) => { payments.resetPricingCache(); return payments.onRequest({ request: new Request("https://x" + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: "https://ntagz.com", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }), env }); };
    let uc = 0;
    const user = () => { const id = crypto.randomUUID(); ++uc; sqlite.prepare("INSERT INTO users (id,email) VALUES (?,?)").run(id, `m${uc}@example.test`); sqlite.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)").run("s-" + id, id, NOW + DAY); return { id, cookie: "ntagz_session=s-" + id }; };
    const member = () => { const u = user(); sqlite.prepare("INSERT INTO memberships (id,user_id,status,purchased_at,expires_at,welcome_credit_paise,price_paid,payment_id) VALUES (?,?,'active',?,?,0,99900,'x')").run(crypto.randomUUID(), u.id, NOW - 40 * DAY, NOW + 300 * DAY); return u; };
    const setCfg = (k, v) => { sqlite.prepare("INSERT INTO membership_config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v); payments.resetPricingCache(); };
    sqlite.exec("UPDATE products SET track_stock=0, price_paise=10000, member_discount_pct=10 WHERE id='black-nfc-card'");
    return { sqlite, D1, one, env, P, user, member, setCfg };
  };

  // ── migrated database ──
  let t = await run();
  t.setCfg("discounts_live", "1");
  const items = [{ id: "black-nfc-card", qty: 10 }];
  const cust = { name: "Asha T", phone: "9876543210", address: "1 Main Street, Pune", pincode: "411001", state: "Maharashtra", email: "a@example.test", quoteRef: "QT-1" };

  let r = await t.P("/api/quote", { items, state: "Maharashtra" }); let d = await r.json();
  assert.equal(r.status, 200); assert.equal(d.dispatch.standardDays, 3); assert.equal(d.dispatch.memberDays, 1); assert.equal(d.dispatch.timezone, "Asia/Kolkata");
  assert.match(d.dispatch.standardDate, /^\d{4}-\d{2}-\d{2}$/); assert.match(d.dispatch.memberDate, /^\d{4}-\d{2}-\d{2}$/);
  ok("a quote reports the working-day build times and an estimated date for display (never money)");

  // non-member order: standard target frozen on the intent, recorded on the order at payment
  r = await t.P("/api/create-order", { items, ...cust }); assert.equal(r.status, 200); const rz = await r.json();
  let intent = t.one("SELECT * FROM checkout_intents WHERE txn_id=?", rz.id);
  assert.equal(intent.processing_target_days, 3); assert.equal(intent.priority_build, 0); ok("a non-member order is frozen at the standard 3 working days");
  r = await t.P("/api/verify-payment", { razorpay_order_id: rz.id, razorpay_payment_id: "p1", razorpay_signature: await hmac("rzp_secret", `${rz.id}|p1`) }); assert.equal(r.status, 200);
  let o = t.one("SELECT * FROM orders WHERE txn_id=?", rz.id);
  assert.equal(o.processing_target_days, 3); assert.equal(o.priority_build, 0); assert.match(o.promised_dispatch, /^\d{4}-\d{2}-\d{2}$/);
  ok("at the verified payment the order records its target and its promised dispatch date");

  // paid member: priority target
  const m = t.member();
  r = await t.P("/api/create-order", { items, ...cust, quoteRef: "QT-2" }, m.cookie); assert.equal(r.status, 200); const rz2 = await r.json();
  intent = t.one("SELECT * FROM checkout_intents WHERE txn_id=?", rz2.id);
  assert.equal(intent.processing_target_days, 1); assert.equal(intent.priority_build, 1); ok("a paid member's order is frozen at the priority 1 working day");
  await t.P("/api/verify-payment", { razorpay_order_id: rz2.id, razorpay_payment_id: "p2", razorpay_signature: await hmac("rzp_secret", `${rz2.id}|p2`) }, m.cookie);
  const om = t.one("SELECT * FROM orders WHERE txn_id=?", rz2.id);
  assert.equal(om.processing_target_days, 1); assert.equal(om.priority_build, 1);
  assert.ok(om.promised_dispatch <= o.promised_dispatch); ok("priority promises an earlier-or-equal dispatch date than a standard order");

  // the admin calendar flows through with no deploy
  t.setCfg("dispatch_days_standard", "5");
  r = await t.P("/api/quote", { items, state: "Maharashtra" }); d = await r.json();
  assert.equal(d.dispatch.standardDays, 5); ok("the admin's working-day target flows to the quote immediately");

  // the checkout selector is told the build-time difference
  t.setCfg("checkout_offer", "1");
  const u = t.user();
  r = await t.P("/api/quote", { items, state: "Maharashtra", offer: true }, u.cookie); d = await r.json();
  assert.equal(d.membershipOffer.standardDays, 5); assert.equal(d.membershipOffer.memberDays, 1);
  ok("the membership comparison carries the working-day build times (no rupee value attached)");

  // offline (unpaid) order: standard target, no queue-jump before payment is verified
  r = await t.P("/api/orders/offline", { method: "upi", items, ...cust, quoteRef: "QT-3" }); assert.equal(r.status, 200);
  o = t.one("SELECT * FROM orders WHERE txn_id='OFF-QT-3-9876543210'");
  assert.equal(o.processing_target_days, 5); assert.equal(o.priority_build, 0); assert.match(o.promised_dispatch, /^\d{4}-\d{2}-\d{2}$/);
  ok("an offline order gets the standard target — priority is never granted before a verified payment");

  // tracking exposes the promise to the customer
  const oid = t.one("SELECT id FROM orders WHERE txn_id=?", rz.id).id;
  t.sqlite.prepare("UPDATE orders SET track_token=? WHERE id=?").run("a".repeat(32), oid);
  r = await t.P("/api/track?o=" + oid + "&t=" + "a".repeat(32)); assert.equal(r.status, 200); d = await r.json();
  assert.equal(d.processing_target_days, 3); assert.equal(d.priority_build, false); assert.match(d.promised_dispatch, /^\d{4}-\d{2}-\d{2}$/);
  ok("order tracking exposes the working-day target and the promised dispatch date");

  // ── database without migration 0018: everything still works, the promise is simply absent ──
  let t0 = await run(["0018_processing.sql"]);
  t0.setCfg("discounts_live", "1");
  r = await t0.P("/api/quote", { items, state: "Maharashtra" }); d = await r.json();
  assert.equal(r.status, 200); assert.equal(d.dispatch.standardDays, 3); assert.equal(d.dispatch.memberDays, 1); ok("pre-migration DB: the quote still answers with default build times");
  r = await t0.P("/api/create-order", { items, ...cust }); assert.equal(r.status, 200); const rz0 = await r.json();
  const i0 = t0.one("SELECT * FROM checkout_intents WHERE txn_id=?", rz0.id); assert.equal(i0.processing_target_days, undefined); ok("pre-migration DB: the intent is stored without the processing columns (no crash)");
  r = await t0.P("/api/verify-payment", { razorpay_order_id: rz0.id, razorpay_payment_id: "p0", razorpay_signature: await hmac("rzp_secret", `${rz0.id}|p0`) }); assert.equal(r.status, 200);
  const o0 = t0.one("SELECT * FROM orders WHERE txn_id=?", rz0.id); assert.equal(o0.promised_dispatch, undefined); ok("pre-migration DB: the order is still recorded; the promise is absent until 0018 is applied");

  global.fetch = realFetch; console.log(`\nall ${n} dispatch checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
