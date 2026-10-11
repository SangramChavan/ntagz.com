// ntagz pricing engine — the ONE place a price is computed. Used by the payments Worker (checkout, offline orders, quotes,
// membership page) and by the admin Worker (pricing preview and warnings), so what the admin previews is what checkout charges.
// Pure functions, no I/O. Amounts follow the original checkout maths exactly (rupees, total rounded to whole rupees), so
// guest prices are unchanged by this module.
//
// Order of discounts, per line:
//   1. regular price (admin catalogue in D1; static table only as a fallback)
//   2. bulk tier by pieces (10 / 15 / 25 %) — everyone
//   3. member % (products.member_discount_pct) — only an active member, only while member pricing is live, never on fixed kits
//   4. guardrails, which only ever shrink the MEMBER part: combined discount <= max_total_discount_pct, and when a cost price
//      is known, the ex-GST unit price stays at or above cost / (1 - min_margin_pct).
// There is no other discount type, so nothing else can stack.

// Product STRUCTURE for checkout (pack size, MOQ, fixed kits, all-inclusive). Prices and member discounts come from the admin
// catalogue in D1 (products.price_paise, products.member_discount_pct); prices here are only a fallback if D1 is unreachable.
// A product must be listed here to be sold through checkout.
const PRODUCTS = {
  "sample-kit":                   { price: 1940, fixed: true, allInclusive: false },
  "black-nfc-card":               { price: 30 },
  "white-nfc-card":               { price: 25 },
  "white-inkjet-nfc-card":        { price: 32.8 },
  "google-review-nfc-card":       { price: 95 },
  "google-review-nfc-stand-5x5":  { price: 99, allInclusive: true },
  "google-review-nfc-stand-10x10":{ price: 149, allInclusive: true },
  "google-review-nfc-stand-12x12":{ price: 199, allInclusive: true },
  "nfc-card-custom-printing":     { price: 75 },
  "anti-metal-tag":               { price: 20 },
  "ntag216-adhesive-tag":         { price: 18 },
  "nfc-coin":                     { price: 20 },
  "mini-nfc-tag":                 { price: 16 },
  "micro-flex-fpc":               { price: 75 },
  "nfc-wristband":                { price: 80 },
  "uhf-rfid-label":               { price: 249, packSize: 10, moq: 1 },
  "rfid-card-custom-printing":    { price: 75 },
};

const GST_PCT = 18;
const BULK_TIERS = [ // pieces threshold -> %
  { min: 5000, pct: 25 }, { min: 1000, pct: 15 }, { min: 500, pct: 10 },
];
const SHIPPING = { freeAbove: 2000, homeState: "Maharashtra", home: 40, rest: 80 };
const MAX_MEMBER_PCT = 50; // hard ceiling the admin cannot exceed

const bulkPctFor = (pieces) => { for (const t of BULK_TIERS) if (pieces >= t.min) return t.pct; return 0; };
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

// membership_config rows ({key: value}) -> typed settings with safe defaults.
function settingsFrom(cfg = {}) {
  return {
    live: cfg.discounts_live === "1",
    feePaise: Math.max(0, parseInt(cfg.fee_paise, 10) || 99900),
    durationDays: Math.min(Math.max(parseInt(cfg.duration_days, 10) || 365, 1), 1095),
    maxTotalPct: Math.min(Math.max(num(cfg.max_total_discount_pct, 30), 0), 90),
    minMarginPct: Math.min(Math.max(num(cfg.min_margin_pct, 20), 0), 90),
  };
}

// Effective member % for one unit after guardrails. listPrice in rupees (as charged, GST-inclusive for all-inclusive items).
// Returns { pct, limit: null | "cap" | "margin" }.
function memberPctFor({ listPrice, costPaise, allInclusive, bulkPct, requestedPct, settings }) {
  let m = Math.min(Math.max(requestedPct || 0, 0), MAX_MEMBER_PCT), limit = null;
  if (m <= 0) return { pct: 0, limit: null };
  const cap = settings.maxTotalPct;
  if (bulkPct + m - (bulkPct * m) / 100 > cap + 1e-9) {
    m = bulkPct >= cap ? 0 : (1 - (100 - cap) / (100 - bulkPct)) * 100;
    limit = "cap";
  }
  if (costPaise != null && costPaise > 0 && settings.minMarginPct > 0 && listPrice > 0) {
    const exGst = allInclusive ? listPrice / (1 + GST_PCT / 100) : listPrice; // all-inclusive prices carry GST
    const floor = costPaise / 100 / (1 - settings.minMarginPct / 100);
    const afterBulk = exGst * (100 - bulkPct) / 100;
    if (afterBulk * (100 - m) / 100 < floor - 1e-9) {
      m = afterBulk <= floor ? 0 : (1 - floor / afterBulk) * 100;
      limit = "margin";
    }
  }
  return { pct: Math.max(0, Math.floor(m * 100) / 100), limit }; // round DOWN to 0.01% so a guardrail is never overshot
}

