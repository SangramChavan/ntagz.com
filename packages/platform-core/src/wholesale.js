import PRICING from '../../../functions/lib/pricing.js'; // the ONE pricing engine; wholesale is priceCart in partner mode, never a second price path
import PAYLINKS from '../../../functions/lib/paylinks.js';
import STOCK from '../../../functions/lib/stock.js';
import { AppError } from './errors.js';
import { requirePermission } from './access.js';
import { auditStmt } from './audit.js';
import { PAY_BASE } from './quotes.js';

// Partner wholesale ordering (docs/platform/CONTRACTS.md section 12).
//  - price = ex-GST retail less the partner type's discount band, floored at cost x (1 + minimum Ntagz margin). HQ sets band and margin; nothing is seeded;
//    a product with no cost, or a type with no band, cannot be priced (refused, never guessed).
//  - the opening stock order (partner_fee_payments) is STOCK CREDIT in a ledger. Credit is a payment, not a discount: the order and its GST invoice
//    show the full value; credit pays part or all of it. Nothing is refunded in cash.
//  - credit not yet consumed but reserved by an open payment link is derived (balance below), so an expired or cancelled link releases it automatically.
//  - the remainder (if any) is paid through the existing pay-link flow; the payments Worker re-prices partner links with the same engine and finalises the order.
export const MARGIN_KEY = 'partner_min_margin_bp';
const LINK_HOURS = 72;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const bad = (msg, fields) => new AppError('VALIDATION_FAILED', msg, fields);
const text = (x, max) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : '');
const nowSec = () => Math.floor(Date.now() / 1000);

// Stock credit the partner can still use: ledger balance less credit reserved by open (active, unexpired, unpaid) links. $p/$n are the SQL parameters
// holding the partner id and "now" in the statement this is embedded in.
const PAID_LINK = "EXISTS (SELECT 1 FROM orders o WHERE o.payment_status = 'paid' AND o.txn_id IN (SELECT value FROM json_each(pl.txn_ids)))";
export const availSql = (p, n) => `(COALESCE((SELECT SUM(delta_paise) FROM partner_stock_credit WHERE partner_id = ${p}), 0)
  - COALESCE((SELECT SUM(pl.credit_paise) FROM pay_links pl WHERE pl.partner_id = ${p} AND pl.credit_paise > 0 AND pl.status = 'active' AND pl.expires_at > ${n} AND NOT ${PAID_LINK}), 0))`;

export async function balance(db, partnerId) {
  const t = nowSec();
  const r = await db.prepare(`SELECT
    COALESCE((SELECT SUM(delta_paise) FROM partner_stock_credit WHERE partner_id = ?1 AND kind = 'grant'), 0) AS granted,
    COALESCE((SELECT -SUM(delta_paise) FROM partner_stock_credit WHERE partner_id = ?1 AND kind = 'consume'), 0) AS consumed,
    COALESCE((SELECT SUM(pl.credit_paise) FROM pay_links pl WHERE pl.partner_id = ?1 AND pl.credit_paise > 0 AND pl.status = 'active' AND pl.expires_at > ?2 AND NOT ${PAID_LINK}), 0) AS held`).bind(partnerId, t).first();
  return { grantedPaise: r.granted, consumedPaise: r.consumed, heldPaise: r.held, availablePaise: r.granted - r.consumed - r.held };
}

export async function termsFor(db, typeKey) {
  const band = await db.prepare('SELECT discount_bp FROM partner_price_bands WHERE partner_type = ?').bind(typeKey).first();
  const m = await db.prepare('SELECT value FROM system_settings WHERE key = ?').bind(MARGIN_KEY).first();
  const mb = m && m.value !== null && m.value !== '' && Number.isInteger(Number(m.value)) ? Number(m.value) : null;
  return { discountBp: band ? band.discount_bp : null, minMarginBp: mb };
}

