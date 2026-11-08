import PRICING from '../../../functions/lib/pricing.js'; // the SAME engine checkout charges with (guest pricing)
import { AppError } from './errors.js';
import { requirePermission } from './access.js';
import { auditStmt } from './audit.js';
import { queueEmail, hqRecipients } from './mail.js';

// Quotations. A quote is a priced, FROZEN offer for one lead. Rules:
//  - lines are priced by the checkout engine, so the total is what the customer would be charged; nobody can type a price or a discount;
//  - the snapshot never changes after it is saved (an edit re-prices and replaces it, and only while the quote is a draft or was rejected);
//  - partners work only on their own quotes, for their own open leads; only HQ/Operations approve or reject;
//  - draft -> pending_approval -> approved | rejected; approved -> sent -> accepted | declined; approved/sent expire by date.
export const STATUSES = ['draft', 'pending_approval', 'approved', 'rejected', 'sent', 'accepted', 'declined', 'expired', 'cancelled'];
const OPEN_LEAD = ['new', 'contacted', 'qualified', 'quotation'];
const inr = (paise) => '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const day = (ts) => new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const text = (x, max) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null);
const esc = (t) => t.replace(/[\\%_]/g, (c) => '\\' + c);
const bad = (msg, fields) => new AppError('VALIDATION_FAILED', msg, fields);

function partnerOf(access) {
  requirePermission(access, 'quotes.create');
  if (!access.partnerId) throw new AppError('FORBIDDEN', 'Partner access is not active');
  return access.partnerId;
}
function hqAll(access) { const scope = requirePermission(access, 'quotes.approve'); if (scope !== 'all') throw new AppError('NOT_FOUND', 'Not found'); }

// ---- catalogue and pricing ----
export async function catalogue(db, access) {
  partnerOf(access);
  const ids = Object.keys(PRICING.PRODUCTS);
  const rows = (await db.prepare(`SELECT id, name, price_paise FROM products WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')}) ORDER BY name`).bind(...ids).all()).results;
  return rows.map((r) => { const st = PRICING.PRODUCTS[r.id]; return { id: r.id, name: r.name, listPricePaise: r.price_paise, moq: st.fixed ? 1 : st.moq || 10, fixed: !!st.fixed, allInclusive: !!st.allInclusive, packSize: st.packSize || 1 }; });
}

