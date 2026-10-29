const PRICING = require("../lib/pricing.js");
const LOYALTY = require("../lib/loyalty.js");
const INTLAPI = require("../lib/intl-api.js");
const POINTS = require("../lib/points.js"); // rewards wallet: points earned/redeemed, milestones
const DISPATCH = require("../lib/dispatch.js"); // working-day dispatch promise (one source of truth)
const DELIVERY = require("../lib/delivery.js"); // Pune-origin courier transit (calendar days; priority = express tier)
const CRMPUBLIC = require("../lib/crm-public.js"); // tracking / unsubscribe / campaign clicks / marketing opt-in

// Product structure (pack size, MOQ, fixed kits, all-inclusive) lives with the pricing engine so the admin preview uses it too.
const PRODUCTS = PRICING.PRODUCTS;

const corsHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Credentials": "true",
  "Vary": "Origin",
};

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Access-Control-Allow-Origin": origin === "https://ntagz.com" ? origin : "https://www.ntagz.com", "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

// Live pricing from the admin's D1 catalogue. Cached 30s per isolate; any failure falls back to the table above.
let pricingCache = { db: null, at: 0, map: null };
async function loadPricing(env) {
  if (!env.DB) return null;
  const nowMs = Date.now();
  if (pricingCache.db === env.DB && nowMs - pricingCache.at < 30000) return pricingCache.map;
  try {
    const cols = "id,name,category,price_paise,active,track_stock,stock_qty,low_stock_threshold,preorder_enabled,preorder_message,preorder_dispatch,preorder_max,preordered_qty";
    // member_discount_pct/cost_paise arrive with migration 0010; before it, read without them (= no member discount).
    let results;
    // loyalty_eligible/loyalty_max_pct arrive with migration 0012 (before it: every product eligible, no ceiling).
    // points_eligible arrives with migration 0014 (before it: every product earns).
    try { ({ results } = await env.DB.prepare(`SELECT ${cols},member_discount_pct,cost_paise,loyalty_eligible,loyalty_max_pct,points_eligible FROM products`).all()); }
    catch {
     try { ({ results } = await env.DB.prepare(`SELECT ${cols},member_discount_pct,cost_paise,loyalty_eligible,loyalty_max_pct FROM products`).all()); }
     catch {
      try { ({ results } = await env.DB.prepare(`SELECT ${cols},member_discount_pct,cost_paise,1 AS loyalty_eligible,NULL AS loyalty_max_pct FROM products`).all()); }
      catch { ({ results } = await env.DB.prepare(`SELECT ${cols},0 AS member_discount_pct,NULL AS cost_paise,1 AS loyalty_eligible,NULL AS loyalty_max_pct FROM products`).all()); }
     }
    }
    const map = {};
    for (const r of results) map[r.id] = r;
    pricingCache = { db: env.DB, at: nowMs, map };
    return map;
  } catch (e) { console.error("loadPricing failed:", e && e.message); return null; }
}
const resetPricingCache = () => { INTLAPI.resetIntlCache(); campaignCache = { db: null, at: 0, rows: [] }; pricingCache = { db: null, at: 0, map: null }; settingsCache = { db: null, at: 0, v: null }; rewardsSchema = { db: null, at: 0, ok: false }; pointsSchema = { db: null, at: 0, ok: false }; procSchema = { db: null, at: 0, ok: false }; LOYALTY.resetTiersCache(); }; // tests flip config in place

// A few in-stock products that would close the gap to the next cart milestone: same category as something in the cart first, then the
// smallest overshoot. Values are ex-GST estimates at each product's minimum order; the server prices the real cart.
function suggestFor(items, pricing, remainingPaise) {
  const inCart = new Set(items.map((i) => i.id)), cats = new Set(items.map((i) => pricing[i.id] && pricing[i.id].category).filter(Boolean)), out = [];
  for (const [id, st] of Object.entries(PRODUCTS)) {
    const row = pricing[id];
    if (st.fixed || inCart.has(id) || !row || !row.active) continue;
    const unitEx = row.price_paise / 100 / (st.allInclusive ? 1.18 : 1);
    if (!(unitEx > 0)) continue;
    const qty = Math.max(st.moq || 10, Math.ceil(remainingPaise / 100 / unitEx));
    if (qty > 100000 || (row.track_stock && !row.preorder_enabled && qty > row.stock_qty)) continue;
    out.push({ id, name: row.name, qty, valuePaise: Math.round(qty * unitEx * 100), sameCategory: cats.has(row.category) });
  }
  out.sort((a, b) => (b.sameCategory - a.sameCategory) || (a.valuePaise - b.valuePaise));
  return out.slice(0, 3);
}

// Everything the cart needs besides prices: the milestone reached/next (with relevant suggestions), and, for a signed-in customer, tier
// progress. These are different numbers: the milestone is about THIS cart; the tier is about lifetime spend (before this order).
async function rewardsBlock(env, request, you, items, pricing, member) {
  const block = { campaign: you.campaign ? { ...you.campaign, savingsPaise: you.campaignDiscountPaise } : null, note: you.campaignNote || null, next: you.nextCampaign, suggest: [], tier: null };
  if (you.nextCampaign && pricing) block.suggest = suggestFor(items, pricing, you.nextCampaign.remainingPaise);
  try {
    const settings = await loadMemberSettings(env), uid = (shopperOf.get(request) || {}).userId;
    if (settings.loyaltyLive && uid) {
      const ctx = member && member.loyalty ? member.loyalty : await LOYALTY.loyaltyContext(env.DB, uid, settings);
      const tiers = await LOYALTY.loadTiers(env.DB), after = ctx.spend + you.qualifyingPaise, aTier = LOYALTY.tierFor(after, tiers), aNext = LOYALTY.nextTierFor(after, tiers);
      const nm = (t) => (t ? { id: t.id, name: t.name, discountPct: Number(t.discount_pct) } : null);
      block.tier = { spendPaise: ctx.spend, current: nm(ctx.tier), next: ctx.next ? { ...nm(ctx.next), remainingPaise: ctx.remaining } : null,
        afterThisOrder: { spendPaise: after, tier: nm(aTier), next: aNext ? { ...nm(aNext), remainingPaise: aNext.min_spend_paise - after } : null } };
    }
  } catch (e) { console.error("tier progress unavailable:", e && e.message); }
  return block;
}

// Returns a customer-facing message if any item can't be sold right now, else null.
function unavailableReason(items, pricing) {
  if (!pricing || !Array.isArray(items)) return null;
  for (const item of items) {
    const row = pricing[item && item.id];
    if (!row) continue;
    const name = row.name || item.id;
    if (!row.active) return `${name} is currently unavailable`;
    if (row.track_stock && Number.isInteger(item.qty)) {
      const room = row.preorder_enabled ? (row.preorder_max == null ? Infinity : Math.max(row.preorder_max - row.preordered_qty, 0)) : 0;
      if (item.qty > row.stock_qty + room) {
        if (!row.preorder_enabled) return row.stock_qty > 0 ? `Only ${row.stock_qty} of ${name} available` : `${name} is out of stock`;
        return `Only ${row.stock_qty + room} of ${name} available (${row.stock_qty} ready to ship, ${room} for pre-order)`;
      }
    }
  }
  return null;
}

// Server-side price of a cart. `member` is the result of getMemberContext (null = regular prices). See functions/lib/pricing.js.
// `member` = getMemberContext's {settings, paid, loyalty} (null = regular prices). A bare {settings} means a paid member (the quote's what-if).
function calculateTotal(items, state, member, pricing, campaigns, redeemPaise) {
  const paid = !!member && member.paid !== false;
  const loyalty = member && member.loyalty && member.loyalty.pct > 0 ? { pct: member.loyalty.pct, tier: member.loyalty.tier } : null;
  const t = PRICING.priceCart(items, { products: PRODUCTS, live: pricing, state, member: paid, settings: member ? member.settings : null, loyalty, campaigns, redeemPaise });
  if (t) t.loyaltyTier = loyalty ? loyalty.tier.id : null;
  return t;
}

async function razorpayRequest(path, env, body) {
  const credentials = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error("Razorpay order creation failed");
  return data;
}

