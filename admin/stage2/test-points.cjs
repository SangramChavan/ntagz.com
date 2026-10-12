// Rewards Membership: points wallet, redemption at checkout, milestones, renewal, expiry, admin controls.
// Real payments Worker + admin Worker + pricing engine on one in-memory D1.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const root = path.join(__dirname, "..", "..");
const payments = require(path.join(root, "functions", "api", "[[path]].js"));
const POINTS = require(path.join(root, "functions", "lib", "points.js"));
const { makeDb } = require("./d1shim.cjs");
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const ADMIN = "https://admin.ntagz.com", NOW = Math.floor(Date.now() / 1000), DAY = 86400;

const realFetch = global.fetch;
global.fetch = async (url, opts) => String(url).includes("api.razorpay.com") ? Response.json({ id: "order_T" + Math.random().toString(36).slice(2, 11), amount: JSON.parse(opts.body).amount, currency: "INR" }) : realFetch(url, opts);
const hmac = async (secret, msg) => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(msg))), (b) => b.toString(16).padStart(2, "0")).join("");

(async () => {
  const admin = (await import(pathToFileURL(path.join(root, "admin", "src", "index.js")).href)).default;
  const memAdmin = await import(pathToFileURL(path.join(root, "admin", "src", "membership.js")).href);
  const db = makeDb(); const { sqlite, D1, q, one } = db;
  const penv = { DB: D1, RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "rzp_secret" };
  const aenv = { DB: D1, ADMIN_EMAILS: "owner@example.test,staff@example.test", DEV_OTP_ECHO: "1", DEV_NOTIFY_ECHO: "1", ASSETS: { fetch: () => new Response("x") } };
  const cookies = {};
  const A = async (who, p, body) => {
    const h = { Origin: ADMIN, "X-Requested-With": "ntagz-admin", "Content-Type": "application/json" }; if (cookies[who]) h.Cookie = cookies[who];
    const r = await admin.fetch(new Request(ADMIN + p, { method: body === undefined ? "GET" : "POST", headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), aenv);
    return { status: r.status, d: await r.clone().json().catch(() => ({})) };
  };
  const login = async (who) => { let r = await fetch2(who); cookies[who] = r; };
  const fetch2 = async (who) => {
    const h = { Origin: ADMIN, "X-Requested-With": "ntagz-admin", "Content-Type": "application/json" };
    let r = await admin.fetch(new Request(ADMIN + "/api/auth/request", { method: "POST", headers: h, body: JSON.stringify({ email: who }) }), aenv); const { dev_otp } = await r.json();
    r = await admin.fetch(new Request(ADMIN + "/api/auth/verify", { method: "POST", headers: h, body: JSON.stringify({ email: who, otp: dev_otp }) }), aenv);
    return r.headers.get("set-cookie").split(";")[0];
  };
  const OW = "owner@example.test", ST = "staff@example.test";
  await login(OW); await login(ST);
  const P = (p, body, cookie) => { payments.resetPricingCache(); return payments.onRequest({ request: new Request("https://x" + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: "https://www.ntagz.com", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }), env: penv }); };
  const cust = { name: "A T", phone: "9876543210", address: "1 Main Street, Pune", pincode: "411001", state: "Maharashtra", email: "a@example.test" };
  let uc = 0, pn = 0;
  const user = () => { const id = crypto.randomUUID(); ++uc; sqlite.prepare("INSERT INTO users (id,email) VALUES (?,?)").run(id, `m${uc}@example.test`); sqlite.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)").run("s-" + id, id, NOW + DAY); return { id, cookie: "ntagz_session=s-" + id }; };
  const member = (u, { start = NOW - 10 * DAY, days = 365, fee = 99900 } = {}) => { const id = crypto.randomUUID(); sqlite.prepare("INSERT INTO memberships (id,user_id,status,purchased_at,expires_at,welcome_credit_paise,price_paid,payment_id) VALUES (?,?,'active',?,?,0,?,?)").run(id, u.id, start, start + days * DAY, fee, "pay-" + id); return id; };
  const buy = async (u, id, qty, extra = {}) => {
    const pid = "pay" + ++pn + Math.random().toString(36).slice(2, 6);
    const r = await P("/api/create-order", { items: [{ id, qty }], ...cust, quoteRef: "Q" + pid, ...extra }, u && u.cookie); const d = await r.json(); if (!d.id) return { error: d, status: r.status };
    const sig = await hmac("rzp_secret", `${d.id}|${pid}`);
    const verify = () => P("/api/verify-payment", { razorpay_order_id: d.id, razorpay_payment_id: pid, razorpay_signature: sig }, u && u.cookie);
    const v = await (await verify()).json();
    return { rz: d, v, verify, order: one("SELECT * FROM orders WHERE txn_id=?", d.id) };
  };
  const quote = async (u, items, extra = {}) => { const r = await P("/api/quote", { items, state: "Maharashtra", ...extra }, u && u.cookie); return { status: r.status, d: await r.json() }; };
  const me = async (u) => (await P("/api/membership/me", null, u.cookie)).json();
  const bal = (u) => POINTS.balance(D1, u.id);
  const ledger = (u) => q("SELECT kind,points,order_id,idem_key FROM points_ledger WHERE user_id=? ORDER BY rowid", u.id);
  const setCfg = (k, v) => { sqlite.prepare("INSERT INTO membership_config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v); payments.resetPricingCache(); };
  const deliver = async (oid) => { sqlite.prepare("UPDATE orders SET status='shipped' WHERE id=?").run(oid); const r = await A(OW, `/api/orders/${oid}/status`, { to: "delivered", confirm: true, idempotency_key: "d-" + oid }); assert.equal(r.status, 200, JSON.stringify(r.d)); };
  sqlite.exec("UPDATE products SET track_stock=0, member_discount_pct=10 WHERE id='black-nfc-card'; UPDATE products SET price_paise=10000 WHERE id='black-nfc-card'");
  payments.resetPricingCache(); setCfg("discounts_live", "1");

  // ── defaults: everything off ──
  const m1 = user(); member(m1);
  let o = await buy(m1, "black-nfc-card", 30);
  assert.equal(o.order.points_basis_paise, 0); assert.equal(one("SELECT count(*) n FROM points_ledger").n, 0); ok("rewards ship OFF: a member's order earns nothing and creates no ledger rows");
  let r = await quote(m1, [{ id: "black-nfc-card", qty: 30 }], { redeemPoints: 100 }); assert.equal(r.status, 409); ok("redemption is refused while rewards are off");
  assert.equal((await P("/api/membership/pricing")).status, 200); assert.equal((await (await P("/api/membership/pricing")).json()).points, null); ok("public programme info hides points while off");

  // ── enable via admin (validated, versioned, audited) ──
  let st = await A(OW, "/api/points"); assert.equal(st.status, 200);
  assert.equal((await A(OW, "/api/points/settings", { version: "stale", settings: { pts_live: true } })).status, 409); ok("stale settings version rejected");
  for (const bad of [{ pts_earn_per_100: -1 }, { pts_value_paise: 0 }, { pts_max_redeem_pct: 80 }, { pts_earn_on: "never" }, { renew_notice_days: "30,abc" }, { pts_live: "yes" }]) assert.equal((await A(OW, "/api/points/settings", { version: st.d.version, settings: bad })).status, 400, JSON.stringify(bad));
  ok("invalid or contradictory settings are rejected on the server");
  st = await A(OW, "/api/points/settings", { version: st.d.version, settings: { pts_live: true } }); assert.equal(st.status, 200); assert.equal(st.d.settings.live, true);
  assert.ok(one("SELECT 1 x FROM audit_log WHERE action='points_settings'")); payments.resetPricingCache(); ok("admin enables rewards; change is audited");
  const info = await (await P("/api/membership/pricing")).json(); assert.equal(info.points.earnPer100, 5); assert.equal(info.milestones.length, 4); assert.equal(info.milestones[0].thresholdPaise, 250000); ok("public info shows the configured earn rate and milestone ladder");

  // ── earning: member only, after delivery, integer maths ──
  const u1 = user(); member(u1);
  o = await buy(u1, "black-nfc-card", 30);   // ₹3,000 list, member 10% => ₹2,700 net
  assert.equal(o.order.points_basis_paise, 270000); assert.equal(o.order.member_saving_paise, 30000); ok("order freezes the earning basis (net, ex GST) and the member saving");
  assert.equal((await bal(u1)).available, 0); let mine = await me(u1); assert.equal(mine.wallet.pendingPoints, Math.floor(270000 * 5 / 10000)); ok("points are pending until delivery (not spendable yet)");
  await deliver(o.order.id);
  assert.equal((await bal(u1)).available, 135 + 50); // 135 purchase points + the ₹2,500 milestone (50)
  assert.deepEqual(ledger(u1).map((x) => [x.kind, x.points]), [["earn", 135], ["bonus", 50]]); ok("delivery credits 5 points per ₹100 of net eligible spend and the ₹2,500 milestone bonus");
  await A(OW, `/api/orders/${o.order.id}/status`, { to: "delivered", confirm: true, idempotency_key: "d2" }); await POINTS.reconcileOrder(D1, o.order.id); await POINTS.reconcileUser(D1, u1.id);
  assert.equal(ledger(u1).length, 2); ok("replays and re-reconciles never double-credit");
  const non = user(); o = await buy(non, "black-nfc-card", 30); assert.equal(o.order.points_basis_paise, 0); await deliver(o.order.id); assert.equal((await bal(non)).available, 0); ok("a signed-in non-member earns nothing");
  const old = user(); member(old, { start: NOW - 400 * DAY, days: 365 }); o = await buy(old, "black-nfc-card", 30); assert.equal(o.order.points_basis_paise, 0); ok("an expired membership earns nothing");
  const guest = await buy(null, "black-nfc-card", 30); assert.equal(guest.order.points_basis_paise, 0); ok("guests earn nothing");
  assert.equal((await P("/api/membership/me")).status, 401); ok("wallet endpoints need sign-in");
  const m2 = await me(non); assert.equal(m2.membership.active, false); assert.equal(m2.wallet.availablePoints, 0); ok("a customer only ever sees their own wallet");

  // ── redemption at checkout ──
  r = await quote(u1, [{ id: "black-nfc-card", qty: 30 }]); assert.equal(r.d.points.available, 185); assert.equal(r.d.points.maxUsable, 185 > 270 ? 185 : 185); assert.equal(r.d.points.willEarn, 135); ok("quote reports the balance, the usable maximum and what this cart will earn");
  r = await quote(u1, [{ id: "black-nfc-card", qty: 30 }], { redeemPoints: 40 }); assert.equal(r.status, 409); assert.match(r.d.error, /at least 50/); ok("below the minimum redemption is refused");
  r = await quote(non, [{ id: "black-nfc-card", qty: 30 }], { redeemPoints: 100 }); assert.equal(r.status, 409); ok("non-members cannot redeem");
  const base = await quote(u1, [{ id: "black-nfc-card", qty: 30 }]);
  r = await quote(u1, [{ id: "black-nfc-card", qty: 30 }], { redeemPoints: 100000 }); assert.equal(r.status, 200); assert.equal(r.d.points.redeemed, 185); assert.equal(r.d.points.discountPaise, 18500); assert.equal(r.d.you.pointsRedeemed, 185); ok("client-requested points are capped by the server (balance, then 10% of eligible value)");
  assert.ok(r.d.you.amount < base.d.you.amount); assert.ok(Math.abs((base.d.you.amount - r.d.you.amount) - 185 * 1.18) <= 1.01); ok("the redemption reduces the taxable value and the payable amount");
  const big = user(); member(big); sqlite.prepare("INSERT INTO points_ledger (id,user_id,kind,points,expires_at,idem_key) VALUES ('seed-big',?,'adjust',5000,?,'seed-big')").run(big.id, NOW + 100 * DAY);
  r = await quote(big, [{ id: "black-nfc-card", qty: 30 }], { redeemPoints: 5000 }); assert.equal(r.d.points.redeemed, Math.floor(270000 * 10 / 100 / 100)); ok("the per-order cap (10% of eligible value) limits redemption");
  // pay with points
  const before = (await bal(u1)).available;
  const red = await buy(u1, "black-nfc-card", 30, { redeemPoints: 100 });
  assert.equal(red.order.points_redeemed, 100); assert.equal(red.order.points_discount_paise, 10000); assert.equal(red.order.points_basis_paise, 270000 - 10000); ok("order stores points redeemed, the discount they bought and a reduced earning basis");
  assert.equal((await bal(u1)).available, before - 100); assert.equal(one("SELECT count(*) n FROM points_ledger WHERE idem_key=?", `redeem:${red.order.id}`).n, 1); ok("verified payment spends the points (once)");
  await red.verify(); await red.verify(); assert.equal(one("SELECT count(*) n FROM points_ledger WHERE order_id=? AND kind='redeem'", red.order.id).n, 1); assert.equal((await bal(u1)).available, before - 100); ok("duplicate payment callbacks cannot spend points twice");
  assert.equal(one("SELECT count(*) n FROM orders WHERE txn_id=?", red.rz.id).n, 1);
  // reservation: an open checkout holds the points
  const hold = user(); member(hold); sqlite.prepare("INSERT INTO points_ledger (id,user_id,kind,points,expires_at,idem_key) VALUES ('seed-hold',?,'adjust',200,?,'seed-hold')").run(hold.id, NOW + 100 * DAY);
  const rr = await P("/api/create-order", { items: [{ id: "black-nfc-card", qty: 30 }], ...cust, quoteRef: "Qhold", redeemPoints: 200 }, hold.cookie); assert.equal(rr.status, 200);
  const held = await bal(hold); assert.equal(held.available, 0); assert.ok(held.held > 0); ok("points in an open checkout are held and cannot be used elsewhere");
  r = await quote(hold, [{ id: "black-nfc-card", qty: 30 }], { redeemPoints: 100 }); assert.equal(r.status, 409); ok("the same points cannot back a second checkout");
  sqlite.prepare("UPDATE points_ledger SET created_at=? WHERE kind='reserve' AND user_id=?").run(NOW - 4 * 3600, hold.id); assert.equal((await bal(hold)).available, 200); ok("an abandoned checkout releases its hold");
  const rr2 = await P("/api/create-order", { items: [{ id: "black-nfc-card", qty: 30 }], ...cust, quoteRef: "Qhold2", redeemPoints: 200 }, hold.cookie); assert.equal(rr2.status, 200); assert.equal(one("SELECT count(*) n FROM points_ledger WHERE user_id=? AND kind='reserve'", hold.id).n, 1); ok("retrying a checkout replaces the old hold instead of stacking holds");

  // ── refunds, cancellation, returns ──
  await deliver(red.order.id);
  const earnedOnRed = one("SELECT coalesce(sum(points),0) s FROM points_ledger WHERE order_id=? AND kind='earn'", red.order.id).s; assert.equal(earnedOnRed, Math.floor(260000 * 5 / 10000)); ok("points earned are on the net spend after the redemption discount");
  const b0 = (await bal(u1)).available;
  r = await A(OW, `/api/orders/${red.order.id}/refund`, { amount_rupees: String(red.order.paid_paise / 100 / 2), reason: "Half refund", idempotency_key: "rf-key-001", confirm: true }); assert.equal(r.status, 200);
  const rev = -one("SELECT coalesce(sum(points),0) s FROM points_ledger WHERE order_id=? AND kind='reverse'", red.order.id).s; assert.ok(rev >= Math.floor(earnedOnRed / 2) - 1 && rev <= Math.ceil(earnedOnRed / 2) + 1, `reversed ${rev} of ${earnedOnRed}`); assert.ok(b0 > (await bal(u1)).available); ok("a partial refund reverses the matching share of the points earned (and may take back a milestone it undercuts)");
  r = await A(OW, `/api/orders/${red.order.id}/status`, { to: "returned", confirm: true, idempotency_key: "ret1" }); assert.equal(r.status, 200);
  assert.equal(one("SELECT coalesce(sum(points),0) s FROM points_ledger WHERE order_id=? AND kind IN ('earn','reverse')", red.order.id).s, 0);
  assert.equal(one("SELECT points FROM points_ledger WHERE idem_key=?", `restore:${red.order.id}`).points, 100); ok("a return reverses all earned points and gives back the points that were spent");
  await POINTS.reconcileOrder(D1, red.order.id); await POINTS.reconcileOrder(D1, red.order.id); assert.equal(one("SELECT count(*) n FROM points_ledger WHERE order_id=? AND kind='restore'", red.order.id).n, 1); ok("reversals are idempotent");

  // ── milestones ──
  const u2 = user(); member(u2);
  let big1 = await buy(u2, "black-nfc-card", 60); await deliver(big1.order.id);          // 60 x ₹100 x 0.9 = ₹5,400
  const bonuses = () => q("SELECT ref,points FROM points_ledger WHERE user_id=? AND kind='bonus' ORDER BY points", u2.id);
  assert.deepEqual(bonuses().map((b) => b.ref), ["m1", "m2"]); ok("crossing ₹2,500 and ₹5,000 pays those two bonuses, once each");
  await POINTS.reconcileUser(D1, u2.id); await POINTS.reconcileUser(D1, u2.id); assert.equal(bonuses().length, 2); ok("concurrent or repeated processing cannot issue a bonus twice");
  let ms = (await me(u2)).milestones; assert.equal(ms.ladder.filter((l) => l.reached).length, 2); assert.equal(ms.next.thresholdPaise, 1000000); assert.equal(ms.next.remainingPaise, 1000000 - 540000); ok("dashboard shows progress and the next milestone");
  const w = await A(OW, "/api/points"); const list = w.d.milestones.map((m) => (m.id === "m2" ? { ...m, bonus_points: 999 } : m));
  r = await A(OW, "/api/points/milestones", { version: w.d.version, milestones: list }); assert.equal(r.status, 200);
  assert.equal(bonuses().find((b) => b.ref === "m2").points, 150); ok("editing a milestone never rewrites history already awarded");
  r = await A(OW, "/api/points/milestones", { version: (await A(OW, "/api/points")).d.version, milestones: [{ id: "m1", threshold_paise: 100, bonus_points: 1 }, { id: "m9", threshold_paise: 100, bonus_points: 2 }] }); assert.equal(r.status, 400); ok("duplicate active thresholds are rejected");
  r = await A(OW, "/api/points/milestones", { version: (await A(OW, "/api/points")).d.version, milestones: (await A(OW, "/api/points")).d.milestones }); assert.equal(r.status, 200);
  r = await A(OW, `/api/orders/${big1.order.id}/refund`, { amount_rupees: "3000", reason: "Refund below milestone", idempotency_key: "rf-key-002", confirm: true }); assert.equal(r.status, 200);
  assert.ok(q("SELECT 1 FROM points_ledger WHERE user_id=? AND kind='bonus_reverse'", u2.id).length >= 1); assert.ok((await bal(u2)).available >= 0); ok("with clawback on, a refund that drops spend under a milestone takes that bonus back, never below zero");

  // ── expiry ──
  const ex = user(); member(ex);
  sqlite.prepare("INSERT INTO points_ledger (id,user_id,kind,points,expires_at,idem_key) VALUES ('e1',?,'adjust',100,?,'e1'),('e2',?,'adjust',100,?,'e2')").run(ex.id, NOW - DAY, ex.id, NOW + 200 * DAY);
  assert.equal((await bal(ex)).available, 100); ok("expired points are excluded from the balance immediately");
  assert.equal(await POINTS.sweepExpiry(D1, NOW), 1); assert.equal(await POINTS.sweepExpiry(D1, NOW), 0); assert.equal((await bal(ex)).available, 100); assert.equal(one("SELECT coalesce(sum(points),0) s FROM points_ledger WHERE user_id=?", ex.id).s, 100); ok("the expiry sweep records the loss once");
  const ex2 = user(); member(ex2);
  sqlite.prepare("INSERT INTO points_ledger (id,user_id,kind,points,expires_at,idem_key) VALUES ('f1',?,'adjust',100,?,'f1'),('f2',?,'adjust',100,?,'f2'),('f3',?,'redeem',-100,NULL,'f3')").run(ex2.id, NOW - DAY, ex2.id, NOW + 200 * DAY, ex2.id);
  assert.equal((await bal(ex2)).available, 100); ok("spending uses the oldest points first, so only unspent points expire");

  // ── manual adjustments ──
  const adj = user();
  assert.equal((await A(ST, `/api/points/customers/${adj.id}/adjust`, { points: 100, reason: "Goodwill gesture", idempotency_key: "adj-key-1", confirm: true })).status, 403); ok("staff without owner rights cannot adjust a wallet");
  assert.equal((await A(OW, `/api/points/customers/${adj.id}/adjust`, { points: 100, reason: "no", idempotency_key: "adj-key-1", confirm: true })).status, 400);
  assert.equal((await A(OW, `/api/points/customers/${adj.id}/adjust`, { points: 100, reason: "Goodwill gesture", idempotency_key: "adj-key-1" })).status, 400); ok("an adjustment needs a reason and a confirmation");
  assert.equal((await A(OW, `/api/points/customers/${adj.id}/adjust`, { points: 100, reason: "Goodwill gesture", idempotency_key: "adj-key-1", confirm: true })).status, 200);
  assert.equal((await A(OW, `/api/points/customers/${adj.id}/adjust`, { points: 100, reason: "Goodwill gesture", idempotency_key: "adj-key-1", confirm: true })).d.duplicate, true); assert.equal((await bal(adj)).available, 100); ok("adjustments are idempotent and audited");
  assert.equal((await A(OW, `/api/points/customers/${adj.id}/adjust`, { points: -500, reason: "Correction attempt", idempotency_key: "adj-key-2", confirm: true })).status, 409); ok("an adjustment cannot make a balance negative");
  assert.ok(one("SELECT 1 x FROM audit_log WHERE action='points_adjust'")); const det = await A(OW, `/api/points/customers/${adj.id}`); assert.equal(det.d.summary.wallet.availablePoints, 100); assert.equal(det.d.activity.entries[0].reason, "Goodwill gesture"); ok("admin sees the customer's wallet and ledger with the reason");

  // ── renewal ──
  const rn = user(); member(rn, { start: NOW - 100 * DAY, days: 365 });
  r = await P("/api/membership/create-order", {}, rn.cookie); assert.equal(r.status, 409); ok("renewal is refused outside the renewal window");
  const soon = user(); const sid = member(soon, { start: NOW - 350 * DAY, days: 365 });
  r = await P("/api/membership/create-order", {}, soon.cookie); assert.equal(r.status, 200); const rz = await r.json();
  const pay = "pay_renew1"; const sig = await hmac("rzp_secret", `${rz.id}|${pay}`);
  global.fetch = async (url, opts) => String(url).includes("/v1/orders/") ? Response.json({ id: rz.id, amount: rz.amount, amount_paid: rz.amount, receipt: `tp-${soon.id.slice(0, 8)}`, notes: { days: "365" } }) : String(url).includes("api.razorpay.com") ? Response.json({ id: "order_X" + Math.random().toString(36).slice(2, 9), amount: JSON.parse(opts.body).amount, currency: "INR" }) : realFetch(url, opts);
  r = await P("/api/membership/verify-payment", { razorpay_order_id: rz.id, razorpay_payment_id: pay, razorpay_signature: sig }, soon.cookie); const vv = await r.json(); assert.equal(r.status, 200); assert.equal(vv.renewed, true);
  const rows = q("SELECT purchased_at,expires_at FROM memberships WHERE user_id=? ORDER BY purchased_at", soon.id); assert.equal(rows.length, 2); assert.equal(rows[1].purchased_at, rows[0].expires_at); assert.equal(rows[1].expires_at, rows[0].expires_at + 365 * DAY); ok("a renewal starts when the current term ends: no days lost or doubled");
  const dup = await P("/api/membership/verify-payment", { razorpay_order_id: rz.id, razorpay_payment_id: pay, razorpay_signature: sig }, soon.cookie); assert.equal((await dup.json()).ok, true); assert.equal(one("SELECT count(*) n FROM memberships WHERE user_id=?", soon.id).n, 2); ok("a repeated payment callback does not create a second membership");
  assert.equal((await P("/api/membership/create-order", {}, soon.cookie)).status, 409); ok("only one renewal can be queued");
  const ms2 = await me(soon); assert.equal(ms2.membership.active, true); assert.equal(ms2.membership.expiresAt, rows[1].expires_at); ok("dashboard shows the end of the renewed term");
  global.fetch = async (url, opts) => String(url).includes("api.razorpay.com") ? Response.json({ id: "order_T" + Math.random().toString(36).slice(2, 11), amount: JSON.parse(opts.body).amount, currency: "INR" }) : realFetch(url, opts);

  // ── admin grant / end ──
  r = await A(OW, "/api/members/grant", { email: "m999@example.test", days: 30, reason: "Bank transfer received", confirm: true }); assert.equal(r.status, 404);
  const gu = user(); r = await A(ST, "/api/members/grant", { email: `m${uc}@example.test`, days: 30, reason: "Bank transfer received", confirm: true }); assert.equal(r.status, 403);
  r = await A(OW, "/api/members/grant", { email: `m${uc}@example.test`, days: 30, reason: "Bank transfer received", confirm: true }); assert.equal(r.status, 201); assert.ok(one("SELECT 1 x FROM audit_log WHERE action='membership_grant'")); ok("only the owner can activate a membership by hand, with a reason, audited");
  r = await A(OW, `/api/members/${r.d.membership_id}/end`, { status: "refunded", reason: "Refunded in full", confirm: true }); assert.equal(r.status, 200); assert.equal((await me(gu)).membership.active, false); ok("a refunded membership stops giving benefits");

  // ── notices ──
  const nt = user(); const nmid = member(nt, { start: NOW - 360 * DAY, days: 365 });
  await memAdmin.tick(aenv); await memAdmin.tick(aenv);
  assert.equal(q("SELECT * FROM membership_notices WHERE membership_id=?", nmid).length, 1); assert.equal(one("SELECT kind FROM membership_notices WHERE membership_id=?", nmid).kind, "expiry_7"); ok("an expiry notice is sent once per threshold, not repeatedly");
  assert.equal(q("SELECT * FROM membership_notices WHERE membership_id=?", sid).length, 0); ok("no notice when a renewal is already queued");

  // ── product exclusion ──
  r = await A(OW, "/api/products/black-nfc-card", { points_eligible: false }); assert.equal(r.status, 200);
  const ex3 = user(); member(ex3); o = await buy(ex3, "black-nfc-card", 30); assert.equal(o.order.points_basis_paise, 0); assert.ok(o.order.member_saving_paise > 0); ok("an excluded product earns no points but still gets the member price");
  r = await A(OW, "/api/products/black-nfc-card", { points_eligible: false }); await A(OW, "/api/products/black-nfc-card", { points_eligible: true });

  // ── tier points rates (migration 0015): Silver ₹5,000 3 / Gold ₹25,000 5 / Diamond ₹50,000 10 points per ₹100 ──
  setCfg("pts_earn_on", "paid"); const LOYALTY = require(path.join(root, "functions", "lib", "loyalty.js"));
  const withSpend = (paise) => { const u = user(); member(u); if (paise) sqlite.prepare("INSERT INTO loyalty_adjustments (id,user_id,delta_paise,reason,actor,spend_before,spend_after,idempotency_key) VALUES (?,?,?,?,?,0,?,?)").run(crypto.randomUUID(), u.id, paise, "test spend", "test", paise, "t" + crypto.randomUUID()); LOYALTY.resetTiersCache(); return u; };
  const earnedBy = async (u) => { const b = await buy(u, "black-nfc-card", 30); assert.equal(b.order.points_basis_paise, 270000); return { b, pts: q("SELECT coalesce(sum(points),0) s FROM points_ledger WHERE order_id=? AND kind IN ('earn','reverse')", b.order.id)[0].s }; };
  assert.equal((await earnedBy(withSpend(499999))).pts, 135); ok("below ₹5,000 qualifying spend: no tier yet, the flat rate (5 per ₹100) applies");
  const sil = await earnedBy(withSpend(500000)); assert.equal(sil.pts, 81); assert.equal(sil.b.order.points_rate_x100, 300); ok("exactly ₹5,000 reaches Silver: 3 points per ₹100, rate frozen on the order");
  assert.equal((await earnedBy(withSpend(2499999))).pts, 81); assert.equal((await earnedBy(withSpend(2500000))).pts, 135); ok("Gold starts at ₹25,000 cumulative (not ₹30,000): 5 per ₹100");
  assert.equal((await earnedBy(withSpend(4999999))).pts, 135); assert.equal((await earnedBy(withSpend(5000000))).pts, 270); ok("Diamond starts at ₹50,000: 10 per ₹100");
  assert.equal(q("SELECT discount_pct FROM loyalty_tiers WHERE id IN ('silver','gold','diamond') AND discount_pct<>0").length, 0); ok("tier rates are points rates: the default tiers give no price discount");
  const cfgT = await A(OW, "/api/rewards"); const bump = (id, v) => cfgT.d.tiers.map((x) => (x.id === id ? { ...x, points_per_100: v } : x));
  assert.equal((await A(OW, "/api/rewards", { version: cfgT.d.version, settings: { live: false }, tiers: bump("silver", 101) })).status, 400); assert.equal((await A(OW, "/api/rewards", { version: cfgT.d.version, settings: { live: false }, tiers: bump("silver", -1) })).status, 400); ok("invalid points rates are rejected by the admin API");
  assert.equal((await A(OW, "/api/rewards", { version: cfgT.d.version, settings: { live: false }, tiers: bump("silver", 4) })).status, 200); payments.resetPricingCache(); LOYALTY.resetTiersCache();
  await POINTS.reconcileOrder(D1, sil.b.order.id); assert.equal(q("SELECT coalesce(sum(points),0) s FROM points_ledger WHERE order_id=? AND kind IN ('earn','reverse')", sil.b.order.id)[0].s, 81); ok("an admin rate change does not rewrite points already earned on an order");
  assert.equal(q("SELECT points_rate_x100 r FROM orders WHERE id=?", sil.b.order.id)[0].r, 300);
  sqlite.prepare("UPDATE orders SET refunded_paise=paid_paise/2 WHERE id=?").run(sil.b.order.id); await POINTS.reconcileOrder(D1, sil.b.order.id); await POINTS.reconcileOrder(D1, sil.b.order.id);
  const half = q("SELECT coalesce(sum(points),0) s, count(*) n FROM points_ledger WHERE order_id=? AND kind IN ('earn','reverse')", sil.b.order.id)[0]; assert.ok(half.s >= 40 && half.s <= 41); assert.equal(half.n, 2); ok("a partial refund reverses points at the frozen rate, once; repeated reconciliation adds nothing");
  const qs = await quote(withSpend(500000), [{ id: "black-nfc-card", qty: 30 }]); assert.equal(qs.d.points.ratePer100, 4); ok("quote shows the points rate of the customer's current tier");
  setCfg("pts_earn_on", "delivered");

  // ── analytics + access ──
  r = await A(OW, "/api/points/analytics?range=90d"); assert.equal(r.status, 200); assert.ok(r.d.points.issued > 0); assert.ok(r.d.memberships.active >= 5); assert.equal(r.d.economics.product_contribution_paise, null); assert.match(r.d.economics.note, /not profit/); ok("analytics: memberships, points liability and economics; contribution is withheld without full cost data");
  assert.equal((await A("nobody", "/api/points")).status, 401); ok("admin points API requires an admin session");
  console.log(`\n${n} points checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
