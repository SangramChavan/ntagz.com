// /membership/ journey: Razorpay webhook (paid-but-never-verified safety net), tier rates in the public programme info,
// and the savings calculator checked against the real pricing engine and the real points ledger.
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");
const payments = require(path.join(root, "functions", "api", "[[path]].js"));
const PRICING = require(path.join(root, "functions", "lib", "pricing.js"));
const POINTS = require(path.join(root, "functions", "lib", "points.js"));
const LOYALTY = require(path.join(root, "functions", "lib", "loyalty.js"));
const { calc } = require(path.join(root, "js", "member-calc.js"));
const { makeDb } = require("./d1shim.cjs");
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const NOW = Math.floor(Date.now() / 1000), DAY = 86400;

const rz = {}; // mock Razorpay orders by id
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("api.razorpay.com/v1/orders/")) { const o = rz[u.split("/").pop()]; return o ? Response.json(o) : new Response("{}", { status: 404 }); }
  if (u.includes("api.razorpay.com/v1/orders")) { const b = JSON.parse(opts.body); const o = { id: "order_T" + Math.random().toString(36).slice(2, 11), amount: b.amount, amount_paid: 0, currency: "INR", receipt: b.receipt, notes: b.notes }; rz[o.id] = o; return Response.json(o); }
  throw new Error("unexpected fetch " + u);
};
const hmac = async (secret, msg) => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(msg))), (b) => b.toString(16).padStart(2, "0")).join("");

