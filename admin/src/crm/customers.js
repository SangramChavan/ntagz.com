// Customers: directory, profile (summary, orders, timeline, interests), tags, notes, consent actions, CSV export, privacy export/erasure,
// tracking settings and data-retention purge. Reads existing order/user/loyalty/membership data through the crm_* views; adds nothing that
// duplicates the order, payment or loyalty workflows.
import LOYALTY from "../../../functions/lib/loyalty.js";
import CRMLIB from "../../../functions/lib/crm.js";
import { compileRules } from "./segments.js";
import { now, istDay, IST_OFFSET, PAGE_SIZE, pageOf, normEmail, sanitiseText, auditStmt, audit, csvRow, DEFS, POLICY_VERSION, EMAIL_RE } from "./common.js";

const DAY = 86400;
const INACTIVE_DAYS = 90, HIGH_VALUE_PAISE = 1000000; // ₹10,000 net paid: one named threshold used by the chips and the default segments
const ymd = /^\d{4}-\d{2}-\d{2}$/;
const istStart = (s) => Math.floor(Date.parse(s + "T00:00:00Z") / 1000) - IST_OFFSET;
const CKEY = /^(u:[0-9a-fA-F-]{8,64}|g:[^\s@/]+@[^\s@/]+\.[^\s@/]+)$/;
const qs = (n) => Array(n).fill("?").join(",");

// ── Directory filters ───────────────────────────────────────────────────────────────────────────────────────
// Every directory filter becomes a rule (segments.js) or one fixed SQL clause below, so "what the table shows" and "what a segment sends to"
// are the same thing.
const PRESETS = {
  new: [{ field: "days_since_first_seen", cmp: "lte", value: 30 }],
  never: [{ field: "never_purchased", cmp: "is", value: true }],
  one_time: [{ field: "paid_orders", cmp: "eq", value: 1 }],
  repeat: [{ field: "paid_orders", cmp: "gte", value: 2 }],
  high_value: [{ field: "net_paise", cmp: "gte", value: HIGH_VALUE_PAISE }],
  inactive: [{ field: "days_since_last_order", cmp: "gte", value: INACTIVE_DAYS }],
};
const CONSENT_SQL = {
  subscribed: "EXISTS (SELECT 1 FROM marketing_contacts mc WHERE mc.email = c.email AND mc.status = 'subscribed')",
  unsubscribed: "EXISTS (SELECT 1 FROM marketing_contacts mc WHERE mc.email = c.email AND mc.status = 'unsubscribed')",
  suppressed: "EXISTS (SELECT 1 FROM marketing_contacts mc WHERE mc.email = c.email AND mc.status = 'suppressed')",
  none: "NOT EXISTS (SELECT 1 FROM marketing_contacts mc WHERE mc.email = c.email)",
};
const money = (v) => { const n = Number(v); return v !== null && v !== "" && Number.isFinite(n) && n >= 0 && n < 1e9 ? Math.round(n * 100) : null; };
const intOf = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 && n < 1e7 ? n : null; };

function directoryWhere(sp) {
  const rules = [];
  const q = (sp.get("q") || "").trim(); if (q) rules.push({ field: "search", cmp: "contains", value: q });
  for (const p of (sp.get("preset") || "").split(",").filter(Boolean)) if (PRESETS[p]) rules.push(...PRESETS[p]);
  if (sp.get("type") === "registered" || sp.get("type") === "guest") rules.push({ field: "type", cmp: "eq", value: sp.get("type") });
  if (sp.get("tier")) rules.push({ field: "tier", cmp: "eq", value: sp.get("tier") });
  if (sp.get("product")) rules.push({ field: "bought_product", cmp: "has", value: sp.get("product") });
  if (sp.get("category")) rules.push({ field: "bought_category", cmp: "has", value: sp.get("category") });
  if (sp.get("tag")) rules.push({ field: "tag", cmp: "has", value: sp.get("tag") });
  const smin = money(sp.get("spend_min")), smax = money(sp.get("spend_max")), omin = intOf(sp.get("orders_min")), omax = intOf(sp.get("orders_max"));
  if (smin !== null) rules.push({ field: "net_paise", cmp: "gte", value: smin });
  if (smax !== null) rules.push({ field: "net_paise", cmp: "lte", value: smax });
  if (omin !== null) rules.push({ field: "paid_orders", cmp: "gte", value: omin });
  if (omax !== null) rules.push({ field: "paid_orders", cmp: "lte", value: omax });
  let tree = { op: "and", rules };
  const raw = sp.get("rules");
  if (raw) { try { const t = JSON.parse(raw); if (t && typeof t === "object" && raw.length < 8000) rules.push(t); else return { errors: ["Invalid rules"] }; } catch { return { errors: ["Invalid rules"] }; } }
  const c = compileRules(tree);
  if (c.errors.length) return { errors: c.errors };
  const sql = [c.sql], params = [...c.params];
  const consent = sp.get("consent"); if (consent) { if (!CONSENT_SQL[consent]) return { errors: ["Invalid consent filter"] }; sql.push(CONSENT_SQL[consent]); }
  if (sp.get("engaged") === "clicked") sql.push("EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.email = c.email AND r.clicked_at IS NOT NULL)");
  const lf = sp.get("last_from"), lt = sp.get("last_to");
  if (lf && ymd.test(lf) && !Number.isNaN(Date.parse(lf))) { sql.push("c.last_order_at >= ?"); params.push(istStart(lf)); }
  if (lt && ymd.test(lt) && !Number.isNaN(Date.parse(lt))) { sql.push("c.last_order_at < ?"); params.push(istStart(lt) + DAY); }
  return { sql: sql.join(" AND "), params, errors: [] };
}

