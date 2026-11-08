// Client-side hints only. The server validates everything again and is the authority.
export const pincode = (v: string): boolean => /^[1-9]\d{5}$/.test(v.trim());
export const phone = (v: string): string | null => {
  const d = v.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(d) ? d : null;
};
export const pan = (v: string): string | null => { const s = v.trim().toUpperCase(); return /^[A-Z]{5}\d{4}[A-Z]$/.test(s) ? s : null; };
export const email = (v: string): boolean => v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
export const code = (v: string): boolean => /^\d{6}$/.test(v.trim());
