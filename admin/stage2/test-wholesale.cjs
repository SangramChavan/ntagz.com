// Partner price lists, wholesale ordering and opening-stock credit (migration 0030). The partner API (platform-core) and the payments Worker run on ONE in-memory D1.
// Costs, bands and the margin below are TEST FIXTURES (the owner's COGS of Rs 90 for the review products is used only here); production has none of them until HQ sets them.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeDb, root } = require("./d1shim.cjs");
const PRICING = require(path.join(root, "functions/lib/pricing.js"));
const worker = require(path.join(root, "functions/api/[[path]].js"));

let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const rej = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);
const hmac = async (secret, msg) => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(msg))), (b) => b.toString(16).padStart(2, "0")).join("");
const env = { DB: null, RAZORPAY_KEY_ID: "rzp_test_abc123", RAZORPAY_KEY_SECRET: "rzp_secret" };
let rzp = 0, lastRzpAmount = null;
global.fetch = async (url, opts) => {
  if (String(url).includes("api.razorpay.com/v1/orders")) { lastRzpAmount = JSON.parse(opts.body).amount; return Response.json({ id: "order_WH" + String(++rzp).padStart(6, "0"), amount: lastRzpAmount, currency: "INR" }); }
  throw new Error("unexpected fetch " + url);
};

