// NTAGZ admin Worker: auth, order management API, and gated static admin UI.
// Every /api/* route except auth/request + auth/verify requires a valid session, re-checked against the
// admin allowlist on each request. All SQL is parameterised. No CORS headers: same-origin only.

const SESSION_TTL = 12 * 3600;
const OTP_TTL = 600;
const COOKIE = "ntagz_admin";
const FULFILMENT = ["confirmed", "packed", "shipped", "delivered", "cancelled"];
const SORTS = { created_at: "created_at", total: "total", name: "name" };
const PAGE_SIZE = 25;
const IST_OFFSET = 19800;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const now = () => Math.floor(Date.now() / 1000);

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SEC_HEADERS, ...extra },
  });
}
const fail = (status, error) => json({ error }, status);

function cookieOf(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : "";
}

function allowlist(env) {
  return (env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

async function session(request, env) {
  const token = cookieOf(request, COOKIE);
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare("SELECT email FROM admin_sessions WHERE token_hash=? AND expires_at>?")
    .bind(await sha256(token), now()).first();
  // Authorisation is checked on every request: removing an email from the allowlist revokes access at once.
  return row && allowlist(env).includes(row.email) ? row.email : null;
}

async function sendOtp(email, otp, env) {
  if (env.DEV_OTP_ECHO === "1") return otp; // local testing only; never set in production
  if (!env.RESEND_API_KEY) return null;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "ntagz admin <hello@ntagz.com>",
      to: [email],
      subject: "Your ntagz admin sign-in code",
      html: `<p style="font-family:sans-serif">Your admin sign-in code is <strong style="font-size:28px;letter-spacing:6px">${otp}</strong>. It expires in 10 minutes.</p>`,
    }),
  }).catch(() => null);
  if (!res || !res.ok) console.error("admin otp email failed", res && res.status);
  return null;
}

// ── Auth ──────────────────────────────────────────────────────────────
async function authRequest(body, env) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
  const reply = { sent: true }; // identical response whether or not the email is allowed
  if (!allowlist(env).includes(email)) return json(reply);
  const recent = await env.DB.prepare("SELECT count(*) c FROM admin_otps WHERE email=? AND created_at>?")
    .bind(email, now() - 900).first();
  if (recent.c >= 3) return fail(429, "Too many requests. Try again in a few minutes.");
  const otp = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  await env.DB.prepare("DELETE FROM admin_otps WHERE expires_at<?").bind(now()).run();
  await env.DB.prepare("INSERT INTO admin_otps (id,email,otp_hash,expires_at) VALUES (?,?,?,?)")
    .bind(crypto.randomUUID(), email, await sha256(`${email}:${otp}`), now() + OTP_TTL).run();
  const echoed = await sendOtp(email, otp, env);
  return json(echoed ? { ...reply, dev_otp: echoed } : reply);
}

async function authVerify(body, env) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
  const otp = typeof body.otp === "string" ? body.otp.trim() : "";
  if (!/^\d{6}$/.test(otp) || !allowlist(env).includes(email)) return fail(401, "Invalid or expired code");
  const row = await env.DB.prepare(
    "SELECT id, otp_hash, attempts FROM admin_otps WHERE email=? AND expires_at>? ORDER BY created_at DESC LIMIT 1"
  ).bind(email, now()).first();
  if (!row || row.attempts >= 5) return fail(401, "Invalid or expired code");
  await env.DB.prepare("UPDATE admin_otps SET attempts=attempts+1 WHERE id=?").bind(row.id).run();
  if (!safeEqual(row.otp_hash, await sha256(`${email}:${otp}`))) return fail(401, "Invalid or expired code");
  await env.DB.prepare("DELETE FROM admin_otps WHERE email=?").bind(email).run(); // single use
  const token = randomHex(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at<?").bind(now()),
    env.DB.prepare("INSERT INTO admin_sessions (token_hash,email,expires_at) VALUES (?,?,?)")
      .bind(await sha256(token), email, now() + SESSION_TTL),
    env.DB.prepare("INSERT INTO audit_log (id,actor,action) VALUES (?,?,'login')").bind(crypto.randomUUID(), email),
  ]);
  return json({ ok: true, email }, 200, {
    "Set-Cookie": `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL}`,
  });
}

// ── Orders ────────────────────────────────────────────────────────────
const COLS = "id,txn_id,quote_ref,name,phone,email,address,pincode,state,gstin,items_json,subtotal,gst,total," +
  "payment_method,payment_status,paid_paise,status,tracking_id,courier,created_at,updated_at";

function parseItems(json_) {
  try { const a = JSON.parse(json_); return Array.isArray(a) ? a : []; } catch { return []; }
}
const shape = (o) => ({ ...o, items: parseItems(o.items_json), items_json: undefined, outstanding_paise: Math.max(0, o.total - o.paid_paise) });

function dayStart(s, endOfDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.floor(t / 1000) - IST_OFFSET + (endOfDay ? 86400 : 0);
}

