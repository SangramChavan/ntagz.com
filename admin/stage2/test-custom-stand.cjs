// New product: Custom Google Review NFC + QR Stand, 10x10 cm, Rs 2,000 including GST.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..", "..");
const payments = require(path.join(root, "functions", "api", "[[path]].js"));
const PRICING = require(path.join(root, "functions", "lib", "pricing.js"));
const { makeDb } = require("./d1shim.cjs");
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const ID = "google-review-nfc-qr-stand-custom-10x10";

global.fetch = async (url, opts) => String(url).includes("api.razorpay.com")
  ? Response.json({ id: "order_T" + Math.random().toString(36).slice(2, 11), amount: JSON.parse(opts.body).amount, currency: "INR" }) : Promise.reject(new Error("unexpected fetch " + url));

(async () => {
  const { sqlite, D1, one } = makeDb();
  const env = { DB: D1, RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s" };
  const P = (p, body) => { payments.resetPricingCache(); return payments.onRequest({ request: new Request("https://x" + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: "https://ntagz.com" }, body: body ? JSON.stringify(body) : undefined }), env }); };
  const quote = async (qty, state = "Maharashtra") => { const r = await P("/api/quote", { items: [{ id: ID, qty }], state }); return { status: r.status, d: await r.json() }; };

  // ── database row (migration 0017) ──
  const row = one("SELECT * FROM products WHERE id=?", ID);
  assert.ok(row); assert.equal(row.name, "Custom Google Review NFC + QR Stand — 10×10 cm"); assert.equal(row.price_paise, 200000);
  assert.equal(row.all_inclusive, 1); assert.equal(row.active, 1); assert.equal(row.built_in, 1); assert.equal(row.unit, "pc"); assert.equal(row.track_stock, 0);
  assert.equal(one("SELECT count(*) c FROM products WHERE lower(sku)='grc2000'").c, 1); ok("the product exists in the admin catalogue at ₹2,000 (all-inclusive), active, not stock-tracked, with a unique SKU");

  // ── priced by the server: ₹2,000 including GST, no GST added on top ──
  let q = await quote(1);
  assert.equal(q.status, 200); assert.equal(q.d.you.amount, 2000); assert.equal(q.d.you.gst, 0); assert.equal(q.d.you.shipping, 0); ok("one stand costs exactly ₹2,000: GST is inside the price, nothing is added, and shipping is free at ₹2,000");
  q = await quote(3); assert.equal(q.d.you.amount, 6000); ok("three stands cost ₹6,000");
  q = await quote(1, "Karnataka"); assert.equal(q.d.you.amount, 2000); ok("the price is the same outside Maharashtra");
  assert.equal((await quote(0)).status, 400); assert.equal((await quote(1.5)).status, 400); ok("zero or fractional quantities are refused");

  // ── minimum order is 1, unlike the default 10 ──
  assert.equal(PRICING.PRODUCTS[ID].moq, 1); const direct = PRICING.priceCart([{ id: ID, qty: 1 }], { products: PRICING.PRODUCTS, live: null, state: "Maharashtra" });
  assert.equal(direct.amount, 2000); ok("it can be bought singly (minimum 1), and the built-in price is also ₹2,000 if the database is unreachable");
  assert.ok(PRICING.priceCart([{ id: "google-review-nfc-stand-12x12", qty: 1 }], { products: PRICING.PRODUCTS, live: null, state: "Maharashtra" }) === null); ok("the other stands still need their minimum of 10");

  // ── an admin price change reaches checkout (the database is the source of truth) ──
  sqlite.prepare("UPDATE products SET price_paise=250000 WHERE id=?").run(ID); assert.equal((await quote(1)).d.you.amount, 2500); sqlite.prepare("UPDATE products SET price_paise=200000 WHERE id=?").run(ID);
  ok("changing the price in admin changes what checkout charges");

  // ── a real Razorpay order carries the server-priced amount ──
  const r = await P("/api/create-order", { items: [{ id: ID, qty: 1 }], state: "Maharashtra", name: "A T", phone: "9876543210", address: "1 Main Street, Pune", pincode: "411001", quoteRef: "QT-STAND1" });
  const d = await r.json(); assert.equal(r.status, 200); assert.equal(d.amount, 200000); ok("payment is created for 200000 paise (₹2,000)");

  // ── the storefront catalogue entry agrees with the server ──
  const sandbox = { window: {}, document: { addEventListener() {}, getElementById() { return null; } }, localStorage: { getItem() { return null; }, setItem() {} } };
  sandbox.window = sandbox; sandbox.self = sandbox; vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "js", "catalog.js"), "utf8"), sandbox);
  const cat = sandbox.NTAGZ_CATALOG && sandbox.NTAGZ_CATALOG.byId ? sandbox.NTAGZ_CATALOG.byId(ID) : null;
  assert.ok(cat, "catalog.js lists the product"); assert.equal(cat.price, 2000); assert.equal(cat.moq, 1); assert.equal(cat.allInclusive, true); assert.equal(cat.name, row.name); assert.equal(cat.sku, row.sku);
  assert.equal(row.image_url, "images/custom-google-review-stand-10x10.png"); assert.equal(cat.image, row.image_url); assert.ok(fs.existsSync(path.join(root, row.image_url)), "image file is in the repo"); assert.ok(fs.statSync(path.join(root, row.image_url)).size < 300000);
  assert.equal(cat.price, PRICING.PRODUCTS[ID].price); ok("js/catalog.js and the server price table agree on name, SKU, price, all-inclusive and minimum quantity");

  console.log(`\n${n} custom-stand checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