async function verifySignature(orderId, paymentId, signature, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`${orderId}|${paymentId}`)
  ));
  const expected = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  if (typeof signature !== "string" || signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function sha512(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-512", new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function payuHash(fields, salt) {
  return sha512([
    fields.key, fields.txnid, fields.amount, fields.productinfo, fields.firstname, fields.email,
    fields.udf1 || "", fields.udf2 || "", fields.udf3 || "", fields.udf4 || "", fields.udf5 || "",
    "", "", "", "", "", salt,
  ].join("|"));
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function verifyPayuResponse(body, salt) {
  if (typeof body.hash !== "string" || typeof body.txnid !== "string" || typeof body.status !== "string" ||
      typeof body.key !== "string" || typeof body.amount !== "string" || typeof body.productinfo !== "string" ||
      typeof body.firstname !== "string" || typeof body.email !== "string") return false;
  if ([body.key, body.txnid, body.amount, body.productinfo, body.firstname, body.email,
    body.udf1 || "", body.udf2 || "", body.udf3 || "", body.udf4 || "", body.udf5 || ""].some(value => value.includes("|"))) return false;
  const responseHash = await sha512([
    salt, body.status, "", "", "", "", "", body.udf5 || "", body.udf4 || "", body.udf3 || "",
    body.udf2 || "", body.udf1 || "", body.email || "", body.firstname || "", body.productinfo || "",
    body.amount || "", body.txnid, body.key,
  ].join("|"));
  return safeEqual(responseHash, body.hash.toLowerCase());
}

// ── Accounts ──────────────────────────────────────────────────────────────

function sessionCookie(id, maxAge) {
  return `ntagz_session=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function getSession(request, env) {
  if (!env.DB) return null;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/ntagz_session=([A-Za-z0-9_-]{10,128})/);
  if (!m) return null;
  return env.DB.prepare(
    `SELECT s.id AS sid, u.id AS user_id, u.email, u.name, u.phone, u.gstin,
            u.loyalty_spend, u.loyalty_tier
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > unixepoch()`
  ).bind(m[1]).first();
}

async function sendOtp(email, otp, env) {
  if (!env.RESEND_API_KEY) { console.log(`OTP for ${email}: ${otp}`); return; } // dev only: never logged when email is configured
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "ntagz <hello@ntagz.com>",
      to: [email],
      subject: `${otp} — your ntagz login code`,
      html: `<p style="font-family:sans-serif;">Your login code is <strong style="font-size:28px;letter-spacing:6px;">${otp}</strong></p><p style="font-family:sans-serif;color:#888;">Valid for 10 minutes. Do not share this code.</p>`,
    }),
  }).catch((e) => { console.error("Resend fetch error:", e); return null; });
  if (res && !res.ok) console.error("Resend error:", res.status, await res.text().catch(() => ""));
}

function jsonAuth(data, status, allowedOrigin, cookieHeader) {
  const headers = { ...corsHeaders, "Access-Control-Allow-Origin": allowedOrigin, "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (cookieHeader) headers["Set-Cookie"] = cookieHeader;
  return new Response(JSON.stringify(data), { status, headers });
}

let settingsCache = { db: null, at: 0, v: null };
async function loadMemberSettings(env) {
  if (!env.DB) return { ...PRICING.settingsFrom({}), dispatch: DISPATCH.fromCfg({}) }; // no database: defaults, never throw (checkout must keep pricing)
  if (settingsCache.db === env.DB && Date.now() - settingsCache.at < 30000 && settingsCache.v) return settingsCache.v;
  let raw;
  try { raw = Object.fromEntries((await env.DB.prepare("SELECT key, value FROM membership_config").all()).results.map((r) => [r.key, r.value])); }
  catch (e) { console.error("membership settings unavailable:", e && e.message); return { ...PRICING.settingsFrom({}), dispatch: DISPATCH.fromCfg({}) }; } // a broken read falls back to defaults and is not cached
  const v = { ...PRICING.settingsFrom(raw), dispatch: DISPATCH.fromCfg(raw) }; // dispatch rides the same row read (no extra query)
  settingsCache = { db: env.DB, at: Date.now(), v };
  return v;
}

// Does this database have the rewards columns yet (migration 0012)? Without them checkout keeps working on the old statements.
let rewardsSchema = { db: null, at: 0, ok: false };
async function hasRewardsSchema(env) {
  if (rewardsSchema.db === env.DB && (rewardsSchema.ok || Date.now() - rewardsSchema.at < 60000)) return rewardsSchema.ok;
  let ok = false;
  try { ok = !!(await env.DB.prepare("SELECT 1 x FROM pragma_table_info('orders') WHERE name='qualifying_paise'").first()); } catch { ok = false; }
  rewardsSchema = { db: env.DB, at: Date.now(), ok };
  return ok;
}

// Active cart milestones (cached 30s). Empty if the table does not exist yet.
let campaignCache = { db: null, at: 0, rows: [] };
async function loadCampaigns(env) {
  if (campaignCache.db === env.DB && Date.now() - campaignCache.at < 30000) return campaignCache.rows;
  let rows = [];
  try { rows = (await env.DB.prepare("SELECT * FROM cart_campaigns WHERE active=1").all()).results; } catch { rows = []; }
  campaignCache = { db: env.DB, at: Date.now(), rows };
  return rows;
}
const shopperOf = new WeakMap(); // request -> {userId}: lets campaignsFor know who is shopping without a second session lookup

// The milestones this shopper can use right now: in date, right audience, and under their redemption limits.
async function campaignsFor(request, env, member) {
  if (!env.DB) return [];
  const rows = await loadCampaigns(env);
  if (!rows.length) return [];
  const now = Math.floor(Date.now() / 1000), uid = (shopperOf.get(request) || {}).userId || null, out = [];
  for (const c of rows) {
    if ((c.starts_at && now < c.starts_at) || (c.ends_at && now > c.ends_at)) continue;
    if ((c.audience === "signed_in" && !uid) || (c.audience === "members" && !member)) continue;
    try {
      if (c.max_redemptions != null) { const t = await env.DB.prepare("SELECT count(*) n FROM orders WHERE campaign_id=? AND status NOT IN ('cancelled','returned')").bind(c.id).first(); if (t.n >= c.max_redemptions) continue; }
      if (c.per_customer_limit != null) { if (!uid) continue; const t = await env.DB.prepare("SELECT count(*) n FROM orders WHERE campaign_id=? AND user_id=? AND status NOT IN ('cancelled','returned')").bind(c.id, uid).first(); if (t.n >= c.per_customer_limit) continue; }
    } catch { continue; }
    out.push(c);
  }
  return out;
}

// Does this database have the points columns yet (migration 0014)? Without them checkout keeps working exactly as before.
let pointsSchema = { db: null, at: 0, ok: false };
async function hasPointsSchema(env) {
  if (pointsSchema.db === env.DB && (pointsSchema.ok || Date.now() - pointsSchema.at < 60000)) return pointsSchema.ok;
  let ok = false;
  try { ok = !!(await env.DB.prepare("SELECT 1 x FROM pragma_table_info('orders') WHERE name='points_basis_paise'").first()); } catch { ok = false; }
  pointsSchema = { db: env.DB, at: Date.now(), ok };
  return ok;
}

// The single authoritative price for a cart, including the Rewards Membership wallet. Points are earned and spent only by a signed-in,
// unexpired PAID member while rewards are live; the browser may only ASK to redeem (`redeemPoints`), the server decides how many points
// are allowed (balance, per-order cap, minimum) and re-prices. Returns { total, points } or { error, status }.
async function pricedCart(env, request, member, items, state, pricing, campaigns, redeemRequested) {
  const t0 = calculateTotal(items, state, member, pricing, campaigns);
  if (!t0) return { error: "Invalid order", status: 400 };
  const userId = member && member.paid !== false ? member.userId : null;
  let st = null;
  if (userId) { try { if (await hasPointsSchema(env)) st = await POINTS.loadSettings(env.DB); } catch (e) { console.error("points settings unavailable:", e && e.message); } }
  const none = () => { t0.pointsRateX100 = null; t0.pointsBasisPaise = 0; t0.pointsRedeemed = 0; t0.pointsDiscountPaise = 0; t0.memberSavingPaise = member && member.paid !== false ? t0.memberSavingPaise : 0; return { total: t0, points: null }; };
  if (!st || !st.live) { if (Number(redeemRequested) > 0) return { error: "Rewards points are not available right now", status: 409 }; return none(); }
  const eligible = t0.pointsBasisPaise >= st.minOrderPaise ? t0.pointsBasisPaise : 0;
  const bal = await POINTS.balance(env.DB, userId);
  let total = t0, used = { points: 0, discountPaise: 0, reason: null };
  if (Number(redeemRequested) > 0) {
    used = POINTS.planRedemption(st, bal.available, redeemRequested, eligible);
    if (!used.points) return { error: used.reason || "Points cannot be used on this order", status: 409 };
    total = calculateTotal(items, state, member, pricing, campaigns, used.discountPaise);
    if (!total) return { error: "Invalid order", status: 400 };
  }
  total.pointsRedeemed = used.points;
  total.pointsBasisPaise = total.pointsBasisPaise >= st.minOrderPaise ? total.pointsBasisPaise : 0;
  const cap = Math.floor((eligible * st.maxRedeemPct) / 100 / st.valuePaise);
  // The earn rate is the customer's spending tier's (derived now, frozen on the order); pre-tier or tier-less = the flat rate.
  let tier = member && member.loyalty ? member.loyalty.tier : null;
  if (!tier) { try { tier = (await LOYALTY.loyaltyContext(env.DB, userId, { loyaltyLive: false })).tier; } catch (e) { console.error("tier unavailable:", e && e.message); } }
  total.pointsRateX100 = POINTS.rateX100For(st, tier);
  return { total, points: { available: bal.available, valuePaise: st.valuePaise, minRedeem: st.minRedeem, maxRedeemPct: st.maxRedeemPct,
    maxUsable: Math.max(0, Math.min(bal.available, cap)), redeemed: used.points, discountPaise: total.pointsDiscountPaise, note: used.reason,
    willEarn: Math.floor((total.pointsBasisPaise * total.pointsRateX100) / 1000000), ratePer100: total.pointsRateX100 / 100, earnOn: st.earnOn } };
}

// {settings, paid, loyalty} for a signed-in customer who earns a price benefit: an unexpired active paid membership (while member
// pricing is live) and/or a spending tier with a discount (while rewards are live). null = regular prices. Loyalty is only looked up
// when switched on, so while it is off this costs nothing extra.
async function getMemberContext(request, env) {
  if (!env.DB) return null;
  const u = await getSession(request, env);
  shopperOf.set(request, { userId: u ? u.user_id : null });
  if (!u) return null;
  const [mem, settings] = await Promise.all([
    env.DB.prepare(`SELECT id FROM memberships WHERE user_id=? AND status='active' AND expires_at>unixepoch() LIMIT 1`).bind(u.user_id).first(),
    loadMemberSettings(env),
  ]);
  const paid = !!mem && settings.live;
  let loyalty = null;
  if (settings.loyaltyLive) { try { loyalty = await LOYALTY.loyaltyContext(env.DB, u.user_id, settings); } catch (e) { console.error("loyalty unavailable:", e && e.message); } }
  if (!paid && !(loyalty && loyalty.pct > 0)) return null;
  return { settings, paid, loyalty: loyalty && loyalty.pct > 0 ? loyalty : null, userId: u.user_id };
}

// ── Rewards (spending tiers) ──────────────────────────────────────────────────
// GET /api/rewards/tiers  public: tier names, thresholds and discounts (cacheable).
// GET /api/rewards/me     the signed-in customer's own standing: derived from their paid orders, never from a client flag.
async function handleRewards(url, request, env, allowedOrigin) {
  if (!env.DB) return jsonAuth({ error: "Rewards are temporarily unavailable" }, 503, allowedOrigin);
  if (request.method !== "GET") return jsonAuth({ error: "Method not allowed" }, 405, allowedOrigin);
  try {
    const settings = await loadMemberSettings(env), tiers = await LOYALTY.loadTiers(env.DB);
    const publicTiers = tiers.map((t) => ({ id: t.id, name: t.name, minSpendPaise: t.min_spend_paise, discountPct: Number(t.discount_pct), pointsPer100: t.points_per_100 === null || t.points_per_100 === undefined ? null : Number(t.points_per_100), perks: t.perks }));
    if (url.pathname.endsWith("/rewards/tiers")) {
      const now = Math.floor(Date.now() / 1000);
      const milestones = (await loadCampaigns(env)).filter((c) => (!c.starts_at || now >= c.starts_at) && (!c.ends_at || now <= c.ends_at))
        .map((c) => ({ id: c.id, name: c.name, thresholdPaise: c.threshold_paise, type: c.reward_type, value: Number(c.reward_value) || 0, audience: c.audience }));
      const res = jsonAuth({ live: settings.loyaltyLive, combine: settings.loyaltyCombine, checkoutOffer: settings.checkoutOffer, tiers: publicTiers, milestones }, 200, allowedOrigin);
      res.headers.set("Cache-Control", "public, max-age=300");
      return res;
    }
    if (url.pathname.endsWith("/rewards/me")) {
      const u = await getSession(request, env);
      if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
      const ctx = await LOYALTY.loyaltyContext(env.DB, u.user_id, settings);
      const [orders, adj, log, sav, mem] = await Promise.all([
        env.DB.prepare(`SELECT txn_id ref, created_at, status, payment_status, paid_paise, refunded_paise, qualifying_paise, discount_paise FROM orders WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 20`).bind(u.user_id).all(),
        env.DB.prepare("SELECT delta_paise, reason, created_at FROM loyalty_adjustments WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 20").bind(u.user_id).all(),
        env.DB.prepare("SELECT from_tier, to_tier, spend_paise, reason, created_at FROM loyalty_tier_log WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 20").bind(u.user_id).all(),
        env.DB.prepare(`SELECT coalesce(sum(discount_paise),0) s FROM orders WHERE user_id=? AND payment_status='paid' AND status NOT IN ('cancelled','returned')`).bind(u.user_id).first(),
        env.DB.prepare(`SELECT expires_at FROM memberships WHERE user_id=? AND status='active' AND expires_at>unixepoch() ORDER BY expires_at DESC LIMIT 1`).bind(u.user_id).first(),
      ]);
      // Relevant products to reach the next tier: what would close the gap, preferring the categories of their last paid order.
      let suggest = [];
      if (ctx.next) {
        try {
          const last = await env.DB.prepare("SELECT items_json FROM orders WHERE user_id=? AND payment_status='paid' ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(u.user_id).first();
          const items = last ? JSON.parse(last.items_json || "[]").filter((i) => i && typeof i.id === "string") : [];
          const pricing = await loadPricing(env);
          if (pricing) suggest = suggestFor(items, pricing, ctx.remaining).map((x) => ({ id: x.id, name: x.name, qty: x.qty, valuePaise: x.valuePaise }));
        } catch (e) { console.error("tier suggestions failed:", e && e.message); }
      }
      const counts = (o) => o.payment_status === "paid" && o.paid_paise > 0 && !["cancelled", "returned"].includes(o.status);
      const pub = (t) => (t ? { id: t.id, name: t.name, discountPct: Number(t.discount_pct), pointsPer100: t.points_per_100 === null || t.points_per_100 === undefined ? null : Number(t.points_per_100), perks: t.perks, minSpendPaise: t.min_spend_paise } : null);
      return jsonAuth({
        live: ctx.live, suggest, spendPaise: ctx.spend, tier: pub(ctx.tier), next: ctx.next ? { ...pub(ctx.next), remainingPaise: ctx.remaining } : null, topTier: !ctx.next,
        discountPct: ctx.pct, savingsPaise: Number(sav && sav.s) || 0, tiers: publicTiers,
        paidMembership: mem ? { active: true, expiresAt: mem.expires_at } : { active: false },
        orders: orders.results.map((o) => ({ ref: o.ref, createdAt: o.created_at, status: o.status, counted: counts(o), qualifyingPaise: counts(o) ? Math.round(o.qualifying_paise * (o.paid_paise - Math.min(o.refunded_paise, o.paid_paise)) / o.paid_paise) : 0, refundedPaise: o.refunded_paise })),
        adjustments: adj.results.map((a) => ({ deltaPaise: a.delta_paise, reason: a.reason, at: a.created_at })),
        tierHistory: log.results.map((l) => ({ from: l.from_tier, to: l.to_tier, spendPaise: l.spend_paise, reason: l.reason, at: l.created_at })),
      }, 200, allowedOrigin);
    }
    return jsonAuth({ error: "Not found" }, 404, allowedOrigin);
  } catch (e) { console.error("rewards failed:", e && e.message); return jsonAuth({ error: "Rewards are temporarily unavailable" }, 503, allowedOrigin); }
}

// ── Membership handler ────────────────────────────────────────────────────────

// Public, cacheable description of the points programme and milestone ladder (only when switched on and migrated). Nothing personal.
async function publicRewards(env) {
  const off = { renewWindowDays: 30, points: null, milestones: [] };
  try {
    if (!(await hasPointsSchema(env))) return off;
    const st = await POINTS.loadSettings(env.DB);
    const out = { renewWindowDays: st.renewWindowDays, points: null, milestones: [] };
    if (!st.live) return out;
    out.points = { earnPer100: st.earnPer100, valuePaise: st.valuePaise, minRedeem: st.minRedeem, maxRedeemPct: st.maxRedeemPct, validDays: st.validDays, earnOn: st.earnOn, minOrderPaise: st.minOrderPaise, restoreOnCancel: st.restoreOnCancel, clawback: st.clawback };
    out.milestones = (await env.DB.prepare("SELECT id,label,threshold_paise AS thresholdPaise,bonus_points AS bonusPoints FROM reward_milestones WHERE active=1 ORDER BY threshold_paise").all()).results;
    // Tier earn rates (migration 0015): below the first tier a member earns the flat earnPer100; from each tier's spend, that tier's rate.
    out.points.tiers = (await LOYALTY.loadTiers(env.DB)).filter((t) => t.points_per_100 !== null && t.points_per_100 !== undefined && t.min_spend_paise > 0)
      .map((t) => ({ name: t.name, minSpendPaise: t.min_spend_paise, pointsPer100: Number(t.points_per_100) }));
    return out;
  } catch (e) { console.error("rewards info unavailable:", e && e.message); return off; }
}

// Creates the membership for a verified, fully paid Razorpay membership order. Idempotent: memberships.razorpay_order_id is UNIQUE, so the browser's
// verify call, a webhook and any replay all end at the same single row. A renewal starts when the current term ends; a first purchase or a lapsed
// member starts now.
async function activateMembership(env, { userId, orderId, paymentId, amount, days }) {
  const found = (id) => env.DB.prepare("SELECT id,expires_at FROM memberships WHERE razorpay_order_id=?").bind(id).first();
  const dup = await found(orderId);
  if (dup) return { id: dup.id, expiresAt: dup.expires_at, existing: true };
  const memId = crypto.randomUUID(), now = Math.floor(Date.now() / 1000);
  const cur = await env.DB.prepare("SELECT max(expires_at) e FROM memberships WHERE user_id=? AND status='active' AND expires_at>?").bind(userId, now).first();
  const start = cur && cur.e > now ? cur.e : now;
  try {
    await env.DB.prepare(
      `INSERT INTO memberships (id, user_id, status, purchased_at, expires_at, welcome_credit_paise, price_paid, payment_id, razorpay_order_id)
       VALUES (?, ?, 'active', ?, ?, 0, ?, ?, ?)`
    ).bind(memId, userId, start, start + days * 86400, amount, paymentId, orderId).run();
  } catch (e) { // lost a race against the unique index: return the winner
    const w = await found(orderId);
    if (w) return { id: w.id, expiresAt: w.expires_at, existing: true };
    throw e;
  }
  return { id: memId, expiresAt: start + days * 86400, renewed: start > now, existing: false };
}

async function handleMembership(url, request, env, allowedOrigin) {
  if (!env.DB) return new Response(JSON.stringify({ error: "Database not configured" }), { status: 503, headers: { "Content-Type": "application/json" } });
  const path = url.pathname;
  const method = request.method;

  // GET /api/membership/pricing — public, no session. Member discount % per product, from the same config checkout uses,
  // so the membership page shows exactly what checkout will charge. {live:false} when member pricing is switched off.
  if (method === "GET" && path.endsWith("/membership/pricing")) {
    const settings = await loadMemberSettings(env);
    const pricing = await loadPricing(env);
    const products = {};
    if (settings.live && pricing) for (const [id, p] of Object.entries(PRODUCTS)) {
      const row = pricing[id];
      if (!p.fixed && row && row.active && Number(row.member_discount_pct) > 0) products[id] = Number(row.member_discount_pct);
    }
    // Products a spending-tier discount can apply to (so "unlock member pricing" is never shown for an excluded product).
    let tierEligible = [];
    if (settings.loyaltyLive && pricing) {
      const top = Math.max(0, ...(await LOYALTY.loadTiers(env.DB)).map((t) => Number(t.discount_pct) || 0));
      if (top > 0) tierEligible = Object.entries(PRODUCTS).filter(([id, p]) => { const r = pricing[id]; return !p.fixed && r && r.active && r.loyalty_eligible !== 0 && !(r.loyalty_max_pct != null && Number(r.loyalty_max_pct) <= 0); }).map(([id]) => id);
    }
    const rewards = await publicRewards(env);
    const res = jsonAuth({ live: settings.live, loyaltyLive: settings.loyaltyLive, tierEligible, feePaise: settings.feePaise, durationDays: settings.durationDays, maxTotalDiscountPct: settings.maxTotalPct, products, renewWindowDays: rewards.renewWindowDays, points: rewards.points, milestones: rewards.milestones }, 200, allowedOrigin);
    res.headers.set("Cache-Control", "public, max-age=300");
    return res;
  }

  // GET /api/membership/status
  if (method === "GET" && path.endsWith("/membership/status")) {
    const u = await getSession(request, env);
    if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
    const mem = await env.DB.prepare(
      `SELECT *, (SELECT max(expires_at) FROM memberships m2 WHERE m2.user_id=memberships.user_id AND m2.status='active') AS term_end
         FROM memberships WHERE user_id=? AND status='active' AND expires_at > unixepoch() ORDER BY expires_at ASC LIMIT 1`
    ).bind(u.user_id).first();
    // The spending tier rides along (only looked up while rewards are live), so one call tells the storefront everything it needs.
    let tier = null;
    try {
      const settings = await loadMemberSettings(env);
      if (settings.loyaltyLive) {
        const c = await LOYALTY.loyaltyContext(env.DB, u.user_id, settings);
        tier = { id: c.tier ? c.tier.id : null, name: c.tier ? c.tier.name : null, discountPct: c.pct, spendPaise: c.spend, next: c.next ? { name: c.next.name, remainingPaise: c.remaining } : null };
      }
    } catch (e) { console.error("tier lookup failed:", e && e.message); }
    return jsonAuth({ membership: mem ? {
      active: true,
      expiresAt: mem.term_end || mem.expires_at,
      pricePaid: mem.price_paid,
      purchasedAt: mem.purchased_at,
    } : { active: false }, tier }, 200, allowedOrigin);
  }

  // GET /api/membership/me — the signed-in customer's own membership + wallet + milestones + realised value (dashboard). Never another user's.
  if (method === "GET" && path.endsWith("/membership/me")) {
    const u = await getSession(request, env);
    if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
    try {
      if (!(await hasPointsSchema(env))) return jsonAuth({ live: false, available: false }, 200, allowedOrigin);
      const [sum, settings, st] = await Promise.all([POINTS.summary(env.DB, u.user_id), loadMemberSettings(env), POINTS.loadSettings(env.DB)]);
      const now = Math.floor(Date.now() / 1000), exp = sum.membership.active ? sum.membership.expiresAt : 0;
      const renew = settings.live && settings.feePaise >= 100 && (!sum.membership.active || exp - now <= st.renewWindowDays * 86400);
      const res = jsonAuth({ ...sum, renewal: { canRenew: renew, windowDays: st.renewWindowDays, feePaise: settings.feePaise, expired: !sum.membership.active && !!sum.membership.lastExpiry,
        startsAt: renew && sum.membership.active ? exp : null } }, 200, allowedOrigin);
      res.headers.set("Cache-Control", "no-store");
      return res;
    } catch (e) { console.error("membership/me failed:", e && e.message); return jsonAuth({ error: "Rewards unavailable" }, 503, allowedOrigin); }
  }
  // GET /api/membership/activity?before=<unix>&limit=<n> — the customer's own points ledger, newest first.
  if (method === "GET" && path.endsWith("/membership/activity")) {
    const u = await getSession(request, env);
    if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
    try {
      if (!(await hasPointsSchema(env))) return jsonAuth({ entries: [], more: false }, 200, allowedOrigin);
      const before = parseInt(url.searchParams.get("before"), 10) || 0, limit = Math.min(Math.max(parseInt(url.searchParams.get("limit"), 10) || 30, 1), 100);
      const res = jsonAuth(await POINTS.activity(env.DB, u.user_id, before, limit), 200, allowedOrigin);
      res.headers.set("Cache-Control", "no-store");
      return res;
    } catch (e) { console.error("membership/activity failed:", e && e.message); return jsonAuth({ error: "Rewards unavailable" }, 503, allowedOrigin); }
  }

  // POST /api/membership/create-order
  if (method === "POST" && path.endsWith("/membership/create-order")) {
    const u = await getSession(request, env);
    if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return jsonAuth({ error: "Payment not configured" }, 503, allowedOrigin);
    if (await throttled(env, request, "membership", 10, 600)) return jsonAuth({ error: TOO_MANY }, 429, allowedOrigin);
    // Renewal: allowed once the current term is within the renewal window, and only one renewal can be queued behind it.
    const existing = await env.DB.prepare(
      `SELECT count(*) n, max(expires_at) e FROM memberships WHERE user_id=? AND status='active' AND expires_at > unixepoch()`
    ).bind(u.user_id).first();
    if (existing.n > 0) {
      const win = (await hasPointsSchema(env)) ? (await POINTS.loadSettings(env.DB)).renewWindowDays : 0;
      if (existing.n > 1) return jsonAuth({ error: "Your membership is already renewed" }, 409, allowedOrigin);
      if (existing.e - Math.floor(Date.now() / 1000) > win * 86400) return jsonAuth({ error: win ? `You can renew within ${win} days of expiry` : "You already have an active membership" }, 409, allowedOrigin);
    }
    const settings = await loadMemberSettings(env);
    // Never sell a membership that currently gives nothing.
    if (!settings.live) return jsonAuth({ error: "Membership is not available right now" }, 409, allowedOrigin);
    const feePaise = settings.feePaise;
    if (feePaise < 100) return jsonAuth({ error: "Membership is not available right now" }, 409, allowedOrigin);
    const rpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ amount: feePaise, currency: "INR", receipt: `tp-${u.user_id.slice(0, 8)}`, notes: { kind: "membership", days: String(settings.durationDays), uid: u.user_id } }),
    });
    if (!rpRes.ok) { const t = await rpRes.text().catch(() => ""); console.error("Razorpay order error:", t); return jsonAuth({ error: "Payment setup failed" }, 502, allowedOrigin); }
    const order = await rpRes.json();
    return jsonAuth({ id: order.id, amount: order.amount, currency: order.currency, keyId: env.RAZORPAY_KEY_ID }, 200, allowedOrigin);
  }

  // POST /api/membership/verify-payment
  if (method === "POST" && path.endsWith("/membership/verify-payment")) {
    const u = await getSession(request, env);
    if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
    let body = {};
    try { body = await request.json(); } catch { return jsonAuth({ error: "Invalid body" }, 400, allowedOrigin); }
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = body;
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) return jsonAuth({ error: "Missing payment fields" }, 400, allowedOrigin);
    const valid = await verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature, env.RAZORPAY_KEY_SECRET);
    if (!valid) return jsonAuth({ error: "Signature mismatch" }, 400, allowedOrigin);
    // Idempotent: check if already recorded
    const already = await env.DB.prepare(`SELECT id,expires_at FROM memberships WHERE razorpay_order_id=?`).bind(razorpay_order_id).first();
    if (already) return jsonAuth({ ok: true, membershipId: already.id, expiresAt: already.expires_at }, 200, allowedOrigin);
    // The signature only proves *a* Razorpay order was paid. Confirm it is this user's membership order (only this Worker creates
    // orders with that receipt, at the fee configured at the time), paid in full. The fee charged is what gets recorded.
    const rp = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(razorpay_order_id)}`, {
      headers: { Authorization: "Basic " + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`) },
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!rp || !Number.isSafeInteger(rp.amount) || rp.amount < 100 || rp.amount_paid !== rp.amount || rp.receipt !== `tp-${u.user_id.slice(0, 8)}`) {
      return jsonAuth({ error: "Payment does not match a membership order" }, 400, allowedOrigin);
    }
    const days = Math.min(Math.max(parseInt(rp.notes && rp.notes.days, 10) || (await loadMemberSettings(env)).durationDays, 1), 1095);
    try {
      const r = await activateMembership(env, { userId: u.user_id, orderId: razorpay_order_id, paymentId: razorpay_payment_id, amount: rp.amount, days });
      return jsonAuth({ ok: true, membershipId: r.id, expiresAt: r.expiresAt, renewed: !!r.renewed }, 200, allowedOrigin);
    } catch { return jsonAuth({ error: "Could not record membership" }, 500, allowedOrigin); }
  }

  return jsonAuth({ error: "Not found" }, 404, allowedOrigin);
}

// ── Accounts handler ──────────────────────────────────────────────────────────

async function handleAccounts(url, request, env, allowedOrigin) {
  if (!env.DB) return new Response(JSON.stringify({ error: "Database not configured" }), { status: 503, headers: { "Content-Type": "application/json" } });

  const path = url.pathname;
  const method = request.method;
  let body = {};
  if (["POST", "PUT"].includes(method)) {
    try {
      const ct = request.headers.get("Content-Type") || "";
      body = ct.includes("json") ? await request.json() : {};
    } catch { body = {}; }
  }

  // POST /api/accounts/auth/send-otp
  if (method === "POST" && path.endsWith("/auth/send-otp")) {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonAuth({ error: "Invalid email" }, 400, allowedOrigin);
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    const otp = String(100000 + (arr[0] % 900000));
    const id = crypto.randomUUID();
    const expires = Math.floor(Date.now() / 1000) + 600;
    // Max 3 codes per email per 15 minutes (stops email bombing and endless invalidation of a victim's code).
    const sent = await env.DB.prepare("SELECT count(*) AS n FROM otp_tokens WHERE email=? AND created_at > unixepoch() - 900").bind(email).first();
    if (sent && sent.n >= 3) return jsonAuth({ error: "Too many codes requested. Try again in a few minutes." }, 429, allowedOrigin);
    const otpHash = await sha256Hex(`ntagz:otp:${email}:${otp}`);
    await env.DB.batch([
      env.DB.prepare("UPDATE otp_tokens SET used=1 WHERE email=? AND used=0").bind(email),
      env.DB.prepare("INSERT INTO otp_tokens (id, email, otp, expires_at) VALUES (?, ?, ?, ?)").bind(id, email, otpHash, expires),
    ]);
    await sendOtp(email, otp, env);
    return jsonAuth({ sent: true }, 200, allowedOrigin);
  }

  // POST /api/accounts/auth/verify-otp
  if (method === "POST" && path.endsWith("/auth/verify-otp")) {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
    const otp   = typeof body.otp   === "string" ? body.otp.trim().slice(0, 6) : "";
    if (!email || !/^\d{6}$/.test(otp)) return jsonAuth({ error: "Invalid request" }, 400, allowedOrigin);
    // Newest live code only; each guess burns one of 5 attempts (atomic), so 6 digits cannot be brute-forced.
    const token = await env.DB.prepare(
      "SELECT id, otp FROM otp_tokens WHERE email=? AND expires_at>unixepoch() AND used=0 AND attempts<5 ORDER BY created_at DESC, rowid DESC LIMIT 1"
    ).bind(email).first();
    if (!token) return jsonAuth({ error: "Invalid or expired code" }, 401, allowedOrigin);
    const burn = await env.DB.prepare("UPDATE otp_tokens SET attempts=attempts+1 WHERE id=? AND attempts<5").bind(token.id).run();
    if (burn.meta.changes !== 1 || !safeEqual(token.otp, await sha256Hex(`ntagz:otp:${email}:${otp}`))) return jsonAuth({ error: "Invalid or expired code" }, 401, allowedOrigin);
    await env.DB.prepare("UPDATE otp_tokens SET used=1 WHERE id=?").bind(token.id).run();
    let user = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if (!user) {
      const uid = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO users (id, email) VALUES (?, ?)").bind(uid, email).run();
      user = { id: uid };
    }
    const sid = crypto.randomUUID();
    const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
    await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").bind(sid, user.id, exp).run();
    return jsonAuth({ ok: true }, 200, allowedOrigin, sessionCookie(sid, 7 * 86400));
  }

  // POST /api/accounts/auth/logout
  if (method === "POST" && path.endsWith("/auth/logout")) {
    const m = (request.headers.get("Cookie") || "").match(/ntagz_session=([A-Za-z0-9_-]{10,128})/);
    if (m) await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(m[1]).run();
    return jsonAuth({ ok: true }, 200, allowedOrigin, sessionCookie("", 0));
  }

  // GET /api/accounts/me
  if (method === "GET" && path.endsWith("/accounts/me")) {
    const u = await getSession(request, env);
    if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
    return jsonAuth({ user: { email: u.email, name: u.name, phone: u.phone, gstin: u.gstin } }, 200, allowedOrigin);
  }

  // PUT /api/accounts/me
  if (method === "PUT" && path.endsWith("/accounts/me")) {
    const u = await getSession(request, env);
    if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
    const name  = typeof body.name  === "string" ? body.name.trim().slice(0, 100)  : null;
    const phone = typeof body.phone === "string" ? body.phone.replace(/\D/g, "").slice(-10) : null;
    const gstin = typeof body.gstin === "string" ? body.gstin.trim().toUpperCase().slice(0, 15) : null;
    await env.DB.prepare("UPDATE users SET name=COALESCE(?,name), phone=COALESCE(?,phone), gstin=COALESCE(?,gstin) WHERE id=?")
      .bind(name, phone, gstin, u.user_id).run();
    return jsonAuth({ ok: true }, 200, allowedOrigin);
  }

  // GET /api/accounts/addresses
  if (method === "GET" && path.endsWith("/accounts/addresses")) {
    const u = await getSession(request, env);
    if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
    const { results } = await env.DB.prepare(
      "SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC, created_at DESC"
    ).bind(u.user_id).all();
    return jsonAuth({ addresses: results }, 200, allowedOrigin);
  }

  // POST /api/accounts/addresses
  if (method === "POST" && path.endsWith("/accounts/addresses")) {
    const u = await getSession(request, env);
    if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
    const { label, name, phone, line1, city, state, pincode, is_default } = body;
    const id = crypto.randomUUID();
    if (is_default) await env.DB.prepare("UPDATE addresses SET is_default=0 WHERE user_id=?").bind(u.user_id).run();
    await env.DB.prepare(
      "INSERT INTO addresses (id,user_id,label,name,phone,line1,city,state,pincode,is_default) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, u.user_id, (label||"Address").slice(0,20), (name||"").slice(0,100), (phone||"").slice(0,20),
           (line1||"").slice(0,300), (city||"").slice(0,100), (state||"").slice(0,50), (pincode||"").slice(0,10), is_default ? 1 : 0).run();
    return jsonAuth({ id }, 201, allowedOrigin);
  }

  // DELETE /api/accounts/addresses/:id
  const addrDel = path.match(/\/accounts\/addresses\/([0-9a-f-]{36})$/);
  if (method === "DELETE" && addrDel) {
    const u = await getSession(request, env);
    if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
    await env.DB.prepare("DELETE FROM addresses WHERE id=? AND user_id=?").bind(addrDel[1], u.user_id).run();
    return jsonAuth({ ok: true }, 200, allowedOrigin);
  }

  // POST /api/accounts/orders — kept so order/confirm.html keeps working, but it no longer writes anything:
  // paid orders are created server-side when the gateway payment is verified (see finalizeOrder).
  if (method === "POST" && path.endsWith("/accounts/orders")) {
    const txnId = typeof body.txnId === "string" ? body.txnId.slice(0, 128) : "";
    if (!txnId) return jsonAuth({ error: "Missing txnId" }, 400, allowedOrigin);
    const existing = await env.DB.prepare("SELECT id FROM orders WHERE txn_id=?").bind(txnId).first();
    return existing ? jsonAuth({ id: existing.id }, 200, allowedOrigin) : jsonAuth({ pending: true }, 202, allowedOrigin);
  }

  // GET /api/accounts/orders
  if (method === "GET" && path.endsWith("/accounts/orders")) {
    const u = await getSession(request, env);
    if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
    const { results } = await env.DB.prepare(
      "SELECT id,txn_id,gateway,status,quote_ref,total,created_at FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 50"
    ).bind(u.user_id).all();
    return jsonAuth({ orders: results }, 200, allowedOrigin);
  }

  // GET /api/accounts/orders/:id
  const orderGet = path.match(/\/accounts\/orders\/([0-9a-f-]{36})$/);
  if (method === "GET" && orderGet) {
    const u = await getSession(request, env);
    if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
    const order = await env.DB.prepare("SELECT * FROM orders WHERE id=? AND user_id=?").bind(orderGet[1], u.user_id).first();
    if (!order) return jsonAuth({ error: "Not found" }, 404, allowedOrigin);
    try { order.items = JSON.parse(order.items_json || "[]"); } catch { order.items = []; }
    return jsonAuth({ order }, 200, allowedOrigin);
  }

  // POST /api/accounts/orders/:id/reorder
  const reorder = path.match(/\/accounts\/orders\/([0-9a-f-]{36})\/reorder$/);
  if (method === "POST" && reorder) {
    const u = await getSession(request, env);
    if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
    const order = await env.DB.prepare("SELECT items_json FROM orders WHERE id=? AND user_id=?").bind(reorder[1], u.user_id).first();
    if (!order) return jsonAuth({ error: "Not found" }, 404, allowedOrigin);
    let items = [];
    try { items = JSON.parse(order.items_json || "[]"); } catch {}
    return jsonAuth({ items }, 200, allowedOrigin);
  }

  return jsonAuth({ error: "Not found" }, 404, allowedOrigin);
}

// ── Payment routes ─────────────────────────────────────────────────────────

// ── Trusted order recording ───────────────────────────────────────────────
// Orders are only ever written by this Worker from amounts it computed itself (checkout_intents) and a payment it
// verified with the gateway, or as UNPAID offline orders priced by calculateTotal. The browser never supplies an
// amount or a "paid" flag. Recording is best-effort: a D1 problem must never break a payment, so every call is guarded.
const OFFLINE_METHODS = ["upi", "bank", "whatsapp"];

// Statements that deduct sold quantities from tracked products, each guarded by "this order row exists" so a repeat or an
// ignored insert deducts nothing. Deduction is clamped at zero (never negative) and every change gets a movement row.
function stockStatements(env, orderId, txnId, items) {
  const out = [];
  const merged = new Map(); // one stock line per product (order_stock_lines is keyed by order+product)
  for (const it of items) {
    if (!it || typeof it.id !== "string" || !Number.isInteger(it.qty) || it.qty < 1) continue;
    merged.set(it.id, (merged.get(it.id) || 0) + it.qty);
  }
  for (const [id, qty] of merged) {
    // Order matters: allocation reads stock_qty, so it runs before the deduction below.
    out.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO order_stock_lines (order_id,product_id,ready_qty,pre_qty)
         SELECT ?1,id,min(stock_qty,?2),CASE WHEN preorder_enabled=1 THEN ?2-min(stock_qty,?2) ELSE 0 END
         FROM products WHERE id=?3 AND track_stock=1 AND EXISTS (SELECT 1 FROM orders WHERE id=?1)`
      ).bind(orderId, qty, id),
      env.DB.prepare( // non-preorder shortfall (concurrent buyers): hold the paid order for the admin instead of silently shipping short
        `UPDATE orders SET status='on_hold' WHERE id=?1 AND status IN ('placed','confirmed')
         AND EXISTS (SELECT 1 FROM order_stock_lines WHERE order_id=?1 AND product_id=?3 AND pre_qty=0 AND ready_qty<?2)`
      ).bind(orderId, qty, id),
      env.DB.prepare(
        `UPDATE products SET preordered_qty=preordered_qty+coalesce((SELECT pre_qty FROM order_stock_lines WHERE order_id=?1 AND product_id=?2),0), updated_at=unixepoch()
         WHERE id=?2 AND preorder_enabled=1 AND track_stock=1 AND EXISTS (SELECT 1 FROM orders WHERE id=?1)`
      ).bind(orderId, id),
      env.DB.prepare(
        `INSERT INTO inventory_movements (id,product_id,type,qty_change,prev_stock,new_stock,reason,reference,admin,idempotency_key)
         SELECT ?1,id,'out',-min(stock_qty,?2),stock_qty,max(stock_qty-?2,0),'Order sale',?3,'system',?4
         FROM products WHERE id=?5 AND track_stock=1 AND stock_qty>0 AND EXISTS (SELECT 1 FROM orders WHERE id=?4)`
      ).bind(crypto.randomUUID(), qty, txnId, orderId, id),
      env.DB.prepare(
        `UPDATE products SET stock_qty=max(stock_qty-?1,0), updated_at=unixepoch()
         WHERE id=?2 AND track_stock=1 AND EXISTS (SELECT 1 FROM orders WHERE id=?3)`
      ).bind(qty, id, orderId),
    );
  }
  out.push(env.DB.prepare(
    `UPDATE orders SET is_preorder=1, status='preorder_confirmed' WHERE id=?1 AND status IN ('placed','confirmed')
     AND EXISTS (SELECT 1 FROM order_stock_lines WHERE order_id=?1 AND pre_qty>0)`
  ).bind(orderId));
  return out;
}

function cleanDetails(b) {
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const gstin = str(b.gstin, 15).toUpperCase();
  return {
    name: str(b.name, 100),
    phone: typeof b.phone === "string" ? b.phone.replace(/\D/g, "").slice(-10) : "",
    email: str(b.email, 254),
    address: str(b.address, 500),
    pincode: /^\d{6}$/.test(str(b.pincode, 6)) ? str(b.pincode, 6) : "",
    state: str(b.state, 50),
    gstin: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin) ? gstin : "",
    quoteRef: /^[\w-]{1,32}$/.test(str(b.quoteRef, 32)) ? str(b.quoteRef, 32) : "",
  };
}

