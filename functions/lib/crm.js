// CRM primitives shared by the payments Worker (public tracking / unsubscribe / click redirect) and the admin Worker (campaigns, consent).
// No I/O at import time. Everything that touches the database takes `db` (a D1 binding) explicitly.

const EVENTS = new Set(["page_view", "product_view", "search", "add_to_cart", "remove_from_cart", "begin_checkout", "membership_view", "email_click", "membership_offer_shown", "membership_offer_added", "membership_offer_declined"]);
// 'purchase', 'refund' and 'membership_tier_changed' are deliberately NOT accepted from browsers: they are derived from orders/refunds/loyalty_tier_log.
const ID = /^[A-Za-z0-9_-]{8,40}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UTM = /^[A-Za-z0-9._ -]{1,60}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const normEmail = (e) => (typeof e === "string" ? e.trim().toLowerCase().slice(0, 254) : "");

// Pathname only: no query, no fragment (they can carry tokens, order ids, emails). Returns "" when unusable.
function cleanPath(p) {
  if (typeof p !== "string") return "";
  const path = p.split(/[?#]/)[0].slice(0, 200);
  return /^\/[A-Za-z0-9._~\/-]*$/.test(path) && !path.includes("//") ? path : "";
}

// Search text can contain personal data typed into the wrong box; keep it only when it looks like a plain product query.
function cleanTerm(t) {
  if (typeof t !== "string") return null;
  const s = t.replace(/\s+/g, " ").trim().slice(0, 60);
  if (!s || s.includes("@") || /\d{7,}/.test(s.replace(/[\s-]/g, ""))) return null;
  return s;
}

// Validates one browser event. Returns { ok, event } with only whitelisted fields, or { ok:false }. The server adds ts and user_id itself.
function validateEvent(raw) {
  if (!raw || typeof raw !== "object" || !EVENTS.has(raw.event) || !ID.test(String(raw.id || "")) || !ID.test(String(raw.sid || ""))) return { ok: false };
  const e = { id: raw.id, sid: raw.sid, event: raw.event, path: cleanPath(raw.path) || null, product_id: null, category: null, term: null, utm_source: null, utm_medium: null, utm_campaign: null, recipient_id: null };
  if (typeof raw.product_id === "string" && SLUG.test(raw.product_id)) e.product_id = raw.product_id;
  if (typeof raw.category === "string" && SLUG.test(raw.category)) e.category = raw.category.slice(0, 30);
  if (raw.event === "search") e.term = cleanTerm(raw.term);
  for (const k of ["utm_source", "utm_medium", "utm_campaign"]) if (typeof raw[k] === "string" && UTM.test(raw[k])) e[k] = raw[k];
  if (typeof raw.recipient_id === "string" && UUID.test(raw.recipient_id)) e.recipient_id = raw.recipient_id;
  if ((raw.event === "product_view" || raw.event === "add_to_cart" || raw.event === "remove_from_cart") && !e.product_id) return { ok: false };
  return { ok: true, event: e };
}

// ── Unsubscribe tokens: HMAC(secret, "unsub:" + email). Stateless, per email, cannot be forged without UNSUB_SECRET. ──
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}
const unsubToken = (secret, email) => hmac(secret, "unsub:" + normEmail(email));
async function verifyUnsub(secret, email, token) {
  if (!secret || typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return false;
  const want = await unsubToken(secret, email);
  let d = 0; for (let i = 0; i < 64; i++) d |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return d === 0;
}
// https://ntagz.com/api/unsubscribe?e=<email>&t=<token>: GET shows a confirm page, POST (browser form or RFC 8058 one-click) performs it.
const unsubUrl = async (secret, email, base = "https://ntagz.com") => `${base}/api/unsubscribe?e=${encodeURIComponent(normEmail(email))}&t=${await unsubToken(secret, email)}`;
// Click-tracking redirect for campaign emails: path must be a site-relative path (never an arbitrary URL, so it cannot be an open redirect).
const clickUrl = (recipientId, path, base = "https://ntagz.com") => `${base}/api/c/${recipientId}?p=${encodeURIComponent(cleanPath(path) || "/")}`;

// ── Consent ledger ───────────────────────────────────────────────────────────────────────────────────────────
// Returns D1 statements (run them inside the caller's batch). status: subscribed | unsubscribed | suppressed.
// Rules enforced here, so no caller can get them wrong:
//   - A 'suppressed' row (bounce / complaint / manual) can only be changed by another 'suppressed' or an explicit admin 'unsuppress'; a customer
//     opt-in or unsubscribe never overrides it.
//   - 'subscribed' after the customer unsubscribed is allowed only as a NEW explicit opt-in (callers pass source = 'account_page' etc.).
//   - Every change appends to consent_log.
function consentStatements(db, c) {
  const email = normEmail(c.email);
  if (!EMAIL.test(email)) throw new Error("invalid email");
  const t = Math.floor(Date.now() / 1000), action = { subscribed: "opt_in", unsubscribed: "unsubscribe", suppressed: "suppress", unsuppress: "unsuppress" }[c.status];
  if (!action) throw new Error("invalid status");
  const status = c.status === "unsuppress" ? "unsubscribed" : c.status;
  const log = db.prepare("INSERT INTO consent_log (id,email,action,source,policy_version,actor,detail) VALUES (?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), email, action, String(c.source || "unknown").slice(0, 40), c.policy ? String(c.policy).slice(0, 20) : null, String(c.actor || "system").slice(0, 254), c.detail ? String(c.detail).slice(0, 300) : null);
  const upsert = db.prepare(`INSERT INTO marketing_contacts (email,user_id,status,source,policy_version,consented_at,unsubscribed_at,suppression_reason,updated_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
      ON CONFLICT(email) DO UPDATE SET status=?3, source=?4, user_id=coalesce(?2,user_id), updated_at=?9,
        policy_version=CASE WHEN ?3='subscribed' THEN ?5 ELSE policy_version END,
        consented_at=CASE WHEN ?3='subscribed' THEN ?6 ELSE consented_at END,
        unsubscribed_at=CASE WHEN ?3='subscribed' THEN NULL WHEN ?3='unsubscribed' THEN ?7 ELSE unsubscribed_at END,
        suppression_reason=CASE WHEN ?3='suppressed' THEN ?8 ELSE NULL END
      WHERE marketing_contacts.status <> 'suppressed' OR ?10 = 1`)
    .bind(email, c.userId || null, status, String(c.source || "unknown").slice(0, 40), c.policy ? String(c.policy).slice(0, 20) : null,
      status === "subscribed" ? t : null, status === "unsubscribed" ? t : null, status === "suppressed" ? (["bounce", "complaint", "manual"].includes(c.reason) ? c.reason : "manual") : null, t, c.status === "suppressed" || c.status === "unsuppress" ? 1 : 0);
  return [upsert, log];
}

module.exports = { EVENTS, validateEvent, cleanPath, cleanTerm, normEmail, unsubToken, verifyUnsub, unsubUrl, clickUrl, consentStatements, EMAIL, UUID };
