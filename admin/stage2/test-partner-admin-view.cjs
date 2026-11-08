// HQ approvals screen backend: stage filters + counts, search (LIKE escaping), detail view (partner, agreement, fee ledger, history), permissions.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeDb, root } = require("./d1shim.cjs");

let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);

(async () => {
  const core = await import(pathToFileURL(path.join(root, "packages/platform-core/src/index.js")).href);
  const review = await import(pathToFileURL(path.join(root, "packages/platform-core/src/review.js")).href);
  const { adminV1, accessForRoles } = core;
  const t = makeDb(); const { D1, sqlite } = t;
  const env = { DB: D1 };
  const get = async (p) => { const r = await adminV1(new Request("https://admin.test" + p), env, "hq@example.test", {}); return { status: r.status, json: await r.json() }; };

  // ---- fixtures ----
  const user = (i) => sqlite.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run("u" + i, `u${i}@example.test`);
  const app = (i, status, biz, city, type = "flex", submitted = 1000 + i) => sqlite.prepare("INSERT INTO partner_applications (id, user_id, type_key, status, business_name, city, state, pincode, pan_last4, form_json, submitted_at) VALUES (?, ?, ?, ?, ?, ?, 'Maharashtra', '411001', '234F', '{\"name\":\"N\",\"phone\":\"9960160016\"}', ?)").run(`00000000-0000-0000-0000-00000000000${i}`, "u" + i, type, status, biz, city, submitted);
  const partner = (i, code, status, type = "flex") => { sqlite.prepare("INSERT INTO partners (id, partner_code, user_id, type_key, status, business_name) VALUES (?, ?, ?, ?, ?, 'x')").run("p" + i, code, "u" + i, type, status); sqlite.prepare("UPDATE partner_applications SET partner_id = ? WHERE user_id = ?").run("p" + i, "u" + i); };
  for (let i = 1; i <= 9; i++) user(i);
  app(1, "submitted", "Alpha Tags", "Pune"); app(2, "under_review", "Beta Cards", "Delhi"); app(3, "documents_required", "Gamma Stands", "Mumbai");
  app(4, "approved", "Delta Onboarding", "Pune"); partner(4, "NTZ-FLX-0001", "agreement_pending"); sqlite.prepare("INSERT INTO partner_agreements (id, partner_id, version, status) VALUES ('ag4', 'p4', 'v1', 'pending')").run();
  app(5, "approved", "Epsilon Active", "Nagpur", "smile"); partner(5, "NTZ-SML-0001", "active", "smile");
  app(6, "approved", "Zeta Suspended", "Surat"); partner(6, "NTZ-FLX-0002", "suspended");
  app(7, "rejected", "Eta Rejected", "Pune");
  app(8, "draft", "Theta Draft", "Pune");
  app(9, "submitted", "Percent% Co", "Pune");
  const A = (qs = "") => get("/api/v1/admin/partner-applications" + qs);

  // ---- counts and stages ----
  let r = await A();
  assert.deepEqual(r.json.data.counts, { new: 2, review: 1, docs: 1, onboarding: 1, active: 1, suspended: 1, rejected: 1 }); ok("counts per stage");
  assert.equal(r.json.data.items.length, 8); assert.ok(!r.json.data.items.some((i) => i.businessName === "Theta Draft")); ok("drafts never appear in HQ's list");
  const names = async (qs) => (await A(qs)).json.data.items.map((i) => i.businessName).sort();
  assert.deepEqual(await names("?stage=new"), ["Alpha Tags", "Percent% Co"]); ok("stage=new");
  assert.deepEqual(await names("?stage=onboarding"), ["Delta Onboarding"]); ok("stage=onboarding is approved applications whose partner is not active yet");
  assert.deepEqual(await names("?stage=active"), ["Epsilon Active"]); assert.deepEqual(await names("?stage=suspended"), ["Zeta Suspended"]); assert.deepEqual(await names("?stage=rejected"), ["Eta Rejected"]); ok("active, suspended and rejected stages");
  r = await A("?stage=new"); assert.equal(r.json.data.counts.active, 1); ok("counts ignore the current filter (chips show the whole queue)");
  assert.equal((await A("?stage=x'%20OR%201=1--")).json.data.items.length, 8); ok("an unknown stage is ignored (no SQL from the request)");
  const row = (await A("?stage=active")).json.data.items[0]; assert.equal(row.partnerCode, "NTZ-SML-0001"); assert.equal(row.partnerStatus, "active"); assert.equal(row.email, "u5@example.test"); ok("rows carry partner code, partner status and applicant email");

  // ---- search ----
  assert.deepEqual(await names("?q=alpha"), ["Alpha Tags"]); ok("search by business name, case-insensitive");
  assert.deepEqual(await names("?q=ntz-flx"), ["Delta Onboarding", "Zeta Suspended"]); ok("search by Partner ID");
  assert.deepEqual(await names("?q=u3@"), ["Gamma Stands"]); ok("search by applicant email");
  assert.deepEqual(await names("?q=nagpur"), ["Epsilon Active"]); ok("search by city");
  assert.deepEqual(await names("?q=%25"), ["Percent% Co"]); ok("a literal % in search matches literally, not as a wildcard");
  assert.deepEqual(await names("?q=_"), []); ok("a literal _ does not match everything");
  assert.deepEqual(await names("?q=pune&stage=new"), ["Alpha Tags", "Percent% Co"]); ok("search combines with stage");
  assert.equal((await A("?q=" + "a".repeat(500))).status, 200); ok("very long search is truncated, not an error");

  // ---- detail ----
  const id4 = "00000000-0000-0000-0000-000000000004";
  let d = (await get(`/api/v1/admin/partner-applications/${id4}`)).json.data;
  assert.equal(d.email, "u4@example.test"); assert.equal(d.partner.partnerCode, "NTZ-FLX-0001"); assert.equal(d.partner.status, "agreement_pending");
  assert.equal(d.partner.feePaise, 2499900); assert.equal(d.partner.agreement.status, "pending"); assert.deepEqual(d.partner.feePayments, []); assert.equal(d.form.phone, "9960160016"); ok("detail includes applicant, partner, fee due, agreement");
  assert.ok(!JSON.stringify(d).includes("pan_hash") && !JSON.stringify(d).includes("r2_key")); ok("detail never exposes the PAN hash or storage keys");
  const hq = await accessForRoles(D1, "hq@example.test", ["hq_admin"]);
  await review.recordAgreementSigned(D1, hq, "p4");
  await review.recordFeePayment(D1, hq, "p4", { amountPaise: 2499900, gstPaise: 381000, method: "upi", reference: "UPI-VIEW-1" });
  d = (await get(`/api/v1/admin/partner-applications/${id4}`)).json.data;
  assert.equal(d.partner.status, "onboarding"); assert.equal(d.partner.agreement.status, "signed"); assert.equal(d.partner.feePayments.length, 1); assert.equal(d.partner.feePayments[0].reference, "UPI-VIEW-1"); assert.equal(d.partner.feePayments[0].recordedBy, "hq@example.test"); ok("detail follows the onboarding steps (agreement signed, fee ledger)");
  assert.ok(d.history.length >= 2 && d.history.every((h) => h.actor && h.at && h.action)); assert.ok(!d.history.some((h) => /^[0-9a-f-]{36}$/.test(h.actor))); const acts = d.history.map((h) => h.action); assert.equal(acts[0], "partner.onboarding"); assert.ok(acts.includes("partner.fee.record") && acts.includes("partner.payment_pending")); assert.ok(acts.indexOf("partner.onboarding") < acts.indexOf("partner.payment_pending")); ok("history lists who did what, newest first");
  assert.equal((await get(`/api/v1/admin/partner-applications/00000000-0000-0000-0000-000000000008`)).status, 404); ok("a draft cannot be opened by HQ");
  assert.equal((await get(`/api/v1/admin/partner-applications/00000000-0000-0000-0000-0000000000ff`)).status, 404); ok("unknown id -> 404");

  // ---- permissions ----
  const ops = await accessForRoles(D1, "o@example.test", ["operations"]);
  assert.equal((await review.listApplications(D1, ops)).items.length, 8); ok("Operations can see the queue");
  const fin = await accessForRoles(D1, "f@example.test", ["finance"]);
  await assert.rejects(() => review.listApplications(D1, fin), (e) => e.code === "FORBIDDEN"); await assert.rejects(() => review.getApplication(D1, fin, id4), (e) => e.code === "FORBIDDEN"); ok("Finance cannot open applications");
  const reg = await accessForRoles(D1, "r@example.test", ["regional"]);
  assert.deepEqual((await review.listApplications(D1, reg)).items, []); await assert.rejects(() => review.getApplication(D1, reg, id4), (e) => e.code === "NOT_FOUND"); ok("Regional sees nothing until a PIN-to-region map exists (fails closed)");

  console.log(`all ${n} partner admin view checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
