// Customer order notifications (email via Resend). Called after an admin action succeeds; never throws, never blocks the action.
// A message is only attempted when the order has the customer's own email (given at checkout) and a channel is configured.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pretty = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || "") ? `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
import INTL from "../../functions/lib/intl.js";
const httpsUrl = (u) => { try { const x = new URL(u); return x.protocol === "https:" ? x.href : ""; } catch { return ""; } };

// event -> { subject, line (what happened), status label }. Add an entry to start notifying on a new event.
const EVENTS = {
  order_confirmed: ["Your ntagz order is confirmed", "We've confirmed your order.", "Confirmed"],
  payment_confirmed: ["We received your payment", "We've received your payment. Thank you.", "Payment received"],
  preorder_confirmed: ["Your ntagz pre-order is confirmed", "Your pre-order is confirmed. We'll let you know when it is ready to ship.", "Pre-order confirmed"],
  preorder_ready: ["Your pre-order is ready to ship", "The stock for your pre-order has arrived and we're getting it ready to ship.", "Ready to ship"],
  packed: ["Your ntagz order is packed", "Your order is packed and will be handed to the courier soon.", "Packed"],
  shipped: ["Your ntagz order has shipped", "Your order is on its way.", "Shipped"],
  out_for_delivery: ["Your ntagz order is out for delivery", "Your order is out for delivery.", "Out for delivery"],
  delivered: ["Your ntagz order was delivered", "Your order has been delivered.", "Delivered"],
  delivery_failed: ["Delivery attempt unsuccessful", "The courier could not deliver your order. We're following up and will update you.", "Delivery failed"],
  // International orders (USD, shipping quoted separately). Subject / what happened / status label.
  intl_order_received: ["We received your ntagz order", "Thank you. We received your international order. Shipping is quoted separately for each order, so we will review your destination and send you a shipping quotation. Nothing has been charged yet.", "Received · shipping quotation required"],
  intl_quote_required: ["Your shipping quotation is in progress", "We are preparing the shipping quotation for your order. We may contact you if we need more details about your destination or shipment.", "Shipping quotation required"],
  intl_quote_sent: ["Your ntagz shipping quotation", "We have sent you a shipping quotation. Please review it and accept or decline. Nothing is final until you accept it.", "Quotation sent · your action is needed"],
  intl_quote_accepted: ["Shipping quotation accepted", "Thank you. You accepted the shipping quotation.", "Quotation accepted"],
  intl_quote_declined: ["Shipping quotation declined", "You declined the shipping quotation. We will contact you about alternatives.", "Quotation declined"],
  intl_payment_pending: ["Payment is pending for your ntagz order", "Your quotation is accepted. The outstanding amount below is needed before we can dispatch. Use the link on your order page, or wait for our payment instructions.", "Payment pending"],
  intl_processing: ["Your ntagz order is being prepared", "All required amounts are received and we are preparing your order.", "Processing"],
  intl_tracking_updated: ["Tracking update for your ntagz order", "We updated the tracking information for your order.", "Tracking updated"],
  intl_cancelled: ["Your ntagz order was cancelled", "Your order has been cancelled.", "Cancelled"],
  intl_refund: ["Refund update for your ntagz order", "A refund has been recorded for your order.", "Refund"],
  dispatch_updated: ["Update on your pre-order dispatch date", "We've updated the expected dispatch date for your pre-order.", "Pre-order"],
};
// admin status changes that notify the customer (processing, on hold, cancelled and returned are deliberately silent)
export const STATUS_EVENT = { confirmed: "order_confirmed", preorder_confirmed: "preorder_confirmed", ready_to_pack: "preorder_ready", packed: "packed", out_for_delivery: "out_for_delivery", delivered: "delivered", delivery_failed: "delivery_failed" };