// Rewards Membership fields of a checkout intent (frozen so the order gets exactly what the customer was shown), plus the hold on the
// points being spent. Empty until migration 0014 is applied.
// migration 0015 (tier points rate) may land after the code: until it does, orders simply earn at the flat rate.
let rateSchema = { db: null, at: 0, ok: false };
async function hasRateSchema(env) {
  if (rateSchema.db === env.DB && (rateSchema.ok || Date.now() - rateSchema.at < 60000)) return rateSchema.ok;
  let ok = false;
  try { ok = !!(await env.DB.prepare("SELECT 1 x FROM pragma_table_info('checkout_intents') WHERE name='points_rate_x100'").first()); } catch { ok = false; }
  rateSchema = { db: env.DB, at: Date.now(), ok };
  return ok;
}

// Does this database have orders.membership_fee_paise (migration 0016: membership inside checkout)?
let ckSchema = { db: null, at: 0, ok: false };
async function hasCheckoutMembershipSchema(env) {
  if (ckSchema.db === env.DB && (ckSchema.ok || Date.now() - ckSchema.at < 60000)) return ckSchema.ok;
  let ok = false;
  try { ok = !!(await env.DB.prepare("SELECT 1 x FROM pragma_table_info('orders') WHERE name='membership_fee_paise'").first()); } catch { ok = false; }
  ckSchema = { db: env.DB, at: Date.now(), ok };
  return ok;
}

