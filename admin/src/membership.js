// Admin API for Ntagz Rewards Membership: points/milestone settings, customer wallets (ledger, audited manual adjustments), manual membership
// grant/end, analytics, and the cron job (point expiry, membership status, expiry notices). Mounted by index.js under /api/points and
// /api/members. Money is paise; points are integers; every change is audited. Reads go through functions/lib/points.js.
import POINTS from "../../functions/lib/points.js";
import { permsOf, rangeOf, auditStmt, sanitiseText, likeOf, now, EMAIL_RE } from "./crm/common.js";

const DAY = 86400;
const SETTING_KEYS = ["checkout_offer", "pts_live", "pts_earn_per_100", "pts_value_paise", "pts_min_redeem", "pts_max_redeem_pct", "pts_min_order_paise", "pts_valid_days", "pts_earn_on", "pts_restore_on_cancel", "pts_clawback", "renew_window_days", "renew_notice_days"];

async function state(env) {
  const [cfg, ms, counts, prods] = await Promise.all([
    env.DB.prepare("SELECT key,value FROM membership_config").all(),
    env.DB.prepare("SELECT id,label,threshold_paise,bonus_points,active,sort_order FROM reward_milestones ORDER BY threshold_paise").all(),
    env.DB.prepare(`SELECT (SELECT count(*) FROM memberships WHERE status='active' AND expires_at>?1) active_members,
        (SELECT count(*) FROM points_ledger) ledger_rows, (SELECT count(*) FROM products WHERE points_eligible=0) excluded_products`).bind(now()).first(),
    env.DB.prepare("SELECT id,name,category,active,price_paise,cost_paise,member_discount_pct,points_eligible FROM products ORDER BY name").all(),
  ]);
  const c = Object.fromEntries(cfg.results.map((r) => [r.key, r.value]));
  const settings = POINTS.settingsFrom(c);
  const raw = Object.fromEntries(SETTING_KEYS.map((k) => [k, c[k] ?? null]));
  return { settings, raw, plan: { fee_paise: Number(c.fee_paise) || 99900, duration_days: Number(c.duration_days) || 365, discounts_live: c.discounts_live === "1" },
    milestones: ms.results.map((m) => ({ ...m, active: !!m.active })), counts, products: prods.results.map((p) => ({ ...p, points_eligible: !!p.points_eligible, active: !!p.active })) };
}
const versionOf = async (st) => {
  const b = new TextEncoder().encode(JSON.stringify([st.raw, st.milestones]));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
};

// Warnings an admin should see before enabling: cost data, reward liability, caps.
async function warnings(env, st) {
  const w = [];
  const s = st.settings;
  const earnRatePct = (s.earnPer100 * s.valuePaise) / 100; // value returned per ₹100 spent, as a percentage of spend
  if (earnRatePct > 5) w.push(`Points are worth ${earnRatePct.toFixed(1)}% of eligible spend. Together with member prices this may be more than your margin allows.`);
  if (s.maxRedeemPct > 20) w.push(`Customers may pay up to ${s.maxRedeemPct}% of an order with points.`);
  const noCost = (await env.DB.prepare("SELECT count(*) n FROM products WHERE active=1 AND cost_paise IS NULL").first()).n;
  if (noCost) w.push(`${noCost} active product(s) have no cost price, so contribution impact can't be calculated for them.`);
  if (st.milestones.some((m) => m.active) && !s.clawback) w.push("Milestone bonuses are not taken back if refunds drop spend under the threshold.");
  if (!st.plan.discounts_live) w.push("Member pricing is off (Pricing page): members currently pay regular prices, so only points and milestones would be a benefit.");
  return w;
}

async function getState(ctx) {
  const st = await state(ctx.env);
  return ctx.json({ ...st, version: await versionOf(st), warnings: await warnings(ctx.env, st), permissions: ctx.perms });
}

