import { AppError } from './errors.js';
import { requirePermission } from './access.js';
import { auditStmt } from './audit.js';
import * as v from './validate.js';
import { accrualStmts } from './commissions.js';

// Leads: prospects a partner registers. Rules enforced here AND in the database:
//  - a partner sees and changes only their own leads (partner_id in every WHERE, never filtered after fetching);
//  - one OPEN lead per phone number across the network (unique index); a second partner is refused without learning who owns it;
//  - partners move a lead new -> contacted -> qualified, or to lost (with a reason). Only HQ can set quotation, and only HQ can mark won, which needs a real order.
export const OPEN = ['new', 'contacted', 'qualified', 'quotation'];
const PARTNER_NEXT = { new: ['contacted', 'qualified', 'lost'], contacted: ['qualified', 'lost'], qualified: ['lost'] };
const HQ_TARGETS = ['contacted', 'qualified', 'quotation', 'won', 'lost'];
const ACTS = ['note', 'call', 'visit'];
const text = (x, max) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null);
const esc = (t) => t.replace(/[\\%_]/g, (c) => '\\' + c);
const openList = `('${OPEN.join("','")}')`;

function out(r, hq) {
  const o = {
    id: r.id, businessName: r.business_name, contactName: r.contact_name, phone: r.phone, email: r.email, city: r.city, state: r.state, pincode: r.pincode,
    interest: r.interest, estQuantity: r.est_quantity, notes: r.notes, status: r.status, lostReason: r.lost_reason, createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at,
  };
  if (hq) Object.assign(o, { partnerId: r.partner_id, partnerCode: r.partner_code ?? null, partnerBusiness: r.partner_business ?? null, source: r.source, orderId: r.order_id });
  return o;
}
function partnerOf(access) {
  requirePermission(access, 'leads.manage.own');
  if (!access.partnerId) throw new AppError('FORBIDDEN', 'Partner access is not active');
  return access.partnerId;
}
const actStmt = (db, leadId, actor, kind, actorKind, body) =>
  db.prepare('INSERT INTO lead_activities (id, lead_id, actor, actor_kind, kind, body) VALUES (?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), leadId, actor, actorKind, kind, body ?? null);

function clean(input, { requireAll }) {
  const i = input && typeof input === 'object' ? input : {};
  const p = {}; const col = {};
  const bn = text(i.businessName, 160), cn = text(i.contactName, 120);
  if (requireAll || i.businessName !== undefined) { if (!bn) p.businessName = 'required'; else col.business_name = bn; }
  if (requireAll || i.contactName !== undefined) { if (!cn) p.contactName = 'required'; else col.contact_name = cn; }
  if (requireAll || i.phone !== undefined) { const ph = v.phone(i.phone); if (!ph) p.phone = 'enter a 10-digit mobile number'; else col.phone = ph; }
  if (i.email !== undefined && i.email !== '') { const e = v.email(i.email); if (!e) p.email = 'invalid email'; else col.email = e; }
  if (i.pincode !== undefined && i.pincode !== '') { const pc = v.pincode(i.pincode); if (!pc) p.pincode = 'must be 6 digits'; else col.pincode = pc; }
  if (i.estQuantity !== undefined && i.estQuantity !== null && i.estQuantity !== '') {
    const q = Number(i.estQuantity); if (!Number.isInteger(q) || q < 1 || q > 1000000) p.estQuantity = 'enter a whole number of pieces'; else col.est_quantity = q;
  }
  for (const [k, c, max] of [['city', 'city', 80], ['state', 'state', 80], ['interest', 'interest', 500], ['notes', 'notes', 1000]]) if (i[k] !== undefined && i[k] !== '') col[c] = text(i[k], max);
  if (Object.keys(p).length) throw new AppError('VALIDATION_FAILED', 'Please correct the highlighted fields', p);
  return col;
}

// ---------------------------------------------------------------- partner side
export async function createLead(db, access, input) {
  const partnerId = partnerOf(access);
  const col = clean(input, { requireAll: true });
  const id = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare('INSERT INTO leads (id, partner_id, created_by, source, business_name, contact_name, phone, email, city, state, pincode, interest, est_quantity, notes) VALUES (?, ?, ?, \'partner\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, partnerId, access.userId, col.business_name, col.contact_name, col.phone, col.email ?? null, col.city ?? null, col.state ?? null, col.pincode ?? null, col.interest ?? null, col.est_quantity ?? null, col.notes ?? null),
      actStmt(db, id, access.userId, 'created', 'partner', 'Lead registered'),
      auditStmt(db, { actor: access.userId, action: 'lead.create', entityType: 'lead', entityId: id, after: { partnerId, status: 'new' } }),
    ]);
  } catch (e) {
    if (!/UNIQUE.*leads\.phone/i.test(String(e && e.message))) throw e;
    const ex = await db.prepare(`SELECT id, partner_id FROM leads WHERE phone = ? AND status IN ${openList}`).bind(col.phone).first();
    if (ex && ex.partner_id === partnerId) throw new AppError('CONFLICT', 'You already have an open lead for this number', { phone: 'already in your leads' });
    // Another partner owns it: say nothing about who. HQ can see the attempt.
    await auditStmt(db, { actor: access.userId, action: 'lead.conflict', entityType: 'lead_conflict', entityId: ex ? ex.id : 'unknown', after: { attemptedByPartner: partnerId, phoneLast4: col.phone.slice(-4) } }).run();
    throw new AppError('CONFLICT', 'This contact is already registered with Ntagz', { phone: 'already registered' });
  }
  return getMine(db, access, id);
}

