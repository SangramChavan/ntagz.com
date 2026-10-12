// CRM analytics: KPI overview + chart datasets. Read-only. All numbers are aggregated in SQL over the crm_orders view
// (counts = 1 is the only revenue) and every money value is paise. Days/weeks/months are Indian Standard Time (see DEFS.period).
// Each function runs a small, fixed number of queries in parallel; nothing loads per-customer rows into JS.
import { rangeOf, istDay, DEFS, IST_OFFSET } from "./common.js";

const DAY = 86400, LAPSE_DAYS = 90;
export const SPEND_EDGES_PAISE = [100000, 300000, 1000000]; // ₹1,000 / ₹3,000 / ₹10,000: bucket edges for the spend distribution
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // same shape segments.js accepts for ids
const rule = (field, cmp, value) => ({ field, cmp, value });
const all = (env, sql, ...a) => env.DB.prepare(sql).bind(...a).all().then((r) => r.results);
const first = (env, sql, ...a) => env.DB.prepare(sql).bind(...a).first();
const n0 = (v) => Number(v) || 0;
const ratio = (a, b) => (b > 0 ? a / b : null); // null = no denominator: shown as "Not available", never as 0
const rangeJson = (r) => ({ from: r.from, to: r.to, label: r.label, days: r.days, from_day: r.from_day, to_day: r.to_day });

// ── Overview ────────────────────────────────────────────────────────────────────────────────────
// Revenue, unpaid and cancelled value for orders created in [from, to). Includes orders with no customer key.
const moneySql = `SELECT
  coalesce(sum(CASE WHEN c.counts = 1 THEN c.gross_paise END), 0) gross, coalesce(sum(CASE WHEN c.counts = 1 THEN c.refund_paise END), 0) refunds,
  coalesce(sum(c.net_paise), 0) net, coalesce(sum(c.net_product_paise), 0) net_product, coalesce(sum(c.net_gst_paise), 0) gst, coalesce(sum(c.net_shipping_paise), 0) shipping,
  coalesce(sum(c.counts), 0) paid_orders,
  coalesce(sum(CASE WHEN c.payment_status <> 'paid' AND c.status NOT IN ('cancelled', 'returned') THEN o.total END), 0) pending,
  coalesce(sum(CASE WHEN c.payment_status <> 'paid' AND c.status NOT IN ('cancelled', 'returned') THEN 1 END), 0) pending_orders,
  coalesce(sum(CASE WHEN c.status IN ('cancelled', 'returned') THEN CASE WHEN c.payment_status = 'paid' THEN o.paid_paise ELSE o.total END END), 0) cancelled
  FROM crm_orders c JOIN orders o ON o.id = c.id WHERE c.created_at >= ?1 AND c.created_at < ?2`;
// One row per customer who has bought up to the period end: lifetime figures as of `to`, and activity inside [from, to).
const peopleSql = `WITH b AS (SELECT ckey, count(*) n, sum(net_paise) net, min(created_at) fo, max(created_at) lo, sum(created_at >= ?1) in_n
    FROM crm_orders WHERE counts = 1 AND ckey IS NOT NULL AND created_at < ?2 GROUP BY ckey)
  SELECT count(*) buyers, coalesce(sum(n >= 2), 0) repeaters, coalesce(sum(net), 0) life_net, coalesce(sum(fo >= ?1), 0) new_c,
    coalesce(sum(in_n > 0), 0) active, coalesce(sum(in_n > 0 AND fo < ?1), 0) returning_c, coalesce(sum(in_n), 0) cust_orders,
    coalesce(sum(lo < ?2 - ${LAPSE_DAYS * DAY}), 0) lapsed FROM b`;
const baseSql = `SELECT (SELECT count(*) FROM users WHERE coalesce(created_at, 0) >= ?1 AND coalesce(created_at, 0) < ?2) new_accounts,
  (SELECT count(*) FROM users WHERE coalesce(created_at, 0) < ?2)
  + (SELECT count(*) FROM (SELECT 1 FROM crm_orders WHERE ckey LIKE 'g:%' GROUP BY ckey HAVING min(created_at) < ?2)) total_customers`;