const SORTS = { recent: "coalesce(c.first_seen_at, c.first_order_at, c.last_any_order_at)", last_order: "c.last_order_at", first_order: "c.first_order_at", orders: "c.paid_orders", spend: "c.net_paise", name: "lower(coalesce(c.name, ''))", email: "c.email" };

// Page-level enrichment: one query per metric for the (at most 25) rows shown, never one per row.
async function enrich(env, rows) {
  const uids = rows.map((r) => r.user_id).filter(Boolean), emails = rows.map((r) => r.email);
  const [tiers, spend, adj, consent, act] = await Promise.all([
    LOYALTY.loadTiers(env.DB),
    uids.length ? env.DB.prepare(`SELECT user_id, sum(qualifying_paise * (paid_paise - min(refunded_paise, paid_paise)) / paid_paise) s FROM orders
      WHERE user_id IN (${qs(uids.length)}) AND payment_status='paid' AND paid_paise>0 AND status NOT IN ('cancelled','returned') GROUP BY user_id`).bind(...uids).all() : { results: [] },
    uids.length ? env.DB.prepare(`SELECT user_id, sum(delta_paise) s FROM loyalty_adjustments WHERE user_id IN (${qs(uids.length)}) GROUP BY user_id`).bind(...uids).all() : { results: [] },
    emails.length ? env.DB.prepare(`SELECT email,status FROM marketing_contacts WHERE email IN (${qs(emails.length)})`).bind(...emails).all() : { results: [] },
    uids.length ? env.DB.prepare(`SELECT user_id, max(ts) t FROM crm_events WHERE user_id IN (${qs(uids.length)}) GROUP BY user_id`).bind(...uids).all() : { results: [] },
  ]);
  const S = new Map(spend.results.map((r) => [r.user_id, Number(r.s) || 0])), A = new Map(adj.results.map((r) => [r.user_id, Number(r.s) || 0]));
  const C = new Map(consent.results.map((r) => [r.email, r.status])), T = new Map(act.results.map((r) => [r.user_id, r.t]));
  const t = now();
  return rows.map((r) => {
    const q = r.user_id ? Math.max(0, Math.round((S.get(r.user_id) || 0) + (A.get(r.user_id) || 0))) : null;
    const tier = q === null ? null : LOYALTY.tierFor(q, tiers);
    const last = Math.max(r.last_any_order_at || 0, T.get(r.user_id) || 0) || null;
    return {
      ckey: r.ckey, type: r.type, name: r.name, email: r.email, phone: r.phone, first_seen_at: r.first_seen_at, first_order_at: r.first_order_at, last_order_at: r.last_order_at,
      paid_orders: r.paid_orders, qualifying_spend_paise: q, net_paise: r.net_paise, aov_paise: r.paid_orders ? Math.round(r.net_paise / r.paid_orders) : 0,
      tier: tier ? tier.id : null, tier_name: tier ? tier.name : null, consent: C.get(r.email) || "none", last_activity_at: last,
      status: !r.paid_orders ? "never_purchased" : r.last_order_at >= t - INACTIVE_DAYS * DAY ? "active" : "lapsed",
    };
  });
}

async function listCustomers(ctx) {
  const sp = ctx.url.searchParams, w = directoryWhere(sp);
  if (w.errors.length) return ctx.fail(400, w.errors[0]);
  const page = pageOf(sp), sort = SORTS[sp.get("sort")] || SORTS.recent, dir = sp.get("dir") === "asc" ? "ASC" : "DESC";
  const [tot, rows] = await Promise.all([
    ctx.env.DB.prepare(`SELECT count(*) n FROM crm_customers c WHERE ${w.sql}`).bind(...w.params).first(),
    ctx.env.DB.prepare(`SELECT c.* FROM crm_customers c WHERE ${w.sql} ORDER BY ${sort} ${dir} NULLS LAST, c.ckey LIMIT ? OFFSET ?`).bind(...w.params, PAGE_SIZE, (page - 1) * PAGE_SIZE).all(),
  ]);
  return ctx.json({ page, page_size: PAGE_SIZE, total: tot.n, more: page * PAGE_SIZE < tot.n, customers: await enrich(ctx.env, rows.results) });
}

