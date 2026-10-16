// International orders: admin side. Every action is validated here, applied in one atomic batch guarded by the order's current state
// (a stale screen or a double click changes nothing), written to order_events (customer-visible timeline) and audit_log (who/what/when).
// The admin can never edit an order's product prices, and can never mark a payment received without a reference and explicit confirmation.
import INTL from "../../functions/lib/intl.js";

const nowS = () => Math.floor(Date.now() / 1000);
const text = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const validDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "") && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const endOfDay = (v) => Math.floor(Date.parse(`${v}T00:00:00Z`) / 1000) + 86399;
const uuid = () => crypto.randomUUID();
const keyOf = (b) => (typeof b.idempotency_key === "string" && b.idempotency_key.length >= 8 ? b.idempotency_key.slice(0, 64) : "");

let schema = { db: null, at: 0, ok: false };
export async function hasIntl(env) {
  if (schema.db === env.DB && (schema.ok || Date.now() - schema.at < 60000)) return schema.ok;
  let ok = false;
  try { ok = !!(await env.DB.prepare("SELECT 1 x FROM pragma_table_info('orders') WHERE name='quote_status'").first()); } catch { ok = false; }
  schema = { db: env.DB, at: Date.now(), ok };
  return ok;
}
export const resetIntlSchemaCache = () => { schema = { db: null, at: 0, ok: false }; };
export const INTL_COLS = ",market,currency,country,city,company,tax_id,order_notes,price_list,quote_status,destination_status,terms_version,terms_accepted_at,pay_link_url,pay_link_minor,dispatch_override_reason";

const EVENT_LABEL = { quote_sent: "Shipping quotation sent", quote_accepted: "Shipping quotation accepted", quote_declined: "Shipping quotation declined", quote_expired: "Shipping quotation expired",
  destination_approved: "Destination approved", destination_rejected: "Destination not supported", payment_link: "Payment link sent", payment_received: "Payment received", payment_failed: "Payment attempt failed", payment_authorized: "Payment authorised (not yet captured)", refund_recorded: "Refund recorded" };
export const eventLabel = (e) => EVENT_LABEL[e.status] || null;

const audit = (env, actor, action, orderId, detail, guard) =>
  env.DB.prepare(`INSERT INTO audit_log (id,actor,action,order_id,detail) SELECT ?1,?2,?3,?4,?5 ${guard || ""}`).bind(uuid(), actor, action, orderId, JSON.stringify(detail));

async function orderOf(env, id) {
  return env.DB.prepare("SELECT id,market,currency,status,payment_status,subtotal,total,paid_paise,quote_status,destination_status,pay_link_url FROM orders WHERE id=?").bind(id).first();
}
const needIntl = (o) => (!o ? [404, "Order not found"] : o.market !== "INTL" ? [409, "This is not an international order"] : ["cancelled", "returned"].includes(o.status) ? [409, "This order is cancelled"] : null);

// ── what getOrder adds for an international order ─────────────────────────────────────────
export async function orderExtras(env, o) {
  if (!o || o.market !== "INTL") return {};
  const [quotes, pays] = await Promise.all([
    env.DB.prepare("SELECT id,version,status,currency,products_minor,shipping_minor,taxes_minor,other_minor,total_minor,quote_type,carrier,method,est_from,est_to,expires_at,charges_note,note,created_by,created_at,decided_at,decided_by,decision_note FROM intl_quotes WHERE order_id=? ORDER BY version DESC").bind(o.id).all(),
    env.DB.prepare("SELECT method,amount_paise,currency,recorded_by,reference,created_at FROM payments WHERE order_id=? ORDER BY created_at, rowid").bind(o.id).all(),
  ]);
  const cfg = Object.fromEntries((await env.DB.prepare("SELECT key,value FROM membership_config WHERE key LIKE 'intl_%'").all()).results.map((r) => [r.key, r.value]));
  return { intl: { quotes: quotes.results.map((q) => ({ ...q, type_label: INTL.QUOTE_TYPE_LABEL[q.quote_type] })), payments: pays.results, quote_valid_days: Number(cfg.intl_quote_valid_days) || 7,
    payment_mode: cfg.intl_payment_mode || "none", customer_link: null } };
}

