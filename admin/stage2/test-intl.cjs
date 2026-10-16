// International customers: USD price list, country-aware checkout, shipping quotations, staged payment, webhook, dispatch rule, emails.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const root = path.join(__dirname, "..", "..");
const payments = require(path.join(root, "functions", "api", "[[path]].js"));
const INTLAPI = require(path.join(root, "functions", "lib", "intl-api.js"));
const { makeDb } = require("./d1shim.cjs");
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const ADMIN = "https://admin.ntagz.com", SECRET = "whsec_test_secret";

(async () => {
  const admin = (await import(pathToFileURL(path.join(root, "admin", "src", "index.js")).href)).default;
  const db = makeDb(), { sqlite, D1, q, one } = db;
  const penv = { DB: D1, RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "rzp_secret", RAZORPAY_WEBHOOK_SECRET: SECRET, DEV_NOTIFY_ECHO: "1" };
  const aenv = { DB: D1, ADMIN_EMAILS: "admin@example.test", DEV_OTP_ECHO: "1", DEV_NOTIFY_ECHO: "1", ASSETS: { fetch: () => new Response("x") } };
  let cookie = ""; let ipn = 0;
  const reset = () => { payments.resetPricingCache(); };
  const P = (p, body, extra = {}) => { reset(); return payments.onRequest({ request: new Request("https://x" + p, { method: body === undefined ? "GET" : "POST", headers: { Origin: "https://www.ntagz.com", "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113." + (extra.ip || 7), ...(extra.headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env: penv }); };
  const Pj = async (p, body, extra) => { const r = await P(p, body, extra); return { status: r.status, d: await r.clone().json().catch(() => ({})), headers: r.headers }; };
  const A = async (p, body, anon) => {
    const h = { Origin: ADMIN, "X-Requested-With": "ntagz-admin", "Content-Type": "application/json" }; if (cookie && !anon) h.Cookie = cookie;
    const r = await admin.fetch(new Request(ADMIN + p, { method: body === undefined ? "GET" : "POST", headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), aenv);
    return { status: r.status, d: await r.clone().json().catch(() => ({})), headers: r };
  };
  let r0 = await A("/api/auth/request", { email: "admin@example.test" }); r0 = await A("/api/auth/verify", { email: "admin@example.test", otp: r0.d.dev_otp }); cookie = r0.headers.headers.get("set-cookie").split(";")[0];
  const key = () => crypto.randomUUID();
  sqlite.exec("UPDATE products SET track_stock=0");

  // ── off by default; domestic untouched ──
  let cfg = (await Pj("/api/intl/config")).d; assert.equal(cfg.enabled, false);
  assert.equal((await Pj("/api/intl/orders", { country: "US" })).status, 404); ok("international ordering is OFF by default (config disabled, order endpoint refuses)");
  const dom = (await Pj("/api/catalog")).d; assert.equal(dom.find((x) => x.id === "black-nfc-card").price, 30); ok("domestic INR catalogue is unchanged");

  // ── admin configures USD prices, quantity breaks, settings ──
  assert.equal((await A("/api/products/black-nfc-card", { intl_enabled: true })).status, 400); // no USD price yet
  let pr = await A("/api/products/black-nfc-card", { price_usd: "1.20", intl_enabled: true, intl_moq: 10, intl_lead_days: 12, weight_g: 6, dims_mm: "86x54x0.8", intl_tax_treatment: "excl", intl_tiers: [{ min_qty: 100, unit_usd: "1.00" }, { min_qty: 500, unit_usd: "0.85" }] });
  assert.equal(pr.status, 200); assert.equal(pr.d.intl.price_usd_cents, 120); assert.equal(pr.d.intl.tiers.length, 2);
  assert.equal((await A("/api/products/black-nfc-card", { intl_tiers: [{ min_qty: 100, unit_usd: "1.00" }, { min_qty: 500, unit_usd: "1.10" }] })).status, 400); // bigger quantity must not cost more
  assert.equal((await A("/api/products/black-nfc-card", { price_usd: "1.234" })).status, 400);
  await A("/api/products/white-nfc-card", { price_usd: "1.50", intl_enabled: true, intl_moq: 10 });
  await A("/api/products/anti-metal-tag", { price_usd: "2.00", intl_enabled: true, intl_custom_quote: true });
  sqlite.exec("UPDATE products SET track_stock=1, stock_qty=1000 WHERE id='white-nfc-card'");
  assert.equal(dom.find((x) => x.id === "black-nfc-card").price, 30); assert.equal(one("SELECT price_paise p FROM products WHERE id='black-nfc-card'").p, 3000);
  let st = (await A("/api/intl/settings")).d;
  assert.equal((await A("/api/intl/settings", { version: "stale", settings: { enabled: true } })).status, 409);
  assert.equal((await A("/api/intl/settings", { version: st.version, settings: { paylink_hosts: "not a host!" } })).status, 400);
  assert.equal((await A("/api/intl/settings", { version: st.version, settings: { enabled: true, payment_mode: "manual_link", quote_valid_days: 5 } })).status, 200);
  assert.equal((await A("/api/intl/settings", undefined, true)).status, 401); assert.ok(one("SELECT 1 x FROM audit_log WHERE action='intl_settings'"));
  ok("admin sets USD prices, MOQ, lead time, tax treatment and quantity breaks (validated); settings versioned + audited; INR price untouched");

  cfg = (await Pj("/api/intl/config")).d; assert.equal(cfg.enabled, true); assert.ok(cfg.countries.find((c) => c.code === "US" && c.regionRequired && c.postalLabel === "ZIP code")); assert.ok(!cfg.countries.find((c) => c.code === "IN"));
  const cat = (await Pj("/api/intl/catalog")).d; const bn = cat.products.find((p) => p.id === "black-nfc-card");
  assert.equal(bn.priceCents, 120); assert.deepEqual(bn.tiers, [{ minQty: 100, unitCents: 100 }, { minQty: 500, unitCents: 85 }]); assert.equal(bn.moq, 10); assert.equal(bn.leadDays, 12); assert.ok(!cat.products.find((p) => p.id === "sample-kit")); ok("public config lists destinations with their own address rules; catalogue only has internationally sold products");

  // ── server-side pricing ──
  const price = (items, extra) => Pj("/api/intl/price", { items, ...extra });
  let pc = await price([{ id: "black-nfc-card", qty: 100 }]); assert.equal(pc.d.subtotalCents, 10000); assert.equal(pc.d.savingsCents, 2000); assert.equal(pc.d.shipping, "quotation_required"); assert.equal(pc.d.currency, "USD");
  pc = await price([{ id: "black-nfc-card", qty: 10 }, { id: "white-nfc-card", qty: 20 }], { price: 1, total: 1, unitCents: 1 }); assert.equal(pc.d.subtotalCents, 10 * 120 + 20 * 150); assert.equal(pc.d.leadDays, 12);
  assert.equal((await price([{ id: "black-nfc-card", qty: 9 }])).status, 400); assert.match((await price([{ id: "black-nfc-card", qty: 9 }])).d.error, /minimum/);
  assert.equal((await price([{ id: "sample-kit", qty: 1 }])).status, 400); const cq = await price([{ id: "anti-metal-tag", qty: 10 }]); assert.equal(cq.d.custom, true);
  assert.equal((await price([{ id: "black-nfc-card", qty: -1 }])).status, 400); assert.equal((await price([])).status, 400); assert.equal((await price([{ id: "black-nfc-card", qty: 10 }, { id: "black-nfc-card", qty: 10 }])).status, 400);
  ok("USD pricing is server-side: quantity breaks, MOQ, custom-quote products refused, unknown/invalid carts refused, browser-sent prices ignored");

  // ── order submission ──
  const body = (over = {}) => ({ submission_id: key(), items: [{ id: "black-nfc-card", qty: 100 }, { id: "white-nfc-card", qty: 20 }], country: "US", name: "Jo Doe", company: "Doe LLC", email: "jo@example.com", address1: "1 Main St", address2: "Suite 4", city: "Austin", region: "TX", postal: "78701", phone: "+1 512 555 0100", tax_id: "EIN 12-3456789", notes: "Print our logo", accept_terms: true, ...over });
  const place = (b, extra) => Pj("/api/intl/orders", b, extra);
  let v1 = (await place(body({ postal: "ABCDE" }))).d; assert.ok(v1.fields && v1.fields.postal); assert.equal((await place(body({ region: "" }))).d.fields.region.length > 0, true);
  assert.ok((await place(body({ phone: "5125550100" }))).d.fields.phone); assert.ok((await place(body({ accept_terms: false }))).d.fields.accept_terms); assert.ok((await place(body({ email: "nope" }))).d.fields.email);
  assert.equal((await place(body({ country: "IN" }))).status, 400); assert.equal((await place(body({ country: "XX" }))).status, 400);
  assert.equal(one("SELECT count(*) c FROM orders WHERE market='INTL'").c, 0); ok("country-aware validation: ZIP format, required state, international phone with + code, terms acknowledgement, email; India and unknown countries refused");
  assert.equal((await place(body({ country: "AE", region: "Dubai", postal: "", city: "Dubai" }))).status, 200); // AE has no postal requirement
  assert.equal((await place(body({ country: "GB", region: "", postal: "SW1A 1AA", city: "London", phone: "+44 20 7946 0958" }))).status, 200); ok("other countries follow their own rules (UAE: no postcode; UK: optional county, UK postcode)");
  sqlite.exec("DELETE FROM order_stock_lines; DELETE FROM order_events; DELETE FROM notifications; DELETE FROM audit_log WHERE order_id IS NOT NULL; DELETE FROM orders WHERE market='INTL'; DELETE FROM order_attempts");
  sqlite.exec("UPDATE products SET stock_qty=1000 WHERE id='white-nfc-card'");

  const sub = key(), o1 = await place(body({ submission_id: sub }), { ip: 21 });
  assert.equal(o1.status, 200); assert.match(o1.d.orderNumber, /^INT-[A-Z0-9]+-[A-F0-9]{4}$/); assert.match(o1.d.viewUrl, /order\/international\.html\?o=[0-9a-f-]{36}&t=[0-9a-f]{32}$/);
  const ord = one("SELECT * FROM orders WHERE txn_id=?", o1.d.orderNumber);
  assert.deepEqual([ord.market, ord.currency, ord.country, ord.payment_status, ord.quote_status, ord.destination_status, ord.status, ord.price_list], ["INTL", "USD", "US", "unpaid", "required", "pending", "placed", "INTL-USD"]);
  assert.equal(ord.subtotal, 10000 + 3000); assert.equal(ord.total, 13000); assert.equal(ord.paid_paise, 0); assert.equal(ord.gst, 0); assert.equal(ord.phone, "+15125550100"); assert.equal(ord.terms_version.length > 3, true); assert.ok(ord.terms_accepted_at);
  assert.equal(one("SELECT stock_qty s FROM products WHERE id='white-nfc-card'").s, 980); assert.equal(JSON.parse(ord.items_json)[0].unit_cents, 100);
  assert.equal(one("SELECT status FROM notifications WHERE order_id=? AND event='intl_order_received'", ord.id).status, "sent"); ok("order stored with currency, country, price list, terms acknowledgement; unpaid + shipping quotation required; stock reserved; confirmation email recorded");
  const again = await place(body({ submission_id: sub }), { ip: 21 }); assert.equal(again.d.repeat, true); assert.equal(again.d.orderNumber, o1.d.orderNumber); assert.equal(one("SELECT count(*) c FROM orders WHERE market='INTL'").c, 1); ok("a repeated submit returns the same order, never a second one");
  const hp = await place(body({ website: "http://spam.example" }), { ip: 22 }); assert.equal(hp.status, 200); assert.equal(one("SELECT count(*) c FROM orders WHERE market='INTL'").c, 1); ok("honeypot field: bots get a quiet success and nothing is stored");
  const dtoken = o1.d.viewUrl.match(/t=([0-9a-f]{32})/)[1], oid = ord.id;

  // ── customer order page (secret link) ──
  const view = async (id = oid, t = dtoken) => Pj(`/api/intl/order?o=${id}&t=${t}`);
  let cv = await view(); assert.equal(cv.status, 200); assert.equal(cv.d.orderNumber, o1.d.orderNumber); assert.equal(cv.d.currency, "USD"); assert.equal(cv.d.productsMinor, 13000); assert.equal(cv.d.quoteStatus, "required"); assert.match(cv.d.priceNote, /Shipping is quoted separately/);
  assert.equal(cv.d.payment.canPay, false); assert.equal(cv.d.payment.link, null); assert.match(cv.d.payment.message, /only after you accept/); assert.equal(cv.headers.get("Cache-Control"), "no-store");
  assert.ok(!JSON.stringify(cv.d).includes("track_token") && !JSON.stringify(cv.d).includes("admin@") && !JSON.stringify(cv.d).includes(oid + "\""));
  assert.equal((await view(oid, "0".repeat(32))).status, 404); assert.equal((await view("11111111-1111-1111-1111-111111111111", dtoken)).status, 404);
  const domOrder = one("SELECT id, track_token t FROM orders WHERE market='IN' LIMIT 1"); if (domOrder) assert.equal((await view(domOrder.id, domOrder.t)).status, 404); ok("customer page: needs the secret link; wrong token = unknown order; domestic orders are not reachable here; no payment possible before acceptance");

  // ── admin: list/filter/detail, destination ──
  let ol = (await A("/api/orders?market=INTL")).d; assert.equal(ol.total, 1); assert.equal(ol.orders[0].currency, "USD"); assert.equal(ol.orders[0].country, "US");
  assert.equal((await A("/api/orders?country=us&quote_status=required")).d.total, 1); assert.equal((await A("/api/orders?country=GB")).d.total, 0); assert.equal((await A("/api/orders?market=IN")).d.orders.every((x) => x.market === "IN"), true); assert.equal((await A("/api/orders?dispatch=dispatched")).d.total, 0);
  const csv = await (await admin.fetch(new Request(ADMIN + "/api/orders.csv?market=INTL", { headers: { Cookie: cookie } }), aenv)).text(); assert.match(csv.split("\n")[0], /currency,market,country$/); assert.ok(csv.trim().endsWith("USD,INTL,US")); // (the address contains a line break, so check the end of the whole export) ok("admin filters by market, country, quotation status and dispatch; CSV states the currency");
  let det = (await A(`/api/orders/${oid}`)).d; assert.equal(det.market, "INTL"); assert.equal(det.intl.quotes.length, 0); assert.match(det.track_url, /order\/international\.html/);
  assert.equal((await A(`/api/orders/${oid}/intl/destination`, { decision: "reject", note: "x" })).status, 400);
  assert.equal((await A(`/api/orders/${oid}/intl/quote`, { shipping: "10", taxes: "", other: "", method: "DHL", confirm: true, idempotency_key: key() })).status, 200); // blank tax/other (as the admin form sends) = 0; a quote also approves the destination
  det = (await A(`/api/orders/${oid}`)).d; assert.equal(det.destination_status, "approved"); ok("destination review with reason on rejection; sending a quote approves the destination");
  await A(`/api/orders/${oid}/intl/destination`, { decision: "reject", note: "We cannot ship this item there" }); assert.equal((await A(`/api/orders/${oid}/intl/quote`, { shipping: "10", method: "DHL", confirm: true, idempotency_key: key() })).status, 409);
  cv = await view(); assert.match(JSON.stringify(cv.d.timeline), /unable to ship/); assert.equal((await Pj("/api/intl/order/quote", { o: oid, t: dtoken, quote_id: det.intl.quotes[0].id, decision: "accept" })).status, 409);
  await A(`/api/orders/${oid}/intl/destination`, { decision: "approve" }); ok("a rejected destination blocks quoting and acceptance, and the customer is told on the timeline");

  // ── quotation ──
  const quote = (b) => A(`/api/orders/${oid}/intl/quote`, { confirm: true, idempotency_key: key(), carrier: "DHL", method: "Express Worldwide", ...b });
  assert.equal((await quote({ shipping: "" })).status, 400); assert.equal((await quote({ shipping: "0" })).status, 400); assert.equal((await quote({ shipping: "-5" })).status, 400); assert.equal((await quote({ shipping: "12.345" })).status, 400);
  assert.equal((await quote({ shipping: "40", expires: "2020-01-01" })).status, 400); assert.equal((await quote({ shipping: "40", est_from: "2026-12-10", est_to: "2026-12-01" })).status, 400);
  assert.equal((await A(`/api/orders/${oid}/intl/quote`, { shipping: "40", carrier: "DHL", idempotency_key: key() })).status, 400); // not confirmed
  const exp = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  let qr = await quote({ shipping: "45.50", taxes: "0", other: "0", est_from: "2026-12-01", est_to: "2026-12-08", expires: exp, charges_note: "Destination customs duties and import taxes are not included.", note: "internal: DHL rate card Q4" });
  assert.equal(qr.status, 200); let q1 = qr.d.intl.quotes[0]; assert.equal(q1.total_minor, 13000 + 4550); assert.equal(q1.quote_type, "product_shipping"); assert.equal(q1.status, "sent"); assert.equal(qr.d.quote_status, "sent"); assert.equal(qr.d.total, 13000);
  assert.equal(one("SELECT status FROM notifications WHERE order_id=? AND event='intl_quote_sent'", oid).status, "sent"); assert.ok(one("SELECT 1 x FROM audit_log WHERE action='intl_quote_sent' AND order_id=?", oid)); ok("quotation validated (shipping, expiry, dates, confirmation); sent with a type label, audited, emailed; the order total stays product-only until accepted");
  cv = await view(); assert.equal(cv.d.quote.status, "sent"); assert.equal(cv.d.quote.totalMinor, 17550); assert.equal(cv.d.quote.typeLabel, "Products plus shipping"); assert.ok(!JSON.stringify(cv.d).includes("DHL rate card")); assert.equal(cv.d.payment.canPay, false); assert.equal(cv.d.totalMinor, 13000);
  const q2r = await quote({ shipping: "52", taxes: "6.50", est_from: "2026-12-02", est_to: "2026-12-09", expires: exp }); const q2 = q2r.d.intl.quotes[0]; assert.equal(q2.version, q1.version + 1); assert.equal(q2.quote_type, "product_shipping_taxes"); assert.equal(q2r.d.intl.quotes[1].status, "superseded");
  assert.equal((await Pj("/api/intl/order/quote", { o: oid, t: dtoken, quote_id: q1.id, decision: "accept" })).status, 409); ok("a newer quotation supersedes the old one; the old one cannot be accepted; product/shipping/taxes types are labelled");

  // ── customer decision ──
  const decide = (id, d, t = dtoken) => Pj("/api/intl/order/quote", { o: oid, t, quote_id: id, decision: d });
  assert.equal((await decide(q2.id, "accept", "f".repeat(32))).status, 404); assert.equal((await decide(q2.id, "maybe")).status, 400);
  let acc = await decide(q2.id, "accept"); assert.equal(acc.status, 200); assert.equal(acc.d.quoteStatus, "accepted"); assert.equal(acc.d.totalMinor, 13000 + 5200 + 650); assert.equal(acc.d.outstandingMinor, 18850);
  const ordA = one("SELECT total,shipping_paise,gst,paid_paise,payment_status FROM orders WHERE id=?", oid); assert.deepEqual([ordA.total, ordA.shipping_paise, ordA.gst, ordA.paid_paise, ordA.payment_status], [18850, 5200, 650, 0, "unpaid"]);
  await decide(q2.id, "accept"); assert.equal(one("SELECT count(*) c FROM order_events WHERE order_id=? AND status='quote_accepted'", oid).c, 1); assert.equal(one("SELECT count(*) c FROM notifications WHERE order_id=? AND event='intl_quote_accepted'", oid).c, 1);
  assert.equal((await decide(q2.id, "decline")).status, 409); assert.equal(one("SELECT quote_status s FROM orders WHERE id=?", oid).s, "accepted"); ok("customer accepts explicitly: total becomes the quoted amount, nothing is paid; a repeat does not duplicate events or emails; a conflicting answer is refused");
  cv = await view(); assert.equal(cv.d.payment.canPay, true); assert.match(cv.d.payment.message, /email you a secure payment link/); assert.equal(cv.d.payment.link, null); ok("after acceptance the customer is told payment is needed, with no link yet");

  // decline + expiry + admin-recorded decision on a second order
  const o2 = (await place(body({ submission_id: key(), items: [{ id: "white-nfc-card", qty: 10 }] }), { ip: 23 })).d, id2 = one("SELECT id FROM orders WHERE txn_id=?", o2.orderNumber).id, t2 = o2.viewUrl.match(/t=([0-9a-f]{32})/)[1];
  let qq = (await A(`/api/orders/${id2}/intl/quote`, { shipping: "30", carrier: "FedEx", confirm: true, idempotency_key: key(), expires: exp })).d.intl.quotes[0];
  let dec = await Pj("/api/intl/order/quote", { o: id2, t: t2, quote_id: qq.id, decision: "decline", note: "too expensive" }); assert.equal(dec.d.quoteStatus, "declined"); assert.equal(one("SELECT total FROM orders WHERE id=?", id2).total, 1500); assert.equal(one("SELECT status FROM notifications WHERE order_id=? AND event='intl_quote_declined'", id2).status, "sent"); ok("declining records it and leaves the order at product-only; the team is not told it was accepted");
  qq = (await A(`/api/orders/${id2}/intl/quote`, { shipping: "35", carrier: "FedEx", confirm: true, idempotency_key: key(), expires: exp })).d.intl.quotes[0];
  sqlite.prepare("UPDATE intl_quotes SET expires_at=? WHERE id=?").run(Math.floor(Date.now() / 1000) - 10, qq.id);
  dec = await Pj("/api/intl/order/quote", { o: id2, t: t2, quote_id: qq.id, decision: "accept" }); assert.equal(dec.status, 409); assert.match(dec.d.error, /expired/); assert.equal(one("SELECT quote_status s FROM orders WHERE id=?", id2).s, "expired"); assert.equal(one("SELECT total FROM orders WHERE id=?", id2).total, 1500); ok("an expired quotation cannot be accepted (order shows expired, total unchanged)");
  qq = (await A(`/api/orders/${id2}/intl/quote`, { shipping: "33", carrier: "FedEx", confirm: true, idempotency_key: key(), expires: exp })).d.intl.quotes[0];
  assert.equal((await A(`/api/orders/${id2}/intl/quote/${qq.id}/decision`, { decision: "accepted", reason: "ok", confirm: true })).status, 400);
  const rec = await A(`/api/orders/${id2}/intl/quote/${qq.id}/decision`, { decision: "accepted", reason: "Customer emailed acceptance on 16 Oct", confirm: true, idempotency_key: key() }); assert.equal(rec.status, 200); assert.equal(rec.d.quote_status, "accepted"); assert.equal(rec.d.total, 1500 + 3300);
  assert.equal(rec.d.intl.quotes[0].decided_by, "admin@example.test"); assert.equal((await A(`/api/orders/${id2}/intl/quote/${qq.id}/decision`, { decision: "declined", reason: "Changed their mind", confirm: true })).status, 409); ok("staff can record a customer's offline acceptance only with a reason and confirmation; it is attributed to the admin and cannot be reversed here");

  // ── payment: link and manual verification ──
  assert.equal((await A(`/api/orders/${o2 && id2}/intl/payment-link`, { url: "https://rzp.io/l/abc", confirm: true })).status, 200);
  const link = (b) => A(`/api/orders/${oid}/intl/payment-link`, { confirm: true, idempotency_key: key(), ...b });
  assert.equal((await link({ url: "http://rzp.io/l/x" })).status, 400); assert.equal((await link({ url: "https://evil.example/pay" })).status, 400); assert.equal((await link({ url: "https://rzp.io.evil.example/x" })).status, 400); assert.equal((await link({ url: "https://rzp.io/l/x", amount: "999" })).status, 400);
  const lk = await link({ url: "https://rzp.io/l/abc123", amount: "50" }); assert.equal(lk.status, 200); assert.equal(lk.d.pay_link_url, "https://rzp.io/l/abc123");
  cv = await view(); assert.equal(cv.d.payment.link, "https://rzp.io/l/abc123"); assert.equal(cv.d.payment.linkAmountMinor, 5000); assert.equal(one("SELECT count(*) c FROM notifications WHERE order_id=? AND event='intl_payment_pending'", oid).c >= 1, true); ok("payment link: https + allow-listed provider only, ≤ outstanding, shown to the customer only after acceptance");
  const pay = (b) => A(`/api/orders/${oid}/intl/payment-received`, { confirm: true, idempotency_key: key(), method: "bank_transfer", ...b });
  assert.equal((await pay({ amount: "100", reference: "" })).status, 400); assert.equal((await pay({ amount: "9999", reference: "SWIFT-1" })).status, 400); assert.equal((await pay({ amount: "100", reference: "SWIFT-1", confirm: false })).status, 400); assert.equal((await pay({ amount: "100", reference: "SWIFT-1", method: "magic" })).status, 400);
  assert.equal(one("SELECT payment_status s FROM orders WHERE id=?", oid).s, "unpaid"); assert.equal(one("SELECT count(*) c FROM payments WHERE order_id=?", oid).c, 0);
  const k1 = key(); let p1 = await pay({ amount: "100", reference: "SWIFT-1001", idempotency_key: k1 }); assert.equal(p1.status, 200); assert.equal(p1.d.payment_status, "unpaid"); assert.equal(p1.d.paid_paise, 10000); assert.equal(p1.d.outstanding_paise, 8850); assert.equal(p1.d.payments[0].currency, "USD");
  assert.equal((await pay({ amount: "10", reference: "SWIFT-1001" })).status, 409); // same reference twice
  assert.equal((await pay({ amount: "10", reference: "SWIFT-9999", idempotency_key: k1 })).status, 409);
  assert.equal(one("SELECT count(*) c FROM payments WHERE order_id=?", oid).c, 1); ok("manual payment needs a reference, confirmation and a valid method; partial payments leave the order unpaid; the same reference or key cannot be recorded twice");

  // ── dispatch guard ──
  const ship = (b) => A(`/api/orders/${oid}/ship`, { courier: "DHL", awb: "JD014600003", shipped_on: "2026-11-02", idempotency_key: key(), ...b });
  let sh = await ship({}); assert.equal(sh.status, 409); assert.match(sh.d.error, /ships only after/); assert.equal((await ship({ override_reason: "short" })).status, 409);
  let p2 = await pay({ amount: "88.50", reference: "SWIFT-1002" }); assert.equal(p2.d.payment_status, "paid"); assert.equal(p2.d.outstanding_paise, 0); assert.equal(one("SELECT count(*) c FROM notifications WHERE order_id=? AND event='payment_confirmed'", oid).c, 2);
  assert.equal((await pay({ amount: "1", reference: "SWIFT-1003" })).status, 409); // nothing outstanding
  assert.equal((await A(`/api/orders/${oid}/status`, { to: "confirmed" })).status, 200); assert.equal((await A(`/api/orders/${oid}/status`, { to: "processing" })).status, 200);
  assert.equal(one("SELECT status FROM notifications WHERE order_id=? AND event='intl_processing'", oid).status, "sent");
  sh = await ship({ tracking_url: "https://www.dhl.com/track?id=JD014600003" }); assert.equal(sh.status, 200); assert.equal(sh.d.status, "shipped"); assert.equal(one("SELECT status FROM notifications WHERE order_id=? AND event='shipped'", oid).status, "sent");
  cv = await view(); assert.equal(cv.d.shipments[0].awb, "JD014600003"); assert.equal(cv.d.paymentStatus, "paid"); assert.ok(cv.d.timeline.some((t) => /Payment received/.test(t.label))); ok("dispatch is refused until the accepted quotation is fully paid; after payment it ships, emails the customer, and tracking appears on the customer's timeline");
  const sh2id = sh.d.shipments[0].id; const upd = await A(`/api/orders/${oid}/shipments/${sh2id}`, { awb: "JD014600004", idempotency_key: key() }); assert.equal(upd.status, 200); assert.equal(one("SELECT status FROM notifications WHERE order_id=? AND event='intl_tracking_updated'", oid).status, "sent");
  await A(`/api/orders/${id2}/status`, { to: "confirmed" });
  const ov = await A(`/api/orders/${id2}/ship`, { courier: "FedEx", awb: "FX123456789", shipped_on: "2026-11-02", idempotency_key: key(), override_reason: "Pay-on-delivery arrangement agreed with buyer in writing" }); assert.equal(ov.status, 200);
  assert.equal(one("SELECT dispatch_override_reason r FROM orders WHERE id=?", id2).r.length > 10, true); assert.ok(one("SELECT 1 x FROM audit_log WHERE action='intl_dispatch_override' AND order_id=?", id2)); ok("tracking changes email the customer; an authorised admin can ship early only with a written override that is stored and audited");

  // ── webhook ──
  const o3 = (await place(body({ submission_id: key(), items: [{ id: "white-nfc-card", qty: 20 }] }), { ip: 24 })).d, id3 = one("SELECT id FROM orders WHERE txn_id=?", o3.orderNumber).id, ref3 = o3.orderNumber;
  const wh = async (evt, id, secret = SECRET, evid = "evt_" + key()) => { const raw = JSON.stringify(evt); const sig = await INTLAPI.hmacHex(secret, raw); return payments.onRequest({ request: new Request("https://x/api/razorpay/webhook", { method: "POST", headers: { "X-Razorpay-Signature": sig, "X-Razorpay-Event-Id": evid }, body: raw }), env: penv }); };
  const captured = (payId, amount, cur, ref, extra = {}) => ({ event: "payment.captured", payload: { payment: { entity: { id: payId, amount, currency: cur, status: "captured", notes: { order_ref: ref }, ...extra } } } });
  reset(); assert.equal((await wh(captured("pay_A", 1000, "USD", ref3), id3, "wrong")).status, 400); const nosec = await payments.onRequest({ request: new Request("https://x/api/razorpay/webhook", { method: "POST", body: "{}" }), env: penv }); assert.equal(nosec.status, 400);
  const nocfg = await payments.onRequest({ request: new Request("https://x/api/razorpay/webhook", { method: "POST", headers: { "X-Razorpay-Signature": "x" }, body: "{}" }), env: { ...penv, RAZORPAY_WEBHOOK_SECRET: "" } }); assert.equal(nocfg.status, 503);
  assert.equal(one("SELECT count(*) c FROM payments WHERE order_id=?", id3).c, 0); ok("webhook needs the configured secret and a valid signature; unsigned or wrongly signed events change nothing");
  // before acceptance a captured payment is not accepted (and is flagged)
  await wh(captured("pay_EARLY", 3000, "USD", ref3), id3); assert.equal(one("SELECT paid_paise p FROM orders WHERE id=?", id3).p, 0); assert.ok(one("SELECT 1 x FROM payment_alerts WHERE payment_ref='pay_EARLY'"));
  const q3 = (await A(`/api/orders/${id3}/intl/quote`, { shipping: "20", carrier: "UPS", confirm: true, idempotency_key: key(), expires: exp })).d.intl.quotes[0]; await Pj("/api/intl/order/quote", { o: id3, t: o3.viewUrl.match(/t=([0-9a-f]{32})/)[1], quote_id: q3.id, decision: "accept" });
  const total3 = one("SELECT total FROM orders WHERE id=?", id3).total; assert.equal(total3, 3000 + 2000);
  await wh(captured("pay_INR", total3, "INR", ref3), id3); assert.equal(one("SELECT paid_paise p FROM orders WHERE id=?", id3).p, 0); assert.ok(one("SELECT 1 x FROM payment_alerts WHERE payment_ref='pay_INR' AND reason LIKE '%currency%'"));
  await wh(captured("pay_BIG", total3 + 1, "USD", ref3), id3); assert.equal(one("SELECT paid_paise p FROM orders WHERE id=?", id3).p, 0);
  await wh({ event: "payment.failed", payload: { payment: { entity: { id: "pay_F", amount: total3, currency: "USD", status: "failed", notes: { order_ref: ref3 } } } } }, id3); await wh({ event: "payment.authorized", payload: { payment: { entity: { id: "pay_AU", amount: total3, currency: "USD", status: "authorized", notes: { order_ref: ref3 } } } } }, id3);
  assert.equal(one("SELECT payment_status s FROM orders WHERE id=?", id3).s, "unpaid"); assert.equal(one("SELECT count(*) c FROM payments WHERE order_id=?", id3).c, 0); ok("a payment is not recorded before acceptance, in the wrong currency, over the outstanding amount, or when failed/only authorised: the order stays unpaid and mismatches are flagged");
  const evid = "evt_fixed_1", part = total3 - 1500; const r1 = await wh(captured("pay_OK1", part, "USD", ref3), id3, SECRET, evid); assert.equal(r1.status, 200);
  const rep1 = await wh(captured("pay_OK1", part, "USD", ref3), id3, SECRET, evid); assert.equal((await rep1.json()).duplicate, true); await wh(captured("pay_OK1", part, "USD", ref3), id3, SECRET, "evt_other_id");
  let o3r = one("SELECT paid_paise p, payment_status s FROM orders WHERE id=?", id3); assert.equal(o3r.p, part); assert.equal(o3r.s, "unpaid"); assert.equal(one("SELECT count(*) c FROM payments WHERE order_id=?", id3).c, 1); assert.equal(one("SELECT currency c FROM payments WHERE order_id=?", id3).c, "USD"); ok("webhook replay (same event) and a re-sent payment (new event id) are recorded once; a partial payment keeps the order unpaid");
  await Promise.all([1, 2, 3].map((i) => wh(captured("pay_OK2", 1500, "USD", ref3), id3, SECRET, "evt_par_" + i))); o3r = one("SELECT paid_paise p, payment_status s FROM orders WHERE id=?", id3);
  assert.equal(o3r.p, total3); assert.equal(o3r.s, "paid"); assert.equal(one("SELECT count(*) c FROM payments WHERE order_id=?", id3).c, 2); assert.equal(one("SELECT count(*) c FROM notifications WHERE order_id=? AND event='payment_confirmed'", id3).c, 2); ok("concurrent duplicate deliveries add the payment once; the order becomes paid only when the full accepted amount is captured; each payment emails once");
  await wh({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_OK2", amount: 500, currency: "USD" } } } }, id3); await wh({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_OK2", amount: 500, currency: "USD" } } } }, id3, SECRET, "evt_r2");
  assert.equal(one("SELECT refunded_paise r FROM orders WHERE id=?", id3).r, 500); assert.equal(one("SELECT currency c FROM order_refunds WHERE order_id=?", id3).c, "USD"); assert.equal(one("SELECT count(*) c FROM notifications WHERE order_id=? AND event='intl_refund'", id3).c, 1); ok("provider refunds are recorded once with currency, and the customer is emailed once");
  await wh(captured("pay_UNKNOWN", 100, "USD", "INT-NOPE-0000"), id3); assert.ok(one("SELECT 1 x FROM payment_alerts WHERE payment_ref='pay_UNKNOWN'"));
  // cancel → email and stock back
  const stock0 = one("SELECT stock_qty s FROM products WHERE id='white-nfc-card'").s; const c1 = await A(`/api/orders/${id3}/status`, { to: "cancelled", confirm: true }); assert.equal(c1.status, 200);
  assert.equal(one("SELECT stock_qty s FROM products WHERE id='white-nfc-card'").s, stock0 + 20); assert.equal(one("SELECT status FROM notifications WHERE order_id=? AND event='intl_cancelled'", id3).status, "sent"); ok("cancelling an international order releases its stock and emails the customer");

  // ── enquiries ──
  const enq = (b, ip = 31) => Pj("/api/intl/enquiries", { name: "Ana", email: "ana@example.com", country: "Germany", product: "NFC cards 5000 pcs", quantity: "5000", message: "Need custom print", ...b }, { ip });
  assert.equal((await enq({ email: "x" })).status, 400); assert.equal((await enq({ name: "" })).status, 400); assert.equal((await enq({ website: "spam" })).status, 200); assert.equal(one("SELECT count(*) c FROM intl_enquiries").c, 0);
  assert.equal((await enq({})).status, 200); await enq({}); await enq({}); assert.equal((await enq({})).status, 429); assert.equal(one("SELECT count(*) c FROM intl_enquiries").c, 3); assert.equal((await enq({}, 32)).status, 200);
  const el = (await A("/api/intl/enquiries")).d.enquiries; assert.equal(el.length, 4); assert.equal((await A("/api/intl/enquiries", undefined, true)).status, 401);
  const eu = await A(`/api/intl/enquiries/${el[0].id}`, { status: "in_progress", notes: "Replied by email" }); assert.equal(eu.status, 200); assert.equal(eu.d.enquiries.find((x) => x.id === el[0].id).status, "in_progress"); ok("enquiries: validated, honeypot ignored, rate limited per connection, listed and managed in the admin (audited), admin-only");

  // ── safety without the migration; permissions ──
  for (const route of [["POST", `/api/orders/${oid}/intl/quote`], ["POST", `/api/orders/${oid}/intl/payment-received`], ["POST", `/api/orders/${oid}/intl/payment-link`], ["POST", `/api/orders/${oid}/intl/destination`], ["GET", "/api/intl/settings"], ["POST", "/api/intl/settings"]])
    assert.equal((await A(route[1], route[0] === "POST" ? {} : undefined, true)).status, 401);
  const noMig = makeDb({ exclude: ["0019_international.sql"] }); const penv2 = { DB: noMig.D1, DEV_NOTIFY_ECHO: "1" };
  payments.resetPricingCache(); const c0 = await payments.onRequest({ request: new Request("https://x/api/intl/config", { headers: { Origin: "https://www.ntagz.com" } }), env: penv2 }); assert.equal((await c0.json()).enabled, false);
  const aenv2 = { ...aenv, DB: noMig.D1 }; require(path.join(root, "functions", "api", "[[path]].js")); (await import(pathToFileURL(path.join(root, "admin", "src", "intl-admin.js")).href)).resetIntlSchemaCache();
  const lo = await admin.fetch(new Request(ADMIN + "/api/orders", { headers: { Cookie: cookie } }), aenv2); assert.equal(lo.status, 401); // different DB, no session there: still no crash
  ok("every international admin route needs a login; a database without migration 0019 keeps international off and does not break the storefront");
  console.log(`\nall ${n} international checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
