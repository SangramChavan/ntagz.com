import { AppError } from './errors.js';
import { requirePermission } from './access.js';
import { auditStmt } from './audit.js';
import * as v from './validate.js';
import { queueEmail, hqRecipients } from './mail.js';

// Applicant side of partner onboarding. Every query is filtered by the caller's user id in SQL.
export const OPEN = ['draft', 'submitted', 'under_review', 'documents_required'];
const EDITABLE = ['draft', 'documents_required'];
const DOC_TYPES = ['pan', 'gst_certificate', 'address_proof', 'shop_photo', 'bank_proof', 'other'];
const REQUIRED_DOCS = ['pan', 'address_proof'];
const MAX_DOC_BYTES = 5 * 1024 * 1024, MAX_DOCS = 8;
const INVEST = ['under_1l', '1l_to_3l', '3l_to_5l', '5l_to_10l', 'over_10l'];

const text = (x, max) => (typeof x === 'string' ? x.trim().slice(0, max) : undefined);
const FIELDS = {
  name: (x) => text(x, 120), business_type: (x) => text(x, 60), experience: (x) => text(x, 1000),
  shop_details: (x) => text(x, 1000), customer_base: (x) => text(x, 1000), sales_marketing: (x) => text(x, 1000),
  investment_capacity: (x) => (INVEST.includes(x) ? x : undefined),
  staff_available: (x) => (Number.isInteger(x) && x >= 0 && x <= 500 ? x : undefined),
  vehicle_available: (x) => (typeof x === 'boolean' ? x : undefined),
  email: (x) => v.email(x) || undefined, phone: (x) => v.phone(x) || undefined,
};

function row(a) { return a && { id: a.id, status: a.status, typeKey: a.type_key, businessName: a.business_name, city: a.city, state: a.state, pincode: a.pincode, panLast4: a.pan_last4, form: JSON.parse(a.form_json || '{}'), decisionNote: a.decision_note, submittedAt: a.submitted_at, updatedAt: a.updated_at }; }

export async function listTypes(db) {
  const r = await db.prepare('SELECT key, label, fee_paise, gst_rate_bp FROM partner_types WHERE active = 1 ORDER BY sort').all();
  return r.results.map((t) => ({ key: t.key, label: t.label, feePaise: t.fee_paise, gstRateBp: t.gst_rate_bp }));
}

async function openApp(db, userId) {
  return db.prepare(`SELECT * FROM partner_applications WHERE user_id = ? AND status IN (${OPEN.map(() => '?').join(',')})`).bind(userId, ...OPEN).first();
}

