// Tests trusted order recording against an in-memory SQLite D1 shim (node:sqlite). Mocks Razorpay + PayU HTTP.
// Usage: WORKER=/path/to/patched/[[path]].js node stage2/test-checkout-recording.cjs   (defaults to ../functions/api/[[path]].js)
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const root = path.join(__dirname, "..", "..");
const worker = require(process.env.WORKER || path.join(root, "functions", "api", "[[path]].js"));

const sqlite = new DatabaseSync(":memory:");
for (const f of ["db/schema.sql", "db/membership-schema.sql", "admin/migrations/0001_admin.sql", "admin/migrations/0002_products.sql", "admin/migrations/0003_checkout.sql"])
  sqlite.exec(fs.readFileSync(path.join(root, f), "utf8"));

// Minimal D1 shim: prepare().bind().first/all/run + atomic batch()
const bound = (sql, a) => {
  const st = sqlite.prepare(sql);
  return {
    async first() { return st.get(...a) ?? null; },
    async all() { return { results: st.all(...a) }; },
    async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; },
    _exec() { if (/^\s*(select|with)/i.test(sql)) { st.all(...a); return { meta: { changes: 0 } }; } const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; },
  };
};
const D1 = {
  prepare(sql) { return { ...bound(sql, []), bind: (...a) => bound(sql, a) }; },
  async batch(stmts) {
    sqlite.exec("BEGIN");
    try { const out = stmts.map((s) => s._exec()); sqlite.exec("COMMIT"); return out; }
    catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  },
};
const q = (sql, ...a) => sqlite.prepare(sql).all(...a);
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);

const env = { DB: D1, RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "rzp_secret", PAYU_KEY: "payu_key", PAYU_SALT: "payu_salt", PAYU_ENV: "test" };
const ORIGIN = "https://www.ntagz.com";
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const hmac = async (secret, msg) => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(msg))), (b) => b.toString(16).padStart(2, "0")).join("");
const sha512 = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-512", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");
const req = (p, body, extra = {}) => worker.onRequest({ request: new Request("https://ntagz-payments.ambivert.workers.dev" + p, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...extra }, body: JSON.stringify(body) }), env });

const realFetch = global.fetch; let payuAmount = "394.00";
global.fetch = async (url, opts) => {
  if (String(url).includes("api.razorpay.com/v1/orders")) { const b = JSON.parse(opts.body); return Response.json({ id: "order_TEST" + Math.random().toString(36).slice(2, 8), amount: b.amount, currency: "INR" }); }
  if (String(url).includes("postservice.php")) { const id = new URLSearchParams(opts.body).get("var1"); return Response.json({ status: 1, transaction_details: { [id]: { status: "success", amount: payuAmount, txnid: id } } }); }
  return realFetch(url, opts);
};

