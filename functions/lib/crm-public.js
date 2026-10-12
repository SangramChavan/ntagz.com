// Public (storefront) CRM endpoints, mounted by the payments Worker under /api/:
//   GET  /api/ev/config            tells the page whether first-party analytics is switched on (cacheable, no data)
//   POST /api/ev                   consent-gated browser events; the server adds the time and the signed-in user, never trusts the body for either
//   GET  /api/c/<recipient-id>     campaign email click: records the click, then redirects to a site-relative path
//   GET/POST /api/unsubscribe      confirm page (GET changes nothing) / performs the unsubscribe (also RFC 8058 one-click)
//   GET/POST /api/marketing/consent  signed-in customer reads / changes their own marketing opt-in
// Browser events can never create revenue, orders or tier changes: those only ever come from the orders/payments tables.
const CRM = require("./crm.js");

const SITE = "https://ntagz.com";
const ORIGINS = ["https://www.ntagz.com", "https://ntagz.com"];
const POLICY = "2026-10";
const SEC = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

// Cheap per-isolate limiter (no database write). Approximate by design: it blunts floods; the hard caps are the 20-event / 8 KB request limits.
const hits = new Map();
function limited(key, max, windowMs) {
  const t = Date.now(), h = hits.get(key);
  if (!h || t - h.at > windowMs) { if (hits.size > 5000) hits.clear(); hits.set(key, { at: t, n: 1 }); return false; }
  return ++h.n > max;
}

let cfgCache = { db: null, at: 0, on: false };
async function trackingOn(env) {
  if (cfgCache.db === env.DB && Date.now() - cfgCache.at < 60000) return cfgCache.on;
  const r = await env.DB.prepare("SELECT value FROM membership_config WHERE key='crm_tracking_enabled'").first().catch(() => null);
  cfgCache = { db: env.DB, at: Date.now(), on: !!r && r.value === "1" };
  return cfgCache.on;
}
const resetCrmCache = () => { cfgCache = { db: null, at: 0, on: false }; hits.clear(); };