async function saveSettings(ctx) {
  const { env, actor, body } = ctx, cur = await state(env);
  if (body.version !== (await versionOf(cur))) return ctx.fail(409, "Settings changed since you opened this page. Reload and review again.");
  const { errors, values } = POINTS.validateSettings(body.settings && typeof body.settings === "object" ? body.settings : {});
  if (errors.length) return ctx.json({ error: errors[0], errors }, 400);
  const next = POINTS.settingsFrom({ ...cur.raw, ...values });
  if (next.live && next.earnPer100 > 0 && next.maxRedeemPct > 0 && (next.minRedeem * next.valuePaise) <= 0) return ctx.fail(400, "Contradictory redemption rules");
  const stmts = Object.entries(values).map(([k, v]) => env.DB.prepare("INSERT INTO membership_config (key,value,updated_at) VALUES (?1,?2,unixepoch()) ON CONFLICT(key) DO UPDATE SET value=?2, updated_at=unixepoch()").bind(k, v));
  stmts.push(auditStmt(env, actor, "points_settings", { from: cur.raw, to: values }));
  await env.DB.batch(stmts);
  return getState(ctx);
}

// Replace-style milestone editor. Rows are never deleted (awards reference them): a milestone left out is switched off, which also keeps history.
async function saveMilestones(ctx) {
  const { env, actor, body } = ctx, cur = await state(env);
  if (body.version !== (await versionOf(cur))) return ctx.fail(409, "Settings changed since you opened this page. Reload and review again.");
  const list = Array.isArray(body.milestones) ? body.milestones : null;
  if (!list || list.length > 12) return ctx.fail(400, "Provide up to 12 milestones");
  const out = [], seen = new Set(), thresholds = new Set();
  for (const [i, m] of list.entries()) {
    const id = typeof m.id === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(m.id) ? m.id : null;
    const threshold = Number(m.threshold_paise), bonus = Number(m.bonus_points);
    if (!id || seen.has(id)) return ctx.fail(400, `Milestone ${i + 1}: invalid or duplicate id`);
    if (!Number.isSafeInteger(threshold) || threshold < 100 || threshold > 1e9) return ctx.fail(400, `Milestone ${i + 1}: threshold must be at least ₹1`);
    if (!Number.isSafeInteger(bonus) || bonus < 1 || bonus > 1e6) return ctx.fail(400, `Milestone ${i + 1}: bonus must be 1 to 1,000,000 points`);
    if (m.active !== false && thresholds.has(threshold)) return ctx.fail(400, `Milestone ${i + 1}: two active milestones share a threshold`);
    seen.add(id); if (m.active !== false) thresholds.add(threshold);
    out.push({ id, label: sanitiseText(m.label, 60), threshold_paise: threshold, bonus_points: bonus, active: m.active === false ? 0 : 1, sort_order: i });
  }
  const stmts = out.map((m) => env.DB.prepare(`INSERT INTO reward_milestones (id,label,threshold_paise,bonus_points,active,sort_order,updated_at) VALUES (?1,?2,?3,?4,?5,?6,unixepoch())
      ON CONFLICT(id) DO UPDATE SET label=?2, threshold_paise=?3, bonus_points=?4, active=?5, sort_order=?6, updated_at=unixepoch()`).bind(m.id, m.label, m.threshold_paise, m.bonus_points, m.active, m.sort_order));
  for (const old of cur.milestones) if (!seen.has(old.id) && old.active) stmts.push(env.DB.prepare("UPDATE reward_milestones SET active=0, updated_at=unixepoch() WHERE id=?").bind(old.id));
  stmts.push(auditStmt(env, actor, "points_milestones", { from: cur.milestones.map((m) => [m.id, m.threshold_paise, m.bonus_points, m.active]), to: out.map((m) => [m.id, m.threshold_paise, m.bonus_points, m.active]) }));
  await env.DB.batch(stmts);
  return getState(ctx);
}

// Milestone statistics: how many members reached each, bonus points issued.
async function milestoneStats(ctx) {
  const { results } = await ctx.env.DB.prepare(`SELECT m.id, m.label, m.threshold_paise, m.bonus_points, m.active,
      (SELECT count(*) FROM points_ledger l WHERE l.kind='bonus' AND l.ref=m.id) awarded,
      (SELECT coalesce(sum(points),0) FROM points_ledger l WHERE l.kind='bonus' AND l.ref=m.id) points_issued,
      (SELECT coalesce(-sum(points),0) FROM points_ledger l WHERE l.kind='bonus_reverse' AND l.ref=m.id) taken_back
    FROM reward_milestones m ORDER BY m.threshold_paise`).all();
  return ctx.json({ milestones: results.map((r) => ({ ...r, active: !!r.active })) });
}