// Export: server-side, same filters, allow-listed fields only, spreadsheet-safe cells, audited. Capped so one request stays small.
const EXPORT_MAX = 5000;
async function exportCustomers(ctx) {
  const sp = ctx.url.searchParams, w = directoryWhere(sp);
  if (w.errors.length) return ctx.fail(400, w.errors[0]);
  const { results } = await ctx.env.DB.prepare(`SELECT c.* FROM crm_customers c WHERE ${w.sql} ORDER BY c.ckey LIMIT ?`).bind(...w.params, EXPORT_MAX + 1).all();
  const truncated = results.length > EXPORT_MAX, rows = await enrich(ctx.env, results.slice(0, EXPORT_MAX));
  const d = (ts) => (ts ? istDay(ts) : ""), r2 = (p) => (p / 100).toFixed(2);
  let out = csvRow(["customer_id", "type", "name", "email", "phone", "first_seen", "first_order", "last_order", "paid_orders", "net_paid_inr", "avg_order_inr", "tier", "marketing_consent"]);
  for (const r of rows) out += csvRow([r.ckey, r.type, r.name, r.email, r.phone, d(r.first_seen_at), d(r.first_order_at), d(r.last_order_at), r.paid_orders, r2(r.net_paise), r2(r.aov_paise), r.tier_name, r.consent]);
  await audit(ctx.env, ctx.actor, "crm_export", { rows: rows.length, truncated, filters: Object.fromEntries([...sp.entries()].filter(([k]) => k !== "page")) });
  return new Response(out, { headers: { ...ctx.sec, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="customers-${istDay(now())}.csv"`, "Cache-Control": "no-store", ...(truncated ? { "X-Export-Truncated": "1" } : {}) } });
}

// ── Profile ──────────────────────────────────────────────────────────────────────────────────────────────────
async function loadCustomer(env, raw) {
  let key = ""; try { key = decodeURIComponent(raw); } catch { return null; }
  if (key.startsWith("g:")) key = key.toLowerCase();
  if (!CKEY.test(key)) return null;
  return await env.DB.prepare("SELECT * FROM crm_customers WHERE ckey=?").bind(key).first();
}
const productMap = async (env) => new Map((await env.DB.prepare("SELECT id,name,category FROM products").all()).results.map((p) => [p.id, p]));
const parseItems = (s) => { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a.filter((i) => i && typeof i.id === "string") : []; } catch { return []; } };

async function getProfile(ctx, m) {
  const { env } = ctx, c = await loadCustomer(env, m[1]);
  if (!c) return ctx.fail(404, "Customer not found");
  const sp = ctx.url.searchParams, f = [], p = [c.ckey];
  const of = sp.get("ofrom"), ot = sp.get("oto"), pay = sp.get("opay"), prod = sp.get("oproduct"), omin = money(sp.get("omin")), omax = money(sp.get("omax"));
  if (of && ymd.test(of)) { f.push("o.created_at >= ?"); p.push(istStart(of)); }
  if (ot && ymd.test(ot)) { f.push("o.created_at < ?"); p.push(istStart(ot) + DAY); }
  if (pay === "paid" || pay === "unpaid") { f.push("o.payment_status = ?"); p.push(pay); }
  if (prod && /^[A-Za-z0-9_-]{1,64}$/.test(prod)) { f.push("EXISTS (SELECT 1 FROM json_each(o.items_json) j WHERE json_extract(j.value,'$.id') = ?)"); p.push(prod); }
  if (omin !== null) { f.push("o.total >= ?"); p.push(omin); }
  if (omax !== null) { f.push("o.total <= ?"); p.push(omax); }
  const since = now() - 365 * DAY;
  const [orders, ships, prods, sav, trend, contact, clog, tags, notes, mem, lctx, linked] = await Promise.all([
    env.DB.prepare(`SELECT o.id,o.created_at,o.status,o.payment_status,o.payment_method,o.items_json,o.subtotal,o.gst,o.total,o.paid_paise,o.refunded_paise,o.shipping_paise,o.discount_paise,o.campaign_discount_paise,o.campaign_id,o.loyalty_tier,o.user_id,
        o.tracking_id,o.courier,x.counts,x.net_paise FROM crm_orders x JOIN orders o ON o.id = x.id WHERE x.ckey = ?${f.map((s) => " AND " + s).join("")} ORDER BY o.created_at DESC, o.rowid DESC LIMIT 100`).bind(...p).all(),
    env.DB.prepare("SELECT s.order_id,s.courier,s.awb,s.tracking_url,s.shipped_on,s.est_delivery FROM shipments s JOIN crm_orders x ON x.id = s.order_id WHERE x.ckey = ? ORDER BY s.created_at").bind(c.ckey).all(),
    productMap(env),
    env.DB.prepare("SELECT coalesce(sum(discount_paise),0) d, coalesce(sum(campaign_discount_paise),0) cd FROM crm_orders WHERE ckey=? AND counts=1").bind(c.ckey).first(),
    env.DB.prepare("SELECT strftime('%Y-%m', created_at + ?, 'unixepoch') m, count(*) n, sum(net_paise) net FROM crm_orders WHERE ckey=? AND counts=1 AND created_at>=? GROUP BY m ORDER BY m").bind(IST_OFFSET, c.ckey, since).all(),
    env.DB.prepare("SELECT status,source,policy_version,consented_at,unsubscribed_at,suppression_reason,updated_at FROM marketing_contacts WHERE email=?").bind(c.email).first(),
    env.DB.prepare("SELECT action,source,policy_version,actor,created_at FROM consent_log WHERE email=? ORDER BY created_at DESC, rowid DESC LIMIT 10").bind(c.email).all(),
    env.DB.prepare("SELECT tag FROM crm_tags WHERE ckey=? ORDER BY tag").bind(c.ckey).all(),
    env.DB.prepare("SELECT id,body,actor,created_at FROM crm_notes WHERE ckey=? ORDER BY created_at DESC, rowid DESC LIMIT 20").bind(c.ckey).all(),
    c.user_id ? env.DB.prepare("SELECT status,purchased_at,expires_at FROM memberships WHERE user_id=? ORDER BY purchased_at DESC LIMIT 5").bind(c.user_id).all() : { results: [] },
    c.user_id ? LOYALTY.loyaltyContext(env.DB, c.user_id, { loyaltyLive: false }) : null,
    c.user_id ? env.DB.prepare("SELECT count(*) n FROM orders WHERE user_id IS NULL AND lower(trim(email)) = ?").bind(c.email).first() : { n: 0 },
  ]);
  const t = now(), ships2 = new Map();
  for (const s of ships.results) (ships2.get(s.order_id) || ships2.set(s.order_id, []).get(s.order_id)).push(s);
  const n = c.paid_orders;
  const summary = {
    first_order_at: c.first_order_at, last_order_at: c.last_order_at, paid_orders: n, gross_paise: c.gross_paise, refund_paise: c.refund_paise, net_paise: c.net_paise, net_product_paise: c.net_product_paise,
    aov_paise: n ? Math.round(c.net_paise / n) : 0, days_since_last_order: c.last_order_at ? Math.floor((t - c.last_order_at) / DAY) : null,
    avg_days_between_orders: n > 1 ? Math.round((c.last_order_at - c.first_order_at) / DAY / (n - 1)) : null,
    refund_rate_pct: c.gross_paise ? Math.round((c.refund_paise * 1000) / c.gross_paise) / 10 : 0,
    membership_discount_savings_paise: Number(sav.d) || 0, campaign_discount_paise: Number(sav.cd) || 0,
    qualifying_spend_paise: lctx ? lctx.spend : null, tier: lctx && lctx.tier ? { id: lctx.tier.id, name: lctx.tier.name } : null,
    next_tier: lctx && lctx.next ? { id: lctx.next.id, name: lctx.next.name, remaining_paise: lctx.remaining } : null,
    best_category: null,
  };
  const cat = new Map();
  for (const o of orders.results) if (o.counts) for (const i of parseItems(o.items_json)) { const pc = prods.get(i.id); if (pc) cat.set(pc.category, (cat.get(pc.category) || 0) + (Number(i.qty) || 0)); }
  summary.best_category = [...cat.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return ctx.json({
    customer: { ckey: c.ckey, type: c.type, user_id: c.user_id, name: c.name, email: c.email, phone: c.phone, first_seen_at: c.first_seen_at,
      email_verified: c.type === "registered", phone_verified: null, // email is verified by sign-in OTP; phone verification is not supported
      linked_guest_orders: linked.n, // guest orders with an identical email, included in this customer's figures
    },
    summary, defs: DEFS,
    membership: mem.results.map((x) => ({ ...x, active: x.status === "active" && x.expires_at > t })),
    consent: { ...(contact || { status: "none" }), eligible: !!contact && contact.status === "subscribed", log: clog.results },
    tags: tags.results.map((x) => x.tag), notes: notes.results,
    orders: orders.results.map((o) => ({
      id: o.id, created_at: o.created_at, status: o.status, payment_status: o.payment_status, payment_method: o.payment_method, counts: !!o.counts,
      items: parseItems(o.items_json).map((i) => ({ id: i.id, name: prods.get(i.id)?.name || i.id, qty: Number(i.qty) || 0 })), // line prices are not stored on orders; totals are authoritative
      subtotal_paise: o.subtotal, gst_paise: o.gst, shipping_paise: o.shipping_paise, member_discount_paise: o.discount_paise, campaign_discount_paise: o.campaign_discount_paise,
      total_paise: o.total, paid_paise: o.paid_paise, refunded_paise: o.refunded_paise, net_paise: o.net_paise, loyalty_tier: o.loyalty_tier, guest: !o.user_id,
      shipments: ships2.get(o.id) || [], order_url: `#/orders?q=${o.id.slice(0, 8)}`,
    })),
    orders_truncated: orders.results.length >= 100,
    trend: trend.results,
  });
}