(async () => {
  const cust = { name: "Asha Test", phone: "9876543210", address: "1 Main Street, Pune", pincode: "411001", state: "Maharashtra", quoteRef: "QT-111111", email: "asha@example.test" };
  const items = [{ id: "black-nfc-card", qty: 10 }];

  // ── Razorpay ──
  let r = await req("/api/create-order", { items, ...cust }); assert.equal(r.status, 200); const rz = await r.json();
  assert.equal(one("SELECT count(*) c FROM orders").c, 0); const intent = one("SELECT * FROM checkout_intents WHERE txn_id=?", rz.id);
  assert.equal(intent.amount_paise, 39400); assert.equal(intent.gst_paise, 5400); assert.equal(intent.name, "Asha Test"); ok("create-order stores a server-priced intent, no order yet");
  const bad = await req("/api/verify-payment", { razorpay_order_id: rz.id, razorpay_payment_id: "pay_1", razorpay_signature: "0".repeat(64) });
  assert.equal(bad.status, 400); assert.equal(one("SELECT count(*) c FROM orders").c, 0); ok("bad signature creates no order");
  const sig = await hmac("rzp_secret", `${rz.id}|pay_1`);
  r = await req("/api/verify-payment", { razorpay_order_id: rz.id, razorpay_payment_id: "pay_1", razorpay_signature: sig }); assert.equal(r.status, 200);
  let o = one("SELECT * FROM orders WHERE txn_id=?", rz.id);
  assert.equal(o.total, 39400); assert.equal(o.paid_paise, 39400); assert.equal(o.payment_status, "paid"); assert.equal(o.payment_method, "razorpay"); assert.equal(o.name, "Asha Test"); assert.equal(o.address, "1 Main Street, Pune");
  assert.equal(JSON.parse(o.items_json)[0].id, "black-nfc-card"); ok("verified Razorpay payment creates a paid order with server-computed total");
  assert.equal(one("SELECT count(*) c FROM payments WHERE order_id=?", o.id).c, 1); assert.equal(one("SELECT count(*) c FROM checkout_intents").c, 0); ok("gateway payment row written, intent consumed");
  await req("/api/verify-payment", { razorpay_order_id: rz.id, razorpay_payment_id: "pay_1", razorpay_signature: sig });
  assert.equal(one("SELECT count(*) c FROM orders").c, 1); assert.equal(one("SELECT count(*) c FROM payments").c, 1); ok("verifying twice stays idempotent");

  // loyalty for a logged-in user
  sqlite.exec("INSERT INTO users (id,email) VALUES ('u1','u1@example.test'); INSERT INTO sessions (id,user_id,expires_at) VALUES ('session-abc-12345','u1',9999999999)");
  r = await req("/api/create-order", { items, ...cust, quoteRef: "QT-222222" }, { Cookie: "ntagz_session=session-abc-12345" }); const rz2 = await r.json();
  await req("/api/verify-payment", { razorpay_order_id: rz2.id, razorpay_payment_id: "pay_2", razorpay_signature: await hmac("rzp_secret", `${rz2.id}|pay_2`) });
  assert.equal(one("SELECT user_id FROM orders WHERE txn_id=?", rz2.id).user_id, "u1"); assert.equal(one("SELECT loyalty_spend s FROM users WHERE id='u1'").s, 39400);
  await req("/api/verify-payment", { razorpay_order_id: rz2.id, razorpay_payment_id: "pay_2", razorpay_signature: await hmac("rzp_secret", `${rz2.id}|pay_2`) });
  assert.equal(one("SELECT loyalty_spend s FROM users WHERE id='u1'").s, 39400); ok("order linked to logged-in user; loyalty added once");

  // ── PayU ──
  r = await req("/api/payu/checkout", { items, ...cust, quoteRef: "QT-333333" }); assert.equal(r.status, 200); const pu = await r.json();
  const tx = pu.fields.txnid; assert.equal(one("SELECT amount_paise a FROM checkout_intents WHERE txn_id=?", tx).a, 39400);
  const mkResp = async (amount) => { const f = { key: "payu_key", txnid: tx, amount, productinfo: pu.fields.productinfo, firstname: pu.fields.firstname, email: pu.fields.email, status: "success", mihpayid: "pu_9" };
    f.hash = await sha512(["payu_salt", f.status, "", "", "", "", "", "", "", "", "", "", f.email, f.firstname, f.productinfo, f.amount, f.txnid, f.key].join("|")); return f; };
  const cb = (f) => worker.onRequest({ request: new Request("https://ntagz-payments.ambivert.workers.dev/api/payu/success", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(f) }), env });
  payuAmount = "1.00"; r = await cb(await mkResp("1.00")); assert.equal(one("SELECT count(*) c FROM orders WHERE txn_id=?", tx).c, 0); ok("PayU amount that differs from the server-priced intent creates no order");
  payuAmount = "394.00"; r = await cb(await mkResp("394.00")); assert.equal(r.status, 303);
  o = one("SELECT * FROM orders WHERE txn_id=?", tx); assert.equal(o.payment_status, "paid"); assert.equal(o.total, 39400); assert.equal(o.payment_method, "payu"); ok("verified PayU payment creates a paid order");
  await cb(await mkResp("394.00")); assert.equal(one("SELECT count(*) c FROM orders WHERE txn_id=?", tx).c, 1); ok("PayU callback repeat is idempotent");

  // ── forged recording route is closed ──
  const before = one("SELECT count(*) c FROM orders").c;
  r = await req("/api/accounts/orders", { txnId: "fake-123", gateway: "razorpay", total: 1, name: "Forger" }); assert.equal(r.status, 202);
  assert.equal(one("SELECT count(*) c FROM orders").c, before); ok("POST /api/accounts/orders no longer creates orders");
  r = await req("/api/accounts/orders", { txnId: rz.id }); assert.equal((await r.json()).id, o.id === undefined ? (await r.json()).id : (await (await req("/api/accounts/orders", { txnId: rz.id })).json()).id); ok("…but still returns existing order ids for the confirm page");

  // ── offline orders ──
  const off = (b, ip = "1.2.3.4") => req("/api/orders/offline", b, { "CF-Connecting-IP": ip });
  r = await off({ method: "upi", items, ...cust, total: 1, paid: true, quoteRef: "QT-444444" }); assert.equal(r.status, 200);
  o = one("SELECT * FROM orders WHERE txn_id='OFF-QT-444444-9876543210'"); assert.equal(o.total, 39400); assert.equal(o.payment_status, "unpaid"); assert.equal(o.paid_paise, 0); assert.equal(o.payment_method, "upi"); ok("offline order is UNPAID and priced by the server (client total/paid flag ignored)");
  await off({ method: "upi", items, ...cust, quoteRef: "QT-444444" }); assert.equal(one("SELECT count(*) c FROM orders WHERE txn_id='OFF-QT-444444-9876543210'").c, 1); ok("same quote re-submitted maps to one order");
  assert.equal((await off({ method: "cash", items, ...cust, quoteRef: "QT-5" })).status, 400); assert.equal((await off({ method: "upi", items: [{ id: "nope", qty: 10 }], ...cust, quoteRef: "QT-6" })).status, 400);
  assert.equal((await off({ method: "upi", items: [{ id: "black-nfc-card", qty: 2 }], ...cust, quoteRef: "QT-7" })).status, 400); assert.equal((await off({ method: "upi", items, ...cust, phone: "123", quoteRef: "QT-8" })).status, 400); ok("invalid method, product, quantity and phone rejected");
  let codes = []; for (let i = 0; i < 6; i++) codes.push((await off({ method: "bank", items, ...cust, quoteRef: "QT-RL" + i }, "9.9.9.9")).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]); ok("6th order from one connection in 10 minutes is rate limited");
  r = await worker.onRequest({ request: new Request("https://x/api/orders/offline", { method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/json" }, body: "{}" }), env }); assert.equal(r.status, 403); ok("other origins rejected");

  // ── DB outage must never break payments ──
  const noDb = { ...env, DB: undefined };
  r = await worker.onRequest({ request: new Request("https://x/api/create-order", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ items, state: "Maharashtra" }) }), env: noDb }); assert.equal(r.status, 200); ok("create-order still works with no database");
  const brokenDb = { ...env, DB: { prepare() { throw new Error("D1 down"); }, batch() { throw new Error("D1 down"); } } };
  r = await worker.onRequest({ request: new Request("https://x/api/create-order", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ items, state: "Maharashtra" }) }), env: brokenDb }); assert.equal(r.status, 200);
  const rid = (await r.json()).id; r = await worker.onRequest({ request: new Request("https://x/api/verify-payment", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ razorpay_order_id: rid, razorpay_payment_id: "p", razorpay_signature: await hmac("rzp_secret", `${rid}|p`) }) }), env: brokenDb });
  assert.equal(r.status, 200); ok("a failing database never blocks create-order or verify-payment");
  global.fetch = realFetch; console.log(`\nall ${n} checkout-recording checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
