import type { DocType, FormExtras, Lead, LeadActivity, LeadCounts, LeadInput, LeadStatus, Me, Mine, PartnerType } from './types';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public fields: Record<string, string> = {}) { super(message); }
}

// Same-origin only. The header + the browser-sent Origin satisfy the server's CSRF rule for state-changing requests.
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'ntagz', ...(init.headers as Record<string, string> | undefined) };
  let res: Response;
  try { res = await fetch(path, { ...init, headers, credentials: 'same-origin' }); }
  catch { throw new ApiError('NETWORK', 'Could not reach the server. Check your connection and try again.', 0); }
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok || !body || body.ok !== true) {
    const e = body && body.error;
    throw new ApiError(e?.code ?? 'INTERNAL', e?.message ?? 'Something went wrong. Please try again.', res.status, e?.fields ?? {});
  }
  return body.data as T;
}
const qs = (o: Record<string, string | undefined>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v) p.set(k, v); const s = p.toString(); return s ? '?' + s : ''; };
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export interface DraftInput {
  typeKey?: string; businessName?: string; city?: string; state?: string; pincode?: string; pan?: string; form?: FormExtras;
}
export const api = {
  types: () => call<PartnerType[]>('/api/v1/partner/types'),
  sendCode: (email: string) => call<{ sent: boolean }>('/api/v1/auth/otp/send', json('POST', { email })),
  verifyCode: (email: string, code: string) => call<{ signedIn: boolean }>('/api/v1/auth/otp/verify', json('POST', { email, code })),
  logout: () => call<{ signedOut: boolean }>('/api/v1/auth/logout', { method: 'POST' }),
  me: () => call<Me>('/api/v1/me'),
  mine: () => call<Mine>('/api/v1/partner/applications/mine'),
  save: (input: DraftInput) => call<Mine>('/api/v1/partner/applications/mine', json('PUT', input)),
  submit: () => call<Mine>('/api/v1/partner/applications/mine/submit', { method: 'POST' }),
  leads: (status?: string, q?: string) => call<{ items: Lead[]; counts: LeadCounts }>('/api/v1/partner/leads' + qs({ status, q })),
  lead: (id: string) => call<{ lead: Lead; activities: LeadActivity[] }>(`/api/v1/partner/leads/${id}`),
  createLead: (input: LeadInput) => call<{ lead: Lead; activities: LeadActivity[] }>('/api/v1/partner/leads', json('POST', input)),
  leadNote: (id: string, kind: 'note' | 'call' | 'visit', body: string) => call<{ lead: Lead; activities: LeadActivity[] }>(`/api/v1/partner/leads/${id}/activity`, json('POST', { kind, body })),
  leadStatus: (id: string, status: LeadStatus, reason?: string) => call<{ lead: Lead; activities: LeadActivity[] }>(`/api/v1/partner/leads/${id}/status`, json('POST', { status, reason })),
  upload: (docType: DocType, file: File) => call<{ id: string; type: DocType }>('/api/v1/partner/documents', { method: 'POST', headers: { 'X-Doc-Type': docType, 'Content-Type': 'application/octet-stream' }, body: file }),
};
