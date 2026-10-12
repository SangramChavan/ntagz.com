// Segment engine. A rule tree is validated against FIELDS (a fixed map) and compiled to parameterised SQL over `crm_customers c`.
// The same compiler powers the directory filters, saved segments and campaign audiences, so one definition means one thing everywhere.
//   tree  = { op: 'and' | 'or', rules: [ rule | tree ] }        (nesting depth <= 3, at most 25 leaf rules)
//   rule  = { field, cmp, value }
import { now, eligibleSql, boughtProductSql, boughtCategorySql, auditStmt, sanitiseText } from "./common.js";

const DAY = 86400;
const NUM_CMP = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
const int = (v, min = 0, max = 1e12) => { const n = Number(v); return Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max ? n : null; };
const id = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
const tag = (v) => (typeof v === "string" && /^[a-z0-9][a-z0-9 _-]{0,29}$/i.test(v.trim()) ? v.trim().toLowerCase() : null);

// Loyalty-qualifying spend of the registered customer (same derivation as functions/lib/loyalty.js), as a scalar subquery on alias c.
const SPEND = `(coalesce((SELECT sum(o.qualifying_paise * (o.paid_paise - min(o.refunded_paise, o.paid_paise)) / o.paid_paise) FROM orders o
   WHERE o.user_id = c.user_id AND o.payment_status = 'paid' AND o.paid_paise > 0 AND o.status NOT IN ('cancelled', 'returned')), 0)
   + coalesce((SELECT sum(a.delta_paise) FROM loyalty_adjustments a WHERE a.user_id = c.user_id), 0))`;

