import { AppError, ok, fail } from './errors.js';
import { loadAccess, accessForRoles } from './access.js';
import { requestOtp, verifyOtp, sessionUser, revokeSession } from './auth.js';
import * as apps from './applications.js';
import * as review from './review.js';
import * as leads from './leads.js';
import * as quotes from './quotes.js';
import * as comm from './commissions.js';
import { flushOutbox } from './mail.js';

const COOKIE = '__Host-ntagz_partner';
const PARTNER_SESSION_TTL = 12 * 3600;
const JSON_LIMIT = 64 * 1024;
const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cache-control': 'no-store' };

const cookieOf = (req, name) => ((req.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(name + '=')) || '').slice(name.length + 1);
const withHeaders = (res, extra = {}) => { const r = new Response(res.body, res); for (const [k, v] of Object.entries({ ...SEC, ...extra })) r.headers.set(k, v); return r; };

// State-changing requests must carry our header and come from our own origin. A missing Origin is rejected, not waved through.
function csrf(request, url) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const origin = request.headers.get('origin');
  if (request.headers.get('x-requested-with') !== 'ntagz' || !origin || origin !== url.origin) throw new AppError('FORBIDDEN', 'Request blocked');
}
async function readJson(request) {
  if (!(request.headers.get('content-type') || '').includes('json')) return {};
  const len = Number(request.headers.get('content-length') || 0);
  if (len > JSON_LIMIT) throw new AppError('VALIDATION_FAILED', 'Request too large');
  const text = await request.text();
  if (text.length > JSON_LIMIT) throw new AppError('VALIDATION_FAILED', 'Request too large');
  try { const b = JSON.parse(text || '{}'); return b && typeof b === 'object' ? b : {}; } catch { throw new AppError('VALIDATION_FAILED', 'Invalid JSON'); }
}
async function sendOtpEmail(env, email, code) {
  if (env.DEV_OTP_ECHO === '1') return code; // local testing only; never set in production
  if (!env.RESEND_API_KEY) { console.error('RESEND_API_KEY missing: partner OTP not sent'); return null; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'ntagz <hello@ntagz.com>', to: [email], subject: `${code} — your ntagz partner login code`,
      html: `<p style="font-family:sans-serif">Your login code is <strong style="font-size:28px;letter-spacing:6px">${code}</strong></p><p style="font-family:sans-serif;color:#888">Valid for 10 minutes. Do not share this code.</p>` }),
  }).catch(() => null);
  if (!res || !res.ok) console.error('partner otp email failed', res && res.status);
  return null;
}
const sessionCookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// ---------------------------------------------------------------- partner.ntagz.com
// Sends queued emails after a successful change. With a Worker `ctx` it runs after the response; the action never waits on, or fails because of, email.
function flushLater(env, ctx) { const p = flushOutbox(env, { limit: 5 }); if (ctx && ctx.waitUntil) { ctx.waitUntil(p); return undefined; } return p; }

