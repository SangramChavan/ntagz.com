const PRODUCTS = {
  "sample-kit":                   { price: 1940, fixed: true, allInclusive: false },
  "black-nfc-card":               { price: 30,  category: "nfc_consumables" },
  "white-nfc-card":               { price: 25,  category: "nfc_consumables" },
  "white-inkjet-nfc-card":        { price: 32.8,category: "nfc_consumables" },
  "google-review-nfc-card":       { price: 95,  category: "finished_products" },
  "google-review-nfc-stand-5x5":  { price: 99,  category: "finished_products", allInclusive: true },
  "google-review-nfc-stand-10x10":{ price: 149, category: "finished_products", allInclusive: true },
  "google-review-nfc-stand-12x12":{ price: 199, category: "finished_products", allInclusive: true },
  "nfc-card-custom-printing":     { price: 75,  category: "finished_products" },
  "anti-metal-tag":               { price: 20,  category: "nfc_consumables" },
  "ntag216-adhesive-tag":         { price: 18,  category: "nfc_consumables" },
  "nfc-coin":                     { price: 20,  category: "nfc_consumables" },
  "mini-nfc-tag":                 { price: 16,  category: "nfc_consumables" },
  "micro-flex-fpc":               { price: 75,  category: "nfc_consumables" },
  "nfc-wristband":                { price: 80,  category: "nfc_consumables" },
  "uhf-rfid-label":               { price: 249, category: "nfc_consumables", packSize: 10, moq: 1 },
  "rfid-card-custom-printing":    { price: 75,  category: "finished_products" },
};

const corsHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Credentials": "true",
  "Vary": "Origin",
};

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Access-Control-Allow-Origin": origin === "https://ntagz.com" ? origin : "https://www.ntagz.com", "Content-Type": "application/json" },
  });
}

// Live pricing from the admin's D1 catalogue. Cached 30s per isolate; any failure falls back to the table above.
let pricingCache = { db: null, at: 0, map: null };
async function loadPricing(env) {
  if (!env.DB) return null;
  const nowMs = Date.now();
  if (pricingCache.db === env.DB && nowMs - pricingCache.at < 30000) return pricingCache.map;
  try {
    const { results } = await env.DB.prepare("SELECT id,name,price_paise,active,track_stock,stock_qty,low_stock_threshold FROM products").all();
    const map = {};
    for (const r of results) map[r.id] = r;
    pricingCache = { db: env.DB, at: nowMs, map };
    return map;
  } catch (e) { console.error("loadPricing failed:", e && e.message); return null; }
}
const resetPricingCache = () => { pricingCache = { db: null, at: 0, map: null }; };

// Returns a customer-facing message if any item can't be sold right now, else null.
function unavailableReason(items, pricing) {
  if (!pricing || !Array.isArray(items)) return null;
  for (const item of items) {
    const row = pricing[item && item.id];
    if (!row) continue;
    const name = row.name || item.id;
    if (!row.active) return `${name} is currently unavailable`;
    if (row.track_stock && Number.isInteger(item.qty) && item.qty > row.stock_qty) return row.stock_qty > 0 ? `Only ${row.stock_qty} of ${name} available` : `${name} is out of stock`;
  }
  return null;
}

function calculateTotal(items, state, memberDiscounts, pricing) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) return null;
  let regular = 0;
  let inclusive = 0;
  let pieces = 0;

  for (const item of items) {
    const product = PRODUCTS[item?.id];
    const qty = item?.qty;
    if (!product || !Number.isSafeInteger(qty) || qty < (product.fixed ? 1 : product.moq || 10) || qty > 100000) return null;
    if (product.fixed && qty !== 1) return null;
    const linePieces = qty * (product.packSize || 1);
    const discount = product.fixed ? 0 : linePieces >= 5000 ? 25 : linePieces >= 1000 ? 15 : linePieces >= 500 ? 10 : 0;
    const memberDisc = memberDiscounts && product.category ? (memberDiscounts[product.category] || 0) : 0;
    const livePrice = pricing && pricing[item.id] ? pricing[item.id].price_paise / 100 : product.price;
    const net = livePrice * qty * (100 - discount) / 100 * (100 - memberDisc) / 100;
    if (product.allInclusive) inclusive += net;
    else regular += net;
    pieces += product.fixed ? 70 : linePieces;
  }

  const taxable = regular + inclusive;
  const shipping = state
    ? inclusive > 0 || taxable >= 2000 ? 0 : state === "Maharashtra" ? 40 : 80
    : 0;
  const amount = Math.round(regular + Math.round(regular * 0.18) + inclusive + shipping);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10000000) return null;
  return { amount, pieces, gst: Math.round(regular * 0.18) };
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
  if (!env.RESEND_API_KEY) return; // dev: skip email, log to console
  console.log(`OTP for ${email}: ${otp}`);
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
  const headers = { ...corsHeaders, "Access-Control-Allow-Origin": allowedOrigin, "Content-Type": "application/json" };
  if (cookieHeader) headers["Set-Cookie"] = cookieHeader;
  return new Response(JSON.stringify(data), { status, headers });
}