// ── Timeline (lazy, cursor-paged). `source`: 'record' = derived from authoritative order/account/consent records (history that always existed);
// 'tracked' = first-party activity events recorded since tracking was enabled. Nothing is invented for periods before tracking existed.
async function getTimeline(ctx, m) {
  const { env } = ctx, c = await loadCustomer(env, m[1]);
  if (!c) return ctx.fail(404, "Customer not found");
  const sp = ctx.url.searchParams, before = intOf(sp.get("before")) || now() + 1, limit = Math.min(intOf(sp.get("limit")) || 40, 100);
  const k = c.ckey, u = c.user_id || "", e = c.email;
  // D1 allows at most 5 terms in one compound SELECT, so the sources run as parallel queries (<=5 terms each) and are merged here.
  const S = [
    ["SELECT created_at ts, 'account_created' kind, NULL ref, NULL detail, 'record' source FROM users WHERE id = ?2", "SELECT created_at, 'order_placed', id, json_object('status', status, 'payment_status', payment_status, 'counts', counts), 'record' FROM crm_orders WHERE ckey = ?1",
      "SELECT p.created_at, 'payment_recorded', p.order_id, json_object('method', p.method, 'amount_paise', p.amount_paise), 'record' FROM payments p JOIN crm_orders x ON x.id = p.order_id WHERE x.ckey = ?1",
      "SELECT ev.created_at, 'order_' || ev.kind, ev.order_id, json_object('status', ev.status, 'note', ev.public_note), 'record' FROM order_events ev JOIN crm_orders x ON x.id = ev.order_id WHERE x.ckey = ?1 AND ev.customer_visible = 1",
      "SELECT r.created_at, 'refund', r.order_id, json_object('amount_paise', r.amount_paise, 'reason', r.reason), 'record' FROM order_refunds r JOIN crm_orders x ON x.id = r.order_id WHERE x.ckey = ?1"],
    ["SELECT created_at ts, 'membership_tier_changed' kind, NULL ref, json_object('from', from_tier, 'to', to_tier, 'reason', reason) detail, 'record' source FROM loyalty_tier_log WHERE user_id = ?2", "SELECT purchased_at, 'membership_purchased', NULL, json_object('expires_at', expires_at), 'record' FROM memberships WHERE user_id = ?2",
      "SELECT n.created_at, 'transactional_email', n.order_id, json_object('event', n.event, 'status', n.status), 'record' FROM notifications n JOIN crm_orders x ON x.id = n.order_id WHERE x.ckey = ?1",
      "SELECT created_at, 'consent_' || action, NULL, json_object('source', source, 'policy', policy_version), 'record' FROM consent_log WHERE email = ?3",
      "SELECT ts, event, product_id, json_object('path', path, 'term', term, 'category', category, 'utm_campaign', utm_campaign), 'tracked' FROM crm_events WHERE user_id = ?2"],
    ["SELECT sent_at ts, 'marketing_email_sent' kind, campaign_id ref, NULL detail, 'record' source FROM campaign_recipients WHERE email = ?3 AND sent_at IS NOT NULL", "SELECT delivered_at, 'marketing_email_delivered', campaign_id, NULL, 'record' FROM campaign_recipients WHERE email = ?3 AND delivered_at IS NOT NULL",
      "SELECT bounced_at, 'marketing_email_bounced', campaign_id, NULL, 'record' FROM campaign_recipients WHERE email = ?3 AND bounced_at IS NOT NULL", "SELECT clicked_at, 'marketing_email_clicked', campaign_id, json_object('clicks', click_count), 'record' FROM campaign_recipients WHERE email = ?3 AND clicked_at IS NOT NULL"],
  ];
  const parts = await Promise.all(S.map((g) => env.DB.prepare(`SELECT * FROM (${g.join(" UNION ALL ")}) WHERE ts IS NOT NULL AND ts < ?4 ORDER BY ts DESC LIMIT ?5`).bind(k, u, e, before, limit + 1).all()));
  const results = parts.flatMap((x) => x.results).sort((a, b) => b.ts - a.ts).slice(0, limit + 1);
  const prods = await productMap(env), more = results.length > limit;
  const rows = results.slice(0, limit).map((r) => {
    let d = null; try { d = r.detail ? JSON.parse(r.detail) : null; } catch { /* leave null */ }
    const product = r.source === "tracked" && r.ref ? prods.get(r.ref)?.name || r.ref : null;
    return { ts: r.ts, kind: r.kind, ref: r.ref, product, detail: d, source: r.source, order_url: r.kind.startsWith("order") || r.kind === "refund" || r.kind === "payment_recorded" ? `#/orders?q=${String(r.ref).slice(0, 8)}` : null };
  });
  const tr = await env.DB.prepare("SELECT min(ts) first_ts, count(*) n FROM crm_events WHERE user_id = ?").bind(u).first();
  return ctx.json({ events: rows, more, next_before: more ? rows[rows.length - 1].ts : null,
    tracking: { events_recorded: tr.n, first_tracked_at: tr.first_ts, note: "Activity before tracking was enabled is not available. Order, payment, refund, membership and consent history comes from existing records." } });
}