// ── Customers ────────────────────────────────────────────────────────────────────────────────────────────────
async function searchMembers(ctx) {
  const q = (ctx.url.searchParams.get("q") || "").trim().slice(0, 80), page = Math.max(parseInt(ctx.url.searchParams.get("page"), 10) || 1, 1), like = q ? likeOf(q) : "%";
  const { results } = await ctx.env.DB.prepare(`SELECT u.id,u.email,u.name,
      (SELECT max(expires_at) FROM memberships m WHERE m.user_id=u.id AND m.status='active') expires_at,
      (SELECT count(*) FROM memberships m WHERE m.user_id=u.id AND m.status='active' AND m.expires_at>?3) active_terms,
      (SELECT coalesce(sum(points),0) FROM points_ledger l WHERE l.user_id=u.id AND l.kind<>'reserve') ledger_points
    FROM users u WHERE (u.email LIKE ?1 ESCAPE '\\' OR coalesce(u.name,'') LIKE ?1 ESCAPE '\\' OR coalesce(u.phone,'') LIKE ?1 ESCAPE '\\')
    ORDER BY (expires_at IS NULL), expires_at DESC, u.created_at DESC LIMIT 26 OFFSET ?2`).bind(like, (page - 1) * 25, now()).all();
  return ctx.json({ page, more: results.length > 25, customers: results.slice(0, 25).map((r) => ({ id: r.id, email: r.email, name: r.name, member: r.active_terms > 0, expires_at: r.expires_at, points: r.ledger_points })) });
}

async function getMember(ctx, m) {
  const { env } = ctx, id = m[1];
  const u = await env.DB.prepare("SELECT id,email,name,phone,created_at FROM users WHERE id=?").bind(id).first();
  if (!u) return ctx.fail(404, "Customer not found");
  const st = await POINTS.loadSettings(env.DB);
  const [sum, act, mems, orders] = await Promise.all([
    POINTS.summary(env.DB, id, st), POINTS.activity(env.DB, id, parseInt(ctx.url.searchParams.get("before"), 10) || 0, 50),
    env.DB.prepare("SELECT id,status,purchased_at,expires_at,price_paid,payment_id FROM memberships WHERE user_id=? ORDER BY purchased_at DESC").bind(id).all(),
    env.DB.prepare("SELECT id,created_at,status,payment_status,total,points_basis_paise,points_redeemed,member_saving_paise,refunded_paise FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 25").bind(id).all(),
  ]);
  return ctx.json({ customer: u, summary: sum, activity: act, memberships: mems.results.map((x) => ({ ...x, active: x.status === "active" && x.expires_at > now() })), orders: orders.results, referrals: null });
}

// Manual adjustment: owner-only, mandatory reason, idempotent, never takes a balance below zero. The ledger row is permanent.
async function adjust(ctx, m) {
  const { env, actor, body } = ctx, id = m[1];
  const u = await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(id).first();
  if (!u) return ctx.fail(404, "Customer not found");
  const pts = Number(body.points), reason = sanitiseText(body.reason, 200), key = typeof body.idempotency_key === "string" ? body.idempotency_key.slice(0, 64) : "";
  if (!Number.isInteger(pts) || pts === 0 || Math.abs(pts) > 100000) return ctx.fail(400, "Enter a whole number of points (not 0)");
  if (reason.length < 5) return ctx.fail(400, "A reason of at least 5 characters is required");
  if (key.length < 8) return ctx.fail(400, "Missing operation key");
  if (body.confirm !== true) return ctx.fail(400, "Please confirm the adjustment");
  const st = await POINTS.loadSettings(env.DB), bal = await POINTS.balance(env.DB, id);
  if (pts < 0 && -pts > bal.available) return ctx.fail(409, `This would take the balance below zero (available ${bal.available})`);
  const res = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO points_ledger (id,user_id,kind,points,expires_at,idem_key,reason,actor) VALUES (?,?,'adjust',?,?,?,?,?)")
      .bind(crypto.randomUUID(), id, pts, pts > 0 ? now() + st.validDays * DAY : null, `adj:${id}:${key}`, reason, actor),
    auditStmt(env, actor, "points_adjust", { user_id: id, points: pts, reason }),
  ]);
  if (res[0].meta.changes !== 1) return ctx.json({ ok: true, duplicate: true });
  return ctx.json({ ok: true, balance: (await POINTS.balance(env.DB, id)).available });
}

