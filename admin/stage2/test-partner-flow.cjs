// Partner journey end to end on the in-memory D1: OTP login -> draft -> documents -> submit -> HQ review -> approve -> agreement -> fee ->
// activate -> dashboard -> suspend/reinstate. Also CSRF, rate limits, data isolation, privacy (no raw PAN), audit, and error hygiene.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeDb, root } = require("./d1shim.cjs");

let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const PAN = "ABCDE1234F";
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const pdf = () => new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");

(async () => {
  const core = await import(pathToFileURL(path.join(root, "packages/platform-core/src/index.js")).href);
  const review = await import(pathToFileURL(path.join(root, "packages/platform-core/src/review.js")).href);
  const { partnerRouter, adminV1, accessForRoles } = core;
  const t = makeDb(); const { D1, sqlite, q, one } = t;
  const store = new Map();
  const KYC = { async put(k, v) { store.set(k, v); }, async get(k) { return store.has(k) ? { body: store.get(k) } : null; } };
  const env = { DB: D1, KYC, DEV_OTP_ECHO: "1", PAN_HASH_SECRET: "test-secret" };
  const ORIGIN = "https://partner.test";

  const call = async (p, { method = "GET", body, cookie, headers = {}, raw, noOrigin, noXrw } = {}) => {
    const h = { ...headers };
    if (!noOrigin && !h.origin) h.origin = ORIGIN; if (!noXrw) h["x-requested-with"] = "ntagz";
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await partnerRouter(new Request(ORIGIN + p, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) }), env);
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, headers: res.headers, text };
  };
  const age = () => sqlite.exec("UPDATE otp_tokens SET created_at = created_at - 2000");
  const login = async (email, ip) => {
    age();
    const s = await call("/api/v1/auth/otp/send", { method: "POST", body: { email }, headers: ip ? { "cf-connecting-ip": ip } : {} });
    assert.equal(s.status, 200, s.text);
    const v = await call("/api/v1/auth/otp/verify", { method: "POST", body: { email, code: s.json.data.dev_otp }, headers: ip ? { "cf-connecting-ip": ip } : {} });
    assert.equal(v.status, 200, v.text);
    return v.headers.get("set-cookie").split(";")[0];
  };
  const admin = async (p, method = "GET", body = {}, actor = "hq@example.test") => {
    const res = await adminV1(new Request("https://admin.test" + p, { method }), env, actor, body);
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: res.status, json, text, res };
  };

  // ---- CSRF / unauthenticated ----
  assert.equal((await call("/api/v1/me")).status, 401); ok("no session -> 401");
  assert.equal((await call("/api/v1/auth/otp/send", { method: "POST", body: { email: "a@example.test" }, noXrw: true })).status, 403); ok("POST without the CSRF header is blocked");
  assert.equal((await call("/api/v1/auth/otp/send", { method: "POST", body: { email: "a@example.test" }, noOrigin: true })).status, 403); ok("POST without Origin is blocked");
  assert.equal((await call("/api/v1/auth/otp/send", { method: "POST", body: { email: "a@example.test" }, headers: { origin: "https://evil.test" } })).status, 403); ok("POST from another origin is blocked");
  assert.equal((await call("/other")).status, 404); ok("unknown path -> 404");
  const types = await call("/api/v1/partner/types"); assert.equal(types.json.data.length, 5); assert.equal(types.json.data[2].key, "flex"); ok("public list of the five partner types");
  { const site = await partnerRouter(new Request("https://partner.test/api/v1/partner/types", { headers: { origin: "https://ntagz.com" } }), env); assert.equal(site.headers.get("access-control-allow-origin"), "https://ntagz.com");
    const other = await partnerRouter(new Request("https://partner.test/api/v1/partner/types", { headers: { origin: "https://evil.example" } }), env); assert.equal(other.headers.get("access-control-allow-origin"), null); ok("ntagz.com (only) may read the public plan list cross-origin"); }

  // ---- login ----
  assert.equal((await call("/api/v1/auth/otp/send", { method: "POST", body: { email: "nope" } })).status, 400); ok("invalid email -> 400");
  const email = "applicant@example.test";
  const send = await call("/api/v1/auth/otp/send", { method: "POST", body: { email } });
  const bad = await call("/api/v1/auth/otp/verify", { method: "POST", body: { email, code: send.json.data.dev_otp === "000000" ? "111111" : "000000" } });
  assert.equal(bad.status, 401); ok("wrong code -> 401");
  const good = await call("/api/v1/auth/otp/verify", { method: "POST", body: { email, code: send.json.data.dev_otp } });
  const setCookie = good.headers.get("set-cookie"); assert.equal(good.status, 200);
  assert.match(setCookie, /^__Host-ntagz_partner=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax/); ok("cookie is __Host-, HttpOnly, Secure, SameSite=Lax");
  const A = setCookie.split(";")[0]; const tokenA = A.split("=")[1];
  assert.equal(one("SELECT COUNT(*) c FROM sessions WHERE id = ?", tokenA).c, 0); assert.equal(one("SELECT COUNT(*) c FROM sessions WHERE portal='partner'").c, 1); ok("only a hash of the token is stored");
  assert.equal((await call("/api/v1/auth/otp/verify", { method: "POST", body: { email, code: send.json.data.dev_otp } })).status, 401); ok("a code works once");
  let me = await call("/api/v1/me", { cookie: A });
  assert.deepEqual(me.json.data.roles, ["customer"]); assert.ok(me.json.data.permissions.includes("partners.apply")); assert.equal(me.json.data.partner, null); ok("new user is a customer who may apply");
  assert.equal(one("SELECT COUNT(*) c FROM login_attempts WHERE identifier = ?", email).c >= 3, true); ok("login attempts are logged");

  // ---- rate limits ----
  for (let i = 0; i < 10; i++) assert.equal((await call("/api/v1/auth/otp/send", { method: "POST", body: { email: `ip${i}@example.test` }, headers: { "cf-connecting-ip": "9.9.9.9" } })).status, 200);
  assert.equal((await call("/api/v1/auth/otp/send", { method: "POST", body: { email: "ip11@example.test" }, headers: { "cf-connecting-ip": "9.9.9.9" } })).status, 429); ok("11th code request from one IP -> 429");
  { const e2 = { ...env, OTP_IP_LIMIT: "2" }; const sendTo = (em) => partnerRouter(new Request(ORIGIN + "/api/v1/auth/otp/send", { method: "POST", headers: { origin: ORIGIN, "x-requested-with": "ntagz", "content-type": "application/json", "cf-connecting-ip": "7.7.7.7" }, body: JSON.stringify({ email: em }) }), e2); assert.equal((await sendTo("c1@example.test")).status, 200); assert.equal((await sendTo("c2@example.test")).status, 200); assert.equal((await sendTo("c3@example.test")).status, 429); ok("the per-IP sign-in limit is configurable (OTP_IP_LIMIT) and enforced"); }
  const lim = "limit@example.test"; for (let i = 0; i < 3; i++) await call("/api/v1/auth/otp/send", { method: "POST", body: { email: lim } });
  assert.equal((await call("/api/v1/auth/otp/send", { method: "POST", body: { email: lim } })).status, 429); ok("4th code for one email -> 429");

  // ---- application draft ----
  assert.equal((await call("/api/v1/partner/applications/mine", { method: "PUT", cookie: A, body: { businessName: "Acme" } })).status, 400); ok("cannot start without a partner category");
  let r = await call("/api/v1/partner/applications/mine", { method: "PUT", cookie: A, body: { typeKey: "flex", pincode: "12" } });
  assert.equal(r.status, 400); assert.equal(r.json.error.fields.pincode, "must be 6 digits"); ok("field errors are reported per field");
  r = await call("/api/v1/partner/applications/mine", { method: "PUT", cookie: A, body: { typeKey: "flex", businessName: "Acme Tags", city: "Pune", state: "Maharashtra", pincode: "411001", pan: PAN, form: { name: "Asha", phone: "99601 60016", business_type: "Retail", investment_capacity: "1l_to_3l", staff_available: 2, vehicle_available: true, pan: "SHOULD-BE-DROPPED", aadhaar: "123412341234" } } });
  assert.equal(r.status, 200, r.text); const app = r.json.data.application; assert.equal(app.status, "draft"); assert.equal(app.panLast4, "1234F".slice(-4)); ok("draft saved; PAN reduced to last 4");
  const stored = one("SELECT * FROM partner_applications WHERE id = ?", app.id);
  assert.ok(!JSON.stringify(stored).includes(PAN)); assert.ok(!stored.form_json.includes("aadhaar") && !stored.form_json.includes("SHOULD-BE")); assert.match(stored.pan_hash, /^[0-9a-f]{64}$/); ok("raw PAN and ID numbers are never stored");
  assert.equal(JSON.parse(stored.form_json).phone, "9960160016"); ok("phone normalised");
  assert.equal((await call("/api/v1/partner/applications/mine", { method: "PUT", cookie: A, body: { form: { investment_capacity: "lots" } } })).status, 400); ok("enum fields are validated");

  // ---- documents ----
  const up = (type, bytes, cookie = A) => call("/api/v1/partner/documents", { method: "POST", cookie, raw: bytes, headers: { "x-doc-type": type, "content-type": "application/octet-stream" } });
  assert.equal((await up("pan", new TextEncoder().encode("hello text file"))).status, 400); ok("non PDF/PNG/JPEG upload rejected (checked by file bytes)");
  assert.equal((await up("selfie", png())).status, 400); ok("unknown document type rejected");
  assert.equal((await up("pan", new Uint8Array(6 * 1024 * 1024))).status, 400); ok("file over 5 MB rejected");
  assert.equal((await call("/api/v1/partner/applications/mine/submit", { method: "POST", cookie: A })).status, 400); ok("submit with no documents is rejected");
  const subErr = (await call("/api/v1/partner/applications/mine/submit", { method: "POST", cookie: A })).json.error.fields;
  assert.ok(subErr.document_pan && subErr.document_address_proof); ok("missing documents are named");
  assert.equal((await up("pan", png())).status, 201); assert.equal((await up("address_proof", pdf())).status, 201);
  const keys = q("SELECT r2_key FROM partner_documents").map((d) => d.r2_key); assert.ok(keys.every((k) => /^kyc\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(k)) && store.size === 2); ok("files stored in the private bucket under random keys");

  // ---- isolation ----
  const B = await login("other@example.test");
  assert.equal((await call("/api/v1/partner/applications/mine", { cookie: B })).json.data.application, null); ok("another user sees none of this application");
  assert.equal((await up("pan", png(), B)).status, 409); ok("another user cannot attach files to it");
  const custAccess = await accessForRoles(D1, "someone", ["customer"]);
  await assert.rejects(() => review.listApplications(D1, custAccess), (e) => e.code === "FORBIDDEN"); ok("customers cannot list applications");

  // ---- submit ----
  r = await call("/api/v1/partner/applications/mine/submit", { method: "POST", cookie: A });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.data.application.status, "submitted"); ok("complete application submits");
  assert.equal((await call("/api/v1/partner/applications/mine", { method: "PUT", cookie: A, body: { city: "Delhi" } })).status, 409); ok("cannot edit once submitted");
  assert.equal((await call("/api/v1/partner/applications/mine/submit", { method: "POST", cookie: A })).status, 409); ok("cannot submit twice");

  // ---- HQ review ----
  let l = await admin("/api/v1/admin/partner-applications"); assert.equal(l.json.data.items.length, 1); const id = l.json.data.items[0].id; ok("HQ sees the submitted application");
  assert.equal((await admin("/api/v1/admin/partner-applications?status=approved")).json.data.items.length, 0); ok("status filter works");
  const det = await admin(`/api/v1/admin/partner-applications/${id}`); assert.equal(det.json.data.documents.length, 2); assert.ok(!det.text.includes("kyc/")); ok("detail lists documents without exposing storage keys");
  const docId = det.json.data.documents[0].id;
  const dres = await admin(`/api/v1/admin/partner-documents/${docId}`); assert.equal(dres.status, 200); assert.equal(dres.res.headers.get("cache-control"), "no-store"); ok("HQ can open a KYC file (no-store, sandboxed)");
  assert.equal(dres.res.headers.get("content-disposition"), "inline");
  const pdfDoc = det.json.data.documents.find((x) => x.type === "address_proof"); const pres = await admin(`/api/v1/admin/partner-documents/${pdfDoc.id}`); assert.match(pres.res.headers.get("content-disposition"), /^attachment/); ok("images open inline, PDFs download (so the sandbox policy cannot block them)");
  assert.equal(one("SELECT COUNT(*) c FROM audit_log WHERE action='partner.document.view' AND entity_id = ?", id).c, 2); ok("every document view is audited");
  assert.equal((await admin(`/api/v1/admin/partner-applications/${id}/approve`, "POST")).status, 409); ok("cannot approve before review");
  assert.equal((await admin(`/api/v1/admin/partner-applications/${id}/start-review`, "POST")).status, 200); ok("review started");
  assert.equal((await admin(`/api/v1/admin/partner-applications/${id}/request-documents`, "POST", {})).status, 400); ok("requesting documents needs a message");
  assert.equal((await admin(`/api/v1/admin/partner-applications/${id}/request-documents`, "POST", { note: "Please add a GST certificate" })).status, 200);
  r = await call("/api/v1/partner/applications/mine", { cookie: A }); assert.equal(r.json.data.application.status, "documents_required"); assert.match(r.json.data.application.decisionNote, /GST certificate/); ok("applicant sees what HQ asked for");
  assert.equal((await call("/api/v1/partner/applications/mine", { method: "PUT", cookie: A, body: { form: { experience: "5 years in retail" } } })).status, 200); assert.equal((await up("gst_certificate", pdf())).status, 201);
  assert.equal((await call("/api/v1/partner/applications/mine/submit", { method: "POST", cookie: A })).status, 200); ok("applicant fixes and resubmits");
  await admin(`/api/v1/admin/partner-applications/${id}/start-review`, "POST");
  const ops = await accessForRoles(D1, "ops@example.test", ["operations"]);
  await assert.rejects(() => review.approve(D1, ops, id), (e) => e.code === "FORBIDDEN"); ok("Operations can review but not approve");
  r = await admin(`/api/v1/admin/partner-applications/${id}/approve`, "POST", { agreementVersion: "v1" });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.data.partnerCode, "NTZ-FLX-0001"); const pid = r.json.data.partnerId; ok("approval issues the Partner ID NTZ-FLX-0001");
  assert.equal(one("SELECT status FROM partners WHERE id = ?", pid).status, "agreement_pending"); assert.equal(one("SELECT COUNT(*) c FROM partner_agreements WHERE partner_id = ? AND status='pending'", pid).c, 1); ok("partner starts at agreement_pending with a pending agreement");
  assert.equal((await admin(`/api/v1/admin/partner-applications/${id}/approve`, "POST")).status, 409); ok("cannot approve twice");
  me = await call("/api/v1/me", { cookie: A }); assert.equal(me.json.data.partner, null); assert.ok(!me.json.data.roles.includes("partner_flex")); ok("approved is not active: no partner access yet");
  r = await call("/api/v1/partner/applications/mine", { cookie: A }); assert.deepEqual(r.json.data.partner, { partnerCode: "NTZ-FLX-0001", status: "agreement_pending" }); ok("applicant can see their own onboarding stage and Partner ID");
  assert.equal((await call("/api/v1/partner/dashboard", { cookie: A })).status, 403); ok("dashboard is closed until activation");

  // ---- onboarding gates ----
  const P = (act, body) => admin(`/api/v1/admin/partners/${pid}/${act}`, "POST", body);
  assert.equal((await P("activate")).status, 409); ok("cannot activate before agreement and fee");
  assert.equal((await P("fee-payment", { amountPaise: 2499900, method: "upi", reference: "UPI123456" })).status, 409); ok("fee cannot be recorded before the agreement");
  assert.equal((await P("agreement-signed")).status, 200);
  { const low = await P("fee-payment", { amountPaise: 100, method: "upi", reference: "UPI123456" }); assert.equal(low.status, 400); assert.match(low.json.error.fields.amountPaise, /₹24,999/); assert.ok(!/paise/.test(low.json.error.fields.amountPaise)); } ok("fee below the joining fee rejected, message in rupees");
  assert.equal((await P("fee-payment", { amountPaise: 2499900, method: "cheque", reference: "UPI123456" })).status, 400);
  assert.equal((await P("fee-payment", { amountPaise: 2499900, gstPaise: 381000, method: "upi", reference: "UPI123456" })).status, 200); ok("fee recorded in its own ledger");
  assert.equal(one("SELECT amount_paise, gst_paise FROM partner_fee_payments WHERE partner_id = ?", pid).gst_paise, 381000);
  assert.equal((await call("/api/v1/partner/dashboard", { cookie: A })).status, 403); ok("still no access during onboarding");
  r = await P("activate"); assert.equal(r.status, 200, r.text); ok("activated after agreement + fee");
  me = await call("/api/v1/me", { cookie: A });
  assert.ok(me.json.data.roles.includes("partner_flex") && me.json.data.roles.includes("customer")); assert.equal(me.json.data.partner.partner_code, "NTZ-FLX-0001"); assert.ok(me.json.data.permissions.includes("leads.manage.own")); assert.ok(!me.json.data.permissions.includes("pricing.manage")); ok("same login now holds customer + Flex partner permissions");
  const dash = await call("/api/v1/partner/dashboard", { cookie: A }); assert.equal(dash.status, 200); assert.equal(dash.json.data.partner.status, "active"); ok("dashboard opens");

  // ---- duplicate PAN ----
  const C = await login("third@example.test");
  await call("/api/v1/partner/applications/mine", { method: "PUT", cookie: C, body: { typeKey: "smile", businessName: "Clone", city: "Pune", state: "MH", pincode: "411002", pan: PAN, form: { name: "C", phone: "9876543210", business_type: "x", investment_capacity: "under_1l" } } });
  await up("pan", png(), C); await up("address_proof", pdf(), C);
  assert.equal((await call("/api/v1/partner/applications/mine/submit", { method: "POST", cookie: C })).status, 200);
  const cid = (await admin("/api/v1/admin/partner-applications?status=submitted")).json.data.items[0].id;
  await admin(`/api/v1/admin/partner-applications/${cid}/start-review`, "POST");
  assert.equal((await admin(`/api/v1/admin/partner-applications/${cid}/approve`, "POST")).status, 409); ok("a second partner with the same PAN is blocked at approval");
  assert.equal((await admin(`/api/v1/admin/partner-applications/${cid}/reject`, "POST", { note: "Duplicate PAN" })).status, 200);
  assert.equal((await call("/api/v1/partner/applications/mine", { cookie: C })).json.data.application.status, "rejected"); ok("rejection reason reaches the applicant");
  assert.equal((await call("/api/v1/partner/applications/mine", { method: "PUT", cookie: C, body: { typeKey: "smile", businessName: "Retry" } })).status, 200); ok("a rejected applicant can start a new application");

  // ---- suspend / reinstate ----
  assert.equal((await P("suspend", {})).status, 400); ok("suspension needs a reason");
  assert.equal((await P("suspend", { reason: "Policy breach" })).status, 200);
  assert.equal((await call("/api/v1/me", { cookie: A })).status, 401); ok("suspending revokes the partner session at once");
  let A2 = await login(email);
  me = await call("/api/v1/me", { cookie: A2 }); assert.deepEqual(me.json.data.roles, ["customer"]); assert.equal((await call("/api/v1/partner/dashboard", { cookie: A2 })).status, 403); ok("suspended partner can still sign in as a customer only");
  assert.equal((await P("reinstate")).status, 200); assert.equal((await call("/api/v1/partner/dashboard", { cookie: A2 })).status, 200); ok("reinstating restores access");

  // ---- refund the joining fee: needs a suspended partner; reverses the credit; the partner stays blocked afterwards ----
  const feeId = one("SELECT id FROM partner_fee_payments WHERE partner_id = ?", pid).id;
  assert.equal((await P("fee-refund", { feePaymentId: feeId, reason: "Partner left" })).status, 409); ok("fee refund needs a suspended partner");
  assert.equal((await P("suspend", { reason: "Leaving" })).status, 200);
  assert.equal((await P("fee-refund", { feePaymentId: feeId, reason: "x" })).status, 400); ok("fee refund needs a reason");
  assert.equal((await P("fee-refund", { feePaymentId: "00000000-0000-4000-8000-000000000000", reason: "Partner left" })).status, 404); ok("fee refund only for a fee of this partner");
  // credit already used by an order: no refund (the partner bought goods with it)
  sqlite.prepare("INSERT INTO orders (id, txn_id, gateway, payment_status, total, subtotal, paid_paise) VALUES ('ord-used', 'TX-USED', 'razorpay', 'paid', 100, 100, 100)").run();
  sqlite.prepare("INSERT INTO partner_stock_credit (id, partner_id, kind, delta_paise, order_id, actor) VALUES ('cons-used', ?, 'consume', -100, 'ord-used', 'system')").run(pid);
  assert.equal((await P("fee-refund", { feePaymentId: feeId, reason: "Partner left" })).status, 409); ok("no refund once any stock credit has been used");
  sqlite.prepare("DELETE FROM partner_stock_credit WHERE id = 'cons-used'").run(); sqlite.prepare("DELETE FROM orders WHERE id = 'ord-used'").run();
  const rf = await P("fee-refund", { feePaymentId: feeId, reason: "Partner left" }); assert.equal(rf.status, 200, rf.text);
  assert.equal(one("SELECT COALESCE(SUM(delta_paise),0) b FROM partner_stock_credit WHERE partner_id = ?", pid).b, 0); ok("refund reverses the fee's stock credit to zero");
  assert.equal((await P("fee-refund", { feePaymentId: feeId, reason: "Partner left" })).status, 409); ok("the same fee cannot be refunded twice");
  assert.equal((await P("reinstate")).status, 409); ok("a refunded partner cannot be reinstated");
  const appRow = one("SELECT id FROM partner_applications WHERE partner_id = ?", pid);
  const detRf = await admin(`/api/v1/admin/partner-applications/${appRow.id}`); assert.equal(detRf.json.data.partner.feePayments[0].refund.reason, "Partner left"); ok("the refund shows on the partner record");
  A2 = await login(email); // suspending revoked the earlier session
  sqlite.prepare("UPDATE users SET status='suspended' WHERE email = ?").run(email);
  assert.equal((await call("/api/v1/me", { cookie: A2 })).status, 401); ok("a suspended user account is locked out immediately");
  sqlite.prepare("UPDATE users SET status=NULL WHERE email = ?").run(email);

  // ---- logout ----
  assert.equal((await call("/api/v1/auth/logout", { method: "POST", cookie: A2 })).status, 200); assert.equal((await call("/api/v1/me", { cookie: A2 })).status, 401); ok("logout revokes the session");

  // ---- audit ----
  const acts = q("SELECT action FROM audit_log WHERE entity_type IN ('partner','partner_application')").map((a) => a.action);
  for (const a of ["partner.application.create", "partner.application.submit", "partner.application.approved", "partner.create", "partner.fee.record", "partner.active", "partner.suspended"]) assert.ok(acts.includes(a), a); ok("every state change and fee record is in the audit log");
  assert.equal(one("SELECT actor FROM audit_log WHERE action='partner.create'").actor, "hq@example.test"); ok("audit rows name the acting admin");

  // ---- error hygiene ----
  { const saved0 = env.KYC; env.KYC = null; const d0 = await admin(`/api/v1/admin/partner-documents/${docId}`); env.KYC = saved0; assert.equal(d0.status, 503); assert.match(d0.json.error.message, /not connected/i); ok("admin without document storage answers 503 with a clear message"); }
  const saved = env.KYC; env.KYC = null; const e500 = await up("pan", png(), (await login("kyc@example.test"))); env.KYC = saved;
  assert.equal(e500.status, 500); assert.ok(!/KYC|stack|SELECT/i.test(e500.text) && e500.json.error.requestId); ok("server errors are generic and carry a request id");
  assert.equal(JSON.parse((await call("/api/v1/me")).text).ok, false); assert.equal((await call("/api/v1/me")).headers.get("cache-control"), "no-store"); ok("responses are no-store");

  console.log(`all ${n} partner flow checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
