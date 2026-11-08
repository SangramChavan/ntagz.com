// Partner-network emails: templates, a transactional outbox, and a sender with retry. Plain, factual text; no income claims, no marketing.
// queueEmail() returns a prepared statement so it rides in the same db.batch() as the change that caused it.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oneLine = (s) => String(s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim().slice(0, 150); // subjects never carry line breaks (header injection)
const TYPE = { '360': 'Ntagz360', enterprise: 'Enterprise', flex: 'Flex', smile: 'Smile', smile_plus: 'Smile+' };
const https = (u, fallback) => { try { const x = new URL(u || fallback); return x.protocol === 'https:' ? x.href.replace(/\/$/, '') : fallback; } catch { return fallback; } };
export const partnerUrl = (env) => https(env && env.PARTNER_URL, 'https://partner.ntagz.com');
export const adminUrl = (env) => https(env && env.ADMIN_URL, 'https://admin.ntagz.com');

// template -> (data, env) -> { subject, lines: [paragraph...], cta?: [label, url] }
const T = {
  application_received: (d, env) => ({ subject: 'We received your Ntagz partner application', lines: [
    `Hi ${d.name || 'there'},`, `Thank you for applying to become an Ntagz ${TYPE[d.typeKey] || ''} partner with ${d.businessName || 'your business'}.`,
    'The Ntagz team will review your application. We will email you when there is an update, and you can check the status at any time.'], cta: ['Check your application', partnerUrl(env) + '/status'] }),
  documents_requested: (d, env) => ({ subject: 'We need a little more to review your application', lines: [
    `Hi ${d.name || 'there'},`, 'To continue reviewing your Ntagz partner application, the team asked for the following:', `“${d.note}”`,
    'Please add it and send your application again.'], cta: ['Update your application', partnerUrl(env) + '/apply'] }),
  application_approved: (d, env) => ({ subject: 'Your Ntagz partner application is approved', lines: [
    `Hi ${d.name || 'there'},`, `Your application for ${d.businessName || 'your business'} has been approved. Your Partner ID is ${d.partnerCode}.`,
    'Your partner dashboard opens after Ntagz records your signed partner agreement and your joining fee, and then activates your account. The Ntagz team will contact you with the details.'],
    cta: ['Follow your progress', partnerUrl(env) + '/status'] }),
  application_rejected: (d, env) => ({ subject: 'Update on your Ntagz partner application', lines: [
    `Hi ${d.name || 'there'},`, 'We could not approve your partner application at this time.', `Reason from the team: “${d.note}”`, 'You are welcome to apply again with updated details.'],
    cta: ['Apply again', partnerUrl(env) + '/apply'] }),
  partner_activated: (d, env) => ({ subject: 'Your Ntagz partner account is active', lines: [
    `Hi ${d.name || 'there'},`, `Your Ntagz partner account (${d.partnerCode}) is now active. You can sign in to your partner dashboard.`], cta: ['Open your dashboard', partnerUrl(env) + '/dashboard'] }),
  partner_suspended: (d) => ({ subject: 'Your Ntagz partner access is suspended', lines: [
    `Hi ${d.name || 'there'},`, `Your Ntagz partner access (${d.partnerCode}) has been suspended.`, `Reason from the team: “${d.note}”`, 'If you have questions, reply to this email.'] }),
  partner_reinstated: (d, env) => ({ subject: 'Your Ntagz partner access is restored', lines: [
    `Hi ${d.name || 'there'},`, `Your Ntagz partner access (${d.partnerCode}) has been restored.`], cta: ['Open your dashboard', partnerUrl(env) + '/dashboard'] }),
  hq_new_application: (d, env) => ({ subject: oneLine(`${d.resubmitted ? 'Updated' : 'New'} partner application: ${d.businessName || 'Unnamed'} (${TYPE[d.typeKey] || d.typeKey})`), lines: [
    `${d.businessName || 'A business'} in ${[d.city, d.state].filter(Boolean).join(', ') || 'an unspecified location'} ${d.resubmitted ? 'sent an updated application' : 'applied'} as ${TYPE[d.typeKey] || d.typeKey}.`], cta: ['Review in admin', adminUrl(env) + '/#/partners'] }),
};
export const TEMPLATES = Object.keys(T);