function filters(sp) {
  const where = [], bind = [];
  const q = (sp.get("q") || "").trim().slice(0, 100);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push("(id LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\' OR phone LIKE ?1 ESCAPE '\\' OR email LIKE ?1 ESCAPE '\\' OR txn_id LIKE ?1 ESCAPE '\\' OR quote_ref LIKE ?1 ESCAPE '\\')");
    bind.push(like);
  }
  const eq = (param, col, allowed) => {
    const v = sp.get(param);
    if (v && allowed.includes(v)) { bind.push(v); where.push(`${col}=?${bind.length}`); }
  };
  eq("payment_status", "payment_status", ["unpaid", "paid"]);
  eq("payment_method", "payment_method", ["razorpay", "payu", "cash", "cod", "upi", "bank"]);
  eq("fulfilment", "status", FULFILMENT);
  const from = dayStart(sp.get("from"), false), to = dayStart(sp.get("to"), true);
  if (from !== null) { bind.push(from); where.push(`created_at>=?${bind.length}`); }
  if (to !== null) { bind.push(to); where.push(`created_at<?${bind.length}`); }
  return { sql: where.length ? "WHERE " + where.join(" AND ") : "", bind };
}

async function listOrders(sp, env) {
  const { sql, bind } = filters(sp);
  const page = Math.max(1, parseInt(sp.get("page"), 10) || 1);
  const col = SORTS[sp.get("sort")] || "created_at";
  const dir = sp.get("dir") === "asc" ? "ASC" : "DESC";
  const total = (await env.DB.prepare(`SELECT count(*) c FROM orders ${sql}`).bind(...bind).first()).c;
  const { results } = await env.DB.prepare(
    `SELECT ${COLS} FROM orders ${sql} ORDER BY ${col} ${dir}, id LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`
  ).bind(...bind).all();
  return json({ orders: results.map(shape), page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total });
}

async function getOrder(id, env) {
  const o = await env.DB.prepare(`SELECT ${COLS} FROM orders WHERE id=?`).bind(id).first();
  if (!o) return null;
  const pays = await env.DB.prepare("SELECT method,amount_paise,recorded_by,created_at FROM payments WHERE order_id=? ORDER BY created_at")
    .bind(id).all();
  return { ...shape(o), payments: pays.results };
}

async function cashReceived(id, body, actor, env) {
  const confirmed = Number(body.confirm_amount_paise);
  const key = typeof body.idempotency_key === "string" ? body.idempotency_key.slice(0, 64) : "";
  if (!Number.isInteger(confirmed) || confirmed <= 0 || !key) return fail(400, "Missing confirmation");
  const o = await env.DB.prepare("SELECT total,paid_paise,status,payment_method,payment_status FROM orders WHERE id=?").bind(id).first();
  if (!o) return fail(404, "Order not found");
  const method = (o.payment_method || "").toLowerCase();
  if (!["cash", "cod"].includes(method)) return fail(409, "Only cash or cash-on-delivery orders can be marked received here");
  if (o.status === "cancelled") return fail(409, "Order is cancelled");
  if (o.payment_status === "paid") return fail(409, "Order is already fully paid");
  if (method === "cod" && o.status !== "delivered") return fail(409, "Cash on delivery can only be recorded after delivery");
  const outstanding = o.total - o.paid_paise;
  if (outstanding <= 0 || outstanding !== confirmed) return fail(409, "Outstanding amount has changed. Refresh and confirm again.");

  const pid = crypto.randomUUID();
  // One atomic batch; every statement is guarded by the same trusted-row conditions, so a concurrent or
  // repeated confirmation inserts nothing (and the unique cash index backs this up at the schema level).
  const guard = `FROM orders WHERE id=?1 AND payment_status='unpaid' AND paid_paise=?2 AND total-paid_paise=?3
                   AND status<>'cancelled' AND lower(payment_method) IN ('cash','cod')
                   AND (lower(payment_method)<>'cod' OR status='delivered')`;
  const res = await env.DB.batch([
    env.DB.prepare(`INSERT INTO payments (id,order_id,method,amount_paise,recorded_by,idempotency_key)
                    SELECT ?4, id, lower(payment_method), total-paid_paise, ?5, ?6 ${guard}`)
      .bind(id, o.paid_paise, confirmed, pid, actor, key),
    env.DB.prepare(`UPDATE orders SET paid_paise=total, payment_status='paid', updated_at=unixepoch()
                    WHERE id=?1 AND payment_status='unpaid' AND paid_paise=?2 AND EXISTS (SELECT 1 FROM payments WHERE id=?3)`)
      .bind(id, o.paid_paise, pid),
    env.DB.prepare(`INSERT INTO audit_log (id,actor,action,order_id,detail)
                    SELECT ?1,?2,'cash_received',?3,?4 WHERE EXISTS (SELECT 1 FROM payments WHERE id=?5)`)
      .bind(crypto.randomUUID(), actor, id, JSON.stringify({ amount_paise: confirmed }), pid),
  ]).catch(() => null);
  if (!res || res[0].meta.changes !== 1) return fail(409, "Payment was not recorded. It may already have been confirmed.");
  return json(await getOrder(id, env));
}