async function getMemberDiscounts(request, env) {
  if (!env.DB) return null;
  const u = await getSession(request, env);
  if (!u) return null;
  const mem = await env.DB.prepare(
    `SELECT id FROM memberships WHERE user_id=? AND status='active' AND expires_at>unixepoch() LIMIT 1`
  ).bind(u.user_id).first();
  if (!mem) return null;
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM membership_config WHERE key IN ('discounts_live','discount_nfc_consumables_pct','discount_finished_products_pct')`
  ).all();
  const cfg = Object.fromEntries(results.map(r => [r.key, r.value]));
  if (cfg.discounts_live !== "1") return null;
  return {
    nfc_consumables:   parseFloat(cfg.discount_nfc_consumables_pct)   || 0,
    finished_products: parseFloat(cfg.discount_finished_products_pct) || 0,
  };
}

// ── Membership handler ────────────────────────────────────────────────────────

async function handleMembership(url, request, env, allowedOrigin) {
  if (!env.DB) return new Response(JSON.stringify({ error: "Database not configured" }), { status: 503, headers: { "Content-Type": "application/json" } });
  const path = url.pathname;
  const method = request.method;

  // GET /api/membership/status
  if (method === "GET" && path.endsWith("/membership/status")) {
    const u = await getSession(request, env);
    if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
    const mem = await env.DB.prepare(
      `SELECT * FROM memberships WHERE user_id=? AND status='active' AND expires_at > unixepoch() ORDER BY expires_at DESC LIMIT 1`
    ).bind(u.user_id).first();
    return jsonAuth({ membership: mem ? {
      active: true,
      expiresAt: mem.expires_at,
      welcomeCreditPaise: mem.welcome_credit_paise,
      welcomeCreditUsed: !!mem.welcome_credit_used,
      pricePaid: mem.price_paid,
      purchasedAt: mem.purchased_at,
    } : { active: false } }, 200, allowedOrigin);
  }

  // POST /api/membership/create-order
  if (method === "POST" && path.endsWith("/membership/create-order")) {
    const u = await getSession(request, env);
    if (!u) return jsonAuth({ error: "Not authenticated" }, 401, allowedOrigin);
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return jsonAuth({ error: "Payment not configured" }, 503, allowedOrigin);
    const existing = await env.DB.prepare(
      `SELECT id FROM memberships WHERE user_id=? AND status='active' AND expires_at > unixepoch() LIMIT 1`
    ).bind(u.user_id).first();
    if (existing) return jsonAuth({ error: "You already have an active Trade Pass" }, 409, allowedOrigin);
    const feePaise = 99900;
    const rpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ amount: feePaise, currency: "INR", receipt: `tp-${u.user_id.slice(0, 8)}` }),
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
    const already = await env.DB.prepare(`SELECT id FROM memberships WHERE razorpay_order_id=?`).bind(razorpay_order_id).first();
    if (already) return jsonAuth({ ok: true, membershipId: already.id }, 200, allowedOrigin);
    const memId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO memberships (id, user_id, status, purchased_at, expires_at, welcome_credit_paise, price_paid, payment_id, razorpay_order_id)
       VALUES (?, ?, 'active', ?, ?, 50000, 99900, ?, ?)`
    ).bind(memId, u.user_id, now, now + 365 * 86400, razorpay_payment_id, razorpay_order_id).run();
    return jsonAuth({ ok: true, membershipId: memId, expiresAt: now + 365 * 86400 }, 200, allowedOrigin);
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
    await env.DB.prepare("DELETE FROM otp_tokens WHERE email = ?").bind(email).run();
    await env.DB.prepare("INSERT INTO otp_tokens (id, email, otp, expires_at) VALUES (?, ?, ?, ?)").bind(id, email, otp, expires).run();
    await sendOtp(email, otp, env);
    return jsonAuth({ sent: true }, 200, allowedOrigin);
  }

  // POST /api/accounts/auth/verify-otp
  if (method === "POST" && path.endsWith("/auth/verify-otp")) {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
    const otp   = typeof body.otp   === "string" ? body.otp.trim().slice(0, 6) : "";
    if (!email || !/^\d{6}$/.test(otp)) return jsonAuth({ error: "Invalid request" }, 400, allowedOrigin);
    const token = await env.DB.prepare(
      "SELECT id FROM otp_tokens WHERE email=? AND otp=? AND expires_at>unixepoch() AND used=0"
    ).bind(email, otp).first();
    if (!token) return jsonAuth({ error: "Invalid or expired code" }, 401, allowedOrigin);
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
    return jsonAuth({ user: { email: u.email, name: u.name, phone: u.phone, gstin: u.gstin, loyaltySpend: u.loyalty_spend, loyaltyTier: u.loyalty_tier } }, 200, allowedOrigin);
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
  for (const it of items) {
    if (!it || typeof it.id !== "string" || !Number.isInteger(it.qty) || it.qty < 1) continue;
    out.push(
      env.DB.prepare(
        `INSERT INTO inventory_movements (id,product_id,type,qty_change,prev_stock,new_stock,reason,reference,admin,idempotency_key)
         SELECT ?1,id,'out',-min(stock_qty,?2),stock_qty,max(stock_qty-?2,0),'Order sale',?3,'system',?4
         FROM products WHERE id=?5 AND track_stock=1 AND stock_qty>0 AND EXISTS (SELECT 1 FROM orders WHERE id=?4)`
      ).bind(crypto.randomUUID(), it.qty, txnId, orderId, it.id),
      env.DB.prepare(
        `UPDATE products SET stock_qty=max(stock_qty-?1,0), updated_at=unixepoch()
         WHERE id=?2 AND track_stock=1 AND EXISTS (SELECT 1 FROM orders WHERE id=?3)`
      ).bind(it.qty, it.id, orderId),
    );
  }
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

async function recordIntent(env, request, txnId, gateway, body, total) {
  if (!env.DB || !txnId) return;
  try {
    const u = await getSession(request, env);
    const d = cleanDetails(body);
    const items = (Array.isArray(body.items) ? body.items : []).map((i) => ({ id: String(i.id).slice(0, 64), qty: i.qty }));
    const amountPaise = total.amount * 100, gstPaise = total.gst * 100;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM checkout_intents WHERE created_at < unixepoch() - 604800"),
      env.DB.prepare(
        `INSERT OR REPLACE INTO checkout_intents (txn_id,gateway,user_id,items_json,name,phone,email,address,pincode,state,gstin,quote_ref,subtotal_paise,gst_paise,amount_paise)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(txnId, gateway, u ? u.user_id : null, JSON.stringify(items), d.name, d.phone, d.email, d.address, d.pincode, d.state, d.gstin, d.quoteRef,
             amountPaise - gstPaise, gstPaise, amountPaise),
    ]);
  } catch (e) { console.error("recordIntent failed:", e && e.message); }
}

async function finalizeOrder(env, txnId, paymentRef, verifiedPaise) {
  if (!env.DB || !txnId) return;
  try {
    const intent = await env.DB.prepare("SELECT * FROM checkout_intents WHERE txn_id=?").bind(txnId).first();
    if (!intent) return; // unknown, or already finalised
    if (verifiedPaise !== null && verifiedPaise !== intent.amount_paise) {
      console.error("finalizeOrder: verified amount does not match intent", txnId);
      return;
    }
    const oid = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO orders (id,user_id,txn_id,gateway,quote_ref,items_json,name,phone,email,address,pincode,state,gstin,subtotal,gst,total,payment_method,payment_status,paid_paise)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'paid', ?)`
      ).bind(oid, intent.user_id, txnId, intent.gateway, intent.quote_ref, intent.items_json, intent.name, intent.phone, intent.email,
             intent.address, intent.pincode, intent.state, intent.gstin, intent.subtotal_paise, intent.gst_paise, intent.amount_paise,
             intent.gateway, intent.amount_paise),
      env.DB.prepare(
        `INSERT INTO payments (id,order_id,method,amount_paise,recorded_by,idempotency_key,reference)
         SELECT ?,id,?,?,'gateway',?,? FROM orders WHERE id=? AND changes()=1`
      ).bind(crypto.randomUUID(), intent.gateway, intent.amount_paise, String(paymentRef || txnId).slice(0, 64), String(paymentRef || "").slice(0, 128) || null, oid),
      env.DB.prepare(
        "UPDATE users SET loyalty_spend=loyalty_spend+?1, loyalty_tier=CASE WHEN loyalty_spend+?1>=1000000 THEN 'pro' ELSE loyalty_tier END WHERE id=?2 AND changes()=1"
      ).bind(intent.amount_paise, intent.user_id),
      env.DB.prepare("DELETE FROM checkout_intents WHERE txn_id=?").bind(txnId),
      ...stockStatements(env, oid, txnId, JSON.parse(intent.items_json || "[]")),
    ]);
  } catch (e) { console.error("finalizeOrder failed:", e && e.message); }
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
  const memberDiscounts = await getMemberDiscounts(request, env);
  const pricing = await loadPricing(env);
  const blocked = unavailableReason(body.items, pricing);
  if (blocked) return json({ error: blocked }, 409, origin);
  const total = calculateTotal(body.items, d.state, memberDiscounts, pricing);
  if (!total) return json({ error: "Invalid order" }, 400, origin);
  const ipHash = await sha256Hex(`ntagz:${request.headers.get("CF-Connecting-IP") || "unknown"}`);
  const recent = await env.DB.prepare("SELECT count(*) c FROM order_attempts WHERE ip_hash=? AND created_at>unixepoch()-600").bind(ipHash).first();
  if (recent.c >= 5) return json({ error: "Too many orders from this connection. Please try again later or contact us on WhatsApp." }, 429, origin);
  const u = await getSession(request, env);
  const txnId = `OFF-${d.quoteRef}-${d.phone}`; // the same quote re-submitted (e.g. a repeated WhatsApp tap) maps to the same order
  const items = body.items.map((i) => ({ id: String(i.id).slice(0, 64), qty: i.qty }));
  const amountPaise = total.amount * 100, gstPaise = total.gst * 100;
  const orderIdOffline = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM order_attempts WHERE created_at < unixepoch() - 86400"),
    env.DB.prepare("INSERT INTO order_attempts (ip_hash) VALUES (?)").bind(ipHash),
    env.DB.prepare(
      `INSERT OR IGNORE INTO orders (id,user_id,txn_id,gateway,quote_ref,items_json,name,phone,email,address,pincode,state,gstin,subtotal,gst,total,payment_method,payment_status,paid_paise)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'unpaid', 0)`
    ).bind(orderIdOffline, u ? u.user_id : null, txnId, method, d.quoteRef, JSON.stringify(items), d.name, d.phone, d.email, d.address, d.pincode,
           d.state, d.gstin, amountPaise - gstPaise, gstPaise, amountPaise, method),
    ...stockStatements(env, orderIdOffline, txnId, items),
  ]);
  return json({ ok: true, orderRef: txnId, total: total.amount }, 200, origin);
}

