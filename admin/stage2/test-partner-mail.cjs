// Partner emails: templates (escaping, no injection, honest copy), transactional outbox (atomic, deduped), sending (retry, backoff, claim, skip),
// and isolation (an email problem can never fail or roll back an approval).
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeDb, root } = require("./d1shim.cjs");

let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const pdf = () => new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");

(async () => {
  const imp = (f) => import(pathToFileURL(path.join(root, "packages/platform-core/src", f)).href);
  const core = await imp("index.js"), mail = await imp("mail.js"), apps = await imp("applications.js"), review = await imp("review.js");
  const { loadAccess, accessForRoles, adminV1 } = core;
  const t = makeDb(); const { D1, sqlite, q, one } = t;
  const store = new Map(); const KYC = { async put(k, v) { store.set(k, v); }, async get(k) { return store.has(k) ? { body: store.get(k) } : null; } };
  const baseEnv = { DB: D1, KYC, PAN_HASH_SECRET: "s", HQ_NOTIFY_EMAILS: "hq1@example.test, not-an-email ,hq2@example.test" };
  const rows = (where = "1=1", ...a) => q(`SELECT * FROM email_outbox WHERE ${where} ORDER BY created_at, rowid`, ...a);
  const hq = await accessForRoles(D1, "hq@example.test", ["hq_admin"]);

  // ================= templates =================
  const nasty = '<script>alert(1)</script> "quoted" & \'x\'';
  for (const tpl of mail.TEMPLATES) {
    const m = mail.render(tpl, { name: nasty, businessName: nasty, note: nasty, partnerCode: "NTZ-FLX-0001", typeKey: "flex", city: "Pune", state: "MH" }, {});
    assert.ok(m.subject && m.text && m.html, tpl); assert.ok(!/<script/i.test(m.html), tpl + " html"); assert.ok(!/[\r\n]/.test(m.subject), tpl + " subject");
  }
  ok(`all ${mail.TEMPLATES.length} templates render and HTML-escape applicant-supplied text`);
  const inj = mail.render("hq_new_application", { businessName: "Evil\r\nBcc: attacker@example.test", typeKey: "flex" }, {});
  assert.ok(!/[\r\n]/.test(inj.subject)); ok("a line break in a business name cannot inject email headers into the subject");
  assert.equal(mail.render("application_approved", { partnerCode: "NTZ-FLX-0001" }, {}).text.includes("NTZ-FLX-0001"), true);
  assert.match(mail.render("application_received", {}, {}).text, /https:\/\/partner\.ntagz\.com\/status/);
  assert.match(mail.render("hq_new_application", { typeKey: "flex" }, {}).text, /https:\/\/admin\.ntagz\.com\/#\/partners/); ok("links default to the real hosts");
  assert.match(mail.render("application_received", {}, { PARTNER_URL: "http://evil.test" }).text, /https:\/\/partner\.ntagz\.com/); ok("a non-https base URL in config is ignored");
  assert.match(mail.render("application_received", {}, { PARTNER_URL: "https://staging.partner.example/" }).text, /https:\/\/staging\.partner\.example\/status/); ok("a staging base URL is honoured");
  const all = mail.TEMPLATES.map((k) => mail.render(k, { name: "A", businessName: "B", note: "ok note", partnerCode: "X", typeKey: "flex" }, {}).text).join("\n").toLowerCase();
  assert.ok(!/guarantee|earn |income|profit|commission|recruit/.test(all.replace(/no income/g, ""))); ok("no income, profit or recruitment claims in any message");
  assert.throws(() => mail.render("nope", {}, {}), /unknown template/); ok("unknown template is refused");

  // ================= outbox basics =================
  await D1.batch([mail.queueEmail(D1, { to: "A@Example.Test", template: "application_received", data: { name: "A" }, dedupeKey: "k1" }), mail.queueEmail(D1, { to: "a@example.test", template: "application_received", data: { name: "A" }, dedupeKey: "k1" })]);
  assert.equal(rows("dedupe_key='k1'").length, 1); assert.equal(rows("dedupe_key='k1'")[0].to_email, "a@example.test"); ok("same dedupe key queues once; address is normalised");
  await D1.batch([mail.queueEmail(D1, { to: "not an address", template: "application_received", data: {}, dedupeKey: "k2" })]);
  assert.equal(rows("dedupe_key='k2'")[0].status, "skipped"); ok("an invalid recipient is recorded as skipped, not sent");
  assert.throws(() => mail.queueEmail(D1, { to: "a@example.test", template: "bogus", dedupeKey: "k3" }), /unknown template/); ok("queueing an unknown template fails loudly");
  assert.deepEqual(mail.hqRecipients(baseEnv), ["hq1@example.test", "hq2@example.test"]); assert.deepEqual(mail.hqRecipients({}), []); ok("HQ recipients: trimmed, validated, optional");
  sqlite.exec("DELETE FROM email_outbox");

  // ================= events queue the right mail, atomically =================
  const user = (id) => sqlite.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(id, `${id}@example.test`);
  const customer = async (id) => { user(id); sqlite.prepare("INSERT INTO user_roles (id, user_id, role_key, granted_by) VALUES (?, ?, 'customer', 'test')").run(crypto.randomUUID(), id); return loadAccess(D1, id); };
  const apply = async (id, type, biz, pan) => {
    const acc = await customer(id);
    await apps.saveDraft(D1, acc, { typeKey: type, businessName: biz, city: "Pune", state: "Maharashtra", pincode: "411001", pan, form: { name: "Asha <b>Patil</b>", phone: "9960160016", business_type: "Retail", investment_capacity: "1l_to_3l" } }, baseEnv);
    await apps.addDocument(D1, KYC, acc, { docType: "pan", bytes: png() }); await apps.addDocument(D1, KYC, acc, { docType: "address_proof", bytes: pdf() });
    return acc;
  };
  const acc1 = await apply("u1", "flex", "Alpha & Sons", "ABCDE1234F");
  assert.equal(rows().length, 0); ok("saving a draft sends nothing");
  await apps.submit(D1, acc1, baseEnv);
  let r = rows(); assert.deepEqual(r.map((x) => x.template).sort(), ["application_received", "hq_new_application", "hq_new_application"]); ok("submit queues a receipt for the applicant and a notice for each valid HQ address");
  const rec = r.find((x) => x.template === "application_received"); assert.equal(rec.to_email, "u1@example.test"); assert.equal(JSON.parse(rec.data_json).name, "Asha <b>Patil</b>"); ok("receipt goes to the applicant with their own details");
  assert.ok(!/pan|hash|ABCDE1234F|1234F/i.test(r.map((x) => x.data_json).join())); ok("no PAN or ID data in any outbox row");
  const appId = one("SELECT id FROM partner_applications WHERE user_id='u1'").id;
  await assert.rejects(() => apps.submit(D1, acc1, baseEnv), (e) => e.code === "CONFLICT"); assert.equal(rows("template='application_received'").length, 1); ok("a repeated submit is refused and queues no second email");

  await review.startReview(D1, hq, appId);
  await review.requestDocuments(D1, hq, appId, "Please add a GST certificate");
  r = rows("template='documents_requested'"); assert.equal(r.length, 1); assert.equal(r[0].to_email, "u1@example.test"); assert.equal(JSON.parse(r[0].data_json).note, "Please add a GST certificate"); ok("requesting documents emails the applicant the note");
  await apps.submit(D1, acc1, baseEnv);
  assert.equal(rows("template='application_received'").length, 2); assert.equal(rows("template='hq_new_application'").length, 4); assert.ok(rows("template='hq_new_application'").some((x) => JSON.parse(x.data_json).resubmitted)); ok("resubmitting queues a new receipt and an 'updated application' notice");
  await review.startReview(D1, hq, appId); await review.requestDocuments(D1, hq, appId, "Please add a shop photo");
  assert.equal(rows("template='documents_requested'").length, 2); ok("a second, genuine request is a new email (not swallowed by dedupe)");
  await apps.submit(D1, acc1, baseEnv); await review.startReview(D1, hq, appId);

  const before = rows().length;
  const acc2 = await apply("u2", "flex", "Clone Co", "ABCDE1234F"); await apps.submit(D1, acc2, baseEnv);
  const app2 = one("SELECT id FROM partner_applications WHERE user_id='u2'").id; await review.startReview(D1, hq, app2);
  const approvedBefore = rows("template='application_approved'").length;
  const first = await review.approve(D1, hq, appId, {});
  assert.equal(first.partnerCode, "NTZ-FLX-0001"); const ap = rows("template='application_approved'"); assert.equal(ap.length, 1); assert.deepEqual(JSON.parse(ap[0].data_json).partnerCode, "NTZ-FLX-0001"); ok("approval emails the Partner ID");
  const outboxCount = rows().length;
  await assert.rejects(() => review.approve(D1, hq, app2, {}), (e) => e.code === "CONFLICT");
  assert.equal(rows().length, outboxCount); ok("a refused approval (duplicate PAN) leaves no email behind (atomic)");
  await review.reject(D1, hq, app2, "Duplicate PAN with an existing partner");
  assert.equal(rows("template='application_rejected'").length, 1); assert.equal(rows("template='application_rejected'")[0].to_email, "u2@example.test"); ok("rejection emails the reason to the applicant");

  const pid = first.partnerId;
  await review.recordAgreementSigned(D1, hq, pid); await review.recordFeePayment(D1, hq, pid, { amountPaise: 2499900, method: "upi", reference: "UPI-MAIL-1" });
  const quiet = rows().length; assert.equal(rows("template IN ('partner_activated','partner_suspended')").length, 0); ok("internal steps (agreement, fee) send nothing");
  await review.activate(D1, hq, pid);
  assert.equal(rows("template='partner_activated'").length, 1); assert.equal(rows("template='partner_activated'")[0].to_email, "u1@example.test"); ok("activation emails the partner");
  await review.suspend(D1, hq, pid, "Policy breach under review");
  assert.equal(JSON.parse(rows("template='partner_suspended'")[0].data_json).note, "Policy breach under review"); ok("suspension emails the reason");
  await review.reinstate(D1, hq, pid); assert.equal(rows("template='partner_reinstated'").length, 1); ok("reinstating emails the partner");
  assert.ok(rows().every((x) => x.to_email.includes("@"))); ok("every queued row has a recipient");

  // ================= sending =================
  sqlite.exec("UPDATE email_outbox SET status='sent'"); sqlite.exec("DELETE FROM email_outbox");
  await D1.batch([mail.queueEmail(D1, { to: "x@example.test", template: "partner_activated", data: { name: "X", partnerCode: "NTZ-FLX-0009" }, dedupeKey: "s1" })]);
  const calls = [];
  const okFetch = async (url, init) => { calls.push({ url, init }); return new Response('{"id":"1"}', { status: 200 }); };
  const rid = rows()[0].id;
  let res = await mail.flushOutbox({ DB: D1, RESEND_API_KEY: "re_test" }, { fetchFn: okFetch });
  assert.deepEqual(res, { sent: 1, retried: 0, failed: 0, skipped: 0 }); assert.equal(rows()[0].status, "sent"); assert.ok(rows()[0].sent_at); ok("a due email is sent and marked sent");
  assert.equal(calls[0].url, "https://api.resend.com/emails"); assert.equal(calls[0].init.headers.Authorization, "Bearer re_test"); assert.equal(calls[0].init.headers["Idempotency-Key"], rid); ok("sent via the provider with an idempotency key (a timed-out retry cannot double send)");
  const body = JSON.parse(calls[0].init.body); assert.deepEqual(body.to, ["x@example.test"]); assert.equal(body.subject, "Your Ntagz partner account is active"); assert.match(body.text, /NTZ-FLX-0009/); assert.ok(body.from.includes("hello@ntagz.com")); ok("message has recipient, subject, text and html");
  await mail.flushOutbox({ DB: D1, RESEND_API_KEY: "re_test" }, { fetchFn: okFetch }); assert.equal(calls.length, 1); ok("a sent email is never sent again");

  const mk = async (key) => { await D1.batch([mail.queueEmail(D1, { to: "y@example.test", template: "partner_reinstated", data: { partnerCode: "P" }, dedupeKey: key })]); return rows("dedupe_key=?", key)[0].id; };
  const get = (id) => one("SELECT * FROM email_outbox WHERE id = ?", id);
  const fail500 = async () => new Response("secret-ish provider body", { status: 500 });
  let id = await mk("r1");
  res = await mail.flushOutbox({ DB: D1, RESEND_API_KEY: "k" }, { fetchFn: fail500 });
  assert.equal(res.retried, 1); let row = get(id); assert.equal(row.status, "pending"); assert.equal(row.attempts, 1); assert.ok(row.next_attempt_at >= Math.floor(Date.now() / 1000) + 50); assert.equal(row.last_error, "email provider answered 500"); ok("a provider error is retried later with backoff, and only a short reason is stored");
  assert.ok(!JSON.stringify(row).includes("secret-ish")); ok("the provider's response body is never stored");
  let c = 0; await mail.flushOutbox({ DB: D1, RESEND_API_KEY: "k" }, { fetchFn: async () => { c++; return new Response("{}", { status: 200 }); } }); assert.equal(c, 0); ok("a message waiting for its retry time is not sent early");
  sqlite.prepare("UPDATE email_outbox SET next_attempt_at = 0 WHERE id = ?").run(id);
  await mail.flushOutbox({ DB: D1, RESEND_API_KEY: "k" }, { fetchFn: okFetch }); assert.equal(get(id).status, "sent"); assert.equal(get(id).attempts, 2); ok("the retry succeeds once due");

  id = await mk("r2");
  await mail.flushOutbox({ DB: D1, RESEND_API_KEY: "k" }, { fetchFn: async () => new Response("bad", { status: 422 }) });
  assert.equal(get(id).status, "failed"); assert.equal(get(id).attempts, 1); ok("a rejected request (4xx) fails at once, no pointless retries");
  id = await mk("r3");
  await mail.flushOutbox({ DB: D1, RESEND_API_KEY: "k" }, { fetchFn: async () => new Response("slow down", { status: 429 }) }); assert.equal(get(id).status, "pending"); ok("rate limiting (429) is retried");
  id = await mk("r4");
  await mail.flushOutbox({ DB: D1, RESEND_API_KEY: "k" }, { fetchFn: async () => { throw new Error("socket hang up secret"); } });
  row = get(id); assert.equal(row.status, "pending"); assert.equal(row.last_error, "email provider unreachable"); assert.ok(!row.last_error.includes("secret")); ok("a network error is retried and not leaked");
  for (let i = 0; i < 6; i++) { sqlite.prepare("UPDATE email_outbox SET next_attempt_at = 0 WHERE id = ? AND status='pending'").run(id); await mail.flushOutbox({ DB: D1, RESEND_API_KEY: "k" }, { fetchFn: fail500 }); }
  row = get(id); assert.equal(row.status, "failed"); assert.equal(row.attempts, 5); ok("after 5 attempts a message is marked failed for good");

  id = await mk("r5"); let hits = 0;
  const slow = async () => { hits++; await new Promise((r) => setTimeout(r, 40)); return new Response("{}", { status: 200 }); };
  await Promise.all([mail.flushOutbox({ DB: D1, RESEND_API_KEY: "k" }, { fetchFn: slow }), mail.flushOutbox({ DB: D1, RESEND_API_KEY: "k" }, { fetchFn: slow })]);
  assert.equal(hits, 1); assert.equal(get(id).status, "sent"); ok("two senders at once send a message exactly once (atomic claim)");
  id = await mk("r6"); sqlite.prepare("UPDATE email_outbox SET status='sending', attempts=1, next_attempt_at = unixepoch() + 200 WHERE id = ?").run(id);
  hits = 0; await mail.flushOutbox({ DB: D1, RESEND_API_KEY: "k" }, { fetchFn: slow }); assert.equal(hits, 0); ok("a message another sender is still working on is left alone");
  sqlite.prepare("UPDATE email_outbox SET next_attempt_at = unixepoch() - 1 WHERE id = ?").run(id);
  await mail.flushOutbox({ DB: D1, RESEND_API_KEY: "k" }, { fetchFn: slow }); assert.equal(hits, 1); assert.equal(get(id).status, "sent"); ok("a crashed sender's claim expires and the message is sent");
  id = await mk("r7"); res = await mail.flushOutbox({ DB: D1 }, { fetchFn: slow }); assert.equal(res.skipped, 1); assert.equal(get(id).status, "skipped"); assert.equal(get(id).last_error, "email not configured"); ok("without an email key nothing is sent and the row is marked skipped");
  const broken = { DB: { prepare() { throw new Error("db down"); } }, RESEND_API_KEY: "k" }; assert.deepEqual(await mail.flushOutbox(broken, {}), { sent: 0, retried: 0, failed: 0, skipped: 0 }); ok("flush never throws, even if the database is down");

  // ================= isolation: email trouble never blocks the action =================
  const acc3 = await apply("u3", "smile", "Gamma Installs", "GAMMA1234G"); await apps.submit(D1, acc3, baseEnv);
  const app3 = one("SELECT id FROM partner_applications WHERE user_id='u3'").id; await review.startReview(D1, hq, app3);
  const realFetch = global.fetch; global.fetch = async () => { throw new Error("provider down"); };
  const env2 = { ...baseEnv, RESEND_API_KEY: "k" };
  const resp = await adminV1(new Request(`https://admin.test/api/v1/admin/partner-applications/${app3}/approve`, { method: "POST" }), env2, "hq@example.test", {});
  global.fetch = realFetch; const j = await resp.json();
  assert.equal(resp.status, 200); assert.equal(j.data.status, "approved"); assert.equal(one("SELECT status FROM partners WHERE id = ?", j.data.partnerId).status, "agreement_pending"); ok("approval succeeds even when the email provider is down");
  const queued = rows("template='application_approved' AND to_email='u3@example.test'")[0]; assert.equal(queued.status, "pending"); assert.equal(queued.attempts, 1); assert.equal(queued.last_error, "email provider unreachable"); ok("...and the email is kept for the cron to retry");
  sqlite.prepare("UPDATE email_outbox SET next_attempt_at = 0 WHERE id = ?").run(queued.id);
  await mail.flushOutbox({ DB: D1, RESEND_API_KEY: "k" }, { fetchFn: okFetch }); assert.equal(get(queued.id).status, "sent"); ok("the 15-minute cron path delivers it later");
  let deferred = null; const ctx = { waitUntil: (p) => { deferred = p; } };
  const app4user = await apply("u4", "flex", "Delta Co", "DELTA1234D"); await apps.submit(D1, app4user, baseEnv); const app4 = one("SELECT id FROM partner_applications WHERE user_id='u4'").id;
  const r2 = await adminV1(new Request(`https://admin.test/api/v1/admin/partner-applications/${app4}/start-review`, { method: "POST" }), baseEnv, "hq@example.test", {}, ctx);
  assert.equal(r2.status, 200); assert.ok(deferred && typeof deferred.then === "function"); await deferred; ok("with a Worker context the send runs after the response (waitUntil)");
  const g = await adminV1(new Request("https://admin.test/api/v1/admin/partner-applications"), baseEnv, "hq@example.test", {}, { waitUntil: () => { throw new Error("must not flush on reads"); } });
  assert.equal(g.status, 200); ok("read-only requests never trigger sending");

  console.log(`all ${n} partner mail checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
