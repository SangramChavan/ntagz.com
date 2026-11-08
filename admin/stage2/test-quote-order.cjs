// Accepted quotation -> payment link -> paid order -> lead won. Reuses the pay-links tool; checkout (the payments Worker) stays the price authority.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeDb, root } = require("./d1shim.cjs");

let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const rej = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);

(async () => {
  const imp = (f) => import(pathToFileURL(path.join(root, f)).href);
  const core = await imp("packages/platform-core/src/index.js"), Q = await imp("packages/platform-core/src/quotes.js"), L = await imp("packages/platform-core/src/leads.js"), QO = await imp("admin/src/quote-order.js");
  const { loadAccess, accessForRoles } = core;
  const t = makeDb(); const { D1, sqlite, q, one } = t;
  const env = { DB: D1 };
  const HQ = "hq@example.test";

  // ---- fixtures: an Enterprise partner, leads, and quotations in several states ----
  sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'u1@example.test')").run();
  sqlite.prepare("INSERT INTO user_roles (id, user_id, role_key, granted_by) VALUES (?, 'u1', 'partner_enterprise', 'test')").run(crypto.randomUUID());
  sqlite.prepare("INSERT INTO partners (id, partner_code, user_id, type_key, status, business_name) VALUES ('p1', 'NTZ-ENT-0001', 'u1', 'enterprise', 'active', 'Biz One')").run();
  const A = await loadAccess(D1, "u1"); const hq = await accessForRoles(D1, HQ, ["hq_admin"]);
  let ph = 9820000000; const mkLead = async () => (await L.createLead(D1, A, { businessName: "Cafe " + ++ph, contactName: "Ravi Shah", phone: String(ph), email: "ravi@example.test", state: "Maharashtra", city: "Pune" })).lead.id;
  const items = [{ productId: "black-nfc-card", qty: 100 }];
  const quote = async (state) => { // state: how far to take it
    const leadId = await mkLead(); const id = (await Q.createQuote(D1, A, { leadId, items }, env)).quote.id;
    if (state === "draft") return { id, leadId };
    await Q.submit(D1, A, id, env); if (state === "pending") return { id, leadId };
    await Q.approve(D1, hq, id); if (state === "approved") return { id, leadId };
    await Q.recordResponseMine(D1, A, id, "accepted"); return { id, leadId };
  };
  const body = (o = {}) => ({ address: "12 MG Road, Camp, Pune", pincode: "411001", ...o });
  const pay = async (id, b) => { const r = await QO.quotePaymentLink(env, HQ, id, b); return { status: r.status, json: await r.json() }; };

  // ---- guards ----
  const approved = await quote("approved"); let r = await pay(approved.id, body());
  assert.equal(r.status, 409); assert.match(r.json.error.message, /customer accepted/); ok("a payment link needs an ACCEPTED quotation (an approved one is refused)");
  const pending = await quote("pending"); assert.equal((await pay(pending.id, body())).status, 409);
  const draft = await quote("draft"); assert.equal((await pay(draft.id, body())).status, 404); ok("pending quotes are refused and a draft is invisible to HQ");
  assert.equal((await pay("00000000-0000-0000-0000-000000000000", body())).status, 404); ok("unknown quotation -> 404");
  assert.equal((await Q.getAny(D1, hq, approved.id)).quote.payLink, null); ok("a quotation with no link reports none");

  // ---- validation (the pay-links tool's own rules apply) ----
  const acc = await quote("accepted");
  r = await pay(acc.id, {}); assert.equal(r.status, 400); assert.ok(r.json.error.fields.address && r.json.error.fields.pincode); ok("delivery address and pincode are required");
  r = await pay(acc.id, body({ pincode: "12" })); assert.equal(r.status, 400); assert.ok(r.json.error.fields.pincode);
  r = await pay(acc.id, body({ expiresInHours: 5 })); assert.equal(r.status, 400); assert.ok(r.json.error.fields.expires_in_hours);
  r = await pay(acc.id, body({ gstin: "nope" })); assert.equal(r.status, 400); assert.ok(r.json.error.fields.gstin); ok("bad pincode, expiry and GSTIN are refused field by field");
  assert.equal(one("SELECT COUNT(*) c FROM pay_links").c, 0); assert.equal(one("SELECT pay_link_id p FROM quotations WHERE id = ?", acc.id).p, null); ok("a refused request creates nothing");

  // ---- create: the link carries the quotation's own lines, customer and total ----
  r = await pay(acc.id, body({ gstin: "27ABCDE1234F1Z5" }));
  assert.equal(r.status, 201, JSON.stringify(r.json)); const d = r.json.data;
  assert.ok(d.url.startsWith(Q.PAY_BASE) && d.url.endsWith(d.id)); assert.equal(d.quotedPaise, 354000); assert.equal(d.currentPaise, 354000); assert.equal(d.priceMoved, false); ok("the link is created and the price has not moved");
  assert.equal(Q.PAY_BASE, /const BASE = "([^"]+)"/.exec(fs.readFileSync(path.join(root, "admin/src/paylinks.js"), "utf8"))[1]); ok("the link base URL matches the pay-links tool (no drift)");
  const pl = one("SELECT * FROM pay_links WHERE id = ?", d.id);
  assert.deepEqual(JSON.parse(pl.items_json), [{ id: "black-nfc-card", qty: 100 }]); assert.equal(pl.name, "Ravi Shah"); assert.equal(pl.phone, String(ph)); assert.equal(pl.email, "ravi@example.test"); assert.equal(pl.state, "Maharashtra"); assert.equal(pl.address, "12 MG Road, Camp, Pune"); assert.equal(pl.gstin, "27ABCDE1234F1Z5"); assert.equal(pl.note, `Quotation ${one("SELECT number n FROM quotations WHERE id = ?", acc.id).n}`); assert.equal(pl.source, "admin"); ok("lines, customer, state and address come from the quotation and the form (nothing is typed twice)");
  assert.equal(pl.quoted_paise, 354000); ok("the link remembers the quotation total, so the customer's page can say if prices changed");
  assert.equal(one("SELECT pay_link_id p FROM quotations WHERE id = ?", acc.id).p, d.id); assert.equal(one("SELECT COUNT(*) c FROM audit_log WHERE action = 'quote.paylink' AND entity_id = ?", acc.id).c, 1); assert.equal(one("SELECT COUNT(*) c FROM lead_activities WHERE lead_id = ? AND body LIKE 'Payment link created%'", acc.leadId).c, 1); ok("the quotation points at the link; the step is audited and noted on the lead");
  const st = (await Q.getAny(D1, hq, acc.id)).quote.payLink; assert.equal(st.status, "new"); assert.equal(st.url, d.url); assert.equal(st.paidOrderId, null); ok("HQ detail shows the link and its status");
  assert.ok(!JSON.stringify(await Q.getMine(D1, A, acc.id)).includes(d.id)); ok("the partner's view never carries the payment link");

  // ---- one open link at a time ----
  r = await pay(acc.id, body()); assert.equal(r.status, 409); assert.match(r.json.error.message, /already open/); assert.equal(one("SELECT COUNT(*) c FROM pay_links").c, 1); ok("a second link is refused while one is open");
  sqlite.prepare("UPDATE pay_links SET open_count = 2 WHERE id = ?").run(d.id); assert.equal((await Q.getAny(D1, hq, acc.id)).quote.payLink.status, "opened");
  sqlite.prepare("UPDATE pay_links SET open_count = 0, sent_at = unixepoch() WHERE id = ?").run(d.id); assert.equal((await Q.getAny(D1, hq, acc.id)).quote.payLink.status, "sent"); ok("link status follows the customer: new, sent, opened");
  sqlite.prepare("UPDATE pay_links SET status = 'cancelled' WHERE id = ?").run(d.id); assert.equal((await Q.getAny(D1, hq, acc.id)).quote.payLink.status, "cancelled");
  r = await pay(acc.id, body({ address: "99 Brigade Road, Bengaluru", pincode: "560001", state: "Karnataka" })); assert.equal(r.status, 201); const d2 = r.json.data; assert.notEqual(d2.id, d.id); assert.equal(one("SELECT pay_link_id p FROM quotations WHERE id = ?", acc.id).p, d2.id); assert.equal(one("SELECT state s FROM pay_links WHERE id = ?", d2.id).s, "Karnataka"); ok("after a cancel, a new link can be made (with a different address and state)");
  sqlite.prepare("UPDATE pay_links SET expires_at = unixepoch() - 5 WHERE id = ?").run(d2.id); assert.equal((await Q.getAny(D1, hq, acc.id)).quote.payLink.status, "expired");
  r = await pay(acc.id, body()); assert.equal(r.status, 201); const d3 = r.json.data; ok("an expired link can be replaced");

  // ---- paid -> lead won with the order ----
  sqlite.prepare("INSERT INTO orders (id, txn_id, gateway, status, total, payment_status) VALUES ('order-PAID-1', 'txn-PL-1', 'razorpay', 'confirmed', 354000, 'paid')").run();
  sqlite.prepare("UPDATE pay_links SET txn_ids = '[\"txn-PL-1\"]' WHERE id = ?").run(d3.id);
  const paid = (await Q.getAny(D1, hq, acc.id)).quote.payLink; assert.equal(paid.status, "paid"); assert.equal(paid.paidOrderId, "order-PAID-1"); assert.equal(paid.paidTotalPaise, 354000); ok("a payment through the link shows as paid, with the order and amount");
  r = await pay(acc.id, body()); assert.equal(r.status, 409); assert.match(r.json.error.message, /already been paid/); ok("a paid quotation cannot get another link");
  assert.equal(one("SELECT status s FROM leads WHERE id = ?", acc.leadId).s, "quotation"); ok("payment alone does not win the lead (HQ confirms)");
  const won = await L.setStatusHq(D1, hq, acc.leadId, { status: "won", orderId: paid.paidOrderId });
  assert.equal(won.lead.status, "won"); assert.equal(won.lead.orderId, "order-PAID-1"); assert.equal((await L.getMine(D1, A, acc.leadId)).lead.status, "won"); ok("HQ marks the lead won with the paid order; the partner sees it won");

  // ---- the price moved since the quotation ----
  const acc2 = await quote("accepted"); sqlite.prepare("UPDATE products SET price_paise = 4000 WHERE id = 'black-nfc-card'").run();
  r = await pay(acc2.id, body()); assert.equal(r.status, 201); assert.equal(r.json.data.quotedPaise, 354000); assert.equal(r.json.data.currentPaise, 472000); assert.equal(r.json.data.priceMoved, true); ok("if catalogue prices rose, HQ is told: ₹3,540 quoted, ₹4,720 now");
  assert.equal(one("SELECT quoted_paise q FROM pay_links WHERE id = ?", r.json.data.id).q, 354000); assert.deepEqual(JSON.parse(one("SELECT items_json i FROM pay_links WHERE id = ?", r.json.data.id).i), [{ id: "black-nfc-card", qty: 100 }]); ok("the link still records the QUOTED total, and the customer is charged the current checkout price (checkout stays the authority)");
  sqlite.prepare("UPDATE products SET price_paise = 3000 WHERE id = 'black-nfc-card'").run();

  // ---- an inactive product cannot be sold ----
  const acc3 = await quote("accepted"); sqlite.prepare("UPDATE products SET active = 0 WHERE id = 'black-nfc-card'").run();
  r = await pay(acc3.id, body()); assert.equal(r.status, 400); assert.match(JSON.stringify(r.json.error), /cannot be sold/i); assert.equal(one("SELECT pay_link_id p FROM quotations WHERE id = ?", acc3.id).p, null); sqlite.prepare("UPDATE products SET active = 1 WHERE id = 'black-nfc-card'").run(); ok("if a quoted product is no longer sellable, no link is made");

  // ---- HQ-only ----
  const fin = await accessForRoles(D1, "fin@example.test", ["finance"]);
  await rej(Q.getAny(D1, fin, acc.id), "FORBIDDEN"); ok("only HQ and Operations can see quotation payment details");

  console.log(`all ${n} quote-to-order checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
