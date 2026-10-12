// Automated journeys: a small scheduler, not a workflow engine. Every journey ships OFF + test mode.
// Candidates come from SQL; each email needs a current opt-in, must clear the global frequency cap, and its exit condition is re-checked
// (the candidate query is re-run for just those addresses) immediately before the claim + send. UNIQUE(journey_id,email,dedupe_key) stops repeats.
import { now, auditStmt, sanitiseText, PAGE_SIZE, pageOf } from "./common.js";
import * as email from "./email.js";

const MAX_PER_TICK = 25; // bounds subrequests per journey per cron run
const DAY = 86400;
const BOUNDS = { delay_hours: [0, 720], window_days: [1, 90], min_gap_days: [0, 60], lookback_days: [1, 30], days_after: [1, 365], inactive_days: [30, 730], within_paise: [1000, 10000000] };
const KINDS = {
  welcome: { keys: ["delay_hours", "window_days"], defaults: { delay_hours: 1, window_days: 7 }, subject: "Welcome to ntagz", heading: "Welcome to ntagz", body: "Thanks for subscribing to ntagz updates. We will only email you about our NFC products and offers.", cta: ["Browse products", "/order.html"] },
  abandoned_cart: { keys: ["delay_hours", "lookback_days"], defaults: { delay_hours: 24, lookback_days: 7 }, subject: "You left something in your cart", heading: "Still thinking it over?", body: "You left something in your cart. It is still there if you would like to finish your order.", cta: ["Return to your cart", "/order.html"] },
  first_purchase: { keys: ["days_after", "window_days"], defaults: { days_after: 7, window_days: 30 }, subject: "How are you getting on with your ntagz order?", heading: "Thanks for your order", body: "Thank you for your first order. If you need help setting up your NFC products, just reply to this email.", cta: ["Visit ntagz", "/order.html"] },
  membership_milestone: { keys: ["within_paise"], defaults: { within_paise: 50000 }, subject: "You are close to your next Rewards tier", heading: "You are close to your next tier", body: "", cta: ["See membership", "/membership/"] },
  repeat_reminder: { keys: ["days_after", "window_days"], defaults: { days_after: 60, window_days: 30, product_ids: [] }, subject: "Time to restock?", heading: "Time to restock?", body: "It has been a while since your last order. If you are running low, you can reorder here.", cta: ["Reorder", "/order.html"] },
  reengagement: { keys: ["inactive_days", "window_days"], defaults: { inactive_days: 90, window_days: 30 }, subject: "It has been a while", heading: "We have missed you", body: "It has been a while since your last order. Take a look at what we offer.", cta: ["Visit ntagz", "/order.html"] },
};
const parse = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };

// Normalise config: defaults + stored + input, numbers bounded, unknown keys dropped. Returns { config } or { error }.
async function normConfig(env, kind, ...layers) {
  const k = KINDS[kind], out = { min_gap_days: 3, ...k.defaults };
  for (const l of layers) {
    if (!l || typeof l !== "object") continue;
    for (const key of [...k.keys, "min_gap_days"]) {
      if (l[key] === undefined) continue;
      const n = Number(l[key]), [lo, hi] = BOUNDS[key];
      if (!Number.isInteger(n) || n < lo || n > hi) return { error: `${key} must be a whole number from ${lo} to ${hi}` };
      out[key] = n;
    }
    for (const [key, max] of [["subject", 150], ["heading", 120], ["body", 1000], ["cta_label", 40]]) if (typeof l[key] === "string") out[key] = sanitiseText(l[key], max).replace(key === "body" ? /$^/ : /[\r\n]+/g, " ");
    if (kind === "repeat_reminder" && l.product_ids !== undefined) {
      const ids = Array.isArray(l.product_ids) ? [...new Set(l.product_ids.map(String))] : null;
      if (!ids || ids.length > 6 || ids.some((x) => !/^[A-Za-z0-9_-]{1,64}$/.test(x))) return { error: "Choose up to 6 products" };
      if (ids.length) {
        const { results } = await env.DB.prepare(`SELECT id FROM products WHERE id IN (${email.placeholders(ids.length)})`).bind(...ids).all();
        if (results.length !== ids.length) return { error: "Unknown product in the filter" };
      }
      out.product_ids = ids;
    }
  }
  return { config: out };
}

