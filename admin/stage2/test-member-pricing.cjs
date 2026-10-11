// Member pricing end to end: shared engine, guardrails, membership eligibility/expiry, checkout + quote consistency,
// browser tampering, admin preview/publish (auth, validation, stale drafts, audit) and admin preview == checkout charge.
// Both Workers run against ONE in-memory D1, like production.
const assert = require("node:assert/strict");
const path = require("node:path");
const worker = require(path.join(__dirname, "..", "..", "functions", "api", "[[path]].js"));
const PRICING = require(path.join(__dirname, "..", "..", "functions", "lib", "pricing.js"));
const { makeDb } = require("./d1shim.cjs");
const { sqlite, D1, one } = makeDb();
const env = { DB: D1, RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "rzp_secret" };
const adminEnv = { DB: D1, ADMIN_EMAILS: "boss@example.test", DEV_OTP_ECHO: "1" };
const ORIGIN = "https://www.ntagz.com";
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const run = (sql, ...a) => sqlite.prepare(sql).run(...a);

const call = (p, body, extra = {}) => { worker.resetPricingCache(); return worker.onRequest({ request: new Request("https://x" + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...extra }, body: body ? JSON.stringify(body) : undefined }), env }); };
const rzpOrders = [];
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("api.razorpay.com/v1/orders/")) return Response.json(rzpOrders.find((o) => u.endsWith(o.id)) || {}, { status: 200 });
  if (u.includes("api.razorpay.com/v1/orders")) { const b = JSON.parse(opts.body); const o = { id: "order_" + Math.random().toString(36).slice(2, 10), amount: b.amount, amount_paid: 0, receipt: b.receipt, notes: b.notes, currency: "INR" }; rzpOrders.push(o); return Response.json(o); }
  throw new Error("unexpected fetch " + u);
};

