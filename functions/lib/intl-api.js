// ntagz international storefront API (payments Worker). Mounted by functions/api/[[path]].js under /api/intl/* and /api/webhooks/razorpay.
//   GET  /api/intl/config      public: switch, countries + address rules, payment mode, terms version (cacheable)
//   GET  /api/intl/catalog     public: USD prices, quantity breaks, MOQ, lead time for internationally sold products (cacheable)
//   POST /api/intl/price       server-side price of a cart (the browser never supplies a price)
//   POST /api/intl/orders      submit an order (no payment yet, shipping quotation required)
//   GET  /api/intl/order       the customer's own order, quotation and timeline (secret link token)
//   POST /api/intl/order/quote customer accepts or declines the current quotation
//   POST /api/intl/enquiries   bulk / custom / shipping-quote enquiry (honeypot + rate limit)
//   POST /api/webhooks/razorpay authenticated provider events (signature + idempotent); a customer redirect is never proof of payment
// Nothing here marks an order paid except a verified provider event whose currency and amount match the accepted quotation.

const INTL = require("./intl.js");
const NOTIFY = require("../../admin/src/notify.js");

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
function safeEqual(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
const nowS = () => Math.floor(Date.now() / 1000);

let cache = { db: null, at: 0, settings: null, countries: null, catalog: null };
const resetIntlCache = () => { cache = { db: null, at: 0, settings: null, countries: null, catalog: null }; };

async function settingsOf(env) {
  if (cache.db === env.DB && Date.now() - cache.at < 30000 && cache.settings) return cache.settings;
  let s = { enabled: false, paymentMode: "none", quoteValidDays: 7, hosts: "", termsVersion: "" }, countries = [], catalog = { rows: {}, tiers: {} };
  try {
    const cfg = Object.fromEntries((await env.DB.prepare("SELECT key,value FROM membership_config WHERE key LIKE 'intl_%'").all()).results.map((r) => [r.key, r.value]));
    s = { enabled: cfg.intl_enabled === "1", paymentMode: cfg.intl_payment_mode === "manual_link" ? "manual_link" : "none", quoteValidDays: Math.min(Math.max(parseInt(cfg.intl_quote_valid_days, 10) || 7, 1), 60), hosts: cfg.intl_paylink_hosts || "", termsVersion: cfg.intl_terms_version || "" };
    if (s.enabled) {
      countries = (await env.DB.prepare("SELECT * FROM intl_countries WHERE enabled=1 ORDER BY sort_order, name").all()).results;
      const prods = (await env.DB.prepare(`SELECT id,name,active,price_usd_cents,intl_enabled,intl_moq,intl_lead_days,intl_custom_quote,weight_g,dims_mm,intl_tax_treatment FROM products WHERE intl_enabled=1`).all()).results;
      const tiers = (await env.DB.prepare("SELECT product_id,min_qty,unit_cents FROM product_intl_tiers").all()).results;
      for (const p of prods) catalog.rows[p.id] = p;
      for (const t of tiers) (catalog.tiers[t.product_id] = catalog.tiers[t.product_id] || []).push({ min_qty: t.min_qty, unit_cents: t.unit_cents });
    }
  } catch (e) { s.enabled = false; } // migration not applied yet: international stays off, domestic is untouched
  cache = { db: env.DB, at: Date.now(), settings: s, countries, catalog };
  return s;
}
const countryOf = (code) => (cache.countries || []).find((c) => c.code === String(code || "").toUpperCase());

const publicCountry = (c) => ({ code: c.code, name: c.name, dial: c.dial_code, regionLabel: c.region_label, regionRequired: !!c.region_required, postalLabel: c.postal_label, postalRequired: !!c.postal_required, postalRegex: c.postal_regex });

async function expireIfNeeded(env, order) {
  if (order.quote_status !== "sent") return order;
  const q = await env.DB.prepare("SELECT id,expires_at FROM intl_quotes WHERE order_id=? AND status='sent' ORDER BY version DESC LIMIT 1").bind(order.id).first();
  if (q && q.expires_at <= nowS()) {
    await env.DB.batch([
      env.DB.prepare("UPDATE intl_quotes SET status='expired' WHERE id=? AND status='sent' AND expires_at<=unixepoch()").bind(q.id),
      env.DB.prepare("UPDATE orders SET quote_status='expired', updated_at=unixepoch() WHERE id=? AND quote_status='sent' AND EXISTS (SELECT 1 FROM intl_quotes WHERE id=? AND status='expired')").bind(order.id, q.id),
      env.DB.prepare("INSERT INTO order_events (id,order_id,kind,status,public_note,customer_visible,actor,idempotency_key) SELECT ?1,?2,'quote','quote_expired','Shipping quotation expired. Contact us for a new one.',1,'system',?3 WHERE EXISTS (SELECT 1 FROM intl_quotes WHERE id=?4 AND status='expired')").bind(crypto.randomUUID(), order.id, "expire-" + q.id, q.id),
    ]).catch(() => {});
    return { ...order, quote_status: "expired" };
  }
  return order;
}

const orderLink = (o) => `https://ntagz.com/order/international.html?o=${encodeURIComponent(o.id)}&t=${o.track_token}`;

async function customerView(env, o, st) {
  o = await expireIfNeeded(env, o);
  const [quotes, events, pays, ships] = await Promise.all([
    env.DB.prepare("SELECT * FROM intl_quotes WHERE order_id=? AND status<>'superseded' ORDER BY version DESC LIMIT 1").bind(o.id).all(),
    env.DB.prepare("SELECT kind,status,public_note,created_at FROM order_events WHERE order_id=? AND customer_visible=1 ORDER BY created_at, rowid").bind(o.id).all(),
    env.DB.prepare("SELECT amount_paise,currency,created_at FROM payments WHERE order_id=? ORDER BY created_at, rowid").bind(o.id).all(),
    env.DB.prepare("SELECT courier,awb,tracking_url,shipped_on,est_delivery FROM shipments WHERE order_id=? ORDER BY created_at, rowid").bind(o.id).all(),
  ]);
  const q = quotes.results[0] || null, items = (() => { try { return JSON.parse(o.items_json || "[]"); } catch { return []; } })();
  const names = Object.fromEntries((cache.catalog && cache.catalog.rows ? Object.values(cache.catalog.rows) : []).map((p) => [p.id, p.name]));
  const outstanding = Math.max(o.total - o.paid_paise, 0);
  const canPay = o.quote_status === "accepted" && outstanding > 0 && o.payment_status !== "paid";
  return {
    orderNumber: o.txn_id, createdAt: o.created_at, currency: o.currency, country: o.country, name: o.name,
    items: items.map((i) => ({ id: i.id, name: names[i.id] || i.name || i.id, qty: i.qty, unitMinor: i.unit_cents ?? null, lineMinor: i.line_cents ?? null })),
    productsMinor: o.subtotal, totalMinor: o.total, paidMinor: o.paid_paise, outstandingMinor: outstanding,
    paymentStatus: o.payment_status, quoteStatus: o.quote_status, destinationStatus: o.destination_status, fulfilment: o.status,
    priceNote: o.quote_status === "accepted" ? "Final payable amount, as accepted." : "Product subtotal only. Shipping is quoted separately and is not included yet.",
    quote: q ? { id: q.id, version: q.version, status: q.status, currency: q.currency, productsMinor: q.products_minor, shippingMinor: q.shipping_minor, taxesMinor: q.taxes_minor, otherMinor: q.other_minor, totalMinor: q.total_minor,
      type: q.quote_type, typeLabel: INTL.QUOTE_TYPE_LABEL[q.quote_type], carrier: q.carrier, method: q.method, estFrom: q.est_from, estTo: q.est_to, expiresAt: q.expires_at, chargesNote: q.charges_note } : null, // q.note is internal and never sent to the customer
    payment: { mode: st.paymentMode, canPay, link: canPay && st.paymentMode === "manual_link" && o.pay_link_url ? o.pay_link_url : null, linkAmountMinor: o.pay_link_minor || null,
      message: o.payment_status === "paid" ? "Payment received. Thank you." : !canPay ? "Payment is requested only after you accept the shipping quotation." : st.paymentMode === "none" ? "Payment instructions will follow once we confirm the order." : (o.pay_link_url ? "Use the secure payment link below for the outstanding amount." : "We will email you a secure payment link for the outstanding amount.") },
    timeline: [{ at: o.created_at, label: "Order received" }, ...events.results.map((e) => ({ at: e.created_at, label: e.public_note || e.status || e.kind })),
      ...pays.results.map((p) => ({ at: p.created_at, label: `Payment received (${INTL.money(p.amount_paise, p.currency)})` }))].sort((a, b) => a.at - b.at),
    shipments: ships.results, termsVersion: o.terms_version,
  };
}

async function handleIntl(url, request, env, origin, d) {
  const J = (data, status = 200, extra) => { const r = d.json(data, status, origin); if (extra) for (const [k, v] of Object.entries(extra)) r.headers.set(k, v); return r; };
  const path = url.pathname;
  if (!env.DB) return J({ error: "Service temporarily unavailable" }, 503);
  const st = await settingsOf(env);
  const isGet = request.method === "GET";

  if (path.endsWith("/intl/config") && isGet) {
    const body = st.enabled ? { enabled: true, paymentMode: st.paymentMode, termsVersion: st.termsVersion, quoteValidDays: st.quoteValidDays, countries: cache.countries.map(publicCountry) } : { enabled: false };
    return J(body, 200, { "Cache-Control": "public, max-age=300" });
  }
  if (path.endsWith("/intl/catalog") && isGet) {
    if (!st.enabled) return J({ enabled: false, products: [] }, 200, { "Cache-Control": "public, max-age=300" });
    const products = Object.values(cache.catalog.rows).filter((p) => p.active && p.price_usd_cents).map((p) => ({ id: p.id, name: p.name, priceCents: p.price_usd_cents,
      tiers: (cache.catalog.tiers[p.id] || []).sort((a, b) => a.min_qty - b.min_qty).map((t) => ({ minQty: t.min_qty, unitCents: t.unit_cents })), moq: p.intl_moq || 1, leadDays: p.intl_lead_days || null,
      customQuote: !!p.intl_custom_quote, taxTreatment: p.intl_tax_treatment || "excl", weightG: p.weight_g || null, dimsMm: p.dims_mm || null }));
    return J({ enabled: true, currency: "USD", products }, 200, { "Cache-Control": "public, max-age=300" });
  }

  // Everything below changes state or returns a customer's own data: same-site browsers only, and never cached.
  if (origin && !["https://www.ntagz.com", "https://ntagz.com"].includes(origin)) return J({ error: "Origin not allowed" }, 403);
  const body = async () => {
    if (Number(request.headers.get("Content-Length")) > 20000) throw Object.assign(new Error("too large"), { status: 413 });
    try { return await request.json(); } catch { throw Object.assign(new Error("bad json"), { status: 400 }); }
  };
  try {
    if (path.endsWith("/intl/price") && request.method === "POST") {
      if (!st.enabled) return J({ error: "International ordering is not available yet" }, 404);
      const b = await body(), p = INTL.priceIntlCart(b.items, cache.catalog.rows, cache.catalog.tiers);
      if (p.error) return J({ error: p.error, id: p.id, custom: !!p.custom }, 400);
      return J({ ...p, shipping: "quotation_required" });
    }

    if (path.endsWith("/intl/orders") && request.method === "POST") {
      if (!st.enabled) return J({ error: "International ordering is not available yet" }, 404);
      const b = await body();
      if (typeof b.website === "string" && b.website.trim() !== "") return J({ ok: true }, 200); // honeypot: pretend success, store nothing
      const country = countryOf(b.country);
      if (!country) return J({ error: "We cannot take online orders for that destination yet. Please send us an enquiry.", fields: { country: "Unsupported destination" } }, 400);
      const { errors, value: v } = INTL.validateOrderDetails(b, country);
      if (b.accept_terms !== true) errors.accept_terms = "Please confirm you have read the terms and policies";
      const sub = typeof b.submission_id === "string" && /^[0-9a-f-]{36}$/i.test(b.submission_id) ? b.submission_id.toLowerCase() : null;
      if (!sub) errors.submission_id = "Please reload the page and try again";
      if (Object.keys(errors).length) return J({ error: "Please fix the highlighted fields", fields: errors }, 400);
      const priced = INTL.priceIntlCart(b.items, cache.catalog.rows, cache.catalog.tiers);
      if (priced.error) return J({ error: priced.error }, 400);
      const pricing = await d.loadPricing(env), blocked = d.unavailableReason(b.items, pricing);
      if (blocked) return J({ error: blocked }, 409);
      const existing = await env.DB.prepare("SELECT id,txn_id,track_token FROM orders WHERE market='INTL' AND quote_ref=?").bind(sub).first();
      if (existing) return J({ ok: true, orderNumber: existing.txn_id, viewUrl: orderLink(existing), repeat: true });
      const ipHash = await sha256(`ntagz:${request.headers.get("CF-Connecting-IP") || "unknown"}`);
      const recent = await env.DB.prepare("SELECT count(*) c FROM order_attempts WHERE ip_hash=? AND created_at>unixepoch()-600").bind(ipHash).first();
      if (recent.c >= 5) return J({ error: "Too many orders from this connection. Please try again later or contact us." }, 429);
      const u = await d.getSession(request, env);
      const id = crypto.randomUUID(), token = toHex(crypto.getRandomValues(new Uint8Array(16)));
      const items = priced.lines.map((l) => ({ id: l.id, qty: l.qty, unit_cents: l.unitCents, line_cents: l.lineCents }));
      let orderNumber = "", saved = false;
      for (let attempt = 0; attempt < 3 && !saved; attempt++) {
        orderNumber = "INT-" + Math.floor(Date.now() / 1000).toString(36).toUpperCase() + "-" + toHex(crypto.getRandomValues(new Uint8Array(2))).toUpperCase();
        try {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM order_attempts WHERE created_at < unixepoch() - 86400"),
            env.DB.prepare("INSERT INTO order_attempts (ip_hash) VALUES (?)").bind(ipHash),
            env.DB.prepare(`INSERT INTO orders (id,user_id,txn_id,gateway,quote_ref,items_json,name,phone,email,address,pincode,state,gstin,subtotal,gst,total,payment_method,payment_status,paid_paise,status,track_token,
                              market,currency,country,city,company,tax_id,order_notes,price_list,quote_status,destination_status,terms_version,terms_accepted_at,shipping_paise,discount_paise,qualifying_paise)
                            VALUES (?1,?2,?3,'intl',?4,?5,?6,?7,?8,?9,?10,?11,NULL,?12,0,?12,'intl','unpaid',0,'placed',?13,
                              'INTL','USD',?14,?15,?16,?17,?18,?19,'required','pending',?20,unixepoch(),0,0,0)`)
              .bind(id, u ? u.user_id : null, orderNumber, sub, JSON.stringify(items), v.name, v.phone, v.email, v.address2 ? `${v.address1}\n${v.address2}` : v.address1, v.postal || null, v.region || null,
                priced.subtotalCents, token, country.code, v.city, v.company || null, v.tax_id || null, v.notes || null, priced.priceList, st.termsVersion || null),
            env.DB.prepare("INSERT INTO order_events (id,order_id,kind,status,public_note,customer_visible,actor,idempotency_key) VALUES (?,?,'status','placed','Order received. Shipping quotation required.',1,'customer',?)").bind(crypto.randomUUID(), id, "placed-" + id),
            ...d.stockStatements(env, id, orderNumber, items),
          ]);
          saved = true;
        } catch (e) { if (!/UNIQUE|constraint/i.test(String(e && e.message)) || attempt === 2) throw e; }
      }
      await NOTIFY.notify(env, id, "intl_order_received", "received-" + id);
      return J({ ok: true, orderNumber, viewUrl: orderLink({ id, track_token: token }), currency: "USD", productsMinor: priced.subtotalCents });
    }

    if (path.endsWith("/intl/order") && isGet) {
      const o = await orderByToken(env, url.searchParams.get("o"), url.searchParams.get("t"));
      if (!o) return J({ error: "Not found" }, 404);
      return J(await customerView(env, o, st));
    }

    if (path.endsWith("/intl/order/quote") && request.method === "POST") {
      const b = await body();
      const o0 = await orderByToken(env, b.o, b.t);
      if (!o0) return J({ error: "Not found" }, 404);
      const o = await expireIfNeeded(env, o0);
      const decision = b.decision === "accept" ? "accepted" : b.decision === "decline" ? "declined" : null;
      if (!decision) return J({ error: "Choose accept or decline" }, 400);
      const q = await env.DB.prepare("SELECT * FROM intl_quotes WHERE id=? AND order_id=?").bind(String(b.quote_id || ""), o.id).first();
      if (!q) return J({ error: "Quotation not found" }, 404);
      if (q.status === decision) return J(await customerView(env, o, st)); // repeat of the same decision: no change, no duplicate
      if (q.status !== "sent" || o.quote_status !== "sent") return J({ error: q.status === "expired" ? "This quotation has expired. Please contact us for a new one." : q.status === "superseded" ? "A newer quotation has been sent. Please use the latest one." : "This quotation has already been answered." }, 409);
      if (o.destination_status === "rejected") return J({ error: "This order cannot be accepted. Please contact us." }, 409);
      const note = INTL.clean(b.note, 300) || null, ipHash = await sha256(`ntagz:${request.headers.get("CF-Connecting-IP") || "unknown"}`);
      const accepted = decision === "accepted";
      const res = await env.DB.batch([
        env.DB.prepare("UPDATE intl_quotes SET status=?2, decided_at=unixepoch(), decided_by='customer', decision_note=?3 WHERE id=?1 AND status='sent' AND expires_at>unixepoch()").bind(q.id, decision, note),
        env.DB.prepare(`UPDATE orders SET quote_status=?2, ${accepted ? "total=?3, shipping_paise=?4, gst=?5," : ""} updated_at=unixepoch() WHERE id=?1 AND quote_status='sent' AND changes()=1`)
          .bind(...(accepted ? [o.id, decision, q.total_minor, q.shipping_minor, q.taxes_minor] : [o.id, decision])),
        env.DB.prepare("INSERT INTO order_events (id,order_id,kind,status,note,public_note,customer_visible,actor,idempotency_key) SELECT ?1,?2,'quote',?3,?4,?5,1,'customer',?6 WHERE EXISTS (SELECT 1 FROM intl_quotes WHERE id=?7 AND status=?8)")
          .bind(crypto.randomUUID(), o.id, "quote_" + decision, note, accepted ? "Shipping quotation accepted by customer." : "Shipping quotation declined by customer.", `quote-${decision}-${q.id}`, q.id, decision),
      ]);
      if (res[0].meta.changes !== 1) return J({ error: "This quotation can no longer be answered. Please refresh." }, 409);
      await NOTIFY.notify(env, o.id, accepted ? "intl_quote_accepted" : "intl_quote_declined", `quote-${decision}-${q.id}`, { quote: q });
      if (accepted && st.paymentMode === "manual_link") await NOTIFY.notify(env, o.id, "intl_payment_pending", `pay-pending-${q.id}`, { quote: q });
      return J(await customerView(env, await orderByToken(env, b.o, b.t), st));
    }

    if (path.endsWith("/intl/enquiries") && request.method === "POST") {
      if (!st.enabled) return J({ error: "International enquiries are not open yet. Please email us." }, 404);
      const b = await body();
      if (typeof b.website === "string" && b.website.trim() !== "") return J({ ok: true }); // honeypot
      const errors = {}, name = INTL.clean(b.name, 100), email = INTL.clean(b.email, 254).toLowerCase(), country = INTL.clean(b.country, 60);
      if (name.length < 2) errors.name = "Enter your name"; if (!INTL.EMAIL.test(email)) errors.email = "Enter a valid email"; if (country.length < 2) errors.country = "Select your country";
      const message = INTL.clean(b.message, 3000), product = INTL.clean(b.product, 300), quantity = INTL.clean(b.quantity, 60);
      if (message.length < 5 && product.length < 2) errors.message = "Tell us what you need";
      if (Object.keys(errors).length) return J({ error: "Please fix the highlighted fields", fields: errors }, 400);
      const ipHash = await sha256(`ntagz:${request.headers.get("CF-Connecting-IP") || "unknown"}`);
      const recent = await env.DB.prepare("SELECT count(*) c FROM intl_enquiries WHERE ip_hash=? AND created_at>unixepoch()-3600").bind(ipHash).first();
      if (recent.c >= 3) return J({ error: "Too many enquiries from this connection. Please email us instead." }, 429);
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO intl_enquiries (id,name,email,country,company,product,quantity,customization,shipping_pref,message,ip_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id, name, email, country, INTL.clean(b.company, 120) || null, product || null, quantity || null, INTL.clean(b.customization, 1500) || null, INTL.clean(b.shipping_pref, 80) || null, message || null, ipHash).run();
      if (env.RESEND_API_KEY) { // best effort: the enquiry is already saved and visible in the admin
        await fetch("https://api.resend.com/emails", { method: "POST", signal: AbortSignal.timeout(6000), headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: "ntagz <hello@ntagz.com>", to: ["hello@ntagz.com"], reply_to: email, subject: `International enquiry from ${country}`, text: `${name} <${email}>\nCountry: ${country}\nCompany: ${INTL.clean(b.company, 120)}\nProduct: ${product}\nQuantity: ${quantity}\nShipping: ${INTL.clean(b.shipping_pref, 80)}\n\n${INTL.clean(b.customization, 1500)}\n\n${message}` }) }).catch(() => null);
      }
      return J({ ok: true, reference: id.slice(0, 8).toUpperCase() });
    }
    return J({ error: "Not found" }, 404);
  } catch (e) {
    if (e && e.status) return J({ error: e.status === 413 ? "Request too large" : "Invalid request" }, e.status);
    console.error("intl api failed:", e && e.message);
    return J({ error: "Something went wrong. Please try again." }, 500);
  }
}