// Does this database have orders.processing_target_days (migration 0018: priority build processing)?
let procSchema = { db: null, at: 0, ok: false };
async function hasProcessingSchema(env) {
  if (procSchema.db === env.DB && (procSchema.ok || Date.now() - procSchema.at < 60000)) return procSchema.ok;
  let ok = false;
  try { ok = !!(await env.DB.prepare("SELECT 1 x FROM pragma_table_info('orders') WHERE name='processing_target_days'").first()); } catch { ok = false; }
  procSchema = { db: env.DB, at: Date.now(), ok };
  return ok;
}

// ── Membership inside checkout ───────────────────────────────────────────────
// The browser may only ASK (`membership: "add"`). The server decides whether that is allowed, adds the configured fee, and prices the
// merchandise as a paid member would pay. The fee sits outside every discount, GST rule and points basis.
async function membershipAdd(env, request, base) {
  const settings = await loadMemberSettings(env);
  if (!settings.checkoutOffer || !settings.live) return { error: "Membership can't be added at checkout right now", status: 409 };
  if (settings.feePaise < 100 || settings.feePaise % 100) return { error: "Membership can't be added at checkout right now", status: 409 };
  const uid = (shopperOf.get(request) || {}).userId;
  if (!uid) return { error: "Sign in to add membership", code: "login_required", status: 401 };
  if (!(await hasCheckoutMembershipSchema(env))) return { error: "Membership can't be added at checkout right now", status: 409 };
  const active = await env.DB.prepare("SELECT 1 x FROM memberships WHERE user_id=? AND status='active' AND expires_at>unixepoch() LIMIT 1").bind(uid).first();
  if (active) return { error: "You already have an active membership", code: "already_member", status: 409 };
  return { member: { settings, paid: true, loyalty: base ? base.loyalty : null, userId: uid }, fee: { paise: settings.feePaise, rupees: settings.feePaise / 100, days: settings.durationDays } };
}