(async () => {
  const S = (o = {}) => PRICING.settingsFrom({ discounts_live: "1", max_total_discount_pct: "30", min_margin_pct: "20", ...o });
  const live = (o = {}) => ({ "black-nfc-card": { price_paise: 3000, member_discount_pct: 10, cost_paise: null, ...o } });
  const price = (items, member, settings = S(), l = live()) => PRICING.priceCart(items, { products: PRICING.PRODUCTS, live: l, state: "Maharashtra", member, settings });

  // ── engine ──
  assert.equal(price([{ id: "black-nfc-card", qty: 10 }], false).amount, 394); ok("guest price unchanged by the engine (₹394 for 10 black cards)");
  const m10 = price([{ id: "black-nfc-card", qty: 10 }], true);
  assert.equal(m10.lines[0].memberPct, 10); assert.equal(m10.memberDiscount, 30); assert.equal(m10.amount, Math.round(270 + Math.round(270 * 0.18) + 40)); ok("member: 10% off after bulk, GST on the discounted value");
  assert.equal(price([{ id: "black-nfc-card", qty: 10 }], true, S({ discounts_live: "0" })).memberDiscount, 0); ok("member pricing switched off -> no member discount");
  const big = price([{ id: "black-nfc-card", qty: 5000 }], true);
  assert.equal(big.lines[0].bulkPct, 25); assert.equal(big.lines[0].limit, "cap"); assert.ok(big.lines[0].memberPct < 6.67 && big.lines[0].memberPct > 6.6);
  assert.ok((1 - (1 - 0.25) * (1 - big.lines[0].memberPct / 100)) * 100 <= 30); ok("cap: 25% bulk + 10% member limited to 30% combined (member part only)");
  assert.equal(price([{ id: "black-nfc-card", qty: 5000 }], true, S({ max_total_discount_pct: "20" })).lines[0].memberPct, 0); ok("bulk alone above the cap: member gets 0, bulk untouched");
  const fl = price([{ id: "black-nfc-card", qty: 10 }], true, S(), live({ cost_paise: 2500 })); // floor = 25/0.8 = 31.25 > 30
  assert.equal(fl.lines[0].memberPct, 0); assert.equal(fl.lines[0].limit, "margin"); assert.equal(fl.amount, 394); ok("margin floor: never sells a member below cost/(1-margin); guest unchanged");
  const fl2 = price([{ id: "black-nfc-card", qty: 10 }], true, S(), live({ cost_paise: 2000 })); // floor 25 -> max 16.6% but asked 10
  assert.equal(fl2.lines[0].memberPct, 10); assert.equal(fl2.lines[0].limit, null); ok("margin floor does not interfere when the discount is safe");
  const kit = price([{ id: "sample-kit", qty: 1 }], true, S(), { "sample-kit": { price_paise: 194000, member_discount_pct: 50 } });
  assert.equal(kit.memberDiscount, 0); ok("fixed kits never get member pricing");
  assert.equal(price([{ id: "black-nfc-card", qty: 10 }], true, S(), live({ member_discount_pct: 400 })).lines[0].memberPct, 30); ok("absurd stored % is clamped (50% ceiling, then the 30% cap)");
  assert.equal(price([{ id: "black-nfc-card", qty: -5 }], true), null); assert.equal(price([{ id: "black-nfc-card", qty: 10.5 }], true), null); assert.equal(price([{ id: "nope", qty: 10 }], true), null); ok("invalid quantities and unknown products are rejected");

  // ── membership eligibility at checkout ──
  run("UPDATE membership_config SET value='1' WHERE key='discounts_live'");
  run("UPDATE products SET member_discount_pct=10 WHERE id='black-nfc-card'");
  run("INSERT INTO users (id,email) VALUES ('u-member','m@example.test'),('u-plain','p@example.test')");
  run("INSERT INTO sessions (id,user_id,expires_at) VALUES ('sess-member-000000000001','u-member',unixepoch()+3600),('sess-plain-0000000000001','u-plain',unixepoch()+3600)");
  run("INSERT INTO memberships (id,user_id,status,expires_at) VALUES ('mem1','u-member','active',unixepoch()+86400)");
  const asMember = { Cookie: "ntagz_session=sess-member-000000000001" }, asPlain = { Cookie: "ntagz_session=sess-plain-0000000000001" };
  const cart = { items: [{ id: "black-nfc-card", qty: 10 }], state: "Maharashtra", name: "A T", phone: "9876543210", address: "1 Main St Pune", pincode: "411001", quoteRef: "Q1" };
  const amountOf = async (h, body = cart) => (await (await call("/api/create-order", body, h)).json()).amount;
  assert.equal(await amountOf({}), 39400); assert.equal(await amountOf(asPlain), 39400); ok("guest and signed-in non-member pay the regular price");
  const memberAmount = await amountOf(asMember);
  assert.equal(memberAmount, (270 + Math.round(270 * 0.18) + 40) * 100); ok("active member is charged the member price by checkout");
  assert.equal(await amountOf({ Cookie: "ntagz_session=forged-session-value-123" }), 39400); ok("forged session cookie gets regular prices");
  assert.equal(await amountOf(asMember, { ...cart, amount: 1, price: 1, total: 1, items: [{ id: "black-nfc-card", qty: 10, price: 0.01, member_discount_pct: 99 }] }), memberAmount); ok("price/amount/discount fields sent by the browser are ignored");
  run("UPDATE memberships SET expires_at=unixepoch()-1 WHERE id='mem1'");
  assert.equal(await amountOf(asMember), 39400); ok("expired membership -> regular prices");
  run("UPDATE memberships SET expires_at=unixepoch()+86400, status='cancelled' WHERE id='mem1'");
  assert.equal(await amountOf(asMember), 39400); ok("cancelled membership -> regular prices");
  run("UPDATE memberships SET status='active' WHERE id='mem1'");
  const off = await call("/api/orders/offline", { ...cart, method: "upi", quoteRef: "QOFF1" }, asMember);
  assert.equal((await off.json()).total * 100, memberAmount); ok("offline (UPI/WhatsApp) orders are priced by the same engine");

  // ── /api/quote ──
  const q = await (await call("/api/quote", { items: cart.items, state: "Maharashtra", compare: true }, asMember)).json();
  assert.equal(q.you.amount * 100, memberAmount); assert.equal(q.signedInMember, true); assert.equal(q.guest.amount, 394); assert.equal(q.member.amount * 100, memberAmount); ok("quote: member sees exactly the checkout amount; compare returns guest + member");
  const qg = await (await call("/api/quote", { items: cart.items, state: "Maharashtra" })).json();
  assert.equal(qg.you.amount, 394); assert.equal(qg.signedInMember, false); ok("quote for a guest = guest price");
  run("UPDATE products SET active=0 WHERE id='white-nfc-card'");
  assert.equal((await call("/api/quote", { items: [{ id: "white-nfc-card", qty: 10 }] })).status, 409); run("UPDATE products SET active=1 WHERE id='white-nfc-card'"); ok("quote refuses inactive products like checkout does");
  assert.equal((await call("/api/quote", { items: cart.items }, { Origin: "https://evil.example" })).status, 403); ok("quote rejects foreign origins");

  // ── membership purchase uses configured fee and length; not sold while pricing is off ──
  run("UPDATE membership_config SET value='149900' WHERE key='fee_paise'"); run("UPDATE membership_config SET value='180' WHERE key='duration_days'");
  const co = await (await call("/api/membership/create-order", {}, asPlain)).json();
  assert.equal(co.amount, 149900); ok("membership order uses the configured fee");
  const rp = rzpOrders.find((o) => o.id === co.id); rp.amount_paid = rp.amount;
  const hmac = async (msg) => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode("rzp_secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(msg))), (b) => b.toString(16).padStart(2, "0")).join("");
  const vr = await call("/api/membership/verify-payment", { razorpay_order_id: rp.id, razorpay_payment_id: "pay_x", razorpay_signature: await hmac(`${rp.id}|pay_x`) }, asPlain);
  assert.equal(vr.status, 200);
  const mrow = one("SELECT * FROM memberships WHERE user_id='u-plain'");
  assert.equal(mrow.price_paid, 149900); assert.equal(mrow.welcome_credit_paise, 0); assert.ok(Math.abs(mrow.expires_at - mrow.purchased_at - 180 * 86400) < 5); ok("verified purchase records the fee paid and the configured length, no phantom credit");
  const half = { ...rzpOrders[0], id: "order_half", amount: 149900, amount_paid: 100, receipt: rp.receipt }; rzpOrders.push(half);
  run("DELETE FROM memberships WHERE user_id='u-plain'");
  assert.equal((await call("/api/membership/verify-payment", { razorpay_order_id: "order_half", razorpay_payment_id: "pay_h", razorpay_signature: await hmac("order_half|pay_h") }, asPlain)).status, 400); ok("partly paid membership order is refused");
  run("UPDATE membership_config SET value='0' WHERE key='discounts_live'");
  assert.equal((await call("/api/membership/create-order", {}, asPlain)).status, 409); ok("membership cannot be bought while member pricing is off");
  run("UPDATE membership_config SET value='1' WHERE key='discounts_live'"); run("UPDATE membership_config SET value='99900' WHERE key='fee_paise'"); run("UPDATE membership_config SET value='365' WHERE key='duration_days'");

  // ── admin: auth, preview, publish ──
  const admin = (await import(path.join(__dirname, "..", "src", "index.js"))).default;
  const A = (p, body, headers = {}) => admin.fetch(new Request("https://admin.ntagz.com" + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin", ...headers }, body: body ? JSON.stringify(body) : undefined }), adminEnv);
  assert.equal((await A("/api/pricing")).status, 401); assert.equal((await A("/api/pricing/publish", { draft: {} })).status, 401); ok("pricing API needs an admin session");
  const otp = (await (await A("/api/auth/request", { email: "boss@example.test" })).json()).dev_otp;
  const login = await A("/api/auth/verify", { email: "boss@example.test", otp });
  const C = { Cookie: login.headers.get("Set-Cookie").split(";")[0] };
  assert.equal((await A("/api/pricing/publish", { draft: {} }, { ...C, "X-Requested-With": "" })).status, 403); ok("state-changing pricing calls need the admin CSRF header");
  const g = await (await A("/api/pricing", null, C)).json();
  const bc = g.products.find((p) => p.id === "black-nfc-card");
  assert.equal(bc.member_discount_pct, 10); assert.equal(bc.tiers[0].unitPrice, 27); assert.equal(g.settings.live, true); assert.ok(g.version); ok("admin sees live member % and member price per bulk tier");
  assert.ok(bc.warnings.some((w) => /No cost price/.test(w))); assert.ok(bc.warnings.some((w) => /cap/.test(w))); ok("admin warned: no cost price, cap limits the 5,000+ tier");

  const draft = { settings: { max_total_discount_pct: 35 }, products: { "black-nfc-card": 12 } };
  const before = one("SELECT member_discount_pct FROM products WHERE id='black-nfc-card'").member_discount_pct;
  const pv = await (await A("/api/pricing/preview", { draft, items: cart.items, state: "Maharashtra" }, C)).json();
  assert.equal(one("SELECT member_discount_pct FROM products WHERE id='black-nfc-card'").member_discount_pct, before); ok("preview never changes live prices");
  assert.equal(pv.basket.guest.amount, 394); assert.equal(pv.basket.member.lines[0].memberPct, 12); assert.deepEqual(pv.changes.products["black-nfc-card"], { from: 10, to: 12 }); ok("preview prices the basket for guest and member with the draft");
  assert.equal((await A("/api/pricing/preview", { draft: { products: { "black-nfc-card": -5 } } }, C)).status, 400);
  assert.equal((await A("/api/pricing/preview", { draft: { products: { "black-nfc-card": 51 } } }, C)).status, 400);
  assert.equal((await A("/api/pricing/preview", { draft: { settings: { fee: "-1" } } }, C)).status, 400); ok("negative or excessive discounts and fees are rejected server-side");
  assert.equal((await A("/api/pricing/publish", { draft, version: "stale", confirm: true }, C)).status, 409); ok("publish refuses a draft made against older live values");
  assert.equal((await A("/api/pricing/publish", { draft, version: g.version }, C)).status, 400); ok("publish requires explicit confirmation");
  const allZero = { settings: { live: true }, products: Object.fromEntries(g.products.map((p) => [p.id, 0])) };
  const blk = await A("/api/pricing/publish", { draft: allZero, version: g.version, confirm: true }, C);
  assert.equal(blk.status, 409); assert.match((await blk.json()).error, /no active product/); ok("blocks publishing member pricing that gives members nothing");
  const pub = await A("/api/pricing/publish", { draft, version: g.version, confirm: true }, C);
  assert.equal(pub.status, 200);
  assert.equal(one("SELECT member_discount_pct FROM products WHERE id='black-nfc-card'").member_discount_pct, 12);
  assert.equal(one("SELECT value FROM membership_config WHERE key='max_total_discount_pct'").value, "35");
  const audit = JSON.parse(one("SELECT detail FROM audit_log WHERE action='pricing_publish'").detail);
  assert.deepEqual(audit.products["black-nfc-card"], { from: 10, to: 12 }); assert.equal(audit.settings.max_total_discount_pct.to, "35"); ok("publish applies atomically and is recorded in the audit log with old -> new values");
  const pubData = await pub.json();
  assert.ok(pubData.history.some((h) => h.action === "pricing_publish")); ok("change history lists the publication");

  // admin preview == what checkout charges now (same engine, same data)
  const pv2 = await (await A("/api/pricing/preview", { draft: {}, items: [{ id: "black-nfc-card", qty: 5000 }, { id: "google-review-nfc-stand-5x5", qty: 20 }], state: "Karnataka" }, C)).json();
  const chk = await amountOf(asMember, { ...cart, state: "Karnataka", items: [{ id: "black-nfc-card", qty: 5000 }, { id: "google-review-nfc-stand-5x5", qty: 20 }] });
  assert.equal(pv2.basket.member.amount * 100, chk); ok(`admin preview member total (₹${pv2.basket.member.amount}) == checkout charge`);
  const pcfg = await (await call("/api/membership/pricing")).json();
  assert.equal(pcfg.products["black-nfc-card"], 12); assert.equal(pcfg.maxTotalDiscountPct, 35); ok("public membership page reads the published values");

  // regular price change in Products: member price follows (percentage), and an open pricing draft becomes stale
  const prod = await A("/api/products/black-nfc-card", { price: "40" }, C);
  assert.equal(prod.status, 200);
  assert.equal((await (await call("/api/quote", { items: cart.items, state: "" }, asMember)).json()).you.memberDiscount, 48); ok("member price follows a regular price change (12% of ₹400)");
  const g2 = await (await A("/api/pricing", null, C)).json();
  assert.notEqual(g2.version, pubData.version); ok("a regular price change invalidates older pricing drafts");
  const ms = await (await A("/api/memberships", null, C)).json();
  assert.ok(ms.memberships.some((m) => m.email === "m@example.test" && m.active)); ok("admin member list shows status");

  // workers deployed before migration 0010: no column -> no member discount, checkout keeps working
  run("ALTER TABLE products DROP COLUMN member_discount_pct");
  assert.equal(await amountOf(asMember), Math.round(400 + Math.round(400 * 0.18) + 40) * 100); ok("without migration 0010, checkout still works at regular prices");
  console.log(`\nall ${n} member-pricing checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
