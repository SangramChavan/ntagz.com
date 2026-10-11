// Bulk price change: the real admin Worker and the real payments Worker on one in-memory D1.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const root = path.join(__dirname, "..", "..");
const payments = require(path.join(root, "functions", "api", "[[path]].js"));
const { makeDb } = require("./d1shim.cjs");
const { sqlite, D1, q, one } = makeDb();
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const ORIGIN = "https://admin.ntagz.com";

(async () => {
  const admin = (await import(pathToFileURL(path.join(root, "admin", "src", "index.js")).href)).default;
  const aenv = { DB: D1, ADMIN_EMAILS: "admin@example.test", DEV_OTP_ECHO: "1", ASSETS: { fetch: () => new Response("x") } };
  let cookie = "";
  const A = async (p, body) => {
    const h = { Origin: ORIGIN, "X-Requested-With": "ntagz-admin", "Content-Type": "application/json" }; if (cookie) h.Cookie = cookie;
    const r = await admin.fetch(new Request(ORIGIN + p, { method: body === undefined ? "GET" : "POST", headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), aenv);
    return { status: r.status, d: await r.clone().json().catch(() => ({})), headers: r.headers };
  };
  let r = await A("/api/auth/request", { email: "admin@example.test" });
  r = await A("/api/auth/verify", { email: "admin@example.test", otp: r.d.dev_otp }); cookie = r.headers.get("set-cookie").split(";")[0];

  // payments-Worker helpers (checkout)
  const penv = { DB: D1, RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "rzp_secret" };
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => String(url).includes("api.razorpay.com") ? Response.json({ id: "order_T" + Math.random().toString(36).slice(2, 11), amount: JSON.parse(opts.body).amount, currency: "INR" }) : realFetch(url, opts);
  const hmac = async (secret, msg) => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(msg))), (b) => b.toString(16).padStart(2, "0")).join("");
  const P = (p, body, extra = {}) => { payments.resetPricingCache(); return payments.onRequest({ request: new Request("https://x" + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: "https://www.ntagz.com", ...extra }, body: body ? JSON.stringify(body) : undefined }), env: penv }); };
  const cust = { name: "A T", phone: "9876543210", address: "1 Main Street, Pune", pincode: "411001", state: "Maharashtra", email: "a@example.test" };
  const buy = async (id, qty, pid) => {
    const d = await (await P("/api/create-order", { items: [{ id, qty }], ...cust, quoteRef: "Q" + pid })).json(); assert.ok(d.id, JSON.stringify(d));
    await P("/api/verify-payment", { razorpay_order_id: d.id, razorpay_payment_id: pid, razorpay_signature: await hmac("rzp_secret", `${d.id}|${pid}`) });
    return { rzAmount: d.amount, order: one("SELECT * FROM orders WHERE txn_id=?", d.id) };
  };
  const price = (id) => one("SELECT price_paise FROM products WHERE id=?", id).price_paise;
  const prices = () => Object.fromEntries(q("SELECT id,price_paise FROM products").map((x) => [x.id, x.price_paise]));
  const preview = (b) => A("/api/products/bulk-price/preview", b);
  const apply = (b) => A("/api/products/bulk-price/apply", b);
  const op = () => crypto.randomUUID();

  // known fixtures
  sqlite.exec("UPDATE products SET price_paise=10000,mrp_paise=NULL,cost_paise=NULL WHERE id='black-nfc-card'; UPDATE products SET price_paise=25000,mrp_paise=NULL WHERE id='white-nfc-card'; UPDATE products SET price_paise=49900,mrp_paise=NULL WHERE id='nfc-coin'");
  const anon = await admin.fetch(new Request(ORIGIN + "/api/products/bulk-price/apply", { method: "POST", headers: { Origin: ORIGIN, "X-Requested-With": "ntagz-admin", "Content-Type": "application/json" }, body: "{}" }), aenv);
  assert.equal(anon.status, 401); ok("signed-out users cannot use bulk price endpoints");

  // 1. increase 10% (preview then apply)
  const before = prices();
  let pv = await preview({ direction: "increase", percent: 10, scope: "all" }); assert.equal(pv.status, 200);
  const row = (id, d = pv.d) => d.changes.find((c) => c.id === id);
  assert.deepEqual([row("black-nfc-card").from, row("black-nfc-card").to, row("black-nfc-card").diff], [10000, 11000, 1000]);
  assert.equal(row("white-nfc-card").to, 27500); assert.equal(row("nfc-coin").to, 54890); // ₹499 -> ₹548.90
  assert.deepEqual(prices(), before); assert.equal(one("SELECT count(*) c FROM audit_log WHERE action='bulk_price'").c, 0); ok("preview shows current/new/difference and changes nothing (also covers Cancel)");
  const old = await buy("black-nfc-card", 10, "pay_hist"); const oldOrder = { ...old.order };
  const o1 = op(); let ap = await apply({ direction: "increase", percent: 10, scope: "all", version: pv.d.version, op_id: o1, confirm: true });
  assert.equal(ap.status, 200); assert.equal(ap.d.updated, pv.d.count);
  assert.equal(price("black-nfc-card"), 11000); assert.equal(price("nfc-coin"), 54890); ok("increase all by 10%: ₹100 -> ₹110, ₹499 -> ₹548.90, count matches");
  const au = one("SELECT * FROM audit_log WHERE id=?", o1); assert.equal(au.action, "bulk_price"); assert.equal(au.actor, "admin@example.test");
  const det = JSON.parse(au.detail); assert.equal(det.count, ap.d.updated); assert.ok(det.changes.find((c) => c.id === "nfc-coin" && c.from === 49900 && c.to === 54890)); ok("one audit row with actor, percent and before/after prices");
  // untouched fields
  const bc = one("SELECT * FROM products WHERE id='black-nfc-card'"); assert.equal(bc.name, "Black NFC 215 Card"); assert.equal(bc.stock_qty, 0); assert.equal(bc.active, 1); ok("only the price changed on the product row (name, stock, active kept)");

  const hist = (await A("/api/pricing")).d.history; assert.ok(hist.some((h) => h.action === "bulk_price" && h.detail.count === ap.d.updated)); ok("bulk update appears in Recent price changes");
  // history unchanged, new orders use the new price (10 x ₹100 + 18% GST + ₹40 shipping = ₹1,220; at ₹110 = ₹1,338)
  assert.deepEqual({ ...one("SELECT * FROM orders WHERE id=?", oldOrder.id) }, oldOrder); assert.equal(old.rzAmount, 122000); ok("existing orders keep their recorded amounts");
  const fresh = await buy("black-nfc-card", 10, "pay_new"); assert.equal(fresh.rzAmount, 133800);
  assert.equal(one("SELECT total FROM orders WHERE id=?", oldOrder.id).total, oldOrder.total); ok("new orders are charged the updated price through checkout");

  // decrease 10% (from the new prices)
  pv = await preview({ direction: "decrease", percent: 10, scope: "all" });
  assert.equal(row("black-nfc-card", pv.d).to, 9900); assert.equal(row("nfc-coin", pv.d).to, 49401);
  ap = await apply({ direction: "decrease", percent: 10, scope: "all", version: pv.d.version, op_id: op(), confirm: true });
  assert.equal(ap.status, 200); assert.equal(price("black-nfc-card"), 9900); assert.equal(price("nfc-coin"), 49401); ok("decrease all by 10%: ₹110 -> ₹99, ₹548.90 -> ₹494.01");

  // fractional percent + rounding to the paisa (half up), 3 decimals refused
  sqlite.exec("UPDATE products SET price_paise=3333 WHERE id='black-nfc-card'; UPDATE products SET price_paise=10 WHERE id='nfc-coin'");
  pv = await preview({ direction: "increase", percent: "2.5", scope: "all" });
  assert.equal(row("black-nfc-card", pv.d).to, 3416); // 3333 x 1.025 = 3416.325 -> 3416
  assert.equal((await preview({ direction: "increase", percent: 5, scope: "all" })).d.changes.find((c) => c.id === "nfc-coin").to, 11); // 10.5 paise -> 11 (half up)
  assert.equal((await preview({ direction: "increase", percent: 2.555, scope: "all" })).status, 400); ok("2.5% and half-up rounding to the paisa; 3-decimal percentages refused");

  // zero price, MRP ceiling, no-change rounding, inactive scope
  sqlite.exec("UPDATE products SET price_paise=0 WHERE id='anti-metal-tag'; UPDATE products SET price_paise=25000, mrp_paise=26000 WHERE id='white-nfc-card'; UPDATE products SET price_paise=1 WHERE id='mini-nfc-tag'; UPDATE products SET active=0 WHERE id='micro-flex-fpc'");
  pv = await preview({ direction: "increase", percent: 10, scope: "all" });
  const sk = (id) => pv.d.skipped.find((x) => x.id === id);
  assert.match(sk("anti-metal-tag").reason, /₹0/); assert.match(sk("white-nfc-card").reason, /exceed the MRP/); assert.match(sk("mini-nfc-tag").reason, /rounding/);
  assert.equal(pv.d.count + pv.d.skipped.length, pv.d.total_products); assert.ok(pv.d.changes.find((c) => c.id === "micro-flex-fpc"));
  const act = await preview({ direction: "increase", percent: 10, scope: "active" }); assert.equal(act.d.changes.find((c) => c.id === "micro-flex-fpc"), undefined); assert.equal(act.d.total_products, pv.d.total_products - 1);
  const snap = prices(); ap = await apply({ direction: "increase", percent: 10, scope: "all", version: pv.d.version, op_id: op(), confirm: true });
  assert.equal(ap.d.updated, pv.d.count); assert.equal(price("anti-metal-tag"), 0); assert.equal(price("white-nfc-card"), 25000); assert.equal(price("mini-nfc-tag"), 1); assert.notEqual(price("micro-flex-fpc"), snap["micro-flex-fpc"]); ok("zero-priced, over-MRP and no-change products are skipped with reasons and left untouched; scope=active excludes inactive");

  // member pricing keeps working: % is unchanged and is taken off the NEW price (no compounding)
  const PRICING = require(path.join(root, "functions", "lib", "pricing.js"));
  sqlite.exec("UPDATE products SET price_paise=10000, member_discount_pct=5, cost_paise=NULL WHERE id='black-nfc-card'");
  const memberNet = () => PRICING.priceCart([{ id: "black-nfc-card", qty: 10 }], { products: PRICING.PRODUCTS, live: Object.fromEntries(q("SELECT * FROM products").map((x) => [x.id, x])), state: "", member: true, settings: PRICING.settingsFrom({ discounts_live: "1" }) }).lines[0];
  assert.equal(memberNet().net, 950);
  pv = await preview({ direction: "increase", percent: 10, scope: "all" });
  await apply({ direction: "increase", percent: 10, scope: "all", version: pv.d.version, op_id: op(), confirm: true });
  const ml = memberNet(); assert.equal(ml.memberPct, 5); assert.equal(one("SELECT member_discount_pct m FROM products WHERE id='black-nfc-card'").m, 5); assert.equal(ml.net, 1045); ok("member % unchanged and applied once to the new price (₹950 -> ₹1,045 for 10 pcs)");

  // invalid input and unsafe operations
  const base = { direction: "increase", percent: 10, scope: "all" };
  for (const bad of [{ percent: 0 }, { percent: -5 }, { percent: "abc" }, { percent: null }, { percent: 101 }, { direction: "decrease", percent: 100 }, { direction: "decrease", percent: 150 }, { direction: "sideways" }, { direction: undefined }])
    assert.equal((await preview({ ...base, ...bad })).status, 400, JSON.stringify(bad));
  assert.equal((await preview({ direction: "decrease", percent: 99.99 })).status, 200);
  pv = await preview(base);
  assert.equal((await apply({ ...base, version: pv.d.version, op_id: op() })).status, 400);                          // no confirm
  assert.equal((await apply({ ...base, version: pv.d.version, confirm: true })).status, 400);                       // no op id
  assert.equal((await apply({ ...base, version: "stale", op_id: op(), confirm: true })).status, 409);               // wrong version
  sqlite.exec("UPDATE products SET price_paise=price_paise+100 WHERE id='nfc-wristband'");
  const s0 = prices(); assert.equal((await apply({ ...base, version: pv.d.version, op_id: op(), confirm: true })).status, 409); assert.deepEqual(prices(), s0); ok("invalid percentages, missing confirm/op id and stale previews are rejected without changes");

  // a failed write and a price changing mid-apply both leave everything untouched
  pv = await preview(base); const s1 = prices(), audits = one("SELECT count(*) c FROM audit_log WHERE action='bulk_price'").c;
  const realBatch = D1.batch;
  D1.batch = async () => { throw new Error("D1 unavailable"); };
  ap = await apply({ ...base, version: pv.d.version, op_id: op(), confirm: true }); D1.batch = realBatch;
  assert.equal(ap.status, 409); assert.deepEqual(prices(), s1);
  D1.batch = async (st) => { sqlite.exec("UPDATE products SET price_paise=price_paise+1 WHERE id='nfc-coin'"); return realBatch.call(D1, st); }; // someone edits a price after the version check
  ap = await apply({ ...base, version: pv.d.version, op_id: op(), confirm: true }); D1.batch = realBatch;
  const s2 = prices(); assert.equal(ap.status, 409); assert.equal(s2["nfc-coin"], s1["nfc-coin"] + 1); assert.equal(s2["black-nfc-card"], s1["black-nfc-card"]);
  assert.equal(one("SELECT count(*) c FROM audit_log WHERE action='bulk_price'").c, audits); ok("database failure or a concurrent edit: whole update rolled back, nothing partial, no audit row");

  // repeated clicks: the same operation id can only ever apply once
  pv = await preview(base); const id = op(), before2 = prices();
  const both = await Promise.all([apply({ ...base, version: pv.d.version, op_id: id, confirm: true }), apply({ ...base, version: pv.d.version, op_id: id, confirm: true })]);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
  const once = prices(); for (const c of pv.d.changes) assert.equal(once[c.id], c.to);
  assert.equal((await apply({ ...base, version: pv.d.version, op_id: id, confirm: true })).status, 409);
  assert.equal(one("SELECT count(*) c FROM audit_log WHERE id=?", id).c, 1); assert.notDeepEqual(once, before2); ok("double submit (even concurrent) applies exactly once");

  console.log(`\nall ${n} bulk price checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