// field -> { label, kind, cmps, build(cmp, value) -> { sql, params } | null (invalid value) }
const num = (col) => (cmp, v) => { const n = int(v, -1e12); return n === null || !NUM_CMP[cmp] ? null : { sql: `${col} ${NUM_CMP[cmp]} ?`, params: [n] }; };
const NUM = Object.keys(NUM_CMP);
export const FIELDS = {
  type: { label: "Customer type", kind: "enum", options: ["registered", "guest"], cmps: ["eq", "ne"], build: (cmp, v) => (["registered", "guest"].includes(v) ? { sql: `c.type ${cmp === "ne" ? "<>" : "="} ?`, params: [v] } : null) },
  paid_orders: { label: "Paid orders", kind: "number", cmps: NUM, build: num("c.paid_orders") },
  net_paise: { label: "Net paid revenue (paise)", kind: "money", cmps: NUM, build: num("c.net_paise") },
  never_purchased: { label: "Never purchased", kind: "bool", cmps: ["is"], build: (_c, v) => ({ sql: v === false ? "c.paid_orders > 0" : "c.paid_orders = 0", params: [] }) },
  days_since_last_order: { label: "Days since last paid order", kind: "number", cmps: ["gte", "lte"], // customers who never bought are excluded: use never_purchased for them
    build: (cmp, v) => { const n = int(v, 0, 3650); return n === null ? null : cmp === "gte" ? { sql: "c.last_order_at IS NOT NULL AND c.last_order_at <= ?", params: [now() - n * DAY] } : { sql: "c.last_order_at IS NOT NULL AND c.last_order_at >= ?", params: [now() - n * DAY] }; } },
  days_since_first_order: { label: "Days since first paid order", kind: "number", cmps: ["gte", "lte"],
    build: (cmp, v) => { const n = int(v, 0, 3650); return n === null ? null : cmp === "gte" ? { sql: "c.first_order_at IS NOT NULL AND c.first_order_at <= ?", params: [now() - n * DAY] } : { sql: "c.first_order_at IS NOT NULL AND c.first_order_at >= ?", params: [now() - n * DAY] }; } },
  days_since_first_seen: { label: "Days since account created / first order", kind: "number", cmps: ["gte", "lte"],
    build: (cmp, v) => { const n = int(v, 0, 3650); const col = "coalesce(c.first_seen_at, c.first_order_at, c.last_any_order_at)"; return n === null ? null : { sql: `${col} ${cmp === "gte" ? "<=" : ">="} ?`, params: [now() - n * DAY] }; } },
  tier: { label: "Rewards tier", kind: "text", cmps: ["eq", "ne"], build: (cmp, v) => { const t = id(v); return t === null ? null : { sql: `coalesce(c.loyalty_tier_id, '') ${cmp === "ne" ? "<>" : "="} ?`, params: [t] }; } },
  approaching_tier: { label: "Within this much spend of the next tier (paise)", kind: "money", cmps: ["lte"],
    build: (_c, v) => { const n = int(v, 1, 1e10); return n === null ? null : { sql: `(c.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM loyalty_tiers t WHERE t.active = 1 AND t.min_spend_paise > ${SPEND} AND t.min_spend_paise - ${SPEND} <= ?))`, params: [n] }; } },
  tag: { label: "Has tag", kind: "text", cmps: ["has", "not_has"], build: (cmp, v) => { const t = tag(v); return t === null ? null : { sql: `${cmp === "not_has" ? "NOT " : ""}EXISTS (SELECT 1 FROM crm_tags g WHERE g.ckey = c.ckey AND g.tag = ?)`, params: [t] }; } },
  bought_product: { label: "Bought product", kind: "product", cmps: ["has", "not_has"], build: (cmp, v) => { const p = id(v); return p === null ? null : { sql: (cmp === "not_has" ? "NOT " : "") + boughtProductSql("c"), params: [p] }; } },
  bought_category: { label: "Bought from category", kind: "category", cmps: ["has", "not_has"], build: (cmp, v) => { const p = id(v); return p === null ? null : { sql: (cmp === "not_has" ? "NOT " : "") + boughtCategorySql("c"), params: [p] }; } },
  bulk_quantity: { label: "Ordered at least this many units of one product in one order", kind: "number", cmps: ["gte"],
    build: (_c, v) => { const n = int(v, 1, 1e7); return n === null ? null : { sql: "EXISTS (SELECT 1 FROM crm_orders o, json_each(o.items_json) j WHERE o.ckey = c.ckey AND o.counts = 1 AND coalesce(json_extract(j.value, '$.qty'), 0) >= ?)", params: [n] }; } },
  marketing_eligible: { label: "Marketing eligible (opted in)", kind: "bool", cmps: ["is"], build: (_c, v) => ({ sql: (v === false ? "NOT " : "") + eligibleSql("c"), params: [] }) },
  // Behavioural fields depend on tracked events (consented visitors, signed in at the time). They only ever match registered customers.
  abandoned_cart: { label: "Left a cart or checkout (last N days, no order since)", kind: "number", cmps: ["lte"],
    build: (_c, v) => { const n = int(v, 1, 90); return n === null ? null : { sql: `(c.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM crm_events e WHERE e.user_id = c.user_id AND e.event IN ('add_to_cart','begin_checkout') AND e.ts >= ?
      AND NOT EXISTS (SELECT 1 FROM crm_orders o WHERE o.ckey = c.ckey AND o.created_at >= e.ts)))`, params: [now() - n * DAY] }; } },
  clicked_no_purchase: { label: "Clicked a campaign email but has not purchased since (last N days)", kind: "number", cmps: ["lte"],
    build: (_c, v) => { const n = int(v, 1, 365); return n === null ? null : { sql: `EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.email = c.email AND r.clicked_at >= ?
      AND NOT EXISTS (SELECT 1 FROM crm_orders o WHERE o.ckey = c.ckey AND o.counts = 1 AND o.created_at >= r.clicked_at))`, params: [now() - n * DAY] }; } },
  not_purchased_since_campaign: { label: "Was sent campaign (id) and has not purchased since", kind: "campaign", cmps: ["is"],
    build: (_c, v) => { const p = id(v); return p === null ? null : { sql: `EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.email = c.email AND r.campaign_id = ? AND r.sent_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM crm_orders o WHERE o.ckey = c.ckey AND o.counts = 1 AND o.created_at >= r.sent_at))`, params: [p] }; } },
  search: { label: "Search name, email, phone or customer id", kind: "text", cmps: ["contains"],
    build: (_c, v) => { const s = typeof v === "string" ? v.trim().slice(0, 80) : ""; if (!s) return null; const l = `%${s.replace(/[%_\\]/g, (ch) => "\\" + ch)}%`;
      return { sql: "(c.email LIKE ? ESCAPE '\\' OR coalesce(c.name, '') LIKE ? ESCAPE '\\' OR coalesce(c.phone, '') LIKE ? ESCAPE '\\' OR c.ckey LIKE ? ESCAPE '\\')", params: [l, l, l, l] }; } },
};

// Validate + compile. Returns { sql, params, errors }. Empty tree => match everyone ("1=1").
export function compileRules(tree) {
  const errors = []; let leaves = 0;
  const walk = (node, depth, path) => {
    if (!node || typeof node !== "object") { errors.push(`${path}: invalid rule`); return null; }
    if (Array.isArray(node.rules)) {
      if (depth >= 3) { errors.push(`${path}: nested too deeply`); return null; }
      const op = node.op === "or" ? "or" : node.op === "and" || node.op === undefined ? "and" : null;
      if (!op) { errors.push(`${path}: op must be and/or`); return null; }
      const parts = node.rules.map((r, i) => walk(r, depth + 1, `${path}.${i + 1}`)).filter(Boolean);
      return parts.length ? { sql: "(" + parts.map((p) => p.sql).join(op === "or" ? " OR " : " AND ") + ")", params: parts.flatMap((p) => p.params) } : null;
    }
    const f = FIELDS[node.field];
    if (!f) { errors.push(`${path}: unknown field`); return null; }
    if (++leaves > 25) { errors.push("Too many rules (max 25)"); return null; }
    const cmp = node.cmp ?? f.cmps[0];
    if (!f.cmps.includes(cmp)) { errors.push(`${path}: ${f.label} does not support "${cmp}"`); return null; }
    const out = f.build(cmp, node.value);
    if (!out) { errors.push(`${path}: ${f.label} needs a valid value`); return null; }
    return out;
  };
  if (!tree || (Array.isArray(tree.rules) && tree.rules.length === 0)) return { sql: "1=1", params: [], errors };
  const r = walk(tree, 0, "rules");
  return errors.length ? { sql: "", params: [], errors } : { sql: r ? r.sql : "1=1", params: r ? r.params : [], errors };
}

// All customers matching a tree, with eligibility. Counts are exact; `rows` is capped (campaign sending reads pages via audience()).
export async function countAudience(env, tree) {
  const c = compileRules(tree); if (c.errors.length) return { errors: c.errors };
  const r = await env.DB.prepare(`SELECT count(*) n, coalesce(sum(${eligibleSql("c")}), 0) eligible FROM crm_customers c WHERE ${c.sql}`).bind(...c.params).first();
  return { count: r.n, eligible: r.eligible };
}

// Marketing-eligible recipients of a tree RIGHT NOW (re-checked on every call: send-time revalidation reuses this).
// Excludes anyone not currently `subscribed`, anyone without a valid-looking email, and returns at most `limit`.
export async function eligibleRecipients(env, tree, limit = 5000) {
  const c = compileRules(tree); if (c.errors.length) return { errors: c.errors, rows: [] };
  const { results } = await env.DB.prepare(`SELECT c.ckey, c.email, c.user_id, c.name FROM crm_customers c
    WHERE ${c.sql} AND ${eligibleSql("c")} AND c.email LIKE '%_@_%._%' ORDER BY c.ckey LIMIT ?`).bind(...c.params, Math.min(Math.max(limit, 1), 50000)).all();
  return { rows: results, errors: [] };
}

// Resolves a campaign/segment target: a saved segment id, or an inline tree.
export async function treeOf(env, segmentId) {
  const s = await env.DB.prepare("SELECT id,name,rules_json,archived FROM crm_segments WHERE id=?").bind(segmentId).first();
  if (!s) return null;
  let tree = {}; try { tree = JSON.parse(s.rules_json); } catch { /* invalid stored rules match nobody below */ }
  return { id: s.id, name: s.name, archived: !!s.archived, tree };
}

// Starter templates (suggestions, not data): the admin creates a real segment from one. value:null means "ask the admin".
export const TEMPLATES = [
  { key: "new_never_ordered", name: "New customers who have never ordered", tree: { op: "and", rules: [{ field: "never_purchased", cmp: "is", value: true }, { field: "type", cmp: "eq", value: "registered" }] } },
  { key: "first_time", name: "First-time purchasers (last 30 days)", tree: { op: "and", rules: [{ field: "paid_orders", cmp: "eq", value: 1 }, { field: "days_since_first_order", cmp: "lte", value: 30 }] } },
  { key: "one_purchase", name: "Exactly one completed purchase", tree: { op: "and", rules: [{ field: "paid_orders", cmp: "eq", value: 1 }] } },
  { key: "repeat", name: "Repeat customers", tree: { op: "and", rules: [{ field: "paid_orders", cmp: "gte", value: 2 }] } },
  { key: "high_value", name: "High-value customers (net paid ≥ ₹10,000)", tree: { op: "and", rules: [{ field: "net_paise", cmp: "gte", value: 1000000 }] } },
  { key: "near_tier", name: "Within ₹500 of the next Rewards tier", tree: { op: "and", rules: [{ field: "approaching_tier", cmp: "lte", value: 50000 }] } },
  { key: "tier_silver", name: "Silver members", tree: { op: "and", rules: [{ field: "tier", cmp: "eq", value: "silver" }] } },
  { key: "tier_gold", name: "Gold members", tree: { op: "and", rules: [{ field: "tier", cmp: "eq", value: "gold" }] } },
  { key: "tier_platinum", name: "Platinum members", tree: { op: "and", rules: [{ field: "tier", cmp: "eq", value: "platinum" }] } },
  { key: "inactive_30", name: "Inactive for 30+ days", tree: { op: "and", rules: [{ field: "days_since_last_order", cmp: "gte", value: 30 }] } },
  { key: "inactive_60", name: "Inactive for 60+ days", tree: { op: "and", rules: [{ field: "days_since_last_order", cmp: "gte", value: 60 }] } },
  { key: "inactive_90", name: "Inactive for 90+ days", tree: { op: "and", rules: [{ field: "days_since_last_order", cmp: "gte", value: 90 }] } },
  { key: "abandoned_cart", name: "Abandoned a cart in the last 7 days", note: "Needs tracking consent and sign-in at the time.", tree: { op: "and", rules: [{ field: "abandoned_cart", cmp: "lte", value: 7 }] } },
  { key: "bought_tags_no_accessory", name: "Bought one category but not another", note: "Choose the two categories.", tree: { op: "and", rules: [{ field: "bought_category", cmp: "has", value: null }, { field: "bought_category", cmp: "not_has", value: null }] } },
  { key: "bought_product", name: "Bought a specific product (e.g. a QR product)", note: "Choose the product.", tree: { op: "and", rules: [{ field: "bought_product", cmp: "has", value: null }] } },
  { key: "bulk", name: "Bought in bulk (500+ units in one order)", tree: { op: "and", rules: [{ field: "bulk_quantity", cmp: "gte", value: 500 }] } },
  { key: "recent_buyer_complement", name: "Recently bought a product but not a related one", note: "Choose both products.", tree: { op: "and", rules: [{ field: "bought_product", cmp: "has", value: null }, { field: "bought_product", cmp: "not_has", value: null }, { field: "days_since_last_order", cmp: "lte", value: 30 }] } },
  { key: "no_purchase_since_campaign", name: "Sent a campaign, no purchase since", note: "Choose the campaign.", tree: { op: "and", rules: [{ field: "not_purchased_since_campaign", cmp: "is", value: null }] } },
  { key: "clicked_no_purchase", name: "Clicked an email but did not purchase", note: "Needs click attribution (campaign emails only).", tree: { op: "and", rules: [{ field: "clicked_no_purchase", cmp: "lte", value: 30 }] } },
];

// ── Saved segments API ─────────────────────────────────────────────────────────────────────────────────────
const shape = (s) => ({ id: s.id, name: s.name, archived: !!s.archived, rules: (() => { try { return JSON.parse(s.rules_json); } catch { return {}; } })(), created_by: s.created_by, created_at: s.created_at, updated_at: s.updated_at, last_count: s.last_count, last_eligible: s.last_eligible, last_eval_at: s.last_eval_at });

async function listSegments(ctx) {
  const archived = ctx.url.searchParams.get("archived") === "1" ? 1 : 0;
  const { results } = await ctx.env.DB.prepare("SELECT * FROM crm_segments WHERE archived=? ORDER BY updated_at DESC, rowid DESC LIMIT 200").bind(archived).all();
  return ctx.json({ segments: results.map(shape) });
}

async function saveSegment(ctx, match) {
  const { env, actor, body } = ctx, sid = match && match[1];
  const name = sanitiseText(body.name, 80);
  if (name.length < 2) return ctx.fail(400, "Give the segment a name (2–80 characters)");
  const c = compileRules(body.rules);
  if (c.errors.length) return ctx.json({ error: c.errors[0], errors: c.errors }, 400);
  const rules = JSON.stringify(body.rules && typeof body.rules === "object" ? body.rules : { op: "and", rules: [] });
  if (rules.length > 8000) return ctx.fail(400, "Rules are too large");
  const n = await countAudience(env, body.rules);
  const t = now();
  if (sid) {
    const cur = await env.DB.prepare("SELECT id FROM crm_segments WHERE id=?").bind(sid).first();
    if (!cur) return ctx.fail(404, "Segment not found");
    await env.DB.batch([
      env.DB.prepare("UPDATE crm_segments SET name=?, rules_json=?, updated_at=?, last_count=?, last_eligible=?, last_eval_at=? WHERE id=?").bind(name, rules, t, n.count, n.eligible, t, sid),
      auditStmt(env, actor, "crm_segment_save", { id: sid, name }),
    ]);
    return ctx.json({ id: sid, ...n });
  }
  const nid = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO crm_segments (id,name,rules_json,created_by,last_count,last_eligible,last_eval_at) VALUES (?,?,?,?,?,?,?)").bind(nid, name, rules, actor, n.count, n.eligible, t),
    auditStmt(env, actor, "crm_segment_save", { id: nid, name }),
  ]);
  return ctx.json({ id: nid, ...n }, 201);
}

async function segmentAction(ctx, match) {
  const { env, actor } = ctx, sid = match[1], act = match[2];
  const s = await env.DB.prepare("SELECT * FROM crm_segments WHERE id=?").bind(sid).first();
  if (!s) return ctx.fail(404, "Segment not found");
  if (act === "archive" || act === "restore") {
    await env.DB.batch([env.DB.prepare("UPDATE crm_segments SET archived=?, updated_at=unixepoch() WHERE id=?").bind(act === "archive" ? 1 : 0, sid), auditStmt(env, actor, "crm_segment_" + act, { id: sid, name: s.name })]);
    return ctx.json({ ok: true });
  }
  if (act === "duplicate") {
    const nid = crypto.randomUUID();
    await env.DB.batch([env.DB.prepare("INSERT INTO crm_segments (id,name,rules_json,created_by) VALUES (?,?,?,?)").bind(nid, (s.name + " (copy)").slice(0, 80), s.rules_json, actor), auditStmt(env, actor, "crm_segment_save", { id: nid, name: s.name + " (copy)", copied_from: sid })]);
    return ctx.json({ id: nid }, 201);
  }
  // evaluate: recompute from current data
  let tree = {}; try { tree = JSON.parse(s.rules_json); } catch { /* falls through to the validation error below */ }
  const n = await countAudience(env, tree);
  if (n.errors) return ctx.json({ error: n.errors[0] }, 400);
  await env.DB.prepare("UPDATE crm_segments SET last_count=?, last_eligible=?, last_eval_at=unixepoch() WHERE id=?").bind(n.count, n.eligible, sid).run();
  return ctx.json({ ...n, last_eval_at: now() });
}

// Live preview of unsaved rules (never writes).
async function previewRules(ctx) {
  const n = await countAudience(ctx.env, ctx.body.rules);
  return n.errors ? ctx.json({ error: n.errors[0], errors: n.errors }, 400) : ctx.json(n);
}

// Fields/options the UI needs to build the rule editor. Product and category lists come from the live catalogue.
async function meta(ctx) {
  const [p, c, t] = await Promise.all([
    ctx.env.DB.prepare("SELECT id,name,category FROM products ORDER BY name LIMIT 500").all(),
    ctx.env.DB.prepare("SELECT DISTINCT category FROM products ORDER BY category").all(),
    ctx.env.DB.prepare("SELECT id,name FROM loyalty_tiers WHERE active=1 ORDER BY min_spend_paise").all(),
  ]);
  return ctx.json({ fields: Object.entries(FIELDS).map(([key, f]) => ({ key, label: f.label, kind: f.kind, cmps: f.cmps, options: f.options || null })), products: p.results, categories: c.results.map((r) => r.category), tiers: t.results, templates: TEMPLATES });
}

export const routes = [
  { m: "GET", p: /^\/api\/crm\/segments$/, perm: "view", h: listSegments },
  { m: "GET", p: /^\/api\/crm\/segments\/meta$/, perm: "view", h: meta },
  { m: "POST", p: /^\/api\/crm\/segments\/preview$/, perm: "view", h: previewRules },
  { m: "POST", p: /^\/api\/crm\/segments$/, perm: "manage", h: saveSegment },
  { m: "POST", p: /^\/api\/crm\/segments\/([0-9a-f-]{36})$/, perm: "manage", h: saveSegment },
  { m: "POST", p: /^\/api\/crm\/segments\/([0-9a-f-]{36})\/(archive|restore|duplicate|evaluate)$/, perm: "manage", h: segmentAction },
];

