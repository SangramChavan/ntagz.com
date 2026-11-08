import { AppError } from './errors.js';
import { requirePermission } from './access.js';
import { auditStmt } from './audit.js';

// Commission engine. Money is integer paise; amounts are floored, never rounded up in the company's disfavour.
//  - NO terms are seeded: a commission is created only when HQ has defined a rule (owner decisions on release/TDS are still open).
//  - A commission is created when HQ marks a lead WON with its order. The matched rule's terms are copied onto it (snapshot), so rule edits never change it.
//  - One commission per order and earning type (database UNIQUE): an order can never be credited twice.
//  - pending -> approved (HQ/Finance) -> payable (after the hold date, customer's payment cleared, no refund) -> paid (settlement). Disputed/reversed on the side.
//  - amount_paise = original_amount_paise + SUM(delta_paise) of its adjustments, always (tests check it).
export const STATUSES = ['pending', 'approved', 'payable', 'paid', 'reversed', 'disputed'];
const DAY = 86400;
const inr = (p) => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const text = (x, max) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null);
const esc = (t) => t.replace(/[\\%_]/g, (c) => '\\' + c);
const bad = (msg, fields) => new AppError('VALIDATION_FAILED', msg, fields);
const nowS = () => Math.floor(Date.now() / 1000);
const adj = (db, id, kind, delta, reason, actor) => db.prepare('INSERT INTO commission_adjustments (id, commission_id, kind, delta_paise, reason, actor) VALUES (?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), id, kind, delta, reason ?? null, actor);

function finance(access, perm) { const s = requirePermission(access, perm); if (s !== 'all') throw new AppError('NOT_FOUND', 'Not found'); }
function partnerOf(access) { requirePermission(access, 'commissions.read.own'); if (!access.partnerId) throw new AppError('FORBIDDEN', 'Partner access is not active'); return access.partnerId; }

// ---------------------------------------------------------------- settings and rules (HQ only)
export async function getSettings(db) {
  const rows = (await db.prepare("SELECT key, value FROM system_settings WHERE key IN ('commission_default_hold_days', 'tds_rate_bp')").all()).results;
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const hold = parseInt(m.commission_default_hold_days, 10), tds = m.tds_rate_bp === undefined || m.tds_rate_bp === null || m.tds_rate_bp === '' ? null : parseInt(m.tds_rate_bp, 10);
  return { defaultHoldDays: Number.isInteger(hold) && hold >= 0 ? hold : 30, defaultHoldDaysIsSet: m.commission_default_hold_days !== undefined, tdsRateBp: Number.isInteger(tds) ? tds : null };
}
export async function setSettings(db, access, { defaultHoldDays, tdsRateBp }) {
  finance(access, 'settings.manage');
  const p = {};
  if (defaultHoldDays !== undefined && (!Number.isInteger(defaultHoldDays) || defaultHoldDays < 0 || defaultHoldDays > 365)) p.defaultHoldDays = '0 to 365 days';
  if (tdsRateBp !== undefined && tdsRateBp !== null && (!Number.isInteger(tdsRateBp) || tdsRateBp < 0 || tdsRateBp > 3000)) p.tdsRateBp = '0 to 3000 basis points (30%), or leave empty for none';
  if (Object.keys(p).length) throw bad('Check the settings', p);
  const before = await getSettings(db); const st = [];
  const put = (k, v) => st.push(db.prepare('INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = unixepoch()').bind(k, v === null ? '' : String(v), access.userId));
  if (defaultHoldDays !== undefined) put('commission_default_hold_days', defaultHoldDays);
  if (tdsRateBp !== undefined) put('tds_rate_bp', tdsRateBp);
  if (st.length) await db.batch([...st, auditStmt(db, { actor: access.userId, action: 'commission.settings', entityType: 'commission_settings', entityId: 'settings', before, after: { defaultHoldDays, tdsRateBp } })]);
  return getSettings(db);
}

const ruleOut = (r) => ({ id: r.id, name: r.name, earningType: r.earning_type, partnerType: r.partner_type, pctBp: r.pct_bp, fixedPaise: r.fixed_paise, minOrderPaise: r.min_order_paise, maxPaise: r.max_paise, holdDays: r.hold_days, refundPolicy: r.refund_policy, active: !!r.active, createdAt: r.created_at });
export async function listRules(db, access) { finance(access, 'settings.manage'); return { rules: (await db.prepare('SELECT * FROM commission_rules ORDER BY active DESC, created_at DESC, rowid DESC').all()).results.map(ruleOut), settings: await getSettings(db) }; }

async function cleanRule(db, i, partial) {
  const p = {}; const c = {};
  if (!partial || i.name !== undefined) { const n = text(i.name, 80); if (!n || n.length < 2) p.name = 'enter a name'; else c.name = n; }
  if (i.earningType !== undefined && i.earningType !== 'lead_conversion') p.earningType = 'only lead conversion commissions are generated today';
  if (i.partnerType !== undefined && i.partnerType !== null && i.partnerType !== '') { const t = await db.prepare('SELECT key FROM partner_types WHERE key = ?').bind(String(i.partnerType)).first(); if (!t) p.partnerType = 'unknown partner type'; else c.partner_type = t.key; } else if (i.partnerType !== undefined) c.partner_type = null;
  const num = (k, col, min, max) => { if (i[k] === undefined) return; if (i[k] === null || i[k] === '') { c[col] = null; return; } const v = Number(i[k]); if (!Number.isInteger(v) || v < min || v > max) p[k] = `a whole number from ${min} to ${max}`; else c[col] = v; };
  num('pctBp', 'pct_bp', 0, 10000); num('fixedPaise', 'fixed_paise', 0, 100000000); num('minOrderPaise', 'min_order_paise', 0, 10000000000); num('maxPaise', 'max_paise', 1, 100000000); num('holdDays', 'hold_days', 0, 365);
  if (i.refundPolicy !== undefined) { if (!['proportional', 'reverse_all'].includes(i.refundPolicy)) p.refundPolicy = 'proportional or reverse_all'; else c.refund_policy = i.refundPolicy; }
  if (i.active !== undefined) c.active = i.active ? 1 : 0;
  if (!partial && !((c.pct_bp || 0) > 0 || (c.fixed_paise || 0) > 0)) p.pctBp = 'a rule must pay a percentage, a fixed amount, or both';
  if (Object.keys(p).length) throw bad('Check the rule', p);
  return c;
}
export async function createRule(db, access, input) {
  finance(access, 'settings.manage'); const c = await cleanRule(db, input || {}, false); const id = crypto.randomUUID();
  await db.batch([
    db.prepare('INSERT INTO commission_rules (id, name, partner_type, pct_bp, fixed_paise, min_order_paise, max_paise, hold_days, refund_policy, active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, c.name, c.partner_type ?? null, c.pct_bp ?? null, c.fixed_paise ?? null, c.min_order_paise ?? 0, c.max_paise ?? null, c.hold_days ?? null, c.refund_policy ?? 'proportional', c.active ?? 1, access.userId),
    auditStmt(db, { actor: access.userId, action: 'commission.rule.create', entityType: 'commission_rule', entityId: id, after: c }),
  ]);
  return listRules(db, access);
}
export async function updateRule(db, access, id, input) {
  finance(access, 'settings.manage'); const r = await db.prepare('SELECT * FROM commission_rules WHERE id = ?').bind(String(id)).first(); if (!r) throw new AppError('NOT_FOUND', 'Not found');
  const c = await cleanRule(db, input || {}, true); const keys = Object.keys(c); if (!keys.length) return listRules(db, access);
  const merged = { ...r, ...c }; if (!((merged.pct_bp || 0) > 0 || (merged.fixed_paise || 0) > 0)) throw bad('A rule must pay a percentage, a fixed amount, or both', { pctBp: 'required' });
  await db.batch([
    db.prepare(`UPDATE commission_rules SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = unixepoch() WHERE id = ?`).bind(...keys.map((k) => c[k]), id), // keys come from the fixed set in cleanRule
    auditStmt(db, { actor: access.userId, action: 'commission.rule.update', entityType: 'commission_rule', entityId: id, before: ruleOut(r), after: c }),
  ]);
  return listRules(db, access);
}

// ---------------------------------------------------------------- accrual (called by leads.setStatusHq when a lead is won)
// Returns { stmts, amountPaise } to add to the caller's batch, or null when no rule applies (nothing is invented).
export async function accrualStmts(db, { lead, orderId, actor }) {
  try { return await accrual(db, { lead, orderId, actor }); }
  catch (e) { if (/no such table/i.test(String(e && e.message))) return null; throw e; } // migration 0028 not applied yet: winning a lead must still work
}
async function accrual(db, { lead, orderId, actor }) {
  const o = await db.prepare('SELECT id, qualifying_paise, subtotal, created_at FROM orders WHERE id = ?').bind(orderId).first();
  if (!o) return null;
  const base = o.qualifying_paise > 0 ? o.qualifying_paise : (o.subtotal > 0 ? o.subtotal : 0);
  if (base <= 0) return null;
  const partner = await db.prepare('SELECT type_key FROM partners WHERE id = ?').bind(lead.partner_id).first(); if (!partner) return null;
  const rule = await db.prepare("SELECT * FROM commission_rules WHERE active = 1 AND earning_type = 'lead_conversion' AND (partner_type IS NULL OR partner_type = ?) AND min_order_paise <= ? ORDER BY (partner_type IS NOT NULL) DESC, created_at DESC, rowid DESC LIMIT 1").bind(partner.type_key, base).first();
  if (!rule) return null;
  let amount = Math.floor(base * (rule.pct_bp || 0) / 10000) + (rule.fixed_paise || 0);
  if (rule.max_paise) amount = Math.min(amount, rule.max_paise);
  if (amount <= 0) return null;
  const settings = await getSettings(db);
  const snap = { ruleName: rule.name, pctBp: rule.pct_bp, fixedPaise: rule.fixed_paise, minOrderPaise: rule.min_order_paise, maxPaise: rule.max_paise, holdDays: rule.hold_days ?? settings.defaultHoldDays, refundPolicy: rule.refund_policy };
  const id = crypto.randomUUID();
  return { amountPaise: amount, stmts: [
    db.prepare("INSERT INTO commissions (id, partner_id, lead_id, order_id, rule_id, rule_snapshot_json, earning_type, base_paise, original_amount_paise, amount_paise) VALUES (?, ?, ?, ?, ?, ?, 'lead_conversion', ?, ?, ?)").bind(id, lead.partner_id, lead.id, orderId, rule.id, JSON.stringify(snap), base, amount, amount),
    db.prepare("INSERT INTO lead_activities (id, lead_id, actor, actor_kind, kind, body) VALUES (?, ?, ?, 'system', 'note', ?)").bind(crypto.randomUUID(), lead.id, actor, `Commission of ${inr(amount)} created, waiting for approval`),
    auditStmt(db, { actor, action: 'commission.create', entityType: 'commission', entityId: id, after: { partnerId: lead.partner_id, orderId, amountPaise: amount, rule: rule.name } }),
  ] };
}

// ---------------------------------------------------------------- release and refunds (idempotent; run by the admin cron and before reads)
export async function processDue(db) {
  const out = { reversed: 0, reduced: 0, flagged: 0, released: 0 };
  try {
    const rows = (await db.prepare(`SELECT c.id, c.status, c.settlement_id, c.original_amount_paise AS orig, c.amount_paise AS cur, c.rule_snapshot_json AS snap, o.paid_paise AS paid, o.refunded_paise AS refunded
      FROM commissions c JOIN orders o ON o.id = c.order_id WHERE o.refunded_paise > 0 AND c.status != 'reversed'`).all()).results;
    for (const c of rows) {
      let snap = {}; try { snap = JSON.parse(c.snap); } catch { /* defaults */ }
      if (c.settlement_id) { // already paid out (including paid-then-disputed): never change the amount, flag once for Finance
        const seen = await db.prepare("SELECT 1 x FROM commission_adjustments WHERE commission_id = ? AND kind = 'refund_after_payment'").bind(c.id).first();
        if (!seen) { await db.batch([adj(db, c.id, 'refund_after_payment', 0, 'The order was refunded after this commission was paid', 'system'), db.prepare("UPDATE commissions SET status = 'disputed', prior_status = 'paid', dispute_reason = 'Order refunded after payout: Finance to review', updated_at = unixepoch() WHERE id = ? AND status = 'paid'").bind(c.id)]); out.flagged++; }
        continue;
      }
      const kept = Math.max(0, (c.paid || 0) - Math.min(c.refunded, c.paid || 0));
      const target = snap.refundPolicy === 'reverse_all' || !c.paid ? 0 : Math.floor(c.orig * kept / c.paid); // what the refund leaves of the ORIGINAL amount
      // Relative to refund adjustments already applied, so a manual correction made after a refund is never undone and this pass stays idempotent.
      const applied = (await db.prepare("SELECT COALESCE(SUM(delta_paise), 0) s FROM commission_adjustments WHERE commission_id = ? AND kind IN ('refund_partial', 'refund_full')").bind(c.id).first()).s;
      const need = (target - c.orig) - applied; if (need >= 0) continue;
      const next = c.cur + need;
      if (next <= 0 || target === 0) { await db.batch([adj(db, c.id, 'refund_full', -c.cur, 'Order refunded', 'system'), db.prepare("UPDATE commissions SET status = 'reversed', amount_paise = 0, reversed_reason = 'Order refunded', updated_at = unixepoch() WHERE id = ? AND status NOT IN ('paid','reversed')").bind(c.id)]); out.reversed++; }
      else { await db.batch([adj(db, c.id, 'refund_partial', need, 'Part of the order was refunded', 'system'), db.prepare("UPDATE commissions SET amount_paise = ?, updated_at = unixepoch() WHERE id = ? AND status NOT IN ('paid','reversed')").bind(next, c.id)]); out.reduced++; }
    }
    const rel = await db.prepare(`UPDATE commissions SET status = 'payable', updated_at = unixepoch() WHERE status = 'approved' AND hold_until IS NOT NULL AND hold_until <= unixepoch()
      AND EXISTS (SELECT 1 FROM orders o WHERE o.id = commissions.order_id AND o.payment_status = 'paid' AND o.refunded_paise = 0)`).run();
    out.released = rel.meta.changes;
  } catch (e) { console.error('commission process failed:', e && e.message); }
  return out;
}

// ---------------------------------------------------------------- output
function out(c, extra = {}) {
  return { id: c.id, status: c.status, earningType: c.earning_type, basePaise: c.base_paise, originalAmountPaise: c.original_amount_paise, amountPaise: c.amount_paise, holdUntil: c.hold_until, approvedAt: c.approved_at,
    disputeReason: c.dispute_reason, reversedReason: c.reversed_reason, createdAt: c.created_at, updatedAt: c.updated_at, orderRef: String(c.order_id).slice(0, 8), leadBusiness: c.lead_business ?? null, settlementNumber: c.settlement_number ?? null, ...extra };
}
const zeroCounts = () => Object.fromEntries(STATUSES.map((s) => [s, { n: 0, amountPaise: 0 }]));

// ---------------------------------------------------------------- partner side
export async function listMine(db, access, { status } = {}) {
  const partnerId = partnerOf(access); await processDue(db);
  const conds = ['c.partner_id = ?']; const binds = [partnerId];
  if (STATUSES.includes(status)) { conds.push('c.status = ?'); binds.push(status); }
  const rows = (await db.prepare(`SELECT c.*, l.business_name AS lead_business, s.number AS settlement_number FROM commissions c LEFT JOIN leads l ON l.id = c.lead_id LEFT JOIN settlements s ON s.id = c.settlement_id WHERE ${conds.join(' AND ')} ORDER BY c.updated_at DESC, c.rowid DESC LIMIT 200`).bind(...binds).all()).results;
  const totals = zeroCounts(); for (const t of (await db.prepare('SELECT status, COUNT(*) n, SUM(amount_paise) s FROM commissions WHERE partner_id = ? GROUP BY status').bind(partnerId).all()).results) totals[t.status] = { n: t.n, amountPaise: t.s || 0 };
  return { items: rows.map((r) => out(r)), totals };
}
export async function getMine(db, access, id) {
  const partnerId = partnerOf(access); await processDue(db);
  const c = await db.prepare('SELECT c.*, l.business_name AS lead_business, s.number AS settlement_number FROM commissions c LEFT JOIN leads l ON l.id = c.lead_id LEFT JOIN settlements s ON s.id = c.settlement_id WHERE c.id = ? AND c.partner_id = ?').bind(String(id), partnerId).first();
  if (!c) throw new AppError('NOT_FOUND', 'Not found');
  const adjs = (await db.prepare('SELECT kind, delta_paise, reason, actor, created_at FROM commission_adjustments WHERE commission_id = ? ORDER BY created_at, rowid').bind(id).all()).results;
  let snap = {}; try { snap = JSON.parse(c.rule_snapshot_json); } catch { /* none */ }
  return { commission: out(c, { terms: { pctBp: snap.pctBp ?? null, fixedPaise: snap.fixedPaise ?? null, maxPaise: snap.maxPaise ?? null, holdDays: snap.holdDays ?? null, refundPolicy: snap.refundPolicy ?? null } }),
    ledger: adjs.map((a) => ({ kind: a.kind, deltaPaise: a.delta_paise, reason: a.reason, by: a.actor === 'system' ? 'System' : a.actor === access.userId ? 'You' : 'Ntagz', at: a.created_at })) };
}
export async function disputeMine(db, access, id, reason) {
  const partnerId = partnerOf(access); const c = await db.prepare('SELECT status FROM commissions WHERE id = ? AND partner_id = ?').bind(String(id), partnerId).first(); if (!c) throw new AppError('NOT_FOUND', 'Not found');
  const why = text(reason, 500); if (!why || why.length < 3) throw bad('Say what looks wrong', { reason: 'required' });
  if (!['pending', 'approved', 'payable', 'paid'].includes(c.status)) throw new AppError('CONFLICT', `A ${c.status} commission cannot be disputed`);
  const res = await db.batch([
    db.prepare("UPDATE commissions SET status = 'disputed', prior_status = status, dispute_reason = ?, updated_at = unixepoch() WHERE id = ? AND partner_id = ? AND status IN ('pending','approved','payable','paid')").bind(why, id, partnerId),
    adj(db, id, 'dispute', 0, why, access.userId),
    auditStmt(db, { actor: access.userId, action: 'commission.dispute', entityType: 'commission', entityId: id, before: { status: c.status }, after: { reason: why } }),
  ]);
  if (res[0].meta.changes !== 1) throw new AppError('CONFLICT', 'The commission changed. Reload and try again.');
  return getMine(db, access, id);
}
export async function listSettlementsMine(db, access) {
  const partnerId = partnerOf(access);
  const rows = (await db.prepare('SELECT s.*, (SELECT COUNT(*) FROM commissions c WHERE c.settlement_id = s.id) AS n FROM settlements s WHERE s.partner_id = ? ORDER BY s.created_at DESC, s.rowid DESC').bind(partnerId).all()).results;
  return { items: rows.map((s) => ({ number: s.number, totalPaise: s.total_paise, tdsPaise: s.tds_paise, tdsRateBp: s.tds_rate_bp, netPaise: s.net_paise, method: s.method, reference: s.reference, commissions: s.n, at: s.created_at })) };
}

// ---------------------------------------------------------------- HQ / Finance side
const HQ_SEL = 'SELECT c.*, l.business_name AS lead_business, p.partner_code, p.business_name AS partner_business, s.number AS settlement_number FROM commissions c LEFT JOIN leads l ON l.id = c.lead_id JOIN partners p ON p.id = c.partner_id LEFT JOIN settlements s ON s.id = c.settlement_id';
const hqOut = (c) => out(c, { partnerId: c.partner_id, partnerCode: c.partner_code, partnerBusiness: c.partner_business, approvedBy: c.approved_by });
export async function listAll(db, access, { status, partnerId, q } = {}) {
  finance(access, 'commissions.approve'); await processDue(db);
  const conds = ['1=1']; const binds = [];
  if (STATUSES.includes(status)) { conds.push('c.status = ?'); binds.push(status); }
  if (partnerId) { conds.push('c.partner_id = ?'); binds.push(String(partnerId)); }
  if (q && String(q).trim()) { const like = `%${esc(String(q).trim().slice(0, 80).toLowerCase())}%`; conds.push("(LOWER(p.partner_code) LIKE ? ESCAPE '\\' OR LOWER(p.business_name) LIKE ? ESCAPE '\\' OR LOWER(l.business_name) LIKE ? ESCAPE '\\')"); binds.push(like, like, like); }
  const rows = (await db.prepare(`${HQ_SEL} WHERE ${conds.join(' AND ')} ORDER BY CASE c.status WHEN 'pending' THEN 0 WHEN 'disputed' THEN 1 ELSE 2 END, c.updated_at DESC, c.rowid DESC LIMIT 300`).bind(...binds).all()).results;
  const totals = zeroCounts(); for (const t of (await db.prepare('SELECT status, COUNT(*) n, SUM(amount_paise) s FROM commissions GROUP BY status').all()).results) totals[t.status] = { n: t.n, amountPaise: t.s || 0 };
  return { items: rows.map(hqOut), totals };
}
async function loadAny(db, id) { const c = await db.prepare(`${HQ_SEL} WHERE c.id = ?`).bind(String(id)).first(); if (!c) throw new AppError('NOT_FOUND', 'Not found'); return c; }
export async function getAny(db, access, id) {
  finance(access, 'commissions.approve'); await processDue(db); const c = await loadAny(db, id);
  const adjs = (await db.prepare('SELECT kind, delta_paise, reason, actor, created_at FROM commission_adjustments WHERE commission_id = ? ORDER BY created_at, rowid').bind(id).all()).results;
  const o = await db.prepare('SELECT id, total, paid_paise, refunded_paise, qualifying_paise, payment_status, created_at FROM orders WHERE id = ?').bind(c.order_id).first();
  let snap = {}; try { snap = JSON.parse(c.rule_snapshot_json); } catch { /* none */ }
  return { commission: { ...hqOut(c), terms: snap, order: o ? { id: o.id, totalPaise: o.total, paidPaise: o.paid_paise, refundedPaise: o.refunded_paise, qualifyingPaise: o.qualifying_paise, paymentStatus: o.payment_status, createdAt: o.created_at } : null, priorStatus: c.prior_status },
    ledger: adjs.map((a) => ({ kind: a.kind, deltaPaise: a.delta_paise, reason: a.reason, by: a.actor, at: a.created_at })) };
}

export async function approve(db, access, id) {
  finance(access, 'commissions.approve'); const c = await loadAny(db, id);
  if (c.status !== 'pending') throw new AppError('CONFLICT', 'Only a pending commission can be approved');
  const o = await db.prepare('SELECT created_at FROM orders WHERE id = ?').bind(c.order_id).first(); let snap = {}; try { snap = JSON.parse(c.rule_snapshot_json); } catch { /* defaults */ }
  const hold = Math.max((o ? o.created_at : nowS()) + (snap.holdDays ?? 30) * DAY, nowS()); // the refund window runs from the order date, never in the past
  const res = await db.batch([
    db.prepare("UPDATE commissions SET status = 'approved', approved_by = ?, approved_at = unixepoch(), hold_until = ?, updated_at = unixepoch() WHERE id = ? AND status = 'pending'").bind(access.userId, hold, id),
    auditStmt(db, { actor: access.userId, action: 'commission.approve', entityType: 'commission', entityId: id, before: { status: 'pending' }, after: { status: 'approved', holdUntil: hold } }),
  ]);
  if (res[0].meta.changes !== 1) throw new AppError('CONFLICT', 'The commission changed. Reload and try again.');
  await processDue(db); return getAny(db, access, id);
}
export async function reverse(db, access, id, reason) {
  finance(access, 'commissions.approve'); const c = await loadAny(db, id); const why = text(reason, 500);
  if (!why || why.length < 3) throw bad('A reason is required', { reason: 'required' });
  if (!['pending', 'approved', 'payable', 'disputed'].includes(c.status) || (c.status === 'disputed' && c.prior_status === 'paid')) throw new AppError('CONFLICT', `A ${c.status === 'disputed' && c.prior_status === 'paid' ? 'paid' : c.status} commission cannot be reversed here`);
  const res = await db.batch([
    db.prepare("UPDATE commissions SET status = 'reversed', amount_paise = 0, reversed_reason = ?, updated_at = unixepoch() WHERE id = ? AND status IN ('pending','approved','payable','disputed') AND settlement_id IS NULL").bind(why, id),
    adj(db, id, 'manual', -c.amount_paise, why, access.userId),
    auditStmt(db, { actor: access.userId, action: 'commission.reverse', entityType: 'commission', entityId: id, before: { status: c.status, amountPaise: c.amount_paise }, after: { reason: why } }),
  ]);
  if (res[0].meta.changes !== 1) throw new AppError('CONFLICT', 'The commission changed. Reload and try again.');
  return getAny(db, access, id);
}
export async function adjust(db, access, id, { deltaPaise, reason }) {
  finance(access, 'commissions.approve'); const c = await loadAny(db, id); const why = text(reason, 500);
  if (!why || why.length < 3) throw bad('A reason is required', { reason: 'required' });
  if (!Number.isInteger(deltaPaise) || deltaPaise === 0 || Math.abs(deltaPaise) > 100000000) throw bad('Enter the change in paise (not zero)', { deltaPaise: 'whole number of paise' });
  if (!['pending', 'approved', 'payable'].includes(c.status)) throw new AppError('CONFLICT', `A ${c.status} commission cannot be adjusted`);
  const next = c.amount_paise + deltaPaise; if (next < 1) throw bad('The commission cannot go to zero or below. Reverse it instead.', { deltaPaise: 'too large a decrease' });
  const res = await db.batch([
    db.prepare("UPDATE commissions SET amount_paise = ?, updated_at = unixepoch() WHERE id = ? AND amount_paise = ? AND status IN ('pending','approved','payable')").bind(next, id, c.amount_paise),
    adj(db, id, 'manual', deltaPaise, why, access.userId),
    auditStmt(db, { actor: access.userId, action: 'commission.adjust', entityType: 'commission', entityId: id, before: { amountPaise: c.amount_paise }, after: { amountPaise: next, reason: why } }),
  ]);
  if (res[0].meta.changes !== 1) throw new AppError('CONFLICT', 'The commission changed. Reload and try again.');
  return getAny(db, access, id);
}
// A dispute ends one of two ways: the commission stands (back where it was) or it is reversed. Disputes raised after payout can only be dismissed here.
export async function resolve(db, access, id, { action, note }) {
  finance(access, 'commissions.approve'); const c = await loadAny(db, id); const why = text(note, 500);
  if (c.status !== 'disputed') throw new AppError('CONFLICT', 'Only a disputed commission can be resolved');
  if (!['restore', 'reverse'].includes(action)) throw bad('Choose restore or reverse', { action: 'invalid' });
  if (!why || why.length < 3) throw bad('Explain the decision', { note: 'required' });
  if (action === 'reverse') { if (c.prior_status === 'paid') throw new AppError('CONFLICT', 'This commission was already paid out. Record a manual adjustment with Finance instead.'); return reverse(db, access, id, why); }
  const back = ['pending', 'approved', 'payable', 'paid'].includes(c.prior_status) ? c.prior_status : 'pending';
  const res = await db.batch([
    db.prepare("UPDATE commissions SET status = ?, prior_status = NULL, dispute_reason = NULL, updated_at = unixepoch() WHERE id = ? AND status = 'disputed'").bind(back, id),
    adj(db, id, 'dispute', 0, `Dispute resolved, commission stands: ${why}`, access.userId),
    auditStmt(db, { actor: access.userId, action: 'commission.resolve', entityType: 'commission', entityId: id, before: { status: 'disputed' }, after: { status: back, note: why } }),
  ]);
  if (res[0].meta.changes !== 1) throw new AppError('CONFLICT', 'The commission changed. Reload and try again.');
  await processDue(db); return getAny(db, access, id);
}

// ---------------------------------------------------------------- settlements (HQ / Finance)
export async function payables(db, access) {
  finance(access, 'settlements.manage'); await processDue(db);
  const rows = (await db.prepare("SELECT p.id, p.partner_code, p.business_name, COUNT(*) n, SUM(c.amount_paise) s FROM commissions c JOIN partners p ON p.id = c.partner_id WHERE c.status = 'payable' AND c.settlement_id IS NULL GROUP BY p.id ORDER BY s DESC").all()).results;
  return { items: rows.map((r) => ({ partnerId: r.id, partnerCode: r.partner_code, partnerBusiness: r.business_name, count: r.n, totalPaise: r.s })), settings: await getSettings(db) };
}
export async function listSettlements(db, access) {
  finance(access, 'settlements.manage');
  const rows = (await db.prepare('SELECT s.*, p.partner_code, p.business_name, (SELECT COUNT(*) FROM commissions c WHERE c.settlement_id = s.id) AS n FROM settlements s JOIN partners p ON p.id = s.partner_id ORDER BY s.created_at DESC, s.rowid DESC LIMIT 200').all()).results;
  return { items: rows.map((s) => ({ id: s.id, number: s.number, partnerCode: s.partner_code, partnerBusiness: s.business_name, totalPaise: s.total_paise, tdsRateBp: s.tds_rate_bp, tdsPaise: s.tds_paise, netPaise: s.net_paise, method: s.method, reference: s.reference, commissions: s.n, recordedBy: s.recorded_by, at: s.created_at })) };
}
// Pays out EVERY payable commission of one partner in one atomic step. The total comes from the rows actually marked paid, so the books cannot disagree;
// a settlement with nothing payable inserts nothing. TDS uses the configured rate (none configured = none withheld, and the statement says so).
export async function createSettlement(db, access, { partnerId, method, reference }) {
  finance(access, 'settlements.manage'); await processDue(db);
  const p = await db.prepare("SELECT id FROM partners WHERE id = ?").bind(String(partnerId || '')).first(); if (!p) throw new AppError('NOT_FOUND', 'Partner not found');
  const ref = text(reference, 80); const fields = {};
  if (!['bank_transfer', 'upi', 'other'].includes(method)) fields.method = 'choose a payment method';
  if (!ref || ref.length < 4) fields.reference = 'enter the bank or UPI reference';
  if (Object.keys(fields).length) throw bad('Check the payout details', fields);
  const rate = (await getSettings(db)).tdsRateBp; const year = new Date().getFullYear();
  const base = (await db.prepare('SELECT COUNT(*) n FROM settlements WHERE number LIKE ?').bind(`S-${year}-%`).first()).n; let lastErr;
  for (let i = 1; i <= 3; i++) {
    const number = `S-${year}-${String(base + i).padStart(4, '0')}`; const id = crypto.randomUUID();
    try {
      const res = await db.batch([
        db.prepare(`INSERT INTO settlements (id, number, partner_id, total_paise, tds_rate_bp, tds_paise, net_paise, method, reference, recorded_by)
          SELECT ?, ?, ?, t, ?, (t * COALESCE(?, 0)) / 10000, t - (t * COALESCE(?, 0)) / 10000, ?, ?, ? FROM (SELECT SUM(amount_paise) AS t FROM commissions WHERE partner_id = ? AND status = 'payable' AND settlement_id IS NULL) WHERE t > 0`)
          .bind(id, number, p.id, rate, rate, rate, method, ref, access.userId, p.id),
        db.prepare("UPDATE commissions SET status = 'paid', settlement_id = ?, updated_at = unixepoch() WHERE partner_id = ? AND status = 'payable' AND settlement_id IS NULL AND EXISTS (SELECT 1 FROM settlements WHERE id = ?)").bind(id, p.id, id),
        auditStmt(db, { actor: access.userId, action: 'settlement.create', entityType: 'settlement', entityId: id, after: { number, partnerId: p.id, method, reference: ref } }),
      ]);
      if (res[0].meta.changes !== 1) throw new AppError('CONFLICT', 'Nothing is payable for this partner right now');
      const s = await db.prepare('SELECT * FROM settlements WHERE id = ?').bind(id).first();
      return { settlement: { id, number, totalPaise: s.total_paise, tdsRateBp: s.tds_rate_bp, tdsPaise: s.tds_paise, netPaise: s.net_paise, commissions: res[1].meta.changes } };
    } catch (e) {
      if (e instanceof AppError) throw e;
      const m = String(e && e.message);
      if (/UNIQUE.*settlements\.reference/i.test(m)) throw new AppError('CONFLICT', 'That payment reference was already recorded', { reference: 'already recorded' });
      if (!/UNIQUE.*settlements\.number/i.test(m)) throw e; lastErr = e;
    }
  }
  throw lastErr;
}