async function orderByToken(env, id, token) {
  if (typeof id !== "string" || typeof token !== "string" || !/^[0-9a-fA-F-]{8,64}$/.test(id) || !/^[0-9a-f]{32}$/.test(token)) return null;
  const o = await env.DB.prepare("SELECT * FROM orders WHERE id=? AND market='INTL'").bind(id).first();
  return o && safeEqual(String(o.track_token || ""), token) ? o : null;
}

// ── Razorpay webhook (international orders) ─────────────────────────────────────────────────────────────
// The signature is verified by the single existing webhook endpoint (functions/api/[[path]].js: /api/razorpay/webhook), which hands
// international events (order reference INT-...) here. Deduplicated by event id and by payment id. Only a captured payment whose
// currency matches the order and whose amount fits the outstanding balance of an ACCEPTED quotation is recorded as paid.
const refOf = (ev) => {
  const pay = ev && ev.payload && ev.payload.payment && ev.payload.payment.entity, link = ev && ev.payload && ev.payload.payment_link && ev.payload.payment_link.entity;
  const ord = ev && ev.payload && ev.payload.order && ev.payload.order.entity;
  return String((pay && pay.notes && (pay.notes.order_ref || pay.notes.reference_id)) || (link && link.reference_id) || (ord && ord.notes && ord.notes.order_ref) || (ord && ord.receipt) || "");
};
// A refund event carries only the payment id, so it is international when that payment belongs to an international order.
async function isIntlEvent(ev, env) {
  if (/^INT-/.test(refOf(ev))) return true;
  const rf = ev && ev.payload && ev.payload.refund && ev.payload.refund.entity;
  if (!rf || !rf.payment_id) return false;
  return !!(await env.DB.prepare("SELECT 1 x FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.reference=? AND o.market='INTL' LIMIT 1").bind(String(rf.payment_id)).first().catch(() => null));
}