// Authorised manual activation (e.g. a bank transfer or goodwill). Price recorded as what the admin states (0 by default), clearly marked.
async function grant(ctx) {
  const { env, actor, body } = ctx;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const reason = sanitiseText(body.reason, 200), days = Number(body.days);
  if (!EMAIL_RE.test(email)) return ctx.fail(400, "Enter the customer's account email");
  if (reason.length < 5) return ctx.fail(400, "A reason of at least 5 characters is required");
  if (!Number.isInteger(days) || days < 1 || days > 1095) return ctx.fail(400, "Days must be 1 to 1095");
  if (body.confirm !== true) return ctx.fail(400, "Please confirm");
  const u = await env.DB.prepare("SELECT id FROM users WHERE lower(email)=?").bind(email).first();
  if (!u) return ctx.fail(404, "No account with that email. The customer must sign up first.");
  const cur = await env.DB.prepare("SELECT max(expires_at) e FROM memberships WHERE user_id=? AND status='active' AND expires_at>?").bind(u.id, now()).first();
  const start = cur && cur.e > now() ? cur.e : now(), mid = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO memberships (id,user_id,status,purchased_at,expires_at,welcome_credit_paise,price_paid,payment_id) VALUES (?,?,'active',?,?,0,0,?)").bind(mid, u.id, start, start + days * DAY, `admin:${actor}`),
    auditStmt(env, actor, "membership_grant", { user_id: u.id, membership_id: mid, days, reason }),
  ]);
  return ctx.json({ ok: true, membership_id: mid, expires_at: start + days * DAY }, 201);
}

async function endMembership(ctx, m) {
  const { env, actor, body } = ctx, id = m[1];
  const mem = await env.DB.prepare("SELECT id,user_id,status FROM memberships WHERE id=?").bind(id).first();
  if (!mem) return ctx.fail(404, "Membership not found");
  const to = body.status === "refunded" ? "refunded" : body.status === "cancelled" ? "cancelled" : null;
  const reason = sanitiseText(body.reason, 200);
  if (!to) return ctx.fail(400, "Status must be cancelled or refunded");
  if (reason.length < 5) return ctx.fail(400, "A reason of at least 5 characters is required");
  if (body.confirm !== true) return ctx.fail(400, "Please confirm");
  if (mem.status !== "active") return ctx.fail(409, `This membership is already ${mem.status}`);
  await env.DB.batch([env.DB.prepare("UPDATE memberships SET status=? WHERE id=? AND status='active'").bind(to, id), auditStmt(env, actor, "membership_end", { membership_id: id, user_id: mem.user_id, to, reason })]);
  return ctx.json({ ok: true });
}

