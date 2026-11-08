// Migrations 0021/0022 + packages/platform-core: roles, scoped permissions, partner gate, one-open-application rule, audit rows.
// Runs against the in-memory D1 shim with every migration applied, like the other stage2 suites.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeDb, root } = require("./d1shim.cjs");

let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const throws = async (fn, code) => { try { await fn(); } catch (e) { assert.equal(e.code, code, `expected ${code}, got ${e.code || e.message}`); return; } assert.fail(`expected ${code}`); };

(async () => {
  const core = await import(pathToFileURL(path.join(root, "packages/platform-core/src/index.js")).href);
  const { loadAccess, requirePermission, scopeClause, auditStmt, AppError, validate } = core;
  const t = makeDb();
  const { D1, sqlite, q, one } = t;

  // ---- seeds ----
  assert.equal(one("SELECT COUNT(*) c FROM roles").c, 12); ok("12 roles seeded");
  assert.equal(one("SELECT COUNT(*) c FROM partner_types").c, 5); ok("5 partner types seeded");
  assert.deepEqual(q("SELECT key FROM partner_types ORDER BY sort").map((r) => r.key), ["360", "enterprise", "flex", "smile", "smile_plus"]); ok("partner types in order");
  assert.deepEqual(q("SELECT fee_paise FROM partner_types ORDER BY sort").map((r) => r.fee_paise), [9999900, 4999900, 2499900, 999900, 1999900]); ok("opening order amounts stored in paise (0029: Smile 9,999 < Smile+ 19,999)");
  assert.equal(one("SELECT COUNT(*) c FROM partner_types WHERE gst_rate_bp IS NOT NULL").c, 0); ok("no GST rate is guessed (owner decision pending)");
  assert.equal(one("SELECT COUNT(*) c FROM role_permissions rp LEFT JOIN roles r ON r.key=rp.role_key LEFT JOIN permissions p ON p.key=rp.permission_key WHERE r.key IS NULL OR p.key IS NULL").c, 0); ok("every role_permission points at a real role and permission");
  assert.equal(one("SELECT COUNT(*) c FROM partner_types pt LEFT JOIN roles r ON r.key=pt.role_key WHERE r.kind != 'partner' OR r.key IS NULL").c, 0); ok("every partner type maps to a partner role");

  // ---- helpers ----
  const user = (id, status) => sqlite.prepare("INSERT INTO users (id, email, status) VALUES (?, ?, ?)").run(id, `${id}@example.test`, status ?? null);
  const grant = (uid, role) => sqlite.prepare("INSERT INTO user_roles (id, user_id, role_key, granted_by) VALUES (?, ?, ?, 'test')").run(crypto.randomUUID(), uid, role);
  const partner = (uid, type, status, region) => sqlite.prepare("INSERT INTO partners (id, user_id, type_key, status, business_name, region) VALUES (?, ?, ?, ?, 'Biz', ?)").run("p_" + uid, uid, type, status, region ?? null);

  // ---- customer ----
  user("cust"); grant("cust", "customer");
  let a = await loadAccess(D1, "cust");
  assert.equal(requirePermission(a, "partners.apply"), "own"); ok("customer may apply to be a partner (own scope)");
  await throws(() => requirePermission(a, "orders.read.all"), "FORBIDDEN"); ok("customer cannot read all orders");
  await throws(() => requirePermission(a, "partners.activate"), "FORBIDDEN"); ok("customer cannot activate partners");

  // ---- unauthenticated ----
  await throws(() => requirePermission({ userId: null, permissions: new Map() }, "catalog.read"), "UNAUTHENTICATED"); ok("no user -> UNAUTHENTICATED");
  a = await loadAccess(D1, "missing-user");
  assert.equal(a.permissions.size, 0); ok("unknown user has no permissions");

  // ---- partner gate ----
  user("flex1"); grant("flex1", "customer"); grant("flex1", "partner_flex"); partner("flex1", "flex", "onboarding");
  a = await loadAccess(D1, "flex1");
  assert.ok(!a.roles.includes("partner_flex")); await throws(() => requirePermission(a, "leads.manage.own"), "FORBIDDEN"); ok("partner role grants nothing until the partner is active");
  assert.equal(requirePermission(a, "partners.apply"), "own"); ok("...but the person keeps customer rights meanwhile (one identity, two roles)");
  sqlite.prepare("UPDATE partners SET status='active' WHERE id='p_flex1'").run();
  a = await loadAccess(D1, "flex1");
  assert.equal(requirePermission(a, "leads.manage.own"), "own"); assert.equal(a.partnerId, "p_flex1"); ok("active partner gets leads.manage.own (own scope)");
  await throws(() => requirePermission(a, "pricing.manage"), "FORBIDDEN"); await throws(() => requirePermission(a, "orders.fulfil"), "FORBIDDEN"); ok("partner cannot change pricing or fulfilment");
  await throws(() => requirePermission(a, "quotes.create"), "FORBIDDEN"); ok("Flex has no quotation right (Enterprise/360 do)");
  sqlite.prepare("UPDATE partners SET status='suspended' WHERE id='p_flex1'").run();
  a = await loadAccess(D1, "flex1");
  await throws(() => requirePermission(a, "leads.manage.own"), "FORBIDDEN"); ok("suspending a partner removes partner access immediately");

  // ---- tier differences ----
  user("ent1"); grant("ent1", "partner_enterprise"); partner("ent1", "enterprise", "active");
  user("sm1"); grant("sm1", "partner_smile"); partner("sm1", "smile", "active");
  user("smp1"); grant("smp1", "partner_smile_plus"); partner("smp1", "smile_plus", "active");
  const ent = await loadAccess(D1, "ent1"), sm = await loadAccess(D1, "sm1"), smp = await loadAccess(D1, "smp1");
  assert.equal(requirePermission(ent, "quotes.create"), "own"); await throws(() => requirePermission(sm, "quotes.create"), "FORBIDDEN"); ok("Enterprise can quote, Smile cannot");
  assert.equal(requirePermission(sm, "service_jobs.manage.own"), "own"); await throws(() => requirePermission(ent, "service_jobs.manage.own"), "FORBIDDEN"); ok("Smile has service jobs, Enterprise does not");
  assert.equal(requirePermission(smp, "orders.place.own"), "own"); assert.equal(requirePermission(smp, "leads.manage.own"), "own"); ok("Smile+ has leads and wholesale ordering (migration 0031)");

  // ---- staff ----
  user("hq"); grant("hq", "hq_admin"); user("fin"); grant("fin", "finance"); user("reg"); grant("reg", "regional");
  const hq = await loadAccess(D1, "hq"), fin = await loadAccess(D1, "fin"), reg = await loadAccess(D1, "reg");
  assert.equal(requirePermission(hq, "partners.activate"), "all"); await throws(() => requirePermission(fin, "partners.activate"), "FORBIDDEN"); ok("only HQ activates partners");
  assert.equal(requirePermission(fin, "commissions.approve"), "all"); assert.equal(requirePermission(fin, "orders.refund"), "all"); ok("Finance approves commissions and refunds");
  await throws(() => requirePermission(fin, "orders.fulfil"), "FORBIDDEN"); ok("Finance cannot fulfil orders");
  assert.equal(requirePermission(reg, "partners.review"), "region"); ok("Regional Manager reviews within a region");

  // ---- widest scope wins, revoked roles ignored, suspended user locked out ----
  user("multi"); grant("multi", "customer"); grant("multi", "operations");
  assert.equal(requirePermission(await loadAccess(D1, "multi"), "orders.read.all"), "all"); ok("several roles combine");
  sqlite.prepare("UPDATE user_roles SET revoked_at=unixepoch() WHERE user_id='multi' AND role_key='operations'").run();
  await throws(async () => requirePermission(await loadAccess(D1, "multi"), "orders.read.all"), "FORBIDDEN"); ok("revoked role grants nothing");
  user("sus", "suspended"); grant("sus", "hq_admin");
  assert.equal((await loadAccess(D1, "sus")).permissions.size, 0); ok("suspended user has no permissions, even as HQ");

  // ---- scope clauses (data isolation) ----
  const own = scopeClause("own", ent, { ownColumn: "partner_id" });
  assert.deepEqual(own, { sql: "partner_id = ?", binds: ["p_ent1"] }); ok("own scope filters by the caller's partner id");
  assert.deepEqual(scopeClause("own", { userId: "u", partnerId: null }, { ownColumn: "partner_id" }), { sql: "1=0", binds: [] }); ok("own scope with no partner returns nothing");
  assert.equal(scopeClause("region", { region: null }, { regionColumn: "region" }).sql, "1=0"); ok("region scope without a region returns nothing");
  assert.equal(scopeClause("region", { region: "west" }, { regionColumn: "region" }).binds[0], "west"); ok("region scope filters by the caller's region");
  assert.deepEqual(scopeClause("own", { userId: "u1" }, { ownColumn: "user_id" }), { sql: "user_id = ?", binds: ["u1"] }); ok("customer own scope uses the user id");

  // ---- applications ----
  const app = (id, uid, status) => sqlite.prepare("INSERT INTO partner_applications (id, user_id, type_key, status) VALUES (?, ?, 'flex', ?)").run(id, uid, status);
  user("applicant"); app("a1", "applicant", "draft");
  assert.throws(() => app("a2", "applicant", "submitted"), /UNIQUE/); ok("a second open application is rejected");
  sqlite.prepare("UPDATE partner_applications SET status='rejected' WHERE id='a1'").run();
  app("a3", "applicant", "draft"); ok("after rejection the person can apply again");
  assert.throws(() => sqlite.prepare("INSERT INTO partner_applications (id, user_id, type_key, status) VALUES ('x','applicant','flex','active')").run(), /CHECK/); ok("invalid application status is rejected by the database");
  user("fkuser");
  assert.throws(() => sqlite.prepare("INSERT INTO partner_applications (id, user_id, type_key) VALUES ('y','fkuser','nope')").run(), /FOREIGN/); ok("unknown partner type is rejected");
  assert.throws(() => sqlite.prepare("INSERT INTO partner_documents (id, application_id, doc_type, r2_key, mime, size_bytes) VALUES ('d','a3','selfie','k','image/png',5)").run(), /CHECK/); ok("document type is constrained");
  assert.throws(() => sqlite.prepare("INSERT INTO partner_documents (id, application_id, doc_type, r2_key, mime, size_bytes) VALUES ('d','a3','pan','k','image/png',0)").run(), /CHECK/); ok("empty document is rejected");
  user("dup"); sqlite.prepare("INSERT INTO partners (id,user_id,type_key,business_name,pan_hash) VALUES ('pd1','dup','flex','B','h1')").run();
  user("dup2");
  assert.throws(() => sqlite.prepare("INSERT INTO partners (id,user_id,type_key,business_name,pan_hash) VALUES ('pd2','dup2','flex','B','h1')").run(), /UNIQUE/); ok("the same PAN hash cannot register two partners");
  assert.throws(() => sqlite.prepare("INSERT INTO partners (id,user_id,type_key,business_name) VALUES ('pd3','dup','flex','B')").run(), /UNIQUE/); ok("one partner record per person");

  // ---- audit ----
  await D1.batch([auditStmt(D1, { actor: "hq@example.test", action: "partner.approve", entityType: "partner", entityId: "p_ent1", before: { status: "submitted" }, after: { status: "approved" } })]);
  const row = one("SELECT * FROM audit_log WHERE entity_type='partner' AND entity_id='p_ent1'");
  assert.equal(row.action, "partner.approve"); assert.deepEqual(JSON.parse(row.detail), { before: { status: "submitted" }, after: { status: "approved" } }); ok("audit row records actor, entity and before/after");
  assert.equal(one("SELECT COUNT(*) c FROM audit_log WHERE order_id IS NOT NULL AND entity_type IS NOT NULL").c, 0); ok("existing order audit rows are untouched");

  // ---- validators ----
  assert.equal(validate.pincode("411001"), "411001"); assert.equal(validate.pincode("011001"), null); assert.equal(validate.pincode("4110"), null);
  assert.equal(validate.phone("+91 99601 60016"), "9960160016"); assert.equal(validate.phone("1234567890"), null);
  assert.equal(validate.pan("abcde1234f"), "ABCDE1234F"); assert.equal(validate.pan("12345ABCDE"), null);
  assert.equal(validate.gstin("27ABCDE1234F1Z5"), "27ABCDE1234F1Z5"); assert.equal(validate.gstin("nope"), null);
  assert.equal(validate.email(" A@B.co "), "a@b.co"); assert.equal(validate.email("a@b"), null); ok("validators accept good and reject bad input");
  const h1 = await validate.keyedHash("s", "ABCDE1234F"), h2 = await validate.keyedHash("s", "ABCDE1234F"), h3 = await validate.keyedHash("t", "ABCDE1234F");
  assert.equal(h1, h2); assert.notEqual(h1, h3); assert.equal(h1.length, 64); ok("keyed hash is stable and secret-dependent");

  // ---- error shape ----
  const res = core.fail(new AppError("VALIDATION_FAILED", "bad", { pincode: "must be 6 digits" }), "req1");
  const body = await res.json(); assert.equal(res.status, 400); assert.deepEqual(body, { ok: false, error: { code: "VALIDATION_FAILED", message: "bad", requestId: "req1", fields: { pincode: "must be 6 digits" } } }); ok("error response matches the contract");
  const r500 = await core.fail(new Error("SELECT * FROM secrets failed"), "req2").json(); assert.ok(!JSON.stringify(r500).includes("SELECT")); assert.equal(r500.error.code, "INTERNAL"); ok("unexpected errors never leak details");

  console.log(`all ${n} platform rbac checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
