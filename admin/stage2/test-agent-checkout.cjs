// Agent checkout: POST /api/agent/checkout returns a pay link, stores the intent, validates input. Razorpay mocked, in-memory D1.
const assert = require("node:assert/strict");
const path = require("node:path");
const worker = require(path.join(__dirname, "..", "..", "functions", "api", "[[path]].js"));
const { makeDb } = require("./d1shim.cjs");
const { D1, one } = makeDb();
const env = { DB: D1, RAZORPAY_KEY_ID: "rzp_test_abc123", RAZORPAY_KEY_SECRET: "s" };
const realFetch = global.fetch;
global.fetch = async (url, opts) => String(url).includes("api.razorpay.com/v1/orders")
  ? Response.json({ id: "order_TESTagent01", amount: JSON.parse(opts.body).amount, currency: "INR" }) : realFetch(url, opts);
const call = (body, e = env, headers = {}) => worker.onRequest({ request: new Request("https://ntagz.com/api/agent/checkout", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), env: e });
const cust = { name: "Asha Test", phone: "9876543210", address: "1 Main Street, Pune", pincode: "411001", state: "Maharashtra" };

(async () => {
  const r = await call({ ...cust, items: [{ id: "black-nfc-card", qty: 10 }] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.payUrl, "https://ntagz.com/pay.html?o=order_TESTagent01&k=rzp_test_abc123");
  assert.equal(j.amountInr, 394);
  const row = await one("SELECT amount_paise, name FROM checkout_intents WHERE txn_id='order_TESTagent01'");
  assert.equal(row.amount_paise, 39400);
  assert.equal((await call({ ...cust, phone: "123", items: [{ id: "black-nfc-card", qty: 10 }] })).status, 400);
  assert.equal((await call({ ...cust, items: [{ id: "black-nfc-card", qty: 1 }] })).status >= 400, true);
  assert.equal((await call({ ...cust, items: [{ id: "black-nfc-card", qty: 10 }] }, env, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await call({ ...cust, items: [{ id: "black-nfc-card", qty: 10 }] }, { DB: D1 })).status, 503);
  global.fetch = realFetch;
  console.log("agent checkout checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