(async () => {
  const { sqlite, D1, q, one } = makeDb();
  const env = { DB: D1, RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "rzp_secret", RAZORPAY_WEBHOOK_SECRET: "whsec" };
  const P = (p, body, cookie, e = env, raw) => { payments.resetPricingCache(); return payments.onRequest({ request: new Request("https://x" + p, { method: body || raw ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: "https://ntagz.com", ...(cookie ? { Cookie: cookie } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined) }), env: e }); };
  let uc = 0;
  const user = () => { const id = crypto.randomUUID(); ++uc; sqlite.prepare("INSERT INTO users (id,email) VALUES (?,?)").run(id, `m${uc}@example.test`); sqlite.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)").run("s-" + id, id, NOW + DAY); return { id, cookie: "ntagz_session=s-" + id }; };
  const setCfg = (k, v) => { sqlite.prepare("INSERT INTO membership_config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v); payments.resetPricingCache(); };
  sqlite.exec("UPDATE products SET track_stock=0, price_paise=10000, member_discount_pct=10 WHERE id='black-nfc-card'");
  setCfg("discounts_live", "1");

  // webhook helper: signed (or not) order.paid
  const hook = async (order, { event = "order.paid", sign = true, secret = "whsec", paymentId = "pay_" + order.id } = {}) => {
    const raw = JSON.stringify({ event, payload: { order: { entity: order }, payment: { entity: { id: paymentId } } } });
    const sig = sign ? await hmac(secret, raw) : "bad";
    return payments.onRequest({ request: new Request("https://x/api/razorpay/webhook", { method: "POST", headers: { "X-Razorpay-Signature": sig, "Content-Type": "application/json" }, body: raw }), env });
  };
  const mkOrder = async (u) => { const r = await P("/api/membership/create-order", {}, u.cookie); const d = await r.json(); assert.equal(d.amount, 99900); return rz[d.id]; };
  const members = (u) => q("SELECT * FROM memberships WHERE user_id=?", u.id);

  // ── webhook: authentication ──
  const u1 = user(), o1 = await mkOrder(u1); assert.equal(o1.notes.uid, u1.id); assert.equal(o1.notes.kind, "membership"); ok("membership orders carry the account id, so a webhook can find its owner");
  assert.equal((await payments.onRequest({ request: new Request("https://x/api/razorpay/webhook", { method: "POST", body: "{}" }), env: { ...env, RAZORPAY_WEBHOOK_SECRET: "" } })).status, 503); ok("webhook is off (503) until its secret is configured");
  assert.equal((await hook({ ...o1, amount_paid: o1.amount }, { sign: false })).status, 400); assert.equal(members(u1).length, 0); ok("a webhook with a bad signature is rejected and activates nothing");
  assert.equal((await hook({ ...o1, amount_paid: o1.amount }, { secret: "other" })).status, 400); ok("a webhook signed with the wrong secret is rejected");
  assert.equal((await payments.onRequest({ request: new Request("https://x/api/razorpay/webhook"), env })).status, 405); ok("webhook is POST only");

  // ── webhook: what must NOT activate ──
  let r = await hook({ ...o1, amount_paid: o1.amount }, { event: "payment.failed" }); assert.equal(r.status, 200); assert.equal(members(u1).length, 0); ok("failed-payment events never activate membership");
  r = await hook({ ...o1, amount_paid: 100 }); assert.equal(r.status, 200); assert.equal(members(u1).length, 0); ok("a partly paid order never activates membership");
  r = await hook({ ...o1, amount_paid: o1.amount, receipt: "tp-wrongusr" }); assert.equal(members(u1).length, 0); ok("an order whose receipt does not match its account is ignored");
  r = await hook({ ...o1, amount_paid: o1.amount, notes: { ...o1.notes, uid: crypto.randomUUID() }, receipt: "tp-" + "x".repeat(8) }); assert.equal(one("SELECT count(*) c FROM memberships").c, 0); ok("an order for an unknown account is ignored");

  // ── webhook: paid but the browser never verified ──
  r = await hook({ ...o1, amount_paid: o1.amount }); assert.equal(r.status, 200);
  let m = members(u1); assert.equal(m.length, 1); assert.equal(m[0].status, "active"); assert.equal(m[0].price_paid, 99900); assert.equal(m[0].expires_at - m[0].purchased_at, 365 * DAY); assert.equal(m[0].razorpay_order_id, o1.id);
  ok("a verified paid order activates membership with no browser involved: fee recorded, 365 days");
  await hook({ ...o1, amount_paid: o1.amount }); await hook({ ...o1, amount_paid: o1.amount }); assert.equal(members(u1).length, 1); ok("duplicate webhooks create one membership");
  const sig = await hmac("rzp_secret", `${o1.id}|pay_x`); rz[o1.id].amount_paid = o1.amount;
  r = await P("/api/membership/verify-payment", { razorpay_order_id: o1.id, razorpay_payment_id: "pay_x", razorpay_signature: sig }, u1.cookie); d = await r.json();
  assert.equal(r.status, 200); assert.equal(d.membershipId, m[0].id); assert.equal(d.expiresAt, m[0].expires_at); assert.equal(members(u1).length, 1); ok("the browser verifying afterwards finds the same membership (with its expiry for the confirmation screen), not a second one");
  var d;

  // ── webhook: merchandise order paid but never verified ──
  const u2 = user(), items = [{ id: "black-nfc-card", qty: 30 }], cust = { name: "A T", phone: "9876543210", address: "1 Main Street, Pune", pincode: "411001", state: "Maharashtra", email: "a@example.test" };
  const co = await (await P("/api/create-order", { items, ...cust, quoteRef: "QW1" }, u2.cookie)).json(); assert.ok(co.id);
  assert.equal(one("SELECT count(*) c FROM orders WHERE txn_id=?", co.id).c, 0);
  r = await hook({ ...rz[co.id], id: co.id, amount: co.amount, amount_paid: co.amount, notes: {} }); assert.equal(r.status, 200);
  const ord = one("SELECT * FROM orders WHERE txn_id=?", co.id); assert.ok(ord); assert.equal(ord.payment_status, "paid"); assert.equal(ord.paid_paise, co.amount); ok("a merchandise order paid but never verified in the browser is still recorded, once, at the amount the server priced");
  await hook({ ...rz[co.id], id: co.id, amount: co.amount, amount_paid: co.amount, notes: {} }); assert.equal(one("SELECT count(*) c FROM orders WHERE txn_id=?", co.id).c, 1); ok("duplicate webhooks create one order");
  const co2 = await (await P("/api/create-order", { items, ...cust, quoteRef: "QW2" }, u2.cookie)).json();
  r = await hook({ id: co2.id, amount: co2.amount - 100, amount_paid: co2.amount - 100, notes: {} }); assert.equal(r.status, 500); assert.equal(one("SELECT count(*) c FROM orders WHERE txn_id=?", co2.id).c, 0); assert.ok(one("SELECT 1 x FROM payment_alerts WHERE txn_id=?", co2.id)); ok("a webhook amount that differs from the server's price records no order and raises a payment alert");

  // ── public programme info exposes the tier rates ──
  setCfg("pts_live", "1");
  const info = await (await P("/api/membership/pricing")).json();
  assert.deepEqual(info.points.tiers.map((t) => [t.name, t.minSpendPaise, t.pointsPer100]), [["Silver", 500000, 3], ["Gold", 2500000, 5], ["Diamond", 5000000, 10]]); assert.equal(info.points.earnPer100, 5); assert.equal(info.feePaise, 99900); ok("public info lists the flat rate and every tier rate, and the ₹999 fee, from the same configuration checkout uses");

  // ── calculator vs the real engine ──
  const settings = PRICING.settingsFrom({ discounts_live: "1", max_total_discount_pct: "30", min_margin_pct: "20" });
  const live = { "black-nfc-card": { price_paise: 10000, member_discount_pct: 10, cost_paise: null, points_eligible: 1 } };
  const eng = PRICING.priceCart(items, { products: PRICING.PRODUCTS, live, state: "Maharashtra", member: true, settings });
  const st = POINTS.settingsFrom({ pts_live: "1", pts_earn_per_100: "5", pts_value_paise: "100", pts_max_redeem_pct: "10", pts_min_redeem: "50" });
  const cfg = (tiers) => ({ pct: 10, fee: 999, pts: { earnPer100: 5, value: 1, maxRedeemPct: 10, minOrder: 0, tiers } });
  const est = calc({ order: 3000, count: 4, share: 100, use: 100 }, cfg([]));
  assert.equal(est.savings, 4 * eng.memberDiscount); assert.equal(est.earned, 4 * POINTS.earnedPoints(st, eng.pointsBasisPaise, 1, 0, null)); ok("calculator savings and points equal the engine's, order for order (flat rate)");
  assert.equal(est.net, est.savings + est.usedValue - 999); assert.ok(est.used <= est.earned); assert.equal(est.unused, est.earned - est.used); ok("net value = savings + redeemable rewards − fee; unused points are not counted");
  const tiers = info.points.tiers.map((t) => ({ minSpend: t.minSpendPaise / 100, pointsPer100: t.pointsPer100 }));
  const t4 = calc({ order: 3000, count: 4, share: 100, use: 100 }, cfg(tiers));
  // real ledger: four orders of the same cart by one member, each at the tier rate its customer had when it was priced
  const mu = user(); sqlite.prepare("INSERT INTO memberships (id,user_id,status,purchased_at,expires_at,welcome_credit_paise,price_paid,payment_id) VALUES (?,?,'active',?,?,0,99900,'p')").run(crypto.randomUUID(), mu.id, NOW - DAY, NOW + 300 * DAY);
  setCfg("pts_earn_on", "paid"); let actual = 0;
  for (let k = 0; k < 4; k++) {
    LOYALTY.resetTiersCache();
    const c1 = await (await P("/api/create-order", { items, ...cust, quoteRef: "QL" + k }, mu.cookie)).json();
    const pid = "pl" + k; const sg = await hmac("rzp_secret", `${c1.id}|${pid}`);
    await P("/api/verify-payment", { razorpay_order_id: c1.id, razorpay_payment_id: pid, razorpay_signature: sg }, mu.cookie);
    actual += q("SELECT coalesce(sum(points),0) s FROM points_ledger WHERE user_id=? AND kind='earn' AND order_id=(SELECT id FROM orders WHERE txn_id=?)", mu.id, c1.id)[0].s;
  }
  const oneOrderSwing = Math.ceil(eng.pointsBasisPaise / 100 * (5 - 3) / 100);   // a tier boundary falling inside an order moves the answer by at most this
  assert.ok(actual > 0 && Math.abs(t4.earned - actual) <= oneOrderSwing, `estimate ${t4.earned} vs real ${actual}`); ok(`tier-aware estimate (${t4.earned} points) matches what four real orders earned (${actual}), within one order's tier-boundary rounding (${oneOrderSwing})`);
  assert.equal(t4.rate, 3); ok("the estimate reports the tier rate reached");

  // ── input safety ──
  for (const bad of [{ order: -5, count: -1, share: 500, use: -9 }, { order: "abc", count: NaN, share: "", use: Infinity }, { order: 1e12, count: 1e6, share: 100, use: 100 }]) {
    const x = calc(bad, cfg(tiers)); for (const k of ["annual", "eligible", "savings", "earned", "used", "usedValue", "net"]) assert.ok(Number.isFinite(x[k]), k + " is finite"); assert.ok(x.annual >= 0 && x.used >= 0 && x.used <= x.earned);
  } ok("negative, non-numeric and absurd inputs give finite, clamped results (no NaN)");
  assert.equal(calc({ order: 500, count: 5, share: 0, use: 0 }, cfg(tiers)).breakEven, null); assert.ok(calc({ order: 500, count: 5, share: 0, use: 0 }, cfg(tiers)).net < 0); ok("no eligible spend and no points used: no break-even is claimed and the net is negative");
  assert.ok(calc({ order: 3000, count: 4, share: 100, use: 100 }, cfg(tiers)).breakEven > 0); ok("with eligible spend, a break-even spend is reported");

  console.log(`\n${n} membership-journey checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
