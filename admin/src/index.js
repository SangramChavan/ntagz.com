// NTAGZ admin Worker: auth, order management API, and gated static admin UI.
// Every /api/* route except auth/request + auth/verify requires a valid session, re-checked against the
// admin allowlist on each request. All SQL is parameterised. No CORS headers: same-origin only.

const SESSION_TTL = 12 * 3600;
const OTP_TTL = 600;
const COOKIE = "ntagz_admin";
// ── Fulfilment workflow (server-enforced) ────────────────────────────
// orders.status is the fulfilment status; payment state lives in separate columns and is never changed by these transitions.
const STATUS_LABEL = {
  placed: "Order placed", confirmed: "Confirmed", processing: "Processing", packed: "Packed", shipped: "Shipped",
  out_for_delivery: "Out for delivery", delivered: "Delivered", on_hold: "On hold", cancelled: "Cancelled",
  delivery_failed: "Delivery failed", returned: "Returned",
  preorder_confirmed: "Pre-order confirmed", awaiting_stock: "Awaiting stock", ready_to_pack: "Ready to pack",
};
const FULFILMENT = Object.keys(STATUS_LABEL);
// Orders do not have to pass through every stage: forward skips are allowed where a stage can be unnecessary.
const TRANSITIONS = {
  placed: ["confirmed", "on_hold", "cancelled"],
  confirmed: ["processing", "packed", "shipped", "on_hold", "cancelled"],
  processing: ["packed", "shipped", "on_hold", "cancelled"],
  packed: ["shipped", "on_hold", "cancelled"],
  shipped: ["out_for_delivery", "delivered", "delivery_failed", "returned"],
  out_for_delivery: ["delivered", "delivery_failed"],
  delivery_failed: ["out_for_delivery", "shipped", "returned", "cancelled"],
  delivered: ["returned"],
  on_hold: ["confirmed", "processing", "packed", "preorder_confirmed", "awaiting_stock", "ready_to_pack", "cancelled"],
  preorder_confirmed: ["awaiting_stock", "ready_to_pack", "on_hold", "cancelled"],
  awaiting_stock: ["ready_to_pack", "on_hold", "cancelled"],
  ready_to_pack: ["processing", "packed", "shipped", "on_hold", "cancelled"],
  cancelled: [], returned: [],
};
const ACTION_LABEL = {
  confirmed: "Confirm Order", processing: "Mark as Processing", packed: "Mark as Packed", shipped: "Ship Order",
  out_for_delivery: "Mark as Out for Delivery", delivered: "Mark as Delivered", on_hold: "Put On Hold",
  cancelled: "Cancel Order", returned: "Mark as Returned", delivery_failed: "Mark Delivery Failed",
  preorder_confirmed: "Confirm Pre-order", awaiting_stock: "Mark Awaiting Stock", ready_to_pack: "Mark Ready to Pack",
};
const PREORDER_ONLY = ["preorder_confirmed", "awaiting_stock", "ready_to_pack"];
const NEEDS_CONFIRM = ["cancelled", "returned", "delivery_failed", "on_hold"];
// Pre-order stages are only offered on pre-orders (the server still accepts them from any allowed state).
const allowedActions = (status, isPre) => (TRANSITIONS[status] || []).filter((to) => isPre || !PREORDER_ONLY.includes(to)).map((to) => ({ to, label: ACTION_LABEL[to], confirm: NEEDS_CONFIRM.includes(to), form: to === "shipped" }));
const VIEWS = { // admin filter chips -> SQL (fixed fragments; never built from request text)
  new: "status IN ('placed','confirmed')", paid: "payment_status='paid'",
  payment_pending: "payment_status='unpaid' AND status NOT IN ('cancelled','returned')",
  processing: "status='processing'", packed: "status='packed'", shipped: "status='shipped'", out_for_delivery: "status='out_for_delivery'",
  delivered: "status='delivered'", on_hold: "status='on_hold'", awaiting_stock: "status='awaiting_stock'", cancelled: "status='cancelled'", returned: "status='returned'", preorders: "is_preorder=1",
};
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
  const burn = await env.DB.prepare("UPDATE admin_otps SET attempts=attempts+1 WHERE id=? AND attempts<5").bind(row.id).run(); // atomic: parallel guesses cannot exceed 5
  if (burn.meta.changes !== 1 || !safeEqual(row.otp_hash, await sha256(`${email}:${otp}`))) return fail(401, "Invalid or expired code");
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
  "payment_method,payment_status,paid_paise,status,tracking_id,courier,is_preorder,expected_dispatch,created_at,updated_at";

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
    where.push("(id LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\' OR phone LIKE ?1 ESCAPE '\\' OR email LIKE ?1 ESCAPE '\\' OR txn_id LIKE ?1 ESCAPE '\\' OR quote_ref LIKE ?1 ESCAPE '\\' OR tracking_id LIKE ?1 ESCAPE '\\' OR EXISTS (SELECT 1 FROM shipments sh WHERE sh.order_id=orders.id AND sh.awb LIKE ?1 ESCAPE '\\'))");
    bind.push(like);
  }
  const eq = (param, col, allowed) => {
    const v = sp.get(param);
    if (v && allowed.includes(v)) { bind.push(v); where.push(`${col}=?${bind.length}`); }
  };
  eq("payment_status", "payment_status", ["unpaid", "paid"]);
  eq("payment_method", "payment_method", ["razorpay", "payu", "cash", "cod", "upi", "bank", "whatsapp"]);
  eq("fulfilment", "status", FULFILMENT);
  const view = sp.get("view");
  if (view && VIEWS[view]) where.push(`(${VIEWS[view]})`);
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
  const tok = (await env.DB.prepare("SELECT track_token FROM orders WHERE id=?").bind(id).first())?.track_token; // detail only, never in COLS/list/CSV
  const pays = await env.DB.prepare("SELECT method,amount_paise,recorded_by,reference,created_at FROM payments WHERE order_id=? ORDER BY created_at")
    .bind(id).all();
  const ships = await env.DB.prepare("SELECT id,courier,awb,tracking_url,shipped_on,est_delivery,notes,created_by,created_at,updated_at FROM shipments WHERE order_id=? ORDER BY created_at, rowid").bind(id).all();
  const revs = ships.results.length
    ? await env.DB.prepare(`SELECT shipment_id,changed_by,changes,created_at FROM shipment_revisions WHERE shipment_id IN (${ships.results.map(() => "?").join(",")}) ORDER BY created_at`).bind(...ships.results.map((x) => x.id)).all()
    : { results: [] };
  const events = await env.DB.prepare("SELECT kind,status,note,public_note,customer_visible,actor,created_at FROM order_events WHERE order_id=? ORDER BY created_at, rowid").bind(id).all();
  const shipments = ships.results.map((x) => ({ ...x, revisions: revs.results.filter((r) => r.shipment_id === x.id).map((r) => ({ changed_by: r.changed_by, changes: JSON.parse(r.changes), created_at: r.created_at })) }));
  // Timeline = synthesised "placed" + recorded payments + recorded events, oldest first.
  const timeline = [
    { kind: "placed", label: "Order placed", at: o.created_at },
    ...pays.results.map((p) => ({ kind: "payment", label: `Payment received (${p.method})`, at: p.created_at, actor: p.recorded_by })),
    ...events.results.map((e) => ({ kind: e.kind, status: e.status, label: e.kind === "dispatch" ? "Expected dispatch" : STATUS_LABEL[e.status] || e.kind, note: e.note, public_note: e.public_note, customer_visible: !!e.customer_visible, actor: e.actor, at: e.created_at })),
  ].sort((x, y) => x.at - y.at);
  const lines = await env.DB.prepare("SELECT l.product_id,p.name,l.ready_qty,l.pre_qty FROM order_stock_lines l LEFT JOIN products p ON p.id=l.product_id WHERE l.order_id=? ORDER BY l.rowid").bind(id).all();
  return { ...shape(o), stock_lines: lines.results.map((l) => ({ ...l, name: l.name || l.product_id })), ...(tok ? { track_url: `https://ntagz.com/track.html?o=${id}&t=${tok}` } : {}), is_preorder: !!o.is_preorder, payments: pays.results, shipments, timeline, actions: allowedActions(o.status, !!o.is_preorder), status_label: STATUS_LABEL[o.status] || o.status };
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

