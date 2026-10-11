// Hardening: customer OTP brute-force/rate limits, membership payment binding, private no-store, non-preorder shortfall hold.
const assert = require("node:assert/strict");
const path = require("node:path");
const worker = require(path.join(__dirname, "..", "..", "functions", "api", "[[path]].js"));
const { makeDb } = require("./d1shim.cjs");
const { sqlite, D1, one } = makeDb();
const env = { DB: D1, RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "rzp_secret" };
const ORIGIN = "https://www.ntagz.com";
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const hmac = async (secret, msg) => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(msg))), (b) => b.toString(16).padStart(2, "0")).join("");
const call = (p, body, extra = {}) => { worker.resetPricingCache(); return worker.onRequest({ request: new Request("https://x" + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...extra }, body: body ? JSON.stringify(body) : undefined }), env }); };
let rpOrder = { id: "order_M1", amount: 99900, amount_paid: 99900, receipt: "" };
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("api.razorpay.com/v1/orders/")) return Response.json(rpOrder);
  if (u.includes("api.razorpay.com/v1/orders")) return Response.json({ id: "order_T" + Math.random().toString(36).slice(2, 11), amount: JSON.parse(opts.body).amount, currency: "INR" });
  return realFetch(url, opts);
};

(async () => {
  const email = "u@example.test";
  const real = "123456"; // plant a known code (stored hashed)
  assert.equal((await call("/api/accounts/auth/send-otp", { email })).status, 200);
  const id = one("SELECT id FROM otp_tokens WHERE email=? AND used=0", email).id;
  const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ntagz:otp:${email}:${real}`))), (b) => b.toString(16).padStart(2, "0")).join("");
  sqlite.prepare("UPDATE otp_tokens SET otp=? WHERE id=?").run(h, id);
  assert.notEqual(one("SELECT otp FROM otp_tokens WHERE id=?", id).otp, real); ok("OTP stored hashed, not plaintext");
  for (let i = 0; i < 5; i++) assert.equal((await call("/api/accounts/auth/verify-otp", { email, otp: "000000" })).status, 401);
  assert.equal((await call("/api/accounts/auth/verify-otp", { email, otp: real })).status, 401); ok("5 wrong guesses lock the code, even the right one fails");

  assert.equal((await call("/api/accounts/auth/send-otp", { email })).status, 200);
  assert.equal((await call("/api/accounts/auth/send-otp", { email })).status, 200);
  assert.equal((await call("/api/accounts/auth/send-otp", { email })).status, 429); ok("send-otp limited to 3 per 15 min per email");

  const e2 = "v@example.test";
  await call("/api/accounts/auth/send-otp", { email: e2 });
  const id2 = one("SELECT id FROM otp_tokens WHERE email=? AND used=0", e2).id;
  const h2 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ntagz:otp:${e2}:${real}`))), (b) => b.toString(16).padStart(2, "0")).join("");
  sqlite.prepare("UPDATE otp_tokens SET otp=? WHERE id=?").run(h2, id2);
  const ver = await call("/api/accounts/auth/verify-otp", { email: e2, otp: real });
  assert.equal(ver.status, 200);
  const cookie = ver.headers.get("Set-Cookie").split(";")[0]; ok("correct code logs in");
  assert.equal((await call("/api/accounts/auth/verify-otp", { email: e2, otp: real })).status, 401); ok("code is single-use");

  const me = await call("/api/accounts/me", null, { Cookie: cookie });
  assert.equal(me.headers.get("Cache-Control"), "no-store"); assert.equal(me.headers.get("X-Content-Type-Options"), "nosniff"); ok("private responses are no-store + nosniff");

  // membership: Razorpay order must be this user's, full Trade Pass amount
  const uid = one("SELECT id FROM users WHERE email=?", e2).id;
  const verify = async (o) => { rpOrder = o; return call("/api/membership/verify-payment", { razorpay_order_id: o.id, razorpay_payment_id: "pay_1", razorpay_signature: await hmac("rzp_secret", `${o.id}|pay_1`) }, { Cookie: cookie }); };
  assert.equal((await verify({ id: "order_cheap", amount: 1600, amount_paid: 1600, receipt: "x" })).status, 400);
  assert.equal((await verify({ id: "order_other", amount: 99900, amount_paid: 99900, receipt: "tp-someone1" })).status, 400);
  assert.equal(one("SELECT count(*) c FROM memberships").c, 0); ok("cheap or foreign Razorpay order cannot buy a Trade Pass");
  const good = { id: "order_good", amount: 99900, amount_paid: 99900, receipt: `tp-${uid.slice(0, 8)}` };
  assert.equal((await verify(good)).status, 200); assert.equal((await verify(good)).status, 200);
  assert.equal(one("SELECT count(*) c FROM memberships").c, 1); ok("valid Trade Pass order recorded once");
  assert.throws(() => sqlite.prepare("INSERT INTO memberships (id,user_id,status,purchased_at,expires_at,razorpay_order_id) VALUES ('d',?, 'active',1,2,'order_good')").run(uid)); ok("unique index blocks duplicate membership per Razorpay order");

  // non-preorder shortfall (concurrent buyers) holds the paid order
  sqlite.prepare("UPDATE products SET track_stock=1, stock_qty=1, preorder_enabled=0 WHERE id='uhf-rfid-label'").run();
  const cust = { name: "A T", phone: "9876543210", address: "1 Main Street, Pune", pincode: "411001", state: "Maharashtra", email: "a@example.test" };
  const start = async (pid) => { const d = await (await call("/api/create-order", { items: [{ id: "uhf-rfid-label", qty: 1 }], ...cust, quoteRef: "Q" + pid })).json(); if (!d.id) throw new Error(JSON.stringify(d)); return d.id; };
  const pay = async (id, pid) => { await call("/api/verify-payment", { razorpay_order_id: id, razorpay_payment_id: pid, razorpay_signature: await hmac("rzp_secret", `${id}|${pid}`) }); return one("SELECT * FROM orders WHERE txn_id=?", id); };
  const [a, b] = [await start("pay_a"), await start("pay_b")]; // both saw stock=1
  const o1 = await pay(a, "pay_a"), o2 = await pay(b, "pay_b");
  assert.notEqual(o1.status, "on_hold"); assert.equal(o2.status, "on_hold"); assert.equal(o2.payment_status, "paid"); ok("last unit: first buyer fine, second paid order held for admin");
  // public member pricing endpoint: off by default, mirrors checkout config when on, never needs a session
  let pr = await (await call("/api/membership/pricing")).json();
  assert.equal(pr.live, false); assert.deepEqual(pr.products, {}); ok("pricing endpoint: member pricing off -> live:false, no discounts");
  sqlite.prepare("UPDATE membership_config SET value='1' WHERE key='discounts_live'").run();
  sqlite.prepare("UPDATE products SET member_discount_pct=10 WHERE id='black-nfc-card'").run(); // per-product % (migration 0010)
  sqlite.prepare("UPDATE products SET member_discount_pct=12 WHERE id='google-review-nfc-card'").run();
  sqlite.prepare("UPDATE products SET member_discount_pct=20 WHERE id='sample-kit'").run(); // fixed kit: must stay excluded
  const pres = await call("/api/membership/pricing"); pr = await pres.json();
  assert.equal(pr.live, true); assert.equal(pr.products["black-nfc-card"], 10); assert.equal(pr.products["google-review-nfc-card"], 12);
  assert.equal(pr.products["sample-kit"], undefined); assert.equal(pres.headers.get("Cache-Control"), "public, max-age=300");
  assert.equal(pr.feePaise, 99900); ok("pricing endpoint: per-product %s, sample kit excluded, cacheable, no session needed");
  console.log(`\nall ${n} hardening checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
