import { AppError } from './errors.js';
import { email as cleanEmail } from './validate.js';
import { sha256Hex, randomToken, safeEqual, now } from './crypto.js';

// Same OTP rules as the live customer login (6 digits, hashed, 10 min, 5 guesses, 3 codes / 15 min / email) plus a per-IP cap.
// Sessions: the cookie holds a random token; only its SHA-256 is stored (sessions.id), so a database read cannot be replayed as a cookie.
const OTP_TTL = 600, PER_EMAIL = 3, PER_IP = 10, WINDOW = 900, MAX_GUESSES = 5;
const otpHash = (email, code) => sha256Hex(`ntagz:otp:${email}:${code}`);

async function log(db, { identifier, ip, portal, stage, success }) {
  await db.prepare('INSERT INTO login_attempts (id, identifier, ip, portal, stage, success) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), identifier, ip || null, portal, stage, success ? 1 : 0).run();
}

// `send(email, code)` delivers the code (email provider in production). Always answers the same way so the response does not reveal accounts.
export async function requestOtp(db, { email, ip, portal, send, ipLimit }) {
  const e = cleanEmail(email);
  if (!e) throw new AppError('VALIDATION_FAILED', 'Enter a valid email address', { email: 'invalid' });
  const byEmail = await db.prepare('SELECT COUNT(*) n FROM otp_tokens WHERE email = ? AND created_at > unixepoch() - ?').bind(e, WINDOW).first();
  const perIp = Number.isInteger(ipLimit) && ipLimit > 0 ? ipLimit : PER_IP; // configurable (OTP_IP_LIMIT) so local test servers sharing one IP are not throttled; production keeps the default
  if (byEmail.n >= PER_EMAIL) throw new AppError('RATE_LIMITED', 'Too many codes requested. Try again in a few minutes.');
  if (ip) {
    const byIp = await db.prepare("SELECT COUNT(*) n FROM login_attempts WHERE ip = ? AND stage = 'send' AND created_at > unixepoch() - ?").bind(ip, WINDOW).first();
    if (byIp.n >= perIp) throw new AppError('RATE_LIMITED', 'Too many requests. Try again in a few minutes.');
  }
  const buf = new Uint32Array(1); crypto.getRandomValues(buf);
  const code = String(100000 + (buf[0] % 900000));
  await db.batch([
    db.prepare('UPDATE otp_tokens SET used = 1 WHERE email = ? AND used = 0').bind(e),
    db.prepare('INSERT INTO otp_tokens (id, email, otp, expires_at) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), e, await otpHash(e, code), now() + OTP_TTL),
  ]);
  await log(db, { identifier: e, ip, portal, stage: 'send', success: true });
  const echoed = await send(e, code);
  return { sent: true, ...(echoed ? { dev_otp: echoed } : {}) };
}

// Verifies the code, creates the user (and the customer role) if new, and opens a session. Returns the raw cookie token once.
export async function verifyOtp(db, { email, code, ip, ua, portal, ttlSeconds }) {
  const e = cleanEmail(email);
  const c = String(code ?? '').trim();
  if (!e || !/^\d{6}$/.test(c)) throw new AppError('VALIDATION_FAILED', 'Invalid request');
  const bad = async () => { await log(db, { identifier: e, ip, portal, stage: 'verify', success: false }); return new AppError('UNAUTHENTICATED', 'Invalid or expired code'); };
  const tok = await db.prepare('SELECT id, otp FROM otp_tokens WHERE email = ? AND expires_at > unixepoch() AND used = 0 AND attempts < ? ORDER BY created_at DESC, rowid DESC LIMIT 1').bind(e, MAX_GUESSES).first();
  if (!tok) throw await bad();
  const burn = await db.prepare('UPDATE otp_tokens SET attempts = attempts + 1 WHERE id = ? AND attempts < ?').bind(tok.id, MAX_GUESSES).run();
  if (burn.meta.changes !== 1 || !safeEqual(tok.otp, await otpHash(e, c))) throw await bad();
  await db.prepare('UPDATE otp_tokens SET used = 1 WHERE id = ?').bind(tok.id).run();

  let user = await db.prepare('SELECT id, status FROM users WHERE email = ?').bind(e).first();
  if (user && user.status && user.status !== 'active') throw new AppError('FORBIDDEN', 'This account is suspended');
  const uid = user ? user.id : crypto.randomUUID();
  const token = randomToken(32);
  const exp = now() + ttlSeconds;
  const stmts = [];
  if (!user) stmts.push(db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').bind(uid, e));
  stmts.push(
    db.prepare("INSERT OR IGNORE INTO user_roles (id, user_id, role_key, granted_by) VALUES (?, ?, 'customer', 'system')").bind(crypto.randomUUID(), uid),
    db.prepare('INSERT INTO sessions (id, user_id, expires_at, portal, ip, ua, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(await sha256Hex(token), uid, exp, portal, ip || null, (ua || '').slice(0, 200), now()),
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), uid),
  );
  await db.batch(stmts);
  await log(db, { identifier: e, ip, portal, stage: 'verify', success: true });
  return { token, userId: uid, expiresAt: exp };
}

// Returns { userId, email } for a valid session of this portal, else null. Suspended users and revoked sessions never match.
export async function sessionUser(db, token, portal) {
  if (!/^[0-9a-f]{64}$/.test(token || '')) return null;
  const id = await sha256Hex(token);
  const row = await db.prepare(
    `SELECT s.id, s.last_seen_at, u.id AS user_id, u.email, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.portal = ? AND s.revoked_at IS NULL AND s.expires_at > unixepoch()`).bind(id, portal).first();
  if (!row || (row.status && row.status !== 'active')) return null;
  if (!row.last_seen_at || now() - row.last_seen_at > 300) await db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(now(), id).run();
  return { userId: row.user_id, email: row.email };
}

export async function revokeSession(db, token) {
  if (/^[0-9a-f]{64}$/.test(token || '')) await db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').bind(now(), await sha256Hex(token)).run();
}
export function revokeUserSessionsStmt(db, userId, portal) {
  return db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND portal = ? AND revoked_at IS NULL').bind(now(), userId, portal);
}
