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
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://www.ntagz.com https://ntagz.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
  eq("payment_method", "payment_method", ["razorpay", "payu", "cash", "cod", "upi", "bank", "whatsapp"]);
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
  const pays = await env.DB.prepare("SELECT method,amount_paise,recorded_by,reference,created_at FROM payments WHERE order_id=? ORDER BY created_at")
    .bind(id).all();
  return { ...shape(o), payments: pays.results };
}

const MANUAL_ORDER_METHODS = ["cash", "cod", "upi", "bank", "whatsapp"];

// Records money received outside the gateways. Cash/COD: confirm the exact outstanding amount. UPI/bank/WhatsApp orders:
// also say which of upi|bank it arrived by and give a reference (e.g. UTR). Gateway (razorpay/payu) orders are never eligible.
async function paymentReceived(id, body, actor, env) {
  const confirmed = Number(body.confirm_amount_paise);
  const key = typeof body.idempotency_key === "string" ? body.idempotency_key.slice(0, 64) : "";
  if (!Number.isInteger(confirmed) || confirmed <= 0 || !key) return fail(400, "Missing confirmation");
  const o = await env.DB.prepare("SELECT total,paid_paise,status,payment_method,payment_status FROM orders WHERE id=?").bind(id).first();
  if (!o) return fail(404, "Order not found");
  const orderMethod = (o.payment_method || "").toLowerCase();
  if (!MANUAL_ORDER_METHODS.includes(orderMethod)) return fail(409, "Online gateway payments cannot be marked received here");
  if (o.status === "cancelled") return fail(409, "Order is cancelled");
  if (o.payment_status === "paid") return fail(409, "Order is already fully paid");
  if (orderMethod === "cod" && o.status !== "delivered") return fail(409, "Cash on delivery can only be recorded after delivery");
  let method = orderMethod, reference = null;
  if (["upi", "bank", "whatsapp"].includes(orderMethod)) {
    method = typeof body.method === "string" ? body.method.toLowerCase() : "";
    if (!["upi", "bank"].includes(method)) return json({ error: "Choose UPI or bank transfer", fields: { method: "Choose UPI or bank transfer" } }, 400);
    reference = sanitiseText(body.reference, 64);
    if (reference.length < 3) return json({ error: "Enter the payment reference (e.g. UTR)", fields: { reference: "Reference is required" } }, 400);
  } else reference = sanitiseText(body.reference, 64) || null;
  const outstanding = o.total - o.paid_paise;
  if (outstanding <= 0 || outstanding !== confirmed) return fail(409, "Outstanding amount has changed. Refresh and confirm again.");

  const pid = crypto.randomUUID();
  // One atomic batch; every statement is guarded by the same trusted-row conditions, so a concurrent or repeated
  // confirmation inserts nothing (and the unique manual-payment index backs this up at the schema level).
  const guard = `FROM orders WHERE id=?1 AND payment_status='unpaid' AND paid_paise=?2 AND total-paid_paise=?3
                   AND status<>'cancelled' AND lower(payment_method) IN ('cash','cod','upi','bank','whatsapp')
                   AND (lower(payment_method)<>'cod' OR status='delivered')`;
  const res = await env.DB.batch([
    env.DB.prepare(`INSERT INTO payments (id,order_id,method,amount_paise,recorded_by,idempotency_key,reference)
                    SELECT ?4, id, ?7, total-paid_paise, ?5, ?6, ?8 ${guard}`)
      .bind(id, o.paid_paise, confirmed, pid, actor, key, method, reference),
    env.DB.prepare(`UPDATE orders SET paid_paise=total, payment_status='paid', payment_method=?4, updated_at=unixepoch()
                    WHERE id=?1 AND payment_status='unpaid' AND paid_paise=?2 AND EXISTS (SELECT 1 FROM payments WHERE id=?3)`)
      .bind(id, o.paid_paise, pid, method),
    env.DB.prepare(`INSERT INTO audit_log (id,actor,action,order_id,detail)
                    SELECT ?1,?2,'payment_received',?3,?4 WHERE EXISTS (SELECT 1 FROM payments WHERE id=?5)`)
      .bind(crypto.randomUUID(), actor, id, JSON.stringify({ amount_paise: confirmed, method, reference }), pid),
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

// ── Products & inventory ──────────────────────────────────────────────
const PSORTS = { name: "name", price: "price_paise", stock: "stock_qty", updated: "updated_at" };
const PCOLS = "id,sku,name,description,category,image_url,price_paise,mrp_paise,gst_rate,all_inclusive,unit,stock_qty,low_stock_threshold,active,created_at,updated_at";
const GST_RATES = [0, 5, 12, 18, 28];
const IMAGE_OK = /^(https:\/\/(www\.)?ntagz\.com\/|images\/)[\w\-./]{1,200}$/;

const stockStatus = (p) => (p.stock_qty <= 0 ? "out" : p.stock_qty <= p.low_stock_threshold ? "low" : "in");
const pshape = (p) => ({ ...p, active: !!p.active, all_inclusive: !!p.all_inclusive, stock_status: stockStatus(p) });

function rupeesToPaise(v) {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 10_000_000) return null;
  const paise = Math.round(n * 100);
  return Math.abs(paise - n * 100) < 1e-6 ? paise : null; // at most 2 decimals
}
const intIn = (v, min, max) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

// Returns { f: {column: value}, errors: {field: message} }. `partial` = only validate fields that are present.
function validateProduct(b, partial) {
  const f = {}, errors = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has("name")) {
    const v = typeof b.name === "string" ? b.name.trim() : "";
    if (v.length < 2 || v.length > 120) errors.name = "Name must be 2–120 characters"; else f.name = v;
  }
  if (has("sku")) {
    const v = typeof b.sku === "string" ? b.sku.trim().toUpperCase() : "";
    if (!/^[A-Z0-9][A-Z0-9._-]{1,31}$/.test(v)) errors.sku = "SKU must be 2–32 letters, numbers, . _ -"; else f.sku = v;
  }
  if (has("description")) {
    const v = b.description === undefined || b.description === null ? "" : b.description;
    if (typeof v !== "string" || v.length > 2000) errors.description = "Description is too long"; else f.description = v.trim();
  }
  if (has("category")) {
    const v = typeof b.category === "string" ? b.category.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9 _-]{0,39}$/.test(v)) errors.category = "Category is required (letters and numbers)"; else f.category = v;
  }
  if (has("image_url")) {
    const v = b.image_url === undefined || b.image_url === null ? "" : String(b.image_url).trim();
    if (v && !IMAGE_OK.test(v)) errors.image_url = "Use an images/… path or an https://ntagz.com/… URL"; else f.image_url = v || null;
  }
  if (has("price")) {
    const p = rupeesToPaise(b.price);
    if (p === null) errors.price = "Enter a valid price in rupees (max 2 decimals)"; else f.price_paise = p;
  }
  if (b.mrp !== undefined) {
    if (b.mrp === null || b.mrp === "") f.mrp_paise = null;
    else { const p = rupeesToPaise(b.mrp); if (p === null) errors.mrp = "Enter a valid MRP"; else f.mrp_paise = p; }
  }
  if (f.mrp_paise !== undefined && f.mrp_paise !== null && f.price_paise !== undefined && f.mrp_paise < f.price_paise) errors.mrp = "MRP cannot be lower than the selling price";
  if (has("gst_rate")) {
    const v = intIn(b.gst_rate ?? 18, 0, 28);
    if (v === null || !GST_RATES.includes(v)) errors.gst_rate = "GST rate must be 0, 5, 12, 18 or 28"; else f.gst_rate = v;
  }
  if (b.unit !== undefined) {
    const v = typeof b.unit === "string" ? b.unit.trim() : "";
    if (!/^[\w ./-]{1,20}$/.test(v)) errors.unit = "Invalid unit"; else f.unit = v;
  }
  if (b.low_stock_threshold !== undefined) {
    const v = intIn(b.low_stock_threshold, 0, 1_000_000);
    if (v === null) errors.low_stock_threshold = "Threshold must be a whole number, 0 or more"; else f.low_stock_threshold = v;
  }
  if (b.active !== undefined) f.active = b.active ? 1 : 0;
  return { f, errors };
}

