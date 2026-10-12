// Shared CRM helpers: permissions, IST date ranges, audit, safe CSV, metric definitions, marketing-eligibility SQL.
// Money is always paise. Every query is parameterised; nothing here builds SQL from request text except through fixed maps.

export const IST_OFFSET = 19800; // Asia/Kolkata, no DST: all CRM days start at 00:00 IST
export const PAGE_SIZE = 25;
export const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const POLICY_VERSION = "2026-10"; // bump when the privacy/marketing policy text changes; stored with each consent

export const now = () => Math.floor(Date.now() / 1000);
export const normEmail = (e) => (typeof e === "string" ? e.trim().toLowerCase().slice(0, 254) : "");
export const sanitiseText = (s, max) => (typeof s === "string" ? s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max) : "");
export const likeOf = (q) => `%${String(q).replace(/[%_\\]/g, (c) => "\\" + c)}%`; // use with: LIKE ? ESCAPE '\\'
export const pageOf = (sp) => Math.min(Math.max(parseInt(sp.get("page"), 10) || 1, 1), 100000);

// ── Permissions (least privilege) ────────────────────────────────────────────
// view: every allow-listed admin unless CRM_VIEW_EMAILS is set. export / send: ONLY the owner (first ADMIN_EMAILS entry) unless
// CRM_EXPORT_EMAILS / CRM_SEND_EMAILS list others. `manage` (tags, notes, consent, segments, journeys, erasure) defaults like view.
const list = (v) => (v || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
export function permsOf(env, actor) {
  const admins = list(env.ADMIN_EMAILS), owner = admins[0];
  const has = (varName, fallbackAll) => { const l = list(env[varName]); return l.length ? l.includes(actor) : fallbackAll ? admins.includes(actor) : actor === owner; };
  return { view: has("CRM_VIEW_EMAILS", true), manage: has("CRM_MANAGE_EMAILS", true), export: has("CRM_EXPORT_EMAILS", false), send: has("CRM_SEND_EMAILS", false) };
}

// ── Date ranges ──────────────────────────────────────────────────────────────
// ?range=today|7d|30d|90d  or  ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive, IST). Returns unix seconds [from, to) plus the previous
// period of equal length for comparisons. Invalid input falls back to 30d.
const ymd = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (s) => Math.floor(Date.parse(s + "T00:00:00Z") / 1000) - IST_OFFSET;
export const istDay = (ts) => new Date((ts + IST_OFFSET) * 1000).toISOString().slice(0, 10);
export function rangeOf(sp) {
  const todayStart = Math.floor((now() + IST_OFFSET) / 86400) * 86400 - IST_OFFSET;
  let from, to, label = sp.get("range") || "30d";
  const f = sp.get("from"), t = sp.get("to");
  if (f && t && ymd.test(f) && ymd.test(t) && !Number.isNaN(Date.parse(f)) && !Number.isNaN(Date.parse(t))) {
    from = dayStart(f); to = dayStart(t) + 86400; label = "custom";
    if (to <= from || to - from > 800 * 86400) { from = todayStart - 29 * 86400; to = todayStart + 86400; label = "30d"; }
  } else {
    const days = { today: 1, "7d": 7, "30d": 30, "90d": 90 }[label] || 30;
    if (!{ today: 1, "7d": 1, "30d": 1, "90d": 1 }[label]) label = "30d";
    from = todayStart - (days - 1) * 86400; to = todayStart + 86400;
  }
  const span = to - from;
  return { from, to, label, prev_from: from - span, prev_to: from, days: Math.round(span / 86400), from_day: istDay(from), to_day: istDay(to - 1) };
}

// ── Audit ────────────────────────────────────────────────────────────────────
export const auditStmt = (env, actor, action, detail) =>
  env.DB.prepare("INSERT INTO audit_log (id,actor,action,detail) VALUES (?,?,?,?)").bind(crypto.randomUUID(), actor, action, JSON.stringify(detail ?? {}).slice(0, 4000));
export const audit = (env, actor, action, detail) => auditStmt(env, actor, action, detail).run();

// ── CSV (spreadsheet-formula safe) ──────────────────────────────────────────
// A leading = + - @ tab or CR makes Excel/Sheets run the cell as a formula; prefix a quote so it is data. Numbers pass through.
export function csvCell(v) {
  if (v === null || v === undefined) return "";
  let s = typeof v === "number" ? String(v) : String(v);
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const csvRow = (cells) => cells.map(csvCell).join(",") + "\r\n";

// ── Marketing eligibility ────────────────────────────────────────────────────
// Eligible = an explicit, current opt-in (marketing_contacts.status='subscribed'). Having ordered never makes anyone eligible.
// `alias` must expose an `email` column (crm_customers does).
export const eligibleSql = (alias) => `EXISTS (SELECT 1 FROM marketing_contacts mc WHERE mc.email = ${alias}.email AND mc.status = 'subscribed')`;

// ── Metric definitions (served to the UI for tooltips; keep wording exact, tests assert on the rules) ───────────
export const DEFS = {
  paid_order: "An order with payment_status = paid, a collected amount > 0, and a fulfilment status other than cancelled or returned. Only these are revenue.",
  gross_paid: "Money collected on paid orders, including GST and shipping, before refunds.",
  refunds: "Refunds recorded in the admin against paid orders (capped at the amount collected). Money is returned outside this system.",
  net_paid: "Gross paid minus refunds, for paid orders that are not cancelled/returned. Includes GST and shipping. Unpaid, pending, cancelled and returned orders contribute 0.",
  net_product: "Net paid revenue without GST and shipping, after discounts (the order's frozen qualifying value, refund-adjusted).",
  qualifying_spend: "Membership-qualifying spend used for Rewards tiers: only orders placed while signed in, plus audited manual adjustments. It can differ from net paid revenue.",
  aov: "Average order value = net paid revenue ÷ number of paid orders in the period.",
  orders_per_customer: "Paid orders ÷ customers with at least one paid order, in the period.",
  new_customer: "A customer whose first paid order falls inside the period (first-time purchaser), or a registered customer whose account was created inside the period (new account).",
  returning_customer: "A customer with a paid order inside the period AND at least one paid order before the period start.",
  active_customer: "A customer with at least one paid order inside the period.",
  inactive_customer: "A customer whose last paid order is older than N days (default 90) or who has never bought.",
  repeat_rate: "Customers with 2 or more lifetime paid orders ÷ customers with at least 1 lifetime paid order (as of the period end).",
  ltv: "Customer lifetime value = lifetime net paid revenue (incl. GST & shipping) ÷ customers with at least one paid order. Historical revenue, not a forecast.",
  period: "All days are Indian Standard Time (UTC+5:30). The range includes both end dates. Orders are dated by creation time (payment time is not stored).",
  email_eligible: "Customers with an explicit current marketing opt-in who are not unsubscribed or suppressed.",
  attributed_revenue: "Net paid revenue of orders placed within 7 days after a recipient's tracked click on that campaign's email. Last-click attribution. It is NOT proof the email caused the purchase.",
};

// ── Order-line helpers (items_json is [{id, qty, ...}]) ─────────────────────────────────────────────────────
// SQL fragment: does customer alias `c` have a counted order containing product `?`. Bind the product id once.
export const boughtProductSql = (alias) => `EXISTS (SELECT 1 FROM crm_orders o, json_each(o.items_json) j WHERE o.ckey = ${alias}.ckey AND o.counts = 1 AND json_extract(j.value, '$.id') = ?)`;
export const boughtCategorySql = (alias) => `EXISTS (SELECT 1 FROM crm_orders o, json_each(o.items_json) j JOIN products p ON p.id = json_extract(j.value, '$.id') WHERE o.ckey = ${alias}.ckey AND o.counts = 1 AND p.category = ?)`;
