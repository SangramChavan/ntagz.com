import type { DocType, FormExtras, Me, Mine, PartnerType } from './types';

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
  upload: (docType: DocType, file: File) => call<{ id: string; type: DocType }>('/api/v1/partner/documents', { method: 'POST', headers: { 'X-Doc-Type': docType, 'Content-Type': 'application/octet-stream' }, body: file }),
};