// The single entry point that prices a cart for quote, Razorpay and PayU: the caller's own member context, plus membership when asked.
// Returns { total, points, member, base, add } or { error, status, code }.
async function pricedCheckout(env, request, body, pricing) {
  const base = await getMemberContext(request, env);
  let member = base, add = null;
  if (body.membership === "add") {
    if (Number(body.redeemPoints) > 0) return { error: "Points can't be used on an order that includes a new membership", status: 409 };
    add = await membershipAdd(env, request, base);
    if (add.error) return add;
    member = add.member;
  }
  const pc = await pricedCart(env, request, member, body.items, typeof body.state === "string" ? body.state.slice(0, 50) : "", pricing, await campaignsFor(request, env, member), body.redeemPoints);
  if (pc.error) return pc;
  if (add) { pc.total.amount += add.fee.rupees; pc.total.membershipFeePaise = add.fee.paise; pc.total.membershipDays = add.fee.days; }
  // Every order is made to order: it carries a working-day processing target. A paid member (or buying membership now) gets
  // the shorter priority target; priority is only ever GRANTED at verified payment (finalizeOrder/offline), never here.
  const dcfg = (await loadMemberSettings(env)).dispatch || DISPATCH.fromCfg({});
  const priority = add ? true : !!(base && base.paid);
  pc.total.processingTargetDays = DISPATCH.targetDays(dcfg, priority);
  pc.total.priorityBuild = priority ? 1 : 0;
  return { ...pc, member, base, add };
}

// What the customer sees before deciding: today's total with and without membership for THIS cart, from the same engine. Nothing is stored.
// Points redemption is left out of both so the two numbers differ only by membership.
async function membershipOffer(env, request, body, base, pricing) {
  const settings = await loadMemberSettings(env);
  if (!settings.checkoutOffer || !settings.live || settings.feePaise < 100 || settings.feePaise % 100 || !(await hasCheckoutMembershipSchema(env))) return { show: false, state: "off" };
  const uid = (shopperOf.get(request) || {}).userId;
  if (uid && await env.DB.prepare("SELECT 1 x FROM memberships WHERE user_id=? AND status='active' AND expires_at>unixepoch() LIMIT 1").bind(uid).first()) return { show: false, state: "active" };
  const state = typeof body.state === "string" ? body.state.slice(0, 50) : "";
  const withCtx = { settings, paid: true, loyalty: base ? base.loyalty : null };
  const [without, withM] = [calculateTotal(body.items, state, base, pricing, await campaignsFor(request, env, base)), calculateTotal(body.items, state, withCtx, pricing, await campaignsFor(request, env, withCtx))];
  if (!without || !withM) return { show: false, state: "off" };
  const savingsPaise = (without.amount - withM.amount) * 100, withoutPaise = without.amount * 100, withPaise = withM.amount * 100 + settings.feePaise;
  const dcfg = settings.dispatch || DISPATCH.fromCfg({});
  // Only worth interrupting checkout when membership actually lowers this cart's price; otherwise a quiet link is enough (show:false keeps the numbers).
  // The processing targets ride along so the selector can state the honest build-time difference (working days, never a rupee value).
  return { show: savingsPaise > 0, state: uid ? "eligible" : "login_required", feePaise: settings.feePaise, durationDays: settings.durationDays, savingsPaise, withoutPaise, withPaise, netPaise: withoutPaise - withPaise, standardDays: dcfg.standardDays, memberDays: dcfg.memberDays };
}

async function pointsIntentStatements(env, txnId, u, total) {
  if (!(await hasPointsSchema(env))) return [];
  const rate = await hasRateSchema(env);
  const out = [env.DB.prepare("UPDATE checkout_intents SET points_basis_paise=?, points_redeemed=?, points_discount_paise=?, member_saving_paise=?" + (rate ? ", points_rate_x100=?" : "") + " WHERE txn_id=?")
    .bind(total.pointsBasisPaise || 0, total.pointsRedeemed || 0, total.pointsDiscountPaise || 0, total.memberSavingPaise || 0, ...(rate ? [Number.isInteger(total.pointsRateX100) ? total.pointsRateX100 : null] : []), txnId)];
  if (u && total.pointsRedeemed > 0) out.push(...POINTS.reserve(env.DB, u.user_id, txnId, total.pointsRedeemed));
  return out;
}

async function recordIntent(env, request, txnId, gateway, body, total) {
  if (!env.DB || !txnId) return;
  try {
    const u = await getSession(request, env);
    const d = cleanDetails(body);
    if (!d.email && u && u.email) d.email = u.email;   // signed in: the order carries the account's email (order emails, invoices)
    const items = (Array.isArray(body.items) ? body.items : []).map((i) => ({ id: String(i.id).slice(0, 64), qty: i.qty }));
    const amountPaise = total.amount * 100, gstPaise = total.gst * 100;
    const rw = await hasRewardsSchema(env);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM checkout_intents WHERE created_at < unixepoch() - 604800"),
      rw ? env.DB.prepare(
        `INSERT OR REPLACE INTO checkout_intents (txn_id,gateway,user_id,items_json,name,phone,email,address,pincode,state,gstin,quote_ref,subtotal_paise,gst_paise,amount_paise,shipping_paise,discount_paise,qualifying_paise,loyalty_tier,campaign_id,campaign_discount_paise)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(txnId, gateway, u ? u.user_id : null, JSON.stringify(items), d.name, d.phone, d.email, d.address, d.pincode, d.state, d.gstin, d.quoteRef,
             amountPaise - gstPaise, gstPaise, amountPaise, total.shippingPaise, total.memberDiscountPaise, total.qualifyingPaise, total.loyaltyTier || null, total.campaign ? total.campaign.id : null, total.campaignDiscountPaise)
      : env.DB.prepare(
        `INSERT OR REPLACE INTO checkout_intents (txn_id,gateway,user_id,items_json,name,phone,email,address,pincode,state,gstin,quote_ref,subtotal_paise,gst_paise,amount_paise)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(txnId, gateway, u ? u.user_id : null, JSON.stringify(items), d.name, d.phone, d.email, d.address, d.pincode, d.state, d.gstin, d.quoteRef,
             amountPaise - gstPaise, gstPaise, amountPaise),
      ...(await pointsIntentStatements(env, txnId, u, total)),
      ...(await hasCheckoutMembershipSchema(env) ? [env.DB.prepare("UPDATE checkout_intents SET membership_fee_paise=?, membership_days=?, rules_json=? WHERE txn_id=?")
        .bind(total.membershipFeePaise || 0, total.membershipDays || 0, JSON.stringify({ v: 1, fee_paise: total.membershipFeePaise || 0, duration_days: total.membershipDays || 0, member_pricing: !!total.member, loyalty_tier: total.loyaltyTier || null,
          points_rate_x100: Number.isInteger(total.pointsRateX100) ? total.pointsRateX100 : null, points_redeemed: total.pointsRedeemed || 0, campaign: total.campaign ? total.campaign.id : null,
          processing_days: Number.isInteger(total.processingTargetDays) ? total.processingTargetDays : null, priority_build: total.priorityBuild ? 1 : 0 }), txnId)] : []),
      ...(await hasProcessingSchema(env) ? [env.DB.prepare("UPDATE checkout_intents SET processing_target_days=?, priority_build=? WHERE txn_id=?")
        .bind(Number.isInteger(total.processingTargetDays) ? total.processingTargetDays : null, total.priorityBuild ? 1 : 0, txnId)] : []),
    ]);
  } catch (e) { console.error("recordIntent failed:", e && e.message); }
}

// A gateway payment was verified but no order exists for it. Never silent: a structured log line plus a durable row to reconcile
// (SELECT * FROM payment_alerts WHERE resolved=0). If D1 itself is down only the log line survives.
async function alertPayment(env, txnId, gateway, ref, paise, reason) {
  console.error(`PAYMENT NOT RECORDED txn=${txnId} gateway=${gateway} ref=${ref} paise=${paise} reason=${reason}`);
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO payment_alerts (id,txn_id,gateway,payment_ref,amount_paise,reason) VALUES (?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), txnId, gateway, ref || null, Number.isFinite(paise) ? paise : null, reason).run();
  } catch (e) { console.error("payment alert not stored:", e && e.message); }
}

// Same batch as the order insert, so points spent and the order they were spent on are recorded together or not at all.
// Replays are harmless: the UPDATE sets the same values and the ledger key is unique.
function pointsOrderStatements(env, oid, intent) {
  if (intent.points_basis_paise === undefined) return [];
  const out = [env.DB.prepare("UPDATE orders SET points_basis_paise=?, points_redeemed=?, points_discount_paise=?, member_saving_paise=?" + (intent.points_rate_x100 !== undefined ? ", points_rate_x100=?" : "") + " WHERE id=?")
    .bind(intent.points_basis_paise || 0, intent.points_redeemed || 0, intent.points_discount_paise || 0, intent.member_saving_paise || 0, ...(intent.points_rate_x100 !== undefined ? [Number.isInteger(intent.points_rate_x100) ? intent.points_rate_x100 : null] : []), oid)];
  if (intent.user_id && intent.points_redeemed > 0) {
    out.push(env.DB.prepare("INSERT OR IGNORE INTO points_ledger (id,user_id,kind,points,order_id,idem_key,reason) SELECT ?,user_id,'redeem',?,id,?,? FROM orders WHERE id=? AND user_id IS NOT NULL")
      .bind(crypto.randomUUID(), -intent.points_redeemed, `redeem:${oid}`, "redeemed at checkout", oid));
  }
  return out;
}

// Same batch as the order: freezes the fee and rules on it and, when the order bought membership, activates it. The term starts when the order
// was created (or after a term still running), and memberships.razorpay_order_id is UNIQUE, so replays and races activate it once.
function membershipOrderStatements(env, oid, intent, txnId, ref) {
  if (intent.membership_fee_paise === undefined) return [];
  const out = [env.DB.prepare("UPDATE orders SET membership_fee_paise=?, rules_json=? WHERE id=?").bind(intent.membership_fee_paise || 0, intent.rules_json || null, oid)];
  if (intent.membership_fee_paise > 0 && intent.user_id) {
    out.push(env.DB.prepare(`INSERT OR IGNORE INTO memberships (id,user_id,status,purchased_at,expires_at,welcome_credit_paise,price_paid,payment_id,razorpay_order_id)
      SELECT ?1, o.user_id, 'active', s.t, s.t + ?2 * 86400, 0, ?3, ?4, ?5
      FROM orders o, (SELECT max(o2.created_at, coalesce((SELECT max(expires_at) FROM memberships WHERE user_id=?6 AND status='active' AND expires_at>unixepoch()), 0)) t FROM orders o2 WHERE o2.id=?7) s WHERE o.id=?7`)
      .bind(crypto.randomUUID(), intent.membership_days || 365, intent.membership_fee_paise, String(ref || txnId).slice(0, 128), txnId, intent.user_id, oid));
  }
  return out;
}