async function setFulfilment(id, body, actor, env) {
  const status = body.status;
  if (!FULFILMENT.includes(status)) return fail(400, "Invalid status");
  const tracking = typeof body.tracking_id === "string" ? body.tracking_id.trim().slice(0, 64) : null;
  const courier = typeof body.courier === "string" ? body.courier.trim().slice(0, 64) : null;
  const o = await env.DB.prepare("SELECT status FROM orders WHERE id=?").bind(id).first();
  if (!o) return fail(404, "Order not found");
  if (o.status === "cancelled" && status !== "cancelled") return fail(409, "Cancelled orders cannot be reopened");
  await env.DB.batch([
    env.DB.prepare("UPDATE orders SET status=?, tracking_id=COALESCE(?,tracking_id), courier=COALESCE(?,courier), updated_at=unixepoch() WHERE id=?")
      .bind(status, tracking || null, courier || null, id),
    env.DB.prepare("INSERT INTO audit_log (id,actor,action,order_id,detail) VALUES (?,?,?,?,?)")
      .bind(crypto.randomUUID(), actor, "fulfilment", id, JSON.stringify({ from: o.status, to: status })),
  ]);
  return json(await getOrder(id, env));
}

const csvCell = (v) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function exportCsv(sp, env) {
  const { sql, bind } = filters(sp);
  const { results } = await env.DB.prepare(`SELECT ${COLS} FROM orders ${sql} ORDER BY created_at DESC LIMIT 5000`).bind(...bind).all();
  const head = ["order_id", "created", "name", "phone", "email", "address", "pincode", "state", "total_inr", "payment_method", "payment_status", "paid_inr", "fulfilment", "tracking_id", "courier"];
  const lines = [head.join(",")].concat(results.map((o) => [
    o.id, new Date(o.created_at * 1000).toISOString(), o.name, o.phone, o.email, o.address, o.pincode, o.state,
    (o.total / 100).toFixed(2), o.payment_method, o.payment_status, (o.paid_paise / 100).toFixed(2), o.status, o.tracking_id, o.courier,
  ].map(csvCell).join(",")));
  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="ntagz-orders.csv"', "Cache-Control": "no-store", ...SEC_HEADERS },
  });
}

// ── Router ────────────────────────────────────────────────────────────
const PUBLIC_ASSETS = { "/style.css": "/style.css", "/login.js": "/login.js" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (!path.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") return fail(405, "Method not allowed");
      let asset = PUBLIC_ASSETS[path];
      if (!asset) {
        const user = await session(request, env);
        if (path === "/") asset = user ? "/app.html" : "/login.html";
        else if (path === "/app.js" && user) asset = "/app.js";
        else return new Response("Not found", { status: 404, headers: SEC_HEADERS });
      }
      const res = await env.ASSETS.fetch(new Request(new URL(asset, url), { method: "GET" }));
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(SEC_HEADERS)) out.headers.set(k, v);
      out.headers.set("Cache-Control", "no-store");
      return out;
    }

    // State-changing requests must come from our own page (custom header forces a CORS preflight,
    // Origin is checked when present, and the cookie is SameSite=Strict).
    if (method !== "GET") {
      const origin = request.headers.get("Origin");
      if (request.headers.get("X-Requested-With") !== "ntagz-admin" || (origin && origin !== url.origin)) return fail(403, "Forbidden");
    }

    let body = {};
    if (method === "POST") {
      try { body = (request.headers.get("Content-Type") || "").includes("json") ? await request.json() : {}; } catch { return fail(400, "Invalid JSON"); }
      if (!body || typeof body !== "object") return fail(400, "Invalid JSON");
    }

    try {
      if (method === "POST" && path === "/api/auth/request") return await authRequest(body, env);
      if (method === "POST" && path === "/api/auth/verify") return await authVerify(body, env);

      const actor = await session(request, env);
      if (!actor) return fail(401, "Not signed in");

      if (method === "POST" && path === "/api/auth/logout") {
        await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(await sha256(cookieOf(request, COOKIE))).run();
        return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (method === "GET" && path === "/api/me") return json({ email: actor });
      if (method === "GET" && path === "/api/orders") return await listOrders(url.searchParams, env);
      if (method === "GET" && path === "/api/orders.csv") return await exportCsv(url.searchParams, env);

      const m = path.match(/^\/api\/orders\/([0-9a-fA-F-]{8,64})(\/cash-received|\/fulfilment)?$/);
      if (m) {
        const id = m[1];
        if (!m[2] && method === "GET") {
          const o = await getOrder(id, env);
          return o ? json(o) : fail(404, "Order not found");
        }
        if (m[2] === "/cash-received" && method === "POST") return await cashReceived(id, body, actor, env);
        if (m[2] === "/fulfilment" && method === "POST") return await setFulfilment(id, body, actor, env);
      }
      return fail(404, "Not found");
    } catch (e) {
      console.error("admin error", e && e.message);
      return fail(500, "Something went wrong");
    }
  },
};
