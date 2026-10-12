// Marketing email: provider abstraction (Resend) + HTML/text rendering. Transactional order mail stays in ../notify.js.
// Nothing is ever reported as sent without a real provider 2xx. No secrets are logged or returned.
import CRM from "../../../functions/lib/crm.js";

const { unsubUrl, clickUrl } = CRM;
export const SITE = "https://ntagz.com";
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const maskEmail = (e) => { const [l, d] = String(e).split("@"); return d ? `${(l || "")[0] || ""}***@${d}` : "***"; };
export const inr = (p) => "₹" + (p / 100).toLocaleString("en-IN", { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

// ── Configuration ────────────────────────────────────────────────────────────
const REQUIRED = ["RESEND_API_KEY", "MARKETING_FROM", "MARKETING_POSTAL_ADDRESS", "UNSUB_SECRET", "RESEND_WEBHOOK_SECRET"];
export function status(env) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (env.MARKETING_SEND_ENABLED !== "1") missing.push("MARKETING_SEND_ENABLED");
  return { configured: missing.length === 0, missing }; // names only, never values
}
export const notConfiguredMessage = (env) => `Email sending is not configured: set ${status(env).missing.join(", ")}`;
const fromAddress = (env) => { const m = String(env.MARKETING_FROM || "").match(/<([^>]+)>/); return (m ? m[1] : String(env.MARKETING_FROM || "")).trim(); };

// ── Links ────────────────────────────────────────────────────────────────────
// Product page directories that exist in the repo (product/<dir>/index.html). Anything else links to the order page.
const PAGES = new Set(["anti-metal-tag", "black-nfc-card", "google-review-nfc-card", "google-review-nfc-card-with-qr", "google-review-nfc-stand", "micro-flex-fpc", "mini-nfc-tag", "nfc-coin", "ntag216-adhesive-tag", "sample-kit", "uhf-rfid-label", "white-inkjet-nfc-card", "white-nfc-card"]);
export const productPath = (id) => (PAGES.has(id) ? `/product/${id}/` : /^google-review-nfc-stand-/.test(id) ? "/product/google-review-nfc-stand/" : "/order.html");
export const PATH_RE = /^\/[A-Za-z0-9._~\/-]{0,150}$/;
const imageUrl = (p) => (typeof p === "string" && /^[A-Za-z0-9._\/-]{1,150}$/.test(p) && !p.includes("..") ? `${SITE}/${p.replace(/^\/+/, "")}` : "");
const priceLabel = (p) => (p.all_inclusive ? `${inr(p.price_paise)} (all-inclusive)` : `${inr(p.price_paise)} + GST`);

// ── Rendering ────────────────────────────────────────────────────────────────
// spec: { subject, preview, template, heading, paragraphs[], products[] (DB rows), cta:{label,path}|null, notes[], utm:{campaign,medium} }
// rcpt: { id (campaign_recipients.id for click attribution; omit for journeys), email, first }
// Never receives cart contents or order data: only a first name.
export async function render(env, spec, rcpt) {
  const utm = `utm_source=email&utm_medium=${spec.utm.medium || "campaign"}&utm_campaign=${encodeURIComponent(spec.utm.campaign)}`;
  const link = (path) => (rcpt.id ? `${clickUrl(rcpt.id, path)}&${utm}` : `${SITE}${path}?${utm}`);
  const unsub = env.UNSUB_SECRET ? await unsubUrl(env.UNSUB_SECRET, rcpt.email) : `${SITE}/unsubscribe`;
  const hi = rcpt.first ? `Hi ${rcpt.first},` : "Hi,";
  const identity = oneLine(env.MARKETING_POSTAL_ADDRESS || "ntagz");
  const why = "You are receiving this because you opted in to marketing emails from ntagz.";
  const prodHtml = spec.products.map((p) => {
    const img = spec.template === "minimal" ? "" : imageUrl(p.image_url);
    return `<tr><td style="padding:10px 0;border-top:1px solid #eee">${img ? `<img src="${esc(img)}" width="64" height="64" alt="" style="vertical-align:middle;margin-right:12px;border-radius:8px">` : ""}`
      + `<a href="${esc(link(productPath(p.id)))}" style="color:#1d1d1f;font-weight:600;text-decoration:none">${esc(p.name)}</a><br><span style="color:#6e6e73">${esc(priceLabel(p))}</span></td></tr>`;
  }).join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f7"><div style="display:none;max-height:0;overflow:hidden">${esc(spec.preview || "")}</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:16px">`
    + `<table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:14px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d1d1f"><tr><td style="padding:24px">`
    + (spec.heading ? `<h1 style="font-size:22px;margin:0 0 12px">${esc(spec.heading)}</h1>` : "")
    + `<p>${esc(hi)}</p>` + spec.paragraphs.map((t) => `<p style="line-height:1.5">${esc(t)}</p>`).join("")
    + (spec.notes || []).map((t) => `<p style="line-height:1.5;background:#f5f5f7;border-radius:10px;padding:12px">${esc(t)}</p>`).join("")
    + (prodHtml ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0">${prodHtml}</table>` : "")
    + (spec.cta ? `<p><a href="${esc(link(spec.cta.path))}" style="background:#ff5a1f;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;display:inline-block">${esc(spec.cta.label)}</a></p>` : "")
    + `<hr style="border:0;border-top:1px solid #eee;margin:20px 0"><p style="color:#6e6e73;font-size:12px;line-height:1.5">${esc(why)}<br>${esc(identity)}<br><a href="${esc(unsub)}" style="color:#6e6e73">Unsubscribe</a></p>`
    + `</td></tr></table></td></tr></table></body></html>`;
  const text = [hi, "", spec.heading || "", ...spec.paragraphs.flatMap((t) => [t, ""]), ...(spec.notes || []).flatMap((t) => [t, ""]),
    ...spec.products.map((p) => `- ${p.name}: ${priceLabel(p)}  ${link(productPath(p.id))}`), spec.products.length ? "" : null,
    spec.cta ? `${spec.cta.label}: ${link(spec.cta.path)}` : null, "", "--", why, identity, `Unsubscribe: ${unsub}`].filter((l) => l !== null && l !== undefined).join("\n");
  const from = fromAddress(env);
  return {
    subject: oneLine(spec.subject).slice(0, 200), html, text,
    headers: { "List-Unsubscribe": `<${unsub}>, <mailto:${from}?subject=unsubscribe>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

// ── Sending ──────────────────────────────────────────────────────────────────
// batch: [{ key (row id), to, subject, html, text, headers }], at most 100. Returns { ok, ids[], status, error? }.
// The Idempotency-Key is derived from the row ids, so retrying the same rows cannot send twice.
export async function send(env, batch) {
  if (!status(env).configured) return { ok: false, status: 0, error: "not configured", unconfigured: true };
  if (!batch.length || batch.length > 100) return { ok: false, status: 0, error: "bad batch size" };
  const idem = "mk-" + hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(batch.map((b) => b.key).sort().join(","))));
  const res = await fetch("https://api.resend.com/emails/batch", {
    method: "POST", signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": idem },
    body: JSON.stringify(batch.map((b) => ({ from: env.MARKETING_FROM, to: [b.to], subject: b.subject, html: b.html, text: b.text, headers: b.headers }))),
  }).catch(() => null);
  if (!res) return { ok: false, status: 0, error: "provider unreachable" };
  if (!res.ok) return { ok: false, status: res.status, error: `provider ${res.status}` };
  const d = await res.json().catch(() => null);
  const ids = d && Array.isArray(d.data) ? d.data.map((x) => (x && typeof x.id === "string" ? x.id : null)) : [];
  return { ok: true, status: res.status, ids: batch.map((_, i) => ids[i] || null) };
}

// ── Helpers shared by campaigns and journeys ─────────────────────────────────
export const placeholders = (n) => Array(n).fill("?").join(",");
// First names only (never anything else) for a list of emails.
export async function firstNames(env, emails) {
  const out = new Map(); if (!emails.length) return out;
  const { results } = await env.DB.prepare(`SELECT lower(email) e, name FROM users WHERE lower(email) IN (${placeholders(emails.length)})`).bind(...emails).all();
  for (const r of results) { const f = String(r.name || "").trim().split(/\s+/)[0].slice(0, 30); if (f) out.set(r.e, f); }
  return out;
}