export function render(template, data, env) {
  const t = T[template]; if (!t) throw new Error('unknown template');
  const m = t(data || {}, env || {});
  const text = [...m.lines, m.cta ? `${m.cta[0]}: ${m.cta[1]}` : '', '— Ntagz'].filter(Boolean).join('\n\n');
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1F1C20;max-width:520px;line-height:1.5">`
    + m.lines.map((l) => `<p style="margin:0 0 14px">${esc(l)}</p>`).join('')
    + (m.cta ? `<p style="margin:18px 0"><a href="${esc(m.cta[1])}" style="background:#FF6A21;color:#1F1C20;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:6px;display:inline-block">${esc(m.cta[0])}</a></p>` : '')
    + `<p style="margin:18px 0 0;color:#5B5760">— Ntagz</p></div>`;
  return { subject: oneLine(m.subject), text, html };
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
// `dedupeKey` identifies the thing that caused the message (for example template + record + the record's previous updated_at).
export function queueEmail(db, { to, template, data, dedupeKey }) {
  if (!T[template]) throw new Error('unknown template: ' + template);
  const addr = String(to || '').trim().toLowerCase();
  const ok = EMAIL.test(addr) && addr.length <= 254;
  return db.prepare("INSERT OR IGNORE INTO email_outbox (id, to_email, template, data_json, dedupe_key, status, last_error) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), ok ? addr : String(to ?? '').slice(0, 254), template, JSON.stringify(data || {}), String(dedupeKey).slice(0, 200), ok ? 'pending' : 'skipped', ok ? null : 'no valid recipient address');
}
export const hqRecipients = (env) => String((env && env.HQ_NOTIFY_EMAILS) || '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => EMAIL.test(e)).slice(0, 10);

const BACKOFF_MIN = [1, 5, 30, 120, 360]; // minutes after attempt 1..5
const MAX_ATTEMPTS = BACKOFF_MIN.length;
const now = () => Math.floor(Date.now() / 1000);

// Sends due messages. Never throws. A row is claimed atomically (so two Workers cannot both send it); a crashed sender's claim expires after 5 minutes.
export async function flushOutbox(env, { limit = 10, fetchFn = fetch } = {}) {
  const db = env.DB; const out = { sent: 0, retried: 0, failed: 0, skipped: 0 };
  try {
    const due = (await db.prepare("SELECT id FROM email_outbox WHERE status IN ('pending','sending') AND next_attempt_at <= unixepoch() ORDER BY created_at LIMIT ?").bind(limit).all()).results;
    for (const { id } of due) {
      const claim = await db.prepare("UPDATE email_outbox SET status = 'sending', attempts = attempts + 1, next_attempt_at = unixepoch() + 300 WHERE id = ? AND status IN ('pending','sending') AND next_attempt_at <= unixepoch()").bind(id).run();
      if (claim.meta.changes !== 1) continue;
      const row = await db.prepare('SELECT * FROM email_outbox WHERE id = ?').bind(id).first();
      const finish = (status, err, nextIn) => db.prepare('UPDATE email_outbox SET status = ?, last_error = ?, sent_at = ?, next_attempt_at = ? WHERE id = ?').bind(status, err ? String(err).slice(0, 200) : null, status === 'sent' ? now() : null, nextIn ? now() + nextIn * 60 : now(), id).run();
      if (!env.RESEND_API_KEY) { await finish('skipped', 'email not configured'); out.skipped++; continue; }
      let msg; try { msg = render(row.template, JSON.parse(row.data_json || '{}'), env); } catch { await finish('failed', 'could not render message'); out.failed++; continue; }
      let err = '';
      try {
        const res = await fetchFn('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': row.id },
          body: JSON.stringify({ from: 'ntagz <hello@ntagz.com>', to: [row.to_email], subject: msg.subject, text: msg.text, html: msg.html }),
        });
        if (res.ok) { await finish('sent'); out.sent++; continue; }
        err = `email provider answered ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) { await finish('failed', err); out.failed++; continue; } // our request is wrong; retrying will not help
      } catch { err = 'email provider unreachable'; }
      if (row.attempts + 0 >= MAX_ATTEMPTS) { await finish('failed', err); out.failed++; } else { await finish('pending', err, BACKOFF_MIN[Math.min(row.attempts, MAX_ATTEMPTS) - 1] ?? 360); out.retried++; }
    }
  } catch (e) { console.error('email outbox flush failed:', e && e.message); }
  return out;
}