function productFilters(sp) {
  const where = [], bind = [];
  const q = (sp.get("q") || "").trim().slice(0, 100);
  if (q) { bind.push(`%${q.replace(/[\\%_]/g, "\\$&")}%`); where.push("(name LIKE ?1 ESCAPE '\\' OR sku LIKE ?1 ESCAPE '\\' OR id LIKE ?1 ESCAPE '\\')"); }
  const cat = (sp.get("category") || "").trim().toLowerCase().slice(0, 40);
  if (cat) { bind.push(cat); where.push(`category=?${bind.length}`); }
  const st = sp.get("stock");
  if (st === "out") where.push("stock_qty<=0");
  else if (st === "low") where.push("stock_qty>0 AND stock_qty<=low_stock_threshold");
  else if (st === "in") where.push("stock_qty>low_stock_threshold");
  const a = sp.get("active");
  if (a === "1" || a === "0") where.push(`active=${a}`);
  return { sql: where.length ? "WHERE " + where.join(" AND ") : "", bind };
}

async function listProducts(sp, env) {
  const { sql, bind } = productFilters(sp);
  const page = Math.max(1, parseInt(sp.get("page"), 10) || 1);
  const col = PSORTS[sp.get("sort")] || "updated_at";
  const dir = sp.get("dir") === "asc" ? "ASC" : "DESC";
  const total = (await env.DB.prepare(`SELECT count(*) c FROM products ${sql}`).bind(...bind).first()).c;
  const { results } = await env.DB.prepare(
    `SELECT ${PCOLS} FROM products ${sql} ORDER BY ${col} ${dir}, id LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`
  ).bind(...bind).all();
  return json({ products: results.map(pshape), page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total });
}

