// Email campaigns: drafts, audience review, frozen send list, batched sending, provider webhooks, reporting.
// Safety model: a recipient row exists once per (campaign,email) (UNIQUE), opt-in is re-checked immediately before each send, and a row is
// only marked sent after the provider answered 2xx. Without full provider configuration nothing is sent and nothing is marked sent.
import { now, auditStmt, sanitiseText, normEmail, EMAIL_RE, DEFS, istDay } from "./common.js";
import { eligibleRecipients, countAudience, treeOf, compileRules } from "./segments.js";
import * as email from "./email.js";
import CRM from "../../../functions/lib/crm.js";

const { consentStatements } = CRM;
const MAX_AUDIENCE = 5000; // ponytail: one campaign freezes at most 5,000 rows (multi-row inserts, bounded subrequests); raise with chunked freezing if needed
const BATCH = 100, MAX_ATTEMPTS = 3, STUCK_SECONDS = 600;
const TEMPLATES = ["standard", "minimal"];
const OFFER_TYPES = ["announcement", "membership_upgrade", "cart_milestone", "new_product", "reorder_reminder"];
const NO_COUPONS = "Needs checkout coupon support (not built yet)";
const oneLine = (s, max) => sanitiseText(s, max).replace(/[\r\n\t]+/g, " ");
const parse = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };
const intIn = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };

const shape = (c) => ({ id: c.id, name: c.name, subject: c.subject, preview_text: c.preview_text, body: parse(c.body_json), segment_id: c.segment_id, status: c.status, scheduled_at: c.scheduled_at, send_limit: c.send_limit, utm_campaign: c.utm_campaign, created_by: c.created_by, created_at: c.created_at, updated_at: c.updated_at, started_at: c.started_at, finished_at: c.finished_at, eligible_at_send: c.eligible_at_send });
const getCampaign = (env, id) => env.DB.prepare("SELECT * FROM campaigns WHERE id=?").bind(id).first();