// ── Analytics ──────────────────────────────────────────────────────────────────────────────────────────────────
async function analytics(ctx) {
  const { env } = ctx, r = rangeOf(ctx.url.searchParams), t = now();
  const [mem, newM, rev, exp30, exp60, ren, aov, pts, liab, econ, conv] = await Promise.all([
    env.DB.prepare("SELECT count(DISTINCT user_id) n FROM memberships WHERE status='active' AND expires_at>?").bind(t).first(),
    env.DB.prepare("SELECT count(*) n FROM memberships WHERE purchased_at>=? AND purchased_at<? AND price_paid>0").bind(r.from, r.to).first(),
    env.DB.prepare("SELECT coalesce(sum(price_paid),0) s, count(*) n FROM memberships WHERE purchased_at>=? AND purchased_at<? AND price_paid>0 AND status IN ('active','expired')").bind(r.from, r.to).first(),
    env.DB.prepare("SELECT count(*) n FROM memberships m WHERE m.status='active' AND m.expires_at>? AND m.expires_at<=? AND NOT EXISTS (SELECT 1 FROM memberships n WHERE n.user_id=m.user_id AND n.status='active' AND n.expires_at>m.expires_at)").bind(t, t + 30 * DAY).first(),
    env.DB.prepare("SELECT count(*) n FROM memberships m WHERE m.status='active' AND m.expires_at>? AND m.expires_at<=? AND NOT EXISTS (SELECT 1 FROM memberships n WHERE n.user_id=m.user_id AND n.status='active' AND n.expires_at>m.expires_at)").bind(t, t + 60 * DAY).first(),
    // renewal rate: of the terms that ended in the period, the share whose owner holds a later term that started by 30 days after the end
    env.DB.prepare(`SELECT count(*) ended, sum(CASE WHEN EXISTS (SELECT 1 FROM memberships n WHERE n.user_id=m.user_id AND n.id<>m.id AND n.status IN ('active','expired') AND n.expires_at>m.expires_at AND n.purchased_at<=m.expires_at+?3) THEN 1 ELSE 0 END) renewed
        FROM memberships m WHERE m.status IN ('active','expired') AND m.expires_at>=?1 AND m.expires_at<?2 AND m.expires_at<=?4 AND m.price_paid>0`).bind(r.from, r.to, 30 * DAY, t - 30 * DAY).first(),
    // member order = placed while the customer held an active membership term
    env.DB.prepare(`SELECT sum(CASE WHEN mo THEN 1 ELSE 0 END) mo_n, sum(CASE WHEN mo THEN net END) mo_net, sum(CASE WHEN mo THEN 0 ELSE 1 END) no_n, sum(CASE WHEN mo THEN 0 ELSE net END) no_net
        FROM (SELECT x.net_paise net, EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=x.user_id AND m.status IN ('active','expired','cancelled','refunded') AND m.purchased_at<=x.created_at AND m.expires_at>x.created_at) mo
              FROM crm_orders x WHERE x.counts=1 AND x.user_id IS NOT NULL AND x.created_at>=?1 AND x.created_at<?2)`).bind(r.from, r.to).first(),
    env.DB.prepare(`SELECT coalesce(sum(CASE WHEN kind IN ('earn','bonus','restore') THEN points END),0) issued, coalesce(-sum(CASE WHEN kind='redeem' THEN points END),0) redeemed,
        coalesce(-sum(CASE WHEN kind='expire' THEN points END),0) expired, coalesce(-sum(CASE WHEN kind IN ('reverse','bonus_reverse') THEN points END),0) reversed
        FROM points_ledger WHERE created_at>=? AND created_at<?`).bind(r.from, r.to).first(),
    env.DB.prepare("SELECT coalesce(sum(b),0) pts, count(*) holders FROM (SELECT sum(points) b FROM points_ledger WHERE kind<>'reserve' GROUP BY user_id HAVING sum(points)>0)").first(),
    env.DB.prepare(`SELECT count(*) orders, coalesce(sum(o.points_basis_paise * (o.paid_paise - min(o.refunded_paise,o.paid_paise)) / o.paid_paise),0) eligible_sales,
        coalesce(sum(o.member_saving_paise),0) member_savings, coalesce(sum(o.points_discount_paise),0) points_discount,
        (SELECT coalesce(sum(CAST(json_extract(j.value,'$.qty') AS INTEGER) * p.cost_paise),0) FROM orders o2, json_each(o2.items_json) j JOIN products p ON p.id=json_extract(j.value,'$.id')
          WHERE o2.points_basis_paise>0 AND o2.payment_status='paid' AND o2.status NOT IN ('cancelled','returned') AND o2.created_at>=?1 AND o2.created_at<?2 AND p.cost_paise IS NOT NULL) cost_paise,
        (SELECT count(*) FROM orders o3, json_each(o3.items_json) j JOIN products p ON p.id=json_extract(j.value,'$.id')
          WHERE o3.points_basis_paise>0 AND o3.payment_status='paid' AND o3.status NOT IN ('cancelled','returned') AND o3.created_at>=?1 AND o3.created_at<?2 AND p.cost_paise IS NULL) lines_without_cost,
        (SELECT count(*) FROM orders o4, json_each(o4.items_json) j JOIN products p ON p.id=json_extract(j.value,'$.id')
          WHERE o4.points_basis_paise>0 AND o4.payment_status='paid' AND o4.status NOT IN ('cancelled','returned') AND o4.created_at>=?1 AND o4.created_at<?2 AND p.cost_paise IS NOT NULL) lines_with_cost
        FROM orders o WHERE o.points_basis_paise>0 AND o.payment_status='paid' AND o.paid_paise>0 AND o.status NOT IN ('cancelled','returned') AND o.created_at>=?1 AND o.created_at<?2`).bind(r.from, r.to).first(),
    env.DB.prepare("SELECT (SELECT count(DISTINCT m.user_id) FROM memberships m WHERE m.status IN ('active','expired') AND m.price_paid>0 AND EXISTS (SELECT 1 FROM orders o WHERE o.user_id=m.user_id AND o.payment_status='paid')) paying, (SELECT count(DISTINCT user_id) FROM orders WHERE user_id IS NOT NULL AND payment_status='paid') buyers").first(),
  ]);
  const st = await POINTS.loadSettings(env.DB);
  const costKnown = econ.lines_without_cost === 0 && econ.lines_with_cost > 0;
  const cost = costKnown ? econ.cost_paise : null;
  const discounts = econ.member_savings + econ.points_discount;
  return ctx.json({
    range: r,
    memberships: { active: mem.n, new_in_range: newM.n, revenue_paise: rev.s, expiring_30d: exp30.n, expiring_60d: exp60.n, renewal_rate: ren.ended ? Math.round((1000 * ren.renewed) / ren.ended) / 10 : null, terms_ended: ren.ended,
      conversion_rate: conv.buyers ? Math.round((1000 * conv.paying) / conv.buyers) / 10 : null },
    orders: { member_orders: aov.mo_n || 0, nonmember_orders: aov.no_n || 0, member_aov_paise: aov.mo_n ? Math.round(aov.mo_net / aov.mo_n) : null, nonmember_aov_paise: aov.no_n ? Math.round(aov.no_net / aov.no_n) : null },
    points: { issued: pts.issued, redeemed: pts.redeemed, expired: pts.expired, reversed: pts.reversed, outstanding_points: liab.pts, holders: liab.holders, outstanding_liability_paise: liab.pts * st.valuePaise,
      liability_note: "Includes points past their expiry date that the daily sweep has not yet removed." },
    economics: { member_sales_eligible_paise: Math.round(econ.eligible_sales), member_price_savings_paise: econ.member_savings, points_discount_paise: econ.points_discount,
      discounts_pct_of_eligible_sales: econ.eligible_sales ? Math.round((1000 * discounts) / econ.eligible_sales) / 10 : null,
      product_contribution_paise: cost === null ? null : Math.round(econ.eligible_sales) - cost, cost_data_complete: costKnown,
      note: "Net sales, not profit. Contribution (shown only when every product sold has a cost price) is net sales minus product cost, before shipping, payment fees and other variable costs." },
  });
}