// ── Product interests: facts (observed) are separate from inferences (derived, labelled). ──────────────────────
async function getInterests(ctx, m) {
  const { env } = ctx, c = await loadCustomer(env, m[1]);
  if (!c) return ctx.fail(404, "Customer not found");
  const [lines, viewed, prods] = await Promise.all([
    env.DB.prepare(`SELECT o.id oid, o.created_at ts, json_extract(j.value,'$.id') pid, json_extract(j.value,'$.qty') qty FROM crm_orders o, json_each(o.items_json) j
      WHERE o.ckey = ? AND o.counts = 1 ORDER BY o.created_at DESC LIMIT 500`).bind(c.ckey).all(),
    c.user_id ? env.DB.prepare("SELECT product_id pid, count(*) n, max(ts) last_ts FROM crm_events WHERE user_id=? AND event='product_view' AND product_id IS NOT NULL GROUP BY product_id ORDER BY n DESC, last_ts DESC LIMIT 10").bind(c.user_id).all() : { results: [] },
    productMap(env),
  ]);
  const by = new Map(), cats = new Map();
  for (const l of lines.results) {
    const q = Number(l.qty) || 0, e = by.get(l.pid) || by.set(l.pid, { pid: l.pid, qty: 0, orders: new Set(), qtys: new Map(), dates: [] }).get(l.pid);
    e.qty += q; e.orders.add(l.oid); e.qtys.set(q, (e.qtys.get(q) || 0) + 1); e.dates.push(l.ts);
    const cat = prods.get(l.pid)?.category; if (cat) cats.set(cat, (cats.get(cat) || 0) + q);
  }
  const bought = [...by.values()].sort((a, b) => b.qty - a.qty).slice(0, 10).map((e) => ({
    id: e.pid, name: prods.get(e.pid)?.name || e.pid, qty: e.qty, orders: e.orders.size,
    typical_qty: [...e.qtys.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0], last_at: Math.max(...e.dates),
  }));
  const last = lines.results[0] || null;
  // Inference 1: repeat-buy cadence. Only offered for a product bought on 3+ separate days; says nothing about whether it is consumable.
  const cadence = [];
  for (const e of by.values()) {
    const days = [...new Set(e.dates.map((d) => Math.floor(d / DAY)))].sort((a, b) => a - b);
    if (days.length >= 3) { const gaps = days.slice(1).map((d, i) => d - days[i]).sort((a, b) => a - b), med = gaps[Math.floor(gaps.length / 2)]; cadence.push({ id: e.pid, name: prods.get(e.pid)?.name || e.pid, median_days: med, expected_next_at: (days[days.length - 1] + med) * DAY, purchases: days.length }); }
  }
  // Inference 2: what customers who bought the same products also bought, which this customer has not (support = number of other customers).
  let also = [];
  const top = bought.slice(0, 3).map((b) => b.id);
  if (top.length) {
    const { results } = await env.DB.prepare(`SELECT json_extract(j2.value,'$.id') pid, count(DISTINCT o2.ckey) n FROM crm_orders o1, json_each(o1.items_json) j1, crm_orders o2, json_each(o2.items_json) j2
      WHERE o1.counts = 1 AND o2.counts = 1 AND o2.ckey = o1.ckey AND o1.ckey <> ? AND json_extract(j1.value,'$.id') IN (${qs(top.length)})
        AND json_extract(j2.value,'$.id') NOT IN (SELECT json_extract(j.value,'$.id') FROM crm_orders o, json_each(o.items_json) j WHERE o.ckey = ? AND o.counts = 1)
      GROUP BY pid ORDER BY n DESC LIMIT 5`).bind(c.ckey, ...top, c.ckey).all();
    also = results.filter((r) => prods.has(r.pid)).map((r) => ({ id: r.pid, name: prods.get(r.pid).name, other_customers: r.n }));
  }
  return ctx.json({
    observed: {
      most_purchased: bought, favourite_categories: [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([category, units]) => ({ category, units })),
      most_viewed: viewed.results.map((v) => ({ id: v.pid, name: prods.get(v.pid)?.name || v.pid, views: v.n, last_at: v.last_ts })), viewed_available: !!c.user_id,
      last_purchased: last ? { id: last.pid, name: prods.get(last.pid)?.name || last.pid, at: last.ts } : null,
    },
    inferred: { repeat_cadence: cadence, also_bought_by_similar_customers: also,
      note: "Inferred from this store's own order patterns. These are suggestions, not facts about the customer; no assumption is made that any product is consumable." },
  });
}