// items: [{id, qty}]. products: static structure table {id: {price, fixed, moq, packSize, allInclusive}}.
// live: D1 rows by id (price_paise, member_discount_pct, cost_paise) or null. member: true only for a verified active member.
// Returns null for any invalid cart (unknown product, bad qty, below MOQ, too many lines, absurd total).
function priceCart(items, { products, live, state, member, settings }) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) return null;
  const s = settings || settingsFrom({});
  let regular = 0, inclusive = 0, pieces = 0, list = 0, bulkOff = 0, memberOff = 0;
  const lines = [];
  for (const item of items) {
    const product = products[item && item.id];
    const qty = item && item.qty;
    if (!product || !Number.isSafeInteger(qty) || qty < (product.fixed ? 1 : product.moq || 10) || qty > 100000) return null;
    if (product.fixed && qty !== 1) return null;
    const row = live && live[item.id];
    const linePieces = qty * (product.packSize || 1);
    const bulk = product.fixed ? 0 : bulkPctFor(linePieces);
    const price = row ? row.price_paise / 100 : product.price;
    const requested = member && s.live && !product.fixed && row ? Number(row.member_discount_pct) || 0 : 0;
    const mp = memberPctFor({ listPrice: price, costPaise: row ? row.cost_paise : null, allInclusive: !!product.allInclusive, bulkPct: bulk, requestedPct: requested, settings: s });
    const afterBulk = price * qty * (100 - bulk) / 100;
    const net = afterBulk * (100 - mp.pct) / 100; // same expression as the original calculateTotal
    if (product.allInclusive) inclusive += net; else regular += net;
    pieces += product.fixed ? 70 : linePieces;
    list += price * qty; bulkOff += price * qty - afterBulk; memberOff += afterBulk - net;
    lines.push({ id: item.id, qty, unitPrice: price, bulkPct: bulk, memberPct: mp.pct, requestedMemberPct: requested, limit: mp.limit, net, allInclusive: !!product.allInclusive });
  }
  const taxable = regular + inclusive;
  const shipping = state ? (inclusive > 0 || taxable >= SHIPPING.freeAbove ? 0 : state === SHIPPING.homeState ? SHIPPING.home : SHIPPING.rest) : 0;
  const gst = Math.round(regular * GST_PCT / 100);
  const amount = Math.round(regular + gst + inclusive + shipping);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10000000) return null;
  const r2 = (x) => Math.round(x * 100) / 100;
  return { amount, pieces, gst, shipping, subtotal: r2(list), bulkDiscount: r2(bulkOff), memberDiscount: r2(memberOff), member: memberOff > 0.004, lines };
}

// Admin view of one product's member price: what members actually pay at each bulk tier, and why it may be limited.
function memberPriceReport(product, row, settings) {
  const price = row.price_paise / 100;
  const tiers = [0, ...BULK_TIERS.map((t) => t.pct).reverse()].map((bulk) => {
    const mp = product && product.fixed ? { pct: 0, limit: null }
      : memberPctFor({ listPrice: price, costPaise: row.cost_paise, allInclusive: !!(product ? product.allInclusive : row.all_inclusive), bulkPct: bulk, requestedPct: row.member_discount_pct, settings });
    const unit = price * (100 - bulk) / 100 * (100 - mp.pct) / 100;
    return { bulkPct: bulk, memberPct: mp.pct, limit: mp.limit, unitPrice: Math.round(unit * 100) / 100 };
  });
  const warnings = [];
  const req = Number(row.member_discount_pct) || 0;
  if (product && product.fixed && req > 0) warnings.push("Fixed-price kits never get member pricing.");
  if (!product) warnings.push("Not sold by the storefront checkout yet (not in the built-in catalogue), so this setting has no effect.");
  if (req > 0 && (row.cost_paise == null)) warnings.push("No cost price: margin protection cannot run for this product. Add a cost price in Products.");
  if (row.cost_paise != null && row.cost_paise > row.price_paise) warnings.push("Regular price is below cost.");
  if (tiers.some((t) => t.limit === "cap")) warnings.push(`Combined discount cap (${settings.maxTotalPct}%) reduces the member discount at ${tiers.filter((t) => t.limit === "cap").map((t) => tierLabel(t.bulkPct)).join(", ")}.`);
  if (tiers.some((t) => t.limit === "margin")) warnings.push(`Minimum margin (${settings.minMarginPct}%) reduces the member discount at ${tiers.filter((t) => t.limit === "margin").map((t) => tierLabel(t.bulkPct)).join(", ")}.`);
  return { tiers, warnings };
}
const tierLabel = (pct) => (pct === 0 ? "regular quantities" : `${BULK_TIERS.find((t) => t.pct === pct).min}+ pcs`);

module.exports = { PRODUCTS, GST_PCT, BULK_TIERS, SHIPPING, MAX_MEMBER_PCT, bulkPctFor, settingsFrom, memberPctFor, priceCart, memberPriceReport };