async function productSummary(env) {
  const s = await env.DB.prepare(
    `SELECT count(*) total, coalesce(sum(active),0) active,
            coalesce(sum(CASE WHEN stock_qty>0 AND stock_qty<=low_stock_threshold THEN 1 ELSE 0 END),0) low,
            coalesce(sum(CASE WHEN stock_qty<=0 THEN 1 ELSE 0 END),0) out FROM products`).first();
  const cats = await env.DB.prepare("SELECT DISTINCT category FROM products ORDER BY category").all();
  return json({ ...s, categories: cats.results.map((c) => c.category) });
}

async function getProduct(id, env) {
  const p = await env.DB.prepare(`SELECT ${PCOLS} FROM products WHERE id=?`).bind(id).first();
  if (!p) return null;
  const mv = await env.DB.prepare(
    "SELECT type,qty_change,prev_stock,new_stock,reason,reference,notes,admin,created_at FROM inventory_movements WHERE product_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50"
  ).bind(id).all();
  return { ...pshape(p), movements: mv.results };
}

function sanitiseText(v, max) { return typeof v === "string" ? v.trim().slice(0, max) : ""; }

async function createProduct(body, actor, env) {
  const { f, errors } = validateProduct(body, false);
  const opening = intIn(body.opening_stock ?? 0, 0, 1_000_000);
  if (opening === null) errors.opening_stock = "Opening stock must be a whole number, 0 or more";
  if (Object.keys(errors).length) return json({ error: "Please fix the highlighted fields", fields: errors }, 400);
  const id = typeof body.id === "string" && /^[a-z0-9][a-z0-9-]{1,63}$/.test(body.id) ? body.id : null;
  const pid = id || f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || crypto.randomUUID();
  if (await env.DB.prepare("SELECT 1 FROM products WHERE id=?").bind(pid).first()) return json({ error: "A product with this ID already exists", fields: { name: "Name is already used by another product" } }, 409);
  if (await env.DB.prepare("SELECT 1 FROM products WHERE lower(sku)=lower(?)").bind(f.sku).first()) return json({ error: "SKU already exists", fields: { sku: "This SKU is already in use" } }, 409);
  const thr = f.low_stock_threshold ?? 10;
  const stmts = [env.DB.prepare(
    `INSERT INTO products (id,sku,name,description,category,image_url,price_paise,mrp_paise,gst_rate,unit,stock_qty,low_stock_threshold,active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(pid, f.sku, f.name, f.description ?? "", f.category, f.image_url ?? null, f.price_paise, f.mrp_paise ?? null, f.gst_rate ?? 18, f.unit ?? "pc", opening, thr, f.active ?? 1)];
  if (opening > 0) stmts.push(env.DB.prepare(
    "INSERT INTO inventory_movements (id,product_id,type,qty_change,prev_stock,new_stock,reason,admin,idempotency_key) VALUES (?,?,'opening',?,0,?,'Opening stock',?,?)"
  ).bind(crypto.randomUUID(), pid, opening, opening, actor, "opening"));
  stmts.push(env.DB.prepare("INSERT INTO audit_log (id,actor,action,detail) VALUES (?,?,'product_create',?)").bind(crypto.randomUUID(), actor, JSON.stringify({ id: pid, sku: f.sku })));
  try { await env.DB.batch(stmts); } catch { return json({ error: "SKU already exists", fields: { sku: "This SKU is already in use" } }, 409); }
  return json(await getProduct(pid, env), 201);
}

async function updateProduct(id, body, actor, env) {
  if ("stock_qty" in body || "stock" in body) return fail(400, "Stock can only be changed through a stock adjustment");
  const { f, errors } = validateProduct(body, true);
  if (Object.keys(errors).length) return json({ error: "Please fix the highlighted fields", fields: errors }, 400);
  const cur = await env.DB.prepare(`SELECT ${PCOLS} FROM products WHERE id=?`).bind(id).first();
  if (!cur) return fail(404, "Product not found");
  if (f.sku && f.sku.toLowerCase() !== cur.sku.toLowerCase() && await env.DB.prepare("SELECT 1 FROM products WHERE lower(sku)=lower(?) AND id<>?").bind(f.sku, id).first())
    return json({ error: "SKU already exists", fields: { sku: "This SKU is already in use" } }, 409);
  const mrp = f.mrp_paise !== undefined ? f.mrp_paise : cur.mrp_paise, price = f.price_paise ?? cur.price_paise;
  if (mrp !== null && mrp < price) return json({ error: "MRP cannot be lower than the selling price", fields: { mrp: "MRP cannot be lower than the selling price" } }, 400);
  const keys = Object.keys(f);
  if (!keys.length) return json(await getProduct(id, env));
  const changed = {};
  for (const k of keys) if (f[k] !== cur[k]) changed[k] = { from: cur[k], to: f[k] };
  // Column names come from the fixed validateProduct whitelist above, never from request input.
  const setSql = keys.map((k) => `${k}=?`).join(",");
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE products SET ${setSql}, updated_at=unixepoch() WHERE id=?`).bind(...keys.map((k) => f[k]), id),
      env.DB.prepare("INSERT INTO audit_log (id,actor,action,detail) VALUES (?,?,'product_update',?)").bind(crypto.randomUUID(), actor, JSON.stringify({ id, changed })),
    ]);
  } catch { return json({ error: "SKU already exists", fields: { sku: "This SKU is already in use" } }, 409); }
  return json(await getProduct(id, env));
}