async function getCampaignHistory(ctx, m) {
  const c = await loadCustomer(ctx.env, m[1]);
  if (!c) return ctx.fail(404, "Customer not found");
  const { results } = await ctx.env.DB.prepare(`SELECT r.campaign_id, k.name, r.status, r.sent_at, r.delivered_at, r.clicked_at, r.click_count
    FROM campaign_recipients r JOIN campaigns k ON k.id = r.campaign_id WHERE r.email = ? ORDER BY coalesce(r.sent_at, 0) DESC, r.rowid DESC LIMIT 50`).bind(c.email).all();
  return ctx.json({ campaigns: results });
}

// ── Admin actions on a customer ────────────────────────────────────────────────────────────────────────────────
async function editTags(ctx, m) {
  const { env, actor, body } = ctx, c = await loadCustomer(env, m[1]);
  if (!c) return ctx.fail(404, "Customer not found");
  const clean = (a) => (Array.isArray(a) ? [...new Set(a.map((t) => (typeof t === "string" ? t.trim().toLowerCase() : "")).filter((t) => /^[a-z0-9][a-z0-9 _-]{0,29}$/.test(t)))].slice(0, 10) : []);
  const add = clean(body.add), rem = clean(body.remove);
  if (!add.length && !rem.length) return ctx.fail(400, "Nothing to change");
  const have = await env.DB.prepare("SELECT count(*) n FROM crm_tags WHERE ckey=?").bind(c.ckey).first();
  if (have.n + add.length > 30) return ctx.fail(400, "A customer can have at most 30 tags");
  await env.DB.batch([...add.map((t) => env.DB.prepare("INSERT OR IGNORE INTO crm_tags (ckey,tag,actor) VALUES (?,?,?)").bind(c.ckey, t, actor)),
    ...rem.map((t) => env.DB.prepare("DELETE FROM crm_tags WHERE ckey=? AND tag=?").bind(c.ckey, t)), auditStmt(env, actor, "crm_tags", { ckey: c.ckey, add, remove: rem })]);
  return ctx.json({ tags: (await env.DB.prepare("SELECT tag FROM crm_tags WHERE ckey=? ORDER BY tag").bind(c.ckey).all()).results.map((x) => x.tag) });
}

// Bulk tagging for the directory (selected ckeys or the current filter, capped).
async function bulkTags(ctx) {
  const { env, actor, body } = ctx, tag = typeof body.tag === "string" ? body.tag.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9 _-]{0,29}$/.test(tag)) return ctx.fail(400, "Invalid tag");
  const keys = Array.isArray(body.ckeys) ? [...new Set(body.ckeys.filter((k) => typeof k === "string" && CKEY.test(k)))].slice(0, 500) : [];
  if (!keys.length) return ctx.fail(400, "Select customers first");
  if (body.confirm !== true) return ctx.fail(400, "Confirmation required");
  const rm = body.remove === true;
  await env.DB.batch([...keys.map((k) => rm ? env.DB.prepare("DELETE FROM crm_tags WHERE ckey=? AND tag=?").bind(k, tag) : env.DB.prepare("INSERT OR IGNORE INTO crm_tags (ckey,tag,actor) SELECT ?1,?2,?3 WHERE EXISTS (SELECT 1 FROM crm_customers WHERE ckey=?1)").bind(k, tag, actor)),
    auditStmt(env, actor, "crm_tags_bulk", { tag, remove: rm, count: keys.length })]);
  return ctx.json({ ok: true, count: keys.length });
}

async function addNote(ctx, m) {
  const { env, actor, body } = ctx, c = await loadCustomer(env, m[1]);
  if (!c) return ctx.fail(404, "Customer not found");
  const text = sanitiseText(body.body, 1000);
  if (text.length < 2) return ctx.fail(400, "Write a note (2–1000 characters)");
  const have = await env.DB.prepare("SELECT count(*) n FROM crm_notes WHERE ckey=?").bind(c.ckey).first();
  if (have.n >= 200) return ctx.fail(400, "Too many notes on this customer");
  const id = crypto.randomUUID();
  await env.DB.batch([env.DB.prepare("INSERT INTO crm_notes (id,ckey,body,actor) VALUES (?,?,?,?)").bind(id, c.ckey, text, actor), auditStmt(env, actor, "crm_note", { ckey: c.ckey, note_id: id })]);
  return ctx.json({ id, body: text, actor, created_at: now() }, 201);
}

// Permitted metadata for REGISTERED customers only: name and phone. Email is the login identity and is never edited here.
async function editMeta(ctx, m) {
  const { env, actor, body } = ctx, c = await loadCustomer(env, m[1]);
  if (!c) return ctx.fail(404, "Customer not found");
  if (!c.user_id) return ctx.fail(400, "Guest customers have no account to edit");
  const name = body.name === undefined ? c.name : sanitiseText(body.name, 100), phone = body.phone === undefined ? c.phone : String(body.phone).replace(/\D/g, "").slice(-10);
  if (phone && phone.length !== 10) return ctx.fail(400, "Phone must be 10 digits");
  await env.DB.batch([env.DB.prepare("UPDATE users SET name=?, phone=? WHERE id=?").bind(name || null, phone || null, c.user_id),
    auditStmt(env, actor, "crm_customer_edit", { ckey: c.ckey, name: { from: c.name, to: name }, phone: { from: c.phone ? "…" + String(c.phone).slice(-4) : null, to: phone ? "…" + phone.slice(-4) : null } })]);
  return ctx.json({ ok: true });
}