const fmtDay = (ts) => new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function buildMessage(event, o, x = {}) {
  const [subject, line, label] = EVENTS[event];
  const intl = o.market === "INTL";
  const link = o.track_token
    ? (intl ? `https://ntagz.com/order/international.html?o=${encodeURIComponent(o.id)}&t=${o.track_token}` : `https://ntagz.com/track.html?o=${encodeURIComponent(o.id)}&t=${o.track_token}`)
    : "";
  const rows = intl ? [["Order number", o.txn_id || o.id.slice(0, 8)], ["Status", label]] : [["Order", o.id.slice(0, 8)], ["Status", label]];
  let action = "";
  if (intl) {
    const cur = o.currency || "USD", m = (n) => INTL.money(n, cur), q = x.quote;
    rows.push(["Currency", cur], ["Product subtotal", m(o.subtotal)]);
    if (q) {
      rows.push(["Shipping", q.shipping_minor > 0 ? m(q.shipping_minor) : "Included / none quoted"], ["Taxes and additional charges", q.taxes_minor + q.other_minor > 0 ? m(q.taxes_minor + q.other_minor) : "None specified"],
        ["Final payable amount", m(q.total_minor)], ["This quotation covers", INTL.QUOTE_TYPE_LABEL[q.quote_type] || ""]);
      const how = [q.carrier, q.method].filter(Boolean).join(" · "); if (how) rows.push(["Shipping method", how]);
      if (q.est_from || q.est_to) rows.push(["Estimated delivery window", `${[pretty(q.est_from), pretty(q.est_to)].filter(Boolean).join(" to ")} (an estimate, not a guarantee)`]);
      if (event === "intl_quote_sent" && q.expires_at) rows.push(["Quotation valid until", fmtDay(q.expires_at)]);
      if (q.charges_note) rows.push(["About these charges", q.charges_note]);
    } else rows.push(["Shipping", o.quote_status === "accepted" ? "Quotation accepted" : "Shipping quotation required (not yet included)"]);
    if (["payment_confirmed", "intl_payment_pending"].includes(event)) rows.push(["Paid so far", m(o.paid_paise || 0)], ["Outstanding", m(Math.max((o.total || 0) - (o.paid_paise || 0), 0))]);
    if (event === "intl_refund" && x.amount) rows.push(["Refund amount", m(x.amount)]);
    action = event === "intl_quote_sent" ? "Please review the quotation and accept or decline it on your order page." : event === "intl_payment_pending" ? "Please pay the outstanding amount shown on your order page." : "";
  }
  if (x.awb) rows.push(["Courier", x.courier || ""], ["AWB / tracking number", x.awb]);
  if (x.est_delivery && pretty(x.est_delivery)) rows.push(["Estimated delivery", `${pretty(x.est_delivery)} (an estimate, not a guarantee)`]);
  if (event === "dispatch_updated" || event === "preorder_confirmed") {
    if (o.expected_dispatch && pretty(o.expected_dispatch)) rows.push(["Expected dispatch", `${pretty(o.expected_dispatch)} (not a delivery date)`]);
  }
  if (x.note) rows.push(["Note", x.note]);
  if (action) rows.push(["Action needed", action]);
  const courierUrl = httpsUrl(x.tracking_url);
  const dutyNote = intl && ["intl_quote_sent", "intl_payment_pending"].includes(event) ? "Customs duties, import taxes and other destination-country charges may be payable by you unless this quotation says otherwise." : "";
  const hi = o.name ? `Hi ${o.name.split(/\s+/)[0]},` : "Hello,";
  const text = [hi, "", line, "", ...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`), "", dutyNote, link ? `${intl ? "View your order" : "Track your order"}: ${link}` : "", courierUrl ? `Courier tracking: ${courierUrl}` : "", "", "You are receiving this because you placed an order at ntagz.com."].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;color:#1d1d1f"><p>${esc(hi)}</p><p>${esc(line)}</p>`
    + `<table style="border-collapse:collapse">${rows.filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:2px 14px 2px 0;color:#6e6e73;vertical-align:top">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>`
    + (dutyNote ? `<p style="font-size:13px;color:#6e6e73">${esc(dutyNote)}</p>` : "")
    + (link ? `<p><a href="${esc(link)}" style="background:#ff5a1f;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;display:inline-block">${intl ? "View your order" : "Track your order"}</a></p>` : "")
    + (courierUrl ? `<p><a href="${esc(courierUrl)}">Courier tracking page</a></p>` : "")
    + `<p style="color:#6e6e73;font-size:12px">You are receiving this because you placed an order at ntagz.com.</p></div>`;
  return { subject, text, html };
}

// Records the attempt first (the unique key stops duplicates), then sends. Returns the final status.
export async function notify(env, orderId, event, dedupeKey, extra = {}) {
  try {
    if (!EVENTS[event]) return "ignored";
    let o;
    try { o = await env.DB.prepare("SELECT id,name,email,track_token,expected_dispatch,txn_id,market,currency,subtotal,total,paid_paise,payment_status,quote_status FROM orders WHERE id=?").bind(orderId).first(); }
    catch { o = await env.DB.prepare("SELECT id,name,email,track_token,expected_dispatch FROM orders WHERE id=?").bind(orderId).first(); } // before migration 0019
    if (!o) return "ignored";
    const msg = buildMessage(event, o, extra);
    const nid = crypto.randomUUID();
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO notifications (id,order_id,event,dedupe_key,subject) VALUES (?,?,?,?,?)").bind(nid, orderId, event, dedupeKey, msg.subject).run();
    if (ins.meta.changes !== 1) return "duplicate";
    const done = (status, detail) => env.DB.prepare("UPDATE notifications SET status=?, detail=? WHERE id=?").bind(status, detail || null, nid).run().then(() => status);
    if (!EMAIL.test(o.email || "")) return await done("skipped", "no customer email");
    if (env.DEV_NOTIFY_ECHO === "1") return await done("sent", "dev echo"); // local testing only; never set in production
    if (!env.RESEND_API_KEY) return await done("skipped", "email not configured");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(6000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "ntagz <hello@ntagz.com>", to: [o.email], subject: msg.subject, text: msg.text, html: msg.html }),
    }).catch(() => null);
    return await done(res && res.ok ? "sent" : "failed", res && res.ok ? null : `email service ${res ? res.status : "unreachable"}`);
  } catch (e) { console.error("notify failed:", e && e.message); return "error"; }
}