// ── Candidate queries ────────────────────────────────────────────────────────
// Each returns SELECT email, user_id, dedupe_key, ts (+ extras) for subscribed people only.
const SUB = (col) => `JOIN marketing_contacts mc ON mc.email = ${col} AND mc.status = 'subscribed'`;
// Same qualifying-spend derivation as the segment builder / functions/lib/loyalty.js
const SPEND = `(coalesce((SELECT sum(o.qualifying_paise * (o.paid_paise - min(o.refunded_paise, o.paid_paise)) / o.paid_paise) FROM orders o
   WHERE o.user_id = c.user_id AND o.payment_status = 'paid' AND o.paid_paise > 0 AND o.status NOT IN ('cancelled', 'returned')), 0)
   + coalesce((SELECT sum(a.delta_paise) FROM loyalty_adjustments a WHERE a.user_id = c.user_id), 0))`;
function inner(kind, cfg, t) {
  const ph = (cfg.product_ids || []).map(() => "?").join(",");
  switch (kind) {
    case "welcome": return { sql: `SELECT mc.email, mc.user_id, 'w' || mc.consented_at AS dedupe_key, mc.consented_at AS ts FROM marketing_contacts mc
      WHERE mc.status = 'subscribed' AND mc.consented_at IS NOT NULL AND mc.consented_at <= ? AND mc.consented_at >= ?`, params: [t - cfg.delay_hours * 3600, t - cfg.window_days * DAY] };
    case "abandoned_cart": return { sql: `SELECT lower(u.email) AS email, u.id AS user_id, 'ac' || (max(e.ts) / 604800) AS dedupe_key, max(e.ts) AS ts
      FROM crm_events e JOIN users u ON u.id = e.user_id ${SUB("lower(u.email)")}
      WHERE e.event IN ('add_to_cart','begin_checkout') AND e.ts <= ? AND e.ts >= ?
        AND NOT EXISTS (SELECT 1 FROM crm_events e2 WHERE e2.user_id = u.id AND e2.event IN ('add_to_cart','begin_checkout') AND e2.ts > ?)
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.created_at >= e.ts AND (o.user_id = u.id OR lower(trim(o.email)) = lower(u.email)))
      GROUP BY u.id`, params: [t - cfg.delay_hours * 3600, t - cfg.lookback_days * DAY, t - cfg.delay_hours * 3600] };
    case "first_purchase": return { sql: `SELECT c.email, c.user_id, 'fp' || c.first_order_at AS dedupe_key, c.first_order_at AS ts FROM crm_customers c ${SUB("c.email")}
      WHERE c.paid_orders = 1 AND c.first_order_at <= ? AND c.first_order_at >= ?`, params: [t - cfg.days_after * DAY, t - (cfg.days_after + cfg.window_days) * DAY] };
    case "membership_milestone": return { sql: `SELECT c.email, c.user_id, 'mm' || nt.id AS dedupe_key, c.s_ts AS ts, nt.name AS next_name, nt.discount_pct AS next_pct, nt.min_spend_paise - c.s AS remaining
      FROM (SELECT c.*, ${SPEND} AS s, coalesce(c.first_seen_at, 0) AS s_ts FROM crm_customers c WHERE c.user_id IS NOT NULL) c ${SUB("c.email")}
      JOIN loyalty_tiers nt ON nt.id = (SELECT t2.id FROM loyalty_tiers t2 WHERE t2.active = 1 AND t2.min_spend_paise > c.s ORDER BY t2.min_spend_paise LIMIT 1)
      WHERE nt.min_spend_paise - c.s > 0 AND nt.min_spend_paise - c.s <= ? AND (SELECT value FROM membership_config WHERE key = 'loyalty_live') = '1'`, params: [cfg.within_paise] };
    case "repeat_reminder": return ph ? { sql: `SELECT c.email, c.user_id, 'rr' || o.id AS dedupe_key, o.created_at AS ts FROM crm_orders o JOIN crm_customers c ON c.ckey = o.ckey ${SUB("c.email")}
      WHERE o.counts = 1 AND o.created_at <= ? AND o.created_at >= ?
        AND EXISTS (SELECT 1 FROM json_each(o.items_json) j WHERE json_extract(j.value, '$.id') IN (${ph}))
        AND NOT EXISTS (SELECT 1 FROM crm_orders o2 WHERE o2.ckey = o.ckey AND o2.counts = 1 AND o2.created_at > o.created_at)`, params: [t - cfg.days_after * DAY, t - (cfg.days_after + cfg.window_days) * DAY, ...cfg.product_ids] } : null;
    case "reengagement": return { sql: `SELECT c.email, c.user_id, 're' || c.last_order_at AS dedupe_key, c.last_order_at AS ts FROM crm_customers c ${SUB("c.email")}
      WHERE c.paid_orders >= 1 AND c.last_order_at <= ? AND c.last_order_at >= ?`, params: [t - cfg.inactive_days * DAY, t - (cfg.inactive_days + cfg.window_days) * DAY] };
  }
  return null;
}