// Admin consent actions. Admins can withdraw or block marketing, never grant it: an opt-in must come from the customer.
async function consentAction(ctx, m) {
  const { env, actor, body } = ctx, c = await loadCustomer(env, m[1]);
  if (!c) return ctx.fail(404, "Customer not found");
  const status = { unsubscribe: "unsubscribed", suppress: "suppressed", unsuppress: "unsuppress" }[body.action];
  if (!status || !EMAIL_RE.test(c.email)) return ctx.fail(400, "Invalid action");
  if (body.confirm !== true) return ctx.fail(400, "Confirmation required");
  const reason = sanitiseText(body.reason, 200);
  if (status !== "unsubscribed" && reason.length < 3) return ctx.fail(400, "Give a reason");
  await env.DB.batch([...CRMLIB.consentStatements(env.DB, { email: c.email, userId: c.user_id, status, source: "admin", actor, reason: "manual", detail: reason, policy: POLICY_VERSION }),
    auditStmt(env, actor, "crm_consent", { ckey: c.ckey, action: body.action, reason })]);
  return ctx.json({ ok: true });
}

// ── Privacy ──────────────────────────────────────────────────────────────────────────────────────────────────
// Access request: everything held about this customer, as JSON. Never includes payment-provider data or credentials (none are stored here).
async function exportOne(ctx, m) {
  const { env } = ctx, c = await loadCustomer(env, m[1]);
  if (!c) return ctx.fail(404, "Customer not found");
  const [orders, events, log, tags, notes, camps, addr] = await Promise.all([
    env.DB.prepare("SELECT o.id,o.created_at,o.status,o.payment_status,o.payment_method,o.items_json,o.subtotal,o.gst,o.total,o.name,o.phone,o.email,o.address,o.pincode,o.state,o.gstin FROM orders o JOIN crm_orders x ON x.id=o.id WHERE x.ckey=? ORDER BY o.created_at").bind(c.ckey).all(),
    c.user_id ? env.DB.prepare("SELECT ts,event,product_id,category,path,term,utm_source,utm_medium,utm_campaign FROM crm_events WHERE user_id=? ORDER BY ts LIMIT 5000").bind(c.user_id).all() : { results: [] },
    env.DB.prepare("SELECT action,source,policy_version,created_at FROM consent_log WHERE email=? ORDER BY created_at").bind(c.email).all(),
    env.DB.prepare("SELECT tag FROM crm_tags WHERE ckey=?").bind(c.ckey).all(), env.DB.prepare("SELECT body,created_at FROM crm_notes WHERE ckey=?").bind(c.ckey).all(),
    env.DB.prepare("SELECT campaign_id,status,sent_at,clicked_at FROM campaign_recipients WHERE email=?").bind(c.email).all(),
    c.user_id ? env.DB.prepare("SELECT label,name,phone,line1,city,state,pincode FROM addresses WHERE user_id=?").bind(c.user_id).all() : { results: [] },
  ]);
  await audit(env, ctx.actor, "crm_customer_export", { ckey: c.ckey });
  const out = { exported_at: now(), customer: { ckey: c.ckey, type: c.type, name: c.name, email: c.email, phone: c.phone, created_at: c.first_seen_at }, addresses: addr.results, orders: orders.results, activity_events: events.results,
    consent_history: log.results, marketing_emails: camps.results, internal_tags: tags.results.map((t) => t.tag), internal_notes: notes.results };
  return new Response(JSON.stringify(out, null, 2), { headers: { ...ctx.sec, "Content-Type": "application/json", "Content-Disposition": `attachment; filename="customer-data-${istDay(now())}.json"`, "Cache-Control": "no-store" } });
}

// Verified erasure request. Orders, invoices and payments are statutory accounting records and are RETAINED (as the privacy policy must say);
// everything else personal is removed or anonymised. The admin must type the customer's email to confirm and record the request reference.
async function erase(ctx, m) {
  const { env, actor, body } = ctx, c = await loadCustomer(env, m[1]);
  if (!c) return ctx.fail(404, "Customer not found");
  if (normEmail(body.confirm_email) !== c.email) return ctx.fail(400, "Type the customer's email exactly to confirm");
  const ref = sanitiseText(body.request_ref, 120);
  if (ref.length < 3) return ctx.fail(400, "Record how the request was verified (e.g. ticket or email reference)");
  const open = await env.DB.prepare("SELECT count(*) n FROM crm_orders WHERE ckey=? AND status NOT IN ('delivered','cancelled','returned')").bind(c.ckey).first();
  if (open.n > 0) return ctx.fail(409, "This customer has orders still in progress. Finish or cancel them first.");
  const stmts = [
    env.DB.prepare("DELETE FROM crm_tags WHERE ckey=?").bind(c.ckey), env.DB.prepare("DELETE FROM crm_notes WHERE ckey=?").bind(c.ckey),
    env.DB.prepare("DELETE FROM consent_log WHERE email=?").bind(c.email), env.DB.prepare("DELETE FROM marketing_contacts WHERE email=?").bind(c.email),
    env.DB.prepare("DELETE FROM journey_runs WHERE email=?").bind(c.email), env.DB.prepare("UPDATE campaign_recipients SET email = 'erased:' || id, user_id = NULL, provider_id = NULL, detail = NULL WHERE email = ?").bind(c.email),
  ];
  if (c.user_id) stmts.push(
    env.DB.prepare("DELETE FROM crm_events WHERE user_id=?").bind(c.user_id), env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(c.user_id),
    env.DB.prepare("DELETE FROM addresses WHERE user_id=?").bind(c.user_id), env.DB.prepare("DELETE FROM otp_tokens WHERE email=?").bind(c.email),
    env.DB.prepare("UPDATE users SET name=NULL, phone=NULL, gstin=NULL, email=? WHERE id=?").bind(`erased-${c.user_id.slice(0, 8)}@erased.invalid`, c.user_id));
  stmts.push(auditStmt(env, actor, "crm_erase", { ckey_hash: (await crypto.subtle.digest("SHA-256", new TextEncoder().encode(c.ckey)).then((b) => [...new Uint8Array(b)].slice(0, 6).map((x) => x.toString(16).padStart(2, "0")).join(""))), request_ref: ref, orders_retained: c.orders_all }));
  await env.DB.batch(stmts);
  return ctx.json({ ok: true, retained: "Orders and payment records are kept for statutory accounting. Personal profile, consent, activity and notes were removed." });
}