// Same batch as the order: freeze the working-day target and the date the order is promised to dispatch. Priority is
// a paid-membership benefit decided at pricing; the promise is computed once here from a verified payment (replays write the same values).
async function processingOrderStatements(env, oid, intent) {
  if (intent.processing_target_days === undefined || intent.processing_target_days === null) return [];
  const cfg = (await loadMemberSettings(env)).dispatch || DISPATCH.fromCfg({});
  const promise = DISPATCH.promisedDispatch(Date.now(), intent.processing_target_days, cfg);
  return [env.DB.prepare("UPDATE orders SET processing_target_days=?, priority_build=?, promised_dispatch=? WHERE id=?")
    .bind(intent.processing_target_days, intent.priority_build ? 1 : 0, promise.date, oid)];
}

// Returns "recorded" | "already" (order exists from an earlier call) | "failed" (payment verified, no order: customer must be told).
async function finalizeOrder(env, txnId, paymentRef, verifiedPaise, gateway) {
  const ref = String(paymentRef || "").slice(0, 128);
  if (!env.DB || !txnId) { console.error(`PAYMENT NOT RECORDED txn=${txnId} gateway=${gateway} ref=${ref} reason=no database`); return "failed"; }
  try {
    const intent = await env.DB.prepare("SELECT * FROM checkout_intents WHERE txn_id=?").bind(txnId).first();
    if (!intent) {
      if (await env.DB.prepare("SELECT 1 AS x FROM orders WHERE txn_id=?").bind(txnId).first()) return "already";
      await alertPayment(env, txnId, gateway, ref, verifiedPaise, "no checkout intent (never saved or expired)");
      return "failed";
    }
    if (verifiedPaise !== null && verifiedPaise !== intent.amount_paise) {
      await alertPayment(env, txnId, gateway, ref, verifiedPaise, `paid amount ${verifiedPaise} differs from order amount ${intent.amount_paise}`);
      return "failed";
    }
    const oid = crypto.randomUUID();
    const rw = intent.qualifying_paise !== undefined; // the intent row only has these fields once migration 0012 is applied
    await env.DB.batch([
      (rw ? env.DB.prepare(
        `INSERT OR IGNORE INTO orders (id,user_id,txn_id,gateway,quote_ref,items_json,name,phone,email,address,pincode,state,gstin,subtotal,gst,total,payment_method,payment_status,paid_paise,shipping_paise,discount_paise,qualifying_paise,loyalty_tier,campaign_id,campaign_discount_paise)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'paid', ?,?,?,?,?,?,?)`
      ).bind(oid, intent.user_id, txnId, intent.gateway, intent.quote_ref, intent.items_json, intent.name, intent.phone, intent.email,
             intent.address, intent.pincode, intent.state, intent.gstin, intent.subtotal_paise, intent.gst_paise, intent.amount_paise,
             intent.gateway, intent.amount_paise, intent.shipping_paise, intent.discount_paise, intent.qualifying_paise, intent.loyalty_tier, intent.campaign_id, intent.campaign_discount_paise)
      : env.DB.prepare(
        `INSERT OR IGNORE INTO orders (id,user_id,txn_id,gateway,quote_ref,items_json,name,phone,email,address,pincode,state,gstin,subtotal,gst,total,payment_method,payment_status,paid_paise)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'paid', ?)`
      ).bind(oid, intent.user_id, txnId, intent.gateway, intent.quote_ref, intent.items_json, intent.name, intent.phone, intent.email,
             intent.address, intent.pincode, intent.state, intent.gstin, intent.subtotal_paise, intent.gst_paise, intent.amount_paise,
             intent.gateway, intent.amount_paise)),
      env.DB.prepare(
        `INSERT INTO payments (id,order_id,method,amount_paise,recorded_by,idempotency_key,reference)
         SELECT ?,id,?,?,'gateway',?,? FROM orders WHERE id=? AND changes()=1`
      ).bind(crypto.randomUUID(), intent.gateway, intent.amount_paise, String(paymentRef || txnId).slice(0, 64), String(paymentRef || "").slice(0, 128) || null, oid),
      // keep the intent unless the order really exists (INSERT OR IGNORE swallows constraint errors), so a retry can finish the job
      env.DB.prepare("DELETE FROM checkout_intents WHERE txn_id=?1 AND EXISTS (SELECT 1 FROM orders WHERE txn_id=?1)").bind(txnId),
      ...stockStatements(env, oid, txnId, JSON.parse(intent.items_json || "[]")),
      ...pointsOrderStatements(env, oid, intent),
      ...membershipOrderStatements(env, oid, intent, txnId, ref),
      ...(await processingOrderStatements(env, oid, intent)),
    ]);
    if (!await env.DB.prepare("SELECT 1 AS x FROM orders WHERE txn_id=?").bind(txnId).first()) {
      await alertPayment(env, txnId, gateway || intent.gateway, ref, intent.amount_paise, "order row was not created");
      return "failed";
    }
    if (intent.user_id && intent.points_basis_paise !== undefined) {   // points: spend recorded already (same batch); earning is reconciled from the order
      try { await POINTS.reconcileOrder(env.DB, oid); } catch (e) { console.error("points reconcile failed:", e && e.message); }
    }
    if (intent.user_id && intent.qualifying_paise !== undefined) {   // record any tier change this payment caused (history only; prices re-derive the tier)
      try { await LOYALTY.syncTier(env.DB, intent.user_id, "order paid"); } catch (e) { console.error("tier sync failed:", e && e.message); }
    }
    return "recorded";
  } catch (e) {
    // the batch is atomic, so the intent is still there: the gateway retrying the callback (or the customer reloading) can complete it
    await alertPayment(env, txnId, gateway, ref, verifiedPaise, `database error: ${String(e && e.message).slice(0, 120)}`);
    return "failed";
  }
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function recordOfflineOrder(request, env, body, origin) {
  if (!env.DB) return json({ error: "Orders are temporarily unavailable" }, 503, origin);
  const method = typeof body.method === "string" ? body.method.toLowerCase() : "";
  if (!OFFLINE_METHODS.includes(method)) return json({ error: "Invalid payment method" }, 400, origin);
  const d = cleanDetails(body);
  if (d.name.length < 2 || d.phone.length !== 10 || d.address.length < 5 || !d.pincode || !d.quoteRef) return json({ error: "Missing or invalid customer details" }, 400, origin);
  const member = await getMemberContext(request, env);
  const pricing = await loadPricing(env);
  const blocked = unavailableReason(body.items, pricing);
  if (blocked) return json({ error: blocked }, 409, origin);
  const pc = await pricedCart(env, request, member, body.items, d.state, pricing, await campaignsFor(request, env, member), 0); // points are spent on online payments only
  if (pc.error) return json({ error: pc.error }, pc.status, origin);
  const total = pc.total;
  const ipHash = await sha256Hex(`ntagz:${request.headers.get("CF-Connecting-IP") || "unknown"}`);
  const recent = await env.DB.prepare("SELECT count(*) c FROM order_attempts WHERE ip_hash=? AND created_at>unixepoch()-600").bind(ipHash).first();
  if (recent.c >= 5) return json({ error: "Too many orders from this connection. Please try again later or contact us on WhatsApp." }, 429, origin);
  const u = await getSession(request, env);
  const txnId = `OFF-${d.quoteRef}-${d.phone}`; // the same quote re-submitted (e.g. a repeated WhatsApp tap) maps to the same order
  const items = body.items.map((i) => ({ id: String(i.id).slice(0, 64), qty: i.qty }));
  const amountPaise = total.amount * 100, gstPaise = total.gst * 100;
  const orderIdOffline = crypto.randomUUID();
  const rw = await hasRewardsSchema(env);
  // Offline (unpaid) orders carry the standard working-day target: priority is granted only at a verified payment
  // (online or later in the admin), so nothing here can jump the queue. The promised date is the normal-order promise.
  const dcfg = (await loadMemberSettings(env)).dispatch || DISPATCH.fromCfg({});
  const procOk = await hasProcessingSchema(env);
  const promise = procOk ? DISPATCH.promisedDispatch(Date.now(), dcfg.standardDays, dcfg) : null;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM order_attempts WHERE created_at < unixepoch() - 86400"),
    env.DB.prepare("INSERT INTO order_attempts (ip_hash) VALUES (?)").bind(ipHash),
    rw ? env.DB.prepare(
      `INSERT OR IGNORE INTO orders (id,user_id,txn_id,gateway,quote_ref,items_json,name,phone,email,address,pincode,state,gstin,subtotal,gst,total,payment_method,payment_status,paid_paise,shipping_paise,discount_paise,qualifying_paise,loyalty_tier,campaign_id,campaign_discount_paise)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'unpaid', 0, ?,?,?,?,?,?)`
    ).bind(orderIdOffline, u ? u.user_id : null, txnId, method, d.quoteRef, JSON.stringify(items), d.name, d.phone, d.email, d.address, d.pincode,
           d.state, d.gstin, amountPaise - gstPaise, gstPaise, amountPaise, method, total.shippingPaise, total.memberDiscountPaise, total.qualifyingPaise, total.loyaltyTier || null, total.campaign ? total.campaign.id : null, total.campaignDiscountPaise)
    : env.DB.prepare(
      `INSERT OR IGNORE INTO orders (id,user_id,txn_id,gateway,quote_ref,items_json,name,phone,email,address,pincode,state,gstin,subtotal,gst,total,payment_method,payment_status,paid_paise)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'unpaid', 0)`
    ).bind(orderIdOffline, u ? u.user_id : null, txnId, method, d.quoteRef, JSON.stringify(items), d.name, d.phone, d.email, d.address, d.pincode,
           d.state, d.gstin, amountPaise - gstPaise, gstPaise, amountPaise, method),
    ...stockStatements(env, orderIdOffline, txnId, items),
    // the order earns when its payment is recorded in the admin (reconciled there); the basis is frozen now
    ...((await hasPointsSchema(env)) ? [env.DB.prepare("UPDATE orders SET points_basis_paise=?, member_saving_paise=? WHERE txn_id=? AND payment_status='unpaid'").bind(total.pointsBasisPaise || 0, total.memberSavingPaise || 0, txnId)] : []),
    ...(procOk ? [env.DB.prepare("UPDATE orders SET processing_target_days=?, priority_build=0, promised_dispatch=? WHERE txn_id=? AND payment_status='unpaid'").bind(dcfg.standardDays, promise.date, txnId)] : []),
  ]);
  return json({ ok: true, orderRef: txnId, total: total.amount }, 200, origin);
}

const STATUS_LABELS = { placed: "Order placed", confirmed: "Confirmed", processing: "Processing", packed: "Packed", shipped: "Shipped", out_for_delivery: "Out for delivery", delivered: "Delivered", on_hold: "On hold", cancelled: "Cancelled", delivery_failed: "Delivery failed", returned: "Returned", preorder_confirmed: "Pre-order confirmed", awaiting_stock: "Awaiting stock", ready_to_pack: "Ready to pack" };

// Whitelisted customer view of an order. Unknown order and wrong token are indistinguishable (same 404).
async function trackOrder(url, env, origin) {
  const notFound = () => json({ error: "Not found" }, 404, origin);
  const o = url.searchParams.get("o") || "", t = url.searchParams.get("t") || "";
  if (!/^[0-9a-fA-F-]{8,64}$/.test(o) || !/^[0-9a-f]{32}$/.test(t)) return notFound();
  if (!env.DB) return json({ error: "Tracking unavailable" }, 503, origin);
  try {
    const hasProc = await hasProcessingSchema(env);
    const ord = await env.DB.prepare(`SELECT id, status, payment_status, total, items_json, state, pincode, created_at, is_preorder, expected_dispatch, track_token${hasProc ? ", processing_target_days, priority_build, promised_dispatch" : ""} FROM orders WHERE id = ?`).bind(o).first();
    if (!ord || !safeEqual(String(ord.track_token || ""), t)) return notFound();
    const [pays, evs, ships, prods, lines] = await Promise.all([
      env.DB.prepare("SELECT created_at FROM payments WHERE order_id = ?").bind(ord.id).all(),
      env.DB.prepare("SELECT kind, status, public_note, created_at FROM order_events WHERE order_id = ? AND customer_visible = 1 AND kind IN ('status','shipment','dispatch')").bind(ord.id).all(),
      env.DB.prepare("SELECT courier, awb, tracking_url, shipped_on, est_delivery FROM shipments WHERE order_id = ? ORDER BY created_at").bind(ord.id).all(),
      env.DB.prepare("SELECT id, name FROM products").all(),
      env.DB.prepare("SELECT product_id, ready_qty, pre_qty FROM order_stock_lines WHERE order_id = ?").bind(ord.id).all(),
    ]);
    const stockLine = Object.fromEntries((lines.results || []).map((l) => [l.product_id, l]));
    const names = Object.fromEntries((prods.results || []).map((p) => [p.id, p.name]));
    let raw = []; try { raw = JSON.parse(ord.items_json || "[]"); } catch {}
    const items = (Array.isArray(raw) ? raw : []).map((i) => {
      const l = stockLine[i.id];
      return { name: names[i.id] || String(i.id), qty: Number(i.qty) || 0, ...(l ? { ready_qty: l.ready_qty, pre_qty: l.pre_qty } : {}) };
    });
    const journey = [
      { kind: "placed", label: "Order placed", at: ord.created_at, note: null },
      ...(pays.results || []).map((p) => ({ kind: "payment", label: "Payment received", at: p.created_at, note: null })),
      ...(evs.results || []).map((e) => ({ kind: e.kind, status: e.status, label: e.kind === "dispatch" ? "Expected dispatch updated" : STATUS_LABELS[e.status] || e.status || "Update", at: e.created_at, note: e.public_note || null })),
    ].sort((a, b) => a.at - b.at);
    return json({
      ref: ord.id.slice(0, 8), placed_at: ord.created_at, status: ord.status, status_label: STATUS_LABELS[ord.status] || ord.status,
      payment_status: ord.payment_status, is_preorder: !!ord.is_preorder, expected_dispatch: ord.expected_dispatch || null, items, total_paise: ord.total,
      ...(hasProc ? { processing_target_days: ord.processing_target_days ?? null, priority_build: !!ord.priority_build, promised_dispatch: ord.promised_dispatch || null } : {}),
      ship_to: { state: ord.state, pincode: ord.pincode }, shipments: ships.results || [], journey,
    }, 200, origin);
  } catch { return json({ error: "Tracking unavailable" }, 503, origin); }
}