const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const validDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
function cleanTrackingUrl(v) {
  if (v === undefined || v === null || String(v).trim() === "") return { ok: true, value: null };
  try {
    const u = new URL(String(v).trim());
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".") || /^[\d.]+$/.test(u.hostname) || u.href.length > 300) return { ok: false };
    return { ok: true, value: u.href };
  } catch { return { ok: false }; }
}
const AWB_RE = /^[A-Za-z0-9][A-Za-z0-9\-_/ ]{1,38}[A-Za-z0-9]$/;
const COURIER_RE = /^[A-Za-z0-9][A-Za-z0-9 .&'()-]{1,59}$/;

// Validates shipment fields. `partial` = only the fields present (used for corrections).
function validateShipment(b, partial) {
  const f = {}, errors = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has("courier")) { const v = text(b.courier, 60); if (!COURIER_RE.test(v)) errors.courier = "Enter the courier name"; else f.courier = v; }
  if (has("awb")) { const v = text(b.awb, 40); if (!AWB_RE.test(v)) errors.awb = "Enter a valid AWB / tracking number (3–40 letters, numbers, - _ /)"; else f.awb = v; }
  if (b.tracking_url !== undefined) { const t = cleanTrackingUrl(b.tracking_url); if (!t.ok) errors.tracking_url = "Paste a full https:// tracking link from the courier"; else f.tracking_url = t.value; }
  if (has("shipped_on")) { const v = text(b.shipped_on, 10); if (!validDate(v)) errors.shipped_on = "Enter the shipping date"; else f.shipped_on = v; }
  if (b.est_delivery !== undefined) { const v = text(b.est_delivery, 10); if (v && !validDate(v)) errors.est_delivery = "Enter a valid date"; else f.est_delivery = v || null; }
  if (b.notes !== undefined) f.notes = text(b.notes, 500) || null;
  if (f.shipped_on && f.est_delivery && f.est_delivery < f.shipped_on) errors.est_delivery = "Estimated delivery cannot be before the shipping date";
  return { f, errors };
}
const dupKey = async (env, orderId, key) => !!(await env.DB.prepare("SELECT 1 FROM order_events WHERE order_id=? AND idempotency_key=?").bind(orderId, key).first());
const keyOf = (b) => (typeof b.idempotency_key === "string" && b.idempotency_key ? b.idempotency_key.slice(0, 64) : "");

