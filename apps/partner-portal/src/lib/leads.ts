import type { LeadStatus } from '../types';

export const LEAD_STATUS: Record<LeadStatus, [string, string]> = {
  new: ['New', ''], contacted: ['Contacted', ''], qualified: ['Qualified', 'accent'], quotation: ['Quotation in progress', 'accent'], won: ['Won', 'ok'], lost: ['Lost', 'bad'],
};
export const LEAD_CHIPS: Array<[string, string]> = [['', 'All'], ['new', 'New'], ['contacted', 'Contacted'], ['qualified', 'Qualified'], ['quotation', 'Quotation'], ['won', 'Won'], ['lost', 'Lost']];
// What a partner may do next. Mirrors the server (which is the authority): partners can never set quotation or won.
export const NEXT: Partial<Record<LeadStatus, LeadStatus[]>> = { new: ['contacted', 'qualified', 'lost'], contacted: ['qualified', 'lost'], qualified: ['lost'] };
export const ACTIVITY_LABEL: Record<string, string> = { created: 'Registered', note: 'Note', call: 'Call', visit: 'Visit', status: 'Status', assign: 'Reassigned' };
export const when = (ts: number): string => new Date(ts * 1000).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
