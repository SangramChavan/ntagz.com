// Membership bought inside checkout: optional, honest comparison, one payment, server-side fee, activation only after verified payment.
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");
const payments = require(path.join(root, "functions", "api", "[[path]].js"));
const POINTS = require(path.join(root, "functions", "lib", "points.js"));
const { makeDb } = require("./d1shim.cjs");
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const NOW = Math.floor(Date.now() / 1000), DAY = 86400;
const realFetch = global.fetch;
global.fetch = async (url, opts) => String(url).includes("api.razorpay.com") ? Response.json({ id: "order_T" + Math.random().toString(36).slice(2, 11), amount: JSON.parse(opts.body).amount, currency: "INR" }) : realFetch(url, opts);
const hmac = async (secret, msg) => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(msg)))).map((b) => b.toString(16).padStart(2, "0")).join("");

(async () => {
  const run = async (exclude) => {
    const { sqlite, D1, q, one } = makeDb({ exclude });
    const env = { DB: D1, RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "rzp_secret", PAYU_KEY: "k", PAYU_SALT: "s", PAYU_ENV: "test" };
    const P = (p, body, cookie) => { payments.resetPricingCache(); return payments.onRequest({ request: new Request("https://x" + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: "https://ntagz.com", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }), env }); };
    let uc = 0;
    const user = () => { const id = crypto.randomUUID(); ++uc; sqlite.prepare("INSERT INTO users (id,email) VALUES (?,?)").run(id, `m${uc}@example.test`); sqlite.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)").run("s-" + id, id, NOW + DAY); return { id, cookie: "ntagz_session=s-" + id }; };
    const setCfg = (k, v) => { sqlite.prepare("INSERT INTO membership_config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v); payments.resetPricingCache(); };
    sqlite.exec("UPDATE products SET track_stock=0, price_paise=10000, member_discount_pct=10 WHERE id='black-nfc-card'");
    setCfg("discounts_live", "1");
    const cust = { name: "A T", phone: "9876543210", address: "1 Main Street, Pune", pincode: "411001", state: "Maharashtra", email: "a@example.test" };
    const items = [{ id: "black-nfc-card", qty: 30 }];
    const quote = async (u, extra = {}) => { const r = await P("/api/quote", { items, state: "Maharashtra", offer: true, ...extra }, u && u.cookie); return { status: r.status, d: await r.json() }; };
    return { sqlite, D1, q, one, env, P, user, setCfg, cust, items, quote };
  };

  // ── flag OFF (default): nothing changes ──
  let t = await run(); let u = t.user();
  let r = await t.quote(u); assert.equal(r.status, 200); assert.equal(r.d.membershipOffer.show, false); assert.equal(r.d.membershipOffer.state, "off");
  r = await t.P("/api/create-order", { items: t.items, ...t.cust, membership: "add" }, u.cookie); assert.equal(r.status, 409);
  assert.equal(t.one("SELECT count(*) c FROM checkout_intents").c, 0); ok("checkout offer ships OFF: no offer, and a forged membership request is refused");
  assert.equal((await (await t.P("/api/rewards/tiers")).json()).checkoutOffer, false); ok("public config says the offer is off");

  // ── flag ON ──
  t.setCfg("checkout_offer", "1");
  assert.equal((await (await t.P("/api/rewards/tiers")).json()).checkoutOffer, true); ok("public config reports the offer is on (cacheable, nothing personal)");
  assert.equal(POINTS.validateSettings({ checkout_offer: true }).values.checkout_offer, "1"); assert.ok(POINTS.validateSettings({ checkout_offer: "yes" }).errors.length); ok("admin setting validates as on/off");

  r = await t.quote(null); let o = r.d.membershipOffer;
  assert.equal(o.state, "login_required"); assert.equal(o.feePaise, 99900); assert.ok(o.savingsPaise > 0); ok("a guest sees the comparison (savings and fee) and is told to sign in; nothing is forced");
  r = await t.P("/api/create-order", { items: t.items, ...t.cust, membership: "add" }); let d = await r.json(); assert.equal(r.status, 401); assert.equal(d.code, "login_required");
  assert.equal(t.one("SELECT count(*) c FROM checkout_intents").c, 0); ok("a guest cannot add membership: refused before any payment is created");

  r = await t.quote(u); o = r.d.membershipOffer;
  assert.equal(o.state, "eligible"); assert.equal(o.show, true); assert.equal(o.withPaise - o.feePaise, o.withoutPaise - o.savingsPaise); assert.equal(o.netPaise, o.savingsPaise - o.feePaise);
  assert.ok(o.netPaise < 0 && o.savingsPaise > 0); ok("honest comparison: savings today are smaller than the fee, so the net difference is negative and says so");
  const without = r.d.you.amount; assert.equal(o.withoutPaise, without * 100); assert.equal(r.d.membershipOffer.added, false); ok("the 'without membership' total is exactly what checkout charges today");

  // big cart: savings exceed the fee → net saving is positive
  const big = await t.quote(u, { items: [{ id: "black-nfc-card", qty: 400 }] }); assert.ok(big.d.membershipOffer.netPaise > 0); ok("when savings exceed the fee the net saving is positive");

  // no eligible product → no pitch, numbers still honest
  t.sqlite.exec("UPDATE products SET member_discount_pct=0 WHERE id='black-nfc-card'"); r = await t.quote(u);
  assert.equal(r.d.membershipOffer.show, false); assert.equal(r.d.membershipOffer.savingsPaise, 0); t.sqlite.exec("UPDATE products SET member_discount_pct=10 WHERE id='black-nfc-card'"); ok("no eligible products: the offer is not shown (savings 0)");

  // add: quote with membership
  r = await t.quote(u, { membership: "add" }); assert.equal(r.status, 200); const you = r.d.you;
  assert.equal(you.membershipFeePaise, 99900); assert.equal(r.d.membershipOffer.added, true); assert.equal(you.amount * 100, r.d.membershipOffer.withPaise); assert.ok(you.memberDiscountPaise > 0); ok("membership added: total = member-priced merchandise + the configured fee, same number the comparison promised");
  r = await t.quote(u, { membership: "add", redeemPoints: 50 }); assert.equal(r.status, 409); ok("points cannot be spent on an order that buys membership");

  // pay
  const pay = async (usr, extra = {}) => {
    const pid = "pay" + Math.random().toString(36).slice(2, 8);
    const rr = await t.P("/api/create-order", { items: t.items, ...t.cust, quoteRef: "Q" + pid, ...extra }, usr.cookie); const dd = await rr.json(); if (!dd.id) return { status: rr.status, d: dd };
    const sig = await hmac("rzp_secret", `${dd.id}|${pid}`);
    const verify = () => t.P("/api/verify-payment", { razorpay_order_id: dd.id, razorpay_payment_id: pid, razorpay_signature: sig }, usr.cookie);
    return { rz: dd, verify, pid };
  };
  const forged = await pay(u, { membership: "add", fee: 1, feePaise: 1, amount: 1 }); const intent = t.one("SELECT * FROM checkout_intents WHERE txn_id=?", forged.rz.id);
  assert.equal(forged.rz.amount, you.amount * 100); assert.equal(intent.membership_fee_paise, 99900); assert.equal(intent.amount_paise, you.amount * 100); ok("the fee and total come from the server: client-supplied fee/amount fields are ignored");
  assert.equal(t.one("SELECT count(*) c FROM memberships WHERE user_id=?", u.id).c, 0); ok("nothing is activated when payment is only initiated");
  assert.equal((await (await forged.verify()).json()).recorded, true);
  const ord = t.one("SELECT * FROM orders WHERE txn_id=?", forged.rz.id), mem = t.q("SELECT * FROM memberships WHERE user_id=?", u.id);
  assert.equal(mem.length, 1); assert.equal(mem[0].status, "active"); assert.equal(mem[0].price_paid, 99900); assert.equal(mem[0].expires_at - mem[0].purchased_at, 365 * DAY); assert.equal(mem[0].purchased_at, ord.created_at);
  assert.equal(ord.membership_fee_paise, 99900); assert.equal(ord.paid_paise, you.amount * 100); ok("verified payment creates the order and activates a 365-day membership in one step; the fee is recorded on the order");
  const rules = JSON.parse(ord.rules_json); assert.equal(rules.fee_paise, 99900); assert.equal(rules.duration_days, 365); assert.equal(rules.v, 1); ok("the rules the order was priced under are frozen on it");
  assert.equal(ord.qualifying_paise, you.qualifyingPaise); ok("the membership fee does not count toward qualifying spend");
  await forged.verify(); await forged.verify();
  assert.equal(t.one("SELECT count(*) c FROM memberships WHERE user_id=?", u.id).c, 1); assert.equal(t.one("SELECT count(*) c FROM orders WHERE txn_id=?", forged.rz.id).c, 1); ok("replayed verification callbacks create no second order or membership");

  // now a member
  r = await t.quote(u, { membership: "add" }); assert.equal(r.status, 409); assert.equal(r.d.code, "already_member");
  assert.equal((await t.quote(u)).d.membershipOffer.state, "active"); ok("an active member is never sold membership again; the offer reports 'active'");
  // a normal checkout is untouched
  const u2 = t.user(); const plain = await pay(u2); assert.equal(plain.rz.amount, (await t.quote(u2)).d.you.amount * 100); await plain.verify();
  assert.equal(t.one("SELECT membership_fee_paise f FROM orders WHERE txn_id=?", plain.rz.id).f, 0); assert.equal(t.one("SELECT count(*) c FROM memberships WHERE user_id=?", u2.id).c, 0); ok("checkout without membership is unchanged: no fee, no membership");

  // a different customer's payment cannot activate someone else's membership
  const u3 = t.user(), a3 = await pay(u3, { membership: "add" }); await a3.verify();
  assert.equal(t.q("SELECT user_id FROM memberships WHERE razorpay_order_id=?", a3.rz.id)[0].user_id, u3.id); ok("membership is attached to the account that paid");

  // PayU
  const u4 = t.user(); r = await t.P("/api/payu/checkout", { items: t.items, ...t.cust, membership: "add" }, u4.cookie); d = await r.json(); assert.equal(r.status, 200);
  const q4 = await t.quote(u4, { membership: "add" }); assert.equal(d.fields.amount, q4.d.you.amount.toFixed(2)); assert.equal(t.one("SELECT membership_fee_paise f FROM checkout_intents WHERE txn_id=?", d.fields.txnid).f, 99900); ok("PayU charges the same total and records the same fee");

  // expired member can buy again; active term is respected
  const u5 = t.user(); t.sqlite.prepare("INSERT INTO memberships (id,user_id,status,purchased_at,expires_at,welcome_credit_paise,price_paid,payment_id) VALUES (?,?,'active',?,?,0,99900,'x')").run(crypto.randomUUID(), u5.id, NOW - 400 * DAY, NOW - 35 * DAY);
  assert.equal((await t.quote(u5)).d.membershipOffer.state, "eligible"); ok("an expired member is offered membership again");

  // rewards live: the order that buys membership also earns points (membership exists by the time points are reconciled)
  t.setCfg("pts_live", "1"); t.setCfg("pts_earn_on", "paid"); const u6 = t.user(), a6 = await pay(u6, { membership: "add" }); await a6.verify();
  const o6 = t.one("SELECT * FROM orders WHERE txn_id=?", a6.rz.id), e6 = t.q("SELECT points FROM points_ledger WHERE order_id=? AND kind='earn'", o6.id);
  assert.ok(o6.points_basis_paise > 0); assert.equal(e6.length, 1); assert.ok(e6[0].points > 0); ok("with rewards on, the same order earns points on the merchandise (not on the fee)");
  assert.ok(o6.points_basis_paise <= o6.qualifying_paise);

  // ── database not migrated to 0016 ──
  const old = await run(["0016_checkout_membership.sql"]); const ou = old.user(); old.setCfg("checkout_offer", "1");
  assert.equal((await old.quote(ou)).d.membershipOffer.state, "off"); r = await old.P("/api/create-order", { items: old.items, ...old.cust, membership: "add" }, ou.cookie); assert.equal(r.status, 409);
  const op = await (async () => { const rr = await old.P("/api/create-order", { items: old.items, ...old.cust, quoteRef: "Q1" }, ou.cookie); return rr.json(); })(); assert.ok(op.id); ok("before migration 0016 the offer is off and ordinary checkout still works");

  console.log(`\n${n} checkout-membership checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