export async function listMine(db, access, { status, q, limit = 100 } = {}) {
  const partnerId = partnerOf(access);
  const conds = ['partner_id = ?']; const binds = [partnerId];
  if (status && ['new', 'contacted', 'qualified', 'quotation', 'won', 'lost'].includes(status)) { conds.push('status = ?'); binds.push(status); }
  if (q && String(q).trim()) { const like = `%${esc(String(q).trim().slice(0, 80).toLowerCase())}%`; conds.push("(LOWER(business_name) LIKE ? ESCAPE '\\' OR LOWER(contact_name) LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR LOWER(city) LIKE ? ESCAPE '\\')"); binds.push(like, like, like, like); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);
  const rows = (await db.prepare(`SELECT * FROM leads WHERE ${conds.join(' AND ')} ORDER BY updated_at DESC, rowid DESC LIMIT ?`).bind(...binds, lim).all()).results;
  const cs = (await db.prepare('SELECT status, COUNT(*) n FROM leads WHERE partner_id = ? GROUP BY status').bind(partnerId).all()).results;
  const counts = { new: 0, contacted: 0, qualified: 0, quotation: 0, won: 0, lost: 0 }; for (const c of cs) counts[c.status] = c.n;
  return { items: rows.map((r) => out(r, false)), counts };
}

export async function getMine(db, access, id) {
  const partnerId = partnerOf(access);
  const r = await db.prepare('SELECT * FROM leads WHERE id = ? AND partner_id = ?').bind(id, partnerId).first(); // another partner's lead is simply "not found"
  if (!r) throw new AppError('NOT_FOUND', 'Not found');
  const acts = (await db.prepare('SELECT actor_kind, kind, body, created_at FROM lead_activities WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100').bind(id).all()).results;
  return { lead: out(r, false), activities: acts.map((a) => ({ by: a.actor_kind === 'partner' ? 'You' : a.actor_kind === 'hq' ? 'Ntagz' : 'System', kind: a.kind, body: a.body, at: a.created_at })) };
}

export async function addActivityMine(db, access, id, { kind, body }) {
  const partnerId = partnerOf(access);
  const b = text(body, 1000);
  if (!ACTS.includes(kind)) throw new AppError('VALIDATION_FAILED', 'Unknown activity', { kind: 'invalid' });
  if (!b) throw new AppError('VALIDATION_FAILED', 'Write something first', { body: 'required' });
  const r = await db.prepare('SELECT id FROM leads WHERE id = ? AND partner_id = ?').bind(id, partnerId).first();
  if (!r) throw new AppError('NOT_FOUND', 'Not found');
  await db.batch([actStmt(db, id, access.userId, kind, 'partner', b), db.prepare('UPDATE leads SET updated_at = unixepoch() WHERE id = ?').bind(id)]);
  return getMine(db, access, id);
}

