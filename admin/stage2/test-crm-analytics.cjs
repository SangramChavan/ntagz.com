// CRM analytics (/api/crm/overview, /api/crm/analytics): the real admin Worker on an in-memory D1 with seeded orders.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeDb, root } = require("./d1shim.cjs");
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const ADMIN = "https://admin.ntagz.com";
// IST wall-clock -> unix seconds ("2026-03-10", "23:59")
const ist = (d, hm = "12:00", s = 0) => Date.parse(`${d}T${hm}:${String(s).padStart(2, "0")}+05:30`) / 1000;

(async () => {
  const admin = (await import(pathToFileURL(path.join(root, "admin", "src", "index.js")).href)).default;
  const { compileRules } = await import(pathToFileURL(path.join(root, "admin", "src", "crm", "segments.js")).href);
  const db = makeDb(); const { sqlite, D1, q, one } = db;
  const aenv = { DB: D1, ADMIN_EMAILS: "admin@example.test,other@example.test", DEV_OTP_ECHO: "1", ASSETS: { fetch: () => new Response("x") } };
  let cookie = "";
  const A = async (p, body, ck = cookie) => {
    const h = { Origin: ADMIN, "X-Requested-With": "ntagz-admin", "Content-Type": "application/json" }; if (ck) h.Cookie = ck;
    const r = await admin.fetch(new Request(ADMIN + p, { method: body === undefined ? "GET" : "POST", headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), aenv);
    return { status: r.status, d: await r.clone().json().catch(() => ({})), headers: r.headers };
  };
  const login = async (email) => { let r = await A("/api/auth/request", { email }, ""); r = await A("/api/auth/verify", { email, otp: r.d.dev_otp }, ""); return r.headers.get("set-cookie").split(";")[0]; };
  cookie = await login("admin@example.test");

  // ── seed ──
  const user = (id, email, createdAt, tier) => sqlite.prepare("INSERT INTO users (id,email,name,created_at,loyalty_tier_id) VALUES (?,?,?,?,?)").run(id, email, id, createdAt, tier || null);
  let on = 0;
  const order = (o) => {
    const id = "o" + ++on, paid = o.paid ?? 0;
    sqlite.prepare("INSERT INTO orders (id,user_id,txn_id,gateway,status,items_json,name,email,subtotal,gst,total,created_at,shipping_paise,qualifying_paise,refunded_paise,loyalty_tier) VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)")
      .run(id, o.user || null, "t" + id, "cash", o.status || "confirmed", o.items || "[]", o.name || null, o.email === undefined ? null : o.email, o.gst || 0, o.total ?? paid, o.at, o.ship || 0, o.qual || 0, o.refunded || 0, o.tier || null);
    sqlite.prepare("UPDATE orders SET payment_status=?, paid_paise=? WHERE id=?").run(o.unpaid ? "unpaid" : "paid", o.unpaid ? 0 : paid, id); // the insert trigger forces unpaid for cash: set the state we want
    return id;
  };
  const prods = q("SELECT id, category FROM products WHERE price_paise > 0 ORDER BY category, id");
  const p1 = prods[0], p2 = prods.find((p) => p.category !== p1.category);
  user("u1", "u1@example.test", ist("2026-01-10"), "silver"); user("u2", "u2@example.test", ist("2026-03-05")); user("u3", "u3@example.test", ist("2026-02-01"));
  order({ user: "u1", paid: 100000, gst: 15000, qual: 85000, at: ist("2026-01-20"), email: "u1@example.test" });                                     // u1 bought before March
  order({ user: "u1", paid: 118000, gst: 18000, ship: 4000, qual: 96000, at: ist("2026-03-03"), tier: "silver", items: JSON.stringify([{ id: p1.id, qty: 2 }]) }); // March, shipping + GST
  order({ user: "u2", paid: 59000, gst: 9000, qual: 50000, refunded: 29500, at: ist("2026-03-06") });                                              // half refunded
  order({ email: "asha1@x.test", name: "Asha Rao", paid: 11800, gst: 1800, qual: 10000, at: ist("2026-03-07"), items: JSON.stringify([{ id: p2.id, qty: 1 }]) });
  order({ email: " U3@Example.TEST ", name: "Someone Else", paid: 23600, gst: 3600, qual: 20000, at: ist("2026-03-07", "15:00") });                  // guest order, same email as registered u3
  order({ user: "u1", unpaid: true, total: 50000, at: ist("2026-03-08") });                                                                        // unpaid
  order({ user: "u2", paid: 20000, status: "cancelled", at: ist("2026-03-09") });                                                                  // paid then cancelled
  order({ user: "u1", paid: 30000, status: "returned", at: ist("2026-03-09", "13:00") });                                                          // returned
  order({ email: "c@x.test", unpaid: true, total: 7000, status: "cancelled", at: ist("2026-03-09", "14:00") });                                    // unpaid + cancelled
  order({ email: "", paid: 30000, gst: 4500, qual: 25500, at: ist("2026-03-10", "03:00") });                                                       // no email, no account
  order({ email: "asha2@x.test", name: "Asha Rao", paid: 5000, qual: 5000, at: ist("2026-03-10", "23:59") });                                      // last minute of 10 Mar IST
  order({ email: "asha2@x.test", name: "Asha Rao", paid: 7000, qual: 7000, at: ist("2026-03-11", "00:01") });                                      // first minutes of 11 Mar IST
  order({ email: "late@x.test", paid: 99999, at: ist("2026-04-01", "00:00") });                                                                    // after March
  order({ email: "feb@x.test", paid: 88888, at: ist("2026-02-28", "23:59", 59) });                                                                 // before March
  order({ email: "old@x.test", paid: 20000, at: ist("2025-11-15") });                                                                              // lapsed
  const R = "/api/crm/overview?from=2026-03-01&to=2026-03-31";
  const { kpis: K, prev: P, defs, range } = (await A(R)).d;

  // ── revenue rules ──
  assert.equal(K.paid_orders, 7); assert.equal(K.gross_paid, 254400); assert.equal(K.refunds, 29500); assert.equal(K.net_paid, 224900);
  ok("net revenue = gross - refunds over paid orders only; unpaid, cancelled and returned add nothing (incl. order with no email)");
  assert.equal(K.pending_unpaid_value, 50000); assert.equal(K.cancelled_value, 20000 + 30000 + 7000); assert.equal(K.net_paid, K.gross_paid - K.refunds);
  ok("unpaid value and cancelled/returned value are reported separately, never inside revenue");
  assert.equal(K.gst, 18000 + 4500 + 1800 + 3600 + 4500); assert.equal(K.shipping, 4000); assert.equal(K.net_product, 96000 + 25000 + 10000 + 20000 + 25500 + 5000 + 7000);
  ok("a half refund halves that order's GST and product value in proportion; GST and shipping are split out");
  assert.equal(K.aov, Math.round(224900 / 7)); ok("AOV = net paid / paid orders (orders with no email still count)");
  assert.equal(range.from_day, "2026-03-01"); assert.equal(range.to_day, "2026-03-31"); assert.equal(range.days, 31);
  ok("range echoes the inclusive IST days");

  // ── IST day boundaries ──
  let d = (await A("/api/crm/overview?from=2026-03-10&to=2026-03-10")).d.kpis;
  assert.equal(d.gross_paid, 30000 + 5000); assert.equal(d.paid_orders, 2);
  d = (await A("/api/crm/overview?from=2026-03-11&to=2026-03-11")).d.kpis; assert.equal(d.gross_paid, 7000); assert.equal(d.paid_orders, 1);
  d = (await A("/api/crm/overview?from=2026-03-10&to=2026-03-11")).d.kpis; assert.equal(d.gross_paid, 42000);
  ok("23:59 IST stays on its day, 00:01 IST is the next day (UTC+5:30), and both end dates are inclusive");
  assert.equal((await A("/api/crm/overview?from=2026-03-31&to=2026-03-31")).d.kpis.gross_paid, 0);
  assert.equal((await A("/api/crm/overview?from=2026-04-01&to=2026-04-01")).d.kpis.gross_paid, 99999); // 00:00 IST on 1 Apr belongs to 1 Apr
  ok("midnight IST belongs to the new day");

  // ── customer definitions ──
  assert.equal(K.active_customers, 5); assert.equal(K.new_customers, 4); assert.equal(K.first_purchasers, 4); assert.equal(K.returning_customers, 1);
  assert.equal(K.new_customers + K.returning_customers, K.active_customers); ok("new (first paid order in period) / returning (bought before period) / active reconcile");
  assert.equal(K.orders_per_customer, 6 / 5); ok("orders per customer = customer paid orders / active customers; the order with no email is excluded");
  assert.equal(K.repeat_rate, 2 / 7); assert.equal(K.ltv, Math.round((100000 + 118000 + 29500 + 11800 + 23600 + 5000 + 7000 + 88888 + 20000) / 7));
  ok("repeat rate = buyers with 2+ paid orders / buyers; LTV = lifetime net / buyers (as of the period end, excluding later orders)");
  assert.equal(K.lapsed_customers, 1); assert.equal(K.new_accounts, 1); assert.equal(K.total_customers, 3 + 5);
  ok("lapsed (last paid order > 90 days before period end), new accounts and total customers (3 accounts + 5 guest emails, one with only a cancelled unpaid order)");
  assert.equal(P.net_paid, 88888); assert.equal(P.new_customers, 1); assert.equal(P.members_by_tier, null); ok("previous equal-length period is computed the same way; snapshots have no previous value");

  // ── identity ──
  const ck = Object.fromEntries(q("SELECT id, ckey FROM crm_orders").map((r) => [r.id, r.ckey]));
  assert.equal(ck.o5, "u:u3"); assert.equal(ck.o4, "g:asha1@x.test"); assert.equal(ck.o11, "g:asha2@x.test"); assert.equal(ck.o10, null);
  assert.equal(one("SELECT count(*) c FROM crm_customers WHERE name = 'Asha Rao'").c, 2);
  ok("guest order with a registered user's email merges into that customer; same name with different emails stays two customers; no email => no customer");

  // ── members / email KPIs ──
  assert.deepEqual(K.members_by_tier.map((t) => [t.name, t.count]), [["Silver", 1], ["Not yet recorded", 2]]);
  assert.equal(K.campaigns, null); assert.equal(K.email_subscribers, 0);
  ok("members per tier (unset => 'Not yet recorded'); no campaigns => null, not zero");
  const mc = sqlite.prepare("INSERT INTO marketing_contacts (email,status,source) VALUES (?,?,?)");
  mc.run("a@x.test", "subscribed", "t"); mc.run("b@x.test", "subscribed", "t"); mc.run("c@x.test", "unsubscribed", "t"); mc.run("d@x.test", "suppressed", "t");
  sqlite.prepare("INSERT INTO campaigns (id,name,status,utm_campaign,created_by,started_at,finished_at,eligible_at_send) VALUES ('cA','Spring','sent','spring','x',?,?,3)").run(ist("2026-03-06"), ist("2026-03-06", "13:00"));
  const rc = sqlite.prepare("INSERT INTO campaign_recipients (id,campaign_id,email,status,sent_at,delivered_at,bounced_at,clicked_at,click_count) VALUES (?,?,?,?,?,?,?,?,?)");
  rc.run("r1", "cA", "asha1@x.test", "delivered", ist("2026-03-06"), ist("2026-03-06"), null, ist("2026-03-07", "09:00"), 1);
  rc.run("r2", "cA", "u3@example.test", "delivered", ist("2026-03-06"), ist("2026-03-06"), null, null, 0);
  rc.run("r3", "cA", "z@x.test", "bounced", ist("2026-03-06"), null, ist("2026-03-06"), null, 0);
  const k2 = (await A(R)).d.kpis;
  assert.deepEqual([k2.email_subscribers, k2.unsubscribed, k2.suppressed], [2, 1, 1]);
  assert.deepEqual(k2.campaigns, { sent_campaigns: 1, recipients: 3, sent: 3, delivered: 2, bounced: 1, unique_clicks: 1 }); ok("subscriber counts and campaign totals");

  // ── charts ──
  const AN = (await A("/api/crm/analytics?from=2026-03-01&to=2026-03-31")).d;
  assert.equal(AN.bucket, "day"); assert.equal(AN.new_vs_returning.length, 31);
  const day = (l) => AN.new_vs_returning.find((b) => b.label === l);
  assert.deepEqual([day("2026-03-03").new, day("2026-03-03").returning], [0, 1]); assert.deepEqual([day("2026-03-07").new, day("2026-03-07").returning], [2, 0]);
  assert.deepEqual([day("2026-03-10").active, day("2026-03-11").active, day("2026-03-11").new, day("2026-03-11").returning], [1, 1, 0, 1]);
  assert.equal(AN.new_vs_returning.reduce((s, b) => s + b.new, 0), 4); assert.equal(AN.acquisition.reduce((s, b) => s + b.new, 0), 4);
  ok("new vs returning per IST day; a customer whose first order was yesterday is returning today");
  assert.equal((await A("/api/crm/analytics?range=90d")).d.bucket, "week"); ok("ranges over 45 days bucket by week");
  assert.deepEqual(AN.revenue_by_tier.map((t) => [t.tier, t.net_paise]), [["Silver", 118000], ["Not yet recorded", 224900 - 118000]]);
  assert.deepEqual(AN.spend_distribution.map((s) => s.customers), (() => {
    const b = [0, 0, 0, 0, 0];
    for (const r of q("SELECT net_paise FROM crm_customers")) b[r.net_paise <= 0 ? 0 : r.net_paise < 100000 ? 1 : r.net_paise < 300000 ? 2 : r.net_paise < 1000000 ? 3 : 4]++; return b; })());
  ok("revenue per tier and the spend distribution match the customer view");
  const cat = Object.fromEntries(AN.categories.map((c) => [c.category, c]));
  assert.equal(cat[p1.category].units, 2); assert.equal(cat[p1.category].approx_net_paise, 118000); assert.equal(cat[p2.category].units, 1); assert.equal(cat[p2.category].approx_net_paise, 11800);
  ok("categories: exact units, approximate net share (single-line orders get the whole order)");
  const cohort = AN.cohorts.find((c) => c.cohort === "2026-03"); assert.equal(AN.cohorts.length, 12); assert.equal(cohort.customers, 4);
  assert.equal(cohort.cells[0], 29500 + 11800 + 23600 + 5000 + 7000); assert.equal(cohort.cells[1], null);
  assert.equal(AN.cohorts.find((c) => c.cohort === "2026-02").cells[1], 0);
  ok("cohort table: month of first order x months since; months not reached are null");
  const rt = AN.repeat_trend; assert.equal(rt.length, 12); assert.equal(rt[11].month, "2026-03"); assert.equal(rt[11].repeat_rate, 2 / 7); assert.equal(rt[10].repeat_rate, 0);
  ok("repeat-rate trend is cumulative as of each month end");
  const em = AN.email_engagement[0]; assert.equal(AN.email_engagement.length, 1);
  assert.deepEqual([em.eligible_at_send, em.recipients, em.delivered, em.bounced, em.unsubscribed, em.unique_clicks, em.attributed_orders, em.attributed_net_paise], [3, 3, 2, 1, null, 1, 1, 11800]);
  ok("email engagement: last-click attributed order and revenue within 7 days of the click; unsubscribes unavailable (null)");
  assert.equal((await A("/api/crm/analytics?from=2026-05-01&to=2026-05-31")).d.email_engagement.length, 0);

  // every drill is a valid rule tree
  const drills = [...AN.revenue_by_tier, ...AN.spend_distribution, ...AN.categories, ...K.members_by_tier].map((x) => x.drill).filter(Boolean);
  assert.ok(drills.length >= 7);
  for (const dr of drills) { const c = compileRules(dr); assert.deepEqual(c.errors, [], JSON.stringify(dr)); assert.ok(c.sql && c.sql !== "1=1"); }
  const lastBucket = AN.spend_distribution[4].drill, cnt = one(`SELECT count(*) c FROM crm_customers c WHERE ${compileRules(lastBucket).sql}`, ...compileRules(lastBucket).params).c;
  assert.equal(cnt, AN.spend_distribution[4].customers); ok(`${drills.length} drill rule trees compile, and a bucket's drill returns the same customers the chart counts`);

  // ── access control ──
  assert.equal((await A(R, undefined, "")).status, 401); assert.equal((await A("/api/crm/analytics", undefined, "")).status, 401);
  aenv.CRM_VIEW_EMAILS = "other@example.test";
  assert.equal((await A(R)).status, 403); assert.equal((await A("/api/crm/analytics")).status, 403);
  assert.equal((await A(R, undefined, await login("other@example.test"))).status, 200); ok("signed-out => 401; admin not in CRM_VIEW_EMAILS => 403; listed admin => 200");
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
