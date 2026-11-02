// Payment links: what both Workers need to agree on, with no I/O. A payment link is a stored cart + customer details behind an unguessable
// token. Prices are NEVER stored as authority: the payments Worker re-prices the cart (same engine as checkout) every time the link is
// opened or paid. This module holds the token/expiry rules, the cart normaliser, the status rules and the nudge engine.
//
// Nudges ("add 100 more for 10% off every piece", "₹180 more for free shipping") are found by ASKING the pricing engine what a bigger cart
// would cost, never by re-deriving discount rules here, so they stay correct when tiers, member prices or shipping rules change.

const PRICING = require("./pricing.js");

const TOKEN_RE = /^[0-9a-f]{32}$/;
const EXPIRY_HOURS = [6, 12, 24, 48, 72, 168];
const DEFAULT_EXPIRY_HOURS = 24;
const MAX_QTY = 100000;
const MAX_LINES = 30;

// 128 random bits as hex. The link is the secret: it is only ever shown to the admin who created it and to the customer.
function newToken() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// [{id, qty}] -> merged list (one line per product, order of first appearance), or null if anything is malformed. Pricing validates the
// rest (known product, minimum quantity, kit quantity); this only makes the shape safe to store.
function normaliseItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_LINES * 2) return null;
  const seen = new Map();
  for (const it of items) {
    if (!it || typeof it.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(it.id) || !Number.isSafeInteger(it.qty) || it.qty < 1 || it.qty > MAX_QTY) return null;
    seen.set(it.id, Math.min((seen.get(it.id) || 0) + it.qty, MAX_QTY));
  }
  return seen.size > MAX_LINES ? null : [...seen].map(([id, qty]) => ({ id, qty }));
}

// "paid" wins over everything (money was taken), then the admin's cancel, then the clock, then how far the customer got.
// `paid` = an order for one of the link's gateway orders exists and is paid.
function statusOf(row, paid, nowSec) {
  if (paid) return "paid";
  if (row.status === "cancelled") return "cancelled";
  if (row.expires_at <= nowSec) return "expired";
  if (row.open_count > 0) return "opened";
  if (row.sent_at) return "sent";
  return "new";
}

const rupees = (n) => Math.round(n * 100) / 100;

// price(items) -> the engine's total for a cart (or null). products = PRICING.PRODUCTS (pack sizes, kits, inclusive lines).
// opts.state: delivery state ("" = unknown, no shipping nudge). Returns at most one tier nudge and one free-shipping nudge.
function nudgesFor(items, price, products, opts = {}) {
  const base = price(items);
  if (!base || !Array.isArray(base.lines) || base.lines.length !== items.length) return [];
  const out = [];
  const tiers = [...PRICING.BULK_TIERS].sort((a, b) => a.min - b.min);

  // 1) Next bulk tier: only a near miss (the extra pieces are at most 30% of what is already in the cart), and only when the engine says
  //    every piece really gets cheaper (a combined-discount cap or margin floor can cancel the benefit).
  let bestTier = null;
  items.forEach((it, i) => {
    const line = base.lines[i], p = products[it.id];
    if (!p || p.fixed || !line || line.id !== it.id) return;
    const pack = p.packSize || 1, pieces = it.qty * pack;
    const next = tiers.find((t) => t.min > pieces && t.pct > line.bulkPct);
    if (!next) return;
    const addQty = Math.ceil((next.min - pieces) / pack);
    if (addQty < 1 || addQty * pack > 0.3 * pieces || it.qty + addQty > MAX_QTY) return;
    const bigger = items.map((x, j) => (j === i ? { id: x.id, qty: x.qty + addQty } : x));
    const t2 = price(bigger);
    if (!t2 || !t2.lines[i]) return;
    const unitNow = line.net / line.qty, unitNext = t2.lines[i].net / t2.lines[i].qty;
    if (!(unitNext < unitNow - 1e-9)) return;
    const n = { type: "tier", id: it.id, addQty, addPieces: addQty * pack, tierMinPieces: next.min, tierPct: next.pct, unitNow: rupees(unitNow), unitNext: rupees(unitNext),
      savingOnCurrent: rupees((unitNow - unitNext) * line.qty), extraAmount: t2.amount - base.amount, action: { id: it.id, qty: it.qty + addQty } };
    if (!bestTier || n.savingOnCurrent > bestTier.savingOnCurrent) bestTier = n;
  });
  if (bestTier) out.push(bestTier);

  // 2) Free shipping: only when a shipping charge applies and the cart is within ~₹1,000 of the free line. Find the cheapest way to cross it
  //    by adding more of something already in the cart (asked of the engine, so bulk tiers and campaigns are respected).
  if (opts.state && base.shipping > 0) {
    let best = null;
    items.forEach((it, i) => {
      const line = base.lines[i], p = products[it.id];
      if (!p || p.fixed || p.allInclusive || !line || line.id !== it.id) return;
      const unit = line.net / line.qty;
      const remaining = PRICING.SHIPPING.freeAbove - (base.cartValuePaise ? base.cartValuePaise / 100 : 0);
      if (remaining <= 0 || remaining > PRICING.SHIPPING.freeAbove / 2 || !(unit > 0)) return;
      let k = Math.max(1, Math.ceil(remaining / unit)), t2 = null;
      for (let tries = 0; tries < 60 && it.qty + k <= MAX_QTY; tries++) {
        t2 = price(items.map((x, j) => (j === i ? { id: x.id, qty: x.qty + k } : x)));
        if (t2 && t2.shipping === 0) break;
        t2 = null; k += Math.max(1, Math.ceil(k / 10));
      }
      if (!t2) return;
      const n = { type: "shipping", id: it.id, addQty: k, shippingSaved: base.shipping, remaining: rupees(remaining), extraAmount: t2.amount - base.amount, action: { id: it.id, qty: it.qty + k } };
      if (!best || n.extraAmount < best.extraAmount) best = n;
    });
    if (best) out.push(best);
  }
  return out;
}

module.exports = { TOKEN_RE, EXPIRY_HOURS, DEFAULT_EXPIRY_HOURS, MAX_QTY, MAX_LINES, newToken, normaliseItems, statusOf, nudgesFor };
