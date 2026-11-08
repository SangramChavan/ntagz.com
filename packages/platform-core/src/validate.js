// Small, dependency-free validators for the partner forms. They return the cleaned value or null.
export const pincode = (v) => (/^[1-9]\d{5}$/.test(String(v ?? '').trim()) ? String(v).trim() : null);
export const phone = (v) => { const d = String(v ?? '').replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''); return /^[6-9]\d{9}$/.test(d) ? d : null; };
export const pan = (v) => { const s = String(v ?? '').trim().toUpperCase(); return /^[A-Z]{5}\d{4}[A-Z]$/.test(s) ? s : null; };
export const gstin = (v) => { const s = String(v ?? '').trim().toUpperCase(); return /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s) ? s : null; };
export const email = (v) => { const s = String(v ?? '').trim().toLowerCase(); return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null; };

// Keyed hash so a stored PAN hash cannot be brute-forced from the database alone. `secret` comes from a Worker secret.
export async function keyedHash(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