export async function setStatusMine(db, access, id, { status, reason }) {
  const partnerId = partnerOf(access);
  const r = await db.prepare('SELECT * FROM leads WHERE id = ? AND partner_id = ?').bind(id, partnerId).first();
  if (!r) throw new AppError('NOT_FOUND', 'Not found');
  if (!(PARTNER_NEXT[r.status] || []).includes(status)) throw new AppError('CONFLICT', `A lead that is ${r.status} cannot be set to ${status} by a partner`);
  const why = status === 'lost' ? text(reason, 500) : null;
  if (status === 'lost' && (!why || why.length < 3)) throw new AppError('VALIDATION_FAILED', 'Say why the lead was lost', { reason: 'required' });
  const res = await db.batch([
    db.prepare('UPDATE leads SET status = ?, lost_reason = ?, closed_at = ?, updated_at = unixepoch() WHERE id = ? AND partner_id = ? AND status = ?').bind(status, why, status === 'lost' ? Math.floor(Date.now() / 1000) : null, id, partnerId, r.status),
    actStmt(db, id, access.userId, 'status', 'partner', `${r.status} → ${status}${why ? ': ' + why : ''}`),
    auditStmt(db, { actor: access.userId, action: 'lead.status', entityType: 'lead', entityId: id, before: { status: r.status }, after: { status } }),
  ]);
  if (res[0].meta.changes !== 1) throw new AppError('CONFLICT', 'The lead changed. Reload and try again.');
  return getMine(db, access, id);
}

// ---------------------------------------------------------------- HQ side
const HQ_FROM = 'FROM leads l JOIN partners p ON p.id = l.partner_id';
const HQ_COLS = 'l.*, p.partner_code, p.business_name AS partner_business';

export async function listAll(db, access, { status, partnerId, q, limit = 100 } = {}) {
  const scope = requirePermission(access, 'leads.read.all');
  if (scope !== 'all') return { items: [], counts: { new: 0, contacted: 0, qualified: 0, quotation: 0, won: 0, lost: 0 } }; // region scope has no PIN-to-region map yet: fail closed
  const conds = ['1=1']; const binds = [];
  if (status && ['new', 'contacted', 'qualified', 'quotation', 'won', 'lost'].includes(status)) { conds.push('l.status = ?'); binds.push(status); }
  if (partnerId) { conds.push('l.partner_id = ?'); binds.push(String(partnerId)); }
  if (q && String(q).trim()) { const like = `%${esc(String(q).trim().slice(0, 80).toLowerCase())}%`; conds.push("(LOWER(l.business_name) LIKE ? ESCAPE '\\' OR LOWER(l.contact_name) LIKE ? ESCAPE '\\' OR l.phone LIKE ? ESCAPE '\\' OR LOWER(p.partner_code) LIKE ? ESCAPE '\\' OR LOWER(p.business_name) LIKE ? ESCAPE '\\')"); binds.push(like, like, like, like, like); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);
  const rows = (await db.prepare(`SELECT ${HQ_COLS} ${HQ_FROM} WHERE ${conds.join(' AND ')} ORDER BY l.updated_at DESC, l.rowid DESC LIMIT ?`).bind(...binds, lim).all()).results;
  const cs = (await db.prepare('SELECT status, COUNT(*) n FROM leads GROUP BY status').all()).results;
  const counts = { new: 0, contacted: 0, qualified: 0, quotation: 0, won: 0, lost: 0 }; for (const c of cs) counts[c.status] = c.n;
  return { items: rows.map((r) => out(r, true)), counts };
}

// HQ-wide rights need scope 'all'. A Regional Manager's 'region' scope has no PIN-to-region map yet, so it sees and changes nothing (fails closed).
function hqAll(access, perm) {
  const scope = requirePermission(access, perm);
  if (scope !== 'all') throw new AppError('NOT_FOUND', 'Not found');
}
async function loadLead(db, id) {
  const r = await db.prepare(`SELECT ${HQ_COLS} ${HQ_FROM} WHERE l.id = ?`).bind(id).first();
  if (!r) throw new AppError('NOT_FOUND', 'Not found');
  return r;
}
export async function getAny(db, access, id) {
  hqAll(access, 'leads.read.all');
  return getHq(db, id);
}
async function getHq(db, id) {
  const r = await loadLead(db, id);
  const acts = (await db.prepare('SELECT actor, actor_kind, kind, body, created_at FROM lead_activities WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100').bind(id).all()).results;
  const conflicts = (await db.prepare("SELECT actor, detail, created_at FROM audit_log WHERE entity_type = 'lead_conflict' AND entity_id = ? ORDER BY created_at DESC LIMIT 20").bind(id).all()).results
    .map((c) => { let d = {}; try { d = JSON.parse(c.detail).after || {}; } catch { /* ignore */ } return { at: c.created_at, attemptedByPartner: d.attemptedByPartner || null }; });
  return { lead: out(r, true), activities: acts.map((a) => ({ by: a.actor_kind === 'partner' ? 'Partner' : a.actor_kind === 'hq' ? a.actor : 'System', kind: a.kind, body: a.body, at: a.created_at })), conflicts };
}