// ── Offers: only what existing server rules can honour ───────────────────────
async function cleanBody(env, b) {
  b = b && typeof b === "object" ? b : {};
  const out = { template: TEMPLATES.includes(b.template) ? b.template : "standard", heading: oneLine(b.heading, 120), body: sanitiseText(b.body, 5000), products: [], cta: null, offer: { type: "announcement" } };
  if (b.products !== undefined) {
    if (!Array.isArray(b.products) || b.products.length > 6) return { error: "Choose up to 6 products" };
    const ids = [...new Set(b.products.map((x) => String(x)))];
    if (ids.some((x) => !/^[A-Za-z0-9_-]{1,64}$/.test(x))) return { error: "Invalid product" };
    if (ids.length) {
      const { results } = await env.DB.prepare(`SELECT id FROM products WHERE active=1 AND id IN (${email.placeholders(ids.length)})`).bind(...ids).all();
      const ok = new Set(results.map((r) => r.id)); const bad = ids.find((x) => !ok.has(x));
      if (bad) return { error: `Unknown or inactive product: ${bad}` };
    }
    out.products = ids;
  }
  if (b.cta && (b.cta.label || b.cta.path)) {
    const label = oneLine(b.cta.label, 40), path = String(b.cta.path || "");
    if (!label || !email.PATH_RE.test(path) || path.includes("//")) return { error: "Button needs a label and a site path such as /order.html" };
    out.cta = { label, path };
  }
  const o = b.offer && typeof b.offer === "object" ? b.offer : { type: "announcement" };
  const type = String(o.type || "announcement");
  if (!OFFER_TYPES.includes(type)) return { error: NO_COUPONS };
  out.offer = { type };
  if (type === "cart_milestone") {
    const id = String(o.cart_campaign_id || "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !(await env.DB.prepare("SELECT 1 x FROM cart_campaigns WHERE id=?").bind(id).first())) return { error: "Choose an existing cart milestone" };
    out.offer.cart_campaign_id = id;
  }
  if ((type === "new_product" || type === "reorder_reminder") && !out.products.length) return { error: "Choose at least one product for this offer type" };
  if (b.recipients !== undefined) {
    if (!Array.isArray(b.recipients) || b.recipients.length > 200) return { error: "At most 200 individual recipients" };
    const list = [...new Set(b.recipients.map(normEmail))];
    if (list.some((e) => !EMAIL_RE.test(e))) return { error: "One of the recipient emails is invalid" };
    if (list.length) out.recipients = list;
  }
  return { body: out };
}

// Text for the offer, built from the live rows at render time. { error } when the offer cannot be honoured right now.
async function offerParts(env, body) {
  const o = body.offer || { type: "announcement" };
  if (o.type === "membership_upgrade") return { notes: ["Ntagz Membership brings member pricing and Rewards tiers on eligible products. See the current details on the membership page."], cta: { label: "See membership", path: "/membership/" } };
  if (o.type !== "cart_milestone") return {};
  const r = await env.DB.prepare("SELECT * FROM cart_campaigns WHERE id=?").bind(o.cart_campaign_id).first(), t = now();
  if (!r) return { error: "The cart milestone no longer exists" };
  if (!r.active) return { error: `The cart milestone "${r.name}" is not active` };
  if (r.starts_at && r.starts_at > t) return { error: `The cart milestone "${r.name}" has not started yet` };
  if (r.ends_at && r.ends_at <= t) return { error: `The cart milestone "${r.name}" has expired` };
  const reward = r.reward_type === "free_shipping" ? "free shipping" : `${r.reward_value}% off`;
  const parts = [`Offer: ${reward} when your cart's product value reaches ${email.inr(r.threshold_paise)}.`, "Applied automatically at checkout when your cart qualifies."];
  if (r.audience === "signed_in") parts.push("Sign in at checkout to qualify.");
  if (r.audience === "members") parts.push("For active members.");
  if (!r.combinable && r.reward_type === "percent_off") parts.push("Not combined with quantity or member discounts.");
  if (r.ends_at) parts.push(`Offer ends ${istDay(r.ends_at)} (IST).`);
  if (r.max_redemptions) parts.push("Limited number of redemptions.");
  return { notes: [parts.join(" ")], cta: { label: "Shop now", path: "/order.html" } };
}

// Render spec from a campaign row (shared by preview, test send and the sender).
async function buildSpec(env, c) {
  const body = parse(c.body_json);
  if (!c.subject.trim()) return { error: "Add a subject line" };
  if (!body.heading && !body.body && !(body.products || []).length) return { error: "Add a heading, some text or products" };
  const offer = await offerParts(env, body);
  if (offer.error) return { error: offer.error };
  let products = [];
  if ((body.products || []).length) {
    const ids = body.products;
    const { results } = await env.DB.prepare(`SELECT id,name,price_paise,all_inclusive,image_url FROM products WHERE active=1 AND id IN (${email.placeholders(ids.length)})`).bind(...ids).all();
    const by = new Map(results.map((r) => [r.id, r])); products = ids.map((i) => by.get(i)).filter(Boolean);
  }
  return { spec: { subject: c.subject, preview: c.preview_text, template: body.template, heading: body.heading, paragraphs: String(body.body || "").split(/\n{2,}/).map((s) => s.trim()).filter(Boolean), products, cta: body.cta || offer.cta || null, notes: offer.notes || [], utm: { campaign: c.utm_campaign, medium: "campaign" } } };
}

// ── Audience (always from CURRENT data) ──────────────────────────────────────
async function audienceOf(env, c) {
  const limit = c.send_limit || MAX_AUDIENCE + 1;
  let total = 0, eligible = 0, byStatus = {}, rows = [];
  if (c.segment_id) {
    const s = await treeOf(env, c.segment_id);
    if (!s) return { error: "The segment no longer exists" };
    if (s.archived) return { error: "The segment is archived" };
    const n = await countAudience(env, s.tree); if (n.errors) return { error: n.errors[0] };
    const comp = compileRules(s.tree);
    const g = await env.DB.prepare(`SELECT coalesce(mc.status,'none') st, count(*) n FROM crm_customers c LEFT JOIN marketing_contacts mc ON mc.email = c.email WHERE ${comp.sql} GROUP BY 1`).bind(...comp.params).all();
    for (const r of g.results) byStatus[r.st] = r.n;
    total = n.count; eligible = n.eligible;
    rows = (await eligibleRecipients(env, s.tree, limit)).rows;
  } else {
    const list = parse(c.body_json).recipients || [];
    if (list.length) {
      const q = email.placeholders(list.length);
      const g = await env.DB.prepare(`SELECT status st, count(*) n FROM marketing_contacts WHERE email IN (${q}) GROUP BY status`).bind(...list).all();
      for (const r of g.results) byStatus[r.st] = r.n;
      byStatus.none = list.length - g.results.reduce((a, r) => a + r.n, 0);
      rows = (await env.DB.prepare(`SELECT email,user_id FROM marketing_contacts WHERE status='subscribed' AND email IN (${q}) ORDER BY email LIMIT ?`).bind(...list, limit).all()).results;
      total = list.length; eligible = byStatus.subscribed || 0;
    }
  }
  const overCap = !c.send_limit && rows.length > MAX_AUDIENCE;
  rows = rows.slice(0, c.send_limit || MAX_AUDIENCE);
  const excluded = { no_consent: byStatus.none || 0, unsubscribed: byStatus.unsubscribed || 0, suppressed: byStatus.suppressed || 0, invalid_email: Math.max(0, eligible - rows.length - (c.send_limit || overCap ? eligible : 0)) };
  return { total, eligible, will_send: rows.length, over_cap: overCap, excluded, rows, sample: rows.slice(0, 10).map((r) => email.maskEmail(r.email)) };
}

// ── Handlers ─────────────────────────────────────────────────────────────────
const statusRoute = (ctx) => ctx.json({ ...email.status(ctx.env), webhook_url_path: "/webhooks/resend" });

async function listCampaigns(ctx) {
  const { results } = await ctx.env.DB.prepare(`SELECT c.*,
    (SELECT count(*) FROM campaign_recipients r WHERE r.campaign_id = c.id) recipients,
    (SELECT count(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.sent_at IS NOT NULL) sent,
    (SELECT count(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'queued') queued
    FROM campaigns c ORDER BY c.created_at DESC, c.rowid DESC LIMIT 100`).all();
  return ctx.json({ campaigns: results.map((c) => ({ ...shape(c), recipients: c.recipients, sent: c.sent, queued: c.queued })) });
}

async function getOne(ctx, match) {
  const c = await getCampaign(ctx.env, match[1]); if (!c) return ctx.fail(404, "Campaign not found");
  return ctx.json({ campaign: shape(c) });
}

async function saveDraft(ctx, match) {
  const { env, actor, body: b } = ctx, id = match && match[1];
  let cur = null;
  if (id) { cur = await getCampaign(env, id); if (!cur) return ctx.fail(404, "Campaign not found"); if (cur.status !== "draft") return ctx.fail(409, "Only drafts can be edited"); }
  const v = (k, d) => (b[k] === undefined ? d : b[k]);
  const name = oneLine(v("name", cur && cur.name), 100); if (name.length < 2) return ctx.fail(400, "Give the campaign a name (2–100 characters)");
  const subject = oneLine(v("subject", cur ? cur.subject : ""), 150), preview = oneLine(v("preview_text", cur ? cur.preview_text : ""), 200);
  const merged = { ...(cur ? parse(cur.body_json) : {}), ...(b.body && typeof b.body === "object" ? b.body : {}) };
  if (b.recipients !== undefined) merged.recipients = b.recipients;
  const cb = await cleanBody(env, merged); if (cb.error) return ctx.fail(400, cb.error);
  let segment = v("segment_id", cur ? cur.segment_id : null) || null;
  if (segment) {
    const s = await env.DB.prepare("SELECT archived FROM crm_segments WHERE id=?").bind(String(segment)).first();
    if (!s || s.archived) return ctx.fail(400, "Choose an existing, unarchived segment");
    if ((cb.body.recipients || []).length) return ctx.fail(400, "Choose a segment or individual recipients, not both");
  }
  const sl = v("send_limit", cur ? cur.send_limit : null), limit = sl === null || sl === "" ? null : intIn(sl, 1, MAX_AUDIENCE);
  if (sl !== null && sl !== "" && limit === null) return ctx.fail(400, `Send limit must be 1–${MAX_AUDIENCE}`);
  const sa = v("scheduled_at", cur ? cur.scheduled_at : null), sched = sa === null || sa === "" ? null : intIn(sa, now() - 300, now() + 90 * 86400);
  if (sa !== null && sa !== "" && sched === null) return ctx.fail(400, "Schedule a time within the next 90 days");
  const bodyJson = JSON.stringify(cb.body);
  if (cur) {
    await env.DB.batch([env.DB.prepare("UPDATE campaigns SET name=?,subject=?,preview_text=?,body_json=?,segment_id=?,send_limit=?,scheduled_at=?,updated_at=? WHERE id=? AND status='draft'").bind(name, subject, preview, bodyJson, segment, limit, sched, now(), id), auditStmt(env, actor, "crm_campaign_save", { id, name })]);
    return ctx.json({ campaign: shape(await getCampaign(env, id)) });
  }
  const nid = crypto.randomUUID();
  await env.DB.batch([env.DB.prepare("INSERT INTO campaigns (id,name,subject,preview_text,body_json,segment_id,send_limit,scheduled_at,utm_campaign,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(nid, name, subject, preview, bodyJson, segment, limit, sched, "c-" + nid.slice(0, 8), actor), auditStmt(env, actor, "crm_campaign_save", { id: nid, name })]);
  return ctx.json({ campaign: shape(await getCampaign(env, nid)) }, 201);
}

async function audience(ctx, match) {
  const c = await getCampaign(ctx.env, match[1]); if (!c) return ctx.fail(404, "Campaign not found");
  const a = await audienceOf(ctx.env, c); if (a.error) return ctx.fail(400, a.error);
  const { rows, ...rest } = a;
  return ctx.json(rest);
}

async function preview(ctx, match) {
  const c = await getCampaign(ctx.env, match[1]); if (!c) return ctx.fail(404, "Campaign not found");
  const s = await buildSpec(ctx.env, c); if (s.error) return ctx.fail(400, s.error);
  const m = await email.render(ctx.env, s.spec, { email: ctx.actor, first: "Alex" });
  return ctx.json({ subject: m.subject, preview_text: c.preview_text, html: m.html, text: m.text, note: "Sample preview: links here are not tracked." });
}

// Same render as /preview but served as its own document so the email's inline styles work: the admin page CSP forbids inline styles,
// which a srcdoc iframe would inherit. This response gets a locked-down CSP of its own (styles + https images only, no scripts).
async function previewHtml(ctx, match) {
  const c = await getCampaign(ctx.env, match[1]); if (!c) return ctx.fail(404, "Campaign not found");
  const s = await buildSpec(ctx.env, c); if (s.error) return ctx.fail(400, s.error);
  const m = await email.render(ctx.env, s.spec, { email: ctx.actor, first: "Alex" });
  return new Response(m.html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https:; frame-ancestors 'self'" } });
}

async function testSend(ctx, match) {
  const { env, actor } = ctx;
  const c = await getCampaign(env, match[1]); if (!c) return ctx.fail(404, "Campaign not found");
  if (!email.status(env).configured) return ctx.fail(409, email.notConfiguredMessage(env));
  const mc = await env.DB.prepare("SELECT status FROM marketing_contacts WHERE email=?").bind(actor).first();
  if (mc && mc.status !== "subscribed") return ctx.fail(409, "Your own address is unsubscribed or suppressed, so it cannot receive test emails");
  const recent = await env.DB.prepare("SELECT count(*) n FROM audit_log WHERE actor=? AND action='crm_campaign_test_send' AND created_at >= ?").bind(actor, now() - 3600).first();
  if (recent.n >= 10) return ctx.fail(429, "Too many test sends this hour");
  const s = await buildSpec(env, c); if (s.error) return ctx.fail(400, s.error);
  const first = (await email.firstNames(env, [actor])).get(actor);
  const m = await email.render(env, s.spec, { email: actor, first });
  const r = await email.send(env, [{ key: "test:" + crypto.randomUUID(), to: actor, ...m, subject: "[TEST] " + m.subject }]);
  await auditStmt(env, actor, "crm_campaign_test_send", { id: c.id, ok: r.ok }).run();
  if (!r.ok) return ctx.fail(502, `The email provider did not accept the test email (${r.error})`);
  return ctx.json({ ok: true, sent_to: actor });
}

async function sendCampaign(ctx, match) {
  const { env, actor, body } = ctx;
  const c = await getCampaign(env, match[1]); if (!c) return ctx.fail(404, "Campaign not found");
  if (c.status !== "draft") return ctx.json({ noop: true, campaign: shape(c) }); // second call: harmless
  if (body.confirm !== true || typeof body.idempotency_key !== "string" || body.idempotency_key.length < 8 || body.idempotency_key.length > 64) return ctx.fail(400, "Confirm the send (confirm: true and an idempotency_key)");
  if (!email.status(env).configured) return ctx.fail(409, email.notConfiguredMessage(env));
  const s = await buildSpec(env, c); if (s.error) return ctx.fail(400, s.error);
  const a = await audienceOf(env, c); if (a.error) return ctx.fail(400, a.error);
  if (a.over_cap) return ctx.fail(400, `More than ${MAX_AUDIENCE} eligible recipients: set a send limit of ${MAX_AUDIENCE} or less`);
  if (!a.rows.length) return ctx.fail(400, "No eligible recipients: nobody in this audience has a current marketing opt-in");
  for (let i = 0; i < a.rows.length; i += 480) { // 24 rows x 4 params per statement stays under D1's 100-parameter limit
    const stmts = [];
    for (let j = i; j < Math.min(i + 480, a.rows.length); j += 24) {
      const chunk = a.rows.slice(j, j + 24);
      stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO campaign_recipients (id,campaign_id,email,user_id) VALUES ${chunk.map(() => "(?,?,?,?)").join(",")}`).bind(...chunk.flatMap((r) => [crypto.randomUUID(), c.id, r.email, r.user_id || null])));
    }
    await env.DB.batch(stmts);
  }
  const t = now(), future = c.scheduled_at && c.scheduled_at > t;
  const up = await env.DB.prepare("UPDATE campaigns SET status=?, started_at=?, eligible_at_send=(SELECT count(*) FROM campaign_recipients WHERE campaign_id=?), updated_at=? WHERE id=? AND status='draft'").bind(future ? "scheduled" : "sending", future ? null : t, c.id, t, c.id).run();
  if (up.meta.changes === 1) await auditStmt(env, actor, "crm_campaign_send", { id: c.id, name: c.name, eligible: a.rows.length, scheduled_at: future ? c.scheduled_at : null, key: body.idempotency_key }).run();
  return ctx.json({ campaign: shape(await getCampaign(env, c.id)) });
}

async function cancel(ctx, match) {
  const { env, actor } = ctx;
  const c = await getCampaign(env, match[1]); if (!c) return ctx.fail(404, "Campaign not found");
  if (!["draft", "scheduled", "sending"].includes(c.status)) return ctx.fail(409, `A ${c.status} campaign cannot be cancelled`);
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE campaigns SET status='cancelled', finished_at=?, updated_at=? WHERE id=? AND status IN ('draft','scheduled','sending')").bind(t, t, c.id),
    env.DB.prepare("UPDATE campaign_recipients SET status='skipped', detail='campaign cancelled' WHERE campaign_id=? AND status='queued'").bind(c.id),
    auditStmt(env, actor, "crm_campaign_cancel", { id: c.id, name: c.name }),
  ]);
  return ctx.json({ campaign: shape(await getCampaign(env, c.id)) });
}

async function report(ctx, match) {
  const { env } = ctx;
  const c = await getCampaign(env, match[1]); if (!c) return ctx.fail(404, "Campaign not found");
  const s = await env.DB.prepare(`SELECT count(*) total, coalesce(sum(status='queued'),0) queued, coalesce(sum(status='sending'),0) sending, coalesce(sum(sent_at IS NOT NULL AND status <> 'sending'),0) sent,
    coalesce(sum(delivered_at IS NOT NULL),0) delivered, coalesce(sum(bounced_at IS NOT NULL),0) bounced, coalesce(sum(complained_at IS NOT NULL),0) complained,
    coalesce(sum(status='failed'),0) failed, coalesce(sum(status='skipped'),0) skipped, coalesce(sum(clicked_at IS NOT NULL),0) unique_clicks, coalesce(sum(click_count),0) click_count
    FROM campaign_recipients WHERE campaign_id=?`).bind(c.id).first();
  const offer = parse(c.body_json).offer || {};
  const fromOrders = `FROM crm_orders o WHERE o.counts = 1 AND EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.campaign_id = ? AND r.clicked_at IS NOT NULL
    AND o.created_at >= r.clicked_at AND o.created_at < r.clicked_at + 604800 AND (o.email_n = r.email OR (r.user_id IS NOT NULL AND o.user_id = r.user_id)))`;
  const att = await env.DB.prepare(`SELECT count(*) orders, coalesce(sum(o.net_paise),0) revenue_paise ${fromOrders}`).bind(c.id).first();
  let discount = null;
  if (offer.type === "cart_milestone") {
    discount = (await env.DB.prepare(`SELECT coalesce(sum(o.campaign_discount_paise),0) d ${fromOrders} AND (SELECT campaign_id FROM orders x WHERE x.id = o.id) = ?`).bind(c.id, offer.cart_campaign_id).first()).d;
  }
  return ctx.json({
    campaign: { id: c.id, name: c.name, status: c.status },
    eligible_at_send: c.eligible_at_send, queued: s.queued + s.sending, sent: s.sent, delivered: s.delivered, bounced: s.bounced, complained: s.complained, failed: s.failed, skipped: s.skipped,
    unique_clicks: s.unique_clicks, click_count: s.click_count,
    unsubscribes: null, unsubscribes_note: "Not available: unsubscribes are not linked back to a campaign.",
    attributed_orders: att.orders, attributed_revenue_paise: att.revenue_paise, attribution_label: "Attributed, not incremental", attribution_definition: DEFS.attributed_revenue,
    discount_cost_paise: discount, discount_cost_note: discount === null ? "Only available for cart-milestone offers." : "Campaign discount on the attributed orders that used this milestone.",
    estimated_profit_paise: null, estimated_profit_note: "Not calculated: product cost is not recorded for every order line.",
    opens: null, opens_note: "Opens are not tracked.",
  });
}

export const routes = [
  { m: "GET", p: /^\/api\/crm\/email-status$/, perm: "view", h: statusRoute },
  { m: "GET", p: /^\/api\/crm\/campaigns$/, perm: "view", h: listCampaigns },
  { m: "POST", p: /^\/api\/crm\/campaigns$/, perm: "manage", h: saveDraft },
  { m: "GET", p: /^\/api\/crm\/campaigns\/([0-9a-f-]{36})$/, perm: "view", h: getOne },
  { m: "POST", p: /^\/api\/crm\/campaigns\/([0-9a-f-]{36})$/, perm: "manage", h: saveDraft },
  { m: "POST", p: /^\/api\/crm\/campaigns\/([0-9a-f-]{36})\/audience$/, perm: "view", h: audience },
  { m: "POST", p: /^\/api\/crm\/campaigns\/([0-9a-f-]{36})\/preview$/, perm: "view", h: preview },
  { m: "GET", p: /^\/api\/crm\/campaigns\/([0-9a-f-]{36})\/preview\.html$/, perm: "view", h: previewHtml },
  { m: "POST", p: /^\/api\/crm\/campaigns\/([0-9a-f-]{36})\/test-send$/, perm: "send", h: testSend },
  { m: "POST", p: /^\/api\/crm\/campaigns\/([0-9a-f-]{36})\/send$/, perm: "send", h: sendCampaign },
  { m: "POST", p: /^\/api\/crm\/campaigns\/([0-9a-f-]{36})\/cancel$/, perm: "send", h: cancel },
  { m: "GET", p: /^\/api\/crm\/campaigns\/([0-9a-f-]{36})\/report$/, perm: "view", h: report },
];

// ── Cron: start due scheduled campaigns, then send queued rows ───────────────
export async function tick(env) {
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE campaigns SET status='sending', started_at=coalesce(started_at,?) WHERE status='scheduled' AND scheduled_at <= ?").bind(t, t),
    // rows claimed but never finished (worker died mid-send): retry, or fail after MAX_ATTEMPTS
    env.DB.prepare(`UPDATE campaign_recipients SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END, detail = CASE WHEN attempts >= ? THEN 'stuck while sending' ELSE detail END, sent_at = NULL
      WHERE status='sending' AND sent_at IS NOT NULL AND sent_at < ?`).bind(MAX_ATTEMPTS, MAX_ATTEMPTS, t - STUCK_SECONDS),
  ]);
  if (!email.status(env).configured) return; // rows stay queued; nothing is simulated
  const { results } = await env.DB.prepare("SELECT * FROM campaigns WHERE status='sending' ORDER BY started_at LIMIT 3").all();
  for (const c of results) {
    try { await processCampaign(env, c); } catch (e) { console.error("campaign tick failed:", e && e.message); }
  }
}

async function processCampaign(env, c) {
  const s = await buildSpec(env, c);
  if (s.error) { // e.g. the cart milestone expired: stop rather than send wrong offer text
    await env.DB.batch([env.DB.prepare("UPDATE campaigns SET status='failed', finished_at=? WHERE id=? AND status='sending'").bind(now(), c.id), auditStmt(env, "system", "crm_campaign_halted", { id: c.id, reason: s.error })]);
    return;
  }
  const t = now();
  const { results: rows } = await env.DB.prepare(`UPDATE campaign_recipients SET status='sending', attempts=attempts+1, sent_at=? WHERE status='queued' AND id IN
    (SELECT id FROM campaign_recipients WHERE campaign_id=? AND status='queued' ORDER BY rowid LIMIT ?) RETURNING id,email,user_id,attempts`).bind(t, c.id, BATCH).all();
  if (rows.length) {
    const emails = rows.map((r) => r.email), q = email.placeholders(emails.length);
    const st = new Map((await env.DB.prepare(`SELECT email,status FROM marketing_contacts WHERE email IN (${q})`).bind(...emails).all()).results.map((r) => [r.email, r.status]));
    const live = rows.filter((r) => st.get(r.email) === "subscribed"); // re-validated immediately before sending
    const stmts = rows.filter((r) => st.get(r.email) !== "subscribed").map((r) => env.DB.prepare("UPDATE campaign_recipients SET status='skipped', detail=?, sent_at=NULL WHERE id=?").bind(`no longer opted in (${st.get(r.email) || "no consent record"})`, r.id));
    let r = { ok: false, error: "none", ids: [] };
    if (live.length) {
      try {
        const names = await email.firstNames(env, live.map((x) => x.email));
        const batch = [];
        for (const x of live) { const m = await email.render(env, s.spec, { id: x.id, email: x.email, first: names.get(x.email) }); batch.push({ key: x.id, to: x.email, ...m }); }
        r = await email.send(env, batch);
      } catch (e) { console.error("campaign send failed:", e && e.message); r = { ok: false, status: 0, error: "internal error" }; }
      live.forEach((x, i) => {
        if (r.ok) stmts.push(env.DB.prepare("UPDATE campaign_recipients SET status='sent', provider_id=?, sent_at=?, detail=NULL WHERE id=? AND status='sending'").bind(r.ids[i] || null, now(), x.id));
        else {
          const retry = x.attempts < MAX_ATTEMPTS || r.status === 429; // rate limiting does not use up an attempt
          stmts.push(env.DB.prepare("UPDATE campaign_recipients SET status=?, attempts=?, detail=?, sent_at=NULL WHERE id=? AND status='sending'").bind(retry ? "queued" : "failed", r.status === 429 ? Math.max(x.attempts - 1, 0) : x.attempts, String(r.error).slice(0, 100), x.id));
        }
      });
    }
    if (stmts.length) await env.DB.batch(stmts);
  }
  const left = await env.DB.prepare("SELECT count(*) n FROM campaign_recipients WHERE campaign_id=? AND status IN ('queued','sending')").bind(c.id).first();
  if (left.n === 0) await env.DB.prepare("UPDATE campaigns SET status='sent', finished_at=? WHERE id=? AND status='sending'").bind(now(), c.id).run();
}

// ── Provider webhook (Svix-style signatures) ─────────────────────────────────
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
function safeEq(a, b) { let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; }
async function verifySvix(secret, id, ts, header, raw) {
  try {
    if (!secret || !id || !ts || !header) return false;
    const n = Number(ts); if (!Number.isFinite(n) || Math.abs(now() - n) > 300) return false; // 5-minute tolerance, both directions
    const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (ch) => ch.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const want = b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${raw}`)));
    let ok = false; for (const part of header.split(" ")) { const [v, sig] = part.split(","); if (v === "v1" && sig && safeEq(sig, want)) ok = true; }
    return ok;
  } catch { return false; }
}
const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function handleWebhook(request, env) {
  const raw = await request.text();
  if (raw.length > 200000) return reply(400, { error: "Too large" });
  const id = request.headers.get("svix-id") || "";
  if (id.length > 100 || !(await verifySvix(env.RESEND_WEBHOOK_SECRET, id, request.headers.get("svix-timestamp"), request.headers.get("svix-signature"), raw))) return reply(401, { error: "Invalid signature" });
  let ev; try { ev = JSON.parse(raw); } catch { return reply(400, { error: "Invalid JSON" }); }
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO email_webhook_events (id) VALUES (?)").bind(id).run();
  if (ins.meta.changes !== 1) return reply(200, { ok: true, duplicate: true });
  try {
    const type = ev && ev.type, pid = ev && ev.data && ev.data.email_id, t = now();
    const col = { "email.delivered": "delivered", "email.bounced": "bounced", "email.complained": "complained" }[type];
    if (col && typeof pid === "string" && pid && !(col === "bounced" && !(ev.data.bounce && /^permanent$/i.test(ev.data.bounce.type || "")))) {
      const stmts = [];
      if (col === "delivered") stmts.push(env.DB.prepare("UPDATE campaign_recipients SET status='delivered', delivered_at=? WHERE provider_id=? AND status='sent'").bind(t, pid));
      else {
        stmts.push(env.DB.prepare(`UPDATE campaign_recipients SET status=?, ${col}_at=? WHERE provider_id=? AND status IN ('sent','delivered')`).bind(col, t, pid));
        const who = await env.DB.prepare("SELECT email FROM campaign_recipients WHERE provider_id=? UNION SELECT email FROM journey_runs WHERE provider_id=? LIMIT 1").bind(pid, pid).first();
        if (who) stmts.push(...consentStatements(env.DB, { email: who.email, status: "suppressed", source: "webhook", actor: "system", reason: col === "bounced" ? "bounce" : "complaint", detail: `provider ${col}` }));
      }
      await env.DB.batch(stmts);
    }
  } catch (e) {
    console.error("webhook failed:", e && e.message);
    await env.DB.prepare("DELETE FROM email_webhook_events WHERE id=?").bind(id).run().catch(() => {}); // let the provider retry
    return reply(500, { error: "Processing failed" });
  }
  return reply(200, { ok: true });
}
