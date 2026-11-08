import type { QuoteStatus } from '../types';

export const QUOTE_STATUS: Record<QuoteStatus, [string, string]> = {
  draft: ['Draft', ''], pending_approval: ['Waiting for Ntagz approval', 'accent'], approved: ['Approved', 'ok'], rejected: ['Needs changes', 'bad'], sent: ['Sent to customer', 'ok'],
  accepted: ['Accepted', 'ok'], declined: ['Declined', 'bad'], expired: ['Expired', ''], cancelled: ['Cancelled', ''],
};
export const QUOTE_CHIPS: Array<[string, string]> = [['', 'All'], ['draft', 'Draft'], ['pending_approval', 'Waiting'], ['approved', 'Approved'], ['sent', 'Sent'], ['accepted', 'Accepted'], ['rejected', 'Needs changes'], ['declined', 'Declined'], ['expired', 'Expired']];
export const day = (ts: number): string => new Date(ts * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
// WhatsApp opens with the message ready; the partner reads it and presses send. Numbers are Indian 10-digit mobiles.
export const waLink = (phone: string, text: string): string => `https://wa.me/91${phone.replace(/\D/g, '').slice(-10)}?text=${encodeURIComponent(text)}`;