// Status change (everything except shipping, which needs the shipment form). Guarded by the status we validated against and by
// a unique idempotency key, so repeated submits and races cannot create duplicate timeline events.
async function changeStatus(id, body, actor, env) {
  const to = body.to ?? body.status;
  if (!FULFILMENT.includes(to)) return fail(400, "Invalid status");
  if (to === "shipped") return fail(400, "Use the shipment form to ship an order");
  const key = keyOf(body) || crypto.randomUUID();
  const o = await env.DB.prepare("SELECT status FROM orders WHERE id=?").bind(id).first();
  if (!o) return fail(404, "Order not found");
  if (await dupKey(env, id, key)) return json(await getOrder(id, env)); // same request replayed
  if (!(TRANSITIONS[o.status] || []).includes(to)) return fail(409, `An order that is ${STATUS_LABEL[o.status] || o.status} cannot be changed to ${STATUS_LABEL[to]}`);
  if (["cancelled", "returned"].includes(to) && body.confirm !== true) return fail(400, "Please confirm this action");
  const note = text(body.note, 500) || null, pub = text(body.public_note, 300) || null;
  const eid = crypto.randomUUID();
  let res;
  try {
    const stmts = [
      env.DB.prepare(`INSERT INTO order_events (id,order_id,kind,status,note,public_note,actor,idempotency_key)
                      SELECT ?1,id,'status',?2,?3,?4,?5,?6 FROM orders WHERE id=?7 AND status=?8`).bind(eid, to, note, pub, actor, key, id, o.status),
      env.DB.prepare("UPDATE orders SET status=?1, updated_at=unixepoch() WHERE id=?2 AND status=?3 AND EXISTS (SELECT 1 FROM order_events WHERE id=?4)").bind(to, id, o.status, eid),
      env.DB.prepare("INSERT INTO audit_log (id,actor,action,order_id,detail) SELECT ?1,?2,'status',?3,?4 WHERE EXISTS (SELECT 1 FROM order_events WHERE id=?5)").bind(crypto.randomUUID(), actor, id, JSON.stringify({ from: o.status, to }), eid),
    ];
    // Cancel gives its stock reservation back in the same batch. Order matters: the movement row reads stock before the update.
    // Every statement needs this request's event (so only the winner of a race releases) and unreleased lines (so it happens once).
    if (to === "cancelled") stmts.push(
      env.DB.prepare(`INSERT INTO inventory_movements (id,product_id,type,qty_change,prev_stock,new_stock,reason,reference,admin,idempotency_key)
                      SELECT lower(hex(randomblob(16))),l.product_id,'in',l.ready_qty,p.stock_qty,p.stock_qty+l.ready_qty,'Order cancelled',l.order_id,?2,'cancel-'||l.order_id
                      FROM order_stock_lines l JOIN products p ON p.id=l.product_id
                      WHERE l.order_id=?1 AND l.released=0 AND l.ready_qty>0 AND EXISTS (SELECT 1 FROM order_events WHERE id=?3)`).bind(id, actor, eid),
      env.DB.prepare(`UPDATE products SET stock_qty=stock_qty+(SELECT l.ready_qty FROM order_stock_lines l WHERE l.order_id=?1 AND l.product_id=products.id),
                        preordered_qty=max(preordered_qty-(SELECT l.pre_qty FROM order_stock_lines l WHERE l.order_id=?1 AND l.product_id=products.id),0), updated_at=unixepoch()
                      WHERE id IN (SELECT product_id FROM order_stock_lines WHERE order_id=?1 AND released=0) AND EXISTS (SELECT 1 FROM order_events WHERE id=?2)`).bind(id, eid),
      env.DB.prepare("UPDATE order_stock_lines SET released=1 WHERE order_id=?1 AND released=0 AND EXISTS (SELECT 1 FROM order_events WHERE id=?2)").bind(id, eid));
    res = await env.DB.batch(stmts);
  } catch { return json(await getOrder(id, env)); } // unique-key race: another identical request won
  if (res[0].meta.changes !== 1) return fail(409, "The order changed while you were working. Refresh and try again.");
  return json(await getOrder(id, env));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const prettyDate = (d) => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

// Expected dispatch date for a pre-order (a planning date, not a delivery promise). Recorded as a customer-visible event.
async function setDispatch(id, body, actor, env) {
  const key = keyOf(body);
  if (!key) return fail(400, "Missing idempotency key");
  const d = body.expected_dispatch === undefined || body.expected_dispatch === null ? "" : text(body.expected_dispatch, 10);
  if (d && !validDate(d)) return json({ error: "Enter a valid date", fields: { expected_dispatch: "Enter a valid date" } }, 400);
  const o = await env.DB.prepare("SELECT status,is_preorder FROM orders WHERE id=?").bind(id).first();
  if (!o) return fail(404, "Order not found");
  if (await dupKey(env, id, key)) return json(await getOrder(id, env));
  if (!o.is_preorder) return fail(409, "Only pre-orders have an expected dispatch date");
  if (["cancelled", "returned", "delivered"].includes(o.status)) return fail(409, `This order is ${STATUS_LABEL[o.status].toLowerCase()}`);
  const pub = text(body.public_note, 300) || (d ? `Expected dispatch: ${prettyDate(d)}` : "Expected dispatch date removed");
  const eid = crypto.randomUUID();
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(`INSERT INTO order_events (id,order_id,kind,status,public_note,customer_visible,actor,idempotency_key)
                      SELECT ?1,id,'dispatch',status,?2,1,?3,?4 FROM orders WHERE id=?5 AND is_preorder=1 AND status=?6`).bind(eid, pub, actor, key, id, o.status),
      env.DB.prepare("UPDATE orders SET expected_dispatch=?1, updated_at=unixepoch() WHERE id=?2 AND EXISTS (SELECT 1 FROM order_events WHERE id=?3)").bind(d || null, id, eid),
      env.DB.prepare("INSERT INTO audit_log (id,actor,action,order_id,detail) SELECT ?1,?2,'dispatch',?3,?4 WHERE EXISTS (SELECT 1 FROM order_events WHERE id=?5)").bind(crypto.randomUUID(), actor, id, JSON.stringify({ expected_dispatch: d || null }), eid),
    ]);
  } catch { return json(await getOrder(id, env)); }
  if (res[0].meta.changes !== 1) return fail(409, "The order changed while you were working. Refresh and try again.");
  return json(await getOrder(id, env));
}