// Campaigns finished in the period, with recipient-level counts (a recipient is "delivered" only on a provider delivery event).
const campSql = `SELECT count(DISTINCT c.id) campaigns, count(r.id) recipients, coalesce(sum(r.sent_at IS NOT NULL), 0) sent,
  coalesce(sum(r.delivered_at IS NOT NULL OR r.status = 'delivered'), 0) delivered, coalesce(sum(r.bounced_at IS NOT NULL OR r.status = 'bounced'), 0) bounced,
  coalesce(sum(r.clicked_at IS NOT NULL), 0) clicks FROM campaigns c LEFT JOIN campaign_recipients r ON r.campaign_id = c.id
  WHERE c.status = 'sent' AND coalesce(c.finished_at, c.started_at) >= ?1 AND coalesce(c.finished_at, c.started_at) < ?2`;

async function periodKpis(env, from, to) {
  const [m, p, b, c] = await Promise.all([first(env, moneySql, from, to), first(env, peopleSql, from, to), first(env, baseSql, from, to), first(env, campSql, from, to)]);
  const campaigns = n0(c.campaigns) === 0 ? null : {
    sent_campaigns: n0(c.campaigns), recipients: n0(c.recipients), sent: n0(c.sent),
    delivered: n0(c.delivered) + n0(c.bounced) > 0 ? n0(c.delivered) : null, bounced: n0(c.delivered) + n0(c.bounced) > 0 ? n0(c.bounced) : null,
    unique_clicks: n0(c.clicks),
  };
  return {
    total_customers: n0(b.total_customers), new_accounts: n0(b.new_accounts), new_customers: n0(p.new_c), returning_customers: n0(p.returning_c),
    first_purchasers: n0(p.new_c), active_customers: n0(p.active), lapsed_customers: n0(p.lapsed),
    gross_paid: n0(m.gross), refunds: n0(m.refunds), net_paid: n0(m.net), net_product: n0(m.net_product), gst: n0(m.gst), shipping: n0(m.shipping),
    paid_orders: n0(m.paid_orders), pending_unpaid_value: n0(m.pending), pending_unpaid_orders: n0(m.pending_orders), cancelled_value: n0(m.cancelled),
    aov: ratio(n0(m.net), n0(m.paid_orders)) === null ? null : Math.round(n0(m.net) / n0(m.paid_orders)),
    orders_per_customer: ratio(n0(p.cust_orders), n0(p.active)), repeat_rate: ratio(n0(p.repeaters), n0(p.buyers)),
    ltv: ratio(n0(p.life_net), n0(p.buyers)) === null ? null : Math.round(n0(p.life_net) / n0(p.buyers)),
    campaigns,
  };
}

const OVERVIEW_DEFS = {
  total_customers: "Registered accounts created by the period end plus guest emails whose first order is on or before it. Orders with no email and no account are not customers.",
  new_accounts: "Registered accounts created inside the period (whether or not they have bought).",
  new_customers: "Customers whose first paid order falls inside the period. " + DEFS.new_customer,
  returning_customers: DEFS.returning_customer,
  first_purchasers: "Customers making their first paid purchase inside the period. Same rule as New customers (the definitions treat them as one group).",
  active_customers: DEFS.active_customer,
  lapsed_customers: `Customers who bought before, whose last paid order (up to the period end) is older than ${LAPSE_DAYS} days. See: ${DEFS.inactive_customer}`,
  gross_paid: DEFS.gross_paid, refunds: DEFS.refunds, net_paid: DEFS.net_paid, net_product: DEFS.net_product,
  gst: "GST included in net paid revenue, refund-adjusted in proportion.", shipping: "Shipping included in net paid revenue, refund-adjusted in proportion.",
  pending_unpaid_value: "Order value of orders not yet paid and not cancelled/returned. Shown separately; it is never revenue.",
  cancelled_value: "Order value of cancelled or returned orders created in the period. Never revenue.",
  aov: DEFS.aov, orders_per_customer: DEFS.orders_per_customer, repeat_rate: DEFS.repeat_rate, ltv: DEFS.ltv,
  members_by_tier: "Registered customers per Rewards tier today (a snapshot, not tied to the period). 'Not yet recorded' = no tier stored on the account yet.",
  email_subscribers: DEFS.email_eligible + " Snapshot of today.",
  unsubscribed: "Contacts who have unsubscribed. Snapshot of today.", suppressed: "Contacts we must not email (bounce, complaint or manual). Snapshot of today.",
  campaigns: "Campaigns finished inside the period. Delivered/bounced appear only once the email provider reports delivery events; clicks are recorded only through tracked campaign links.",
  period: DEFS.period,
};

