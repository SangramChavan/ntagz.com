// PayU webhook (server-to-server safety net for a customer who paid but never came back) and per-IP rate limits on the routes that call a
// payment gateway. In-memory D1 shim; Razorpay and PayU HTTP mocked.
const assert = require("node:assert/strict");
const path = require("node:path");
const worker = require(path.join(__dirname, "..", "..", "functions", "api", "[[path]].js"));
const { makeDb } = require("./d1shim.cjs");
const { sqlite, D1, one } = makeDb();
const env = { DB: D1, RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "rzp_secret", PAYU_KEY: "payu_key", PAYU_SALT: "payu_salt", PAYU_ENV: "test" };
const ORIGIN = "https://www.ntagz.com";
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const sha512 = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-512", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");

let payuVerify = { status: "success", amount: "394.00" }, verifyCalls = 0, rzpCalls = 0;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("api.razorpay.com/v1/orders")) { rzpCalls++; const b = JSON.parse(opts.body); return Response.json({ id: "order_T" + Math.random().toString(36).slice(2, 10), amount: b.amount, currency: "INR" }); }
  if (u.includes("postservice.php")) { verifyCalls++; const id = new URLSearchParams(opts.body).get("var1"); return Response.json({ status: 1, transaction_details: { [id]: { ...payuVerify, txnid: id } } }); }
  throw new Error("unexpected fetch " + u);
};
const post = (p, body, headers = {}) => worker.onRequest({ request: new Request("https://ntagz.com" + p, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers }, body: JSON.stringify(body) }), env });
// PayU's webhook is a server-to-server form POST: no Origin header, no cookies.
const hook = (fields, type = "form") => worker.onRequest({ request: new Request("https://ntagz.com/api/payu/webhook", { method: "POST",
  headers: { "Content-Type": type === "json" ? "application/json" : "application/x-www-form-urlencoded" }, body: type === "json" ? JSON.stringify(fields) : new URLSearchParams(fields) }), env });
const sign = async (f) => ({ ...f, hash: await sha512(["payu_salt", f.status, "", "", "", "", "", "", "", "", "", "", f.email, f.firstname, f.productinfo, f.amount, f.txnid, f.key].join("|")) });
const orders = (tx) => one("SELECT count(*) c FROM orders WHERE txn_id=?", tx).c;