const STATUS_LABELS = { placed: "Order placed", confirmed: "Confirmed", processing: "Processing", packed: "Packed", shipped: "Shipped", out_for_delivery: "Out for delivery", delivered: "Delivered", on_hold: "On hold", cancelled: "Cancelled", delivery_failed: "Delivery failed", returned: "Returned" };

// Whitelisted customer view of an order. Unknown order and wrong token are indistinguishable (same 404).
async function trackOrder(url, env, origin) {
  const notFound = () => json({ error: "Not found" }, 404, origin);
  const o = url.searchParams.get("o") || "", t = url.searchParams.get("t") || "";
  if (!/^[0-9a-fA-F-]{8,64}$/.test(o) || !/^[0-9a-f]{32}$/.test(t)) return notFound();
  if (!env.DB) return json({ error: "Tracking unavailable" }, 503, origin);
  try {
    const ord = await env.DB.prepare("SELECT id, status, payment_status, total, items_json, state, pincode, created_at, is_preorder, track_token FROM orders WHERE id = ?").bind(o).first();
    if (!ord || !safeEqual(String(ord.track_token || ""), t)) return notFound();
    const [pays, evs, ships, prods] = await Promise.all([
      env.DB.prepare("SELECT created_at FROM payments WHERE order_id = ?").bind(ord.id).all(),
      env.DB.prepare("SELECT kind, status, public_note, created_at FROM order_events WHERE order_id = ? AND customer_visible = 1 AND kind IN ('status','shipment')").bind(ord.id).all(),
      env.DB.prepare("SELECT courier, awb, tracking_url, shipped_on, est_delivery FROM shipments WHERE order_id = ? ORDER BY created_at").bind(ord.id).all(),
      env.DB.prepare("SELECT id, name FROM products").all(),
    ]);
    const names = Object.fromEntries((prods.results || []).map((p) => [p.id, p.name]));
    let raw = []; try { raw = JSON.parse(ord.items_json || "[]"); } catch {}
    const items = (Array.isArray(raw) ? raw : []).map((i) => ({ name: names[i.id] || String(i.id), qty: Number(i.qty) || 0 }));
    const journey = [
      { kind: "placed", label: "Order placed", at: ord.created_at, note: null },
      ...(pays.results || []).map((p) => ({ kind: "payment", label: "Payment received", at: p.created_at, note: null })),
      ...(evs.results || []).map((e) => ({ kind: e.kind, status: e.status, label: STATUS_LABELS[e.status] || e.status || "Update", at: e.created_at, note: e.public_note || null })),
    ].sort((a, b) => a.at - b.at);
    return json({
      ref: ord.id.slice(0, 8), placed_at: ord.created_at, status: ord.status, status_label: STATUS_LABELS[ord.status] || ord.status,
      payment_status: ord.payment_status, is_preorder: !!ord.is_preorder, items, total_paise: ord.total,
      ship_to: { state: ord.state, pincode: ord.pincode }, shipments: ships.results || [], journey,
    }, 200, origin);
  } catch { return json({ error: "Tracking unavailable" }, 503, origin); }
}