async function overview(ctx) {
  const { env, url } = ctx, r = rangeOf(url.searchParams);
  const [kpis, prev, tiers, subs] = await Promise.all([
    periodKpis(env, r.from, r.to), periodKpis(env, r.prev_from, r.prev_to),
    all(env, `SELECT t.id, coalesce(t.name, 'Not yet recorded') name, count(*) n FROM users u LEFT JOIN loyalty_tiers t ON t.id = u.loyalty_tier_id GROUP BY t.id ORDER BY (t.id IS NULL), t.sort_order`),
    all(env, "SELECT status, count(*) n FROM marketing_contacts GROUP BY status"),
  ]);
  const sub = Object.fromEntries(subs.map((s) => [s.status, s.n]));
  Object.assign(kpis, {
    members_by_tier: tiers.map((t) => ({ id: t.id, name: t.name, count: t.n, ...(t.id ? { drill: { op: "and", rules: [rule("tier", "eq", t.id)] } } : {}) })),
    email_subscribers: n0(sub.subscribed), unsubscribed: n0(sub.unsubscribed), suppressed: n0(sub.suppressed),
  });
  // Snapshot KPIs have no history, so they have no previous-period value.
  for (const k of ["members_by_tier", "email_subscribers", "unsubscribed", "suppressed"]) prev[k] = null;
  return ctx.json({ range: rangeJson(r), kpis, prev, defs: OVERVIEW_DEFS, lapse_days: LAPSE_DAYS });
}

// ── Charts ──────────────────────────────────────────────────────────────────────────────────────
const monthOf = (ts) => istDay(ts).slice(0, 7);
const monthIdx = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const monthName = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
const lastMonths = (endTs, n) => { const e = monthIdx(monthOf(endTs)); return Array.from({ length: n }, (_, i) => monthName(e - n + 1 + i)); };