// Ship: creates a shipment (courier + AWB + optional tracking link) and moves the order to Shipped. Another shipment can be
// added to an order that is already shipped (split shipments). Tracking links are stored exactly as pasted, never invented.
async function shipOrder(id, body, actor, env) {
  const { f, errors } = validateShipment(body, false);
  if (Object.keys(errors).length) return json({ error: "Please fix the highlighted fields", fields: errors }, 400);
  const key = keyOf(body);
  if (!key) return fail(400, "Missing idempotency key");
  const o = await env.DB.prepare("SELECT status FROM orders WHERE id=?").bind(id).first();
  if (!o) return fail(404, "Order not found");
  if (await dupKey(env, id, key)) return json(await getOrder(id, env));
  const addExtra = ["shipped", "out_for_delivery"].includes(o.status); // additional parcel for an order already on its way
  if (!addExtra && !(TRANSITIONS[o.status] || []).includes("shipped")) return fail(409, `An order that is ${STATUS_LABEL[o.status] || o.status} cannot be shipped`);
  if (await env.DB.prepare("SELECT 1 FROM shipments WHERE order_id=? AND lower(awb)=lower(?)").bind(id, f.awb).first()) return json({ error: "This AWB is already on the order", fields: { awb: "This AWB is already on the order" } }, 409);
  const note = text(body.note, 500) || null, pub = text(body.public_note, 300) || null;
  const eid = crypto.randomUUID(), sid = crypto.randomUUID();
  const newStatus = addExtra ? o.status : "shipped";
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(`INSERT INTO order_events (id,order_id,kind,status,note,public_note,actor,idempotency_key)
                      SELECT ?1,id,'shipment',?2,?3,?4,?5,?6 FROM orders WHERE id=?7 AND status=?8`).bind(eid, newStatus, note, pub, actor, key, id, o.status),
      env.DB.prepare(`INSERT INTO shipments (id,order_id,courier,awb,tracking_url,shipped_on,est_delivery,notes,created_by)
                      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE EXISTS (SELECT 1 FROM order_events WHERE id=?10)`).bind(sid, id, f.courier, f.awb, f.tracking_url ?? null, f.shipped_on, f.est_delivery ?? null, f.notes ?? null, actor, eid),
      env.DB.prepare("UPDATE orders SET status=?1, courier=?2, tracking_id=?3, updated_at=unixepoch() WHERE id=?4 AND EXISTS (SELECT 1 FROM shipments WHERE id=?5)").bind(newStatus, f.courier, f.awb, id, sid),
      env.DB.prepare("INSERT INTO audit_log (id,actor,action,order_id,detail) SELECT ?1,?2,'ship',?3,?4 WHERE EXISTS (SELECT 1 FROM shipments WHERE id=?5)").bind(crypto.randomUUID(), actor, id, JSON.stringify({ courier: f.courier, awb: f.awb }), sid),
    ]);
  } catch { return json(await getOrder(id, env)); }
  if (res[0].meta.changes !== 1) return fail(409, "The order changed while you were working. Refresh and try again.");
  return json(await getOrder(id, env));
}