export const routes = [
  { m: "GET", p: /^\/api\/points$/, h: getState },
  { m: "POST", p: /^\/api\/points\/settings$/, h: saveSettings },
  { m: "POST", p: /^\/api\/points\/milestones$/, h: saveMilestones },
  { m: "GET", p: /^\/api\/points\/milestone-stats$/, h: milestoneStats },
  { m: "GET", p: /^\/api\/points\/analytics$/, h: analytics },
  { m: "GET", p: /^\/api\/points\/customers$/, h: searchMembers },
  { m: "GET", p: /^\/api\/points\/customers\/([0-9a-fA-F-]{8,64})$/, h: getMember },
  { m: "POST", p: /^\/api\/points\/customers\/([0-9a-fA-F-]{8,64})\/adjust$/, perm: "export", h: adjust },
  { m: "POST", p: /^\/api\/members\/grant$/, perm: "export", h: grant },
  { m: "POST", p: /^\/api\/members\/([0-9a-fA-F-]{8,64})\/end$/, perm: "export", h: endMembership },
];

export async function membershipRoute(ctx) {
  if (!ctx.url.pathname.startsWith("/api/points") && !ctx.url.pathname.startsWith("/api/members/")) return null;
  for (const r of routes) {
    if (r.m !== ctx.method) continue;
    const match = ctx.url.pathname.match(r.p);
    if (!match) continue;
    const perms = permsOf(ctx.env, ctx.actor);
    if (r.perm && !perms[r.perm]) return ctx.fail(403, "You do not have permission for this action");
    return await r.h({ ...ctx, perms }, match);
  }
  return null;
}