// ── destination review ────────────────────────────────────────────────────────────────────
export async function destinationDecision(id, b, actor, env, d) {
  const o = await orderOf(env, id), bad = needIntl(o); if (bad) return d.fail(bad[0], bad[1]);
  const decision = b.decision === "approve" ? "approved" : b.decision === "reject" ? "rejected" : null;
  if (!decision) return d.fail(400, "Choose approve or reject");
  const note = text(b.note, 300);
  if (decision === "rejected" && note.length < 5) return d.json({ error: "Give a short reason for the customer", fields: { note: "Reason required" } }, 400);
  const key = keyOf(b) || uuid();
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE orders SET destination_status=?2, updated_at=unixepoch() WHERE id=?1 AND market='INTL' AND coalesce(destination_status,'')<>?2 AND status NOT IN ('cancelled','returned')").bind(id, decision),
    env.DB.prepare("INSERT INTO order_events (id,order_id,kind,status,public_note,note,customer_visible,actor,idempotency_key) SELECT ?1,?2,'quote',?3,?4,?5,1,?6,?7 WHERE changes()=1")
      .bind(uuid(), id, decision === "approved" ? "destination_approved" : "destination_rejected", decision === "approved" ? "Destination approved. We will send your shipping quotation." : `We are unable to ship this order to the destination provided. ${note}`, note || null, actor, "dest-" + key),
    audit(env, actor, "intl_destination", id, { decision, note }, "WHERE changes()=1"),
  ]).catch(() => null);
  if (!res || res[0].meta.changes !== 1) return d.fail(409, "The destination already has that decision, or the order changed. Refresh and try again.");
  return d.json(await d.getOrder(id, env));
}