async function processIntlEvent(ev, eventId, env, d) {
  const J = (data, status = 200) => d.json(data, status, "https://www.ntagz.com");
  const type = String(ev.event || "");
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO provider_events (provider,event_id,type,outcome) VALUES ('razorpay',?,?,'received')").bind(eventId, type.slice(0, 60)).run();
  if (ins.meta.changes !== 1) return J({ ok: true, duplicate: true });
  const setOutcome = (outcome, orderId) => env.DB.prepare("UPDATE provider_events SET outcome=?, order_id=? WHERE provider='razorpay' AND event_id=?").bind(outcome, orderId || null, eventId).run();
  const pay = ev.payload && ev.payload.payment && ev.payload.payment.entity, ref = ev.payload && ev.payload.refund && ev.payload.refund.entity;
  const orderRef = refOf(ev);
  const findOrder = async (txn) => (txn ? env.DB.prepare("SELECT * FROM orders WHERE txn_id=? AND market='INTL'").bind(String(txn)).first() : null);

  if (type === "payment.captured" || type === "payment_link.paid" || type === "order.paid") {
    if (!pay || !pay.id || !Number.isSafeInteger(pay.amount) || pay.amount <= 0) { await setOutcome("ignored"); return J({ ok: true }); }
    const o = await findOrder(orderRef);
    if (!o) { await d.alertPayment(env, String(orderRef || pay.id), "razorpay", pay.id, pay.amount, "payment for an unknown international order"); await setOutcome("unmatched"); return J({ ok: true }); }
    const outstanding = o.total - o.paid_paise;
    const problem = String(pay.currency).toUpperCase() !== o.currency ? `currency ${pay.currency} does not match order currency ${o.currency}`
      : o.quote_status !== "accepted" ? "shipping quotation not accepted yet" : pay.status && pay.status !== "captured" ? `payment status is ${pay.status}` : pay.amount > outstanding ? `amount ${pay.amount} exceeds outstanding ${outstanding}` : null;
    if (problem) { await d.alertPayment(env, o.txn_id, "razorpay", pay.id, pay.amount, problem); await setOutcome("rejected", o.id); return J({ ok: true }); }
    const eid = crypto.randomUUID();
    const res = await env.DB.batch([
      // one provider payment id can only ever be recorded once, on one order
      env.DB.prepare("INSERT INTO payments (id,order_id,method,amount_paise,recorded_by,idempotency_key,reference,currency) SELECT ?,?, 'razorpay',?, 'gateway',?,?,? WHERE NOT EXISTS (SELECT 1 FROM payments WHERE reference=?)").bind(crypto.randomUUID(), o.id, pay.amount, "rzp:" + pay.id, pay.id, o.currency, pay.id),
      env.DB.prepare("UPDATE orders SET paid_paise=paid_paise+?2, payment_status=CASE WHEN paid_paise+?2>=total THEN 'paid' ELSE payment_status END, updated_at=unixepoch() WHERE id=?1 AND changes()=1").bind(o.id, pay.amount),
      env.DB.prepare("INSERT INTO order_events (id,order_id,kind,status,public_note,customer_visible,actor,idempotency_key) SELECT ?1,?2,'payment','payment_received',?3,1,'webhook',?4 WHERE EXISTS (SELECT 1 FROM payments WHERE idempotency_key=?5)")
        .bind(eid, o.id, `Payment received (${INTL.money(pay.amount, o.currency)}).`, "pay-" + pay.id, "rzp:" + pay.id),
    ]).catch(() => null);
    if (!res) { await setOutcome("error", o.id); return J({ error: "retry" }, 500); }
    await setOutcome(res[0].meta.changes === 1 ? "recorded" : "duplicate", o.id);
    if (res[0].meta.changes === 1) await NOTIFY.notify(env, o.id, "payment_confirmed", "pay-" + pay.id);
    return J({ ok: true });
  }
  if (type === "payment.failed" || type === "payment.authorized") {
    const o = await findOrder(orderRef);
    if (o && pay) await env.DB.prepare("INSERT OR IGNORE INTO order_events (id,order_id,kind,status,note,customer_visible,actor,idempotency_key) VALUES (?,?,'payment',?,?,0,'webhook',?)")
      .bind(crypto.randomUUID(), o.id, type === "payment.failed" ? "payment_failed" : "payment_authorized", `${type} ${pay.id}`, "evt-" + eventId).run();
    await setOutcome(type === "payment.failed" ? "failed_noted" : "authorized_noted", o && o.id); // never marks anything paid
    return J({ ok: true });
  }
  if ((type === "refund.processed" || type === "refund.created") && ref && ref.id) {
    const p = await env.DB.prepare("SELECT order_id,currency FROM payments WHERE reference=? AND method='razorpay'").bind(String(ref.payment_id || "")).first();
    const o = p ? await env.DB.prepare("SELECT id,paid_paise,refunded_paise,currency FROM orders WHERE id=? AND market='INTL'").bind(p.order_id).first() : null;
    if (!o || !Number.isSafeInteger(ref.amount) || ref.amount <= 0 || ref.amount > o.paid_paise - o.refunded_paise || String(ref.currency || o.currency).toUpperCase() !== o.currency) { await setOutcome(o ? "rejected" : "unmatched", o && o.id); return J({ ok: true }); }
    const res = await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO order_refunds (id,order_id,amount_paise,reason,actor,idempotency_key,currency) VALUES (?,?,?,?,'webhook',?,?)").bind(crypto.randomUUID(), o.id, ref.amount, `Provider refund ${ref.id}`, "rzp:" + ref.id, o.currency),
      env.DB.prepare("UPDATE orders SET refunded_paise=refunded_paise+?2, updated_at=unixepoch() WHERE id=?1 AND changes()=1").bind(o.id, ref.amount),
      env.DB.prepare("INSERT INTO order_events (id,order_id,kind,status,public_note,customer_visible,actor,idempotency_key) SELECT ?1,?2,'payment','refund_recorded',?3,1,'webhook',?4 WHERE EXISTS (SELECT 1 FROM order_refunds WHERE idempotency_key=?5)")
        .bind(crypto.randomUUID(), o.id, `Refund of ${INTL.money(ref.amount, o.currency)} processed.`, "refund-" + ref.id, "rzp:" + ref.id),
    ]).catch(() => null);
    await setOutcome(res && res[0].meta.changes === 1 ? "recorded" : res ? "duplicate" : "error", o.id);
    if (res && res[0].meta.changes === 1) await NOTIFY.notify(env, o.id, "intl_refund", "refund-" + ref.id, { amount: ref.amount });
    return J({ ok: true });
  }
  await setOutcome("ignored");
  return J({ ok: true });
}

module.exports = { handleIntl, isIntlEvent, processIntlEvent, resetIntlCache, settingsOf, hmacHex };
