// Quotations: priced by the checkout engine, frozen snapshots, approval flow, isolation, permissions, expiry, emails, HTTP routes.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeDb, root } = require("./d1shim.cjs");
const PRICING = require(path.join(root, "functions/lib/pricing.js"));

let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const rej = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);

(async () => {
  const imp = (f) => import(pathToFileURL(path.join(root, "packages/platform-core/src", f)).href);
  const core = await imp("index.js"), Q = await imp("quotes.js"), L = await imp("leads.js");
  const { loadAccess, accessForRoles, partnerRouter, adminV1 } = core;
  const t = makeDb(); const { D1, sqlite, q, one } = t;
  const env = { DB: D1, HQ_NOTIFY_EMAILS: "hq@example.test" };

  // ---- fixtures ----
  const mk = (i, type, role, code) => {
    sqlite.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run("u" + i, `u${i}@example.test`);
    sqlite.prepare("INSERT INTO user_roles (id, user_id, role_key, granted_by) VALUES (?, ?, ?, 'test')").run(crypto.randomUUID(), "u" + i, role);
    sqlite.prepare("INSERT INTO partners (id, partner_code, user_id, type_key, status, business_name) VALUES (?, ?, ?, ?, 'active', ?)").run("p" + i, code, "u" + i, type, `Biz ${code}`);
    sqlite.prepare("INSERT INTO partner_applications (id, user_id, type_key, status, partner_id, form_json) VALUES (?, ?, ?, 'approved', ?, ?)").run("a" + i, "u" + i, type, "p" + i, JSON.stringify({ name: `Owner ${i}` }));
  };
  mk(1, "flex", "partner_flex", "NTZ-FLX-0001");             // Flex has no quotation right
  mk(2, "enterprise", "partner_enterprise", "NTZ-ENT-0001");
  mk(3, "360", "partner_360", "NTZ-360-0001");
  const A = {}; for (const i of [1, 2, 3]) A[i] = await loadAccess(D1, "u" + i);
  const hq = await accessForRoles(D1, "hq@example.test", ["hq_admin"]);
  const ops = await accessForRoles(D1, "ops@example.test", ["operations"]);
  const fin = await accessForRoles(D1, "fin@example.test", ["finance"]);
  const lead = async (acc, phone, state) => (await L.createLead(D1, acc, { businessName: "Cafe " + phone, contactName: "Ravi", phone, email: "ravi@example.test", state, city: "Pune" })).lead.id;
  const leadMH = await lead(A[2], "9820000001", "Maharashtra");
  const leadKA = await lead(A[2], "9820000002", "Karnataka");
  const leadNone = await lead(A[2], "9820000003", undefined);
  const price = (id) => one("SELECT price_paise p FROM products WHERE id = ?", id).p;
  assert.equal(price("black-nfc-card"), 3000); assert.equal(price("anti-metal-tag"), 2000); // fixtures below rely on the seeded catalogue

  // ---- catalogue ----
  let cat = await Q.catalogue(D1, A[2]);
  assert.ok(cat.find((c) => c.id === "black-nfc-card" && c.moq === 10 && c.listPricePaise === 3000)); assert.ok(cat.find((c) => c.id === "sample-kit" && c.fixed && c.moq === 1)); ok("the quote catalogue lists sellable products with minimum order and fixed-kit flags");
  assert.ok(!cat.some((c) => !PRICING.PRODUCTS[c.id])); sqlite.prepare("UPDATE products SET active = 0 WHERE id = 'nfc-ring'").run();
  assert.ok(!(await Q.catalogue(D1, A[2])).some((c) => c.id === "nfc-ring")); sqlite.prepare("UPDATE products SET active = 1 WHERE id = 'nfc-ring'").run(); ok("inactive products are not quotable");

  // ---- pricing = the checkout engine ----
  const engine = (items, state) => PRICING.priceCart(items, { products: PRICING.PRODUCTS, live: Object.fromEntries(q("SELECT * FROM products").map((r) => [r.id, r])), state, member: false, settings: PRICING.settingsFrom({}) });
  let p = await Q.price(D1, A[2], { items: [{ productId: "black-nfc-card", qty: 100 }], state: "Maharashtra" });
  assert.equal(p.totals.totalPaise, 354000); assert.equal(p.totals.gstPaise, 54000); assert.equal(p.totals.shippingPaise, 0); assert.equal(p.totals.subtotalPaise, 300000); ok("100 black cards to Maharashtra = ₹3,540 (₹3,000 + 18% GST, free shipping over ₹2,000)");
  assert.equal(p.totals.totalPaise, engine([{ id: "black-nfc-card", qty: 100 }], "Maharashtra").amount * 100); ok("the total equals the checkout engine's total");
  p = await Q.price(D1, A[2], { items: [{ productId: "black-nfc-card", qty: 1000 }, { productId: "anti-metal-tag", qty: 500 }], state: "Karnataka" });
  const e2 = engine([{ id: "black-nfc-card", qty: 1000 }, { id: "anti-metal-tag", qty: 500 }], "Karnataka");
  assert.equal(p.totals.totalPaise, e2.amount * 100); assert.equal(p.totals.discountPaise, Math.round(e2.bulkDiscount * 100)); assert.ok(p.totals.discountPaise > 0); assert.equal(p.lines[0].bulkPct, 15); assert.equal(p.lines[1].bulkPct, 10); ok("quantity discounts (15% at 1,000, 10% at 500) come straight from the engine");
  p = await Q.price(D1, A[2], { items: [{ productId: "anti-metal-tag", qty: 10 }], state: "Karnataka" }); assert.equal(p.totals.shippingPaise, 8000); assert.equal(p.totals.totalPaise, (200 + 36 + 80) * 100); ok("a small order outside Maharashtra carries shipping (₹80)");
  p = await Q.price(D1, A[2], { items: [{ productId: "anti-metal-tag", qty: 10 }] }); assert.equal(p.totals.shippingPaise, 0); ok("with no state, shipping is left out (the share text says it is extra)");
  const bad = async (items) => Q.price(D1, A[2], { items }).catch((e) => e);
  assert.equal((await bad([{ productId: "black-nfc-card", qty: 5 }])).fields["items.0"], "minimum 10"); assert.equal((await bad([{ productId: "nope", qty: 10 }])).fields["items.0"], "not available");
  assert.equal((await bad([{ productId: "sample-kit", qty: 2 }])).fields["items.0"], "sold as one kit"); assert.equal((await bad([{ productId: "black-nfc-card", qty: 10 }, { productId: "black-nfc-card", qty: 20 }])).code, "VALIDATION_FAILED");
  assert.equal((await bad([])).code, "VALIDATION_FAILED"); assert.equal((await bad(Array.from({ length: 31 }, (_, i) => ({ productId: "black-nfc-card", qty: 10 })))).code, "VALIDATION_FAILED"); assert.equal((await bad([{ productId: "black-nfc-card", qty: 1.5 }])).code, "VALIDATION_FAILED"); assert.equal((await bad([{ productId: "black-nfc-card", qty: 1e9 }])).code, "VALIDATION_FAILED"); ok("below-minimum, unknown, duplicate, fixed-kit, empty, oversized, fractional and absurd quantities are all refused");

  // ---- who may quote ----
  await rej(Q.price(D1, A[1], { items: [{ productId: "black-nfc-card", qty: 10 }] }), "FORBIDDEN"); await rej(Q.createQuote(D1, A[1], { leadId: leadMH, items: [{ productId: "black-nfc-card", qty: 10 }] }), "FORBIDDEN"); ok("a Flex partner has no quotation right");
  await rej(Q.listMine(D1, hq), "FORBIDDEN"); ok("HQ staff do not use the partner quote screens");

  // ---- create ----
  const items100 = [{ productId: "black-nfc-card", qty: 100 }];
  let r = await Q.createQuote(D1, A[2], { leadId: leadMH, items: items100, notes: "Custom logo on the back" }, env);
  const id1 = r.quote.id;
  assert.match(r.quote.number, /^Q-\d{4}-0001$/); assert.equal(r.quote.status, "draft"); assert.equal(r.quote.totalPaise, 354000); assert.equal(r.quote.customerName, "Ravi"); assert.equal(r.quote.customerPhone, "9820000001"); assert.equal(r.quote.items.length, 1); assert.ok(!("shareText" in r.quote)); ok("a draft is created for the partner's own lead, with customer details copied from the lead");
  assert.equal(Math.round((r.quote.validUntil - Date.now() / 1000) / 86400), 15); ok("a quotation is valid for 15 days by default");
  assert.equal(one("SELECT COUNT(*) c FROM audit_log WHERE action='quote.create' AND entity_id = ?", id1).c, 1); assert.ok(one("SELECT COUNT(*) c FROM lead_activities WHERE lead_id = ? AND body LIKE 'Quotation Q-%drafted%'", leadMH).c === 1); ok("creation is audited and noted on the lead");
  await rej(Q.createQuote(D1, A[2], { leadId: leadMH, items: items100, validDays: 0 }), "VALIDATION_FAILED"); await rej(Q.createQuote(D1, A[2], { leadId: leadMH, items: items100, validDays: 90 }), "VALIDATION_FAILED"); ok("validity must be 1 to 60 days");
  await rej(Q.createQuote(D1, A[3], { leadId: leadMH, items: items100 }), "NOT_FOUND"); ok("a partner cannot quote someone else's lead");
  await rej(Q.createQuote(D1, A[2], { leadId: "nope", items: items100 }), "NOT_FOUND"); sqlite.prepare("UPDATE leads SET status='lost' WHERE id = ?").run(leadNone);
  await rej(Q.createQuote(D1, A[2], { leadId: leadNone, items: items100 }), "CONFLICT"); sqlite.prepare("UPDATE leads SET status='new' WHERE id = ?").run(leadNone); ok("a closed lead cannot be quoted");
  assert.equal(one("SELECT COUNT(*) c FROM quotations").c, 1); ok("refused quotes leave nothing behind");
  assert.equal((await Q.listAll(D1, hq)).items.length, 0); await rej(Q.getAny(D1, hq, id1), "NOT_FOUND"); ok("a draft is the partner's private work: HQ cannot see it");

  // ---- snapshot immutability ----
  sqlite.prepare("UPDATE products SET price_paise = 5000 WHERE id = 'black-nfc-card'").run();
  r = await Q.getMine(D1, A[2], id1); assert.equal(r.quote.totalPaise, 354000); assert.equal(r.quote.items[0].unitPricePaise, 3000); ok("a later price change never alters a saved quotation (immutable snapshot)");
  r = await Q.replaceItems(D1, A[2], id1, { items: [{ productId: "black-nfc-card", qty: 100 }, { productId: "anti-metal-tag", qty: 50 }] });
  assert.equal(r.quote.items.length, 2); assert.equal(r.quote.items[0].unitPricePaise, 5000); assert.equal(r.quote.totalPaise, engine([{ id: "black-nfc-card", qty: 100 }, { id: "anti-metal-tag", qty: 50 }], "Maharashtra").amount * 100); assert.equal(r.quote.notes, "Custom logo on the back"); ok("editing a draft re-prices it with today's prices and replaces the lines");
  sqlite.prepare("UPDATE products SET price_paise = 3000 WHERE id = 'black-nfc-card'").run();
  assert.equal(one("SELECT COUNT(*) c FROM quotation_items WHERE quotation_id = ?", id1).c, 2); ok("no duplicate or stale lines after an edit");

  // ---- isolation ----
  for (const f of [() => Q.getMine(D1, A[3], id1), () => Q.replaceItems(D1, A[3], id1, { items: items100 }), () => Q.submit(D1, A[3], id1, env), () => Q.cancel(D1, A[3], id1), () => Q.markSent(D1, A[3], id1), () => Q.recordResponseMine(D1, A[3], id1, "accepted")]) await rej(f(), "NOT_FOUND");
  assert.equal((await Q.listMine(D1, A[3])).items.length, 0); ok("another partner cannot read, edit, submit, cancel or answer a quotation (it is 'not found')");

  // ---- submit -> HQ ----
  r = await Q.submit(D1, A[2], id1, env); assert.equal(r.quote.status, "pending_approval");
  const hqMail = q("SELECT * FROM email_outbox WHERE template = 'quotation_submitted'"); assert.equal(hqMail.length, 1); assert.equal(hqMail[0].to_email, "hq@example.test"); assert.match(JSON.parse(hqMail[0].data_json).number, /^Q-/); ok("submitting asks HQ for approval and emails the HQ inbox");
  await rej(Q.submit(D1, A[2], id1, env), "CONFLICT"); await rej(Q.replaceItems(D1, A[2], id1, { items: items100 }), "CONFLICT"); assert.equal(q("SELECT * FROM email_outbox WHERE template = 'quotation_submitted'").length, 1); ok("a submitted quotation cannot be edited or submitted twice (and no second email)");
  let all = await Q.listAll(D1, hq); assert.equal(all.items.length, 1); assert.equal(all.items[0].partnerCode, "NTZ-ENT-0001"); assert.equal(all.counts.pending_approval, 1); assert.ok(!("shareText" in all.items[0])); ok("HQ sees the queue with the partner named");
  assert.equal((await Q.listAll(D1, hq, { q: "ntz-ent" })).items.length, 1); assert.equal((await Q.listAll(D1, hq, { q: q("SELECT number FROM quotations")[0].number })).items.length, 1); assert.equal((await Q.listAll(D1, hq, { q: "%" })).items.length, 0); assert.equal((await Q.listAll(D1, hq, { status: "approved" })).items.length, 0); ok("HQ can search by partner, number or lead; wildcards are literal; status filter works");
  await rej(Q.listAll(D1, fin), "FORBIDDEN"); await rej(Q.approve(D1, fin, id1), "FORBIDDEN"); await rej(Q.approve(D1, { ...A[2] }, id1), "FORBIDDEN"); ok("only HQ and Operations can see or approve quotations");

  // ---- reject, revise, resubmit ----
  await rej(Q.reject(D1, hq, id1, "x"), "VALIDATION_FAILED"); r = await Q.reject(D1, ops, id1, "Please confirm the logo file first");
  assert.equal(r.quote.status, "rejected"); assert.equal(r.quote.decisionNote, "Please confirm the logo file first"); const rm = q("SELECT * FROM email_outbox WHERE template = 'quotation_rejected'")[0]; assert.equal(rm.to_email, "u2@example.test"); assert.equal(JSON.parse(rm.data_json).note, "Please confirm the logo file first"); assert.equal(JSON.parse(rm.data_json).name, "Owner 2"); ok("rejection needs a reason; the partner is emailed it");
  r = await Q.getMine(D1, A[2], id1); assert.equal(r.quote.status, "rejected"); assert.ok(!JSON.stringify(r).includes("hq@example.test")); ok("the partner sees the reason, not the admin's email");
  r = await Q.replaceItems(D1, A[2], id1, { items: [{ productId: "black-nfc-card", qty: 200 }] }); assert.equal(r.quote.status, "draft"); assert.equal(r.quote.decisionNote, null); ok("revising a rejected quotation makes it a draft again");
  await Q.submit(D1, A[2], id1, env); assert.equal(q("SELECT * FROM email_outbox WHERE template = 'quotation_submitted'").length, 2); ok("resubmitting asks HQ again (a new email, not swallowed as a duplicate)");

  // ---- approve ----
  r = await Q.approve(D1, hq, id1); assert.equal(r.quote.status, "approved"); assert.equal(r.quote.approvedBy, "hq@example.test"); assert.ok(r.quote.shareText); ok("HQ approves");
  assert.equal(one("SELECT status FROM leads WHERE id = ?", leadMH).status, "quotation"); assert.equal((await L.getMine(D1, A[2], leadMH)).lead.status, "quotation"); ok("approval moves the lead to 'quotation'");
  const am = q("SELECT * FROM email_outbox WHERE template = 'quotation_approved'")[0]; assert.equal(am.to_email, "u2@example.test"); assert.match(JSON.parse(am.data_json).total, /₹/); ok("the partner is emailed the approval");
  await rej(Q.approve(D1, hq, id1), "CONFLICT"); await rej(Q.reject(D1, hq, id1, "too late"), "CONFLICT"); ok("an approved quotation cannot be approved or rejected again");
  r = await Q.getMine(D1, A[2], id1); assert.equal(r.quote.approvedBy, undefined); assert.match(r.quote.shareText, /^Quotation Q-\d{4}-0001 from Ntagz\nFor: Ravi/); assert.match(r.quote.shareText, /200 × .*black.*₹5,000|200 × .*Black/i); assert.match(r.quote.shareText, /Total: ₹/); assert.match(r.quote.shareText, /Valid until/); ok("the partner gets a ready-to-send summary with the frozen total and validity");
  assert.equal(r.quote.totalPaise, engine([{ id: "black-nfc-card", qty: 200 }], "Maharashtra").amount * 100); ok("the approved total still equals the checkout engine's");

  // ---- sent / customer answer ----
  await rej(Q.markSent(D1, A[2], await (async () => (await Q.createQuote(D1, A[2], { leadId: leadKA, items: items100 }, env)).quote.id)()), "CONFLICT"); ok("only an approved quotation can be marked sent");
  r = await Q.markSent(D1, A[2], id1); assert.equal(r.quote.status, "sent"); assert.ok(r.quote.sentAt); await rej(Q.markSent(D1, A[2], id1), "CONFLICT"); ok("marking it sent is recorded once");
  await rej(Q.recordResponseMine(D1, A[2], id1, "maybe"), "VALIDATION_FAILED"); r = await Q.recordResponseMine(D1, A[2], id1, "accepted"); assert.equal(r.quote.status, "accepted"); assert.ok(r.quote.respondedAt); ok("the customer's answer is recorded");
  assert.ok(one("SELECT COUNT(*) c FROM lead_activities WHERE lead_id = ? AND body LIKE 'Customer accepted quotation%'", leadMH).c === 1); await rej(Q.recordResponseMine(D1, A[2], id1, "declined"), "CONFLICT"); await rej(Q.cancel(D1, A[2], id1), "CONFLICT"); ok("an accepted quotation is final and the lead shows it");
  assert.equal(one("SELECT status FROM leads WHERE id = ?", leadMH).status, "quotation"); ok("accepting does not win the lead: only HQ can, with a real order");

  // ---- cancel, HQ answer, expiry ----
  const idKA = q("SELECT id FROM quotations WHERE lead_id = ?", leadKA)[0].id;
  r = await Q.cancel(D1, A[2], idKA); assert.equal(r.quote.status, "cancelled"); await rej(Q.submit(D1, A[2], idKA, env), "CONFLICT"); ok("a draft can be cancelled, and a cancelled one stays cancelled");
  const idX = (await Q.createQuote(D1, A[2], { leadId: leadNone, items: [{ productId: "anti-metal-tag", qty: 20 }] }, env)).quote.id; await Q.submit(D1, A[2], idX, env); await Q.approve(D1, hq, idX);
  r = await Q.recordResponseHq(D1, hq, idX, "declined"); assert.equal(r.quote.status, "declined"); ok("HQ can also record the customer's answer");
  const idE = (await Q.createQuote(D1, A[3], { leadId: await lead(A[3], "9820000009", "Gujarat"), items: items100 }, env)).quote.id; await Q.submit(D1, A[3], idE, env); await Q.approve(D1, hq, idE);
  sqlite.prepare("UPDATE quotations SET valid_until = unixepoch() - 10 WHERE id = ?").run(idE);
  r = await Q.getMine(D1, A[3], idE); assert.equal(r.quote.status, "expired"); await rej(Q.markSent(D1, A[3], idE), "CONFLICT"); await rej(Q.recordResponseMine(D1, A[3], idE, "accepted"), "CONFLICT"); ok("an approved quotation past its date expires and can no longer be sent or accepted");
  const idP = (await Q.createQuote(D1, A[3], { leadId: await lead(A[3], "9820000010", "Gujarat"), items: items100 }, env)).quote.id; await Q.submit(D1, A[3], idP, env); sqlite.prepare("UPDATE quotations SET valid_until = unixepoch() - 10 WHERE id = ?").run(idP);
  await rej(Q.approve(D1, hq, idP), "CONFLICT"); ok("HQ cannot approve a quotation that has already lapsed");
  const counts = (await Q.listAll(D1, hq)).counts; assert.equal(counts.accepted, 1); assert.equal(counts.declined, 1); assert.equal(counts.expired, 1); ok("HQ counts add up by status");

  // ---- HTTP ----
  const sid = async (uid) => { const tok = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""); const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tok))), (b) => b.toString(16).padStart(2, "0")).join(""); sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at, portal) VALUES (?, ?, unixepoch() + 3600, 'partner')").run(h, uid); return tok; };
  const http = async (p, { method = "GET", body, who } = {}) => { const headers = { origin: "https://partner.test", "x-requested-with": "ntagz" }; if (who) headers.cookie = `__Host-ntagz_partner=${who}`; if (body) headers["content-type"] = "application/json"; const res = await partnerRouter(new Request("https://partner.test" + p, { method, headers, body: body ? JSON.stringify(body) : undefined }), env); return { status: res.status, json: await res.json() }; };
  const t2 = await sid("u2"), t3 = await sid("u3"), t1 = await sid("u1");
  assert.equal((await http("/api/v1/partner/quotes")).status, 401); assert.equal((await http("/api/v1/partner/quotes", { who: t1 })).status, 403); ok("the quotes API needs a session and a partner with the right");
  let h = await http("/api/v1/partner/quote-products", { who: t2 }); assert.ok(h.json.data.length > 5);
  h = await http("/api/v1/partner/quote-price", { method: "POST", who: t2, body: { items: items100, state: "Maharashtra" } }); assert.equal(h.json.data.totals.totalPaise, 354000); ok("catalogue and price-check routes work");
  const leadH = await lead(A[2], "9820000020", "Maharashtra");
  h = await http("/api/v1/partner/quotes", { method: "POST", who: t2, body: { leadId: leadH, items: items100 } }); assert.equal(h.status, 201); const hid = h.json.data.quote.id;
  assert.equal((await http(`/api/v1/partner/quotes/${hid}`, { who: t3 })).status, 404); assert.equal((await http(`/api/v1/partner/quotes/${hid}/submit`, { method: "POST", who: t3 })).status, 404); ok("another partner's quotation id is 404 on every route");
  h = await http(`/api/v1/partner/quotes/${hid}/items`, { method: "POST", who: t2, body: { items: [{ productId: "anti-metal-tag", qty: 30 }] } }); assert.equal(h.json.data.quote.items[0].productId, "anti-metal-tag");
  h = await http(`/api/v1/partner/quotes/${hid}/submit`, { method: "POST", who: t2 }); assert.equal(h.json.data.quote.status, "pending_approval"); ok("edit and submit routes work");
  h = await http("/api/v1/partner/quotes?status=pending_approval", { who: t2 }); assert.equal(h.json.data.items.length, 1); h = await http(`/api/v1/partner/quotes?leadId=${leadH}`, { who: t2 }); assert.equal(h.json.data.items.length, 1); ok("the list filters by status and lead");
  const noCsrf = await partnerRouter(new Request("https://partner.test/api/v1/partner/quotes", { method: "POST", headers: { origin: "https://partner.test", cookie: `__Host-ntagz_partner=${t2}`, "content-type": "application/json" }, body: JSON.stringify({ leadId: leadH, items: items100 }) }), env); assert.equal(noCsrf.status, 403); ok("creating a quotation without the CSRF header is blocked");
  const adm = async (p, method = "GET", body = {}) => { const res = await adminV1(new Request("https://admin.test" + p, { method }), env, "hq@example.test", body); return { status: res.status, json: await res.json() }; };
  h = await adm("/api/v1/admin/quotes?status=pending_approval"); assert.equal(h.json.data.items.length, 2); assert.ok(h.json.data.items.some((i) => i.id === hid)); h = await adm(`/api/v1/admin/quotes/${hid}`); assert.equal(h.json.data.quote.partnerCode, "NTZ-ENT-0001"); assert.equal(h.json.data.quote.items.length, 1);
  assert.equal((await adm(`/api/v1/admin/quotes/${hid}/reject`, "POST", {})).status, 400); h = await adm(`/api/v1/admin/quotes/${hid}/approve`, "POST"); assert.equal(h.json.data.quote.status, "approved"); h = await adm(`/api/v1/admin/quotes/${hid}/response`, "POST", { outcome: "accepted" }); assert.equal(h.json.data.quote.status, "accepted"); ok("HQ routes list, open, validate, approve and record the answer");

  console.log(`all ${n} quotation checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