// Correct courier / AWB / link / dates after shipping. Every change is kept in shipment_revisions (who, when, old -> new).
async function correctShipment(id, sid, body, actor, env) {
  const { f, errors } = validateShipment(body, true);
  if (Object.keys(errors).length) return json({ error: "Please fix the highlighted fields", fields: errors }, 400);
  const cur = await env.DB.prepare("SELECT * FROM shipments WHERE id=? AND order_id=?").bind(sid, id).first();
  if (!cur) return fail(404, "Shipment not found");
  const ord = await env.DB.prepare("SELECT status FROM orders WHERE id=?").bind(id).first();
  if (["cancelled", "returned"].includes(ord.status)) return fail(409, "This order is closed");
  const changes = {};
  for (const k of Object.keys(f)) if ((f[k] ?? null) !== (cur[k] ?? null)) changes[k] = { from: cur[k] ?? null, to: f[k] ?? null };
  if (!Object.keys(changes).length) return json(await getOrder(id, env));
  if (changes.awb && await env.DB.prepare("SELECT 1 FROM shipments WHERE order_id=? AND lower(awb)=lower(?) AND id<>?").bind(id, f.awb, sid).first())
    return json({ error: "This AWB is already on the order", fields: { awb: "This AWB is already on the order" } }, 409);
  const keys = Object.keys(changes), setSql = keys.map((k) => `${k}=?`).join(","); // column names come from validateShipment's fixed keys
  const latest = await env.DB.prepare("SELECT id FROM shipments WHERE order_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(id).first();
  const stmts = [
    env.DB.prepare(`UPDATE shipments SET ${setSql}, updated_at=unixepoch() WHERE id=? AND order_id=?`).bind(...keys.map((k) => f[k] ?? null), sid, id),
    env.DB.prepare("INSERT INTO shipment_revisions (id,shipment_id,changed_by,changes) VALUES (?,?,?,?)").bind(crypto.randomUUID(), sid, actor, JSON.stringify(changes)),
    env.DB.prepare("INSERT INTO order_events (id,order_id,kind,status,note,customer_visible,actor,idempotency_key) VALUES (?,?,'shipment_update',?,?,0,?,?)")
      .bind(crypto.randomUUID(), id, ord.status, `Shipment corrected: ${keys.join(", ")}`, actor, `corr-${crypto.randomUUID()}`),
  ];
  if (latest && latest.id === sid && (changes.courier || changes.awb)) stmts.push(env.DB.prepare("UPDATE orders SET courier=?, tracking_id=?, updated_at=unixepoch() WHERE id=?").bind(f.courier ?? cur.courier, f.awb ?? cur.awb, id));
  await env.DB.batch(stmts);
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
const PSORTS = { name: "name", price: "price_paise", stock: "stock_qty", updated: "updated_at", newest: "created_at" };
const PCOLS = "id,sku,name,description,category,image_url,price_paise,mrp_paise,gst_rate,all_inclusive,unit,stock_qty,low_stock_threshold,active,track_stock,cost_paise,built_in,preorder_enabled,preorder_message,preorder_dispatch,preorder_max,preordered_qty,created_at,updated_at";
const GST_RATES = [0, 5, 12, 18, 28];
const IMAGE_OK = /^(https:\/\/(www\.)?ntagz\.com\/|images\/)[\w\-./]{1,200}$/;

const stockStatus = (p) => (p.stock_qty <= 0 ? "out" : p.stock_qty <= p.low_stock_threshold ? "low" : "in");
const pshape = (p) => ({ ...p, active: !!p.active, track_stock: !!p.track_stock, built_in: !!p.built_in, all_inclusive: !!p.all_inclusive, preorder_enabled: !!p.preorder_enabled, stock_status: stockStatus(p) });

function rupeesToPaise(v) {
  if (typeof v === "string" && v.trim() === "") return null; // blank is "missing", not zero
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
  if (b.cost !== undefined) {
    if (b.cost === null || b.cost === "") f.cost_paise = null;
    else { const p = rupeesToPaise(b.cost); if (p === null) errors.cost = "Enter a valid cost price"; else f.cost_paise = p; }
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
  if (b.track_stock !== undefined) f.track_stock = b.track_stock ? 1 : 0; // 1 = checkout enforces and deducts stock
  if (b.preorder_enabled !== undefined) f.preorder_enabled = b.preorder_enabled ? 1 : 0;
  for (const [k, max] of [["preorder_message", 200], ["preorder_dispatch", 100]]) { // preordered_qty is never writable
    if (b[k] === undefined) continue;
    const v = b[k] === null ? "" : b[k];
    if (typeof v !== "string" || v.trim().length > max) errors[k] = `Keep this under ${max} characters`; else f[k] = v.trim() || null;
  }
  if (b.preorder_max !== undefined) {
    if (b.preorder_max === null || b.preorder_max === "") f.preorder_max = null;
    else { const v = intIn(b.preorder_max, 0, 1_000_000); if (v === null) errors.preorder_max = "Enter a whole number, 0 or more"; else f.preorder_max = v; }
  }
  return { f, errors };
}

// Pre-orders need stock tracking (ready stock ships now, the rest is a pre-order). Checked against the merged result.
function preorderRule(f, cur, errors) {
  const pre = f.preorder_enabled ?? cur.preorder_enabled, track = f.track_stock ?? cur.track_stock;
  if (pre && !track) errors.preorder_enabled = "Turn on stock tracking first";
}

function productFilters(sp) {
  const where = [], bind = [];
  const q = (sp.get("q") || "").trim().slice(0, 100);
  if (q) { bind.push(`%${q.replace(/[\\%_]/g, "\\$&")}%`); where.push("(name LIKE ?1 ESCAPE '\\' OR sku LIKE ?1 ESCAPE '\\' OR id LIKE ?1 ESCAPE '\\' OR category LIKE ?1 ESCAPE '\\')"); }
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

async function genSku(env, name) {
  const initials = (String(name).toUpperCase().match(/[A-Z0-9]+/g) || []).map((w) => w[0]).join("").slice(0, 4);
  const base = initials.length >= 2 ? initials : "PRD";
  for (let i = 0; i < 20; i++) {
    const sku = `${base}-${100 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900)}`;
    if (!(await env.DB.prepare("SELECT 1 FROM products WHERE lower(sku)=lower(?)").bind(sku).first())) return sku;
  }
  return `${base}-${Date.now().toString(36).toUpperCase()}`;
}

async function uniqueProductId(env, name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 56) || "product";
  for (let i = 1; i < 50; i++) {
    const id = i === 1 ? slug : `${slug}-${i}`;
    if (!(await env.DB.prepare("SELECT 1 FROM products WHERE id=?").bind(id).first())) return id;
  }
  return `${slug}-${crypto.randomUUID().slice(0, 8)}`;
}

async function createProduct(body, actor, env) {
  const b = { ...body };
  if (typeof b.sku !== "string" || !b.sku.trim()) b.sku = await genSku(env, typeof b.name === "string" ? b.name : ""); // SKU is optional: generated when blank
  const { f, errors } = validateProduct(b, false);
  preorderRule(f, {}, errors);
  const opening = intIn(b.opening_stock ?? 0, 0, 1_000_000);
  if (opening === null) errors.opening_stock = "Stock must be a whole number, 0 or more";
  if (Object.keys(errors).length) return json({ error: "Please fix the highlighted fields", fields: errors }, 400);
  if (await env.DB.prepare("SELECT 1 FROM products WHERE lower(sku)=lower(?)").bind(f.sku).first()) return json({ error: "SKU already exists", fields: { sku: "This SKU is already in use" } }, 409);
  const pid = await uniqueProductId(env, f.name);
  const thr = f.low_stock_threshold ?? 10;
  const stmts = [env.DB.prepare(
    `INSERT INTO products (id,sku,name,description,category,image_url,price_paise,mrp_paise,cost_paise,gst_rate,unit,stock_qty,low_stock_threshold,active,track_stock,preorder_enabled,preorder_message,preorder_dispatch,preorder_max)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(pid, f.sku, f.name, f.description ?? "", f.category, f.image_url ?? null, f.price_paise, f.mrp_paise ?? null, f.cost_paise ?? null, f.gst_rate ?? 18, f.unit ?? "pc", opening, thr, f.active ?? 1, f.track_stock ?? 0, f.preorder_enabled ?? 0, f.preorder_message ?? null, f.preorder_dispatch ?? null, f.preorder_max ?? null)];
  if (opening > 0) stmts.push(env.DB.prepare(
    "INSERT INTO inventory_movements (id,product_id,type,qty_change,prev_stock,new_stock,reason,admin,idempotency_key) VALUES (?,?,'opening',?,0,?,'Opening stock',?,?)"
  ).bind(crypto.randomUUID(), pid, opening, opening, actor, "opening"));
  stmts.push(env.DB.prepare("INSERT INTO audit_log (id,actor,action,detail) VALUES (?,?,'product_create',?)").bind(crypto.randomUUID(), actor, JSON.stringify({ id: pid, sku: f.sku })));
  try { await env.DB.batch(stmts); } catch { return json({ error: "SKU already exists", fields: { sku: "This SKU is already in use" } }, 409); }
  return json(await getProduct(pid, env), 201);
}

// Copy details into a new INACTIVE product with a fresh SKU and zero stock, so a half-finished copy can never be sold by accident.
async function duplicateProduct(id, actor, env) {
  const src = await env.DB.prepare(`SELECT ${PCOLS} FROM products WHERE id=?`).bind(id).first();
  if (!src) return fail(404, "Product not found");
  const name = `${src.name} (copy)`.slice(0, 120);
  const pid = await uniqueProductId(env, name), sku = await genSku(env, src.name);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO products (id,sku,name,description,category,image_url,price_paise,mrp_paise,cost_paise,gst_rate,all_inclusive,unit,stock_qty,low_stock_threshold,active,track_stock,built_in)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,0,0,0)`
      ).bind(pid, sku, name, src.description, src.category, src.image_url, src.price_paise, src.mrp_paise, src.cost_paise, src.gst_rate, src.all_inclusive, src.unit, src.low_stock_threshold),
      env.DB.prepare("INSERT INTO audit_log (id,actor,action,detail) VALUES (?,?,'product_duplicate',?)").bind(crypto.randomUUID(), actor, JSON.stringify({ from: id, id: pid })),
    ]);
  } catch { return fail(409, "Could not create the copy. Try again."); }
  return json(await getProduct(pid, env), 201);
}

// Safe delete: only products nothing refers to are removed. Anything with orders, pending checkouts or stock history is
// deactivated instead (never breaks history). Built-in catalogue products can only be deactivated.
async function deleteProduct(id, actor, env) {
  const p = await env.DB.prepare("SELECT id,sku,name,built_in FROM products WHERE id=?").bind(id).first();
  if (!p) return fail(404, "Product not found");
  if (p.built_in) return json({ error: "This product is part of the storefront catalogue. Deactivate it instead.", deactivate: true }, 409);
  const pattern = `%"id":"${id}"%`;
  const used = (await env.DB.prepare("SELECT 1 FROM orders WHERE items_json LIKE ? LIMIT 1").bind(pattern).first())
    || (await env.DB.prepare("SELECT 1 FROM checkout_intents WHERE items_json LIKE ? LIMIT 1").bind(pattern).first())
    || (await env.DB.prepare("SELECT 1 FROM inventory_movements WHERE product_id=? AND type<>'opening' LIMIT 1").bind(id).first());
  if (used) {
    await env.DB.batch([
      env.DB.prepare("UPDATE products SET active=0, updated_at=unixepoch() WHERE id=?").bind(id),
      env.DB.prepare("INSERT INTO audit_log (id,actor,action,detail) VALUES (?,?,'product_deactivate',?)").bind(crypto.randomUUID(), actor, JSON.stringify({ id, via: "delete" })),
    ]);
    return json({ deleted: false, deactivated: true, message: "This product has orders or stock history, so it was deactivated instead of deleted." });
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM inventory_movements WHERE product_id=?").bind(id),
    env.DB.prepare("DELETE FROM products WHERE id=?").bind(id),
    env.DB.prepare("INSERT INTO audit_log (id,actor,action,detail) VALUES (?,?,'product_delete',?)").bind(crypto.randomUUID(), actor, JSON.stringify({ id, sku: p.sku, name: p.name })),
  ]);
  return json({ deleted: true });
}