// Who may order: an active partner whose OWN partner type's role carries orders.place.own. The permission alone is not enough: the generic 'customer' role also
// carries it, and every signed-in person can hold that role, so a Smile+ partner (no ordering) would otherwise pass.
async function partnerCtx(db, access) {
  requirePermission(access, 'orders.place.own');
  if (!access.partnerId) throw new AppError('FORBIDDEN', 'Partner access is not active');
  const p = await db.prepare(`SELECT p.id, p.type_key, p.business_name, p.gstin, p.state, p.pincode, u.email, t.role_key,
      EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_key = t.role_key AND rp.permission_key = 'orders.place.own') AS can_order,
      json_extract(a.form_json, '$.name') AS contact_name, json_extract(a.form_json, '$.phone') AS contact_phone
    FROM partners p JOIN users u ON u.id = p.user_id JOIN partner_types t ON t.key = p.type_key LEFT JOIN partner_applications a ON a.partner_id = p.id WHERE p.id = ?`).bind(access.partnerId).first();
  if (!p || !p.can_order || !access.roles.includes(p.role_key)) throw new AppError('FORBIDDEN', 'Your partner type does not include wholesale ordering');
  return { ...p, terms: await termsFor(db, p.type_key) };
}
export async function canOrder(db, access) { try { await partnerCtx(db, access); return true; } catch { return false; } }

