// Admin edit of quantity / unit price on a placed order. Pure rules and maths only: index.js loads the rows and does the atomic write.
// Totals mirror what checkout writes (functions/lib/pricing.js priceCart): GST is rounded to whole rupees on the non-inclusive lines,
// the total is rounded to whole rupees, and subtotal = total - gst (so it includes shipping). The client never supplies a total.

// Fulfilment statuses before the goods leave: after packing the parcel and the invoice amount are already fixed.
export const EDITABLE_STATUS = ["placed", "confirmed", "processing", "on_hold", "preorder_confirmed", "awaiting_stock", "ready_to_pack"];
export const OFFLINE_METHODS = ["cash", "cod", "upi", "bank", "whatsapp"];

// Returns a plain-language reason this order cannot be edited, or null when it can. `o` is a full orders row (columns that an older
// schema lacks read as undefined and count as "not set").
export function whyNotEditable(o) {
  if (o.market === "INTL") return "International orders are changed through the shipping quotation";
  if (o.partner_id) return "Partner orders cannot be edited here";
  if (!OFFLINE_METHODS.includes(o.payment_method)) return "Only orders paid by cash, COD, UPI, bank or WhatsApp can be edited";
  if (o.payment_status !== "unpaid" || (o.paid_paise || 0) > 0 || (o.refunded_paise || 0) > 0) return "Orders with a payment or refund recorded cannot be edited";
  if ((o.points_redeemed || 0) > 0) return "This order used reward points, so it cannot be edited";
  if (o.pay_link_url) return "This order has a payment link, so it cannot be edited";
  if (!EDITABLE_STATUS.includes(o.status)) return "This order has moved past the stage where it can be edited";
  return null;
}

// items: the order's existing [{id, qty, ...}]; lines: [{qty, unit_paise}] in the same order (ex-GST unit price, or GST-inclusive for
// all-inclusive products); inclusive: Set of product ids whose price already carries GST.
// Returns { items, subtotal, gst, total, qualifying, pointsBasis } or { error }.
export function recompute(o, items, lines, inclusive, gstPct) {
  let regular = 0, incl = 0;
  const next = items.map((it, i) => {
    const { qty, unit_paise } = lines[i];
    const net = qty * unit_paise;
    if (inclusive.has(it.id)) incl += net; else regular += net;
    return { ...it, qty, unit_paise };
  });
  const gst = Math.round(regular * gstPct / 10000) * 100;
  const total = Math.round((regular + gst + incl + (o.shipping_paise || 0)) / 100) * 100;
  if (!Number.isSafeInteger(total) || total < 100 || total > 1_000_000_000) return { error: "The new total must be between ₹1 and ₹1,00,00,000" };
  const qualifying = Math.round(regular + incl / (1 + gstPct / 100)); // net product value without GST, as checkout freezes it
  const pointsBasis = o.points_basis_paise > 0 && o.qualifying_paise > 0 ? Math.round(o.points_basis_paise * qualifying / o.qualifying_paise) : (o.points_basis_paise || 0);
  return { items: next, subtotal: total - gst, gst, total, qualifying, pointsBasis };
}
