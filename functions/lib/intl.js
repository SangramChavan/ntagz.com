// ntagz international orders: validation, USD pricing and quotation maths. Shared by the payments Worker and the admin Worker.
// Pure functions; destinations, postal rules, tax treatment and quantity breaks all come from data (intl_countries, products, tiers),
// never from country-specific branches. Amounts are integer minor units (cents for USD) so nothing is converted or rounded silently.

const CURRENCY = "USD";
const PRICE_LIST = "INTL-USD";
const MAX_QTY = 100000;

const clean = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

// Digits, spaces and common separators are accepted; the stored form is +<digits> (E.164 style, 7-15 digits).
function normalisePhone(v) {
  const raw = clean(v, 30).replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(raw) ? raw : null;
}

// country: a row from intl_countries. Returns {errors:{field:message}, value:{...clean fields}}.
function validateOrderDetails(b, country) {
  const errors = {}, v = {};
  v.name = clean(b.name, 100); if (v.name.length < 2) errors.name = "Enter your full name";
  v.company = clean(b.company, 120);
  v.email = clean(b.email, 254).toLowerCase(); if (!EMAIL.test(v.email)) errors.email = "Enter a valid email address";
  v.address1 = clean(b.address1, 120); if (v.address1.length < 4) errors.address1 = "Enter the street address";
  v.address2 = clean(b.address2, 120);
  v.city = clean(b.city, 80); if (v.city.length < 2) errors.city = "Enter the city";
  v.region = clean(b.region, 80);
  if (country.region_required && v.region.length < 2) errors.region = `Enter the ${String(country.region_label).replace(/\s*\(optional\)/i, "").toLowerCase()}`;
  v.postal = clean(b.postal, 20).toUpperCase();
  if (country.postal_required && !v.postal) errors.postal = `Enter the ${String(country.postal_label).toLowerCase()}`;
  else if (v.postal && country.postal_regex) { try { if (!new RegExp(country.postal_regex).test(v.postal)) errors.postal = `That ${String(country.postal_label).toLowerCase()} doesn't look right for ${country.name}`; } catch { /* a bad admin-entered pattern must never block orders */ } }
  v.phone = normalisePhone(b.phone); if (!v.phone) errors.phone = "Enter your phone number with the country code, e.g. +1 415 555 0100";
  v.tax_id = clean(b.tax_id, 40);
  v.notes = clean(b.notes, 1500);
  return { errors, value: v };
}

// items: [{id, qty}]. rows: {id: product row incl. intl columns}. tiers: {id: [{min_qty, unit_cents}] any order}.
// Returns {error} or {lines, subtotalCents, listCents, savingsCents, leadDays, currency}.
function priceIntlCart(items, rows, tiers) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) return { error: "Your cart is empty or has too many items" };
  const lines = []; const seen = new Set(); let subtotal = 0, list = 0, lead = 0;
  for (const it of items) {
    const id = it && typeof it.id === "string" ? it.id : "", qty = it && it.qty;
    if (seen.has(id)) return { error: "Each product can appear only once" };
    seen.add(id);
    const p = rows[id];
    if (!p || !p.active || !p.intl_enabled || !p.price_usd_cents) return { error: `${p && p.name ? p.name : "A product in your cart"} is not available for international orders`, id };
    if (p.intl_custom_quote) return { error: `${p.name} is made to order. Please send us an enquiry for a quotation`, id, custom: true };
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_QTY) return { error: "Enter a valid quantity", id };
    const moq = p.intl_moq || 1;
    if (qty < moq) return { error: `${p.name}: minimum order is ${moq}`, id };
    const ladder = (tiers[id] || []).slice().sort((a, b) => b.min_qty - a.min_qty);
    const t = ladder.find((x) => qty >= x.min_qty);
    const unit = t ? t.unit_cents : p.price_usd_cents;
    const lineCents = unit * qty;
    subtotal += lineCents; list += p.price_usd_cents * qty;
    lead = Math.max(lead, p.intl_lead_days || 0);
    lines.push({ id, name: p.name, qty, unitCents: unit, listUnitCents: p.price_usd_cents, lineCents, tierMinQty: t ? t.min_qty : null, leadDays: p.intl_lead_days || null, taxTreatment: p.intl_tax_treatment || "excl" });
  }
  if (!Number.isSafeInteger(subtotal) || subtotal < 1 || subtotal > 100_000_000_00) return { error: "Order total is out of range" };
  return { lines, subtotalCents: subtotal, listCents: list, savingsCents: Math.max(list - subtotal, 0), leadDays: lead || null, currency: CURRENCY, priceList: PRICE_LIST };
}

// What a quotation covers, so the customer sees it before paying.
const quoteTypeFor = (shippingMinor, taxesMinor, otherMinor = 0) => (taxesMinor > 0 || otherMinor > 0 ? "product_shipping_taxes" : shippingMinor > 0 ? "product_shipping" : "product_only");
const QUOTE_TYPE_LABEL = { product_only: "Products only", product_shipping: "Products plus shipping", product_shipping_taxes: "Products, shipping and specified taxes/charges" };

// Parses "12.34" / 12.34 into cents; null if blank, negative, or with more than 2 decimals.
function toMinor(v) {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
  const n = typeof v === "string" ? Number(v.trim().replace(/,/g, "")) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1_000_000) return null;
  const m = Math.round(n * 100);
  return Math.abs(m - n * 100) < 1e-6 ? m : null;
}

const money = (minor, currency) => (currency === "USD" ? "US$" : currency === "INR" ? "₹" : currency + " ") + (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Payment-link hosts must be https and on the admin-configured allow-list (default: well-known providers).
function validPaymentLink(url, hostsCsv) {
  try {
    const u = new URL(String(url).trim());
    if (u.protocol !== "https:" || u.username || u.password || u.href.length > 400) return null;
    const host = u.hostname.toLowerCase();
    const ok = String(hostsCsv || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean).some((h) => host === h || host.endsWith("." + h));
    return ok ? u.href : null;
  } catch { return null; }
}

module.exports = { CURRENCY, PRICE_LIST, MAX_QTY, clean, EMAIL, normalisePhone, validateOrderDetails, priceIntlCart, quoteTypeFor, QUOTE_TYPE_LABEL, toMinor, money, validPaymentLink };