export async function getMine(db, access) {
  requirePermission(access, 'partners.apply');
  const a = await openApp(db, access.userId) || await db.prepare('SELECT * FROM partner_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(access.userId).first();
  if (!a) return { application: null, partner: null };
  // The applicant's own partner record (exists from approval on) so the portal can show the onboarding stage before access is active.
  const pr = await db.prepare('SELECT partner_code, status FROM partners WHERE user_id = ?').bind(access.userId).first();
  const partner = pr ? { partnerCode: pr.partner_code, status: pr.status } : null;
  const docs = (await db.prepare('SELECT id, doc_type, mime, size_bytes, status, note, created_at FROM partner_documents WHERE application_id = ? ORDER BY created_at').bind(a.id).all()).results;
  return { application: row(a), partner, documents: docs.map((d) => ({ id: d.id, type: d.doc_type, mime: d.mime, size: d.size_bytes, status: d.status, note: d.note })) };
}

// Creates the draft on first save, then updates it. Unknown keys are dropped; ID numbers are never stored.
export async function saveDraft(db, access, input, env) {
  requirePermission(access, 'partners.apply');
  input = input && typeof input === 'object' ? input : {};
  const fields = {};
  const problems = {};
  for (const [k, clean] of Object.entries(FIELDS)) {
    if (input.form && input.form[k] !== undefined) { const c = clean(input.form[k]); if (c === undefined) problems[k] = 'invalid'; else fields[k] = c; }
  }
  const col = {};
  if (input.typeKey !== undefined) {
    const t = await db.prepare('SELECT key FROM partner_types WHERE key = ? AND active = 1').bind(String(input.typeKey)).first();
    if (!t) problems.typeKey = 'unknown partner type'; else col.type_key = t.key;
  }
  if (input.businessName !== undefined) { const c = text(input.businessName, 160); if (!c) problems.businessName = 'required'; else col.business_name = c; }
  if (input.city !== undefined) { const c = text(input.city, 80); if (!c) problems.city = 'required'; else col.city = c; }
  if (input.state !== undefined) { const c = text(input.state, 80); if (!c) problems.state = 'required'; else col.state = c; }
  if (input.pincode !== undefined) { const c = v.pincode(input.pincode); if (!c) problems.pincode = 'must be 6 digits'; else col.pincode = c; }
  if (input.pan !== undefined) {
    const c = v.pan(input.pan);
    if (!c) problems.pan = 'invalid PAN';
    else { if (!env.PAN_HASH_SECRET) throw new AppError('INTERNAL'); col.pan_last4 = c.slice(-4); col.pan_hash = await v.keyedHash(env.PAN_HASH_SECRET, c); }
  }
  if (Object.keys(problems).length) throw new AppError('VALIDATION_FAILED', 'Please correct the highlighted fields', problems);

  const existing = await openApp(db, access.userId);
  if (existing && !EDITABLE.includes(existing.status)) throw new AppError('CONFLICT', 'This application is with Ntagz and cannot be edited right now');
  if (!existing) {
    if (!col.type_key) throw new AppError('VALIDATION_FAILED', 'Choose a partner category first', { typeKey: 'required' });
    const id = crypto.randomUUID();
    await db.batch([
      db.prepare('INSERT INTO partner_applications (id, user_id, type_key, form_json, business_name, city, state, pincode, pan_last4, pan_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, access.userId, col.type_key, JSON.stringify(fields), col.business_name ?? null, col.city ?? null, col.state ?? null, col.pincode ?? null, col.pan_last4 ?? null, col.pan_hash ?? null),
      auditStmt(db, { actor: access.userId, action: 'partner.application.create', entityType: 'partner_application', entityId: id, after: { typeKey: col.type_key } }),
    ]);
    return getMine(db, access);
  }
  const merged = { ...JSON.parse(existing.form_json || '{}'), ...fields };
  const sets = ['form_json = ?', 'updated_at = unixepoch()']; const binds = [JSON.stringify(merged)];
  for (const [k, val] of Object.entries(col)) { sets.push(`${k} = ?`); binds.push(val); } // k comes from the fixed set above
  await db.prepare(`UPDATE partner_applications SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds, existing.id, access.userId).run();
  return getMine(db, access);
}

function sniff(bytes) {
  const b = new Uint8Array(bytes.slice(0, 8));
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}

// Stores the file in the PRIVATE bucket under a random key. The type is taken from the file's own bytes, not the client's header.
export async function addDocument(db, bucket, access, { docType, bytes }) {
  requirePermission(access, 'partners.apply');
  if (!DOC_TYPES.includes(docType)) throw new AppError('VALIDATION_FAILED', 'Unknown document type', { docType: 'invalid' });
  if (!bytes || bytes.byteLength === 0) throw new AppError('VALIDATION_FAILED', 'Empty file');
  if (bytes.byteLength > MAX_DOC_BYTES) throw new AppError('VALIDATION_FAILED', 'File is larger than 5 MB');
  const mime = sniff(bytes);
  if (!mime) throw new AppError('VALIDATION_FAILED', 'Upload a PDF, PNG or JPEG file');
  const app = await openApp(db, access.userId);
  if (!app || !EDITABLE.includes(app.status)) throw new AppError('CONFLICT', 'Start your application before uploading documents');
  const count = await db.prepare('SELECT COUNT(*) n FROM partner_documents WHERE application_id = ?').bind(app.id).first();
  if (count.n >= MAX_DOCS) throw new AppError('CONFLICT', 'Document limit reached');
  const id = crypto.randomUUID();
  const key = `kyc/${app.id}/${crypto.randomUUID()}`;
  await bucket.put(key, bytes, { httpMetadata: { contentType: mime } });
  await db.batch([
    db.prepare('INSERT INTO partner_documents (id, application_id, doc_type, r2_key, mime, size_bytes) VALUES (?, ?, ?, ?, ?, ?)').bind(id, app.id, docType, key, mime, bytes.byteLength),
    auditStmt(db, { actor: access.userId, action: 'partner.document.upload', entityType: 'partner_application', entityId: app.id, after: { docType, size: bytes.byteLength } }),
  ]);
  return { id, type: docType, mime, size: bytes.byteLength };
}

export async function submit(db, access, env = {}) {
  requirePermission(access, 'partners.apply');
  const a = await openApp(db, access.userId);
  if (!a || !EDITABLE.includes(a.status)) throw new AppError('CONFLICT', 'There is no application to submit');
  const form = JSON.parse(a.form_json || '{}');
  const missing = {};
  for (const k of ['name', 'phone', 'business_type', 'investment_capacity']) if (form[k] === undefined || form[k] === '') missing[k] = 'required';
  for (const k of ['business_name', 'city', 'state', 'pincode', 'pan_last4']) if (!a[k]) missing[k === 'pan_last4' ? 'pan' : k] = 'required';
  const docs = (await db.prepare("SELECT doc_type FROM partner_documents WHERE application_id = ? AND status != 'rejected'").bind(a.id).all()).results.map((d) => d.doc_type);
  for (const d of REQUIRED_DOCS) if (!docs.includes(d)) missing[`document_${d}`] = 'upload required';
  if (Object.keys(missing).length) throw new AppError('VALIDATION_FAILED', 'Complete all required details before submitting', missing);
  const u = await db.prepare('SELECT email FROM users WHERE id = ?').bind(access.userId).first();
  const data = { name: form.name, businessName: a.business_name, typeKey: a.type_key, city: a.city, state: a.state, resubmitted: a.status === 'documents_required' };
  // Dedupe on the application's audit-log count (a revision number): a double-click or retry reads the same value and cannot queue a second email,
  // while a genuine later event always sees a higher one (updated_at has only 1-second resolution, so it is not used).
  const rev = (await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_type = 'partner_application' AND entity_id = ?").bind(a.id).first()).n;
  const res = await db.batch([
    db.prepare("UPDATE partner_applications SET status = 'submitted', submitted_at = unixepoch(), updated_at = unixepoch(), decision_note = NULL WHERE id = ? AND user_id = ? AND status IN ('draft','documents_required')").bind(a.id, access.userId),
    auditStmt(db, { actor: access.userId, action: 'partner.application.submit', entityType: 'partner_application', entityId: a.id, before: { status: a.status }, after: { status: 'submitted' } }),
    queueEmail(db, { to: u && u.email, template: 'application_received', data, dedupeKey: `application_received:${a.id}:${rev}` }),
    ...hqRecipients(env).map((to) => queueEmail(db, { to, template: 'hq_new_application', data, dedupeKey: `hq_new_application:${a.id}:${rev}:${to}` })),
  ]);
  if (res[0].meta.changes !== 1) throw new AppError('CONFLICT', 'Already submitted');
  return getMine(db, access);
}
