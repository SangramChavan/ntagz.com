import { AppError } from './errors.js';
import { requirePermission, scopeClause } from './access.js';
import { auditStmt } from './audit.js';
import { revokeUserSessionsStmt } from './auth.js';
import { queueEmail } from './mail.js';

// HQ side of partner onboarding. Application: submitted -> under_review <-> documents_required -> approved | rejected.
// Partner after approval: agreement_pending -> payment_pending -> onboarding -> active <-> suspended. Nothing skips a step.
const APP_NEXT = {
  submitted: ['under_review', 'rejected'],
  under_review: ['documents_required', 'rejected', 'approved'],
  documents_required: [], // the applicant moves it back to 'submitted'
};
const CODE = { '360': '360', enterprise: 'ENT', flex: 'FLX', smile: 'SML', smile_plus: 'SMP' };
const hasNote = (n) => typeof n === 'string' && n.trim().length >= 3;
const note = (n) => String(n).trim().slice(0, 1000);

function appOut(a) {
  return { id: a.id, status: a.status, typeKey: a.type_key, businessName: a.business_name, city: a.city, state: a.state, pincode: a.pincode, panLast4: a.pan_last4, submittedAt: a.submitted_at, reviewedBy: a.reviewed_by, decisionNote: a.decision_note, partnerId: a.partner_id, partnerCode: a.partner_code ?? null, partnerStatus: a.partner_status ?? null, email: a.email ?? null };
}

// What HQ works through. A "stage" is a view over application status + partner status, so nothing is double counted.
const STAGES = {
  new: "a.status = 'submitted'",
  review: "a.status = 'under_review'",
  docs: "a.status = 'documents_required'",
  onboarding: "a.status = 'approved' AND p.status IN ('agreement_pending','payment_pending','onboarding')",
  active: "p.status = 'active'",
  suspended: "p.status IN ('suspended','terminated')",
  rejected: "a.status = 'rejected'",
};
const FROM = 'FROM partner_applications a LEFT JOIN partners p ON p.id = a.partner_id JOIN users u ON u.id = a.user_id';
const esc = (t) => t.replace(/[\\%_]/g, (c) => '\\' + c);