// Wraps a candidate query with: not already run for this trigger, and the global frequency cap (campaigns AND journeys).
// `only` restricts to specific addresses: used to re-check exit conditions right before sending.
async function candidates(env, j, cfg, { live, limit, only }) {
  const t = now(), q = inner(j.kind, cfg, t);
  if (!q) return [];
  const cut = t - cfg.min_gap_days * DAY;
  const sql = `SELECT * FROM (${q.sql}) t WHERE NOT EXISTS (SELECT 1 FROM journey_runs jr WHERE jr.journey_id = ? AND jr.email = t.email AND jr.dedupe_key = t.dedupe_key${live ? " AND jr.status <> 'would_send'" : ""})
    AND NOT EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.email = t.email AND r.sent_at >= ?)
    AND NOT EXISTS (SELECT 1 FROM journey_runs x WHERE x.email = t.email AND x.status = 'sent' AND x.created_at >= ?)
    ${only ? `AND t.email IN (${email.placeholders(only.length)})` : ""} ORDER BY t.ts LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...q.params, j.id, cut, cut, ...(only || []), limit).all();
  const seen = new Set();
  return results.filter((r) => (seen.has(r.email) ? false : seen.add(r.email)));
}

// ── Message per kind (never cart contents or order details) ──────────────────
async function specFor(env, j, cfg, row, products) {
  const k = KINDS[j.kind], notes = [];
  let body = cfg.body !== undefined ? cfg.body : k.body;
  if (j.kind === "membership_milestone") {
    notes.push(`You are ${email.inr(row.remaining)} away from ${row.next_name}${row.next_pct > 0 ? ` (${row.next_pct}% off eligible products)` : ""}. Spend counts orders placed while signed in, on eligible products.`);
    if (cfg.body === undefined) body = "";
  }
  return { subject: cfg.subject ?? k.subject, preview: "", template: "standard", heading: cfg.heading ?? k.heading, paragraphs: String(body).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean),
    products: j.kind === "repeat_reminder" ? products : [], cta: { label: cfg.cta_label || k.cta[0], path: k.cta[1] }, notes, utm: { campaign: "journey-" + j.kind, medium: "journey" } };
}

const mkRun = (env, j, row, status, detail) => env.DB.prepare("INSERT OR IGNORE INTO journey_runs (id,journey_id,email,status,detail,dedupe_key) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(), j.id, row.email, status, detail, row.dedupe_key);

async function runJourney(env, j, cfg, live) {
  const rows = await candidates(env, j, cfg, { live, limit: MAX_PER_TICK });
  if (!rows.length) return 0;
  if (!live) { await env.DB.batch(rows.map((r) => mkRun(env, j, r, "would_send", "test mode: nothing was sent"))); return rows.length; }
  const products = j.kind === "repeat_reminder" && cfg.product_ids.length
    ? (await env.DB.prepare(`SELECT id,name,price_paise,all_inclusive,image_url FROM products WHERE active = 1 AND id IN (${email.placeholders(cfg.product_ids.length)})`).bind(...cfg.product_ids).all()).results : [];
  const names = await email.firstNames(env, rows.map((r) => r.email));
  const built = new Map();
  for (const r of rows) built.set(r.email, { row: r, msg: await email.render(env, await specFor(env, j, cfg, r, products), { email: r.email, first: names.get(r.email) }) });
  // Send-time re-check: still subscribed, still outside the cap, exit condition (purchased since trigger etc.) still false, trigger unchanged.
  const still = await candidates(env, j, cfg, { live: true, limit: MAX_PER_TICK, only: [...built.keys()] });
  const todo = still.filter((s) => built.get(s.email) && built.get(s.email).row.dedupe_key === s.dedupe_key).map((s) => built.get(s.email));
  if (!todo.length) return 0;
  const claims = await env.DB.batch(todo.map(({ row }) => env.DB.prepare(`INSERT INTO journey_runs (id,journey_id,email,status,detail,dedupe_key) VALUES (?,?,?,'skipped','claimed',?)
    ON CONFLICT(journey_id,email,dedupe_key) DO UPDATE SET status='skipped', detail='claimed', created_at=unixepoch() WHERE journey_runs.status='would_send'`).bind(crypto.randomUUID(), j.id, row.email, row.dedupe_key)));
  const mine = todo.filter((_, i) => claims[i].meta.changes === 1);
  if (!mine.length) return 0;
  let r;
  try { r = await email.send(env, mine.map(({ row, msg }) => ({ key: `${j.id}:${row.email}:${row.dedupe_key}`, to: row.email, ...msg }))); }
  catch (e) { r = { ok: false, error: "internal error" }; }
  await env.DB.batch(mine.map(({ row }, i) => r.ok
    ? env.DB.prepare("UPDATE journey_runs SET status='sent', detail=NULL, provider_id=?, created_at=unixepoch() WHERE journey_id=? AND email=? AND dedupe_key=?").bind(r.ids[i] || null, j.id, row.email, row.dedupe_key)
    : env.DB.prepare("UPDATE journey_runs SET status='error', detail=? WHERE journey_id=? AND email=? AND dedupe_key=?").bind(String(r.error).slice(0, 100), j.id, row.email, row.dedupe_key)));
  return mine.length;
}

export async function tick(env) {
  const { results } = await env.DB.prepare("SELECT * FROM journeys WHERE active = 1").all();
  const configured = email.status(env).configured;
  for (const j of results) {
    const live = !j.test_mode;
    if (live && !configured) continue; // nothing is simulated or marked sent
    try {
      const c = await normConfig(env, j.kind, parse(j.config_json));
      if (c.config) await runJourney(env, j, c.config, live);
    } catch (e) {
      console.error("journey tick failed:", j.kind, e && e.message);
      await env.DB.prepare("INSERT OR IGNORE INTO journey_runs (id,journey_id,email,status,detail,dedupe_key) VALUES (?,?,'(journey)','error','evaluation failed',?)").bind(crypto.randomUUID(), j.id, "err" + Math.floor(now() / 3600)).run().catch(() => {});
    }
  }
}

// ── API ──────────────────────────────────────────────────────────────────────
async function shape(env, j) {
  const c = await normConfig(env, j.kind, parse(j.config_json));
  const { results } = await env.DB.prepare("SELECT status, count(*) n FROM (SELECT status FROM journey_runs WHERE journey_id=? ORDER BY created_at DESC, rowid DESC LIMIT 20) GROUP BY status").bind(j.id).all();
  const runs = { sent: 0, would_send: 0, skipped: 0, error: 0 }; for (const r of results) runs[r.status] = r.n;
  return { id: j.id, kind: j.kind, name: j.name, active: !!j.active, test_mode: !!j.test_mode, config: c.config || {}, updated_by: j.updated_by, updated_at: j.updated_at, last_20_runs: runs, defaults: { subject: KINDS[j.kind].subject, heading: KINDS[j.kind].heading, body: KINDS[j.kind].body } };
}
const getJ = (env, id) => env.DB.prepare("SELECT * FROM journeys WHERE id=?").bind(id).first();

async function list(ctx) {
  const { results } = await ctx.env.DB.prepare("SELECT * FROM journeys ORDER BY rowid").all();
  return ctx.json({ journeys: await Promise.all(results.map((j) => shape(ctx.env, j))), email: email.status(ctx.env) });
}

async function runs(ctx, match) {
  const j = await getJ(ctx.env, match[1]); if (!j) return ctx.fail(404, "Journey not found");
  const page = pageOf(ctx.url.searchParams);
  const [{ results }, total] = await Promise.all([
    ctx.env.DB.prepare("SELECT id,email,status,detail,created_at FROM journey_runs WHERE journey_id=? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?").bind(j.id, PAGE_SIZE, (page - 1) * PAGE_SIZE).all(),
    ctx.env.DB.prepare("SELECT count(*) n FROM journey_runs WHERE journey_id=?").bind(j.id).first(),
  ]);
  return ctx.json({ runs: results.map((r) => ({ ...r, email: email.maskEmail(r.email) })), page, page_size: PAGE_SIZE, total: total.n });
}

async function update(ctx, match) {
  const { env, actor, body } = ctx;
  const j = await getJ(env, match[1]); if (!j) return ctx.fail(404, "Journey not found");
  const c = await normConfig(env, j.kind, parse(j.config_json), body.config);
  if (c.error) return ctx.fail(400, c.error);
  const active = body.active === undefined ? !!j.active : body.active === true, test = body.test_mode === undefined ? !!j.test_mode : body.test_mode !== false;
  if (j.kind === "repeat_reminder" && active && !c.config.product_ids.length) return ctx.fail(400, "Choose the products this reminder applies to before turning it on");
  if (active && !test) {
    if (!(j.active && !j.test_mode) && body.confirm_live !== true) return ctx.fail(400, "Confirm that this journey will send real emails");
    if (!email.status(env).configured) return ctx.fail(409, email.notConfiguredMessage(env));
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE journeys SET active=?, test_mode=?, config_json=?, updated_by=?, updated_at=unixepoch() WHERE id=?").bind(active ? 1 : 0, test ? 1 : 0, JSON.stringify(c.config), actor, j.id),
    auditStmt(env, actor, "crm_journey_update", { id: j.id, active, test_mode: test, config: c.config }),
  ]);
  return ctx.json({ journey: await shape(env, await getJ(env, j.id)) });
}

// Dry evaluation: who WOULD receive right now. Writes nothing, sends nothing.
async function runNow(ctx, match) {
  const j = await getJ(ctx.env, match[1]); if (!j) return ctx.fail(404, "Journey not found");
  const c = await normConfig(ctx.env, j.kind, parse(j.config_json));
  const rows = await candidates(ctx.env, j, c.config, { live: !j.test_mode, limit: 50 });
  return ctx.json({ dry_run: true, sends_nothing: true, count: rows.length, would_receive: rows.map((r) => ({ email: email.maskEmail(r.email), dedupe_key: r.dedupe_key })) });
}

export const routes = [
  { m: "GET", p: /^\/api\/crm\/journeys$/, perm: "view", h: list },
  { m: "GET", p: /^\/api\/crm\/journeys\/([a-z_]{1,40})\/runs$/, perm: "view", h: runs },
  { m: "POST", p: /^\/api\/crm\/journeys\/([a-z_]{1,40})$/, perm: "send", h: update },
  { m: "POST", p: /^\/api\/crm\/journeys\/([a-z_]{1,40})\/run-now$/, perm: "send", h: runNow },
];
