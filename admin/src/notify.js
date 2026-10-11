// Customer order notifications (email via Resend). Called after an admin action succeeds; never throws, never blocks the action.
// A message is only attempted when the order has the customer's own email (given at checkout) and a channel is configured.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pretty = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || "") ? `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
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
  dispatch_updated: ["Update on your pre-order dispatch date", "We've updated the expected dispatch date for your pre-order.", "Pre-order"],
};
// admin status changes that notify the customer (processing, on hold, cancelled and returned are deliberately silent)
export const STATUS_EVENT = { confirmed: "order_confirmed", preorder_confirmed: "preorder_confirmed", ready_to_pack: "preorder_ready", packed: "packed", out_for_delivery: "out_for_delivery", delivered: "delivered", delivery_failed: "delivery_failed" };

export function buildMessage(event, o, x = {}) {
  const [subject, line, label] = EVENTS[event];
  const link = o.track_token ? `https://ntagz.com/track.html?o=${encodeURIComponent(o.id)}&t=${o.track_token}` : "";
  const rows = [["Order", o.id.slice(0, 8)], ["Status", label]];
  if (x.awb) rows.push(["Courier", x.courier || ""], ["AWB", x.awb]);
  if (x.est_delivery && pretty(x.est_delivery)) rows.push(["Estimated delivery", `${pretty(x.est_delivery)} (an estimate, not a guarantee)`]);
  if (event === "dispatch_updated" || event === "preorder_confirmed") {
    if (o.expected_dispatch && pretty(o.expected_dispatch)) rows.push(["Expected dispatch", `${pretty(o.expected_dispatch)} (not a delivery date)`]);
  }
  if (x.note) rows.push(["Note", x.note]);
  const courierUrl = httpsUrl(x.tracking_url);
  const hi = o.name ? `Hi ${o.name.split(/\s+/)[0]},` : "Hello,";
  const text = [hi, "", line, "", ...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`), "", link ? `Track your order: ${link}` : "", courierUrl ? `Courier tracking: ${courierUrl}` : "", "", "You are receiving this because you placed an order at ntagz.com. Questions? Reply to this email or WhatsApp +91 9960 160016."].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;color:#1d1d1f"><p>${esc(hi)}</p><p>${esc(line)}</p>`
    + `<table style="border-collapse:collapse">${rows.filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:2px 14px 2px 0;color:#6e6e73">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>`
    + (link ? `<p><a href="${esc(link)}" style="background:#ff5a1f;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;display:inline-block">Track your order</a></p>` : "")
    + (courierUrl ? `<p><a href="${esc(courierUrl)}">Courier tracking page</a></p>` : "")
    + `<p style="color:#6e6e73;font-size:12px">You are receiving this because you placed an order at ntagz.com.</p></div>`;
  return { subject, text, html };
}

// Records the attempt first (the unique key stops duplicates), then sends. Returns the final status.
export async function notify(env, orderId, event, dedupeKey, extra = {}) {
  try {
    if (!EVENTS[event]) return "ignored";
    const o = await env.DB.prepare("SELECT id,name,email,track_token,expected_dispatch FROM orders WHERE id=?").bind(orderId).first();
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