export async function listApplications(db, access, { status, stage, q, limit = 50, before } = {}) {
  const scope = requirePermission(access, 'partners.review');
  const where = scopeClause(scope === 'all' ? 'all' : 'none', access, {});
  const conds = [where.sql, "a.status != 'draft'"]; const binds = [...where.binds];
  if (STAGES[stage]) conds.push(STAGES[stage]); // value comes from the fixed map, never from the request
  if (status) { conds.push('a.status = ?'); binds.push(String(status)); }
  if (q && String(q).trim()) {
    const like = `%${esc(String(q).trim().slice(0, 80).toLowerCase())}%`;
    conds.push("(LOWER(a.business_name) LIKE ? ESCAPE '\\' OR LOWER(a.city) LIKE ? ESCAPE '\\' OR LOWER(p.partner_code) LIKE ? ESCAPE '\\' OR LOWER(u.email) LIKE ? ESCAPE '\\')");
    binds.push(like, like, like, like);
  }
  if (before) { conds.push('COALESCE(a.submitted_at, 0) < ?'); binds.push(Number(before) || 0); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const rows = (await db.prepare(`SELECT a.*, p.partner_code, p.status AS partner_status, u.email ${FROM} WHERE ${conds.join(' AND ')} ORDER BY COALESCE(a.submitted_at, 0) DESC LIMIT ?`).bind(...binds, lim).all()).results;
  // Counts ignore the stage/search filters so the chips always show the whole queue.
  const sums = Object.entries(STAGES).map(([k, c]) => `SUM(CASE WHEN ${c} THEN 1 ELSE 0 END) AS ${k}`).join(', ');
  const c = await db.prepare(`SELECT ${sums} ${FROM} WHERE a.status != 'draft'`).first();
  const counts = {}; for (const k of Object.keys(STAGES)) counts[k] = Number(c?.[k] || 0);
  return { items: rows.map(appOut), counts, limit: lim };
}

export async function getApplication(db, access, id) {
  const scope = requirePermission(access, 'partners.review');
  if (scope !== 'all') throw new AppError('NOT_FOUND', 'Not found');
  const a = await db.prepare(`SELECT a.*, p.partner_code, p.status AS partner_status, u.email ${FROM} WHERE a.id = ? AND a.status != 'draft'`).bind(id).first();
  if (!a) throw new AppError('NOT_FOUND', 'Not found');
  const docs = (await db.prepare('SELECT id, doc_type, mime, size_bytes, status, note FROM partner_documents WHERE application_id = ? ORDER BY created_at').bind(id).all()).results;
  const form = JSON.parse(a.form_json || '{}');
  let partner = null; const entityIds = [id];
  if (a.partner_id) {
    const p = await db.prepare('SELECT p.id, p.partner_code, p.status, p.suspend_reason, p.activated_at, t.fee_paise, t.label AS type_label FROM partners p JOIN partner_types t ON t.key = p.type_key WHERE p.id = ?').bind(a.partner_id).first();
    const ag = await db.prepare('SELECT version, status, sent_at, signed_at FROM partner_agreements WHERE partner_id = ? ORDER BY created_at DESC LIMIT 1').bind(a.partner_id).first();
    const fees = (await db.prepare('SELECT amount_paise, gst_paise, method, reference, recorded_by, created_at FROM partner_fee_payments WHERE partner_id = ? ORDER BY created_at').bind(a.partner_id).all()).results;
    partner = {
      id: p.id, partnerCode: p.partner_code, status: p.status, suspendReason: p.suspend_reason, activatedAt: p.activated_at, feePaise: p.fee_paise, typeLabel: p.type_label,
      agreement: ag ? { version: ag.version, status: ag.status, sentAt: ag.sent_at, signedAt: ag.signed_at } : null,
      feePayments: fees.map((f) => ({ amountPaise: f.amount_paise, gstPaise: f.gst_paise, method: f.method, reference: f.reference, recordedBy: f.recorded_by, at: f.created_at })),
    };
    entityIds.push(a.partner_id);
  }
  const hist = (await db.prepare(`SELECT action, actor, detail, created_at FROM audit_log WHERE entity_type IN ('partner_application','partner') AND entity_id IN (${entityIds.map(() => '?').join(',')}) ORDER BY created_at DESC, rowid DESC LIMIT 60`).bind(...entityIds).all()).results;
  const history = hist.map((h) => { let d = null; try { d = JSON.parse(h.detail); } catch { /* keep null */ } return { action: h.action, actor: h.actor === a.user_id ? 'Applicant' : h.actor, at: h.created_at, after: d && d.after ? d.after : null }; });
  return { ...appOut(a), form, documents: docs.map((d) => ({ id: d.id, type: d.doc_type, mime: d.mime, size: d.size_bytes, status: d.status, note: d.note })), partner, history };
}

// Streams a KYC file. Every view is written to the audit log.
export async function openDocument(db, bucket, access, docId) {
  requirePermission(access, 'partners.review');
  const d = await db.prepare('SELECT id, application_id, r2_key, mime FROM partner_documents WHERE id = ?').bind(docId).first();
  if (!d) throw new AppError('NOT_FOUND', 'Not found');
  const obj = await bucket.get(d.r2_key);
  if (!obj) throw new AppError('NOT_FOUND', 'Not found');
  await auditStmt(db, { actor: access.userId, action: 'partner.document.view', entityType: 'partner_application', entityId: d.application_id, after: { documentId: d.id } }).run();
  return { body: obj.body ?? obj, mime: d.mime };
}

const nameOf = (row) => { try { return JSON.parse(row.form_json || '{}').name || ''; } catch { return ''; } };
// The applicant's email and name are needed to tell them what happened. Queued with the change itself (same transaction).
const mail = (db, row, template, data, key) => queueEmail(db, { to: row.email, template, data: { name: nameOf(row), ...data }, dedupeKey: key });

async function loadApp(db, id) {
  const a = await db.prepare(`SELECT a.*, u.email, (SELECT COUNT(*) FROM audit_log WHERE entity_type = 'partner_application' AND entity_id = a.id) AS rev FROM partner_applications a JOIN users u ON u.id = a.user_id WHERE a.id = ?`).bind(id).first();
  if (!a) throw new AppError('NOT_FOUND', 'Not found');
  return a;
}
function move(a, to) {
  if (!(APP_NEXT[a.status] || []).includes(to)) throw new AppError('CONFLICT', `Cannot move an application from ${a.status} to ${to}`);
}
// `pre` statements run before the status update in the same transaction (needed when the update references a row they create).
async function setApp(db, access, a, to, extra = {}, pre = []) {
  const sets = ['status = ?', 'reviewed_by = ?', 'reviewed_at = unixepoch()', 'updated_at = unixepoch()']; const binds = [to, access.userId];
  for (const [k, val] of Object.entries(extra)) { sets.push(`${k} = ?`); binds.push(val); }
  const res = await db.batch([
    ...pre,
    db.prepare(`UPDATE partner_applications SET ${sets.join(', ')} WHERE id = ? AND status = ?`).bind(...binds, a.id, a.status),
    auditStmt(db, { actor: access.userId, action: `partner.application.${to}`, entityType: 'partner_application', entityId: a.id, before: { status: a.status }, after: { status: to, ...extra } }),
  ]);
  if (res[pre.length].meta.changes !== 1) throw new AppError('CONFLICT', 'The application changed. Reload and try again.');
}

export async function startReview(db, access, id) {
  requirePermission(access, 'partners.review');
  const a = await loadApp(db, id); move(a, 'under_review');
  await setApp(db, access, a, 'under_review');
  return { id, status: 'under_review' };
}
export async function requestDocuments(db, access, id, n) {
  requirePermission(access, 'partners.review');
  if (!hasNote(n)) throw new AppError('VALIDATION_FAILED', 'Tell the applicant what is needed', { note: 'required' });
  const a = await loadApp(db, id); move(a, 'documents_required');
  await setApp(db, access, a, 'documents_required', { decision_note: note(n) }, [mail(db, a, 'documents_requested', { note: note(n) }, `documents_requested:${a.id}:${a.rev}`)]);
  return { id, status: 'documents_required' };
}
export async function reject(db, access, id, n) {
  requirePermission(access, 'partners.review');
  if (!hasNote(n)) throw new AppError('VALIDATION_FAILED', 'A reason is required', { note: 'required' });
  const a = await loadApp(db, id); move(a, 'rejected');
  await setApp(db, access, a, 'rejected', { decision_note: note(n) }, [mail(db, a, 'application_rejected', { note: note(n) }, `application_rejected:${a.id}:${a.rev}`)]);
  return { id, status: 'rejected' };
}

// Approval creates the partner record (so the Partner ID exists) but grants NO partner access. Access starts at 'active'.
export async function approve(db, access, id, { agreementVersion } = {}) {
  requirePermission(access, 'partners.activate');
  const a = await loadApp(db, id); move(a, 'approved');
  if (a.pan_hash) {
    const dup = await db.prepare('SELECT id FROM partners WHERE pan_hash = ?').bind(a.pan_hash).first();
    if (dup) throw new AppError('CONFLICT', 'A partner with this PAN already exists');
  }
  const exists = await db.prepare('SELECT id FROM partners WHERE user_id = ?').bind(a.user_id).first();
  if (exists) throw new AppError('CONFLICT', 'This person is already a partner');
  const n = (await db.prepare('SELECT COUNT(*) n FROM partners WHERE type_key = ?').bind(a.type_key).first()).n;
  const pid = crypto.randomUUID();
  let lastErr;
  for (let i = 1; i <= 3; i++) { // partner_code is UNIQUE; retry on a concurrent approval
    const code = `NTZ-${CODE[a.type_key] || 'GEN'}-${String(n + i).padStart(4, '0')}`;
    try {
      await setApp(db, access, a, 'approved', { partner_id: pid }, [
        db.prepare("INSERT INTO partners (id, partner_code, user_id, type_key, status, business_name, city, state, pincode, pan_last4, pan_hash, approved_by, approved_at) VALUES (?, ?, ?, ?, 'agreement_pending', ?, ?, ?, ?, ?, ?, ?, unixepoch())")
          .bind(pid, code, a.user_id, a.type_key, a.business_name || 'Unnamed', a.city, a.state, a.pincode, a.pan_last4, a.pan_hash, access.userId),
        db.prepare("INSERT INTO partner_agreements (id, partner_id, version, status, sent_at) VALUES (?, ?, ?, 'pending', unixepoch())").bind(crypto.randomUUID(), pid, String(agreementVersion || 'draft-v1').slice(0, 40)),
        auditStmt(db, { actor: access.userId, action: 'partner.create', entityType: 'partner', entityId: pid, after: { partnerCode: code, typeKey: a.type_key } }),
        mail(db, a, 'application_approved', { businessName: a.business_name, partnerCode: code }, `application_approved:${a.id}:${a.rev}`),
      ]);
      return { id, status: 'approved', partnerId: pid, partnerCode: code };
    } catch (e) { if (!/UNIQUE.*partner_code/i.test(String(e && e.message))) throw e; lastErr = e; }
  }
  throw lastErr;
}

async function loadPartner(db, id) {
  const p = await db.prepare(`SELECT p.*, t.fee_paise, t.role_key, u.email, (SELECT form_json FROM partner_applications WHERE partner_id = p.id LIMIT 1) AS form_json, (SELECT COUNT(*) FROM audit_log WHERE entity_type = 'partner' AND entity_id = p.id) AS rev FROM partners p JOIN partner_types t ON t.key = p.type_key JOIN users u ON u.id = p.user_id WHERE p.id = ?`).bind(id).first();
  if (!p) throw new AppError('NOT_FOUND', 'Not found');
  return p;
}
async function setPartner(db, access, p, from, to, extra = {}, extraStmts = []) {
  const sets = ['status = ?', 'updated_at = unixepoch()']; const binds = [to];
  for (const [k, val] of Object.entries(extra)) { sets.push(`${k} = ?`); binds.push(val); }
  const res = await db.batch([
    db.prepare(`UPDATE partners SET ${sets.join(', ')} WHERE id = ? AND status = ?`).bind(...binds, p.id, from),
    ...extraStmts,
    auditStmt(db, { actor: access.userId, action: `partner.${to}`, entityType: 'partner', entityId: p.id, before: { status: from }, after: { status: to, ...extra } }),
  ]);
  if (res[0].meta.changes !== 1) throw new AppError('CONFLICT', 'The partner record changed. Reload and try again.');
}
const need = (p, st, what) => { if (p.status !== st) throw new AppError('CONFLICT', `${what} is not possible while the partner is ${p.status}`); };

export async function recordAgreementSigned(db, access, partnerId) {
  requirePermission(access, 'partners.activate');
  const p = await loadPartner(db, partnerId); need(p, 'agreement_pending', 'Recording the agreement');
  const ag = await db.prepare("SELECT id FROM partner_agreements WHERE partner_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").bind(partnerId).first();
  if (!ag) throw new AppError('CONFLICT', 'No pending agreement');
  await setPartner(db, access, p, 'agreement_pending', 'payment_pending', {}, [db.prepare("UPDATE partner_agreements SET status = 'signed', signed_at = unixepoch() WHERE id = ?").bind(ag.id)]);
  return { id: partnerId, status: 'payment_pending' };
}

export async function recordFeePayment(db, access, partnerId, { amountPaise, gstPaise = 0, method, reference }) {
  requirePermission(access, 'partners.activate');
  const p = await loadPartner(db, partnerId); need(p, 'payment_pending', 'Recording the fee');
  const problems = {};
  if (!Number.isInteger(amountPaise) || amountPaise < p.fee_paise) problems.amountPaise = `must be at least ₹${(p.fee_paise / 100).toLocaleString('en-IN')} (the joining fee before tax)`;
  if (!Number.isInteger(gstPaise) || gstPaise < 0 || gstPaise > amountPaise) problems.gstPaise = 'invalid';
  if (!['bank_transfer', 'upi', 'razorpay', 'payu', 'cash', 'other'].includes(method)) problems.method = 'invalid';
  if (typeof reference !== 'string' || reference.trim().length < 4) problems.reference = 'required (bank/UPI/gateway reference)';
  if (Object.keys(problems).length) throw new AppError('VALIDATION_FAILED', 'Check the payment details', problems);
  try {
    await setPartner(db, access, p, 'payment_pending', 'onboarding', {}, [
      db.prepare('INSERT INTO partner_fee_payments (id, partner_id, amount_paise, gst_paise, method, reference, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), partnerId, amountPaise, gstPaise, method, reference.trim().slice(0, 80), access.userId),
      auditStmt(db, { actor: access.userId, action: 'partner.fee.record', entityType: 'partner', entityId: partnerId, after: { amountPaise, gstPaise, method, reference: reference.trim().slice(0, 80) } }),
    ]);
  } catch (e) { if (/UNIQUE.*reference/i.test(String(e && e.message))) throw new AppError('CONFLICT', 'That payment reference was already recorded'); throw e; }
  return { id: partnerId, status: 'onboarding' };
}

// Activation needs: signed agreement + recorded fee payment + onboarding stage. Then (and only then) the partner role is granted.
export async function activate(db, access, partnerId) {
  requirePermission(access, 'partners.activate');
  const p = await loadPartner(db, partnerId); need(p, 'onboarding', 'Activation');
  const signed = await db.prepare("SELECT 1 x FROM partner_agreements WHERE partner_id = ? AND status = 'signed'").bind(partnerId).first();
  const paid = await db.prepare('SELECT 1 x FROM partner_fee_payments WHERE partner_id = ?').bind(partnerId).first();
  if (!signed || !paid) throw new AppError('CONFLICT', 'Agreement and joining fee must both be recorded first');
  await setPartner(db, access, p, 'onboarding', 'active', { activated_at: Math.floor(Date.now() / 1000) }, [
    db.prepare('INSERT INTO user_roles (id, user_id, role_key, granted_by) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, role_key) DO UPDATE SET revoked_at = NULL, granted_by = excluded.granted_by')
      .bind(crypto.randomUUID(), p.user_id, p.role_key, access.userId),
    mail(db, p, 'partner_activated', { partnerCode: p.partner_code }, `partner_activated:${p.id}:${p.rev}`),
  ]);
  return { id: partnerId, status: 'active', partnerCode: p.partner_code };
}

export async function suspend(db, access, partnerId, reason) {
  requirePermission(access, 'partners.suspend');
  if (!hasNote(reason)) throw new AppError('VALIDATION_FAILED', 'A reason is required', { reason: 'required' });
  const p = await loadPartner(db, partnerId); need(p, 'active', 'Suspension');
  await setPartner(db, access, p, 'active', 'suspended', { suspended_at: Math.floor(Date.now() / 1000), suspend_reason: note(reason) }, [revokeUserSessionsStmt(db, p.user_id, 'partner'), mail(db, p, 'partner_suspended', { partnerCode: p.partner_code, note: note(reason) }, `partner_suspended:${p.id}:${p.rev}`)]);
  return { id: partnerId, status: 'suspended' };
}
export async function reinstate(db, access, partnerId) {
  requirePermission(access, 'partners.activate');
  const p = await loadPartner(db, partnerId); need(p, 'suspended', 'Reinstating');
  await setPartner(db, access, p, 'suspended', 'active', { suspend_reason: null }, [mail(db, p, 'partner_reinstated', { partnerCode: p.partner_code }, `partner_reinstated:${p.id}:${p.rev}`)]);
  return { id: partnerId, status: 'active' };
}