export async function partnerRouter(request, env, ctx) {
  const res = await partnerRouterInner(request, env);
  if (request.method !== 'GET' && request.method !== 'HEAD' && res.status < 400) await flushLater(env, ctx);
  return res;
}
async function partnerRouterInner(request, env) {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url); const path = url.pathname; const method = request.method;
  try {
    if (!path.startsWith('/api/v1/')) throw new AppError('NOT_FOUND', 'Not found');
    csrf(request, url);
    const ip = request.headers.get('cf-connecting-ip') || null;
    const ua = request.headers.get('user-agent') || '';

    if (method === 'POST' && path === '/api/v1/auth/otp/send') {
      const b = await readJson(request);
      return withHeaders(ok(await requestOtp(env.DB, { email: b.email, ip, portal: 'partner', ipLimit: parseInt(env.OTP_IP_LIMIT, 10) || undefined, send: (e, c) => sendOtpEmail(env, e, c) })));
    }
    if (method === 'POST' && path === '/api/v1/auth/otp/verify') {
      const b = await readJson(request);
      const s = await verifyOtp(env.DB, { email: b.email, code: b.code, ip, ua, portal: 'partner', ttlSeconds: PARTNER_SESSION_TTL });
      return withHeaders(ok({ signedIn: true }), { 'set-cookie': sessionCookie(s.token, PARTNER_SESSION_TTL) });
    }
    if (method === 'GET' && path === '/api/v1/partner/types') { // public data; the ntagz.com partner page reads it so plan amounts are never hardcoded there
      const o = request.headers.get('origin'); const site = o === 'https://ntagz.com' || o === 'https://www.ntagz.com';
      return withHeaders(ok(await apps.listTypes(env.DB)), { 'cache-control': 'public, max-age=300', ...(site ? { 'access-control-allow-origin': o, vary: 'Origin' } : { vary: 'Origin' }) });
    }

    const token = cookieOf(request, COOKIE);
    const who = await sessionUser(env.DB, token, 'partner');
    if (!who) throw new AppError('UNAUTHENTICATED', 'Sign in required');
    const access = await loadAccess(env.DB, who.userId);

    if (method === 'POST' && path === '/api/v1/auth/logout') { await revokeSession(env.DB, token); return withHeaders(ok({ signedOut: true }), { 'set-cookie': sessionCookie('', 0) }); }
    if (method === 'GET' && path === '/api/v1/me') {
      const partner = access.partnerId ? await env.DB.prepare('SELECT partner_code, type_key, status, business_name FROM partners WHERE id = ?').bind(access.partnerId).first() : null;
      return withHeaders(ok({ email: who.email, roles: access.roles, permissions: [...access.permissions.keys()], partner }));
    }
    if (path === '/api/v1/partner/applications/mine') {
      if (method === 'GET') return withHeaders(ok(await apps.getMine(env.DB, access)));
      if (method === 'PUT') return withHeaders(ok(await apps.saveDraft(env.DB, access, await readJson(request), env)));
    }
    if (method === 'POST' && path === '/api/v1/partner/applications/mine/submit') return withHeaders(ok(await apps.submit(env.DB, access, env)));
    if (method === 'POST' && path === '/api/v1/partner/documents') {
      if (!env.KYC) throw new AppError('INTERNAL');
      const len = Number(request.headers.get('content-length') || 0);
      if (len > 5 * 1024 * 1024 + 1024) throw new AppError('VALIDATION_FAILED', 'File is larger than 5 MB');
      const bytes = await request.arrayBuffer();
      return withHeaders(ok(await apps.addDocument(env.DB, env.KYC, access, { docType: request.headers.get('x-doc-type'), bytes }), {}, 201));
    }
    if (method === 'GET' && path === '/api/v1/partner/dashboard') {
      if (!access.partnerId) throw new AppError('FORBIDDEN', 'Partner access is not active');
      const p = await env.DB.prepare('SELECT partner_code, type_key, status, business_name, activated_at FROM partners WHERE id = ? AND user_id = ?').bind(access.partnerId, access.userId).first();
      return withHeaders(ok({ partner: p, permissions: [...access.permissions.keys()] }));
    }
    let m;
    if (path === '/api/v1/partner/leads') {
      if (method === 'GET') return withHeaders(ok(await leads.listMine(env.DB, access, { status: url.searchParams.get('status') || undefined, q: url.searchParams.get('q') || undefined })));
      if (method === 'POST') return withHeaders(ok(await leads.createLead(env.DB, access, await readJson(request)), {}, 201));
    }
    if (method === 'GET' && path === '/api/v1/partner/commissions') return withHeaders(ok(await comm.listMine(env.DB, access, { status: url.searchParams.get('status') || undefined })));
    if (method === 'GET' && path === '/api/v1/partner/settlements') return withHeaders(ok(await comm.listSettlementsMine(env.DB, access)));
    if ((m = path.match(/^\/api\/v1\/partner\/commissions\/([0-9a-f-]{36})(\/dispute)?$/))) {
      if (method === 'GET' && !m[2]) return withHeaders(ok(await comm.getMine(env.DB, access, m[1])));
      if (method === 'POST' && m[2] === '/dispute') return withHeaders(ok(await comm.disputeMine(env.DB, access, m[1], (await readJson(request)).reason)));
    }
    if (method === 'GET' && path === '/api/v1/partner/quote-products') return withHeaders(ok(await quotes.catalogue(env.DB, access)));
    if (method === 'POST' && path === '/api/v1/partner/quote-price') return withHeaders(ok(await quotes.price(env.DB, access, await readJson(request))));
    if (path === '/api/v1/partner/quotes') {
      if (method === 'GET') return withHeaders(ok(await quotes.listMine(env.DB, access, { status: url.searchParams.get('status') || undefined, leadId: url.searchParams.get('leadId') || undefined })));
      if (method === 'POST') return withHeaders(ok(await quotes.createQuote(env.DB, access, await readJson(request), env), {}, 201));
    }
    if ((m = path.match(/^\/api\/v1\/partner\/quotes\/([0-9a-f-]{36})(\/items|\/submit|\/cancel|\/sent|\/response)?$/))) {
      const qid = m[1];
      if (method === 'GET' && !m[2]) return withHeaders(ok(await quotes.getMine(env.DB, access, qid)));
      if (method === 'POST' && m[2] === '/items') return withHeaders(ok(await quotes.replaceItems(env.DB, access, qid, await readJson(request))));
      if (method === 'POST' && m[2] === '/submit') return withHeaders(ok(await quotes.submit(env.DB, access, qid, env)));
      if (method === 'POST' && m[2] === '/cancel') return withHeaders(ok(await quotes.cancel(env.DB, access, qid)));
      if (method === 'POST' && m[2] === '/sent') return withHeaders(ok(await quotes.markSent(env.DB, access, qid)));
      if (method === 'POST' && m[2] === '/response') return withHeaders(ok(await quotes.recordResponseMine(env.DB, access, qid, (await readJson(request)).outcome)));
    }
    if ((m = path.match(/^\/api\/v1\/partner\/leads\/([0-9a-f-]{36})(\/activity|\/status)?$/))) {
      if (method === 'GET' && !m[2]) return withHeaders(ok(await leads.getMine(env.DB, access, m[1])));
      if (method === 'POST' && m[2] === '/activity') return withHeaders(ok(await leads.addActivityMine(env.DB, access, m[1], await readJson(request))));
      if (method === 'POST' && m[2] === '/status') return withHeaders(ok(await leads.setStatusMine(env.DB, access, m[1], await readJson(request))));
    }
    throw new AppError('NOT_FOUND', 'Not found');
  } catch (e) {
    if (!(e instanceof AppError)) console.error('partner api error', requestId, e && e.message);
    return withHeaders(fail(e, requestId));
  }
}