// ── Cron: point expiry, membership status, expiry notices (transactional service emails, one per membership per threshold) ───────────
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (ts) => { const d = new Date((ts + 19800) * 1000); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function sendNotice(env, to, name, kind, expiresAt) {
  const hi = name ? `Hi ${String(name).split(/\s+/)[0]},` : "Hello,";
  const expired = kind === "expired";
  const subject = expired ? "Your ntagz membership has ended" : "Your ntagz membership is about to expire";
  const line = expired ? `Your ntagz Rewards Membership ended on ${fmt(expiresAt)}. Member prices and new points no longer apply. Points you already hold stay until their own expiry date.`
    : `Your ntagz Rewards Membership expires on ${fmt(expiresAt)}. You can renew from your account; the new year starts when the current one ends, so no days are lost.`;
  const link = "https://ntagz.com/membership/";
  const text = [hi, "", line, "", `Renew or view your rewards: ${link}`, "", "This is a service message about your membership, not a promotion."].join("\n");
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;color:#1d1d1f"><p>${esc(hi)}</p><p>${esc(line)}</p><p><a href="${link}" style="background:#ff5a1f;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;display:inline-block">View my membership</a></p><p style="color:#6e6e73;font-size:12px">This is a service message about your membership, not a promotion.</p></div>`;
  if (env.DEV_NOTIFY_ECHO === "1") return ["sent", "dev echo"]; // local testing only; never set in production
  if (!env.RESEND_API_KEY) return ["skipped", "email not configured"];
  const res = await fetch("https://api.resend.com/emails", { method: "POST", signal: AbortSignal.timeout(6000), headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "ntagz <hello@ntagz.com>", to: [to], subject, text, html }) }).catch(() => null);
  return res && res.ok ? ["sent", null] : ["failed", `email service ${res ? res.status : "unreachable"}`];
}

export async function tick(env) {
  const t = now();
  await env.DB.prepare("UPDATE memberships SET status='expired' WHERE status='active' AND expires_at<=?").bind(t).run();
  const st = await POINTS.loadSettings(env.DB);
  await POINTS.sweepExpiry(env.DB, t);
  if (!st.noticeDays.length) return;
  const maxDay = Math.max(...st.noticeDays);
  // Expiring soon: the smallest configured threshold already crossed, once, and not if a renewal is already queued behind this term.
  const { results } = await env.DB.prepare(`SELECT m.id,m.user_id,m.expires_at,u.email,u.name FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.status='active' AND m.price_paid>0 AND m.expires_at>? AND m.expires_at<=? AND NOT EXISTS (SELECT 1 FROM memberships n WHERE n.user_id=m.user_id AND n.status='active' AND n.expires_at>m.expires_at) LIMIT 40`).bind(t, t + maxDay * DAY).all();
  const recent = await env.DB.prepare(`SELECT m.id,m.user_id,m.expires_at,u.email,u.name FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.status='expired' AND m.price_paid>0 AND m.expires_at<=? AND m.expires_at>? AND NOT EXISTS (SELECT 1 FROM memberships n WHERE n.user_id=m.user_id AND n.status IN ('active','expired') AND n.expires_at>m.expires_at) LIMIT 40`).bind(t, t - 3 * DAY).all();
  const jobs = [...results.map((m) => ({ m, kind: `expiry_${[...st.noticeDays].sort((a, b) => a - b).find((d) => m.expires_at - t <= d * DAY)}` })), ...recent.results.map((m) => ({ m, kind: "expired" }))];
  for (const { m, kind } of jobs) {
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO membership_notices (membership_id,kind,user_id) VALUES (?,?,?)").bind(m.id, kind, m.user_id).run();
    if (ins.meta.changes !== 1) continue; // already handled: never repeated
    let status = "skipped", detail = "no email";
    if (EMAIL_RE.test(m.email || "") && !String(m.email).endsWith("@erased.invalid")) [status, detail] = await sendNotice(env, m.email, m.name, kind, m.expires_at);
    await env.DB.prepare("UPDATE membership_notices SET status=?, detail=? WHERE membership_id=? AND kind=?").bind(status, detail, m.id, kind).run();
  }
}