// Stock movements. In/out are relative (safe under concurrency); "set" is optimistic: it only applies if the
// stock is still what the admin saw. Update + movement row are one atomic batch; negative stock is impossible.
async function adjustStock(id, body, actor, env) {
  const type = body.type;
  if (!["in", "out", "set"].includes(type)) return fail(400, "Invalid adjustment type");
  const qty = intIn(body.quantity, type === "set" ? 0 : 1, 1_000_000);
  if (qty === null) return json({ error: type === "set" ? "Actual stock must be a whole number, 0 or more" : "Quantity must be a whole number of at least 1", fields: { quantity: "Invalid quantity" } }, 400);
  const reason = sanitiseText(body.reason, 200);
  if (reason.length < 3) return json({ error: "A reason is required", fields: { reason: "Enter a reason (at least 3 characters)" } }, 400);
  const reference = sanitiseText(body.reference, 100) || null, notes = sanitiseText(body.notes, 500) || null;
  const key = typeof body.idempotency_key === "string" && body.idempotency_key ? body.idempotency_key.slice(0, 64) : "";
  if (!key) return fail(400, "Missing idempotency key");
  const cur = await env.DB.prepare("SELECT stock_qty FROM products WHERE id=?").bind(id).first();
  if (!cur) return fail(404, "Product not found");

  let batch;
  if (type === "set") {
    const expected = intIn(body.expected_stock, 0, 1_000_000);
    if (expected === null) return fail(400, "Missing current stock");
    if (expected !== cur.stock_qty) return fail(409, `Stock changed to ${cur.stock_qty}. Review and try again.`);
    batch = [
      env.DB.prepare("UPDATE products SET stock_qty=?1, updated_at=unixepoch() WHERE id=?2 AND stock_qty=?3").bind(qty, id, expected),
      env.DB.prepare(`INSERT INTO inventory_movements (id,product_id,type,qty_change,prev_stock,new_stock,reason,reference,notes,admin,idempotency_key)
                      SELECT ?1,?2,'set',?3-?4,?4,?3,?5,?6,?7,?8,?9 WHERE changes()=1`)
        .bind(crypto.randomUUID(), id, qty, expected, reason, reference, notes, actor, key),
    ];
  } else {
    const delta = type === "in" ? qty : -qty;
    batch = [
      env.DB.prepare("UPDATE products SET stock_qty=stock_qty+?1, updated_at=unixepoch() WHERE id=?2 AND stock_qty+?1>=0").bind(delta, id),
      env.DB.prepare(`INSERT INTO inventory_movements (id,product_id,type,qty_change,prev_stock,new_stock,reason,reference,notes,admin,idempotency_key)
                      SELECT ?1,?2,?3,?4,stock_qty-?4,stock_qty,?5,?6,?7,?8,?9 FROM products WHERE id=?2 AND changes()=1`)
        .bind(crypto.randomUUID(), id, type, delta, reason, reference, notes, actor, key),
    ];
  }
  let res;
  try { res = await env.DB.batch(batch); } catch { return fail(409, "This adjustment was already recorded"); }
  if (res[0].meta.changes !== 1) {
    const now_ = await env.DB.prepare("SELECT stock_qty FROM products WHERE id=?").bind(id).first();
    return fail(409, type === "out" ? `Cannot remove ${qty}: only ${now_.stock_qty} in stock` : `Stock changed to ${now_.stock_qty}. Review and try again.`);
  }
  return json(await getProduct(id, env));
}

