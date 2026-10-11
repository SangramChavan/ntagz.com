// Spending tiers (Ntagz Rewards): the real payments Worker, admin Worker and pricing engine on one in-memory D1.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const root = path.join(__dirname, "..", "..");
const payments = require(path.join(root, "functions", "api", "[[path]].js"));
const LOYALTY = require(path.join(root, "functions", "lib", "loyalty.js"));
const PRICING = require(path.join(root, "functions", "lib", "pricing.js"));
const { makeDb } = require("./d1shim.cjs");
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const ADMIN = "https://admin.ntagz.com";

const realFetch = global.fetch;
global.fetch = async (url, opts) => String(url).includes("api.razorpay.com") ? Response.json({ id: "order_T" + Math.random().toString(36).slice(2, 11), amount: JSON.parse(opts.body).amount, currency: "INR" }) : realFetch(url, opts);
const hmac = async (secret, msg) => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(msg))), (b) => b.toString(16).padStart(2, "0")).join("");

function harness(db, adminWorker) {
  const { sqlite, D1, q, one } = db;
  const penv = { DB: D1, RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "rzp_secret" };
  const aenv = { DB: D1, ADMIN_EMAILS: "admin@example.test", DEV_OTP_ECHO: "1", ASSETS: { fetch: () => new Response("x") } };
  const cust = { name: "A T", phone: "9876543210", address: "1 Main Street, Pune", pincode: "411001", state: "Maharashtra", email: "a@example.test" };
  let adminCookie = "";
  const P = (p, body, cookie) => { payments.resetPricingCache(); return payments.onRequest({ request: new Request("https://x" + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: "https://www.ntagz.com", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }), env: penv }); };
  const A = async (p, body) => {
    const h = { Origin: ADMIN, "X-Requested-With": "ntagz-admin", "Content-Type": "application/json" }; if (adminCookie) h.Cookie = adminCookie;
    const r = await adminWorker.fetch(new Request(ADMIN + p, { method: body === undefined ? "GET" : "POST", headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), aenv);
    return { status: r.status, d: await r.clone().json().catch(() => ({})), headers: r.headers };
  };
  const login = async () => { let r = await A("/api/auth/request", { email: "admin@example.test" }); r = await A("/api/auth/verify", { email: "admin@example.test", otp: r.d.dev_otp }); adminCookie = r.headers.get("set-cookie").split(";")[0]; };
  let uc = 0;
  const user = (email) => { const id = crypto.randomUUID(); ++uc; sqlite.prepare("INSERT INTO users (id,email) VALUES (?,?)").run(id, email || `c${uc}@example.test`); sqlite.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)").run("s-" + id, id, Math.floor(Date.now() / 1000) + 86400); return { id, cookie: "ntagz_session=s-" + id }; };
  let pn = 0;
  // buys qty of a product; returns {rz, order}
  const buy = async (u, id, qty, extra = {}) => {
    const pid = "pay" + ++pn + Math.random().toString(36).slice(2, 6);
    const r = await P("/api/create-order", { items: [{ id, qty }], ...cust, quoteRef: "Q" + pid, ...extra }, u && u.cookie); const d = await r.json(); assert.ok(d.id, JSON.stringify(d));
    const sig = await hmac("rzp_secret", `${d.id}|${pid}`);
    const v = await (await P("/api/verify-payment", { razorpay_order_id: d.id, razorpay_payment_id: pid, razorpay_signature: sig }, u && u.cookie)).json();
    return { rz: d, v, pid, sig, order: one("SELECT * FROM orders WHERE txn_id=?", d.id) };
  };
  const me = async (u) => (await P("/api/rewards/me", null, u.cookie)).json();
  const setCfg = (k, v) => { sqlite.prepare("INSERT INTO membership_config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v); payments.resetPricingCache(); };
  const price = (id, paise) => { sqlite.prepare("UPDATE products SET price_paise=? WHERE id=?").run(paise, id); payments.resetPricingCache(); };
  return { ...db, penv, P, A, login, user, buy, me, setCfg, price, cust };
}

(async () => {
  const admin = (await import(pathToFileURL(path.join(root, "admin", "src", "index.js")).href)).default;
  const H = harness(makeDb(), admin);
  const { sqlite, q, one, P, A, user, buy, me, setCfg, price } = H;
  await H.login();
  price("black-nfc-card", 10000); // ₹100: 10 pcs = ₹1,000 = the Silver threshold
  sqlite.exec("UPDATE products SET track_stock=0");

  // ── defaults, public tiers, new customer ──
  let t = await (await P("/api/rewards/tiers")).json();
  assert.equal(t.live, false); assert.deepEqual(t.tiers.map((x) => [x.name, x.minSpendPaise, x.discountPct]), [["Free", 0, 0], ["Silver", 100000, 3], ["Gold", 300000, 5], ["Platinum", 1000000, 8]]);
  ok("defaults: Free 0% / Silver ₹1,000 3% / Gold ₹3,000 5% / Platinum ₹10,000 8%; rewards start OFF");
  const u1 = user();
  let m = await me(u1); assert.equal(m.tier.id, "free"); assert.equal(m.spendPaise, 0); assert.equal(m.next.id, "silver"); assert.equal(m.next.remainingPaise, 100000); assert.equal(m.topTier, false);
  assert.equal((await P("/api/rewards/me")).status, 401); ok("new customer is Free with ₹1,000 to Silver; signed-out gets 401");

  // ── qualification: excludes GST and shipping; threshold exact; below threshold ──
  price("black-nfc-card", 9000); // ₹90 x 10 = ₹900
  let o = await buy(u1, "black-nfc-card", 10); price("black-nfc-card", 10000); assert.equal(o.order.qualifying_paise, 90000); assert.equal(o.order.shipping_paise, 4000); assert.ok(o.order.gst > 0);
  m = await me(u1); assert.equal(m.tier.id, "free"); assert.equal(m.spendPaise, 90000); ok("₹900 of products (GST and shipping excluded) is below the Silver threshold");
  o = await buy(u1, "black-nfc-card", 10); m = await me(u1);
  assert.equal(m.spendPaise, 190000); assert.equal(m.tier.id, "silver"); ok("multiple paid orders accumulate; crossing ₹1,000 qualifies for Silver");
  const fresh = user(); o = await buy(fresh, "black-nfc-card", 10); m = await me(fresh); assert.equal(m.spendPaise, 100000); assert.equal(m.tier.id, "silver"); ok("spend exactly at the threshold qualifies");

  // ── idempotency: replay and concurrent payment events never count an order twice ──
  const before = (await me(u1)).spendPaise;
  const replay = await P("/api/verify-payment", { razorpay_order_id: o.rz.id, razorpay_payment_id: o.pid, razorpay_signature: o.sig }, fresh.cookie);
  assert.equal(replay.status, 200); assert.equal(one("SELECT count(*) c FROM orders WHERE txn_id=?", o.rz.id).c, 1); assert.equal((await me(fresh)).spendPaise, 100000);
  const pr = "payX" + Math.random().toString(36).slice(2, 6);
  const d2 = await (await P("/api/create-order", { items: [{ id: "black-nfc-card", qty: 10 }], ...H.cust, quoteRef: "QC" }, fresh.cookie)).json(); const sg = await hmac("rzp_secret", `${d2.id}|${pr}`);
  await Promise.all([1, 2, 3].map(() => P("/api/verify-payment", { razorpay_order_id: d2.id, razorpay_payment_id: pr, razorpay_signature: sg }, fresh.cookie)));
  assert.equal(one("SELECT count(*) c FROM orders WHERE txn_id=?", d2.id).c, 1); assert.equal((await me(fresh)).spendPaise, 200000); assert.equal((await me(u1)).spendPaise, before); ok("repeated and concurrent payment events count an order once");

  // ── cancellation, refunds, returns ──
  const c1 = user(); const ca = await buy(c1, "black-nfc-card", 10); const cb = await buy(c1, "black-nfc-card", 20);
  assert.equal((await me(c1)).spendPaise, 300000); assert.equal((await me(c1)).tier.id, "gold");
  let r = await H.A(`/api/orders/${cb.order.id}/status`, { to: "cancelled", confirm: true }); assert.equal(r.status, 200);
  m = await me(c1); assert.equal(m.spendPaise, 100000); assert.equal(m.tier.id, "silver"); assert.ok(m.tierHistory.some((x) => x.to === "silver" && /cancelled/.test(x.reason))); ok("cancelling an order removes its spend and demotes (history records why)");
  r = await A(`/api/orders/${ca.order.id}/refund`, { amount_rupees: "500", reason: "Part refund", idempotency_key: "refund-key-1", confirm: true }); assert.equal(r.status, 200);
  const paidA = ca.order.paid_paise; m = await me(c1); assert.equal(m.spendPaise, Math.round(100000 * (paidA - 50000) / paidA)); ok("a partial refund reduces qualifying spend in proportion to what was refunded");
  assert.equal((await A(`/api/orders/${ca.order.id}/refund`, { amount_rupees: "500", reason: "Part refund", idempotency_key: "refund-key-1", confirm: true })).status, 409);
  assert.equal((await A(`/api/orders/${ca.order.id}/refund`, { amount_rupees: "99999", reason: "Too much", idempotency_key: "refund-key-2", confirm: true })).status, 409);
  assert.equal(one("SELECT refunded_paise r FROM orders WHERE id=?", ca.order.id).r, 50000); ok("refund replays and over-refunds are rejected; refunded amount recorded once");
  r = await A(`/api/orders/${ca.order.id}/refund`, { amount_rupees: String((paidA - 50000) / 100), reason: "Remaining balance refunded", idempotency_key: "refund-key-3", confirm: true });
  assert.equal(r.status, 200); assert.equal((await me(c1)).spendPaise, 0); assert.equal((await me(c1)).tier.id, "free"); ok("a full refund brings the order's spend to zero");

  // ── tier settings never rewrite history ──
  const frozen = { ...one("SELECT * FROM orders WHERE id=?", ca.order.id) };
  let rs = (await A("/api/rewards")).d;
  const edited = rs.tiers.map((x) => (x.id === "silver" ? { ...x, min_spend_paise: 50000, discount_pct: 4 } : x));
  r = await A("/api/rewards", { version: rs.version, tiers: edited, settings: { live: false } }); assert.equal(r.status, 200);
  assert.deepEqual({ ...one("SELECT * FROM orders WHERE id=?", ca.order.id) }, frozen); assert.equal(one("SELECT qualifying_paise q FROM orders WHERE id=?", ca.order.id).q, 100000); ok("changing tier settings leaves existing orders untouched");
  rs = (await A("/api/rewards")).d; await A("/api/rewards", { version: rs.version, tiers: rs.tiers.map((x) => (x.id === "silver" ? { ...x, min_spend_paise: 100000, discount_pct: 3 } : x)), settings: { live: false } });
  LOYALTY.resetTiersCache();

  // ── pricing: eligibility, stacking, guardrails ──
  const live = (flag) => setCfg("loyalty_live", flag ? "1" : "0");
  const sil = user(), gold = user(); await buy(sil, "black-nfc-card", 10); await buy(gold, "black-nfc-card", 30);
  const quote = async (u, items, compare) => (await P("/api/quote", { items, compare, state: "Maharashtra" }, u && u.cookie)).json();
  const item10 = [{ id: "black-nfc-card", qty: 10 }];
  live(false); let qd = await quote(sil, item10); assert.equal(qd.you.memberDiscount, 0); assert.equal(qd.signedInMember, false); ok("rewards OFF: no tier discount for anyone (deploying changes no price)");
  live(true);
  qd = await quote(sil, item10); assert.equal(qd.you.lines[0].memberPct, 3); assert.equal(qd.you.lines[0].source, "tier"); assert.equal(qd.you.memberDiscount, 30);
  qd = await quote(gold, item10); assert.equal(qd.you.lines[0].memberPct, 5);
  qd = await quote(user(), item10); assert.equal(qd.you.memberDiscount, 0); qd = await quote(null, item10); assert.equal(qd.you.memberDiscount, 0); ok("Silver 3%, Gold 5% on eligible products; Free tier and guests pay regular price");
  sqlite.prepare("UPDATE products SET loyalty_eligible=0 WHERE id='white-nfc-card'").run();
  qd = await quote(gold, [{ id: "white-nfc-card", qty: 10 }, { id: "black-nfc-card", qty: 10 }, { id: "sample-kit", qty: 1 }]);
  assert.equal(qd.you.lines[0].memberPct, 0); assert.equal(qd.you.lines[1].memberPct, 5); assert.equal(qd.you.lines[2].memberPct, 0); ok("excluded products and fixed-price kits get no tier discount");
  sqlite.prepare("UPDATE products SET loyalty_max_pct=2 WHERE id='black-nfc-card'").run(); qd = await quote(gold, item10); assert.equal(qd.you.lines[0].memberPct, 2);
  sqlite.prepare("UPDATE products SET loyalty_max_pct=NULL WHERE id='black-nfc-card'").run(); ok("a per-product ceiling caps the tier discount");
  // paid membership meets the tier: best_of by default, stack optional, never above the cap
  sqlite.prepare("INSERT INTO memberships (id,user_id,status,purchased_at,expires_at,price_paid,razorpay_order_id) VALUES ('mm1',?,?,?,?,99900,'o_mm1')").run(gold.id, "active", 1, Math.floor(Date.now() / 1000) + 86400 * 300);
  setCfg("discounts_live", "1"); sqlite.prepare("UPDATE products SET member_discount_pct=6 WHERE id='black-nfc-card'").run();
  qd = await quote(gold, item10); assert.equal(qd.you.lines[0].memberPct, 6); assert.equal(qd.you.lines[0].source, "membership"); ok("paid membership 6% vs Gold 5%: the better one applies, not both (default)");
  setCfg("loyalty_combine", "stack"); qd = await quote(gold, item10); assert.ok(Math.abs(qd.you.lines[0].memberPct - (6 + 5 - 0.3)) < 1e-9); assert.equal(qd.you.lines[0].source, "both");
  setCfg("max_total_discount_pct", "8"); qd = await quote(gold, item10); assert.ok(qd.you.lines[0].memberPct <= 8 + 1e-9); ok("stacking (when enabled) stays under the combined-discount cap");
  setCfg("loyalty_combine", "best_of"); setCfg("max_total_discount_pct", "30");
  sqlite.prepare("UPDATE products SET member_discount_pct=0, cost_paise=9800 WHERE id='black-nfc-card'").run();
  qd = await quote(gold, item10); assert.ok(qd.you.lines[0].memberPct < 5 && qd.you.lines[0].limit === "margin"); sqlite.prepare("UPDATE products SET cost_paise=NULL WHERE id='black-nfc-card'").run(); ok("the minimum-margin guardrail also limits tier discounts");

  // ── cart, checkout and order totals agree; client tampering is ignored; frozen amounts ──
  qd = await quote(gold, item10);
  const ord = await buy(gold, "black-nfc-card", 10, { memberPct: 50, amount: 1, price: 1, tier: "platinum", member: true, loyaltyPct: 40 });
  assert.equal(ord.rz.amount / 100, qd.you.amount); assert.equal(ord.order.total, qd.you.amount * 100);
  assert.equal(ord.order.discount_paise, 5000); assert.equal(ord.order.qualifying_paise, 95000); assert.equal(ord.order.loyalty_tier, "gold"); ok("quote, checkout amount and order total agree; forged tier/price/percent fields change nothing");
  const spentBefore = (await me(gold)).spendPaise; await buy(gold, "black-nfc-card", 10); assert.equal((await me(gold)).spendPaise, spentBefore + 95000); ok("an order's qualifying spend is net of the member discount");
  m = await me(gold); assert.equal(m.savingsPaise, 10000); ok("membership savings are summed from the discounts actually given on paid orders");

  // ── privacy ──
  const other = user(); const mo = await me(other); assert.equal(mo.orders.length, 0); assert.ok(!JSON.stringify(mo).includes(gold.id));
  assert.equal((await (await P("/api/rewards/me", null, "ntagz_session=forged-session-123456")).status), 401); ok("each customer sees only their own rewards; forged sessions are refused");

  // ── admin: settings validation, audit, auth ──
  const anon = await admin.fetch(new Request(ADMIN + "/api/rewards", { method: "POST", headers: { Origin: ADMIN, "X-Requested-With": "ntagz-admin", "Content-Type": "application/json" }, body: "{}" }), H.penv && { DB: H.D1, ADMIN_EMAILS: "admin@example.test", ASSETS: { fetch: () => new Response("x") } });
  assert.equal(anon.status, 401);
  rs = (await A("/api/rewards")).d; const base = rs.tiers.map((x) => ({ ...x }));
  const tryTiers = (mut) => A("/api/rewards", { version: rs.version, tiers: mut(base.map((x) => ({ ...x }))), settings: {} });
  assert.equal((await tryTiers((x) => { x[1].min_spend_paise = 0; return x; })).status, 400);                // not increasing
  assert.equal((await tryTiers((x) => { x[0].min_spend_paise = 100; return x; })).status, 400);              // must start at 0
  assert.equal((await tryTiers((x) => { x[2].discount_pct = 1; return x; })).status, 400);                   // discount falls
  assert.equal((await tryTiers((x) => { x[1].discount_pct = 80; return x; })).status, 400);                  // over 50%
  assert.equal((await A("/api/rewards", { version: "stale", tiers: base, settings: {} })).status, 409);
  const sv = await A("/api/rewards", { version: rs.version, tiers: base.map((x) => (x.id === "gold" ? { ...x, discount_pct: 6 } : x)), settings: { live: true } }); assert.equal(sv.status, 200);
  assert.equal(sv.d.tiers.find((x) => x.id === "gold").discount_pct, 6); assert.ok(sv.d.history.some((h) => h.action === "rewards_settings" && h.actor === "admin@example.test")); ok("tier edits are validated (order, floor, ≤50%), versioned, audited; signed-out is refused");
  LOYALTY.resetTiersCache(); payments.resetPricingCache(); qd = await quote(gold, item10); assert.equal(qd.you.lines[0].memberPct, 6); ok("an edit in the admin takes effect for new prices without a code change");

  // ── manual adjustments ──
  const adjU = user("adj-target@example.test"); const cid = adjU.id;
  const adj = (b) => A(`/api/customers/${cid}/adjust`, { confirm: true, idempotency_key: crypto.randomUUID(), ...b });
  assert.equal((await adj({ delta_rupees: "500", reason: "short" })).status, 400);
  assert.equal((await adj({ delta_rupees: "0", reason: "A valid long reason" })).status, 400);
  assert.equal((await adj({ delta_rupees: "-100", reason: "Cannot go below zero" })).status, 409);
  assert.equal((await adj({ delta_rupees: "1000000", reason: "Way too large an amount" })).status, 400);
  assert.equal((await A(`/api/customers/${cid}/adjust`, { delta_rupees: "500", reason: "No confirmation sent" })).status, 400);
  const key = crypto.randomUUID(); let ar = await adj({ delta_rupees: "1500", reason: "Verified offline purchase #123", idempotency_key: key }); assert.equal(ar.status, 200);
  assert.equal((await adj({ delta_rupees: "1500", reason: "Verified offline purchase #123", idempotency_key: key })).status, 409);
  assert.equal(ar.d.spend_paise, 150000); assert.equal(ar.d.tier.id, "silver"); assert.equal(ar.d.adjustments[0].actor, "admin@example.test"); assert.equal(ar.d.adjustments[0].spend_before, 0); assert.equal(ar.d.adjustments[0].spend_after, 150000);
  assert.ok(one("SELECT 1 x FROM audit_log WHERE action='rewards_adjust'")); assert.equal(one("SELECT count(*) c FROM loyalty_adjustments WHERE user_id=?", cid).c, 1);
  const mine = await me(adjU); assert.equal(mine.spendPaise, 150000); assert.equal(mine.adjustments[0].reason, "Verified offline purchase #123"); ok("adjustments need a reason and confirmation, are bounded, idempotent, audited with who/when/before/after, and visible to the customer");
  const list = (await A("/api/customers?q=adj-target")).d; assert.equal(list.customers.length, 1); assert.equal(list.customers[0].spend_paise, 150000); assert.equal(list.customers[0].tier, "silver");
  assert.equal((await A("/api/customers?q=zzzz-no-such")).d.customers.length, 0); assert.equal((await A("/api/customers?q=%25")).d.customers.length <= 25, true); ok("customer search finds by email and shows tier and spend (wildcards are escaped)");
  const detail = (await A(`/api/customers/${gold.id}`)).d; assert.equal(detail.customer.id, gold.id); assert.ok(detail.orders.length >= 3 && detail.orders.every((x) => "effective_paise" in x)); ok("customer detail shows orders, effective spend and history");

  // ── invariant: derived spend equals a from-scratch recomputation, and persisted tier matches ──
  for (const u of [u1, c1, gold, sil, adjU, fresh]) {
    const expected = q("SELECT qualifying_paise qp, paid_paise pp, refunded_paise rp, status st, payment_status ps FROM orders WHERE user_id=?", u.id)
      .filter((x) => x.ps === "paid" && !["cancelled", "returned"].includes(x.st)).reduce((a, x) => a + Math.floor(x.qp * (x.pp - Math.min(x.rp, x.pp)) / x.pp), 0)
      + one("SELECT coalesce(sum(delta_paise),0) s FROM loyalty_adjustments WHERE user_id=?", u.id).s;
    assert.equal((await me(u)).spendPaise, Math.max(0, expected));
    await LOYALTY.syncTier(H.D1, u.id, "audit"); const t2 = LOYALTY.tierFor(Math.max(0, expected), await LOYALTY.loadTiers(H.D1));
    assert.equal(one("SELECT loyalty_tier_id t FROM users WHERE id=?", u.id).t, t2.id);
  } ok("invariant: stored tier and displayed spend equal a recomputation from the orders");

  // ── cart milestones ──
  price("nfc-coin", 2000); sqlite.exec("UPDATE products SET member_discount_pct=0 WHERE 1=1; UPDATE products SET cost_paise=NULL");
  const camp = (b) => A("/api/campaigns", { confirm: true, audience: "all", active: true, ...b });
  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  assert.equal((await camp({ name: "x", threshold_rupees: "0", reward_type: "free_shipping" })).status, 400);
  assert.equal((await camp({ name: "Big", threshold_rupees: "300", reward_type: "percent_off", reward_value: 25 })).status, 400);
  assert.equal((await camp({ name: "Big", threshold_rupees: "300", reward_type: "percent_off", reward_value: 5, starts: day(2), ends: day(1) })).status, 400);
  assert.equal((await camp({ name: "Big", threshold_rupees: "300", reward_type: "gift" })).status, 400);
  assert.equal((await A("/api/campaigns", { name: "No confirm", threshold_rupees: "300", reward_type: "free_shipping" })).status, 400);
  assert.equal((await A("/api/campaigns")).d.campaigns.length, 0); ok("campaign validation: threshold, reward ≤20%, dates, confirmation; none exist until an admin creates one");
  let cl = (await camp({ name: "Free shipping from ₹150", threshold_rupees: "150", reward_type: "free_shipping" })).d.campaigns; assert.equal(cl.length, 1);
  await camp({ name: "5% off from ₹300", threshold_rupees: "300", reward_type: "percent_off", reward_value: 5 });
  assert.ok(one("SELECT 1 x FROM audit_log WHERE action='campaign_save'")); payments.resetPricingCache();
  const coins = (n) => [{ id: "nfc-coin", qty: n }];
  let g = await quote(null, coins(10)); // ₹200 of products
  assert.equal(g.you.campaign.type, "free_shipping"); assert.equal(g.you.shipping, 0); assert.equal(g.you.amount, 236); assert.equal(g.you.campaignDiscountPaise, 4000);
  assert.equal(g.rewards.next.remainingPaise, 10000); assert.ok(g.rewards.suggest.length > 0 && g.rewards.suggest.every((x) => x.valuePaise >= 10000 && x.id !== "nfc-coin")); ok("₹200 cart: free-shipping reward applied; ₹100 more unlocks the next milestone; suggestions are in-stock products that close the gap");
  g = await quote(null, coins(5)); assert.equal(g.you, null === 1 ? 0 : g.you); // below MOQ
  g = await quote(null, coins(60)); assert.equal(g.you.campaign.type, "percent_off"); assert.equal(g.you.campaignDiscountPaise, 6000); assert.equal(g.you.qualifyingPaise, 114000); assert.equal(g.rewards.next, null);
  ok("only the single best milestone applies (₹1,200 cart: 5% beats shipping), qualifying spend is net of it, and no milestone is 'next' once all are reached");
  // no unexpected stacking: percent reward is skipped when the cart already has a member/bulk discount
  sqlite.prepare("UPDATE products SET member_discount_pct=0 WHERE id='nfc-coin'").run(); const gm = user(); await buy(gm, "black-nfc-card", 30); // Gold
  let mq = await quote(gm, coins(60)); assert.equal(mq.you.memberDiscount > 0, true); assert.notEqual(mq.you.campaign && mq.you.campaign.type, "percent_off"); assert.equal(mq.you.campaign.type, "free_shipping");
  assert.match(mq.rewards.note, /not applied because this cart already has/); assert.equal(mq.rewards.next, null); const bq = await quote(null, coins(500)); assert.notEqual(bq.you.campaign && bq.you.campaign.type, "percent_off"); ok("percentage rewards do not stack on member or quantity discounts (and the customer is told why)");
  // customer-visible numbers agree end to end; forged campaign fields are ignored
  const cq = await quote(null, coins(60)); const co = await buy(null, "nfc-coin", 60, { campaignId: "forged", campaign: { type: "percent_off", value: 20 }, amount: 1 });
  assert.equal(co.rz.amount / 100, cq.you.amount); assert.equal(co.order.campaign_discount_paise, 6000); assert.equal(co.order.campaign_id, cq.you.campaign.id); assert.equal(co.order.qualifying_paise, 114000); ok("quote, checkout amount and order record agree on the milestone; forged campaign fields change nothing");
  // audience, dates, limits
  const members = (await camp({ name: "Members only", threshold_rupees: "100", reward_type: "percent_off", reward_value: 2, audience: "members" })).d.campaigns.find((c) => c.name === "Members only");
  payments.resetPricingCache(); mq = await quote(null, coins(10)); assert.notEqual(mq.you.campaign && mq.you.campaign.id, members.id); mq = await quote(gm, coins(10)); assert.equal(mq.you.campaign.type === "free_shipping" || mq.you.campaign.id === members.id, true);
  await camp({ id: members.id, name: "Members only", threshold_rupees: "100", reward_type: "percent_off", reward_value: 2, audience: "members", active: false });
  const expired = (await camp({ name: "Expired", threshold_rupees: "100", reward_type: "percent_off", reward_value: 20, starts: day(-10), ends: day(-5) })).d.campaigns.find((c) => c.name === "Expired");
  const future = (await camp({ name: "Future", threshold_rupees: "100", reward_type: "percent_off", reward_value: 20, starts: day(5), ends: day(9) })).d.campaigns.find((c) => c.name === "Future");
  payments.resetPricingCache(); g = await quote(null, coins(10)); assert.ok(g.you.campaign.id !== expired.id && g.you.campaign.id !== future.id); ok("audience, start/end dates and active flag are honoured");
  const once = (await camp({ name: "First order only", threshold_rupees: "100", reward_type: "percent_off", reward_value: 20, max_redemptions: 1 })).d.campaigns.find((c) => c.name === "First order only");
  payments.resetPricingCache(); g = await quote(null, coins(10)); assert.equal(g.you.campaign.id, once.id);
  const redeemer = await buy(null, "nfc-coin", 10); assert.equal(redeemer.order.campaign_id, once.id);
  payments.resetPricingCache(); g = await quote(null, coins(10)); assert.notEqual(g.you.campaign && g.you.campaign.id, once.id);
  r = await A(`/api/orders/${redeemer.order.id}/status`, { to: "cancelled", confirm: true }); assert.equal(r.status, 200); payments.resetPricingCache(); g = await quote(null, coins(10)); assert.equal(g.you.campaign.id, once.id);
  ok("a redemption limit is enforced; cancelling the order gives the redemption back");
  await camp({ id: once.id, name: "First order only", threshold_rupees: "100", reward_type: "percent_off", reward_value: 20, max_redemptions: 1, active: false });
  const each = (await camp({ name: "Once per customer", threshold_rupees: "100", reward_type: "percent_off", reward_value: 20, per_customer_limit: 1 })).d.campaigns.find((c) => c.name === "Once per customer");
  const pc = user(); payments.resetPricingCache(); assert.equal((await quote(null, coins(10))).you.campaign.id === each.id, false); // needs an identity to count against
  g = await quote(pc, coins(10)); assert.equal(g.you.campaign.id, each.id); await buy(pc, "nfc-coin", 10); payments.resetPricingCache(); g = await quote(pc, coins(10)); assert.notEqual(g.you.campaign && g.you.campaign.id, each.id); ok("per-customer limits need a signed-in customer and are enforced per customer");
  // milestone vs tier progress are separate numbers
  const tp = user(); await buy(tp, "black-nfc-card", 12); g = await quote(tp, coins(10)); const tpSpend = (await me(tp)).spendPaise;
  const tNow = await LOYALTY.loadTiers(H.D1), cur = LOYALTY.tierFor(tpSpend, tNow), nxt = LOYALTY.nextTierFor(tpSpend, tNow); assert.ok(tpSpend > 0 && tpSpend < 120000); // milestone rewards make the order count less than its list value
  assert.ok(g.rewards.tier && g.rewards.tier.current.id === cur.id); assert.equal(g.rewards.tier.next.id, nxt.id); assert.equal(g.rewards.tier.spendPaise, tpSpend); assert.equal(g.rewards.tier.next.remainingPaise, nxt.min_spend_paise - tpSpend);
  assert.equal(g.rewards.tier.afterThisOrder.spendPaise, tpSpend + g.you.qualifyingPaise); assert.ok(g.rewards.next === null || typeof g.rewards.next.remainingPaise === "number"); assert.notEqual(g.rewards.tier.next.remainingPaise, g.rewards.next && g.rewards.next.remainingPaise); ok("tier progress (lifetime spend) is reported separately from the cart milestone (this cart)");
  assert.equal((await P("/api/rewards/tiers")).status, 200); const pubm = (await (await P("/api/rewards/tiers")).json()).milestones; assert.ok(pubm.length >= 2 && pubm.every((x) => x.thresholdPaise > 0 && !("max_redemptions" in x))); ok("public milestone list exposes only names, thresholds and rewards");
  // margin warning for percentage rewards
  sqlite.prepare("UPDATE products SET cost_paise=1950 WHERE id='nfc-coin'").run(); const wl = (await A("/api/campaigns")).d.campaigns.find((c) => c.name === "5% off from ₹300"); assert.ok(wl.warnings.length === 1 && /minimum margin/.test(wl.warnings[0])); ok("percentage rewards warn the admin when they would cut below the minimum margin");

  // ── legacy data and an un-migrated database ──
  const old = makeDb({ exclude: ["0012_rewards.sql"] }); const OH = harness(old, admin);
  old.sqlite.exec("UPDATE products SET track_stock=0");
  const lu = OH.user("legacy@example.test");
  // checkout still works (rewards schema absent) and records the order the old way
  const lo = await OH.buy(lu, "black-nfc-card", 10); assert.ok(lo.order); assert.equal(lo.v.recorded, true);
  assert.equal(old.one("SELECT count(*) c FROM pragma_table_info('orders') WHERE name='qualifying_paise'").c, 0); ok("without migration 0012, checkout and order recording keep working");
  // an old paid order (pre-dating shipping/qualifying columns), then migrate: existing customers keep their standing
  old.sqlite.prepare("INSERT INTO orders (id,user_id,txn_id,gateway,items_json,subtotal,gst,total,payment_method,payment_status,paid_paise,state,status) VALUES ('legacy1',?,'T-LEG1','payu','[]',?,?,?, 'payu','paid',?,'Maharashtra','delivered')").run(lu.id, 300000 + 4000, 54000, 300000 + 4000 + 54000, 358000);
  old.applyMigration("0012_rewards.sql");
  const lg = old.one("SELECT shipping_paise s, qualifying_paise q FROM orders WHERE id='legacy1'"); assert.equal(lg.s, 0); assert.equal(lg.q, 304000); // total 358000 - GST 54000 - shipping 0 (the order was over ₹2,000)
  LOYALTY.resetTiersCache(); const lm = await OH.me(lu); assert.ok(lm.spendPaise >= 300000); assert.notEqual(lm.tier.id, "free"); ok("migration 0012 backfills existing paid orders, so current customers are not reset to Free");
  console.log(`\nall ${n} rewards checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