async function analytics(ctx) {
  const { env, url } = ctx, r = rangeOf(url.searchParams);
  const step = r.days <= 45 ? DAY : 7 * DAY, bucketKind = r.days <= 45 ? "day" : "week";
  const nb = Math.ceil((r.to - r.from) / step), months = lastMonths(r.to - 1, 12);
  const cohortFromTs = Date.parse(months[0] + "-01T00:00:00Z") / 1000 - IST_OFFSET; // first IST instant of the oldest cohort month
  const [flow, rep, coh, cohSize, tiers, spend, cats, camps, attrib] = await Promise.all([
    // customers active per bucket, split into new (their first paid order is in this bucket) and returning
    all(env, `WITH f AS (SELECT ckey, min(created_at) fo FROM crm_orders WHERE counts = 1 AND ckey IS NOT NULL GROUP BY ckey)
      SELECT CAST((o.created_at - ?1) / ?3 AS INTEGER) b, count(DISTINCT o.ckey) active, count(DISTINCT CASE WHEN f.fo >= ?1 AND CAST((f.fo - ?1) / ?3 AS INTEGER) = CAST((o.created_at - ?1) / ?3 AS INTEGER) THEN o.ckey END) new_c,
        count(DISTINCT CASE WHEN f.fo >= ?1 AND CAST((f.fo - ?1) / ?3 AS INTEGER) = CAST((o.created_at - ?1) / ?3 AS INTEGER) AND o.ckey LIKE 'u:%' THEN o.ckey END) new_reg, count(*) orders, sum(o.net_paise) net
      FROM crm_orders o JOIN f ON f.ckey = o.ckey WHERE o.counts = 1 AND o.created_at >= ?1 AND o.created_at < ?2 GROUP BY b`, r.from, r.to, step),
    all(env, `WITH x AS (SELECT created_at, row_number() OVER (PARTITION BY ckey ORDER BY created_at, id) rn FROM crm_orders WHERE counts = 1 AND ckey IS NOT NULL AND created_at < ?1)
      SELECT strftime('%Y-%m', created_at + ${IST_OFFSET}, 'unixepoch') m, rn, count(*) n FROM x WHERE rn IN (1, 2) GROUP BY m, rn`, r.to),
    all(env, `WITH f AS (SELECT ckey, min(created_at) fo FROM crm_orders WHERE counts = 1 AND ckey IS NOT NULL GROUP BY ckey HAVING fo >= ?1)
      SELECT strftime('%Y-%m', f.fo + ${IST_OFFSET}, 'unixepoch') cm, strftime('%Y-%m', o.created_at + ${IST_OFFSET}, 'unixepoch') om, sum(o.net_paise) net
      FROM crm_orders o JOIN f ON f.ckey = o.ckey WHERE o.counts = 1 AND o.created_at < ?2 GROUP BY cm, om`, cohortFromTs, r.to),
    all(env, `SELECT cm, count(*) n FROM (SELECT strftime('%Y-%m', min(created_at) + ${IST_OFFSET}, 'unixepoch') cm, min(created_at) fo FROM crm_orders
      WHERE counts = 1 AND ckey IS NOT NULL GROUP BY ckey HAVING fo >= ?1 AND fo < ?2) GROUP BY cm`, cohortFromTs, r.to),
    all(env, `SELECT t.id, coalesce(t.name, 'Not yet recorded') name, sum(o.net_paise) net, count(*) orders FROM crm_orders o LEFT JOIN loyalty_tiers t ON t.id = o.loyalty_tier
      WHERE o.counts = 1 AND o.created_at >= ?1 AND o.created_at < ?2 GROUP BY t.id ORDER BY (t.id IS NULL), t.sort_order`, r.from, r.to),
    all(env, `WITH a AS (SELECT ckey, sum(net_paise) n FROM crm_orders WHERE ckey IS NOT NULL GROUP BY ckey)
      SELECT b, count(*) n FROM (SELECT CASE WHEN n <= 0 THEN 0 WHEN n < ?1 THEN 1 WHEN n < ?2 THEN 2 WHEN n < ?3 THEN 3 ELSE 4 END b FROM a
        UNION ALL SELECT 0 FROM users u WHERE NOT EXISTS (SELECT 1 FROM a WHERE a.ckey = 'u:' || u.id)) GROUP BY b`, ...SPEND_EDGES_PAISE),
    all(env, `WITH l AS (SELECT o.id oid, o.net_paise net, p.category cat, coalesce(json_extract(j.value, '$.qty'), 0) qty, coalesce(json_extract(j.value, '$.qty'), 0) * coalesce(p.price_paise, 0) lv
        FROM crm_orders o, json_each(CASE WHEN json_valid(o.items_json) THEN o.items_json ELSE '[]' END) j LEFT JOIN products p ON p.id = json_extract(j.value, '$.id')
        WHERE o.counts = 1 AND o.created_at >= ?1 AND o.created_at < ?2),
      t AS (SELECT oid, sum(lv) tot FROM l GROUP BY oid)
      SELECT l.cat, sum(l.qty) units, count(DISTINCT l.oid) orders, sum(CASE WHEN t.tot > 0 THEN 1.0 * l.net * l.lv / t.tot END) approx_net FROM l JOIN t ON t.oid = l.oid GROUP BY l.cat ORDER BY units DESC LIMIT 20`, r.from, r.to),
    all(env, `SELECT c.id, c.name, c.eligible_at_send, coalesce(c.finished_at, c.started_at) at, count(r.id) recipients, coalesce(sum(r.sent_at IS NOT NULL), 0) sent,
        coalesce(sum(r.delivered_at IS NOT NULL OR r.status = 'delivered'), 0) delivered, coalesce(sum(r.bounced_at IS NOT NULL OR r.status = 'bounced'), 0) bounced, coalesce(sum(r.clicked_at IS NOT NULL), 0) clicks
      FROM campaigns c LEFT JOIN campaign_recipients r ON r.campaign_id = c.id WHERE c.status = 'sent' AND coalesce(c.finished_at, c.started_at) >= ?1 AND coalesce(c.finished_at, c.started_at) < ?2
      GROUP BY c.id ORDER BY at DESC LIMIT 20`, r.from, r.to),
    // last-click attribution (DEFS.attributed_revenue): each counted order goes to the most recent tracked click of that customer within the 7 days before it
    all(env, `WITH cl AS (SELECT campaign_id cid, email, user_id, clicked_at FROM campaign_recipients WHERE clicked_at IS NOT NULL),
      m AS (SELECT o.id oid, o.net_paise, cl.cid, row_number() OVER (PARTITION BY o.id ORDER BY cl.clicked_at DESC) rn
        FROM crm_orders o JOIN cl ON (o.email_n = cl.email OR (o.user_id IS NOT NULL AND o.user_id = cl.user_id)) AND o.created_at >= cl.clicked_at AND o.created_at < cl.clicked_at + ${7 * DAY}
        WHERE o.counts = 1)
      SELECT cid, count(*) orders, sum(net_paise) net FROM m WHERE rn = 1 GROUP BY cid`),
  ]);

  // new vs returning + acquisition (zero-filled: a bucket with no paid orders genuinely has 0 customers)
  const byB = new Map(flow.map((x) => [x.b, x]));
  const buckets = Array.from({ length: nb }, (_, i) => { const x = byB.get(i) || {}, ts = r.from + i * step, nw = n0(x.new_c);
    return { start: ts, label: istDay(ts), active: n0(x.active), new: nw, returning: n0(x.active) - nw, new_registered: n0(x.new_reg), new_guest: nw - n0(x.new_reg), orders: n0(x.orders), net_paise: n0(x.net) }; });

  // repeat rate by month: cumulative customers with a 2nd paid order ÷ cumulative customers with a 1st, as of each month end
  const cum = { 1: 0, 2: 0 }, per = {};
  for (const x of rep) (per[x.m] ||= {})[x.rn] = x.n;
  const firstMonth = rep.length ? rep.map((x) => x.m).sort()[0] : months[0];
  const repeat_trend = [];
  for (let i = Math.min(monthIdx(firstMonth), monthIdx(months[0])); i <= monthIdx(months[11]); i++) {
    const m = monthName(i); cum[1] += n0(per[m]?.[1]); cum[2] += n0(per[m]?.[2]);
    if (months.includes(m)) repeat_trend.push({ month: m, buyers: cum[1], repeaters: cum[2], repeat_rate: ratio(cum[2], cum[1]) });
  }

  // cohorts: first-paid-order month x months since; null = that month has not happened yet (not zero)
  const sizes = Object.fromEntries(cohSize.map((x) => [x.cm, x.n])), cell = Object.fromEntries(coh.map((x) => [x.cm + "|" + x.om, x.net]));
  const last = monthIdx(months[11]);
  const cohorts = months.map((cm) => ({ cohort: cm, customers: n0(sizes[cm]), cells: Array.from({ length: 12 }, (_, k) => {
    const idx = monthIdx(cm) + k; if (idx > last) return null; return n0(cell[cm + "|" + monthName(idx)]); }) }));

  const revenue_by_tier = tiers.map((t) => ({ tier_id: t.id, tier: t.name, net_paise: n0(t.net), orders: t.orders, ...(t.id ? { drill: { op: "and", rules: [rule("tier", "eq", t.id)] } } : {}) }));

  const E = SPEND_EDGES_PAISE, sd = Object.fromEntries(spend.map((x) => [x.b, x.n]));
  const sdDef = [["₹0", [rule("net_paise", "eq", 0)]], [`Under ₹${E[0] / 100}`, [rule("net_paise", "gt", 0), rule("net_paise", "lt", E[0])]],
    [`₹${E[0] / 100}-${E[1] / 100}`, [rule("net_paise", "gte", E[0]), rule("net_paise", "lt", E[1])]], [`₹${E[1] / 100}-${E[2] / 100}`, [rule("net_paise", "gte", E[1]), rule("net_paise", "lt", E[2])]],
    [`₹${E[2] / 100}+`, [rule("net_paise", "gte", E[2])]]];
  const spend_distribution = sdDef.map(([label, rules], i) => ({ label, customers: n0(sd[i]), drill: { op: "and", rules } }));

  const categories = cats.map((c) => ({ category: c.cat || "Unknown", units: n0(c.units), orders: c.orders, approx_net_paise: c.approx_net === null ? null : Math.round(c.approx_net),
    ...(c.cat && ID_RE.test(c.cat) ? { drill: { op: "and", rules: [rule("bought_category", "has", c.cat)] } } : {}) }));

  const at = new Map(attrib.map((a) => [a.cid, a]));
  const email_engagement = camps.map((c) => { const a = at.get(c.id), hasEv = n0(c.delivered) + n0(c.bounced) > 0;
    return { id: c.id, name: c.name, sent_at: c.at, eligible_at_send: c.eligible_at_send ?? null, recipients: n0(c.recipients), sent: n0(c.sent),
      delivered: hasEv ? n0(c.delivered) : null, bounced: hasEv ? n0(c.bounced) : null, unsubscribed: null, // unsubscribes are not linked to a campaign in consent_log
      unique_clicks: n0(c.clicks), attributed_orders: n0(c.clicks) ? n0(a?.orders) : null, attributed_net_paise: n0(c.clicks) ? n0(a?.net) : null }; });

  return ctx.json({
    range: rangeJson(r), bucket: bucketKind,
    new_vs_returning: buckets, acquisition: buckets.map((b) => ({ start: b.start, label: b.label, new: b.new, registered: b.new_registered, guest: b.new_guest })),
    repeat_trend, cohorts, revenue_by_tier, spend_distribution, categories, email_engagement,
    notes: {
      cohorts: "Cohort = month of a customer's first paid order (IST). Cells are net paid revenue (incl. GST and shipping) in the months since; blank = month not reached yet.",
      revenue_by_tier: "Tier is the one recorded on each order when it was placed. Drill-down lists customers currently in that tier.",
      spend_distribution: `Lifetime net paid revenue per customer (as of today). Bucket edges: ${E.map((e) => "₹" + e / 100).join(", ")}.`,
      categories: "Units are exact. Revenue share is APPROXIMATE: each order's net revenue is split across its lines in proportion to quantity x the product's current price. Drill-down lists all-time buyers of the category.",
      email_engagement: DEFS.attributed_revenue + " Unsubscribes are not linked to a campaign, so they are not available per campaign.",
      new_vs_returning: DEFS.new_customer + " / " + DEFS.returning_customer,
    },
  });
}

export const routes = [
  { m: "GET", p: /^\/api\/crm\/overview$/, perm: "view", h: overview },
  { m: "GET", p: /^\/api\/crm\/analytics$/, perm: "view", h: analytics },
];