async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const allowedOrigin = origin === "https://ntagz.com" ? origin : "https://www.ntagz.com";
  const responseHeaders = { ...corsHeaders, "Access-Control-Allow-Origin": allowedOrigin };
  if (request.method === "OPTIONS") return new Response(null, { headers: responseHeaders });

  // ── Public live catalogue: GET /api/catalog (price + availability only; no exact stock counts) ──
  if (url.pathname.endsWith("/catalog") && !url.pathname.includes("/accounts/")) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, origin);
    const pricing = await loadPricing(env);
    if (!pricing) return json({ error: "Catalogue unavailable" }, 503, origin);
    const items = Object.values(pricing).map((r) => ({
      id: r.id, price: r.price_paise / 100, active: !!r.active,
      available: !r.track_stock || r.stock_qty > 0, low: !!r.track_stock && r.stock_qty > 0 && r.stock_qty <= r.low_stock_threshold,
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

  // ── Membership routes (/api/membership/*) ──────────────────────────────
  if (url.pathname.includes("/membership/")) {
    if (origin && !["https://www.ntagz.com", "https://ntagz.com"].includes(origin)) {
      return json({ error: "Origin not allowed" }, 403, origin);
    }
    return handleMembership(url, request, env, allowedOrigin);
  }

  // ── Payment routes ─────────────────────────────────────────────────────
  const payuReturn = url.pathname.endsWith("/payu/success") || url.pathname.endsWith("/payu/failure");
  if (request.method !== "POST" && !(request.method === "GET" && (url.pathname.endsWith("/payu/verify-payment") || payuReturn))) return json({ error: "Method not allowed" }, 405, origin);
  const payuCallback = payuReturn || url.pathname.endsWith("/payu/verify-payment");
  if (origin && !["https://www.ntagz.com", "https://ntagz.com"].includes(origin)) {
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
      let transaction;
      if (body.status === "success") {
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
        transaction = result.transaction_details?.[body.txnid];
        if (result.status !== 1 || transaction?.status !== "success" ||
            !safeEqual(String(transaction?.amount || ""), body.amount) || transaction?.txnid !== body.txnid) {
          throw new Error("PayU could not confirm this payment");
        }
      } else {
        transaction = { status: body.status };
      }
      const isSuccess = body.status === "success";
      if (isSuccess) await finalizeOrder(env, body.txnid, String(body.mihpayid || "").slice(0, 128), Math.round(parseFloat(body.amount) * 100));
      const confirmParams = new URLSearchParams({
        status: isSuccess ? "success" : "failed",
        gateway: "payu",
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
      const memberDiscounts = await getMemberDiscounts(request, env);
      const pricing = await loadPricing(env);
      const blocked = unavailableReason(body.items, pricing);
      if (blocked) return json({ error: blocked }, 409, origin);
      const total = calculateTotal(body.items, body.state, memberDiscounts, pricing);
      if (!total) return json({ error: "Invalid order" }, 400, origin);
      const order = await razorpayRequest("/orders", env, {
        amount: total.amount * 100,
        currency: "INR",
        receipt: `ntagz_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
        notes: {
          quote_ref: typeof body.quoteRef === "string" ? body.quoteRef.slice(0, 32) : "",
          pieces: String(total.pieces),
        },
      });
      await recordIntent(env, request, order.id, "razorpay", body, total);
      return json({ id: order.id, amount: order.amount, currency: order.currency, keyId: env.RAZORPAY_KEY_ID, memberPricing: !!memberDiscounts }, 200, origin);
    }

    if (url.pathname.endsWith("/verify-payment")) {
      const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = body;
      if (![orderId, paymentId, signature].every(value => typeof value === "string" && value.length <= 128)) {
        return json({ error: "Invalid payment response" }, 400, origin);
      }
      if (!await verifySignature(orderId, paymentId, signature, env.RAZORPAY_KEY_SECRET)) {
        return json({ error: "Invalid payment signature" }, 400, origin);
      }
      await finalizeOrder(env, orderId, paymentId, null);
      return json({ status: "verified", paymentId, orderId }, 200, origin);
    }

    if (url.pathname.endsWith("/payu/checkout")) {
      if (!env.PAYU_KEY || !env.PAYU_SALT) return json({ error: "PayU is not configured" }, 503, origin);
      const memberDiscounts = await getMemberDiscounts(request, env);
      const pricing = await loadPricing(env);
      const blocked = unavailableReason(body.items, pricing);
      if (blocked) return json({ error: blocked }, 409, origin);
      const total = calculateTotal(body.items, body.state, memberDiscounts, pricing);
      if (!total) return json({ error: "Invalid order" }, 400, origin);
      const firstName = typeof body.name === "string" ? body.name.trim().split(/\s+/)[0].slice(0, 60) : "";
      const email = typeof body.email === "string" ? body.email.trim().slice(0, 254) : "";
      const phone = typeof body.phone === "string" ? body.phone.replace(/\D/g, "").slice(-10) : "";
      if (!firstName || /[|<>]/.test(firstName) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[|<>]/.test(email) || !/^\d{10}$/.test(phone)) {
        return json({ error: "Enter a valid name, email, and 10-digit phone number for PayU" }, 400, origin);
      }
      const fields = {
        key: env.PAYU_KEY,
        txnid: `ntagz${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
        amount: total.amount.toFixed(2),
        productinfo: `nTagz order ${(typeof body.quoteRef === "string" ? body.quoteRef : "").replace(/[^\w-]/g, "").slice(0, 20)}`,
        firstname: firstName,
        email,
        phone,
        surl: "https://ntagz-payments.ambivert.workers.dev/api/payu/success",
        furl: "https://ntagz-payments.ambivert.workers.dev/api/payu/failure",
        curl: "https://ntagz-payments.ambivert.workers.dev/api/payu/failure",
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

if (typeof module !== "undefined") module.exports = { onRequest, resetPricingCache, calculateTotal, verifySignature, payuHash, verifyPayuResponse };