(async () => {
  const imp = (f) => import(pathToFileURL(path.join(root, f)).href);
  const core = await imp("packages/platform-core/src/index.js"), W = await imp("packages/platform-core/src/wholesale.js"), R = await imp("packages/platform-core/src/review.js"), Q = await imp("packages/platform-core/src/quotes.js");
  const { loadAccess, accessForRoles } = core;
  const t = makeDb(); const { D1, sqlite, one, q } = t; env.DB = D1;
  const run = (sql, ...a) => sqlite.prepare(sql).run(...a);
  const hq = await accessForRoles(D1, "hq@example.test", ["hq_admin"]);
  const call = (p, body, headers = {}) => { worker.resetPricingCache && worker.resetPricingCache(); return worker.onRequest({ request: new Request("https://ntagz.com" + p, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", Origin: "https://www.ntagz.com", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env }); };
  const jget = async (p) => { const r = await call(p); return { status: r.status, body: await r.json() }; };
  const jpost = async (p, b) => { const r = await call(p, b); return { status: r.status, body: await r.json() }; };

  // A partner who went through the real onboarding path: fee recorded by HQ (which grants the credit), then active.
  const mkPartner = async (id, type, role) => {
    run("INSERT INTO users (id, email) VALUES (?, ?)", "u-" + id, `${id}@example.test`);
    run("INSERT INTO user_roles (id, user_id, role_key, granted_by) VALUES (?, ?, ?, 'test')", crypto.randomUUID(), "u-" + id, role);
    run("INSERT INTO partners (id, user_id, type_key, status, business_name, state, pincode) VALUES (?, ?, ?, 'payment_pending', ?, 'Maharashtra', '411001')", id, "u-" + id, type, "Biz " + id);
    const fee = one("SELECT fee_paise f FROM partner_types WHERE key = ?", type).f;
    await R.recordFeePayment(D1, hq, id, { amountPaise: fee, method: "upi", reference: "UPI-" + id });
    run("UPDATE partners SET status = 'active' WHERE id = ?", id);
    return loadAccess(D1, "u-" + id);
  };
  const ent = await mkPartner("pe", "enterprise", "partner_enterprise"); // opening 4,999,900 paise
  assert.equal(one("SELECT COALESCE(SUM(delta_paise),0) b FROM partner_stock_credit WHERE partner_id = 'pe'").b, 4999900); ok("recording the opening payment at onboarding grants stock credit equal to it (net of GST)");
  const addr = { address: "12 MG Road, Camp, Pune", pincode: "411001", state: "Maharashtra", phone: "9820000001" };
  const cart = (id, qty) => [{ productId: id, qty }];

  // ---- nothing configured: refused, never guessed ----
  let cat = await W.catalogue(D1, ent); assert.equal(cat.ready, false); assert.ok(cat.products.every((p) => !p.priced && p.partnerExPaise === null)); ok("with no band, margin or cost, no product has a partner price");
  await rej(W.placeOrder(D1, ent, { ...addr, items: cart("black-nfc-card", 10) }), "VALIDATION_FAILED"); assert.equal(one("SELECT COUNT(*) c FROM orders WHERE partner_id IS NOT NULL").c, 0); ok("ordering is refused and nothing is created");
  let cfg = await W.adminConfig(D1, hq); assert.equal(cfg.minMarginBp, null); assert.ok(cfg.types.every((x) => x.discountBp === null)); assert.ok(cfg.missingCost.includes("black-nfc-card"));
  assert.equal(cfg.products.find((p) => p.id === "black-nfc-card").byType.enterprise.status, "no_band"); ok("HQ sees that no band, no margin and no costs are set (products listed as missing cost)");

  // ---- HQ configures (fixtures) ----
  run("UPDATE products SET cost_paise = 900 WHERE id = 'black-nfc-card'");
  run("UPDATE products SET cost_paise = 9000 WHERE id IN ('google-review-nfc-stand-5x5', 'google-review-nfc-qr-stand-custom-10x10')");
  run("UPDATE products SET cost_paise = NULL WHERE id = 'nfc-wristband'");
  await rej(W.setBand(D1, ent, { partnerType: "enterprise", discountBp: 3000 }), "FORBIDDEN"); ok("a partner cannot change bands");
  await rej(W.setBand(D1, hq, { partnerType: "enterprise", discountBp: 9500 }), "VALIDATION_FAILED"); await rej(W.setBand(D1, hq, { partnerType: "nope", discountBp: 100 }), "VALIDATION_FAILED"); await rej(W.setMargin(D1, hq, { minMarginBp: -1 }), "VALIDATION_FAILED"); ok("band and margin are validated");
  await W.setBand(D1, hq, { partnerType: "enterprise", discountBp: 3000 }); await W.setBand(D1, hq, { partnerType: "smile", discountBp: 2000 });
  await rej(W.placeOrder(D1, ent, { ...addr, items: cart("black-nfc-card", 10) }), "VALIDATION_FAILED"); ok("a band alone is not enough: without the minimum margin there is still no price");
  cfg = await W.setMargin(D1, hq, { minMarginBp: 2000 }); assert.equal(cfg.minMarginBp, 2000); assert.equal(one("SELECT COUNT(*) c FROM audit_log WHERE action IN ('wholesale.band','wholesale.margin')").c, 3); ok("HQ sets bands and the margin; each change is audited");

  // ---- prices (expected values from an independent formula) ----
  const priceOf = (id) => one("SELECT price_paise p FROM products WHERE id = ?", id).p;
  const exOf = (id) => Math.round((PRICING.PRODUCTS[id].allInclusive ? priceOf(id) / 1.18 : priceOf(id)));
  const expectUnit = (id, cost, bp, m) => { const retail = exOf(id), floor = Math.ceil(cost * (10000 + m) / 10000), disc = Math.ceil(retail * (10000 - bp) / 10000); return floor >= retail ? retail : Math.max(disc, floor); };
  cat = await W.catalogue(D1, ent); const by = Object.fromEntries(cat.products.map((p) => [p.id, p]));
  assert.equal(by["black-nfc-card"].partnerExPaise, expectUnit("black-nfc-card", 900, 3000, 2000)); assert.equal(by["black-nfc-card"].partnerExPaise, 2100);
  assert.equal(by["google-review-nfc-qr-stand-custom-10x10"].partnerExPaise, expectUnit("google-review-nfc-qr-stand-custom-10x10", 9000, 3000, 2000));
  assert.equal(by["google-review-nfc-stand-5x5"].partnerExPaise, exOf("google-review-nfc-stand-5x5")); assert.equal(by["google-review-nfc-stand-5x5"].discountPct, 0); ok("band applies to the ex-GST price; the 5x5 stand (retail under the floor) gets no discount");
  assert.equal(by["nfc-wristband"].priced, false); assert.ok(!JSON.stringify(cat).includes("cost")); ok("a product with no cost is refused, and the partner is never shown cost or floor");
  await rej(W.placeOrder(D1, ent, { ...addr, items: cart("nfc-wristband", 10) }), "VALIDATION_FAILED"); ok("ordering a product with no cost is refused");
  // the floor holds for every band; and it never raises a price above retail
  for (const bp of [0, 500, 3000, 6000, 9000]) for (const m of [0, 2000, 10000]) for (const id of ["black-nfc-card", "google-review-nfc-stand-5x5", "google-review-nfc-qr-stand-custom-10x10"]) {
    const cost = id === "black-nfc-card" ? 900 : 9000; const pu = PRICING.partnerUnit({ price: priceOf(id) / 100, allInclusive: !!PRICING.PRODUCTS[id].allInclusive, costPaise: cost, band: { discountBp: bp, minMarginBp: m } });
    assert.ok(pu.unitExPaise <= pu.retailExPaise); assert.ok(pu.unitExPaise >= Math.min(pu.floorPaise, pu.retailExPaise)); assert.equal(pu.unitExPaise, expectUnit(id, cost, bp, m));
  } ok("floor property: partner price is never below cost x (1 + margin) unless retail itself is lower, and never above retail");
  assert.equal(PRICING.partnerUnit({ price: 30, allInclusive: false, costPaise: null, band: { discountBp: 100, minMarginBp: 100 } }).reason, "no_cost");
  assert.equal(PRICING.priceCart([{ id: "black-nfc-card", qty: 10 }], { products: PRICING.PRODUCTS, live: { "black-nfc-card": { price_paise: 3000, cost_paise: null } }, state: "Maharashtra", member: false, settings: PRICING.settingsFrom({}), partner: { discountBp: 100, minMarginBp: 100 } }), null); ok("the engine itself fails closed without a cost");
  const guest = PRICING.priceCart([{ id: "black-nfc-card", qty: 10 }], { products: PRICING.PRODUCTS, live: { "black-nfc-card": { price_paise: 3000, cost_paise: 900 } }, state: "Maharashtra", member: false, settings: PRICING.settingsFrom({}) });
  assert.equal(guest.amount, 394); ok("guest pricing through the same engine is unchanged (Rs 394)");

  // ---- public bulk tiers vs the partner price (reported to HQ, not stacked) ----
  cfg = await W.adminConfig(D1, hq);
  const card = cfg.products.find((p) => p.id === "black-nfc-card").byType.enterprise; // partner 2100; bulk 25% = 2250, 15% = 2550, 10% = 2700
  assert.deepEqual(card.bulk.map((b) => b.atOrBelowPartner), [false, false, false]); ok("with a 30% band no public bulk tier undercuts the partner price");
  const wide = PRICING.partnerPriceReport(PRICING.PRODUCTS["black-nfc-card"], { price_paise: 3000, cost_paise: 900 }, { discountBp: 1000, minMarginBp: 2000 }); // partner 2700
  assert.deepEqual(wide.bulk.map((b) => b.atOrBelowPartner), [true, true, true]); assert.ok(wide.warnings.some((w) => /same or less than a partner/.test(w))); ok("with a 10% band every public bulk tier is at or below the partner price, and HQ is warned");
  const stand = cfg.products.find((p) => p.id === "google-review-nfc-stand-5x5").byType.enterprise; assert.equal(stand.limit, "retail"); assert.ok(stand.bulk.every((b) => b.belowFloor)); assert.ok(stand.warnings.length >= 2); ok("the 5x5 stand: retail under the floor, public bulk tiers under the floor, all shown to HQ");
  assert.ok(cfg.missingCost.includes("nfc-wristband") && !cfg.missingCost.includes("black-nfc-card")); ok("HQ lists products with no cost");

  // ---- orders paid wholly by stock credit ----
  const p10 = await W.price(D1, ent, { items: cart("black-nfc-card", 10) }); // 10 x 21.00 = 210 + GST 38 (rounded) + shipping 40
  assert.equal(p10.totals.totalPaise, 28800); assert.equal(p10.creditPaise, 28800); assert.equal(p10.payablePaise, 0); ok("price preview: wholesale total, credit applied, nothing to pay");
  const o1 = await W.placeOrder(D1, ent, { ...addr, gstin: "27ABCDE1234F1Z5", items: cart("black-nfc-card", 10) });
  assert.equal(o1.kind, "order"); assert.equal(o1.totalPaise, 28800);
  const ord = one("SELECT * FROM orders WHERE id = ?", o1.orderId);
  assert.equal(ord.partner_id, "pe"); assert.equal(ord.user_id, null); assert.equal(ord.total, 28800); assert.equal(ord.gst, 3800); assert.equal(ord.subtotal, 25000); assert.equal(ord.paid_paise, 28800); assert.equal(ord.payment_status, "paid"); assert.equal(ord.stock_credit_paise, 28800); assert.equal(ord.gstin, "27ABCDE1234F1Z5"); assert.equal(ord.shipping_paise, 4000);
  ok("the order carries the FULL value, GST and GSTIN like any order, tagged to the partner and to no customer account");
  assert.equal(one("SELECT COUNT(*) c FROM payments WHERE order_id = ? AND method = 'stock_credit' AND amount_paise = 28800", o1.orderId).c, 1);
  assert.equal(one("SELECT delta_paise d FROM partner_stock_credit WHERE order_id = ?", o1.orderId).d, -28800); assert.equal((await W.balance(D1, "pe")).availablePaise, 4999900 - 28800); ok("credit was drawn down: one payment row and one ledger consume");
  assert.deepEqual(await W.creditProblems(D1), []); ok("invariant: balance = grants - consumes, every consume matches its order and payment");
  const mine = await W.listMine(D1, ent); assert.equal(mine.items.length, 1); assert.equal(mine.items[0].items[0].name.length > 0, true); assert.equal(mine.credit.consumedPaise, 28800); ok("the partner sees the order and the balance");

  // ---- isolation and permissions ----
  const flex = await mkPartner("pf", "flex", "partner_flex"); await W.setBand(D1, hq, { partnerType: "flex", discountBp: 1500 });
  assert.equal((await W.listMine(D1, flex)).items.length, 0); ok("another partner's orders are not listed");
  const plus = await mkPartner("pp", "smile_plus", "partner_smile_plus"); assert.equal((await W.adminPartners(D1, hq)).items.find((p) => p.id === "pp").canOrder, false);
  await rej(W.catalogue(D1, plus), "FORBIDDEN"); await rej(W.placeOrder(D1, plus, { ...addr, items: cart("black-nfc-card", 10) }), "FORBIDDEN"); assert.equal((await W.balance(D1, "pp")).availablePaise, 1999900); ok("Smile+ has credit but no orders.place.own: refused (HQ list says it cannot order)");
  run("INSERT INTO user_roles (id, user_id, role_key, granted_by) VALUES (?, 'u-pp', 'customer', 'test')", crypto.randomUUID()); const plusC = await loadAccess(D1, "u-pp");
  assert.ok(plusC.permissions.has("orders.place.own")); await rej(W.catalogue(D1, plusC), "FORBIDDEN"); assert.equal(await W.canOrder(D1, plusC), false); assert.equal(await W.canOrder(D1, ent), true); ok("a Smile+ partner who also holds the generic customer role (which carries orders.place.own) still cannot order");
  await rej(W.catalogue(D1, { ...ent, permissions: new Map() }), "FORBIDDEN"); await rej(W.catalogue(D1, await accessForRoles(D1, "x@example.test", ["customer"])), "FORBIDDEN"); ok("no permission, or a customer without a partner record: refused");

  // ---- partial payment: credit reserved on a pay link ----
  const sm = await mkPartner("ps", "smile", "partner_smile"); // opening 999,900
  const big = cart("google-review-nfc-qr-stand-custom-10x10", 10);
  const quote = await W.price(D1, sm, { items: big }); assert.ok(quote.totals.totalPaise > 999900); assert.equal(quote.creditPaise, 999900); assert.equal(quote.payablePaise, quote.totals.totalPaise - 999900);
  const gpr = PRICING.priceCart([{ id: big[0].productId, qty: 10 }], { products: PRICING.PRODUCTS, live: Object.fromEntries(q("SELECT * FROM products").map((r) => [r.id, r])), state: "Maharashtra", member: false, settings: PRICING.settingsFrom({}) });
  assert.ok(gpr.amount * 100 > quote.totals.totalPaise); ok("a partner pays less than a guest for the same cart; the rest after credit is the gateway amount");
  const l1 = await W.placeOrder(D1, sm, { ...addr, items: big }); assert.equal(l1.kind, "link"); assert.equal(l1.creditPaise, 999900); assert.equal(l1.payablePaise, quote.payablePaise); assert.ok(l1.payUrl.startsWith(Q.PAY_BASE));
  let bal = await W.balance(D1, "ps"); assert.equal(bal.heldPaise, 999900); assert.equal(bal.availablePaise, 0); assert.equal(q("SELECT * FROM orders WHERE partner_id = 'ps'").length, 0); ok("a link reserves the credit (derived, no ledger row) and creates no order yet");
  const l2 = await W.placeOrder(D1, sm, { ...addr, items: big }); assert.equal(l2.creditPaise, 0); assert.equal(l2.payablePaise, l2.totalPaise); ok("a second order while credit is reserved gets no credit (cannot spend it twice)");
  assert.equal((await W.cancelMine(D1, sm, l2.linkId)).items.find((i) => i.id === l2.linkId).status, "cancelled"); await rej(W.cancelMine(D1, flex, l1.linkId), "NOT_FOUND"); ok("cancel works; cancelling someone else's link is 404");
  run("UPDATE pay_links SET expires_at = unixepoch() - 5 WHERE id = ?", l1.linkId); assert.equal((await W.balance(D1, "ps")).availablePaise, 999900); ok("an expired link releases its credit with no background job");
  run("UPDATE pay_links SET expires_at = unixepoch() + 86400 WHERE id = ?", l1.linkId);

  // ---- the customer-facing payment page and the payments Worker ----
  const tok = l1.linkId;
  const v = await jget("/api/pay/" + tok); assert.equal(v.status, 200); assert.equal(v.body.status, "active"); assert.equal(v.body.wholesale, true);
  assert.equal(v.body.totals.stockCredit, 9999); assert.equal(v.body.totals.orderTotal * 100, l1.totalPaise); assert.equal(Math.round(v.body.totals.amount * 100), l1.payablePaise); assert.deepEqual(v.body.nudges, []); assert.equal(v.body.memberPricing, false); assert.equal(v.body.adjusted, false);
  ok("the pay page shows the full order, the stock credit and only the remainder to pay (no nudges, no member pricing)");
  const adj = await jpost("/api/pay/" + tok + "/adjust", { id: big[0].productId, qty: 20 }); assert.equal(adj.status, 400); assert.equal(JSON.parse(one("SELECT items_json i FROM pay_links WHERE id = ?", tok).i)[0].qty, 10); ok("a wholesale link cannot be enlarged at partner price from the payment page");
  const st = await jpost("/api/pay/" + tok + "/start", {}); assert.equal(st.status, 200); assert.equal(st.body.amountPaise, l1.payablePaise); assert.equal(lastRzpAmount, l1.payablePaise); ok("the gateway is asked for exactly the remainder after stock credit");
  const it = one("SELECT * FROM checkout_intents WHERE txn_id = ?", st.body.orderId); assert.equal(it.partner_id, "ps"); assert.equal(it.credit_paise, 999900); assert.equal(it.user_id, null); assert.equal(it.amount_paise, l1.payablePaise); assert.equal(it.subtotal_paise + it.gst_paise, l1.totalPaise); ok("the intent keeps the full value (subtotal + GST), the gateway amount and the credit; it is never attached to a customer account");
  const pay = (id, ref) => hmac("rzp_secret", `${id}|${ref}`).then((sig) => jpost("/api/verify-payment", { razorpay_order_id: id, razorpay_payment_id: ref, razorpay_signature: sig }));
  const vr = await pay(st.body.orderId, "pay_wh1"); assert.equal(vr.status, 200, JSON.stringify(vr.body));
  const wo = one("SELECT * FROM orders WHERE txn_id = ?", st.body.orderId);
  assert.equal(wo.partner_id, "ps"); assert.equal(wo.total, l1.totalPaise); assert.equal(wo.paid_paise, l1.totalPaise); assert.equal(wo.stock_credit_paise, 999900); assert.equal(wo.payment_status, "paid"); assert.equal(wo.user_id, null); assert.equal(wo.subtotal + wo.gst, wo.total); ok("payment creates the order at FULL value (GST invoice basis), tagged to the partner");
  const pm = q("SELECT method, amount_paise a FROM payments WHERE order_id = ? ORDER BY method", wo.id); assert.deepEqual(pm.map((x) => [x.method, x.a]), [["razorpay", l1.payablePaise], ["stock_credit", 999900]]); ok("two payment rows: the gateway remainder and the stock credit");
  assert.equal(one("SELECT delta_paise d FROM partner_stock_credit WHERE order_id = ?", wo.id).d, -999900); bal = await W.balance(D1, "ps"); assert.equal(bal.availablePaise, 0); assert.equal(bal.heldPaise, 0); assert.equal(bal.consumedPaise, 999900); ok("credit consumed once; the paid link no longer holds anything");
  await pay(st.body.orderId, "pay_wh1"); assert.equal(one("SELECT COUNT(*) c FROM orders WHERE partner_id = 'ps'").c, 1); assert.equal(one("SELECT COUNT(*) c FROM partner_stock_credit WHERE partner_id = 'ps' AND kind = 'consume'").c, 1); ok("a repeated verification does not create a second order or consume credit twice");
  assert.deepEqual(await W.creditProblems(D1), []);

  // ---- races on one balance: exactly one wins ----
  const pc = await mkPartner("pc", "smile", "partner_smile");
  const mid = cart("black-nfc-card", 242); const midTotal = (await W.price(D1, pc, { items: mid })).totals.totalPaise; assert.ok(midTotal < 999900 && midTotal * 2 > 999900);
  const rs = await Promise.allSettled([W.placeOrder(D1, pc, { ...addr, items: mid }), W.placeOrder(D1, pc, { ...addr, items: mid })]);
  assert.equal(rs.filter((x) => x.status === "fulfilled").length, 1); assert.equal(rs.find((x) => x.status === "rejected").reason.code, "CONFLICT"); assert.equal(one("SELECT COUNT(*) c FROM orders WHERE partner_id = 'pc'").c, 1); assert.equal((await W.balance(D1, "pc")).availablePaise, 999900 - midTotal); ok("two simultaneous orders against one balance: exactly one is created, the other is refused");
  const pq = await mkPartner("pq", "smile", "partner_smile");
  const rl = await Promise.allSettled([W.placeOrder(D1, pq, { ...addr, items: big }), W.placeOrder(D1, pq, { ...addr, items: big })]);
  assert.equal(rl.filter((x) => x.status === "fulfilled").length, 1); assert.equal((await W.balance(D1, "pq")).heldPaise, 999900); assert.equal(one("SELECT COUNT(*) c FROM pay_links WHERE partner_id = 'pq'").c, 1); ok("two simultaneous links cannot reserve the same credit twice");

  // ---- HQ views ----
  const ps = await W.adminPartners(D1, hq); const row = ps.items.find((x) => x.id === "ps"); assert.equal(row.credit.grantedPaise, 999900); assert.equal(row.ordersN, 1); assert.equal(row.canOrder, true); assert.deepEqual(ps.problems, []);
  const ho = await W.adminOrders(D1, hq, "ps"); assert.equal(ho.orders.length, 1); assert.equal(ho.orders[0].creditPaise, 999900); await rej(W.adminOrders(D1, hq, "nope"), "NOT_FOUND"); await rej(W.adminPartners(D1, ent), "FORBIDDEN"); ok("HQ sees each partner's credit balance and orders; partners cannot call the HQ views");

  // ---- sabotage: the invariant check must catch each kind of corruption ----
  const consume = one("SELECT * FROM partner_stock_credit WHERE order_id = ?", o1.orderId);
  run("DELETE FROM partner_stock_credit WHERE id = ?", consume.id); assert.ok((await W.creditProblems(D1)).some((x) => /nothing was consumed/.test(x))); run("INSERT INTO partner_stock_credit (id, partner_id, kind, delta_paise, order_id, actor) VALUES (?, 'pe', 'consume', -28800, ?, 'system')", consume.id, o1.orderId);
  assert.deepEqual(await W.creditProblems(D1), []);
  run("UPDATE orders SET stock_credit_paise = 100 WHERE id = ?", o1.orderId); assert.ok((await W.creditProblems(D1)).some((x) => /does not match/.test(x))); run("UPDATE orders SET stock_credit_paise = 28800 WHERE id = ?", o1.orderId);
  run("INSERT INTO partner_fee_payments (id, partner_id, amount_paise, gst_paise, method, reference, recorded_by) VALUES ('fx', 'pe', 500000, 0, 'upi', 'UPI-SAB', 'x')"); assert.ok((await W.creditProblems(D1)).some((x) => /differ from opening payments/.test(x))); run("DELETE FROM partner_fee_payments WHERE id = 'fx'");
  run("UPDATE partner_stock_credit SET delta_paise = -9000000 WHERE id = ?", consume.id); run("UPDATE orders SET stock_credit_paise = 9000000 WHERE id = ?", o1.orderId); run("UPDATE payments SET amount_paise = 9000000 WHERE order_id = ? AND method = 'stock_credit'", o1.orderId);
  assert.ok((await W.creditProblems(D1)).some((x) => /negative/.test(x))); run("UPDATE partner_stock_credit SET delta_paise = -28800 WHERE id = ?", consume.id); run("UPDATE orders SET stock_credit_paise = 28800 WHERE id = ?", o1.orderId); run("UPDATE payments SET amount_paise = 28800 WHERE order_id = ? AND method = 'stock_credit'", o1.orderId);
  assert.deepEqual(await W.creditProblems(D1), []); ok("sabotage: a lost consume, a wrong amount, an unmatched opening payment and an overdraw are each detected; restoring clears them");
  assert.throws(() => run("INSERT INTO partner_stock_credit (id, partner_id, kind, delta_paise, order_id, actor) VALUES ('dup', 'pe', 'consume', -1, ?, 'x')", o1.orderId), /UNIQUE/); assert.throws(() => run("INSERT INTO partner_stock_credit (id, partner_id, kind, delta_paise, actor) VALUES ('bad', 'pe', 'grant', 100, 'x')"), /CHECK/); ok("the database itself refuses a second consume for one order and a grant with no opening payment");

  // ---- turning the band off locks pricing again; cost removed locks the product ----
  await W.setBand(D1, hq, { partnerType: "enterprise", discountBp: null }); await rej(W.price(D1, ent, { items: cart("black-nfc-card", 10) }), "VALIDATION_FAILED");
  await W.setBand(D1, hq, { partnerType: "enterprise", discountBp: 3000 }); run("UPDATE products SET cost_paise = NULL WHERE id = 'black-nfc-card'"); await rej(W.price(D1, ent, { items: cart("black-nfc-card", 10) }), "VALIDATION_FAILED"); ok("clearing a band or a product's cost stops partner pricing straight away");
  const l4 = await W.placeOrder(D1, sm, { ...addr, items: big }).catch((e) => e); // sm has no credit left; the link must be priced fresh by the Worker
  assert.equal(l4.kind, "link"); assert.equal(l4.creditPaise, 0); run("UPDATE products SET cost_paise = NULL WHERE id = 'google-review-nfc-qr-stand-custom-10x10'");
  const gone = await jget("/api/pay/" + l4.linkId); assert.equal(gone.status, 200); assert.equal(gone.body.status, "error"); assert.match(gone.body.message, /can no longer be priced/); ok("if a cost disappears after a link was made, the payments Worker refuses to price it rather than guessing");

  // ---- review follow-ups: stock rule on the credit path; a partner's own wholesale order never wins a lead ----
  run("UPDATE products SET cost_paise = 900, track_stock = 1, stock_qty = 5, preorder_enabled = 0 WHERE id = 'black-nfc-card'");
  await rej(W.placeOrder(D1, ent, { ...addr, items: cart("black-nfc-card", 10) }), "VALIDATION_FAILED"); assert.equal(one("SELECT COUNT(*) c FROM orders WHERE partner_id = 'pe'").c, 1); ok("credit orders respect tracked stock like checkout (no order beyond stock)");
  const Lm = await imp("packages/platform-core/src/leads.js"); run("INSERT INTO leads (id, partner_id, created_by, business_name, contact_name, phone, status) VALUES ('ld1', 'pe', 'u-pe', 'Cafe X', 'R', '9811111111', 'qualified')");
  await rej(Lm.setStatusHq(D1, hq, "ld1", { status: "won", orderId: o1.orderId }), "VALIDATION_FAILED"); assert.equal(one("SELECT COUNT(*) c FROM commissions").c, 0); ok("a partner's own wholesale order cannot win a lead or earn commission");

  console.log(`all ${n} wholesale checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