async function updateProduct(id, body, actor, env) {
  if ("stock_qty" in body || "stock" in body) return fail(400, "Stock can only be changed through a stock adjustment");
  const { f, errors } = validateProduct(body, true);
  const cur = await env.DB.prepare(`SELECT ${PCOLS} FROM products WHERE id=?`).bind(id).first();
  if (cur) preorderRule(f, cur, errors);
  if (Object.keys(errors).length) return json({ error: "Please fix the highlighted fields", fields: errors }, 400);
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
        else if ((path === "/app.js" || path === "/orders.js" || path === "/products.js") && user) asset = path;
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

      const m = path.match(/^\/api\/orders\/([0-9a-fA-F-]{8,64})(\/cash-received|\/payment-received|\/fulfilment|\/status|\/ship|\/dispatch|\/shipments\/[0-9a-fA-F-]{8,64})?$/);
      if (m) {
        const id = m[1];
        if (!m[2] && method === "GET") {
          const o = await getOrder(id, env);
          return o ? json(o) : fail(404, "Order not found");
        }
        if ((m[2] === "/cash-received" || m[2] === "/payment-received") && method === "POST") return await paymentReceived(id, body, actor, env);
        if ((m[2] === "/fulfilment" || m[2] === "/status") && method === "POST") return await changeStatus(id, body, actor, env);
        if (m[2] === "/ship" && method === "POST") return await shipOrder(id, body, actor, env);
        if (m[2] === "/dispatch" && method === "POST") return await setDispatch(id, body, actor, env);
        if (m[2] && m[2].startsWith("/shipments/") && method === "POST") return await correctShipment(id, m[2].slice(11), body, actor, env);
      }
      if (method === "GET" && path === "/api/products") return await listProducts(url.searchParams, env);
      if (method === "GET" && path === "/api/products/summary") return await productSummary(env);
      if (method === "POST" && path === "/api/products") return await createProduct(body, actor, env);
      const pm = path.match(/^\/api\/products\/([a-z0-9][a-z0-9-]{0,63})(\/stock|\/active|\/duplicate|\/delete)?$/);
      if (pm) {
        const pid = pm[1];
        if (!pm[2] && method === "GET") { const p = await getProduct(pid, env); return p ? json(p) : fail(404, "Product not found"); }
        if (!pm[2] && method === "POST") return await updateProduct(pid, body, actor, env);
        if (pm[2] === "/stock" && method === "POST") return await adjustStock(pid, body, actor, env);
        if (pm[2] === "/active" && method === "POST") return await setActive(pid, body, actor, env);
        if (pm[2] === "/duplicate" && method === "POST") return await duplicateProduct(pid, actor, env);
        if (pm[2] === "/delete" && method === "POST") return await deleteProduct(pid, actor, env);
      }
      return fail(404, "Not found");
    } catch (e) {
      console.error("admin error", e && e.message);
      return fail(500, "Something went wrong");
    }
  },
};