// ── Settings (tracking switch + retention), stored in the existing membership_config key/value table ───────────────
const RETENTION_DEFAULT = 180;
async function readSettings(env) {
  const { results } = await env.DB.prepare("SELECT key,value FROM membership_config WHERE key IN ('crm_tracking_enabled','crm_event_retention_days')").all();
  const c = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return { tracking_enabled: c.crm_tracking_enabled === "1", retention_days: Math.min(Math.max(parseInt(c.crm_event_retention_days, 10) || RETENTION_DEFAULT, 30), 730) };
}
async function getSettings(ctx) {
  const s = await readSettings(ctx.env);
  const [ev, subs] = await Promise.all([ctx.env.DB.prepare("SELECT count(*) n, min(ts) first_ts FROM crm_events").first(), ctx.env.DB.prepare("SELECT status, count(*) n FROM marketing_contacts GROUP BY status").all()]);
  return ctx.json({ ...s, policy_version: POLICY_VERSION, events_stored: ev.n, first_event_at: ev.first_ts, contacts: Object.fromEntries(subs.results.map((r) => [r.status, r.n])), permissions: ctx.perms, inactive_days: INACTIVE_DAYS, high_value_paise: HIGH_VALUE_PAISE, defs: DEFS,
    events_tracked: ["page_view", "product_view", "search", "add_to_cart", "remove_from_cart", "begin_checkout", "membership_view", "email_click"], events_from_records: ["purchase (from orders)", "refund (from order_refunds)", "membership_tier_changed (from loyalty_tier_log)"] });
}
async function saveSettings(ctx) {
  const { env, actor, body } = ctx, cur = await readSettings(env), next = { ...cur };
  if (body.tracking_enabled !== undefined) { if (typeof body.tracking_enabled !== "boolean") return ctx.fail(400, "Invalid value"); next.tracking_enabled = body.tracking_enabled; }
  if (body.retention_days !== undefined) { const d = intOf(body.retention_days); if (d === null || d < 30 || d > 730) return ctx.fail(400, "Retention must be 30–730 days"); next.retention_days = d; }
  const up = (k, v) => env.DB.prepare("INSERT INTO membership_config (key,value,updated_at) VALUES (?1,?2,unixepoch()) ON CONFLICT(key) DO UPDATE SET value=?2, updated_at=unixepoch()").bind(k, v);
  await env.DB.batch([up("crm_tracking_enabled", next.tracking_enabled ? "1" : "0"), up("crm_event_retention_days", String(next.retention_days)), auditStmt(env, actor, "crm_settings", { from: cur, to: next })]);
  return getSettings(ctx);
}

// ── Retention (cron) ──────────────────────────────────────────────────────────────────────────────────────────
export async function purgeExpired(env) {
  const { retention_days } = await readSettings(env), t = now();
  const del = (sql, ...b) => env.DB.prepare(sql).bind(...b).run();
  await del("DELETE FROM crm_events WHERE id IN (SELECT id FROM crm_events WHERE ts < ? LIMIT 5000)", t - retention_days * DAY);
  await del("DELETE FROM email_webhook_events WHERE created_at < ?", t - 30 * DAY);
  await del("DELETE FROM journey_runs WHERE id IN (SELECT id FROM journey_runs WHERE created_at < ? LIMIT 2000)", t - 400 * DAY);
}

export const routes = [
  { m: "GET", p: /^\/api\/crm\/customers$/, perm: "view", h: listCustomers },
  { m: "GET", p: /^\/api\/crm\/customers\/export\.csv$/, perm: "export", h: exportCustomers },
  { m: "POST", p: /^\/api\/crm\/customers\/bulk-tag$/, perm: "manage", h: bulkTags },
  { m: "GET", p: /^\/api\/crm\/customers\/([^/]+)$/, perm: "view", h: getProfile },
  { m: "GET", p: /^\/api\/crm\/customers\/([^/]+)\/timeline$/, perm: "view", h: getTimeline },
  { m: "GET", p: /^\/api\/crm\/customers\/([^/]+)\/interests$/, perm: "view", h: getInterests },
  { m: "GET", p: /^\/api\/crm\/customers\/([^/]+)\/campaigns$/, perm: "view", h: getCampaignHistory },
  { m: "POST", p: /^\/api\/crm\/customers\/([^/]+)\/tags$/, perm: "manage", h: editTags },
  { m: "POST", p: /^\/api\/crm\/customers\/([^/]+)\/notes$/, perm: "manage", h: addNote },
  { m: "POST", p: /^\/api\/crm\/customers\/([^/]+)\/meta$/, perm: "manage", h: editMeta },
  { m: "POST", p: /^\/api\/crm\/customers\/([^/]+)\/consent$/, perm: "manage", h: consentAction },
  { m: "GET", p: /^\/api\/crm\/customers\/([^/]+)\/data\.json$/, perm: "export", h: exportOne },
  { m: "POST", p: /^\/api\/crm\/customers\/([^/]+)\/erase$/, perm: "export", h: erase }, // erasure is owner-level, like export
  { m: "GET", p: /^\/api\/crm\/settings$/, perm: "view", h: getSettings },
  { m: "POST", p: /^\/api\/crm\/settings$/, perm: "manage", h: saveSettings },
];