// Asks PayU's own verify API whether this transaction really succeeded for this amount. A signed hash alone only proves PayU sent the
// message; this is what lets a payment become an order. Throws on network trouble (callers treat that as "not confirmed").
async function payuConfirmed(env, body) {
  const verificationHash = await sha512(`${env.PAYU_KEY}|verify_payment|${body.txnid}|${env.PAYU_SALT}`);
  const verification = await fetch(env.PAYU_ENV === "test"
    ? "https://test.payu.in/merchant/postservice.php?form=2"
    : "https://info.payu.in/merchant/postservice.php?form=2", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key: env.PAYU_KEY, command: "verify_payment", var1: body.txnid, hash: verificationHash }),
  });
  if (!verification.ok) throw new Error("PayU payment verification failed");
  const result = await verification.json();
  const transaction = result.transaction_details?.[body.txnid];
  return result.status === 1 && transaction?.status === "success" &&
    safeEqual(String(transaction?.amount || ""), body.amount) && transaction?.txnid === body.txnid;
}

// ── PayU webhook: POST /api/payu/webhook ───────────────────────────────────────
// The PayU twin of the Razorpay webhook: PayU's servers report a successful payment even if the customer never came back to /payu/success
// (closed tab, lost connection). Same trust chain as the browser return: PayU's signed hash, our merchant key, then PayU's verify API.
// It records through the same idempotent finalizeOrder, so the return page and the webhook can never create two orders.
// Configure in the PayU dashboard: Webhooks -> Payment Success -> https://ntagz.com/api/payu/webhook
async function payuWebhook(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!env.PAYU_KEY || !env.PAYU_SALT || !env.DB) return json({ error: "Webhook not configured" }, 503);
  if (Number(request.headers.get("Content-Length")) > 20000) return json({ error: "Request too large" }, 413);
  const raw = await request.text();
  if (raw.length > 20000) return json({ error: "Request too large" }, 413);
  let body;
  try { body = (request.headers.get("Content-Type") || "").includes("json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); }
  catch { return json({ error: "Invalid body" }, 400); }
  if (!body || typeof body !== "object" || !(await verifyPayuResponse(body, env.PAYU_SALT)) || body.key !== env.PAYU_KEY) return json({ error: "Invalid signature" }, 400);
  // Failures, pending and anything else are acknowledged and ignored (an error would only make PayU retry).
  if (body.status !== "success") return json({ ok: true, ignored: true });
  try {
    if (!(await payuConfirmed(env, body))) {
      await alertPayment(env, body.txnid, "payu", String(body.mihpayid || ""), Math.round(parseFloat(body.amount) * 100), "webhook: PayU verify API did not confirm the payment");
      return json({ ok: true, ignored: true });
    }
    const r = await finalizeOrder(env, body.txnid, String(body.mihpayid || "").slice(0, 128), Math.round(parseFloat(body.amount) * 100), "payu");
    return r === "failed" ? json({ error: "Could not record the order" }, 500) : json({ ok: true });
  } catch (e) { console.error("payu webhook failed:", e && e.message); return json({ error: "Could not process" }, 500); }
}

// ── Rate limits ────────────────────────────────────────────────────────────────
// Per client IP (stored hashed). `throttled` is for routes that call a payment gateway and write to D1, so a script cannot flood Razorpay/PayU
// order creation or the database; it counts in D1, so it holds across Worker instances. Requests without CF-Connecting-IP never reach
// production through Cloudflare (local runs and tests only) and are not limited.
async function throttled(env, request, bucket, max, windowSec) {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || !env.DB) return false;
  try {
    const ipHash = await sha256Hex(`ntagz:${bucket}:${ip}`);
    const r = await env.DB.prepare("SELECT count(*) c FROM order_attempts WHERE ip_hash=? AND created_at>unixepoch()-?").bind(ipHash, windowSec).first();
    if (r && r.c >= max) return true;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO order_attempts (ip_hash) VALUES (?)").bind(ipHash),
      ...(Math.random() < 0.02 ? [env.DB.prepare("DELETE FROM order_attempts WHERE created_at < unixepoch() - 86400")] : []),
    ]);
    return false;
  } catch (e) { console.error("rate limit check failed:", e && e.message); return false; } // never block a sale on a limiter fault
}
// Cheap per-instance limit for read-only routes (no D1 writes per request). Resets when an instance recycles; that is acceptable here.
const quickHits = new Map();
function quickLimited(request, bucket, max, windowMs) {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return false;
  const key = bucket + ":" + ip, t = Date.now(), h = quickHits.get(key);
  if (!h || t - h.at > windowMs) { if (quickHits.size > 5000) quickHits.clear(); quickHits.set(key, { at: t, n: 1 }); return false; }
  return ++h.n > max;
}
const TOO_MANY = "Too many attempts from this connection. Please wait a few minutes and try again, or contact us on WhatsApp.";

// ── Razorpay webhook: POST /api/razorpay/webhook ───────────────────────────────
// Server-to-server safety net for a customer who paid but whose browser never reached verify-payment (closed tab, lost connection). Trusted only
// by its HMAC signature over the raw body (secret RAZORPAY_WEBHOOK_SECRET); the browser is not involved. Handles `order.paid` only, and funnels
// into the same idempotent paths as the browser: activateMembership for membership orders, finalizeOrder for merchandise orders.
const intlDeps = () => ({ json, getSession, stockStatements, loadPricing, unavailableReason, alertPayment });

async function razorpayWebhook(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!env.RAZORPAY_WEBHOOK_SECRET || !env.DB) return json({ error: "Webhook not configured" }, 503);
  if (Number(request.headers.get("Content-Length")) > 200000) return json({ error: "Request too large" }, 413);
  const raw = await request.text();
  if (raw.length > 200000) return json({ error: "Request too large" }, 413);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.RAZORPAY_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw))), (b) => b.toString(16).padStart(2, "0")).join("");
  if (!safeEqual(expected, request.headers.get("X-Razorpay-Signature"))) return json({ error: "Invalid signature" }, 400);
  let ev;
  try { ev = JSON.parse(raw); } catch { return json({ error: "Invalid body" }, 400); }
  // International orders (reference INT-...) are handled by lib/intl-api.js: staged USD payments, refunds, failures. Everything else is unchanged.
  if (await INTLAPI.isIntlEvent(ev, env)) {
    try { return await INTLAPI.processIntlEvent(ev, request.headers.get("X-Razorpay-Event-Id") || expected, env, intlDeps()); }
    catch (e) { console.error("intl webhook failed:", e && e.message); return json({ error: "Could not process" }, 500); }
  }
  const o = ev && ev.event === "order.paid" && ev.payload && ev.payload.order && ev.payload.order.entity, pay = ev && ev.payload && ev.payload.payment && ev.payload.payment.entity;
  // Anything else, or an order not paid in full, is acknowledged and ignored (a 4xx/5xx would only make Razorpay retry it).
  if (!o || !pay || typeof o.id !== "string" || typeof pay.id !== "string" || !Number.isSafeInteger(o.amount) || o.amount_paid !== o.amount) return json({ ok: true, ignored: true });
  const notes = o.notes && typeof o.notes === "object" && !Array.isArray(o.notes) ? o.notes : {};
  try {
    if (notes.kind === "membership") {
      const uid = notes.uid;
      if (typeof uid !== "string" || o.receipt !== `tp-${uid.slice(0, 8)}` || o.amount < 100) return json({ ok: true, ignored: true });
      if (!(await env.DB.prepare("SELECT 1 x FROM users WHERE id=?").bind(uid).first())) return json({ ok: true, ignored: true });
      const days = Math.min(Math.max(parseInt(notes.days, 10) || (await loadMemberSettings(env)).durationDays, 1), 1095);
      await activateMembership(env, { userId: uid, orderId: o.id, paymentId: pay.id, amount: o.amount, days });
      return json({ ok: true });
    }
    const r = await finalizeOrder(env, o.id, pay.id, o.amount_paid, "razorpay");
    return r === "failed" ? json({ error: "Could not record the order" }, 500) : json({ ok: true });
  } catch (e) { console.error("razorpay webhook failed:", e && e.message); return json({ error: "Could not process" }, 500); }
}