// ── send a shipping quotation ─────────────────────────────────────────────────────────────
export async function sendQuote(id, b, actor, env, d) {
  const o = await orderOf(env, id), bad = needIntl(o); if (bad) return d.fail(bad[0], bad[1]);
  const errors = {};
  const shipping = INTL.toMinor(b.shipping), taxes = INTL.toMinor(b.taxes || 0), other = INTL.toMinor(b.other || 0);
  if (shipping === null) errors.shipping = `Enter the shipping charge in ${o.currency} (0 only if you tick "shipping is included")`;
  else if (shipping === 0 && b.shipping_included !== true) errors.shipping = 'A zero shipping charge must be confirmed with "Shipping is included"';
  if (taxes === null) errors.taxes = "Enter a valid amount, or leave blank";
  if (other === null) errors.other = "Enter a valid amount, or leave blank";
  const carrier = text(b.carrier, 60), method = text(b.method, 80);
  if (!carrier && !method) errors.method = "Enter the carrier or shipping method";
  const estFrom = text(b.est_from, 10), estTo = text(b.est_to, 10);
  if (estFrom && !validDate(estFrom)) errors.est_from = "Enter a valid date"; if (estTo && !validDate(estTo)) errors.est_to = "Enter a valid date";
  if (estFrom && estTo && estTo < estFrom) errors.est_to = "Must not be before the start date";
  const cfgDays = Number((await env.DB.prepare("SELECT value FROM membership_config WHERE key='intl_quote_valid_days'").first())?.value) || 7;
  const expiry = text(b.expires, 10) || new Date(Date.now() + cfgDays * 86400000).toISOString().slice(0, 10);
  let expiresAt = null;
  if (!validDate(expiry)) errors.expires = "Enter the quotation expiry date";
  else { expiresAt = endOfDay(expiry); if (expiresAt <= nowS()) errors.expires = "Expiry must be in the future"; else if (expiresAt > nowS() + 90 * 86400) errors.expires = "Expiry can be at most 90 days away"; }
  const chargesNote = text(b.charges_note, 400), note = text(b.note, 400);
  if (Object.keys(errors).length) return d.json({ error: "Please fix the highlighted fields", fields: errors }, 400);
  if (o.destination_status === "rejected") return d.fail(409, "The destination was rejected. Approve it again before quoting.");
  if (o.quote_status === "accepted" && o.paid_paise > 0) return d.fail(409, "A quotation is already accepted and payment has started. Contact the customer and handle changes manually.");
  if (b.confirm !== true) return d.fail(400, "Please confirm sending this quotation to the customer");
  const key = keyOf(b); if (!key) return d.fail(400, "Missing operation key");
  const total = o.subtotal + shipping + taxes + other, type = INTL.quoteTypeFor(shipping, taxes, other);
  const ver = ((await env.DB.prepare("SELECT max(version) v FROM intl_quotes WHERE order_id=?").bind(id).first()).v || 0) + 1, qid = uuid();
  try {
    const res = await env.DB.batch([
      env.DB.prepare("UPDATE intl_quotes SET status='superseded' WHERE order_id=?1 AND status='sent' AND EXISTS (SELECT 1 FROM orders WHERE id=?1 AND market='INTL' AND status NOT IN ('cancelled','returned') AND coalesce(destination_status,'')<>'rejected' AND subtotal=?2)").bind(id, o.subtotal),
      env.DB.prepare(`INSERT INTO intl_quotes (id,order_id,version,status,currency,products_minor,shipping_minor,taxes_minor,other_minor,total_minor,quote_type,carrier,method,est_from,est_to,expires_at,charges_note,note,created_by)
                      SELECT ?1,id,?2,'sent',currency,subtotal,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15 FROM orders WHERE id=?16 AND market='INTL' AND status NOT IN ('cancelled','returned') AND coalesce(destination_status,'')<>'rejected' AND subtotal=?17`)
        .bind(qid, ver, shipping, taxes, other, total, type, carrier || null, method || null, estFrom || null, estTo || null, expiresAt, chargesNote || null, note || null, actor, id, o.subtotal),
      env.DB.prepare("UPDATE orders SET quote_status='sent', destination_status=CASE WHEN coalesce(destination_status,'pending')='pending' THEN 'approved' ELSE destination_status END, updated_at=unixepoch() WHERE id=?1 AND EXISTS (SELECT 1 FROM intl_quotes WHERE id=?2)").bind(id, qid),
      env.DB.prepare("INSERT INTO order_events (id,order_id,kind,status,public_note,note,customer_visible,actor,idempotency_key) SELECT ?1,?2,'quote','quote_sent',?3,?4,1,?5,?6 WHERE EXISTS (SELECT 1 FROM intl_quotes WHERE id=?7)")
        .bind(uuid(), id, `Shipping quotation sent: ${INTL.money(total, o.currency)} (${INTL.QUOTE_TYPE_LABEL[type]}).`, note || null, actor, "quote-" + key, qid),
      audit(env, actor, "intl_quote_sent", id, { version: ver, shipping, taxes, other, total, type, carrier, method, expires: expiry }, "WHERE EXISTS (SELECT 1 FROM intl_quotes WHERE id='" + qid + "')"),
    ]);
    if (res[1].meta.changes !== 1) return d.fail(409, "The order changed while you were working (cancelled, destination rejected, or prices changed). Refresh and try again.");
  } catch { return d.json(await d.getOrder(id, env)); } // same key replayed, or a concurrent quote won the version number
  const q = await env.DB.prepare("SELECT * FROM intl_quotes WHERE id=?").bind(qid).first();
  await d.notify(env, id, "intl_quote_sent", "quote-sent-" + qid, { quote: q });
  return d.json(await d.getOrder(id, env));
}

