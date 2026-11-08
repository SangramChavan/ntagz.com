// Leads: ownership isolation, one-open-lead-per-phone, status rules, HQ oversight, reassignment, permissions (incl. region fails closed), HTTP routes.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeDb, root } = require("./d1shim.cjs");

let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const rej = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);

(async () => {
  const imp = (f) => import(pathToFileURL(path.join(root, "packages/platform-core/src", f)).href);
  const core = await imp("index.js"), L = await imp("leads.js");
  const { loadAccess, accessForRoles, partnerRouter, adminV1 } = core;
  const t = makeDb(); const { D1, sqlite, q, one } = t;

  // ---- fixtures: partners of different tiers and states ----
  const mkPartner = (i, type, role, status, code) => {
    sqlite.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run("u" + i, `u${i}@example.test`);
    sqlite.prepare("INSERT INTO user_roles (id, user_id, role_key, granted_by) VALUES (?, ?, ?, 'test')").run(crypto.randomUUID(), "u" + i, role);
    sqlite.prepare("INSERT INTO partners (id, partner_code, user_id, type_key, status, business_name) VALUES (?, ?, ?, ?, ?, ?)").run("p" + i, code, "u" + i, type, status, `Biz ${code}`);
  };
  mkPartner(1, "flex", "partner_flex", "active", "NTZ-FLX-0001");
  mkPartner(2, "enterprise", "partner_enterprise", "active", "NTZ-ENT-0001");
  mkPartner(3, "smile", "partner_smile", "active", "NTZ-SML-0001");      // Smile has no leads permission
  mkPartner(4, "flex", "partner_flex", "onboarding", "NTZ-FLX-0002");    // not active yet
  mkPartner(5, "smile_plus", "partner_smile_plus", "active", "NTZ-SMP-0001");
  const A = {}; for (const i of [1, 2, 3, 4, 5]) A[i] = await loadAccess(D1, "u" + i);
  const hq = await accessForRoles(D1, "hq@example.test", ["hq_admin"]);
  const ops = await accessForRoles(D1, "ops@example.test", ["operations"]);
  const reg = await accessForRoles(D1, "reg@example.test", ["regional"]);
  const fin = await accessForRoles(D1, "fin@example.test", ["finance"]);
  const input = (o = {}) => ({ businessName: "Cafe Aroma", contactName: "Ravi Shah", phone: "+91 98200 12345", email: "Ravi@Example.Test", city: "Pune", state: "Maharashtra", pincode: "411001", interest: "100 NFC review stands", estQuantity: 100, notes: "met at the shop", ...o });

  // ---- create ----
  let r = await L.createLead(D1, A[1], input());
  const id1 = r.lead.id;
  assert.equal(r.lead.status, "new"); assert.equal(r.lead.phone, "9820012345"); assert.equal(r.lead.email, "ravi@example.test"); assert.equal(r.lead.estQuantity, 100); ok("a partner registers a lead; phone and email are normalised");
  assert.ok(!("partnerId" in r.lead) && !("orderId" in r.lead) && !("source" in r.lead)); ok("the partner's own view carries no internal ownership or order fields");
  assert.equal(r.activities.length, 1); assert.equal(r.activities[0].kind, "created"); assert.equal(one("SELECT COUNT(*) c FROM audit_log WHERE action='lead.create' AND entity_id = ?", id1).c, 1); ok("creation writes an activity and an audit row");

  // ---- validation ----
  await rej(L.createLead(D1, A[1], {}), "VALIDATION_FAILED");
  const bad = async (o) => { try { await L.createLead(D1, A[1], input({ phone: "9876501234", ...o })); } catch (e) { return e; } };
  assert.equal((await bad({ businessName: "" })).fields.businessName, "required"); assert.ok((await bad({ phone: "123" })).fields.phone);
  assert.ok((await bad({ email: "nope" })).fields.email); assert.ok((await bad({ pincode: "12" })).fields.pincode);
  assert.ok((await bad({ estQuantity: 0 })).fields.estQuantity); assert.ok((await bad({ estQuantity: 2.5 })).fields.estQuantity); assert.ok((await bad({ estQuantity: 1e9 })).fields.estQuantity); ok("missing/invalid business, phone, email, PIN and quantity are refused field by field");
  const longOne = await L.createLead(D1, A[1], input({ phone: "9876501234", businessName: "x".repeat(400), notes: "n".repeat(5000) }));
  assert.equal(longOne.lead.businessName.length, 160); assert.equal(longOne.lead.notes.length, 1000); ok("over-long text is truncated, not stored whole");
  assert.equal(one("SELECT COUNT(*) c FROM leads").c, 2); ok("a refused lead leaves nothing behind");

  // ---- one open lead per phone across the network ----
  const sameP = await L.createLead(D1, A[1], input()).catch((e) => e);
  assert.equal(sameP.code, "CONFLICT"); assert.equal(sameP.fields.phone, "already in your leads"); ok("the same partner registering the number twice is told it is theirs");
  const other = await L.createLead(D1, A[2], input({ businessName: "Cafe Aroma (second)" })).catch((e) => e);
  assert.equal(other.code, "CONFLICT"); assert.equal(other.message, "This contact is already registered with Ntagz");
  assert.ok(!JSON.stringify(other).includes("NTZ-FLX-0001") && !JSON.stringify(other).includes("Biz ") && !JSON.stringify(other).includes("p1")); ok("another partner is refused without learning who owns the number");
  const conf = one("SELECT * FROM audit_log WHERE action='lead.conflict'"); const cd = JSON.parse(conf.detail).after;
  assert.equal(conf.entity_id, id1); assert.equal(cd.attemptedByPartner, "p2"); assert.equal(cd.phoneLast4, "2345"); assert.ok(!conf.detail.includes("9820012345")); ok("HQ can see the attempt in the audit log (without the full number)");
  assert.equal((await L.listMine(D1, A[2])).items.length, 0); ok("the refused lead was not created for the second partner");

  // ---- isolation ----
  await rej(L.getMine(D1, A[2], id1), "NOT_FOUND"); await rej(L.addActivityMine(D1, A[2], id1, { kind: "note", body: "x" }), "NOT_FOUND"); await rej(L.setStatusMine(D1, A[2], id1, { status: "contacted" }), "NOT_FOUND"); ok("another partner cannot read, annotate or change a lead (it is simply not found)");
  const l1 = await L.listMine(D1, A[1]); assert.equal(l1.items.length, 2); assert.equal(l1.counts.new, 2); assert.deepEqual((await L.listMine(D1, A[2])).counts, { new: 0, contacted: 0, qualified: 0, quotation: 0, won: 0, lost: 0 }); ok("lists and counts only ever cover the caller's own leads");

  // ---- who may use leads at all ----
  await rej(L.createLead(D1, A[3], input({ phone: "9000000001" })), "FORBIDDEN"); await rej(L.listMine(D1, A[3]), "FORBIDDEN"); ok("a Smile partner (no lead rights) is refused");
  await rej(L.createLead(D1, A[4], input({ phone: "9000000002" })), "FORBIDDEN"); ok("a partner who is not active yet is refused");
  assert.equal((await L.createLead(D1, A[5], input({ phone: "9000000003", businessName: "Walk-in Salon" }))).lead.status, "new"); ok("a Smile+ field associate can register leads");
  await rej(L.listMine(D1, hq), "FORBIDDEN"); ok("HQ staff have no 'own leads' view (they use the HQ list)");

  // ---- activities ----
  r = await L.addActivityMine(D1, A[1], id1, { kind: "call", body: "Called, wants a demo" }); await L.addActivityMine(D1, A[1], id1, { kind: "visit", body: "Visited Tuesday" });
  r = await L.getMine(D1, A[1], id1); assert.deepEqual(r.activities.map((a) => a.kind), ["visit", "call", "created"]); assert.equal(r.activities[0].by, "You"); ok("call and visit notes are logged, newest first");
  await rej(L.addActivityMine(D1, A[1], id1, { kind: "email", body: "x" }), "VALIDATION_FAILED"); await rej(L.addActivityMine(D1, A[1], id1, { kind: "note", body: "   " }), "VALIDATION_FAILED"); ok("unknown activity kinds and empty notes are refused");

  // ---- partner status rules ----
  r = await L.setStatusMine(D1, A[1], id1, { status: "contacted" }); assert.equal(r.lead.status, "contacted");
  await rej(L.setStatusMine(D1, A[1], id1, { status: "won" }), "CONFLICT"); await rej(L.setStatusMine(D1, A[1], id1, { status: "quotation" }), "CONFLICT"); ok("a partner can never mark a lead won or in quotation");
  await rej(L.setStatusMine(D1, A[1], id1, { status: "new" }), "CONFLICT"); ok("status cannot go backwards");
  r = await L.setStatusMine(D1, A[1], id1, { status: "qualified" }); assert.equal(r.lead.status, "qualified");
  const e1 = await L.setStatusMine(D1, A[1], id1, { status: "lost", reason: "x" }).catch((e) => e); assert.equal(e1.code, "VALIDATION_FAILED"); ok("losing a lead needs a real reason");
  r = await L.setStatusMine(D1, A[1], id1, { status: "lost", reason: "Went with a local vendor" });
  assert.equal(r.lead.status, "lost"); assert.equal(r.lead.lostReason, "Went with a local vendor"); assert.ok(r.lead.closedAt); ok("a lead can be closed as lost with the reason kept");
  await rej(L.setStatusMine(D1, A[1], id1, { status: "contacted" }), "CONFLICT"); ok("a closed lead cannot be reopened by the partner");
  r = await L.createLead(D1, A[2], input({ businessName: "Cafe Aroma (second try)" })); assert.equal(r.lead.status, "new"); ok("once a lead is lost its number is free for any partner again");
  const id2 = r.lead.id;

  // ---- HQ oversight ----
  let all = await L.listAll(D1, hq);
  assert.equal(all.items.length, 4); assert.ok(all.items.every((i) => i.partnerCode && i.partnerBusiness)); ok("HQ sees every partner's leads with the partner named");
  assert.deepEqual(all.counts, { new: 3, contacted: 0, qualified: 0, quotation: 0, won: 0, lost: 1 }); ok("HQ counts cover the whole network");
  assert.equal((await L.listAll(D1, hq, { status: "lost" })).items.length, 1); assert.equal((await L.listAll(D1, hq, { partnerId: "p2" })).items.length, 1);
  assert.equal((await L.listAll(D1, hq, { q: "ntz-smp" })).items.length, 1); assert.equal((await L.listAll(D1, hq, { q: "walk-in" })).items.length, 1); assert.equal((await L.listAll(D1, hq, { q: "%" })).items.length, 0); ok("HQ can filter by status and partner and search (wildcards are literal)");
  assert.equal((await L.listAll(D1, ops)).items.length, 4); ok("Operations can see all leads");
  await rej(L.listAll(D1, fin), "FORBIDDEN"); await rej(L.listAll(D1, A[1]), "FORBIDDEN"); ok("Finance and partners cannot use the HQ list");
  assert.deepEqual((await L.listAll(D1, reg)).items, []); await rej(L.getAny(D1, reg, id1), "NOT_FOUND"); ok("a Regional Manager sees nothing until a PIN-to-region map exists (fails closed)");
  const det = await L.getAny(D1, hq, id1); assert.equal(det.lead.partnerCode, "NTZ-FLX-0001"); assert.equal(det.conflicts.length, 1); assert.equal(det.conflicts[0].attemptedByPartner, "p2"); ok("HQ detail shows the partner and any ownership conflicts");

  // ---- HQ reassign ----
  await rej(L.assign(D1, reg, id2, "p1"), "NOT_FOUND"); await rej(L.assign(D1, fin, id2, "p1"), "FORBIDDEN"); await rej(L.assign(D1, A[2], id2, "p1"), "FORBIDDEN"); ok("only HQ and Operations can reassign (region scope fails closed)");
  await rej(L.assign(D1, hq, id2, "p2"), "CONFLICT"); await rej(L.assign(D1, hq, id2, "p4"), "VALIDATION_FAILED"); await rej(L.assign(D1, hq, id2, "p-nope"), "VALIDATION_FAILED"); await rej(L.assign(D1, hq, id1, "p2"), "CONFLICT"); ok("reassigning to the same, an inactive or unknown partner, or a closed lead is refused");
  r = await L.assign(D1, ops, id2, "p5"); assert.equal(r.lead.partnerCode, "NTZ-SMP-0001"); assert.match(r.activities[0].body, /NTZ-ENT-0001 to NTZ-SMP-0001/); ok("Operations reassign a lead; the move is recorded");
  await rej(L.getMine(D1, A[2], id2), "NOT_FOUND"); assert.equal((await L.getMine(D1, A[5], id2)).lead.id, id2); ok("the old partner loses access at once; the new partner gets it");
  assert.equal(one("SELECT COUNT(*) c FROM audit_log WHERE action='lead.assign' AND entity_id = ?", id2).c, 1); ok("reassignment is audited");

  // ---- HQ status: quotation / won (needs a real order) / lost ----
  r = await L.setStatusHq(D1, hq, id2, { status: "quotation" }); assert.equal(r.lead.status, "quotation"); assert.equal((await L.getMine(D1, A[5], id2)).lead.status, "quotation"); ok("HQ can move a lead to quotation, and the partner sees it");
  await rej(L.setStatusHq(D1, hq, id2, { status: "won" }), "VALIDATION_FAILED"); await rej(L.setStatusHq(D1, hq, id2, { status: "won", orderId: "no-such-order" }), "VALIDATION_FAILED"); ok("won needs an order that exists");
  sqlite.prepare("INSERT INTO orders (id, txn_id, gateway, status, total) VALUES ('order-1', 'txn-1', 'razorpay', 'confirmed', 100000)").run();
  sqlite.prepare("INSERT INTO orders (id, txn_id, gateway, status, total) VALUES ('order-2', 'txn-2', 'razorpay', 'confirmed', 50000)").run();
  r = await L.setStatusHq(D1, hq, id2, { status: "won", orderId: "order-1" }); assert.equal(r.lead.status, "won"); assert.equal(r.lead.orderId, "order-1"); assert.ok(r.lead.closedAt); ok("HQ marks a lead won with its order");
  const mine = await L.getMine(D1, A[5], id2); assert.equal(mine.lead.status, "won"); assert.ok(!("orderId" in mine.lead)); ok("the partner sees 'won' but not the customer's order");
  await rej(L.setStatusHq(D1, hq, id2, { status: "lost", reason: "oops" }), "CONFLICT"); await rej(L.setStatusMine(D1, A[5], id2, { status: "lost", reason: "oops too" }), "CONFLICT"); ok("a won lead is final");
  const third = await L.createLead(D1, A[1], input({ phone: "9000000009", businessName: "Third Co" }));
  await rej(L.setStatusHq(D1, hq, third.lead.id, { status: "won", orderId: "order-1" }), "CONFLICT"); ok("an order can be credited to one lead only (no double attribution)");
  await rej(L.setStatusHq(D1, hq, third.lead.id, { status: "lost" }), "VALIDATION_FAILED"); r = await L.setStatusHq(D1, hq, third.lead.id, { status: "lost", reason: "Customer unreachable" }); assert.equal(r.lead.status, "lost"); ok("HQ can close a lead as lost with a reason");
  r = await L.addNoteHq(D1, hq, id1, "Spoke to the owner; partner follow-up was late"); assert.equal(r.activities[0].by, "hq@example.test"); assert.equal((await L.getMine(D1, A[1], id1)).activities[0].by, "Ntagz"); ok("HQ notes are shown to the partner as coming from Ntagz (admin email stays private)");

  // ---- HTTP routes ----
  const env = { DB: D1 }; const ORIGIN = "https://partner.test";
  const sid = async (uid) => { const tok = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""); const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tok))), (b) => b.toString(16).padStart(2, "0")).join(""); sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at, portal) VALUES (?, ?, unixepoch() + 3600, 'partner')").run(h, uid); return tok; };
  const http = async (p, { method = "GET", body, who } = {}) => {
    const headers = { origin: ORIGIN, "x-requested-with": "ntagz" }; if (who) headers.cookie = `__Host-ntagz_partner=${who}`; if (body) headers["content-type"] = "application/json";
    const res = await partnerRouter(new Request(ORIGIN + p, { method, headers, body: body ? JSON.stringify(body) : undefined }), env); return { status: res.status, json: await res.json() };
  };
  const t1 = await sid("u1"), t2 = await sid("u2");
  assert.equal((await http("/api/v1/partner/leads")).status, 401); ok("the leads API needs a signed-in session");
  let h = await http("/api/v1/partner/leads", { method: "POST", who: t1, body: input({ phone: "9111111111", businessName: "HTTP Co" }) }); assert.equal(h.status, 201); const hid = h.json.data.lead.id; ok("POST /partner/leads creates (201)");
  h = await http("/api/v1/partner/leads?q=http", { who: t1 }); assert.equal(h.json.data.items.length, 1); assert.equal((await http("/api/v1/partner/leads", { who: t2 })).json.data.items.length, 0); ok("GET /partner/leads is scoped to the session's partner");
  assert.equal((await http(`/api/v1/partner/leads/${hid}`, { who: t2 })).status, 404); assert.equal((await http(`/api/v1/partner/leads/${hid}/status`, { method: "POST", who: t2, body: { status: "contacted" } })).status, 404); ok("another partner's lead id is 404 on every route");
  h = await http(`/api/v1/partner/leads/${hid}/status`, { method: "POST", who: t1, body: { status: "contacted" } }); assert.equal(h.json.data.lead.status, "contacted");
  h = await http(`/api/v1/partner/leads/${hid}/activity`, { method: "POST", who: t1, body: { kind: "note", body: "left a brochure" } }); assert.equal(h.json.data.activities[0].body, "left a brochure"); ok("status and activity routes work");
  h = await http("/api/v1/partner/leads", { method: "POST", who: t2, body: input({ phone: "9111111111" }) }); assert.equal(h.status, 409); assert.equal(h.json.error.message, "This contact is already registered with Ntagz"); ok("the duplicate-owner rule holds over HTTP");
  const noCsrf = await partnerRouter(new Request(ORIGIN + "/api/v1/partner/leads", { method: "POST", headers: { origin: ORIGIN, cookie: `__Host-ntagz_partner=${t1}`, "content-type": "application/json" }, body: JSON.stringify(input({ phone: "9222222222" })) }), env); assert.equal(noCsrf.status, 403); ok("creating a lead without the CSRF header is blocked");
  const adm = async (p, method = "GET", body = {}, who = "hq@example.test") => { const res = await adminV1(new Request("https://admin.test" + p, { method }), env, who, body); return { status: res.status, json: await res.json() }; };
  h = await adm("/api/v1/admin/leads"); assert.ok(h.json.data.items.length >= 6); h = await adm(`/api/v1/admin/leads/${hid}`); assert.equal(h.json.data.lead.partnerCode, "NTZ-FLX-0001"); ok("HQ routes list and open leads");
  h = await adm("/api/v1/admin/active-partners"); assert.deepEqual(h.json.data.map((p) => p.partnerCode), ["NTZ-ENT-0001", "NTZ-FLX-0001", "NTZ-SML-0001", "NTZ-SMP-0001"]); ok("the reassignment list shows only active partners");
  h = await adm(`/api/v1/admin/leads/${hid}/assign`, "POST", { partnerId: "p2" }); assert.equal(h.json.data.lead.partnerCode, "NTZ-ENT-0001"); h = await adm(`/api/v1/admin/leads/${hid}/note`, "POST", { body: "moved to Enterprise" }); assert.equal(h.status, 200);
  h = await adm(`/api/v1/admin/leads/${hid}/status`, "POST", { status: "lost" }); assert.equal(h.status, 400); ok("HQ assign, note and status routes work and validate");

  console.log(`all ${n} leads checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
