import { AppError, ok, fail } from './errors.js';
import { loadAccess, accessForRoles } from './access.js';
import { requestOtp, verifyOtp, sessionUser, revokeSession } from './auth.js';
import * as apps from './applications.js';
import * as review from './review.js';

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
export async function partnerRouter(request, env) {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url); const path = url.pathname; const method = request.method;
  try {
    if (!path.startsWith('/api/v1/')) throw new AppError('NOT_FOUND', 'Not found');
    csrf(request, url);
    const ip = request.headers.get('cf-connecting-ip') || null;
    const ua = request.headers.get('user-agent') || '';

    if (method === 'POST' && path === '/api/v1/auth/otp/send') {
      const b = await readJson(request);
      return withHeaders(ok(await requestOtp(env.DB, { email: b.email, ip, portal: 'partner', send: (e, c) => sendOtpEmail(env, e, c) })));
    }
    if (method === 'POST' && path === '/api/v1/auth/otp/verify') {
      const b = await readJson(request);
      const s = await verifyOtp(env.DB, { email: b.email, code: b.code, ip, ua, portal: 'partner', ttlSeconds: PARTNER_SESSION_TTL });
      return withHeaders(ok({ signedIn: true }), { 'set-cookie': sessionCookie(s.token, PARTNER_SESSION_TTL) });
    }
    if (method === 'GET' && path === '/api/v1/partner/types') return withHeaders(ok(await apps.listTypes(env.DB)));

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
    if (method === 'POST' && path === '/api/v1/partner/applications/mine/submit') return withHeaders(ok(await apps.submit(env.DB, access)));
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
    throw new AppError('NOT_FOUND', 'Not found');
  } catch (e) {
    if (!(e instanceof AppError)) console.error('partner api error', requestId, e && e.message);
    return withHeaders(fail(e, requestId));
  }
}

// ---------------------------------------------------------------- admin.ntagz.com (called after the admin Worker's own auth + CSRF)
// `actor` is the allowlisted admin email; body is already parsed by the admin Worker.
export async function adminV1(request, env, actor, body) {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url); const path = url.pathname; const method = request.method;
  try {
    const access = await accessForRoles(env.DB, actor, ['hq_admin']);
    let m;
    if (method === 'GET' && path === '/api/v1/admin/partner-applications') return ok(await review.listApplications(env.DB, access, { status: url.searchParams.get('status') || undefined, limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }));
    if ((m = path.match(/^\/api\/v1\/admin\/partner-applications\/([0-9a-f-]{36})$/)) && method === 'GET') return ok(await review.getApplication(env.DB, access, m[1]));
    if ((m = path.match(/^\/api\/v1\/admin\/partner-documents\/([0-9a-f-]{36})$/)) && method === 'GET') {
      if (!env.KYC) throw new AppError('INTERNAL');
      const d = await review.openDocument(env.DB, env.KYC, access, m[1]);
      return new Response(d.body, { headers: { 'content-type': d.mime, 'content-disposition': 'inline', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } });
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
    throw new AppError('NOT_FOUND', 'Not found');
  } catch (e) {
    if (!(e instanceof AppError)) console.error('admin v1 error', requestId, e && e.message);
    return fail(e, requestId);
  }
}