export async function assign(db, access, id, partnerId) {
  hqAll(access, 'leads.assign');
  const r = await loadLead(db, id);
  if (!OPEN.includes(r.status)) throw new AppError('CONFLICT', 'Only open leads can be reassigned');
  if (r.partner_id === partnerId) throw new AppError('CONFLICT', 'That partner already owns this lead');
  const to = await db.prepare("SELECT id, partner_code FROM partners WHERE id = ? AND status = 'active'").bind(String(partnerId || '')).first();
  if (!to) throw new AppError('VALIDATION_FAILED', 'Choose an active partner', { partnerId: 'must be an active partner' });
  const res = await db.batch([
    db.prepare('UPDATE leads SET partner_id = ?, updated_at = unixepoch() WHERE id = ? AND partner_id = ? AND status IN (\'new\',\'contacted\',\'qualified\',\'quotation\')').bind(to.id, id, r.partner_id),
    actStmt(db, id, access.userId, 'assign', 'hq', `Reassigned from ${r.partner_code} to ${to.partner_code}`),
    auditStmt(db, { actor: access.userId, action: 'lead.assign', entityType: 'lead', entityId: id, before: { partnerId: r.partner_id }, after: { partnerId: to.id } }),
  ]);
  if (res[0].meta.changes !== 1) throw new AppError('CONFLICT', 'The lead changed. Reload and try again.');
  return getHq(db, id);
}

export async function setStatusHq(db, access, id, { status, reason, orderId }) {
  hqAll(access, 'leads.assign');
  const r = await loadLead(db, id);
  if (!OPEN.includes(r.status)) throw new AppError('CONFLICT', `A ${r.status} lead cannot be changed`);
  if (!HQ_TARGETS.includes(status) || status === r.status) throw new AppError('VALIDATION_FAILED', 'Choose a different status', { status: 'invalid' });
  let why = null, ord = null;
  if (status === 'lost') { why = text(reason, 500); if (!why || why.length < 3) throw new AppError('VALIDATION_FAILED', 'Say why the lead was lost', { reason: 'required' }); }
  if (status === 'won') {
    const o = orderId ? await db.prepare('SELECT id FROM orders WHERE id = ?').bind(String(orderId)).first() : null;
    if (!o) throw new AppError('VALIDATION_FAILED', 'Enter the order this lead produced', { orderId: 'no such order' });
    ord = o.id;
  }
  const closed = status === 'won' || status === 'lost';
  const accrual = status === 'won' ? await accrualStmts(db, { lead: r, orderId: ord, actor: access.userId }) : null; // a commission is created only if HQ has defined a matching rule
  try {
    const res = await db.batch([
      db.prepare('UPDATE leads SET status = ?, lost_reason = ?, order_id = ?, closed_at = ?, updated_at = unixepoch() WHERE id = ? AND status = ?').bind(status, why, ord, closed ? Math.floor(Date.now() / 1000) : null, id, r.status),
      actStmt(db, id, access.userId, 'status', 'hq', `${r.status} → ${status}${why ? ': ' + why : ''}${ord ? ' (order ' + ord.slice(0, 8) + ')' : ''}`),
      auditStmt(db, { actor: access.userId, action: 'lead.status', entityType: 'lead', entityId: id, before: { status: r.status }, after: { status, orderId: ord } }),
      ...(accrual ? accrual.stmts : []),
    ]);
    if (res[0].meta.changes !== 1) throw new AppError('CONFLICT', 'The lead changed. Reload and try again.');
  } catch (e) { if (/UNIQUE.*leads\.order_id|uq_leads_order|UNIQUE.*commissions\.order_id/i.test(String(e && e.message))) throw new AppError('CONFLICT', 'That order is already credited'); throw e; }
  return { ...(await getHq(db, id)), commission: accrual ? { amountPaise: accrual.amountPaise, status: 'pending' } : null };
}

export async function activePartners(db, access) {
  hqAll(access, 'leads.assign');
  const rows = (await db.prepare("SELECT id, partner_code, business_name, type_key FROM partners WHERE status = 'active' ORDER BY partner_code").all()).results;
  return rows.map((p) => ({ id: p.id, partnerCode: p.partner_code, businessName: p.business_name, typeKey: p.type_key }));
}

export async function addNoteHq(db, access, id, body) {
  hqAll(access, 'leads.assign');
  await loadLead(db, id);
  const b = text(body, 1000); if (!b) throw new AppError('VALIDATION_FAILED', 'Write something first', { body: 'required' });
  await db.batch([actStmt(db, id, access.userId, 'note', 'hq', b), db.prepare('UPDATE leads SET updated_at = unixepoch() WHERE id = ?').bind(id)]);
  return getHq(db, id);
}