// ── an admin records a customer's decision that was given outside the site (email, phone) ──
export async function recordQuoteDecision(id, qid, b, actor, env, d) {
  const o = await orderOf(env, id), bad = needIntl(o); if (bad) return d.fail(bad[0], bad[1]);
  const decision = b.decision === "accepted" ? "accepted" : b.decision === "declined" ? "declined" : null;
  const why = text(b.reason, 300);
  if (!decision) return d.fail(400, "Choose accepted or declined");
  if (why.length < 8) return d.json({ error: "Record how and when the customer told you (e.g. email on 12 Oct)", fields: { reason: "Required" } }, 400);
  if (b.confirm !== true) return d.fail(400, "Please confirm you have the customer's explicit decision");
  const q = await env.DB.prepare("SELECT * FROM intl_quotes WHERE id=? AND order_id=?").bind(qid, id).first();
  if (!q) return d.fail(404, "Quotation not found");
  const accepted = decision === "accepted", key = keyOf(b) || uuid();
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE intl_quotes SET status=?2, decided_at=unixepoch(), decided_by=?3, decision_note=?4 WHERE id=?1 AND status='sent' AND expires_at>unixepoch()").bind(qid, decision, actor, "Recorded by staff: " + why),
    env.DB.prepare(`UPDATE orders SET quote_status=?2, ${accepted ? "total=?3, shipping_paise=?4, gst=?5," : ""} updated_at=unixepoch() WHERE id=?1 AND quote_status='sent' AND changes()=1`).bind(...(accepted ? [id, decision, q.total_minor, q.shipping_minor, q.taxes_minor] : [id, decision])),
    env.DB.prepare("INSERT INTO order_events (id,order_id,kind,status,public_note,note,customer_visible,actor,idempotency_key) SELECT ?1,?2,'quote',?3,?4,?5,1,?6,?7 WHERE EXISTS (SELECT 1 FROM intl_quotes WHERE id=?8 AND status=?9)")
      .bind(uuid(), id, "quote_" + decision, accepted ? "Shipping quotation accepted (recorded by our team)." : "Shipping quotation declined (recorded by our team).", why, actor, `quote-${decision}-${qid}`, qid, decision),
    audit(env, actor, "intl_quote_decision", id, { quote: qid, decision, reason: why }, `WHERE EXISTS (SELECT 1 FROM intl_quotes WHERE id='${qid}' AND status='${decision}')`),
  ]).catch(() => null);
  if (!res || res[0].meta.changes !== 1) return d.fail(409, "That quotation can no longer be answered (already decided, expired or superseded). Refresh and check.");
  await d.notify(env, id, accepted ? "intl_quote_accepted" : "intl_quote_declined", `quote-${decision}-${qid}`, { quote: q });
  if (accepted) await d.notify(env, id, "intl_payment_pending", `pay-pending-${qid}`, { quote: q });
  return d.json(await d.getOrder(id, env));
}

// ── payment link for the outstanding balance (https + allow-listed host) ──────────────────
export async function attachPaymentLink(id, b, actor, env, d) {
  const o = await orderOf(env, id), bad = needIntl(o); if (bad) return d.fail(bad[0], bad[1]);
  if (o.quote_status !== "accepted") return d.fail(409, "A payment link can only be sent after the customer accepts the quotation");
  const outstanding = o.total - o.paid_paise;
  if (outstanding <= 0 || o.payment_status === "paid") return d.fail(409, "Nothing is outstanding on this order");
  const hosts = (await env.DB.prepare("SELECT value FROM membership_config WHERE key='intl_paylink_hosts'").first())?.value || "";
  const url = INTL.validPaymentLink(b.url, hosts);
  if (!url) return d.json({ error: "Use an https payment link from an allowed provider (see Settings)", fields: { url: "Not an allowed payment link" } }, 400);
  const amount = b.amount === undefined || b.amount === "" ? outstanding : INTL.toMinor(b.amount);
  if (amount === null || amount <= 0 || amount > outstanding) return d.json({ error: `The link amount must be between 0.01 and the outstanding ${INTL.money(outstanding, o.currency)}`, fields: { amount: "Invalid" } }, 400);
  if (b.confirm !== true) return d.fail(400, "Please confirm the link and amount are correct");
  const key = keyOf(b) || uuid();
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE orders SET pay_link_url=?2, pay_link_minor=?3, pay_link_at=unixepoch(), updated_at=unixepoch() WHERE id=?1 AND quote_status='accepted' AND total-paid_paise=?4").bind(id, url, amount, outstanding),
    env.DB.prepare("INSERT INTO order_events (id,order_id,kind,status,public_note,customer_visible,actor,idempotency_key) SELECT ?1,?2,'payment','payment_link',?3,1,?4,?5 WHERE changes()=1")
      .bind(uuid(), id, `Payment link sent for ${INTL.money(amount, o.currency)}.`, actor, "link-" + key),
    audit(env, actor, "intl_payment_link", id, { amount, host: new URL(url).hostname }, "WHERE changes()=1"),
  ]).catch(() => null);
  if (!res || res[0].meta.changes !== 1) return d.fail(409, "The outstanding amount changed. Refresh and try again.");
  const cur = await d.getOrder(id, env);
  await d.notify(env, id, "intl_payment_pending", "pay-link-" + key);
  return d.json(cur);
}