async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const allowedOrigin = origin === "https://ntagz.com" ? origin : "https://www.ntagz.com";
  const responseHeaders = { ...corsHeaders, "Access-Control-Allow-Origin": allowedOrigin };
  if (request.method === "OPTIONS") return new Response(null, { headers: responseHeaders });

  if (url.pathname.endsWith("/razorpay/webhook")) return razorpayWebhook(request, env);
  if (url.pathname.endsWith("/payu/webhook")) return payuWebhook(request, env);

  // International storefront (/api/intl/*). Dispatched first: several routes below match on a path suffix (/catalog, /quote ...).
  if (url.pathname.includes("/intl/")) {
    if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405, origin);
    return INTLAPI.handleIntl(url, request, env, origin, intlDeps());
  }

  const crmRes = await CRMPUBLIC.handle(url, request, env, { getSession });
  if (crmRes) return crmRes;

  // ── Public live catalogue: GET /api/catalog (price + availability only; no exact stock counts) ──
  if (url.pathname.endsWith("/catalog") && !url.pathname.includes("/accounts/")) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, origin);
    const pricing = await loadPricing(env);
    if (!pricing) return json({ error: "Catalogue unavailable" }, 503, origin);
    const items = Object.values(pricing).map((r) => ({
      id: r.id, price: r.price_paise / 100, active: !!r.active,
      available: !r.track_stock || r.stock_qty > 0 || (!!r.preorder_enabled && (r.preorder_max == null || r.preordered_qty < r.preorder_max)),
      low: !!r.track_stock && r.stock_qty > 0 && r.stock_qty <= r.low_stock_threshold,
      left: r.track_stock && r.stock_qty > 0 && r.stock_qty <= r.low_stock_threshold ? r.stock_qty : null,
      preorder: r.track_stock && r.preorder_enabled ? {
        message: r.preorder_message || null, dispatch: r.preorder_dispatch || null, ready_qty: r.stock_qty,
        max_qty: r.preorder_max == null ? null : Math.max(r.preorder_max - r.preordered_qty, 0),
      } : null,
    }));
    const res = json(items, 200, origin);
    res.headers.set("Cache-Control", "public, max-age=60");
    return res;
  }

  // ── Public read-only order tracking: GET /api/track?o=<orderId>&t=<token> ──
  if (url.pathname.endsWith("/track") && !url.pathname.includes("/accounts/")) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, origin);
    const res = await trackOrder(url, env, origin);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }

  // ── Accounts routes (/api/accounts/*) ──────────────────────────────────
  if (url.pathname.includes("/accounts/")) {
    if (origin && !["https://www.ntagz.com", "https://ntagz.com"].includes(origin)) {
      return json({ error: "Origin not allowed" }, 403, origin);
    }
    return handleAccounts(url, request, env, allowedOrigin);
  }

  // ── Offline (UPI / bank / WhatsApp) orders: POST /api/orders/offline ──────────────────
  if (url.pathname.endsWith("/orders/offline")) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
    if (origin && !["https://www.ntagz.com", "https://ntagz.com"].includes(origin)) return json({ error: "Origin not allowed" }, 403, origin);
    let offlineBody;
    try {
      if (Number(request.headers.get("Content-Length")) > 10000) return json({ error: "Request too large" }, 413, origin);
      offlineBody = await request.json();
    } catch { return json({ error: "Invalid JSON" }, 400, origin); }
    try { return await recordOfflineOrder(request, env, offlineBody || {}, origin); }
    catch (e) { console.error("offline order failed:", e && e.message); return json({ error: "Could not record order" }, 500, origin); }
  }

  // ── Price quote: POST /api/quote {items, state, compare?} — the checkout engine's numbers, for display only ──
  // Prices for the caller (member prices only with a verified active membership). compare:true also returns guest and member
  // prices for the same cart (the membership calculator). Nothing is stored; checkout re-prices on its own.
  if (url.pathname.endsWith("/quote") && !url.pathname.includes("/accounts/")) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
    if (origin && !["https://www.ntagz.com", "https://ntagz.com"].includes(origin)) return json({ error: "Origin not allowed" }, 403, origin);
    if (quickLimited(request, "quote", 120, 60000)) return json({ error: TOO_MANY }, 429, origin); // the order page debounces; 2/s is generous
    let qb;
    try {
      if (Number(request.headers.get("Content-Length")) > 10000) return json({ error: "Request too large" }, 413, origin);
      qb = await request.json();
    } catch { return json({ error: "Invalid JSON" }, 400, origin); }
    try {
      const pricing = await loadPricing(env);
      const blocked = unavailableReason(qb && qb.items, pricing);
      if (blocked) return json({ error: blocked }, 409, origin);
      const state = typeof qb.state === "string" ? qb.state.slice(0, 50) : "";
      const pc = await pricedCheckout(env, request, qb, pricing);
      if (pc.error) return json({ error: pc.error, code: pc.code, points: null }, pc.status, origin);
      const you = pc.total, member = pc.member;
      const out = { you, signedInMember: !!pc.base, points: pc.points, rewards: await rewardsBlock(env, request, you, qb.items, pricing, member) };
      // Build-time promise for display only (dates are estimates from "now"; the order's date is frozen at payment). Never a rupee value.
      const dcfg = (await loadMemberSettings(env)).dispatch || DISPATCH.fromCfg({});
      const stdD = DISPATCH.promisedDispatch(Date.now(), dcfg.standardDays, dcfg);
      const memD = DISPATCH.promisedDispatch(Date.now(), dcfg.memberDays, dcfg);
      out.dispatch = { timezone: dcfg.timezone, standardDays: dcfg.standardDays, memberDays: dcfg.memberDays,
        standardDate: stdD.date, memberDate: memD.date };
      // Estimated delivery window from the Pune origin (calendar days; membership = express courier). Pincode only.
      const pin = String(qb.pincode || "");
      if (/^\d{6}$/.test(pin)) {
        out.dispatch.delivery = {
          standard: DELIVERY.deliveryRange(Date.parse(stdD.date + "T00:00:00Z"), pin, { priority: false }),
          member: DELIVERY.deliveryRange(Date.parse(memD.date + "T00:00:00Z"), pin, { priority: true }),
        };
      }
      if (qb.offer === true) out.membershipOffer = { ...(await membershipOffer(env, request, qb, pc.base, pricing)), added: !!pc.add };
      if (qb.compare === true && env.DB) {
        const settings = await loadMemberSettings(env);
        out.guest = calculateTotal(qb.items, state, null, pricing, await campaignsFor(request, env, null));
        out.member = settings.live ? calculateTotal(qb.items, state, { settings, paid: true }, pricing, await campaignsFor(request, env, { settings })) : null;
        out.feePaise = settings.feePaise;
      }
      return json(out, 200, origin);
    } catch (e) { console.error("quote failed:", e && e.message); return json({ error: "Quote unavailable" }, 503, origin); }
  }

  // ── Membership routes (/api/membership/*) ──────────────────────────────
  if (url.pathname.includes("/membership/")) {
    if (origin && !["https://www.ntagz.com", "https://ntagz.com"].includes(origin)) {
      return json({ error: "Origin not allowed" }, 403, origin);
    }
    return handleMembership(url, request, env, allowedOrigin);
  }
  // ── Rewards routes (/api/rewards/*) ────────────────────────────────────
  if (url.pathname.includes("/rewards/")) {
    if (origin && !["https://www.ntagz.com", "https://ntagz.com"].includes(origin)) return json({ error: "Origin not allowed" }, 403, origin);
    return handleRewards(url, request, env, allowedOrigin);
  }

  // ── Payment routes ─────────────────────────────────────────────────────
  const payuReturn = url.pathname.endsWith("/payu/success") || url.pathname.endsWith("/payu/failure");
  if (request.method !== "POST" && !(request.method === "GET" && (url.pathname.endsWith("/payu/verify-payment") || payuReturn))) return json({ error: "Method not allowed" }, 405, origin);
  const payuCallback = payuReturn || url.pathname.endsWith("/payu/verify-payment");
  // Browser-facing API calls must come from our own pages. PayU's return routes are the exception: PayU sends the customer back to them
  // from its own site (Origin: https://secure.payu.in), so an origin check would 403 every payment result. They are authenticated by PayU's
  // signed hash instead (verifyPayuResponse), and a success is re-confirmed with PayU's verify API before any order is recorded.
  if (!payuReturn && origin && !["https://www.ntagz.com", "https://ntagz.com"].includes(origin)) {
    return json({ error: "Origin not allowed" }, 403, origin);
  }
  if (!payuCallback && !url.pathname.endsWith("/payu/checkout") &&
      !url.pathname.endsWith("/create-order") && !url.pathname.endsWith("/verify-payment")) return json({ error: "Not found" }, 404, origin);
  if (!payuCallback && url.pathname.endsWith("/create-order") && (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET)) {
    return json({ error: "Razorpay is not configured" }, 503, origin);
  }
  if (!payuCallback && url.pathname.endsWith("/verify-payment") &&
      (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET)) return json({ error: "Razorpay is not configured" }, 503, origin);
  let body;
  try {
    if (Number(request.headers.get("Content-Length")) > 10000) return json({ error: "Request too large" }, 413, origin);
    if (payuCallback && request.method === "GET") body = Object.fromEntries(url.searchParams.entries());
    else if (payuCallback && request.headers.get("Content-Type")?.includes("application/x-www-form-urlencoded")) {
      body = Object.fromEntries(new URLSearchParams(await request.text()));
    }
    else body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, origin);
  }

  if (payuCallback) {
    try {
      if (!env.PAYU_KEY || !env.PAYU_SALT) return json({ error: "PayU is not configured" }, 503, origin);
      if (!await verifyPayuResponse(body, env.PAYU_SALT)) throw new Error("Invalid PayU payment signature");
      if (body.key !== env.PAYU_KEY) throw new Error("Invalid PayU payment response");
      if (body.status === "success" && !(await payuConfirmed(env, body))) throw new Error("PayU could not confirm this payment");
      const isSuccess = body.status === "success";
      const recorded = isSuccess ? await finalizeOrder(env, body.txnid, String(body.mihpayid || "").slice(0, 128), Math.round(parseFloat(body.amount) * 100), "payu") : null;
      const confirmParams = new URLSearchParams({
        status: isSuccess ? "success" : "failed",
        gateway: "payu",
        ...(recorded === "failed" && { recorded: "0" }),
        ...(body.txnid  && { txnid:  body.txnid }),
        ...(body.amount && { amount: body.amount }),
      });
      return Response.redirect(`https://www.ntagz.com/order/confirm.html?${confirmParams}`, 303);
    } catch (error) {
      const confirmParams = new URLSearchParams({ status: "failed", gateway: "payu" });
      return Response.redirect(`https://www.ntagz.com/order/confirm.html?${confirmParams}`, 303);
    }
  }

  try {
    if (url.pathname.endsWith("/create-order")) {
      if (await throttled(env, request, "checkout", 20, 600)) return json({ error: TOO_MANY }, 429, origin);
      const pricing = await loadPricing(env);
      const blocked = unavailableReason(body.items, pricing);
      if (blocked) return json({ error: blocked }, 409, origin);
      const pc = await pricedCheckout(env, request, body, pricing);
      if (pc.error) return json({ error: pc.error, code: pc.code }, pc.status, origin);
      const member = pc.member, total = pc.total;
      const order = await razorpayRequest("/orders", env, {
        amount: total.amount * 100,
        currency: "INR",
        receipt: `ntagz_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
        notes: {
          quote_ref: typeof body.quoteRef === "string" ? body.quoteRef.slice(0, 32) : "",
          pieces: String(total.pieces),
          membership: total.membershipFeePaise ? "1" : "0",
        },
      });
      await recordIntent(env, request, order.id, "razorpay", body, total);
      return json({ id: order.id, amount: order.amount, currency: order.currency, keyId: env.RAZORPAY_KEY_ID, memberPricing: !!member }, 200, origin);
    }

    if (url.pathname.endsWith("/verify-payment")) {
      const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = body;
      if (![orderId, paymentId, signature].every(value => typeof value === "string" && value.length <= 128)) {
        return json({ error: "Invalid payment response" }, 400, origin);
      }
      if (!await verifySignature(orderId, paymentId, signature, env.RAZORPAY_KEY_SECRET)) {
        return json({ error: "Invalid payment signature" }, 400, origin);
      }
      const recorded = await finalizeOrder(env, orderId, paymentId, null, "razorpay");
      return json({ status: "verified", paymentId, orderId, recorded: recorded !== "failed" }, 200, origin);
    }

    if (url.pathname.endsWith("/payu/checkout")) {
      if (!env.PAYU_KEY || !env.PAYU_SALT) return json({ error: "PayU is not configured" }, 503, origin);
      if (await throttled(env, request, "checkout", 20, 600)) return json({ error: TOO_MANY }, 429, origin);
      const pricing = await loadPricing(env);
      const blocked = unavailableReason(body.items, pricing);
      if (blocked) return json({ error: blocked }, 409, origin);
      const pc = await pricedCheckout(env, request, body, pricing);
      if (pc.error) return json({ error: pc.error, code: pc.code }, pc.status, origin);
      const total = pc.total;
      const firstName = typeof body.name === "string" ? body.name.trim().split(/\s+/)[0].slice(0, 60) : "";
      const phone = typeof body.phone === "string" ? body.phone.replace(/\D/g, "").slice(-10) : "";
      if (!firstName || /[|<>]/.test(firstName) || !/^\d{10}$/.test(phone)) {
        return json({ error: "Enter a valid name and 10-digit phone number for PayU" }, 400, origin);
      }
      // PayU needs an email on every transaction, but the customer is not asked for one. In order: an address the client sent, the signed-in
      // account's, else our own support address (PayU's receipt then reaches us; our order emails use the order's own email, never this fallback).
      const given = typeof body.email === "string" ? body.email.trim().slice(0, 254) : "";
      const account = await getSession(request, env);
      const validEmail = (e) => !!e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !/[|<>]/.test(e);
      const email = [given, account && account.email].find(validEmail) || env.PAYU_FALLBACK_EMAIL || "hello@ntagz.com";
      const fields = {
        key: env.PAYU_KEY,
        txnid: `ntagz${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
        amount: total.amount.toFixed(2),
        productinfo: `nTagz order ${(typeof body.quoteRef === "string" ? body.quoteRef : "").replace(/[^\w-]/g, "").slice(0, 20)}`,
        firstname: firstName,
        email,
        phone,
        // PayU returns the customer here. Use the real domain (routed to this Worker): the workers.dev address is not enabled for this Worker.
        surl: "https://ntagz.com/api/payu/success",
        furl: "https://ntagz.com/api/payu/failure",
        curl: "https://ntagz.com/api/payu/failure",
      };
      fields.hash = await payuHash(fields, env.PAYU_SALT);
      await recordIntent(env, request, fields.txnid, "payu", body, total);
      return json({ action: env.PAYU_ENV === "test" ? "https://test.payu.in/_payment" : "https://secure.payu.in/_payment", fields }, 200, origin);
    }

  if (url.pathname.endsWith("/payu/verify-payment") || url.pathname.endsWith("/payu/success") || url.pathname.endsWith("/payu/failure")) {
      if (!env.PAYU_SALT) return json({ error: "PayU is not configured" }, 503, origin);
      if (!await verifyPayuResponse(body, env.PAYU_SALT)) return json({ error: "Invalid PayU payment signature" }, 400, origin);
      const verificationHash = await sha512(`${env.PAYU_KEY}|verify_payment|${body.txnid}|${env.PAYU_SALT}`);
      const verification = await fetch(env.PAYU_ENV === "test"
        ? "https://test.payu.in/merchant/postservice.php?form=2"
        : "https://info.payu.in/merchant/postservice.php?form=2", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ key: env.PAYU_KEY, command: "verify_payment", var1: body.txnid, hash: verificationHash }),
      });
      if (!verification.ok) throw new Error("PayU payment verification failed");
      const result = await verification.json();
      const transaction = result.transaction_details?.[body.txnid];
      if (result.status !== 1 || transaction?.status !== "success" ||
          !safeEqual(String(transaction?.amount || ""), body.amount) || transaction?.txnid !== body.txnid) {
        return json({ error: "PayU could not confirm this payment" }, 402, origin);
      }
      if (transaction.status !== "success") return json({ error: "PayU reports this payment was not successful" }, 402, origin);
      return json({ status: "verified", paymentId: String(body.mihpayid || "").slice(0, 128), orderId: body.txnid }, 200, origin);
    }

    return json({ error: "Not found" }, 404, origin);
  } catch (error) {
    console.error("Payment request failed", error instanceof Error ? error.message : "unknown error");
    return json({ error: "Payment request failed" }, 502, origin);
  }
}

if (typeof module !== "undefined") module.exports = { onRequest, resetPricingCache, resetCrmCache: CRMPUBLIC.resetCrmCache, calculateTotal, PRODUCTS, verifySignature, payuHash, verifyPayuResponse };