(async () => {
  const cust = { name: "Asha Test", phone: "9876543210", address: "1 Main Street, Pune", pincode: "411001", state: "Maharashtra", quoteRef: "QT-777777", email: "asha@example.test" };
  const items = [{ id: "black-nfc-card", qty: 10 }];

  // ── PayU webhook ──
  const pu = await (await post("/api/payu/checkout", { items, ...cust })).json();
  const tx = pu.fields.txnid;
  const base = { key: "payu_key", txnid: tx, amount: pu.fields.amount, productinfo: pu.fields.productinfo, firstname: pu.fields.firstname, email: pu.fields.email, status: "success", mihpayid: "pu_w1" };
  assert.equal(orders(tx), 0); ok("PayU checkout alone creates no order (only a priced intent)");

  let r = await hook({ ...base, hash: "0".repeat(128) });
  assert.equal(r.status, 400); assert.equal(orders(tx), 0); ok("webhook with a forged hash is rejected and records nothing");
  r = await hook(await sign({ ...base, key: "someone_else" }));
  assert.equal(r.status, 400); assert.equal(orders(tx), 0); ok("webhook signed for another merchant key is rejected");
  r = await hook(await sign({ ...base, status: "failure" }));
  assert.equal(r.status, 200); assert.equal((await r.json()).ignored, true); assert.equal(orders(tx), 0); ok("failed payment is acknowledged (no PayU retries) and records nothing");

  payuVerify = { status: "failure", amount: base.amount };
  r = await hook(await sign(base));
  assert.equal(r.status, 200); assert.equal(orders(tx), 0);
  assert.ok(one("SELECT count(*) c FROM payment_alerts WHERE txn_id=?", tx).c >= 1); ok("signed 'success' that PayU's verify API does not confirm: no order, flagged for the admin");

  payuVerify = { status: "success", amount: base.amount };
  const v0 = verifyCalls;
  r = await hook(await sign(base));
  assert.equal(r.status, 200); assert.equal(verifyCalls, v0 + 1);
  const o = one("SELECT * FROM orders WHERE txn_id=?", tx);
  assert.equal(o.payment_status, "paid"); assert.equal(o.payment_method, "payu"); assert.equal(o.total, Math.round(parseFloat(base.amount) * 100));
  ok("customer never returned: the webhook alone records the paid order (re-confirmed with PayU first)");

  r = await hook(await sign(base)); assert.equal(r.status, 200); assert.equal(orders(tx), 1); ok("repeated webhook delivery creates no duplicate");
  const back = await worker.onRequest({ request: new Request("https://ntagz.com/api/payu/success", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://secure.payu.in" }, body: new URLSearchParams(await sign(base)) }), env });
  assert.equal(back.status, 303); assert.match(back.headers.get("location"), /status=success/); assert.equal(orders(tx), 1); ok("customer returning after the webhook still sees success, and still one order");

  const pu2 = await (await post("/api/payu/checkout", { items, ...cust, quoteRef: "QT-777778" })).json();
  const b2 = { ...base, txnid: pu2.fields.txnid, productinfo: pu2.fields.productinfo, mihpayid: "pu_w2" };
  r = await hook(await sign(b2), "json"); assert.equal(r.status, 200); assert.equal(orders(b2.txnid), 1); ok("JSON-encoded webhook bodies are accepted too");

  r = await hook(await sign({ ...base, txnid: "ntagzunknown123", mihpayid: "pu_x" }));
  assert.equal(r.status, 500); assert.equal(orders("ntagzunknown123"), 0); assert.equal(one("SELECT count(*) c FROM payment_alerts WHERE txn_id='ntagzunknown123'").c, 1);
  ok("verified payment with no matching checkout: not recorded, alert raised, error returned so PayU retries");
  assert.equal((await worker.onRequest({ request: new Request("https://ntagz.com/api/payu/webhook"), env })).status, 405); ok("webhook accepts POST only");
  assert.equal((await worker.onRequest({ request: new Request("https://ntagz.com/api/payu/webhook", { method: "POST", body: "a=1" }), env: { DB: D1 } })).status, 503); ok("webhook refuses to run without PayU credentials");

  // ── Rate limits ──
  const ipA = { "CF-Connecting-IP": "203.0.113.7" }, ipB = { "CF-Connecting-IP": "198.51.100.9" };
  let codes = [];
  for (let i = 0; i < 21; i++) codes.push((await post("/api/create-order", { items, ...cust }, ipA)).status);
  assert.deepEqual(codes.slice(0, 20), Array(20).fill(200)); assert.equal(codes[20], 429); ok("Razorpay checkout: 20 per 10 minutes per IP, then 429");
  const before = rzpCalls;
  assert.equal((await post("/api/create-order", { items, ...cust }, ipA)).status, 429); assert.equal(rzpCalls, before); ok("a limited request never reaches Razorpay");
  assert.equal((await post("/api/payu/checkout", { items, ...cust }, ipA)).status, 429); ok("PayU checkout shares the same checkout budget");
  assert.equal((await post("/api/create-order", { items, ...cust }, ipB)).status, 200); ok("other customers are unaffected");
  const stored = sqlite.prepare("SELECT ip_hash FROM order_attempts").all().map((x) => x.ip_hash);
  assert.ok(!stored.some((h) => h.includes("203.0.113.7"))); ok("IP addresses are stored only as hashes");
  sqlite.prepare("UPDATE order_attempts SET created_at = created_at - 601").run();
  assert.equal((await post("/api/create-order", { items, ...cust }, ipA)).status, 200); ok("limit lifts after the 10-minute window");
  assert.equal((await post("/api/create-order", { items, ...cust })).status, 200); ok("requests without CF-Connecting-IP (local/tests only) are not limited");

  codes = [];
  for (let i = 0; i < 121; i++) codes.push((await post("/api/quote", { items, state: "Maharashtra" }, { "CF-Connecting-IP": "192.0.2.44" })).status);
  assert.equal(codes.filter((c) => c === 200).length, 120); assert.equal(codes[120], 429); ok("quote: 120 per minute per IP, then 429");

  // membership checkout: 10 per 10 minutes per IP (needs a signed-in user)
  sqlite.exec(`INSERT INTO users (id,email) VALUES ('u-rl','rl@example.test');
               INSERT INTO sessions (id,user_id,expires_at) VALUES ('sess-ratelimit-00000001','u-rl',unixepoch()+3600);
               UPDATE membership_config SET value='1' WHERE key='discounts_live';`);
  const mh = { Cookie: "ntagz_session=sess-ratelimit-00000001", "CF-Connecting-IP": "192.0.2.99" };
  codes = [];
  for (let i = 0; i < 11; i++) codes.push((await post("/api/membership/create-order", {}, mh)).status);
  assert.ok(codes.slice(0, 10).every((c) => c !== 429)); assert.equal(codes[10], 429); ok("membership checkout: 10 per 10 minutes per IP, then 429");

  console.log(`\nall ${n} payu-webhook/rate-limit checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