// ── record a payment that has been verified outside the webhook (bank transfer, provider dashboard) ──
const MANUAL_METHODS = ["bank_transfer", "provider_dashboard", "other"];
export async function recordPayment(id, b, actor, env, d) {
  const o = await orderOf(env, id), bad = needIntl(o); if (bad) return d.fail(bad[0], bad[1]);
  if (o.quote_status !== "accepted") return d.fail(409, "Payment is only recorded after the customer accepts the quotation");
  const outstanding = o.total - o.paid_paise;
  if (outstanding <= 0 || o.payment_status === "paid") return d.fail(409, "Nothing is outstanding on this order");
  const amount = INTL.toMinor(b.amount), method = MANUAL_METHODS.includes(b.method) ? b.method : null, ref = text(b.reference, 80), key = keyOf(b);
  if (amount === null || amount <= 0) return d.json({ error: "Enter the amount received", fields: { amount: "Required" } }, 400);
  if (amount > outstanding) return d.json({ error: `That is more than the outstanding ${INTL.money(outstanding, o.currency)}`, fields: { amount: "Too much" } }, 400);
  if (!method) return d.json({ error: "Choose how it was verified", fields: { method: "Required" } }, 400);
  if (ref.length < 4) return d.json({ error: "Enter the transaction reference you verified (bank reference or provider payment ID)", fields: { reference: "Required" } }, 400);
  if (!key) return d.fail(400, "Missing operation key");
  if (b.confirm !== true) return d.fail(400, "Please confirm you have verified this payment in your bank or provider account");
  const pid = uuid();
  const res = await env.DB.batch([
    env.DB.prepare(`INSERT INTO payments (id,order_id,method,amount_paise,recorded_by,idempotency_key,reference,currency)
                    SELECT ?1,id,?2,?3,?4,?5,?6,currency FROM orders WHERE id=?7 AND market='INTL' AND quote_status='accepted' AND payment_status<>'paid' AND paid_paise=?8 AND total-paid_paise>=?3 AND status NOT IN ('cancelled','returned')
                      AND NOT EXISTS (SELECT 1 FROM payments WHERE reference=?6)`).bind(pid, method, amount, actor, key, ref, id, o.paid_paise),
    env.DB.prepare("UPDATE orders SET paid_paise=paid_paise+?2, payment_status=CASE WHEN paid_paise+?2>=total THEN 'paid' ELSE payment_status END, updated_at=unixepoch() WHERE id=?1 AND changes()=1").bind(id, amount),
    env.DB.prepare("INSERT INTO order_events (id,order_id,kind,status,public_note,customer_visible,actor,idempotency_key) SELECT ?1,?2,'payment','payment_received',?3,1,?4,?5 WHERE EXISTS (SELECT 1 FROM payments WHERE id=?6)")
      .bind(uuid(), id, `Payment received (${INTL.money(amount, o.currency)}).`, actor, "pay-" + key, pid),
    audit(env, actor, "intl_payment_recorded", id, { amount, method, reference: ref }, `WHERE EXISTS (SELECT 1 FROM payments WHERE id='${pid}')`),
  ]).catch(() => null);
  if (!res || res[0].meta.changes !== 1) return d.fail(409, "Payment was not recorded: the order changed, or this reference was already recorded. Refresh and check.");
  await d.notify(env, id, "payment_confirmed", "pay-" + pid);
  return d.json(await d.getOrder(id, env));
}

