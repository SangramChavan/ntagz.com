// Customers/CRM core: identity, directory, profile, segments, consent, tracking, unsubscribe, click redirect, export, erasure, permissions.
// Runs the REAL admin Worker and payments Worker on one in-memory D1 (no network, never production).
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const root = path.join(__dirname, "..", "..");
const payments = require(path.join(root, "functions", "api", "[[path]].js"));
const CRMLIB = require(path.join(root, "functions", "lib", "crm.js"));
const { makeDb } = require("./d1shim.cjs");
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const ADMIN = "https://admin.ntagz.com", SECRET = "unsub-test-secret";
const NOW = Math.floor(Date.now() / 1000), DAY = 86400;

(async () => {
  const admin = (await import(pathToFileURL(path.join(root, "admin", "src", "index.js")).href)).default;
  const common = await import(pathToFileURL(path.join(root, "admin", "src", "crm", "common.js")).href);
  const segs = await import(pathToFileURL(path.join(root, "admin", "src", "crm", "segments.js")).href);
  const customers = await import(pathToFileURL(path.join(root, "admin", "src", "crm", "customers.js")).href);
  const { sqlite, D1, q, one } = makeDb();
  const aenv = { DB: D1, ADMIN_EMAILS: "owner@example.test,staff@example.test", DEV_OTP_ECHO: "1", ASSETS: { fetch: () => new Response("x") } };
  const penv = { DB: D1, UNSUB_SECRET: SECRET };
  const cookies = {};
  const A = async (who, p, body) => {
    const h = { Origin: ADMIN, "X-Requested-With": "ntagz-admin", "Content-Type": "application/json" }; if (cookies[who]) h.Cookie = cookies[who];
    const r = await admin.fetch(new Request(ADMIN + p, { method: body === undefined ? "GET" : "POST", headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), aenv);
    const text = await r.clone().text(); let d = {}; try { d = JSON.parse(text); } catch { /* csv or html */ }
    return { status: r.status, d, text, headers: r.headers };
  };
  const login = async (who) => { let r = await A(who, "/api/auth/request", { email: who }); r = await A(who, "/api/auth/verify", { email: who, otp: r.d.dev_otp }); cookies[who] = r.headers.get("set-cookie").split(";")[0]; };
  const P = (p, { body, cookie, method, origin, headers } = {}) => { payments.resetCrmCache(); return payments.onRequest({ request: new Request("https://ntagz.com" + p, { method: method || (body ? "POST" : "GET"), headers: { "Content-Type": "application/json", ...(origin === null ? {} : { Origin: origin || "https://ntagz.com" }), ...(cookie ? { Cookie: cookie } : {}), ...(headers || {}) }, body: typeof body === "string" ? body : body ? JSON.stringify(body) : undefined }), env: penv }); };
  const OW = "owner@example.test", ST = "staff@example.test";
  await login(OW); await login(ST);

  // ── fixtures ──
  const user = (id, email, name, created = NOW - 200 * DAY) => { sqlite.prepare("INSERT INTO users (id,email,name,created_at) VALUES (?,?,?,?)").run(id, email, name, created); sqlite.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)").run("s-" + id, id, NOW + DAY); return "ntagz_session=s-" + id; };
  let on = 0;
  const order = (o) => {
    const id = o.id || `o${++on}`, total = o.total ?? 11800, paid = o.paid === undefined ? (o.status === "unpaid" ? 0 : total) : o.paid;
    sqlite.prepare(`INSERT INTO orders (id,user_id,txn_id,gateway,items_json,name,phone,email,subtotal,gst,total,payment_status,paid_paise,status,qualifying_paise,shipping_paise,refunded_paise,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, o.user || null, "tx" + id, "razorpay", JSON.stringify(o.items || [{ id: "black-nfc-card", qty: 10 }]), o.name || "N", o.phone || null, o.email ?? null,
      total - 1800, 1800, total, o.pay || "paid", paid, o.status === "unpaid" ? "confirmed" : (o.status || "delivered"), o.qual ?? total - 1800, 0, o.refunded || 0, o.at || NOW - 10 * DAY);
    return id;
  };
  const cA = user("aaaaaaaa-1111-1111-1111-111111111111", "asha@example.test", "Asha Rao");
  const cB = user("bbbbbbbb-2222-2222-2222-222222222222", "bob@example.test", "Asha Rao"); // SAME name as A, different email: must never merge
  user("cccccccc-3333-3333-3333-333333333333", "newbie@example.test", "No Orders", NOW - 5 * DAY);
  order({ user: "aaaaaaaa-1111-1111-1111-111111111111", email: "asha@example.test", name: "Asha Rao", at: NOW - 60 * DAY });
  order({ user: null, email: "ASHA@Example.test ", name: "Asha guest", at: NOW - 20 * DAY, total: 23600 });          // guest order, identical email => attaches to Asha
  order({ user: "bbbbbbbb-2222-2222-2222-222222222222", email: "bob@example.test", name: "Asha Rao", total: 11800, at: NOW - 30 * DAY });
  order({ user: null, email: "guest1@example.test", name: "=cmd|' /C calc'!A0", phone: "+919000000001", at: NOW - 3 * DAY, total: 5900 });     // guest with formula-looking name
  order({ user: null, email: "unpaid@example.test", name: "Unpaid", status: "unpaid", at: NOW - 2 * DAY });
  order({ user: null, email: "cancel@example.test", name: "Cancelled", status: "cancelled", at: NOW - 2 * DAY });
  order({ user: null, email: "", name: "NoEmail", at: NOW - 2 * DAY });
  order({ id: "orf1", user: null, email: "refund@example.test", name: "Refunder", total: 10000, refunded: 2500, at: NOW - 4 * DAY });

  // ── permissions ──
  assert.equal((await A("nobody", "/api/crm/customers")).status, 401); ok("CRM API requires a signed-in admin");
  assert.equal((await A(ST, "/api/crm/customers")).status, 200); ok("any allow-listed admin can view by default");
  assert.equal((await A(ST, "/api/crm/customers/export.csv")).status, 403); assert.equal((await A(ST, "/api/crm/customers/x/erase", {})).status, 403); ok("export and erasure are owner-only by default (least privilege)");
  assert.deepEqual(common.permsOf({ ADMIN_EMAILS: "a@x.t,b@x.t", CRM_EXPORT_EMAILS: "b@x.t" }, "b@x.t"), { view: true, manage: true, export: true, send: false }); ok("permission lists are explicit when configured");

  // ── identity ──
  const all = (await A(OW, "/api/crm/customers?sort=name&dir=asc")).d;
  const byEmail = Object.fromEntries(all.customers.map((c) => [c.email, c]));
  assert.equal(byEmail["asha@example.test"].paid_orders, 2); assert.equal(byEmail["asha@example.test"].net_paise, 11800 + 23600); ok("guest order with an identical email attaches to the registered customer");
  assert.equal(byEmail["bob@example.test"].paid_orders, 1); assert.notEqual(byEmail["bob@example.test"].ckey, byEmail["asha@example.test"].ckey); ok("same name, different email: NOT merged");
  assert.equal(byEmail["guest1@example.test"].type, "guest"); assert.ok(!all.customers.some((c) => c.name === "NoEmail")); ok("guests are keyed by email; orders with no email stay out of customer views");
  assert.equal(byEmail["unpaid@example.test"].net_paise, 0); assert.equal(byEmail["cancel@example.test"].net_paise, 0); assert.equal(byEmail["cancel@example.test"].paid_orders, 0); ok("unpaid and cancelled orders are not revenue");
  assert.equal(byEmail["refund@example.test"].net_paise, 7500); ok("a recorded refund reduces net revenue");
  assert.equal(all.total, 7); ok("directory total counts every customer (3 registered + 4 guests)");

  // ── directory: search, pagination, filters ──
  assert.equal((await A(OW, "/api/crm/customers?q=" + encodeURIComponent("100%"))).d.total, 0); ok("LIKE wildcards are escaped");
  assert.equal((await A(OW, "/api/crm/customers?q=asha")).d.total, 2); ok("search by name/email (2 registered/guest-asha matches: Asha Rao x2 incl. bob's account name)");
  assert.equal((await A(OW, "/api/crm/customers?q=" + encodeURIComponent("aaaaaaaa-1111"))).d.total, 1); ok("search by customer id");
  assert.equal((await A(OW, "/api/crm/customers?preset=repeat")).d.total, 1); assert.equal((await A(OW, "/api/crm/customers?preset=one_time")).d.total, 3); assert.equal((await A(OW, "/api/crm/customers?preset=never")).d.customers.length, 3); ok("repeat / one-time / never-purchased presets");
  assert.equal((await A(OW, "/api/crm/customers?spend_min=200")).d.customers.filter((c) => c.net_paise < 20000).length, 0); ok("spend range filter");
  const pg = (await A(OW, "/api/crm/customers?page=1")).d; assert.equal(pg.page_size, 25); assert.equal(pg.more, false); ok("server-side pagination metadata");
  for (let i = 0; i < 30; i++) sqlite.prepare("INSERT INTO users (id,email,name) VALUES (?,?,?)").run("dddddddd-0000-0000-0000-" + String(i).padStart(12, "0"), `bulk${i}@example.test`, "Bulk " + i);
  const p1 = (await A(OW, "/api/crm/customers?sort=email&dir=asc")).d, p2 = (await A(OW, "/api/crm/customers?sort=email&dir=asc&page=2")).d;
  assert.equal(p1.customers.length, 25); assert.equal(p1.more, true); assert.equal(p2.customers.length, p1.total - 25); assert.ok(!p2.customers.some((c) => p1.customers.some((d) => d.ckey === c.ckey))); ok("pagination returns disjoint pages");
  sqlite.exec("DELETE FROM users WHERE email LIKE 'bulk%'");
  assert.equal((await A(OW, "/api/crm/customers?rules=" + encodeURIComponent('{"op":"and","rules":[{"field":"nope","value":1}]}'))).status, 400); ok("unknown rule field rejected");
  assert.equal((await A(OW, "/api/crm/customers?consent=drop")).status, 400); ok("invalid enum filter rejected");

  // ── CSV export ──
  const csv = await A(OW, "/api/crm/customers/export.csv?q=guest1");
  assert.equal(csv.status, 200); assert.match(csv.headers.get("content-type"), /text\/csv/); assert.match(csv.text, /'=cmd\|/); assert.ok(!/(^|,)=cmd/.test(csv.text)); ok("CSV neutralises spreadsheet formulas");
  assert.match(csv.text, /customer_id,type,name,email,phone/); assert.ok(!/gstin|address|password/i.test(csv.text)); ok("export includes only allow-listed fields");
  assert.ok(one("SELECT 1 x FROM audit_log WHERE action='crm_export'")); ok("export is audited");

  // ── consent / opt-in / unsubscribe ──
  assert.equal((await P("/api/marketing/consent", { body: { subscribe: true } })).status, 401); ok("opt-in requires a signed-in session");
  assert.equal((await P("/api/marketing/consent", { cookie: cA, body: { subscribe: true }, origin: "https://evil.example" })).status, 403); ok("opt-in rejects foreign origins");
  assert.equal((await P("/api/marketing/consent", { cookie: cA, body: { subscribe: "yes" } })).status, 400); ok("opt-in value validated");
  let r = await P("/api/marketing/consent", { cookie: cA, body: { subscribe: true } }); assert.equal(r.status, 200);
  const mc = one("SELECT * FROM marketing_contacts WHERE email='asha@example.test'"); assert.equal(mc.status, "subscribed"); assert.equal(mc.source, "account_page"); assert.ok(mc.consented_at && mc.policy_version);
  assert.equal(one("SELECT count(*) n FROM consent_log WHERE email='asha@example.test' AND action='opt_in'").n, 1); ok("explicit opt-in is stored with time, source and policy version, and logged");
  assert.equal(one("SELECT count(*) n FROM marketing_contacts WHERE email='bob@example.test'").n, 0); ok("ordering never subscribes anyone");
  assert.equal((await A(OW, "/api/crm/customers?consent=subscribed")).d.total, 1); assert.equal((await A(OW, "/api/crm/customers?consent=none")).d.total, 6); ok("consent filter");
  const tok = await CRMLIB.unsubToken(SECRET, "asha@example.test");
  const u = (e, t) => `/api/unsubscribe?e=${encodeURIComponent(e)}&t=${t}`;
  r = await P(u("asha@example.test", tok)); assert.equal(r.status, 200); assert.equal(one("SELECT status FROM marketing_contacts WHERE email='asha@example.test'").status, "subscribed"); ok("GET unsubscribe page changes nothing (link scanners are safe)");
  assert.equal((await P(u("asha@example.test", "0".repeat(64)), { method: "POST", body: "List-Unsubscribe=One-Click" })).status, 400); assert.equal((await P(u("asha@example.test", await CRMLIB.unsubToken(SECRET, "other@example.test")), { method: "POST", body: "x" })).status, 400); ok("forged or mismatched unsubscribe tokens are rejected");
  r = await P(u("asha@example.test", tok), { method: "POST", body: "List-Unsubscribe=One-Click", origin: null }); assert.equal(r.status, 200);
  assert.equal(one("SELECT status FROM marketing_contacts WHERE email='asha@example.test'").status, "unsubscribed"); assert.ok(one("SELECT unsubscribed_at a FROM marketing_contacts WHERE email='asha@example.test'").a); ok("one-click unsubscribe works without a session");
  assert.equal((await segs.eligibleRecipients({ DB: D1 }, { op: "and", rules: [] })).rows.length, 0); ok("unsubscribed customers are excluded from every audience");
  await P("/api/marketing/consent", { cookie: cA, body: { subscribe: true } });
  assert.equal((await segs.eligibleRecipients({ DB: D1 }, { op: "and", rules: [] })).rows.length, 1); ok("a fresh explicit opt-in makes them eligible again");
  r = await A(OW, `/api/crm/customers/${encodeURIComponent("u:aaaaaaaa-1111-1111-1111-111111111111")}/consent`, { action: "suppress", reason: "hard bounce", confirm: true }); assert.equal(r.status, 200);
  assert.equal((await P("/api/marketing/consent", { cookie: cA, body: { subscribe: true } })).status, 409); assert.equal((await segs.eligibleRecipients({ DB: D1 }, { op: "and", rules: [] })).rows.length, 0); ok("suppression cannot be overridden by a customer opt-in and removes them from audiences");
  r = await A(OW, `/api/crm/customers/${encodeURIComponent("u:aaaaaaaa-1111-1111-1111-111111111111")}/consent`, { action: "subscribe", confirm: true }); assert.equal(r.status, 400); ok("admins cannot grant marketing consent on a customer's behalf");
  await A(OW, `/api/crm/customers/${encodeURIComponent("u:aaaaaaaa-1111-1111-1111-111111111111")}/consent`, { action: "unsuppress", reason: "address fixed", confirm: true });
  assert.equal(one("SELECT status FROM marketing_contacts WHERE email='asha@example.test'").status, "unsubscribed"); ok("unblocking returns to unsubscribed, never straight to subscribed");
  assert.equal((await P(u("asha@example.test", tok), { method: "POST", body: "x" })).status, 200);
  assert.ok(one("SELECT count(*) n FROM audit_log WHERE action='crm_consent'").n >= 2); ok("consent changes are audited");

  // ── segments ──
  const meta = (await A(OW, "/api/crm/segments/meta")).d; assert.ok(meta.fields.length > 10 && meta.templates.length >= 15 && meta.products.length > 5); ok("segment catalogue served (fields, products, templates)");
  r = await A(OW, "/api/crm/segments", { name: "Repeat", rules: { op: "and", rules: [{ field: "paid_orders", cmp: "gte", value: 2 }] } }); assert.equal(r.status, 201); assert.equal(r.d.count, 1);
  const sid = r.d.id; ok("segment saved with live matching count");
  assert.equal((await A(OW, "/api/crm/segments", { name: "Bad", rules: { op: "and", rules: [{ field: "tag", cmp: "has", value: "x'; DROP TABLE users;--" }] } })).status, 400);
  assert.equal((await A(OW, "/api/crm/segments", { name: "Bad", rules: { op: "and", rules: [{ field: "bought_product", cmp: "has", value: "a' OR '1'='1" }] } })).status, 400);
  assert.equal((await A(OW, "/api/crm/segments", { name: "Bad", rules: { op: "and", rules: [{ field: "paid_orders", cmp: "gte", value: "1; DROP" }] } })).status, 400); ok("rule values are validated; injection strings are rejected");
  assert.ok(one("SELECT count(*) n FROM users").n > 0);
  r = await A(OW, "/api/crm/segments/preview", { rules: { op: "or", rules: [{ field: "never_purchased", cmp: "is", value: true }, { field: "type", cmp: "eq", value: "guest" }] } }); assert.equal(r.d.count, 5); ok("OR groups evaluate");
  r = await A(OW, "/api/crm/segments", { name: "Marketing eligible buyers", rules: { op: "and", rules: [{ field: "paid_orders", cmp: "gte", value: 1 }] } }); assert.equal(r.d.eligible, 0); ok("segment reports marketing-eligible count separately from members");
  assert.equal((await A(OW, `/api/crm/segments/${sid}/duplicate`, {})).status, 201); assert.equal((await A(OW, `/api/crm/segments/${sid}/archive`, {})).status, 200);
  assert.equal((await A(OW, "/api/crm/segments")).d.segments.some((s) => s.id === sid), false); ok("duplicate and archive");
  sqlite.prepare("INSERT INTO crm_tags (ckey,tag,actor) VALUES ('u:aaaaaaaa-1111-1111-1111-111111111111','vip','t')").run();
  assert.equal((await A(OW, "/api/crm/customers?tag=vip")).d.total, 1); ok("tag filter");
  const comp = segs.compileRules({ op: "and", rules: [{ field: "approaching_tier", cmp: "lte", value: 50000 }, { field: "abandoned_cart", cmp: "lte", value: 7 }, { field: "clicked_no_purchase", cmp: "lte", value: 30 }, { field: "bulk_quantity", cmp: "gte", value: 5 }] });
  assert.deepEqual(comp.errors, []); await D1.prepare(`SELECT count(*) n FROM crm_customers c WHERE ${comp.sql}`).bind(...comp.params).first(); ok("behavioural and tier segment fields compile to valid SQL");
  for (const t of segs.TEMPLATES.filter((t) => !JSON.stringify(t.tree).includes("null"))) assert.deepEqual(segs.compileRules(t.tree).errors, [], t.key); ok("every complete starter template is valid");

  // ── tracking (browser events) ──
  const evt = (o) => ({ id: "ev" + Math.random().toString(36).slice(2, 12), sid: "session1234", event: "page_view", path: "/", ...o });
  r = await P("/api/ev", { body: { events: [evt({})] } }); assert.equal(r.status, 204); assert.equal(one("SELECT count(*) n FROM crm_events").n, 0); ok("tracking is OFF by default: nothing is stored");
  assert.equal((await (await P("/api/ev/config")).json()).enabled, false); ok("config endpoint reports tracking off");
  r = await A(OW, "/api/crm/settings", { tracking_enabled: true, retention_days: 90 }); assert.equal(r.d.tracking_enabled, true); assert.equal(r.d.retention_days, 90);
  assert.equal((await A(OW, "/api/crm/settings", { retention_days: 5 })).status, 400); ok("tracking switch and retention are validated and audited");
  assert.ok(one("SELECT 1 x FROM audit_log WHERE action='crm_settings'"));
  const e1 = evt({ event: "product_view", product_id: "black-nfc-card", path: "/product/black-nfc-card/?token=SECRET&email=a@b.c#frag", user_id: "bbbbbbbb-2222-2222-2222-222222222222", revenue: 99999 });
  r = await P("/api/ev", { body: { events: [e1, e1, evt({ event: "purchase", id: "purchase0001" }), evt({ event: "search", id: "search00001", term: "who@example.com" }), evt({ event: "search", id: "search00002", term: "nfc card" }), evt({ id: "bad", event: "page_view" })] }, cookie: cA });
  assert.equal(r.status, 204);
  const rows = q("SELECT * FROM crm_events ORDER BY id"); assert.equal(rows.length, 3, JSON.stringify(rows.map((x) => x.event)));
  const pv = rows.find((x) => x.event === "product_view"); assert.equal(pv.path, "/product/black-nfc-card/"); assert.equal(pv.user_id, "aaaaaaaa-1111-1111-1111-111111111111"); ok("query strings are stripped; user comes from the session, not the request body");
  assert.ok(!rows.some((x) => x.event === "purchase")); ok("browsers cannot submit purchase/revenue events");
  assert.ok(rows.filter((x) => x.event === "search").every((x) => !x.term || !x.term.includes("@"))); assert.ok(rows.some((x) => x.term === "nfc card")); ok("search text that looks like an email is not stored");
  assert.equal(one("SELECT count(*) n FROM crm_events WHERE id=?", e1.id).n, 1); ok("duplicate event ids are ignored (idempotent retries)");
  r = await P("/api/ev", { body: "x".repeat(9000) }); assert.equal(r.status, 413); ok("oversized batches rejected");
  r = await P("/api/ev", { body: { events: [evt({ id: "anon0000001" })] } }); assert.equal(one("SELECT user_id u FROM crm_events WHERE id='anon0000001'").u, null); ok("anonymous visitors stay anonymous");
  assert.equal((await P("/api/ev", { body: { events: [evt({ id: "forn0000001" })] }, origin: "https://evil.example" })).status, 403); ok("foreign origins cannot post events");
  assert.equal(one("SELECT count(*) n FROM orders").n, 8); ok("tracking never touches orders or revenue");

  // ── campaign click redirect ──
  sqlite.exec(`INSERT INTO campaigns (id,name,subject,status,utm_campaign,created_by) VALUES ('c0000000-0000-0000-0000-000000000001','C','S','sent','spring','owner@example.test');
    INSERT INTO campaign_recipients (id,campaign_id,email,status,sent_at) VALUES ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000001','asha@example.test','sent',${NOW - DAY})`);
  r = await P("/api/c/11111111-1111-1111-1111-111111111111?p=" + encodeURIComponent("/product/black-nfc-card/")); assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /^https:\/\/ntagz\.com\/product\/black-nfc-card\/\?utm_source=email&utm_medium=campaign&utm_campaign=spring&nz_r=1111/); assert.equal(one("SELECT click_count c FROM campaign_recipients WHERE email='asha@example.test'").c, 1); ok("click is recorded, then redirected with campaign attribution");
  r = await P("/api/c/11111111-1111-1111-1111-111111111111?p=" + encodeURIComponent("//evil.example/x")); assert.match(r.headers.get("location"), /^https:\/\/ntagz\.com\/\?utm/); ok("click redirect cannot be used as an open redirect");
  r = await P("/api/c/99999999-9999-9999-9999-999999999999?p=/"); assert.equal(r.headers.get("location"), "https://ntagz.com/"); ok("unknown tokens redirect plainly without attribution");

  // ── profile, timeline, interests ──
  const key = encodeURIComponent("u:aaaaaaaa-1111-1111-1111-111111111111");
  r = await A(OW, `/api/crm/customers/${key}`); assert.equal(r.status, 200);
  assert.equal(r.d.summary.paid_orders, 2); assert.equal(r.d.summary.net_paise, 35400); assert.equal(r.d.customer.linked_guest_orders, 1); assert.equal(r.d.orders.length, 2); assert.ok(r.d.orders.some((o) => o.guest)); assert.ok(r.d.summary.qualifying_spend_paise !== null); ok("profile summary: guest order included and flagged; qualifying spend reported separately");
  assert.ok(JSON.stringify(r.d).indexOf("otp") === -1 && !/password|secret|token_hash/i.test(JSON.stringify(r.d))); ok("profile exposes no credentials");
  assert.equal((await A(OW, `/api/crm/customers/${key}?opay=unpaid`)).d.orders.length, 0); assert.equal((await A(OW, `/api/crm/customers/${key}?oproduct=black-nfc-card`)).d.orders.length, 2); ok("order history filters");
  r = await A(OW, `/api/crm/customers/${key}/timeline`); const kinds = new Set(r.d.events.map((e) => e.kind));
  assert.ok(kinds.has("order_placed") && kinds.has("account_created") && kinds.has("consent_opt_in") && kinds.has("marketing_email_clicked") && kinds.has("product_view")); assert.ok(r.d.events.some((e) => e.source === "tracked") && r.d.events.some((e) => e.source === "record")); assert.match(r.d.tracking.note, /before tracking/); ok("timeline merges order records with tracked events and labels each source");
  const tsList = r.d.events.map((e) => e.ts); assert.deepEqual(tsList, [...tsList].sort((a, b) => b - a)); ok("timeline is newest-first");
  const old = (await A(OW, `/api/crm/customers/${encodeURIComponent("u:cccccccc-3333-3333-3333-333333333333")}/timeline`)).d; assert.deepEqual(old.events.map((e) => e.kind), ["account_created"]); assert.equal(old.tracking.events_recorded, 0); ok("nothing is invented for a customer with no tracked activity");
  r = await A(OW, `/api/crm/customers/${key}/interests`); assert.equal(r.d.observed.most_purchased[0].id, "black-nfc-card"); assert.match(r.d.inferred.note, /not facts|suggestions/); assert.ok(r.d.observed.most_viewed.length === 1); ok("interests separate observed facts from inferences");
  assert.equal((await A(OW, `/api/crm/customers/${encodeURIComponent("u:ffffffff-0000-0000-0000-000000000000")}`)).status, 404); assert.equal((await A(OW, `/api/crm/customers/${encodeURIComponent("x:whatever")}`)).status, 404); assert.equal((await A(OW, `/api/crm/customers/${encodeURIComponent("g:'; DROP TABLE users;--@x.co")}`)).status, 404); ok("unknown or malformed customer ids are 404");
  assert.equal(JSON.stringify((await A(OW, `/api/crm/customers/${encodeURIComponent("u:bbbbbbbb-2222-2222-2222-222222222222")}`)).d.orders.map((o) => o.id)), JSON.stringify(["o3"])); ok("one customer's profile never contains another's orders");

  // ── tags, notes, edits ──
  r = await A(OW, `/api/crm/customers/${key}/tags`, { add: ["VIP", "bulk buyer"], remove: [] }); assert.deepEqual(r.d.tags.sort(), ["bulk buyer", "vip"]); assert.equal((await A(OW, `/api/crm/customers/${key}/tags`, { add: ["<script>"] })).status, 400); ok("tags are normalised and validated");
  assert.equal((await A(OW, `/api/crm/customers/${key}/notes`, { body: "Prefers WhatsApp" })).status, 201); assert.equal((await A(OW, `/api/crm/customers/${key}/notes`, { body: "x" })).status, 400); ok("internal notes");
  assert.equal((await A(OW, `/api/crm/customers/${key}/meta`, { name: "Asha R", phone: "98765 43210" })).status, 200); assert.equal(one("SELECT phone p FROM users WHERE id='aaaaaaaa-1111-1111-1111-111111111111'").p, "9876543210"); assert.equal((await A(OW, `/api/crm/customers/${key}/meta`, { phone: "123" })).status, 400); ok("permitted metadata edit (name, phone) is validated");
  assert.equal((await A(OW, `/api/crm/customers/${encodeURIComponent("g:guest1@example.test")}/meta`, { name: "x" })).status, 400); ok("guests have no account to edit");
  r = await A(OW, "/api/crm/customers/bulk-tag", { tag: "campaign-a", ckeys: ["u:aaaaaaaa-1111-1111-1111-111111111111", "g:guest1@example.test", "g:nobody@example.test"] }); assert.equal(r.status, 400); r = await A(OW, "/api/crm/customers/bulk-tag", { tag: "campaign-a", ckeys: ["u:aaaaaaaa-1111-1111-1111-111111111111", "g:guest1@example.test", "g:nobody@example.test"], confirm: true });
  assert.equal(r.status, 200); assert.equal(one("SELECT count(*) n FROM crm_tags WHERE tag='campaign-a'").n, 2); ok("bulk tagging needs confirmation and skips customers that do not exist");
  for (const a of ["crm_tags", "crm_note", "crm_customer_edit", "crm_tags_bulk"]) assert.ok(one("SELECT 1 x FROM audit_log WHERE action=?", a), a); ok("manual customer changes are audited");
  r = await A(OW, `/api/crm/customers/${key}/data.json`); assert.equal(r.status, 200); assert.ok(JSON.parse(r.text).orders.length === 2); assert.equal((await A(ST, `/api/crm/customers/${key}/data.json`)).status, 403); ok("per-customer data export is owner-only and audited");

  // ── date ranges (IST) ──
  const sp = (s) => new URLSearchParams(s);
  const rg = common.rangeOf(sp("from=2026-03-01&to=2026-03-01")); assert.equal(rg.to - rg.from, 86400); assert.equal(rg.from, Date.UTC(2026, 2, 1) / 1000 - 19800); assert.equal(rg.from_day, "2026-03-01"); assert.equal(rg.to_day, "2026-03-01");
  assert.equal(common.istDay(Date.UTC(2026, 2, 1, 18, 29, 59) / 1000), "2026-03-01"); assert.equal(common.istDay(Date.UTC(2026, 2, 1, 18, 30, 0) / 1000), "2026-03-02"); ok("ranges are IST days, inclusive of both end dates (18:30 UTC is the day boundary)");
  assert.equal(common.rangeOf(sp("from=bad&to=2026-01-01")).label, "30d"); assert.equal(common.rangeOf(sp("from=2026-02-01&to=2026-01-01")).label, "30d"); ok("invalid ranges fall back safely");
  assert.equal(common.csvCell("+1"), "'+1"); assert.equal(common.csvCell('a"b'), '"a""b"'); assert.equal(common.csvCell(-5), "-5"); ok("csvCell");

  // ── erasure ──
  const gk = encodeURIComponent("u:bbbbbbbb-2222-2222-2222-222222222222");
  sqlite.prepare("UPDATE orders SET status='shipped' WHERE id='o3'").run();
  assert.equal((await A(OW, `/api/crm/customers/${gk}/erase`, { confirm_email: "bob@example.test", request_ref: "ticket 42" })).status, 409); ok("erasure is refused while an order is in progress");
  sqlite.prepare("UPDATE orders SET status='delivered' WHERE id='o3'").run();
  assert.equal((await A(OW, `/api/crm/customers/${gk}/erase`, { confirm_email: "wrong@example.test", request_ref: "ticket 42" })).status, 400); assert.equal((await A(OW, `/api/crm/customers/${gk}/erase`, { confirm_email: "bob@example.test" })).status, 400); ok("erasure needs the typed email and a request reference");
  await P("/api/ev", { body: { events: [evt({ id: "bobev000001" })] }, cookie: cB });
  r = await A(OW, `/api/crm/customers/${gk}/erase`, { confirm_email: "bob@example.test", request_ref: "ticket 42" }); assert.equal(r.status, 200);
  const bu = one("SELECT * FROM users WHERE id='bbbbbbbb-2222-2222-2222-222222222222'"); assert.equal(bu.name, null); assert.match(bu.email, /@erased\.invalid$/); assert.equal(one("SELECT count(*) n FROM sessions WHERE user_id=?", bu.id).n, 0); assert.equal(one("SELECT count(*) n FROM crm_events WHERE user_id=?", bu.id).n, 0);
  assert.equal(one("SELECT count(*) n FROM orders WHERE id='o3'").n, 1); assert.ok(!JSON.stringify(one("SELECT detail d FROM audit_log WHERE action='crm_erase'")).includes("bob@")); ok("erasure anonymises the profile, removes consent/activity/sessions, keeps orders for accounting, and audits without the email");

  // ── retention ──
  sqlite.prepare("INSERT INTO crm_events (id,ts,sid,event) VALUES ('oldevent001',?,'sess00000001','page_view')").run(NOW - 400 * DAY);
  await customers.purgeExpired({ DB: D1 }); assert.equal(one("SELECT count(*) n FROM crm_events WHERE id='oldevent001'").n, 0); assert.ok(one("SELECT count(*) n FROM crm_events").n > 0); ok("retention purge deletes expired events only");
  console.log(`\n${n} CRM core checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