async function setActive(id, body, actor, env) {
  if (typeof body.active !== "boolean") return fail(400, "active must be true or false");
  const r = await env.DB.batch([
    env.DB.prepare("UPDATE products SET active=?, updated_at=unixepoch() WHERE id=?").bind(body.active ? 1 : 0, id),
    env.DB.prepare("INSERT INTO audit_log (id,actor,action,detail) SELECT ?,?,?,? WHERE changes()=1")
      .bind(crypto.randomUUID(), actor, body.active ? "product_activate" : "product_deactivate", JSON.stringify({ id })),
  ]);
  if (r[0].meta.changes !== 1) return fail(404, "Product not found");
  return json(await getProduct(id, env));
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
        else if ((path === "/app.js" || path === "/products.js") && user) asset = path;
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

      const m = path.match(/^\/api\/orders\/([0-9a-fA-F-]{8,64})(\/cash-received|\/payment-received|\/fulfilment)?$/);
      if (m) {
        const id = m[1];
        if (!m[2] && method === "GET") {
          const o = await getOrder(id, env);
          return o ? json(o) : fail(404, "Order not found");
        }
        if ((m[2] === "/cash-received" || m[2] === "/payment-received") && method === "POST") return await paymentReceived(id, body, actor, env);
        if (m[2] === "/fulfilment" && method === "POST") return await setFulfilment(id, body, actor, env);
      }
      if (method === "GET" && path === "/api/products") return await listProducts(url.searchParams, env);
      if (method === "GET" && path === "/api/products/summary") return await productSummary(env);
      if (method === "POST" && path === "/api/products") return await createProduct(body, actor, env);
      const pm = path.match(/^\/api\/products\/([a-z0-9][a-z0-9-]{0,63})(\/stock|\/active)?$/);
      if (pm) {
        const pid = pm[1];
        if (!pm[2] && method === "GET") { const p = await getProduct(pid, env); return p ? json(p) : fail(404, "Product not found"); }
        if (!pm[2] && method === "POST") return await updateProduct(pid, body, actor, env);
        if (pm[2] === "/stock" && method === "POST") return await adjustStock(pid, body, actor, env);
        if (pm[2] === "/active" && method === "POST") return await setActive(pid, body, actor, env);
      }
      return fail(404, "Not found");
    } catch (e) {
      console.error("admin error", e && e.message);
      return fail(500, "Something went wrong");
    }
  },
};