// Dispatch rule: an international order ships only once the quotation is accepted and everything is paid, unless an authorised
// admin explicitly records a different arrangement (reason required, kept on the order and in the audit log).
export async function shipGuard(env, id, body) {
  if (!(await hasIntl(env))) return null;
  const o = await env.DB.prepare("SELECT market,quote_status,payment_status FROM orders WHERE id=?").bind(id).first();
  if (!o || o.market !== "INTL") return null;
  if (o.quote_status === "accepted" && o.payment_status === "paid") return null;
  const why = text(body.override_reason, 300);
  if (why.length >= 10) return { override: why };
  return { error: "An international order ships only after the shipping quotation is accepted and the full amount is paid. To record a different arrangement, enter an override reason (at least 10 characters)." };
}

// ── settings: switch, payment mode, quote validity, allowed link hosts, destinations ──────
export async function getIntlSettings(env, sha256) {
  const cfg = Object.fromEntries((await env.DB.prepare("SELECT key,value FROM membership_config WHERE key LIKE 'intl_%'").all()).results.map((r) => [r.key, r.value]));
  const countries = (await env.DB.prepare("SELECT * FROM intl_countries ORDER BY sort_order, name").all()).results.map((c) => ({ ...c, enabled: !!c.enabled, region_required: !!c.region_required, postal_required: !!c.postal_required }));
  const settings = { enabled: cfg.intl_enabled === "1", payment_mode: cfg.intl_payment_mode === "manual_link" ? "manual_link" : "none", quote_valid_days: Number(cfg.intl_quote_valid_days) || 7, paylink_hosts: cfg.intl_paylink_hosts || "", terms_version: cfg.intl_terms_version || "" };
  return { settings, countries, version: await sha256(JSON.stringify([settings, countries.map((c) => [c.code, c.enabled])])) };
}
export async function saveIntlSettings(b, actor, env, d) {
  const cur = await getIntlSettings(env, d.sha256);
  if (b.version !== cur.version) return d.fail(409, "Settings changed since you opened this page. Reload and review again.");
  const s = b.settings && typeof b.settings === "object" ? b.settings : {}, next = { ...cur.settings };
  if (s.enabled !== undefined) { if (typeof s.enabled !== "boolean") return d.fail(400, "Invalid on/off value"); next.enabled = s.enabled; }
  if (s.payment_mode !== undefined) { if (!["none", "manual_link"].includes(s.payment_mode)) return d.fail(400, "Invalid payment mode"); next.payment_mode = s.payment_mode; }
  if (s.quote_valid_days !== undefined) { const n = Number(s.quote_valid_days); if (!Number.isInteger(n) || n < 1 || n > 60) return d.fail(400, "Quotation validity must be 1–60 days"); next.quote_valid_days = n; }
  if (s.paylink_hosts !== undefined) {
    const hosts = String(s.paylink_hosts).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (!hosts.length || hosts.length > 20 || hosts.some((h) => !/^[a-z0-9]([a-z0-9.-]{0,60}[a-z0-9])?\.[a-z]{2,}$/.test(h))) return d.fail(400, "Enter allowed payment-link domains, e.g. rzp.io, paypal.com");
    next.paylink_hosts = hosts.join(",");
  }
  if (s.terms_version !== undefined) { const v = text(s.terms_version, 20); if (v.length < 4) return d.fail(400, "Enter the terms version (e.g. 2026-10-16)"); next.terms_version = v; }
  const known = new Set(cur.countries.map((c) => c.code)), stmts = [];
  for (const c of Array.isArray(b.countries) ? b.countries : []) {
    if (!c || !known.has(c.code) || typeof c.enabled !== "boolean") return d.fail(400, "Invalid destination list");
    stmts.push(env.DB.prepare("UPDATE intl_countries SET enabled=? WHERE code=?").bind(c.enabled ? 1 : 0, c.code));
  }
  for (const [k, v] of [["intl_enabled", next.enabled ? "1" : "0"], ["intl_payment_mode", next.payment_mode], ["intl_quote_valid_days", String(next.quote_valid_days)], ["intl_paylink_hosts", next.paylink_hosts], ["intl_terms_version", next.terms_version]])
    stmts.push(env.DB.prepare("INSERT INTO membership_config (key,value,updated_at) VALUES (?1,?2,unixepoch()) ON CONFLICT(key) DO UPDATE SET value=?2, updated_at=unixepoch()").bind(k, v));
  stmts.push(env.DB.prepare("INSERT INTO audit_log (id,actor,action,detail) VALUES (?,?,'intl_settings',?)").bind(uuid(), actor, JSON.stringify({ from: cur.settings, to: next, countries: (b.countries || []).length })));
  await env.DB.batch(stmts);
  return d.json(await getIntlSettings(env, d.sha256));
}

// ── enquiries ─────────────────────────────────────────────────────────────────────────────
export async function listEnquiries(sp, env) {
  const st = ["new", "in_progress", "closed"].includes(sp.get("status")) ? sp.get("status") : null;
  const { results } = await env.DB.prepare(`SELECT id,name,email,country,company,product,quantity,customization,shipping_pref,message,status,notes,handled_by,created_at,updated_at FROM intl_enquiries ${st ? "WHERE status=?1" : "WHERE ?1 IS NULL"} ORDER BY created_at DESC, rowid DESC LIMIT 100`).bind(st).all();
  return { enquiries: results };
}
export async function updateEnquiry(id, b, actor, env, d) {
  const status = ["new", "in_progress", "closed"].includes(b.status) ? b.status : null, notes = b.notes === undefined ? undefined : text(b.notes, 1000);
  if (!status && notes === undefined) return d.fail(400, "Nothing to update");
  const cur = await env.DB.prepare("SELECT id,status,notes FROM intl_enquiries WHERE id=?").bind(id).first();
  if (!cur) return d.fail(404, "Enquiry not found");
  await env.DB.batch([
    env.DB.prepare("UPDATE intl_enquiries SET status=coalesce(?2,status), notes=coalesce(?3,notes), handled_by=?4, updated_at=unixepoch() WHERE id=?1").bind(id, status, notes === undefined ? null : notes, actor),
    env.DB.prepare("INSERT INTO audit_log (id,actor,action,detail) VALUES (?,?,'intl_enquiry',?)").bind(uuid(), actor, JSON.stringify({ id, from: cur.status, to: status || cur.status })),
  ]);
  return d.json(await listEnquiries(new URLSearchParams(), env));
}