// ---------------------------------------------------------------- admin.ntagz.com (called after the admin Worker's own auth + CSRF)
// `actor` is the allowlisted admin email; body is already parsed by the admin Worker.
export async function adminV1(request, env, actor, body, ctx) {
  const res = await adminV1Inner(request, env, actor, body);
  if (request.method === 'POST' && res.status < 400) await flushLater(env, ctx);
  return res;
}
async function adminV1Inner(request, env, actor, body) {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url); const path = url.pathname; const method = request.method;
  try {
    const access = await accessForRoles(env.DB, actor, ['hq_admin']);
    let m;
    if (method === 'GET' && path === '/api/v1/admin/partner-applications') return ok(await review.listApplications(env.DB, access, { status: url.searchParams.get('status') || undefined, stage: url.searchParams.get('stage') || undefined, q: url.searchParams.get('q') || undefined, limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }));
    if ((m = path.match(/^\/api\/v1\/admin\/partner-applications\/([0-9a-f-]{36})$/)) && method === 'GET') return ok(await review.getApplication(env.DB, access, m[1]));
    if ((m = path.match(/^\/api\/v1\/admin\/partner-documents\/([0-9a-f-]{36})$/)) && method === 'GET') {
      if (!env.KYC) throw new AppError('UNAVAILABLE', 'Document storage is not connected to the admin yet');
      const d = await review.openDocument(env.DB, env.KYC, access, m[1]);
      return new Response(d.body, { headers: { 'content-type': d.mime, 'content-disposition': d.mime === 'application/pdf' ? 'attachment; filename="document.pdf"' : 'inline', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } });
    }
    if ((m = path.match(/^\/api\/v1\/admin\/partner-applications\/([0-9a-f-]{36})\/(start-review|request-documents|reject|approve)$/)) && method === 'POST') {
      const id = m[1];
      if (m[2] === 'start-review') return ok(await review.startReview(env.DB, access, id));
      if (m[2] === 'request-documents') return ok(await review.requestDocuments(env.DB, access, id, body.note));
      if (m[2] === 'reject') return ok(await review.reject(env.DB, access, id, body.note));
      return ok(await review.approve(env.DB, access, id, { agreementVersion: body.agreementVersion }));
    }
    if ((m = path.match(/^\/api\/v1\/admin\/partners\/([0-9a-f-]{36})\/(agreement-signed|fee-payment|activate|suspend|reinstate)$/)) && method === 'POST') {
      const id = m[1];
      if (m[2] === 'agreement-signed') return ok(await review.recordAgreementSigned(env.DB, access, id));
      if (m[2] === 'fee-payment') return ok(await review.recordFeePayment(env.DB, access, id, { amountPaise: body.amountPaise, gstPaise: body.gstPaise ?? 0, method: body.method, reference: body.reference }));
      if (m[2] === 'activate') return ok(await review.activate(env.DB, access, id));
      if (m[2] === 'suspend') return ok(await review.suspend(env.DB, access, id, body.reason));
      return ok(await review.reinstate(env.DB, access, id));
    }
    if (method === 'GET' && path === '/api/v1/admin/leads') return ok(await leads.listAll(env.DB, access, { status: url.searchParams.get('status') || undefined, partnerId: url.searchParams.get('partnerId') || undefined, q: url.searchParams.get('q') || undefined }));
    if (method === 'GET' && path === '/api/v1/admin/commissions') return ok(await comm.listAll(env.DB, access, { status: url.searchParams.get('status') || undefined, partnerId: url.searchParams.get('partnerId') || undefined, q: url.searchParams.get('q') || undefined }));
    if ((m = path.match(/^\/api\/v1\/admin\/commissions\/([0-9a-f-]{36})(\/approve|\/reverse|\/adjust|\/resolve)?$/))) {
      if (method === 'GET' && !m[2]) return ok(await comm.getAny(env.DB, access, m[1]));
      if (method === 'POST' && m[2] === '/approve') return ok(await comm.approve(env.DB, access, m[1]));
      if (method === 'POST' && m[2] === '/reverse') return ok(await comm.reverse(env.DB, access, m[1], body.reason));
      if (method === 'POST' && m[2] === '/adjust') return ok(await comm.adjust(env.DB, access, m[1], { deltaPaise: body.deltaPaise, reason: body.reason }));
      if (method === 'POST' && m[2] === '/resolve') return ok(await comm.resolve(env.DB, access, m[1], { action: body.action, note: body.note }));
    }
    if (method === 'GET' && path === '/api/v1/admin/commission-rules') return ok(await comm.listRules(env.DB, access));
    if (method === 'POST' && path === '/api/v1/admin/commission-rules') return ok(await comm.createRule(env.DB, access, body), {}, 201);
    if (method === 'POST' && (m = path.match(/^\/api\/v1\/admin\/commission-rules\/([0-9a-f-]{36})$/))) return ok(await comm.updateRule(env.DB, access, m[1], body));
    if (method === 'POST' && path === '/api/v1/admin/commission-settings') return ok(await comm.setSettings(env.DB, access, { defaultHoldDays: body.defaultHoldDays, tdsRateBp: body.tdsRateBp }));
    if (method === 'GET' && path === '/api/v1/admin/payables') return ok(await comm.payables(env.DB, access));
    if (method === 'GET' && path === '/api/v1/admin/settlements') return ok(await comm.listSettlements(env.DB, access));
    if (method === 'POST' && path === '/api/v1/admin/settlements') return ok(await comm.createSettlement(env.DB, access, { partnerId: body.partnerId, method: body.method, reference: body.reference }), {}, 201);
    if (method === 'GET' && path === '/api/v1/admin/quotes') return ok(await quotes.listAll(env.DB, access, { status: url.searchParams.get('status') || undefined, q: url.searchParams.get('q') || undefined }));
    if ((m = path.match(/^\/api\/v1\/admin\/quotes\/([0-9a-f-]{36})(\/approve|\/reject|\/response)?$/))) {
      if (method === 'GET' && !m[2]) return ok(await quotes.getAny(env.DB, access, m[1]));
      if (method === 'POST' && m[2] === '/approve') return ok(await quotes.approve(env.DB, access, m[1]));
      if (method === 'POST' && m[2] === '/reject') return ok(await quotes.reject(env.DB, access, m[1], body.note));
      if (method === 'POST' && m[2] === '/response') return ok(await quotes.recordResponseHq(env.DB, access, m[1], body.outcome));
    }
    if (method === 'GET' && path === '/api/v1/admin/active-partners') return ok(await leads.activePartners(env.DB, access));
    if ((m = path.match(/^\/api\/v1\/admin\/leads\/([0-9a-f-]{36})(\/assign|\/status|\/note)?$/))) {
      if (method === 'GET' && !m[2]) return ok(await leads.getAny(env.DB, access, m[1]));
      if (method === 'POST' && m[2] === '/assign') return ok(await leads.assign(env.DB, access, m[1], body.partnerId));
      if (method === 'POST' && m[2] === '/status') return ok(await leads.setStatusHq(env.DB, access, m[1], { status: body.status, reason: body.reason, orderId: body.orderId }));
      if (method === 'POST' && m[2] === '/note') return ok(await leads.addNoteHq(env.DB, access, m[1], body.body));
    }
    throw new AppError('NOT_FOUND', 'Not found');
  } catch (e) {
    if (!(e instanceof AppError)) console.error('admin v1 error', requestId, e && e.message);
    return fail(e, requestId);
  }
}