async function priceItems(db, items, state) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) throw bad('Add between 1 and 30 products', { items: 'required' });
  const ids = items.map((i) => String(i && i.productId));
  if (new Set(ids).size !== ids.length) throw bad('Each product can be added once', { items: 'duplicate product' });
  const rows = (await db.prepare(`SELECT id, name, category, price_paise, active FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results;
  const live = {}; for (const r of rows) live[r.id] = r;
  const errs = {}; const engine = [];
  items.forEach((it, i) => {
    const st = PRICING.PRODUCTS[ids[i]]; const row = live[ids[i]]; const qty = it && it.qty;
    if (!st || !row || !row.active) { errs[`items.${i}`] = 'not available'; return; }
    const moq = st.fixed ? 1 : st.moq || 10;
    if (!Number.isSafeInteger(qty) || qty < moq || qty > 100000 || (st.fixed && qty !== 1)) { errs[`items.${i}`] = st.fixed ? 'sold as one kit' : `minimum ${moq}`; return; }
    engine.push({ id: ids[i], qty });
  });
  if (Object.keys(errs).length) throw bad('Check the products and quantities', errs);
  const r = PRICING.priceCart(engine, { products: PRICING.PRODUCTS, live, state: state || null, member: false, settings: PRICING.settingsFrom({}) });
  if (!r) throw bad('This basket is outside the range that can be quoted', { items: 'too large or too small' });
  return {
    lines: r.lines.map((l) => ({ productId: l.id, name: live[l.id].name, qty: l.qty, unitPricePaise: Math.round(l.unitPrice * 100), bulkPct: l.bulkPct, lineNetPaise: Math.round(l.net * 100), allInclusive: l.allInclusive ? 1 : 0 })),
    totals: { pieces: r.pieces, subtotalPaise: Math.round(r.subtotal * 100), discountPaise: Math.round(r.bulkDiscount * 100), gstPaise: Math.round(r.gst * 100), shippingPaise: r.shippingPaise, totalPaise: Math.round(r.amount * 100) },
  };
}
// A price check for the form (nothing is saved).
export async function price(db, access, { items, state }) { partnerOf(access); return priceItems(db, items, text(state, 80)); }

// ---- output ----
function out(q, items, hq) {
  const o = {
    id: q.id, number: q.number, leadId: q.lead_id, status: q.status, customerName: q.customer_name, customerPhone: q.customer_phone, customerEmail: q.customer_email, shipState: q.ship_state,
    validUntil: q.valid_until, notes: q.notes, decisionNote: q.decision_note, pieces: q.pieces, subtotalPaise: q.subtotal_paise, discountPaise: q.discount_paise, gstPaise: q.gst_paise,
    shippingPaise: q.shipping_paise, totalPaise: q.total_paise, approvedAt: q.approved_at, sentAt: q.sent_at, respondedAt: q.responded_at, createdAt: q.created_at, updatedAt: q.updated_at,
    leadBusiness: q.lead_business ?? null,
  };
  if (items) o.items = items.map((i) => ({ productId: i.product_id, name: i.name, qty: i.qty, unitPricePaise: i.unit_price_paise, bulkPct: i.bulk_pct, lineNetPaise: i.line_net_paise, allInclusive: !!i.all_inclusive }));
  if (hq) { o.partnerId = q.partner_id; o.partnerCode = q.partner_code ?? null; o.partnerBusiness = q.partner_business ?? null; o.approvedBy = q.approved_by; }
  if (['approved', 'sent', 'accepted'].includes(q.status) && items) o.shareText = shareText(q, items);
  return o;
}
function shareText(q, items) {
  const lines = items.map((i) => `• ${i.qty.toLocaleString('en-IN')} × ${i.name} — ${inr(i.line_net_paise)}${i.all_inclusive ? ' (incl. GST)' : ''}`);
  return [`Quotation ${q.number} from Ntagz`, `For: ${q.customer_name}`, '', ...lines, '',
    q.discount_paise > 0 ? `Quantity discount: −${inr(q.discount_paise)}` : null, `GST: ${inr(q.gst_paise)}`, q.ship_state ? `Shipping: ${q.shipping_paise > 0 ? inr(q.shipping_paise) : 'free'}` : 'Shipping: extra, depending on delivery address',
    `Total: ${inr(q.total_paise)}`, `Valid until ${day(q.valid_until)}`].filter((x) => x !== null).join('\n');
}
async function itemsOf(db, id) { return (await db.prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY position').bind(id).all()).results; }
const expire = (db) => db.prepare("UPDATE quotations SET status = 'expired', updated_at = unixepoch() WHERE status IN ('approved', 'sent') AND valid_until < unixepoch()").run();
const itemStmts = (db, id, lines) => lines.map((l, i) => db.prepare('INSERT INTO quotation_items (id, quotation_id, product_id, name, qty, unit_price_paise, bulk_pct, line_net_paise, all_inclusive, position) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT status FROM quotations WHERE id = ?) = \'draft\'')
  .bind(crypto.randomUUID(), id, l.productId, l.name, l.qty, l.unitPricePaise, l.bulkPct, l.lineNetPaise, l.allInclusive, i, id));
const leadNote = (db, leadId, actor, kind, body) => db.prepare('INSERT INTO lead_activities (id, lead_id, actor, actor_kind, kind, body) VALUES (?, ?, ?, ?, \'note\', ?)').bind(crypto.randomUUID(), leadId, actor, kind, body);

// ---- partner side ----
export async function createQuote(db, access, { leadId, items, validDays, notes }, env = {}) {
  const partnerId = partnerOf(access);
  const lead = await db.prepare('SELECT * FROM leads WHERE id = ? AND partner_id = ?').bind(String(leadId || ''), partnerId).first();
  if (!lead) throw new AppError('NOT_FOUND', 'Lead not found');
  if (!OPEN_LEAD.includes(lead.status)) throw new AppError('CONFLICT', 'You can only quote an open lead');
  const days = validDays === undefined || validDays === '' ? 15 : Number(validDays);
  if (!Number.isInteger(days) || days < 1 || days > 60) throw bad('Validity must be 1 to 60 days', { validDays: '1 to 60' });
  const { lines, totals } = await priceItems(db, items, lead.state);
  const id = crypto.randomUUID(); const year = new Date().getFullYear(); const validUntil = Math.floor(Date.now() / 1000) + days * 86400;
  const base = (await db.prepare('SELECT COUNT(*) n FROM quotations WHERE number LIKE ?').bind(`Q-${year}-%`).first()).n;
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    const number = `Q-${year}-${String(base + i).padStart(4, '0')}`;
    try {
      await db.batch([
        db.prepare('INSERT INTO quotations (id, number, lead_id, partner_id, created_by, customer_name, customer_phone, customer_email, ship_state, valid_until, notes, pieces, subtotal_paise, discount_paise, gst_paise, shipping_paise, total_paise) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, number, lead.id, partnerId, access.userId, lead.contact_name, lead.phone, lead.email, lead.state, validUntil, text(notes, 1000), totals.pieces, totals.subtotalPaise, totals.discountPaise, totals.gstPaise, totals.shippingPaise, totals.totalPaise),
        ...itemStmts(db, id, lines),
        leadNote(db, lead.id, access.userId, 'partner', `Quotation ${number} drafted (${inr(totals.totalPaise)})`),
        auditStmt(db, { actor: access.userId, action: 'quote.create', entityType: 'quotation', entityId: id, after: { number, leadId: lead.id, totalPaise: totals.totalPaise } }),
      ]);
      return getMine(db, access, id);
    } catch (e) { if (!/UNIQUE.*quotations\.number/i.test(String(e && e.message))) throw e; lastErr = e; }
  }
  throw lastErr;
}

export async function listMine(db, access, { status, leadId } = {}) {
  const partnerId = partnerOf(access); await expire(db);
  const conds = ['q.partner_id = ?']; const binds = [partnerId];
  if (STATUSES.includes(status)) { conds.push('q.status = ?'); binds.push(status); }
  if (leadId) { conds.push('q.lead_id = ?'); binds.push(String(leadId)); }
  const rows = (await db.prepare(`SELECT q.*, l.business_name AS lead_business FROM quotations q JOIN leads l ON l.id = q.lead_id WHERE ${conds.join(' AND ')} ORDER BY q.updated_at DESC, q.rowid DESC LIMIT 200`).bind(...binds).all()).results;
  const cs = (await db.prepare('SELECT status, COUNT(*) n FROM quotations WHERE partner_id = ? GROUP BY status').bind(partnerId).all()).results;
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])); for (const c of cs) counts[c.status] = c.n;
  return { items: rows.map((r) => out(r, null, false)), counts };
}
async function loadMine(db, partnerId, id) {
  const q = await db.prepare('SELECT q.*, l.business_name AS lead_business FROM quotations q JOIN leads l ON l.id = q.lead_id WHERE q.id = ? AND q.partner_id = ?').bind(String(id), partnerId).first(); // someone else's quote is "not found"
  if (!q) throw new AppError('NOT_FOUND', 'Not found');
  return q;
}
export async function getMine(db, access, id) {
  const partnerId = partnerOf(access); await expire(db);
  const q = await loadMine(db, partnerId, id);
  return { quote: out(q, await itemsOf(db, q.id), false) };
}

export async function replaceItems(db, access, id, { items, validDays, notes }) {
  const partnerId = partnerOf(access); const q = await loadMine(db, partnerId, id);
  if (!['draft', 'rejected'].includes(q.status)) throw new AppError('CONFLICT', 'Only a draft or a rejected quotation can be changed');
  const { lines, totals } = await priceItems(db, items, q.ship_state);
  const days = validDays === undefined || validDays === '' ? null : Number(validDays);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 60)) throw bad('Validity must be 1 to 60 days', { validDays: '1 to 60' });
  const res = await db.batch([
    db.prepare("UPDATE quotations SET status = 'draft', decision_note = NULL, pieces = ?, subtotal_paise = ?, discount_paise = ?, gst_paise = ?, shipping_paise = ?, total_paise = ?, valid_until = COALESCE(?, valid_until), notes = COALESCE(?, notes), updated_at = unixepoch() WHERE id = ? AND partner_id = ? AND status IN ('draft','rejected')")
      .bind(totals.pieces, totals.subtotalPaise, totals.discountPaise, totals.gstPaise, totals.shippingPaise, totals.totalPaise, days === null ? null : Math.floor(Date.now() / 1000) + days * 86400, text(notes, 1000), id, partnerId),
    db.prepare("DELETE FROM quotation_items WHERE quotation_id = ? AND (SELECT status FROM quotations WHERE id = ?) = 'draft'").bind(id, id),
    ...itemStmts(db, id, lines),
    auditStmt(db, { actor: access.userId, action: 'quote.edit', entityType: 'quotation', entityId: id, before: { totalPaise: q.total_paise }, after: { totalPaise: totals.totalPaise } }),
  ]);
  if (res[0].meta.changes !== 1) throw new AppError('CONFLICT', 'The quotation changed. Reload and try again.');
  return getMine(db, access, id);
}

async function move(db, who, id, { from, to, set = '', binds = [], by, extra = [], action, after }) {
  const res = await db.batch([
    db.prepare(`UPDATE quotations SET status = ?${set}, updated_at = unixepoch() WHERE id = ? AND status IN (${from.map(() => '?').join(',')})${who.partnerId ? ' AND partner_id = ?' : ''}`)
      .bind(to, ...binds, id, ...from, ...(who.partnerId ? [who.partnerId] : [])),
    auditStmt(db, { actor: by, action, entityType: 'quotation', entityId: id, before: { status: from }, after: { status: to, ...(after || {}) } }),
    ...extra,
  ]);
  if (res[0].meta.changes !== 1) throw new AppError('CONFLICT', 'The quotation changed. Reload and try again.');
}

export async function submit(db, access, id, env = {}) {
  const partnerId = partnerOf(access); const q = await loadMine(db, partnerId, id);
  if (q.status !== 'draft') throw new AppError('CONFLICT', 'Only a draft can be submitted');
  const n = (await db.prepare('SELECT COUNT(*) n FROM quotation_items WHERE quotation_id = ?').bind(id).first()).n; if (!n) throw bad('Add at least one product', { items: 'required' });
  const p = await db.prepare('SELECT business_name FROM partners WHERE id = ?').bind(partnerId).first();
  const rev = (await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_type = 'quotation' AND entity_id = ?").bind(id).first()).n;
  const data = { number: q.number, businessName: q.lead_business, partnerBusiness: p && p.business_name, total: inr(q.total_paise) };
  await move(db, { partnerId }, id, { from: ['draft'], to: 'pending_approval', by: access.userId, action: 'quote.submit', extra: hqRecipients(env).map((to) => queueEmail(db, { to, template: 'quotation_submitted', data, dedupeKey: `quotation_submitted:${id}:${rev}:${to}` })) });
  return getMine(db, access, id);
}
export async function cancel(db, access, id) {
  const partnerId = partnerOf(access); const q = await loadMine(db, partnerId, id);
  if (!['draft', 'pending_approval', 'rejected', 'approved'].includes(q.status)) throw new AppError('CONFLICT', `A ${q.status} quotation cannot be cancelled`);
  await move(db, { partnerId }, id, { from: ['draft', 'pending_approval', 'rejected', 'approved'], to: 'cancelled', by: access.userId, action: 'quote.cancel' });
  return getMine(db, access, id);
}
export async function markSent(db, access, id) {
  const partnerId = partnerOf(access); await expire(db); const q = await loadMine(db, partnerId, id);
  if (q.status !== 'approved') throw new AppError('CONFLICT', 'Only an approved quotation can be marked as sent');
  await move(db, { partnerId }, id, { from: ['approved'], to: 'sent', set: ', sent_at = unixepoch()', by: access.userId, action: 'quote.sent' });
  return getMine(db, access, id);
}
async function respond(db, who, q, outcome, by, kind) {
  if (!['accepted', 'declined'].includes(outcome)) throw bad('Choose accepted or declined', { outcome: 'invalid' });
  if (!['approved', 'sent'].includes(q.status)) throw new AppError('CONFLICT', `A ${q.status} quotation cannot take a customer answer`);
  await move(db, who, q.id, { from: ['approved', 'sent'], to: outcome, set: ', responded_at = unixepoch()', by, action: `quote.${outcome}`,
    extra: [leadNote(db, q.lead_id, by, kind, `Customer ${outcome} quotation ${q.number} (${inr(q.total_paise)})`)] });
}
export async function recordResponseMine(db, access, id, outcome) {
  const partnerId = partnerOf(access); await expire(db); const q = await loadMine(db, partnerId, id);
  await respond(db, { partnerId }, q, outcome, access.userId, 'partner'); return getMine(db, access, id);
}

// ---- payment link (the existing pay_links tool collects the money) ----
export const PAY_BASE = 'https://ntagz.com/pay.html?t='; // must equal BASE in admin/src/paylinks.js (a test checks)
export async function payLinkState(db, id) {
  if (!id) return null;
  try {
    const r = await db.prepare(`SELECT pl.id, pl.status, pl.expires_at, pl.open_count, pl.sent_at, pl.quoted_paise,
      (SELECT o.id FROM orders o WHERE o.payment_status = 'paid' AND o.txn_id IN (SELECT value FROM json_each(pl.txn_ids)) LIMIT 1) AS paid_order_id,
      (SELECT o.total FROM orders o WHERE o.payment_status = 'paid' AND o.txn_id IN (SELECT value FROM json_each(pl.txn_ids)) LIMIT 1) AS paid_total
      FROM pay_links pl WHERE pl.id = ?`).bind(id).first();
    if (!r) return null;
    const status = r.paid_order_id ? 'paid' : r.status === 'cancelled' ? 'cancelled' : r.expires_at <= Math.floor(Date.now() / 1000) ? 'expired' : r.open_count > 0 ? 'opened' : r.sent_at ? 'sent' : 'new';
    return { id: r.id, url: PAY_BASE + r.id, status, expiresAt: r.expires_at, quotedPaise: r.quoted_paise, paidOrderId: r.paid_order_id || null, paidTotalPaise: r.paid_total ?? null };
  } catch { return null; } // pay_links missing (older database): no link information
}

// ---- HQ side ----
const HQ_SEL = 'SELECT q.*, l.business_name AS lead_business, p.partner_code, p.business_name AS partner_business FROM quotations q JOIN leads l ON l.id = q.lead_id JOIN partners p ON p.id = q.partner_id';
export async function listAll(db, access, { status, q } = {}) {
  hqAll(access); await expire(db);
  const conds = ["q.status != 'draft'"]; const binds = [];
  if (STATUSES.includes(status)) { conds.push('q.status = ?'); binds.push(status); }
  if (q && String(q).trim()) { const like = `%${esc(String(q).trim().slice(0, 80).toLowerCase())}%`; conds.push("(LOWER(q.number) LIKE ? ESCAPE '\\' OR LOWER(l.business_name) LIKE ? ESCAPE '\\' OR LOWER(p.partner_code) LIKE ? ESCAPE '\\' OR LOWER(p.business_name) LIKE ? ESCAPE '\\')"); binds.push(like, like, like, like); }
  const rows = (await db.prepare(`${HQ_SEL} WHERE ${conds.join(' AND ')} ORDER BY CASE q.status WHEN 'pending_approval' THEN 0 ELSE 1 END, q.updated_at DESC, q.rowid DESC LIMIT 200`).bind(...binds).all()).results;
  const cs = (await db.prepare("SELECT status, COUNT(*) n FROM quotations WHERE status != 'draft' GROUP BY status").all()).results;
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])); for (const c of cs) counts[c.status] = c.n;
  return { items: rows.map((r) => out(r, null, true)), counts };
}
async function loadAny(db, id) {
  const q = await db.prepare(`${HQ_SEL} WHERE q.id = ? AND q.status != 'draft'`).bind(String(id)).first(); // drafts are the partner's private work
  if (!q) throw new AppError('NOT_FOUND', 'Not found');
  return q;
}
export async function getAny(db, access, id) { hqAll(access); await expire(db); const q = await loadAny(db, id); return { quote: { ...out(q, await itemsOf(db, q.id), true), payLink: await payLinkState(db, q.pay_link_id) } }; }

export async function approve(db, access, id) {
  hqAll(access); const q = await loadAny(db, id);
  if (q.status !== 'pending_approval') throw new AppError('CONFLICT', 'Only a submitted quotation can be approved');
  if (q.valid_until < Math.floor(Date.now() / 1000)) throw new AppError('CONFLICT', 'This quotation has already expired. Ask the partner to renew it.');
  const u = await db.prepare('SELECT u.email, json_extract(a.form_json, \'$.name\') AS name FROM partners p JOIN users u ON u.id = p.user_id LEFT JOIN partner_applications a ON a.partner_id = p.id WHERE p.id = ?').bind(q.partner_id).first();
  const rev = (await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_type = 'quotation' AND entity_id = ?").bind(id).first()).n;
  await move(db, {}, id, { from: ['pending_approval'], to: 'approved', set: ', approved_by = ?, approved_at = unixepoch(), decision_note = NULL', binds: [access.userId], by: access.userId, action: 'quote.approve', extra: [
    db.prepare("UPDATE leads SET status = 'quotation', updated_at = unixepoch() WHERE id = ? AND status IN ('new','contacted','qualified')").bind(q.lead_id), // the reserved lead status
    leadNote(db, q.lead_id, access.userId, 'hq', `Quotation ${q.number} approved`),
    queueEmail(db, { to: u && u.email, template: 'quotation_approved', data: { name: u && u.name, number: q.number, businessName: q.lead_business, total: inr(q.total_paise), validUntil: day(q.valid_until) }, dedupeKey: `quotation_approved:${id}:${rev}` }),
  ] });
  return getAny(db, access, id);
}
export async function reject(db, access, id, note) {
  hqAll(access); const q = await loadAny(db, id); const why = text(note, 500);
  if (!why || why.length < 3) throw bad('Tell the partner what to change', { note: 'required' });
  if (q.status !== 'pending_approval') throw new AppError('CONFLICT', 'Only a submitted quotation can be rejected');
  const u = await db.prepare('SELECT u.email, json_extract(a.form_json, \'$.name\') AS name FROM partners p JOIN users u ON u.id = p.user_id LEFT JOIN partner_applications a ON a.partner_id = p.id WHERE p.id = ?').bind(q.partner_id).first();
  const rev = (await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_type = 'quotation' AND entity_id = ?").bind(id).first()).n;
  await move(db, {}, id, { from: ['pending_approval'], to: 'rejected', set: ', decision_note = ?', binds: [why], by: access.userId, action: 'quote.reject', after: { note: why }, extra: [
    queueEmail(db, { to: u && u.email, template: 'quotation_rejected', data: { name: u && u.name, number: q.number, businessName: q.lead_business, note: why }, dedupeKey: `quotation_rejected:${id}:${rev}` }),
  ] });
  return getAny(db, access, id);
}
export async function recordResponseHq(db, access, id, outcome) {
  hqAll(access); await expire(db); const q = await loadAny(db, id);
  await respond(db, {}, q, outcome, access.userId, 'hq'); return getAny(db, access, id);
}