const productRows = async (db, ids) => Object.fromEntries((await db.prepare(`SELECT id, name, active, price_paise, cost_paise FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results.map((r) => [r.id, r]));

// Catalogue at the partner's own price. Cost and floor are never sent to a partner; a product with no usable price just says so.
export async function catalogue(db, access) {
  const ctx = await partnerCtx(db, access);
  const ids = Object.keys(PRICING.PRODUCTS);
  const rows = await productRows(db, ids);
  const products = ids.filter((id) => rows[id] && rows[id].active).map((id) => {
    const st = PRICING.PRODUCTS[id]; const r = rows[id];
    const pu = PRICING.partnerUnit({ price: r.price_paise / 100, allInclusive: !!st.allInclusive, costPaise: r.cost_paise, band: ctx.terms });
    return { id, name: r.name, moq: st.fixed ? 1 : st.moq || 10, fixed: !!st.fixed, packSize: st.packSize || 1,
      retailExPaise: pu.ok ? pu.retailExPaise : Math.round((st.allInclusive ? r.price_paise / 1.18 : r.price_paise)), partnerExPaise: pu.ok ? pu.unitExPaise : null, discountPct: pu.ok ? pu.pct : null, priced: pu.ok };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { ready: products.some((p) => p.priced), gstPct: PRICING.GST_PCT, products, credit: await balance(db, ctx.id) };
}

// Prices a cart for a partner type. Per-line problems are reported field by field. Returns the engine's totals in paise.
async function priceItems(db, terms, items, state) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) throw bad('Add between 1 and 30 products', { items: 'required' });
  const ids = items.map((i) => String(i && i.productId));
  if (new Set(ids).size !== ids.length) throw bad('Each product can be added once', { items: 'duplicate product' });
  const live = await productRows(db, ids); const errs = {}; const engine = [];
  items.forEach((it, i) => {
    const st = PRICING.PRODUCTS[ids[i]]; const row = live[ids[i]]; const qty = it && it.qty;
    if (!st || !row || !row.active) { errs[`items.${i}`] = 'not available'; return; }
    const moq = st.fixed ? 1 : st.moq || 10;
    if (!Number.isSafeInteger(qty) || qty < moq || qty > 100000 || (st.fixed && qty !== 1)) { errs[`items.${i}`] = st.fixed ? 'sold as one kit' : `minimum ${moq}`; return; }
    if (!PRICING.partnerUnit({ price: row.price_paise / 100, allInclusive: !!st.allInclusive, costPaise: row.cost_paise, band: terms }).ok) { errs[`items.${i}`] = 'no partner price yet'; return; }
    engine.push({ id: ids[i], qty });
  });
  if (Object.keys(errs).length) throw bad('Check the products and quantities', errs);
  const r = PRICING.priceCart(engine, { products: PRICING.PRODUCTS, live, state: state || null, member: false, settings: PRICING.settingsFrom({}), partner: terms });
  if (!r) throw bad('This basket is outside the range that can be ordered', { items: 'too large or too small' });
  return {
    lines: r.lines.map((l) => ({ productId: l.id, name: live[l.id].name, qty: l.qty, unitExPaise: Math.round(l.unitPrice * 100), retailExUnitPaise: Math.round(l.retailUnit * 100), discountPct: l.partnerPct, lineExPaise: Math.round(l.net * 100) })),
    engine, totals: { pieces: r.pieces, retailExPaise: Math.round(r.subtotal * 100), discountPaise: r.partnerDiscountPaise, shippingPaise: r.shippingPaise, gstPaise: Math.round(r.gst * 100), totalPaise: r.amount * 100 },
  };
}

// How much stock credit goes on an order of `total` paise. The gateway cannot take under Rs 1, so a part-payment never leaves less than that.
function creditFor(availablePaise, total, useCredit) {
  let c = useCredit === false ? 0 : Math.min(Math.max(availablePaise, 0), total);
  if (c < total && total - c < 100) c = Math.max(total - 100, 0);
  return c;
}

export async function price(db, access, { items, state, useCredit }) {
  const ctx = await partnerCtx(db, access);
  const { lines, totals } = await priceItems(db, ctx.terms, items, text(state, 50) || ctx.state);
  const bal = await balance(db, ctx.id); const creditPaise = creditFor(bal.availablePaise, totals.totalPaise, useCredit);
  return { lines, totals, creditPaise, payablePaise: totals.totalPaise - creditPaise, availableCreditPaise: bal.availablePaise };
}

export async function placeOrder(db, access, body, env = {}) {
  const ctx = await partnerCtx(db, access); const b = body || {};
  const errs = {};
  const address = text(b.address, 500); if (address.length < 10) errs.address = 'Enter the full delivery address';
  const pincode = text(b.pincode, 6) || ctx.pincode || ''; if (!/^\d{6}$/.test(pincode)) errs.pincode = 'Enter the 6-digit pincode';
  const state = text(b.state, 50) || ctx.state || ''; if (!state) errs.state = 'Choose the delivery state';
  const gstin = (text(b.gstin, 15) || ctx.gstin || '').toUpperCase(); if (gstin && !GSTIN_RE.test(gstin)) errs.gstin = 'That GST number is not valid';
  const phone = String(b.phone || ctx.contact_phone || '').replace(/\D/g, '').slice(-10); if (phone.length !== 10) errs.phone = 'Enter a 10-digit mobile number';
  const name = text(b.contactName, 100) || text(ctx.contact_name, 100) || ctx.business_name;
  if (Object.keys(errs).length) throw bad('Please fix the highlighted fields', errs);

  const { lines, engine, totals } = await priceItems(db, ctx.terms, b.items, state);
  const bal = await balance(db, ctx.id); const credit = creditFor(bal.availablePaise, totals.totalPaise, b.useCredit);
  const total = totals.totalPaise; const t = nowSec();
  const itemsJson = JSON.stringify(engine);
  const audit = auditStmt(db, { actor: access.userId, action: 'wholesale.order', entityType: 'partner', entityId: ctx.id, after: { totalPaise: total, creditPaise: credit, lines: engine.length } });

  if (credit === total) { // stock credit pays all of it: the order is created now, in one guarded batch (no gateway, nothing to collect)
    const oid = crypto.randomUUID(); const txn = `CRD-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    await db.batch([
      db.prepare(`INSERT INTO orders (id, user_id, txn_id, gateway, quote_ref, items_json, name, phone, email, address, pincode, state, gstin, subtotal, gst, total, payment_method, payment_status, paid_paise, shipping_paise, discount_paise, partner_id, stock_credit_paise)
        SELECT ?1, NULL, ?2, 'stock_credit', NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'stock_credit', 'paid', ?13, ?14, ?15, ?16, ?13 WHERE ${availSql('?16', '?17')} >= ?13`)
        .bind(oid, txn, itemsJson, name, phone, ctx.email, address, pincode, state, gstin || null, total - totals.gstPaise, totals.gstPaise, total, totals.shippingPaise, totals.discountPaise, ctx.id, t),
      db.prepare("INSERT INTO payments (id, order_id, method, amount_paise, recorded_by, idempotency_key, reference) SELECT ?, id, 'stock_credit', ?, 'partner', ?, ? FROM orders WHERE id = ?")
        .bind(crypto.randomUUID(), total, `credit:${oid}`, txn, oid),
      db.prepare("INSERT INTO partner_stock_credit (id, partner_id, kind, delta_paise, order_id, actor) SELECT ?, partner_id, 'consume', -stock_credit_paise, id, ? FROM orders WHERE id = ?").bind(crypto.randomUUID(), access.userId, oid),
      ...STOCK.stockStatements(db, oid, txn, engine),
      audit,
    ]);
    // not meta.changes: the orders table has AFTER INSERT triggers, and D1 counts their row changes too. The guarded insert either made the row or it did not.
    if (!(await db.prepare('SELECT 1 AS x FROM orders WHERE id = ?').bind(oid).first())) throw new AppError('CONFLICT', 'Your stock credit changed. Reload and try again.');
    return { kind: 'order', orderId: oid, orderRef: txn, totalPaise: total, creditPaise: credit, payablePaise: 0 };
  }

  const id = PAYLINKS.newToken(); const note = `Wholesale order ${ctx.business_name}`;
  const res = await db.batch([
    db.prepare(`INSERT INTO pay_links (id, source, created_by, items_json, orig_items_json, name, phone, email, address, pincode, state, gstin, note, quoted_paise, created_at, expires_at, partner_id, credit_paise)
      SELECT ?1, 'admin', ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16 WHERE ?16 = 0 OR ${availSql('?15', '?13')} >= ?16`)
      .bind(id, `partner:${ctx.id}`, itemsJson, name, phone, ctx.email, address, pincode, state, gstin || null, note, total, t, t + LINK_HOURS * 3600, ctx.id, credit),
    audit,
  ]);
  if (res[0].meta.changes !== 1) throw new AppError('CONFLICT', 'Your stock credit changed. Reload and try again.');
  return { kind: 'link', linkId: id, payUrl: PAY_BASE + id, expiresAt: t + LINK_HOURS * 3600, totalPaise: total, creditPaise: credit, payablePaise: total - credit };
}

const names = async (db) => Object.fromEntries((await db.prepare('SELECT id, name FROM products').all()).results.map((r) => [r.id, r.name]));
const itemsOut = (json, nm) => { try { return JSON.parse(json || '[]').map((i) => ({ productId: i.id, name: nm[i.id] || i.id, qty: i.qty })); } catch { return []; } };

// The partner's wholesale orders: paid ones, and links still waiting for payment (cancelled and expired ones are listed so nothing disappears).
export async function listMine(db, access) {
  const ctx = await partnerCtx(db, access); const nm = await names(db); const t = nowSec();
  const orders = (await db.prepare("SELECT id, txn_id, created_at, total, gst, stock_credit_paise, status, items_json FROM orders WHERE partner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100").bind(ctx.id).all()).results;
  const links = (await db.prepare(`SELECT pl.id, pl.created_at, pl.expires_at, pl.quoted_paise, pl.credit_paise, pl.status, pl.items_json FROM pay_links pl
    WHERE pl.partner_id = ? AND NOT ${PAID_LINK} ORDER BY pl.created_at DESC LIMIT 100`).bind(ctx.id).all()).results;
  const items = [
    ...orders.map((o) => ({ kind: 'order', id: o.id, ref: o.txn_id, at: o.created_at, status: o.status, totalPaise: o.total, gstPaise: o.gst, creditPaise: o.stock_credit_paise, payablePaise: 0, items: itemsOut(o.items_json, nm) })),
    ...links.map((l) => { const st = l.status === 'cancelled' ? 'cancelled' : l.expires_at <= t ? 'expired' : 'awaiting_payment';
      return { kind: 'link', id: l.id, ref: l.id.slice(0, 8), at: l.created_at, status: st, totalPaise: l.quoted_paise, creditPaise: l.credit_paise, payablePaise: l.quoted_paise - l.credit_paise, expiresAt: l.expires_at, payUrl: st === 'awaiting_payment' ? PAY_BASE + l.id : null, items: itemsOut(l.items_json, nm) }; }),
  ].sort((a, b) => b.at - a.at);
  return { items, credit: await balance(db, ctx.id) };
}

export async function ledgerMine(db, access) {
  const ctx = await partnerCtx(db, access);
  const rows = (await db.prepare("SELECT c.kind, c.delta_paise, c.created_at, o.txn_id AS order_ref FROM partner_stock_credit c LEFT JOIN orders o ON o.id = c.order_id WHERE c.partner_id = ? ORDER BY c.created_at DESC, c.rowid DESC LIMIT 200").bind(ctx.id).all()).results;
  return { credit: await balance(db, ctx.id), entries: rows.map((r) => ({ kind: r.kind, deltaPaise: r.delta_paise, at: r.created_at, orderRef: r.order_ref })) };
}

// Cancelling an unpaid link releases its reserved credit at once. Someone else's link is "not found".
export async function cancelMine(db, access, linkId) {
  const ctx = await partnerCtx(db, access);
  const l = await db.prepare('SELECT id FROM pay_links WHERE id = ? AND partner_id = ?').bind(String(linkId), ctx.id).first();
  if (!l) throw new AppError('NOT_FOUND', 'Not found');
  const res = await db.batch([
    db.prepare(`UPDATE pay_links SET status = 'cancelled' WHERE id = ?1 AND partner_id = ?2 AND status = 'active' AND NOT EXISTS (SELECT 1 FROM orders WHERE payment_status = 'paid' AND txn_id IN (SELECT value FROM json_each(pay_links.txn_ids)))`).bind(l.id, ctx.id),
    auditStmt(db, { actor: access.userId, action: 'wholesale.cancel', entityType: 'partner', entityId: ctx.id, after: { link: l.id.slice(0, 8) } }),
  ]);
  if (res[0].meta.changes !== 1) throw new AppError('CONFLICT', 'This order can no longer be cancelled');
  return listMine(db, access);
}

// ---------------------------------------------------------------- HQ
function hqAll(access, perm) { if (requirePermission(access, perm) !== 'all') throw new AppError('NOT_FOUND', 'Not found'); }

// Bands, the margin, and for every product x partner type the resulting price with the reasons it is limited or refused (no cost, no band),
// and where the PUBLIC bulk tiers land at or below the partner price.
export async function adminConfig(db, access) {
  hqAll(access, 'pricing.manage');
  const types = (await db.prepare(`SELECT t.key, t.label, t.fee_paise, t.active, b.discount_bp, EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_key = t.role_key AND rp.permission_key = 'orders.place.own') AS can_order
    FROM partner_types t LEFT JOIN partner_price_bands b ON b.partner_type = t.key ORDER BY t.sort`).all()).results;
  const m = await db.prepare('SELECT value FROM system_settings WHERE key = ?').bind(MARGIN_KEY).first();
  const minMarginBp = m && m.value !== null && m.value !== '' ? Number(m.value) : null;
  const rows = (await db.prepare('SELECT id, name, active, price_paise, cost_paise FROM products ORDER BY name').all()).results.filter((r) => PRICING.PRODUCTS[r.id]);
  const products = rows.map((r) => ({ id: r.id, name: r.name, active: !!r.active, retailPaise: r.price_paise, costPaise: r.cost_paise, allInclusive: !!PRICING.PRODUCTS[r.id].allInclusive,
    byType: Object.fromEntries(types.map((t) => [t.key, PRICING.partnerPriceReport(PRICING.PRODUCTS[r.id], r, { discountBp: t.discount_bp, minMarginBp })])) }));
  return { minMarginBp, types: types.map((t) => ({ key: t.key, label: t.label, openingPaise: t.fee_paise, discountBp: t.discount_bp, canOrder: !!t.can_order })), products,
    missingCost: products.filter((p) => p.active && (p.costPaise === null || p.costPaise <= 0)).map((p) => p.id) };
}

export async function setBand(db, access, { partnerType, discountBp }) {
  hqAll(access, 'pricing.manage');
  const t = await db.prepare('SELECT key FROM partner_types WHERE key = ?').bind(String(partnerType || '')).first();
  if (!t) throw bad('Choose a partner type', { partnerType: 'unknown' });
  const clear = discountBp === null || discountBp === '';
  if (!clear && (!Number.isInteger(discountBp) || discountBp < 0 || discountBp > 9000)) throw bad('The discount must be between 0% and 90%', { discountBp: '0 to 9000 basis points' });
  const before = await db.prepare('SELECT discount_bp FROM partner_price_bands WHERE partner_type = ?').bind(t.key).first();
  await db.batch([
    clear ? db.prepare('DELETE FROM partner_price_bands WHERE partner_type = ?').bind(t.key)
      : db.prepare('INSERT INTO partner_price_bands (partner_type, discount_bp, updated_by) VALUES (?, ?, ?) ON CONFLICT(partner_type) DO UPDATE SET discount_bp = excluded.discount_bp, updated_by = excluded.updated_by, updated_at = unixepoch()').bind(t.key, discountBp, access.userId),
    auditStmt(db, { actor: access.userId, action: 'wholesale.band', entityType: 'partner_type', entityId: t.key, before: { discountBp: before ? before.discount_bp : null }, after: { discountBp: clear ? null : discountBp } }),
  ]);
  return adminConfig(db, access);
}

export async function setMargin(db, access, { minMarginBp }) {
  hqAll(access, 'pricing.manage');
  const clear = minMarginBp === null || minMarginBp === '';
  if (!clear && (!Number.isInteger(minMarginBp) || minMarginBp < 0 || minMarginBp > 10000)) throw bad('The margin must be between 0% and 100%', { minMarginBp: '0 to 10000 basis points' });
  const before = await db.prepare('SELECT value FROM system_settings WHERE key = ?').bind(MARGIN_KEY).first();
  await db.batch([
    clear ? db.prepare('DELETE FROM system_settings WHERE key = ?').bind(MARGIN_KEY)
      : db.prepare('INSERT INTO system_settings (key, value, updated_by) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = unixepoch()').bind(MARGIN_KEY, String(minMarginBp), access.userId),
    auditStmt(db, { actor: access.userId, action: 'wholesale.margin', entityType: 'setting', entityId: MARGIN_KEY, before: { value: before ? before.value : null }, after: { value: clear ? null : minMarginBp } }),
  ]);
  return adminConfig(db, access);
}

export async function adminPartners(db, access) {
  hqAll(access, 'orders.read.all');
  const rows = (await db.prepare(`SELECT p.id, p.partner_code, p.business_name, p.type_key, p.status,
      EXISTS (SELECT 1 FROM partner_types t JOIN role_permissions rp ON rp.role_key = t.role_key AND rp.permission_key = 'orders.place.own' WHERE t.key = p.type_key) AS can_order,
      (SELECT COUNT(*) FROM orders o WHERE o.partner_id = p.id) AS orders_n,
      (SELECT COALESCE(SUM(o.total), 0) FROM orders o WHERE o.partner_id = p.id) AS orders_paise
    FROM partners p WHERE EXISTS (SELECT 1 FROM partner_stock_credit c WHERE c.partner_id = p.id) OR EXISTS (SELECT 1 FROM orders o WHERE o.partner_id = p.id) OR p.status = 'active'
    ORDER BY p.business_name`).all()).results;
  const out = [];
  for (const r of rows) out.push({ id: r.id, partnerCode: r.partner_code, business: r.business_name, typeKey: r.type_key, status: r.status, canOrder: !!r.can_order, ordersN: r.orders_n, ordersPaise: r.orders_paise, credit: await balance(db, r.id) });
  return { items: out, problems: await creditProblems(db) };
}

export async function adminOrders(db, access, partnerId) {
  hqAll(access, 'orders.read.all');
  const p = await db.prepare('SELECT id, partner_code, business_name FROM partners WHERE id = ?').bind(String(partnerId)).first();
  if (!p) throw new AppError('NOT_FOUND', 'Not found');
  const nm = await names(db); const t = nowSec();
  const orders = (await db.prepare('SELECT id, txn_id, created_at, total, gst, stock_credit_paise, status, items_json FROM orders WHERE partner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200').bind(p.id).all()).results;
  const open = (await db.prepare(`SELECT pl.id, pl.created_at, pl.expires_at, pl.quoted_paise, pl.credit_paise, pl.status FROM pay_links pl WHERE pl.partner_id = ? AND NOT ${PAID_LINK} ORDER BY pl.created_at DESC LIMIT 100`).bind(p.id).all()).results;
  return { partner: { id: p.id, partnerCode: p.partner_code, business: p.business_name }, credit: await balance(db, p.id),
    orders: orders.map((o) => ({ id: o.id, ref: o.txn_id, at: o.created_at, status: o.status, totalPaise: o.total, gstPaise: o.gst, creditPaise: o.stock_credit_paise, items: itemsOut(o.items_json, nm) })),
    links: open.map((l) => ({ ref: l.id.slice(0, 8), at: l.created_at, status: l.status === 'cancelled' ? 'cancelled' : l.expires_at <= t ? 'expired' : 'awaiting_payment', totalPaise: l.quoted_paise, creditPaise: l.credit_paise })) };
}

// The credit invariant (a test runs it, and HQ sees it on the partners list). Returns human-readable problems; [] means the books balance:
//   balance = grants - consumes; grants = opening payments (net of GST); every consume is exactly the credit its order shows, with a matching stock_credit payment.
export async function creditProblems(db) {
  const out = [];
  const q = async (sql) => (await db.prepare(sql).all()).results;
  for (const r of await q("SELECT partner_id, SUM(delta_paise) AS bal FROM partner_stock_credit GROUP BY partner_id HAVING bal < 0")) out.push(`partner ${r.partner_id}: credit balance is negative`);
  for (const r of await q(`SELECT p.partner_id, p.paid, COALESCE(g.granted, 0) AS granted FROM
      (SELECT partner_id, SUM(amount_paise - gst_paise) AS paid FROM partner_fee_payments WHERE amount_paise > gst_paise GROUP BY partner_id) p
      LEFT JOIN (SELECT partner_id, SUM(delta_paise) AS granted FROM partner_stock_credit WHERE kind = 'grant' GROUP BY partner_id) g ON g.partner_id = p.partner_id WHERE p.paid <> COALESCE(g.granted, 0)`))
    out.push(`partner ${r.partner_id}: grants ${r.granted} differ from opening payments ${r.paid}`);
  for (const r of await q(`SELECT c.order_id, c.partner_id, -c.delta_paise AS used, o.stock_credit_paise, o.partner_id AS o_partner,
      COALESCE((SELECT SUM(amount_paise) FROM payments WHERE order_id = c.order_id AND method = 'stock_credit'), 0) AS paid_by_credit
    FROM partner_stock_credit c LEFT JOIN orders o ON o.id = c.order_id WHERE c.kind = 'consume'
      AND (o.id IS NULL OR o.partner_id IS NOT c.partner_id OR o.stock_credit_paise <> -c.delta_paise OR COALESCE((SELECT SUM(amount_paise) FROM payments WHERE order_id = c.order_id AND method = 'stock_credit'), 0) <> -c.delta_paise)`))
    out.push(`order ${r.order_id}: credit consumed ${r.used} does not match the order (${r.stock_credit_paise}) or its payment (${r.paid_by_credit})`);
  for (const r of await q("SELECT o.id FROM orders o WHERE o.stock_credit_paise > 0 AND NOT EXISTS (SELECT 1 FROM partner_stock_credit c WHERE c.order_id = o.id)")) out.push(`order ${r.id}: shows stock credit but nothing was consumed`);
  for (const r of await q("SELECT o.id FROM orders o WHERE o.partner_id IS NOT NULL AND o.paid_paise <> o.total AND o.payment_status = 'paid'")) out.push(`order ${r.id}: paid amount differs from total`);
  return out;
}
