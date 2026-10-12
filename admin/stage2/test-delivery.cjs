// Pune-origin delivery estimate, mirroring what the storefront promises: the checkout quote returns a delivery window
// built from the working-day dispatch date + a Pune-origin calendar-day transit table; members (priority build) get the
// express courier tier (one day less); the tracking page shows the per-shipment estimated delivery the admin recorded.
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");
const payments = require(path.join(root, "functions", "api", "[[path]].js"));
const DV = require(path.join(root, "functions", "lib", "delivery.js"));
const { makeDb } = require("./d1shim.cjs");
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const NOW = Math.floor(Date.now() / 1000), DAY = 86400;
const realFetch = global.fetch;
global.fetch = async (url, opts) => String(url).includes("api.razorpay.com") ? Response.json({ id: "order_T" + Math.random().toString(36).slice(2, 11), amount: JSON.parse(opts.body).amount, currency: "INR" }) : realFetch(url, opts);

(async () => {
  // ── the engine (pure): Pune origin, region tiers, priority express tier, calendar (not working-day) transit ──
  assert.equal(DV.transitFor("411001"), 1);
  assert.equal(DV.transitFor("400001"), 2);   // Mumbai (Maharashtra)
  assert.equal(DV.transitFor("440010"), 2);   // Nagpur (Maharashtra)
  assert.equal(DV.transitFor("110001"), 3);   // Delhi NCR
  assert.equal(DV.transitFor("560001"), 3);   // Bengaluru
  assert.equal(DV.transitFor("600001"), 3);   // Chennai
  assert.equal(DV.transitFor("700091"), 3);   // Kolkata
  assert.equal(DV.transitFor("781001"), 6);   // North-east
  assert.equal(DV.transitFor("190001"), 6);   // Jammu
  assert.equal(DV.transitFor("461001"), 5);   // default rest-of-India
  assert.equal(DV.transitFor("411001", true), 1); // priority cannot go under one day
  assert.equal(DV.transitFor("560001", true), 2); // express = one day faster
  assert.equal(DV.transitFor("12345"), null);
  assert.equal(DV.deliveryDate("2026-10-14", 3), "2026-10-17");
  ok("engine: Pune-origin transit tiers, express tier one day faster, calendar-day add, invalid pincode rejected");

  const run = async () => {
    const { sqlite, D1 } = makeDb({ });
    const env = { DB: D1, RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "rzp_secret", PAYU_KEY: "k", PAYU_SALT: "s", PAYU_ENV: "test" };
    const P = (p, body) => { payments.resetPricingCache(); return payments.onRequest({ request: new Request("https://x" + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: "https://ntagz.com" }, body: body ? JSON.stringify(body) : undefined }), env }); };
    sqlite.prepare("INSERT INTO membership_config (key,value) VALUES ('checkout_offer','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    sqlite.exec("UPDATE products SET track_stock=0, price_paise=10000, member_discount_pct=10 WHERE id='black-nfc-card'");
    return { sqlite, P };
  };
  const t = await run();
  const items = [{ id: "black-nfc-card", qty: 10 }];

  // no pincode -> no delivery estimate (the promise still shows)
  let r = await t.P("/api/quote", { items, state: "Maharashtra" }); let d = await r.json();
  assert.equal(r.status, 200); assert.equal(d.dispatch.delivery, undefined); ok("a quote without a pincode omits the delivery estimate");

  // Pune pincode: same-city estimate, member = express tier (earlier window)
  r = await t.P("/api/quote", { items, state: "Maharashtra", pincode: "411001" }); d = await r.json();
  assert.equal(r.status, 200);
  const std = d.dispatch.delivery.standard, mem = d.dispatch.delivery.member;
  assert.equal(std.transitDays, 1); assert.equal(mem.transitDays, 1);
  assert.match(std.from, /^\d{4}-\d{2}-\d{2}$/); assert.match(std.to, /^\d{4}-\d{2}-\d{2}$/);
  ok("a Pune pincode gives a same-city standard estimate (1 transit day)");

  r = await t.P("/api/quote", { items, state: "Maharashtra", pincode: "560001" }); d = await r.json();
  assert.equal(d.dispatch.delivery.standard.transitDays, 3); assert.equal(d.dispatch.delivery.member.transitDays, 2);
  assert.ok(d.dispatch.delivery.member.from < d.dispatch.delivery.standard.from); ok("a member gets the express tier: their delivery window starts before the standard window");

  // the delivery estimate starts after the build promise, never before it
  const buildStd = Date.parse(d.dispatch.standardDate + "T00:00:00Z");
  const delStd = Date.parse(d.dispatch.delivery.standard.from + "T00:00:00Z");
  assert.ok(delStd >= buildStd); ok("the delivery estimate never lands before the promised dispatch date");

  // bad pincodes are ignored by the server
  r = await t.P("/api/quote", { items, state: "Maharashtra", pincode: "12" }); d = await r.json();
  assert.equal(d.dispatch.delivery, undefined); ok("a malformed pincode is ignored (no delivery estimate)");

  global.fetch = realFetch; console.log(`\nall ${n} delivery checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });