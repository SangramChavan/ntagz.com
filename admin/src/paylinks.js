// Admin API for payment links, mounted by index.js under /api/paylinks (session + CSRF are enforced there). A link is a stored cart and the
// customer's details behind an unguessable token; the payments Worker prices it fresh every time it is opened or paid. The total shown here
// is only an ESTIMATE (guest prices, no cart milestones): the customer's page is the authority.
// Routes: GET /api/paylinks (list + funnel stats), POST /api/paylinks (create), GET /api/paylinks/prefill (returning customer / unpaid order),
//         POST /api/paylinks/:id/extend | /cancel | /sent.
import PRICING from "../../functions/lib/pricing.js";
import PAYLINKS from "../../functions/lib/paylinks.js";
import { auditStmt, sanitiseText, now, EMAIL_RE } from "./crm/common.js";

const BASE = "https://ntagz.com/pay.html?t=";
const PAGE = 25;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

let schema = { db: null, at: 0, ok: false };
export async function hasPayLinks(env) {
  if (schema.db === env.DB && Date.now() - schema.at < 30000) return schema.ok;
  let ok = false;
  try { await env.DB.prepare("SELECT 1 FROM pay_links LIMIT 1").first(); ok = true; } catch { ok = false; }
  schema = { db: env.DB, at: Date.now(), ok };
  return ok;
}

// The status the admin sees, in SQL so the list can be filtered and paged. Mirrors PAYLINKS.statusOf (paid > cancelled > expired > opened > sent > new).
const ST = (nowSec) => `CASE WHEN paid_order_id IS NOT NULL THEN 'paid' WHEN status='cancelled' THEN 'cancelled' WHEN expires_at<=${nowSec} THEN 'expired' WHEN open_count>0 THEN 'opened' WHEN sent_at IS NOT NULL THEN 'sent' ELSE 'new' END`;
const FILTERS = {
  awaiting: "st IN ('new','sent','opened')", opened: "st='opened'", paid: "st='paid'", closed: "st IN ('expired','cancelled')",
};
const BASE_SQL = `SELECT pl.*, (SELECT o.id FROM orders o WHERE o.payment_status='paid' AND o.txn_id IN (SELECT value FROM json_each(pl.txn_ids)) LIMIT 1) AS paid_order_id,
  (SELECT o.created_at FROM orders o WHERE o.payment_status='paid' AND o.txn_id IN (SELECT value FROM json_each(pl.txn_ids)) LIMIT 1) AS paid_at,
  (SELECT o.total FROM orders o WHERE o.payment_status='paid' AND o.txn_id IN (SELECT value FROM json_each(pl.txn_ids)) LIMIT 1) AS paid_total,
  so.payment_status AS src_pay, so.status AS src_status FROM pay_links pl LEFT JOIN orders so ON so.id = pl.source_order_id`;

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const ref = (id) => (id ? String(id).slice(0, 8) : null);

async function productNames(env) {
  const { results } = await env.DB.prepare("SELECT id,name FROM products").all();
  return Object.fromEntries(results.map((r) => [r.id, r.name]));
}

function shape(r, names) {
  const items = parse(r.items_json, []), orig = parse(r.orig_items_json, []);
  return {
    id: r.id, url: BASE + r.id, source: r.source, created_by: r.created_by, status: r.st, name: r.name, phone: r.phone, state: r.state, pincode: r.pincode, note: r.note || null,
    items: items.map((i) => ({ id: i.id, qty: i.qty, name: names[i.id] || i.id, orig_qty: (orig.find((o) => o.id === i.id) || i).qty })),
    adjusted: r.items_json !== r.orig_items_json, adjust_count: r.adjust_count, est_paise: r.quoted_paise, paid_total_paise: r.paid_total ?? null,
    created_at: r.created_at, expires_at: r.expires_at, sent_at: r.sent_at, reminder_count: r.reminder_count, last_reminded_at: r.last_reminded_at,
    open_count: r.open_count, first_opened_at: r.first_opened_at, last_opened_at: r.last_opened_at, start_count: r.start_count,
    paid_order_id: r.paid_order_id || null, paid_order_ref: ref(r.paid_order_id), paid_at: r.paid_at || null,
    source_order_id: r.source_order_id || null, source_order_ref: ref(r.source_order_id),
    // The customer paid through the link but the unpaid order it was meant to replace is still open: the admin should cancel it (stock was reserved by it).
    dup_order_open: !!(r.paid_order_id && r.source_order_id && r.src_pay === "unpaid" && !["cancelled", "returned"].includes(r.src_status)),
  };
}

async function list(ctx) {
  const { env, url } = ctx, sp = url.searchParams, t = now();
  if (!(await hasPayLinks(env))) return ctx.json({ available: false, links: [], page: 1, pages: 1, total: 0 });
  const filter = FILTERS[sp.get("status")] || "1=1", bind = [];
  let where = filter;
  const qtxt = (sp.get("q") || "").trim().slice(0, 60);
  if (qtxt) { where += " AND (name LIKE ?1 ESCAPE '\\' OR phone LIKE ?1 ESCAPE '\\' OR id LIKE ?1 ESCAPE '\\')"; bind.push(`%${qtxt.replace(/[\\%_]/g, "\\$&")}%`); }
  const inner = `SELECT *, ${ST(t)} AS st FROM (${BASE_SQL})`;
  const page = Math.max(1, parseInt(sp.get("page"), 10) || 1);
  const total = (await env.DB.prepare(`SELECT count(*) c FROM (${inner}) WHERE ${where}`).bind(...bind).first()).c;
  const { results } = await env.DB.prepare(`SELECT * FROM (${inner}) WHERE ${where} ORDER BY created_at DESC, id LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`).bind(...bind).all();
  // Funnel for the last 30 days: how far links get, and what they bring in.
  const since = t - 30 * 86400;
  const s = await env.DB.prepare(`SELECT count(*) created, coalesce(sum(CASE WHEN open_count>0 THEN 1 ELSE 0 END),0) opened,
      coalesce(sum(CASE WHEN st='paid' THEN 1 ELSE 0 END),0) paid, coalesce(sum(CASE WHEN st='paid' THEN paid_total ELSE 0 END),0) revenue_paise,
      coalesce(sum(CASE WHEN st='paid' AND items_json<>orig_items_json THEN 1 ELSE 0 END),0) paid_after_suggestion,
      coalesce(sum(CASE WHEN st IN ('new','sent','opened') THEN 1 ELSE 0 END),0) awaiting,
      coalesce(sum(CASE WHEN st='opened' THEN 1 ELSE 0 END),0) opened_unpaid,
      coalesce(avg(CASE WHEN st='paid' AND paid_at>=created_at THEN paid_at-created_at END),0) avg_secs_to_pay
    FROM (${inner}) WHERE created_at >= ?1`).bind(since).first();
  const names = await productNames(env);
  // What can be put on a link: active products the checkout can sell, with the minimum quantity the checkout enforces.
  const catalog = (await env.DB.prepare("SELECT id,name,price_paise,unit FROM products WHERE active=1 ORDER BY name").all()).results
    .filter((p) => PRICING.PRODUCTS[p.id]).map((p) => ({ id: p.id, name: p.name, price: p.price_paise / 100, unit: p.unit, fixed: !!PRICING.PRODUCTS[p.id].fixed, min: PRICING.PRODUCTS[p.id].fixed ? 1 : PRICING.PRODUCTS[p.id].moq || 10 }));
  return ctx.json({ available: true, links: results.map((r) => shape(r, names)), page, pages: Math.max(1, Math.ceil(total / PAGE)), total, stats: s, catalog });
}

// Returning customer: what we already know about this phone number, and any unpaid WhatsApp/UPI orders that a link could settle instead.
async function prefill(ctx) {
  const { env, url } = ctx, sp = url.searchParams;
  const names = await productNames(env);
  const orderId = sp.get("order");
  const COLS = "id,name,phone,email,address,pincode,state,gstin,items_json,total,payment_status,status,created_at,txn_id";
  const dom = " AND coalesce(market,'IN')<>'INTL'";
  const rows = async (where, ...b) => {
    try { return (await env.DB.prepare(`SELECT ${COLS} FROM orders WHERE ${where}${dom} ORDER BY created_at DESC LIMIT 10`).bind(...b).all()).results; }
    catch { return (await env.DB.prepare(`SELECT ${COLS} FROM orders WHERE ${where} ORDER BY created_at DESC LIMIT 10`).bind(...b).all()).results; }
  };
  const itemsOf = (o) => parse(o.items_json, []).map((i) => ({ id: i.id, qty: i.qty, name: names[i.id] || i.id }));
  if (orderId) {
    if (!/^[0-9a-fA-F-]{8,64}$/.test(orderId)) return ctx.fail(400, "Invalid order");
    const [o] = await rows("id=?", orderId);
    if (!o) return ctx.fail(404, "Order not found");
    return ctx.json({ order: { id: o.id, ref: ref(o.id), payment_status: o.payment_status, status: o.status, total_paise: o.total, items: itemsOf(o) },
      customer: { name: o.name, phone: o.phone, email: o.email, address: o.address, pincode: o.pincode, state: o.state, gstin: o.gstin } });
  }
  const phone = String(sp.get("phone") || "").replace(/\D/g, "").slice(-10);
  if (phone.length !== 10) return ctx.json({ found: false });
  const os = await rows("phone=?", phone);
  if (!os.length) return ctx.json({ found: false });
  const latest = os[0], lastPaid = os.find((o) => o.payment_status === "paid");
  return ctx.json({
    found: true, customer: { name: latest.name, phone, email: latest.email, address: latest.address, pincode: latest.pincode, state: latest.state, gstin: os.find((o) => o.gstin)?.gstin || "" },
    orders: os.length, last_order_at: latest.created_at, last_paid_items: lastPaid ? itemsOf(lastPaid) : [],
    unpaid_orders: os.filter((o) => o.payment_status === "unpaid" && !["cancelled", "returned"].includes(o.status)).slice(0, 5).map((o) => ({ id: o.id, ref: ref(o.id), total_paise: o.total, created_at: o.created_at, items: itemsOf(o) })),
  });
}

async function create(ctx) {
  const { env, actor, body: b } = ctx, errors = {};
  if (!(await hasPayLinks(env))) return ctx.fail(409, "Payment links need database migration 0020 first");
  const name = sanitiseText(b.name, 100);
  if (name.length < 2 || /[|<>]/.test(name)) errors.name = "Enter the customer's name";
  const phone = typeof b.phone === "string" || typeof b.phone === "number" ? String(b.phone).replace(/\D/g, "").slice(-10) : "";
  if (phone.length !== 10) errors.phone = "Enter a 10-digit mobile number";
  const email = sanitiseText(b.email, 254);
  if (email && !EMAIL_RE.test(email)) errors.email = "Enter a valid email or leave it blank";
  const address = sanitiseText(b.address, 500);
  if (address.length < 10) errors.address = "Enter the full delivery address";
  const pincode = sanitiseText(b.pincode, 6);
  if (!/^\d{6}$/.test(pincode)) errors.pincode = "Enter the 6-digit pincode";
  const state = sanitiseText(b.state, 50);
  if (!state) errors.state = "Choose the delivery state";
  const gstin = sanitiseText(b.gstin, 15).toUpperCase();
  if (gstin && !GSTIN_RE.test(gstin)) errors.gstin = "That GST number is not valid. Leave it blank if there is none";
  const note = sanitiseText(b.note, 500);
  const hours = b.expires_in_hours === undefined ? PAYLINKS.DEFAULT_EXPIRY_HOURS : Number(b.expires_in_hours);
  if (!PAYLINKS.EXPIRY_HOURS.includes(hours)) errors.expires_in_hours = "Choose how long the link stays valid";
  const items = PAYLINKS.normaliseItems(b.items);
  let est = null;
  if (!items) errors.items = "Add at least one product with a whole-number quantity";
  else {
    const { results: prods } = await env.DB.prepare("SELECT id,name,active,price_paise,cost_paise,member_discount_pct FROM products").all();
    const live = Object.fromEntries(prods.map((p) => [p.id, p]));
    const bad = items.find((i) => !PRICING.PRODUCTS[i.id] || !live[i.id] || !live[i.id].active);
    if (bad) errors.items = `${(live[bad.id] && live[bad.id].name) || bad.id} cannot be sold through checkout right now`;
    else {
      const cfg = Object.fromEntries((await env.DB.prepare("SELECT key,value FROM membership_config").all()).results.map((r) => [r.key, r.value]));
      est = PRICING.priceCart(items, { products: PRICING.PRODUCTS, live, state, member: false, settings: PRICING.settingsFrom(cfg) });
      if (!est) errors.items = "Check the quantities: the minimum is 10 pieces per product (1 for kits and UHF packs)";
    }
  }
  let srcId = null;
  if (b.source_order_id) {
    srcId = String(b.source_order_id);
    const so = /^[0-9a-fA-F-]{8,64}$/.test(srcId) ? await env.DB.prepare("SELECT payment_status, status FROM orders WHERE id=?").bind(srcId).first() : null;
    if (!so) errors.source_order_id = "That order was not found";
    else if (so.payment_status !== "unpaid" || ["cancelled", "returned"].includes(so.status)) errors.source_order_id = "Only an open, unpaid order can be replaced by a payment link";
  }
  // Dry run: just the estimate while the admin is still typing (only the items and state matter), nothing is saved.
  if (b.dry_run === true) {
    if (errors.items) return ctx.json({ error: errors.items, fields: { items: errors.items } }, 400);
    return ctx.json({ dry_run: true, est_paise: est.amount * 100, shipping_paise: Math.round(est.shipping * 100) });
  }
  if (Object.keys(errors).length) return ctx.json({ error: "Please fix the highlighted fields", fields: errors }, 400);

  const id = PAYLINKS.newToken(), t = now(), json = JSON.stringify(items);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO pay_links (id,source,created_by,items_json,orig_items_json,name,phone,email,address,pincode,state,gstin,note,source_order_id,quoted_paise,created_at,expires_at)
      VALUES (?,'admin',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, actor, json, json, name, phone, email || null, address, pincode, state, gstin || null, note || null, srcId, est.amount * 100, t, t + hours * 3600),
    auditStmt(env, actor, "paylink_create", { link: ref(id), source_order: ref(srcId), estimate_inr: est.amount, valid_hours: hours, lines: items.length }),
  ]);
  return ctx.json({ id, url: BASE + id, est_paise: est.amount * 100, expires_at: t + hours * 3600 }, 201);
}

async function load(env, id) {
  const r = await env.DB.prepare(`SELECT * FROM (SELECT *, ${ST(now())} AS st FROM (${BASE_SQL})) WHERE id=?`).bind(id).first();
  return r || null;
}

async function extend(ctx, m) {
  const { env, actor, body: b } = ctx;
  const hours = Number(b.hours);
  if (!PAYLINKS.EXPIRY_HOURS.includes(hours)) return ctx.fail(400, "Choose how long to extend the link");
  const r = await load(env, m[1]);
  if (!r) return ctx.fail(404, "Link not found");
  if (r.st === "paid") return ctx.fail(409, "This link is already paid");
  if (r.st === "cancelled") return ctx.fail(409, "This link was cancelled. Make a new one");
  const exp = now() + hours * 3600;
  await env.DB.batch([env.DB.prepare("UPDATE pay_links SET expires_at=? WHERE id=?").bind(exp, r.id), auditStmt(env, actor, "paylink_extend", { link: ref(r.id), valid_hours: hours })]);
  return ctx.json({ ok: true, expires_at: exp });
}

async function cancel(ctx, m) {
  const { env, actor } = ctx;
  const r = await load(env, m[1]);
  if (!r) return ctx.fail(404, "Link not found");
  if (r.st === "paid") return ctx.fail(409, "This link is already paid");
  await env.DB.batch([env.DB.prepare("UPDATE pay_links SET status='cancelled' WHERE id=? AND NOT EXISTS (SELECT 1 FROM orders WHERE payment_status='paid' AND txn_id IN (SELECT value FROM json_each(pay_links.txn_ids)))").bind(r.id),
    auditStmt(env, actor, "paylink_cancel", { link: ref(r.id) })]);
  return ctx.json({ ok: true });
}

// The admin tapped "WhatsApp": record that it was sent (first time) or reminded, so the list shows who has been chased and when.
async function sent(ctx, m) {
  const { env, actor, body: b } = ctx;
  const kind = b.kind === "remind" ? "remind" : "send";
  const r = await load(env, m[1]);
  if (!r) return ctx.fail(404, "Link not found");
  if (!["new", "sent", "opened"].includes(r.st)) return ctx.fail(409, r.st === "expired" ? "This link has expired. Extend it first" : "This link is closed");
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE pay_links SET sent_at=COALESCE(sent_at,?1), reminder_count=reminder_count+?2, last_reminded_at=CASE WHEN ?2=1 THEN ?1 ELSE last_reminded_at END WHERE id=?3").bind(t, kind === "remind" ? 1 : 0, r.id),
    auditStmt(env, actor, kind === "remind" ? "paylink_remind" : "paylink_send", { link: ref(r.id) }),
  ]);
  return ctx.json({ ok: true });
}

const routes = [
  { m: "GET", p: /^\/api\/paylinks$/, h: list },
  { m: "POST", p: /^\/api\/paylinks$/, h: create },
  { m: "GET", p: /^\/api\/paylinks\/prefill$/, h: prefill },
  { m: "POST", p: /^\/api\/paylinks\/([0-9a-f]{32})\/extend$/, h: extend },
  { m: "POST", p: /^\/api\/paylinks\/([0-9a-f]{32})\/cancel$/, h: cancel },
  { m: "POST", p: /^\/api\/paylinks\/([0-9a-f]{32})\/sent$/, h: sent },
];

export async function payLinkRoute(ctx) {
  if (!ctx.url.pathname.startsWith("/api/paylinks")) return null;
  for (const r of routes) {
    if (r.m !== ctx.method) continue;
    const match = ctx.url.pathname.match(r.p);
    if (match) return await r.h(ctx, match);
  }
  return null;
}