const res = (data, status, extra = {}) => new Response(data === null ? null : JSON.stringify(data), { status, headers: { ...SEC, ...(data === null ? {} : { "Content-Type": "application/json" }), "Cache-Control": "no-store", ...extra } });
const page = (title, body, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>
<body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:12vh auto;padding:0 20px;color:#1d1d1f">${body}</body></html>`, { status, headers: { ...SEC, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ipOf = (request) => request.headers.get("CF-Connecting-IP") || "unknown";

async function handle(url, request, env, ctx) {
  const p = url.pathname, m = request.method;
  if (!env.DB) return null;

  if (p === "/api/ev/config" && m === "GET") {
    const r = res({ enabled: await trackingOn(env), policy: POLICY }, 200); r.headers.set("Cache-Control", "public, max-age=300"); return r;
  }

  if (p === "/api/ev" && m === "POST") {
    const origin = request.headers.get("Origin");
    if (origin && !ORIGINS.includes(origin)) return res({ error: "Origin not allowed" }, 403);
    if (limited("ev:" + ipOf(request), 40, 60000)) return res(null, 429);
    if (!(await trackingOn(env))) return res(null, 204); // off: store nothing at all
    const raw = await request.text();
    if (raw.length > 8192) return res({ error: "Too large" }, 413);
    let body; try { body = JSON.parse(raw); } catch { return res({ error: "Invalid JSON" }, 400); }
    const list = (Array.isArray(body && body.events) ? body.events : []).slice(0, 20).map(CRM.validateEvent).filter((v) => v.ok).map((v) => v.event);
    if (!list.length) return res(null, 204);
    const u = await ctx.getSession(request, env); // signed-in identity comes from the session cookie only
    const t = Math.floor(Date.now() / 1000);
    await env.DB.batch(list.map((e) => env.DB.prepare(`INSERT OR IGNORE INTO crm_events (id,ts,sid,event,user_id,product_id,category,path,term,utm_source,utm_medium,utm_campaign,recipient_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(e.id, t, e.sid, e.event, u ? u.user_id : null, e.product_id, e.category, e.path, e.term, e.utm_source, e.utm_medium, e.utm_campaign, e.recipient_id)));
    return res(null, 204);
  }

  const click = p.match(/^\/api\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  if (click && (m === "GET" || m === "HEAD")) {
    const path = CRM.cleanPath(url.searchParams.get("p") || "/") || "/";
    let dest = SITE + path;
    if (m === "GET" && !limited("c:" + ipOf(request), 120, 60000)) {
      const r = await env.DB.prepare("SELECT r.id, k.utm_campaign FROM campaign_recipients r JOIN campaigns k ON k.id = r.campaign_id WHERE r.id = ?").bind(click[1]).first().catch(() => null);
      if (r) {
        await env.DB.prepare("UPDATE campaign_recipients SET clicked_at = coalesce(clicked_at, unixepoch()), click_count = click_count + 1 WHERE id = ?").bind(r.id).run().catch(() => {});
        dest += `?utm_source=email&utm_medium=campaign&utm_campaign=${encodeURIComponent(r.utm_campaign)}&nz_r=${r.id}`;
      }
    }
    return new Response(null, { status: 302, headers: { ...SEC, Location: dest, "Cache-Control": "no-store" } });
  }

  if (p === "/api/unsubscribe" && (m === "GET" || m === "POST")) {
    const email = CRM.normEmail(url.searchParams.get("e") || ""), token = url.searchParams.get("t") || "";
    if (!env.UNSUB_SECRET) return page("Unsubscribe", "<p>Unsubscribe is temporarily unavailable. Please reply to any ntagz email and we will remove you.</p>", 503);
    if (!CRM.EMAIL.test(email) || !(await CRM.verifyUnsub(env.UNSUB_SECRET, email, token))) return page("Unsubscribe", "<p>This unsubscribe link is not valid. Reply to the email and we will remove you by hand.</p>", 400);
    if (m === "GET") { // a GET never changes anything: link scanners and prefetchers open links
      return page("Unsubscribe", `<h1 style="font-size:22px">Unsubscribe from ntagz offers?</h1><p>${esc(email)} will stop receiving marketing emails. Order and account emails are not affected.</p>
<form method="post" action="${esc(url.pathname + url.search)}"><button style="background:#ff5a1f;color:#fff;border:0;border-radius:10px;padding:12px 20px;font-size:16px">Unsubscribe</button></form>`);
    }
    if (limited("u:" + ipOf(request), 30, 60000)) return page("Unsubscribe", "<p>Too many requests. Please try again in a minute.</p>", 429);
    const u = await env.DB.prepare("SELECT id FROM users WHERE lower(email) = ?").bind(email).first().catch(() => null);
    await env.DB.batch(CRM.consentStatements(env.DB, { email, userId: u ? u.id : null, status: "unsubscribed", source: "unsubscribe_link", actor: "customer", policy: POLICY }));
    return page("Unsubscribed", `<h1 style="font-size:22px">You're unsubscribed</h1><p>${esc(email)} will no longer receive marketing emails from ntagz. Order and account emails will still arrive.</p>`);
  }

  if (p === "/api/marketing/consent") {
    const origin = request.headers.get("Origin");
    if (origin && !ORIGINS.includes(origin)) return res({ error: "Origin not allowed" }, 403);
    const u = await ctx.getSession(request, env);
    if (!u) return res({ error: "Sign in first" }, 401);
    const email = CRM.normEmail(u.email);
    if (m === "GET") {
      const c = await env.DB.prepare("SELECT status FROM marketing_contacts WHERE email = ?").bind(email).first();
      return res({ subscribed: !!c && c.status === "subscribed", policy: POLICY }, 200);
    }
    if (m === "POST") {
      if (limited("mc:" + u.user_id, 20, 60000)) return res(null, 429);
      let body = {}; try { body = await request.json(); } catch { /* handled below */ }
      if (typeof body.subscribe !== "boolean") return res({ error: "Invalid request" }, 400);
      const cur = await env.DB.prepare("SELECT status FROM marketing_contacts WHERE email = ?").bind(email).first();
      if (body.subscribe && cur && cur.status === "suppressed") return res({ error: "We are unable to email this address. Please contact us." }, 409);
      if (body.subscribe && cur && cur.status === "subscribed") return res({ subscribed: true, policy: POLICY }, 200);
      await env.DB.batch(CRM.consentStatements(env.DB, { email, userId: u.user_id, status: body.subscribe ? "subscribed" : "unsubscribed", source: "account_page", actor: "customer", policy: POLICY }));
      return res({ subscribed: body.subscribe, policy: POLICY }, 200);
    }
  }
  return null;
}

module.exports = { handle, resetCrmCache };