// ── per-product international data (price list, quantity breaks, MOQ, lead time, tax treatment) ──
export async function productIntl(env, id) {
  if (!(await hasIntl(env))) return {};
  const p = await env.DB.prepare("SELECT price_usd_cents,intl_enabled,intl_moq,intl_lead_days,intl_custom_quote,weight_g,dims_mm,intl_tax_treatment FROM products WHERE id=?").bind(id).first();
  const t = await env.DB.prepare("SELECT min_qty,unit_cents FROM product_intl_tiers WHERE product_id=? ORDER BY min_qty").bind(id).all();
  return p ? { intl: { ...p, intl_enabled: !!p.intl_enabled, intl_custom_quote: !!p.intl_custom_quote, tiers: t.results } } : {};
}
// Adds validated intl columns to f (and returns tiers) from a product update body. errors is mutated.
export function validateProductIntl(b, f, errors) {
  const has = (k) => b[k] !== undefined;
  if (has("price_usd")) { if (b.price_usd === null || b.price_usd === "") f.price_usd_cents = null; else { const m = INTL.toMinor(b.price_usd); if (m === null || m < 1) errors.price_usd = "Enter a USD price like 12.50"; else f.price_usd_cents = m; } }
  if (has("intl_enabled")) { if (b.intl_enabled === true || b.intl_enabled === 1) f.intl_enabled = 1; else if (b.intl_enabled === false || b.intl_enabled === 0) f.intl_enabled = 0; else errors.intl_enabled = "Invalid"; }
  if (has("intl_custom_quote")) f.intl_custom_quote = b.intl_custom_quote === true || b.intl_custom_quote === 1 ? 1 : 0;
  for (const [k, max] of [["intl_moq", 100000], ["intl_lead_days", 365], ["weight_g", 1000000]]) {
    if (!has(k)) continue;
    if (b[k] === null || b[k] === "") { f[k] = null; continue; }
    const n = Number(b[k]); if (!Number.isInteger(n) || n < (k === "intl_lead_days" ? 0 : 1) || n > max) errors[k] = "Enter a whole number"; else f[k] = n;
  }
  if (has("dims_mm")) { const v = text(b.dims_mm, 40); if (v && !/^\d+(\.\d+)?(x\d+(\.\d+)?){0,2}$/i.test(v)) errors.dims_mm = "Use millimetres like 86x54x0.8"; else f.dims_mm = v || null; }
  if (has("intl_tax_treatment")) { if (!["excl", "incl", "quoted"].includes(b.intl_tax_treatment)) errors.intl_tax_treatment = "Invalid"; else f.intl_tax_treatment = b.intl_tax_treatment; }
  let tiers;
  if (has("intl_tiers")) {
    if (!Array.isArray(b.intl_tiers) || b.intl_tiers.length > 12) errors.intl_tiers = "Provide up to 12 quantity breaks";
    else {
      tiers = []; const seen = new Set();
      for (const t of b.intl_tiers) {
        const q = Number(t && t.min_qty), c = INTL.toMinor(t && t.unit_usd);
        if (!Number.isInteger(q) || q < 2 || q > 100000 || c === null || c < 1 || seen.has(q)) { errors.intl_tiers = "Each break needs a unique quantity of 2 or more and a USD unit price"; break; }
        seen.add(q); tiers.push({ min_qty: q, unit_cents: c });
      }
      if (!errors.intl_tiers) { tiers.sort((a, b2) => a.min_qty - b2.min_qty); for (let i = 1; i < tiers.length; i++) if (tiers[i].unit_cents > tiers[i - 1].unit_cents) { errors.intl_tiers = "A larger quantity must not cost more per unit"; break; } }
    }
  }
  return { tiers };
}

// The USD price list for the admin screen in one call: every product with its international fields and quantity breaks.
export async function listIntlProducts(env) {
  const prods = (await env.DB.prepare("SELECT id,sku,name,price_paise,price_usd_cents,intl_enabled,intl_moq,intl_lead_days,intl_custom_quote,weight_g,dims_mm,intl_tax_treatment FROM products ORDER BY name COLLATE NOCASE").all()).results;
  const tiers = (await env.DB.prepare("SELECT product_id,min_qty,unit_cents FROM product_intl_tiers ORDER BY min_qty").all()).results;
  return { products: prods.map((p) => ({ id: p.id, sku: p.sku, name: p.name, price_paise: p.price_paise, intl: { price_usd_cents: p.price_usd_cents, intl_enabled: !!p.intl_enabled, intl_moq: p.intl_moq, intl_lead_days: p.intl_lead_days, intl_custom_quote: !!p.intl_custom_quote, weight_g: p.weight_g, dims_mm: p.dims_mm, intl_tax_treatment: p.intl_tax_treatment, tiers: tiers.filter((t) => t.product_id === p.id) } })) };
}
