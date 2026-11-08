import type { Application, DocRow, DocType } from '../types';

export const STEPS = ['Category', 'Business', 'About you', 'Capacity', 'Documents', 'Review'] as const;
export const REQUIRED_DOCS: DocType[] = ['pan', 'address_proof'];
export const OPTIONAL_DOCS: DocType[] = ['gst_certificate', 'shop_photo', 'bank_proof'];
export const DOC_LABEL: Record<DocType, string> = { pan: 'PAN card', address_proof: 'Address proof', gst_certificate: 'GST certificate', shop_photo: 'Shop or office photo', bank_proof: 'Bank proof (cancelled cheque or statement)', other: 'Other' };

export const INVEST: Array<[string, string]> = [['under_1l', 'Under ₹1 lakh'], ['1l_to_3l', '₹1 – 3 lakh'], ['3l_to_5l', '₹3 – 5 lakh'], ['5l_to_10l', '₹5 – 10 lakh'], ['over_10l', 'Over ₹10 lakh']];
export const BUSINESS_TYPES = ['Retail shop', 'Distributor or wholesaler', 'Technician or service provider', 'Freelance sales or marketing', 'Corporate or B2B sales', 'Other'];
export const STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'];

// Which wizard step a server field error belongs to, so "Review" can send the person back to the right place.
export const FIELD_STEP: Record<string, number> = {
  typeKey: 0, businessName: 1, business_type: 1, city: 1, state: 1, pincode: 1, shop_details: 1,
  name: 2, phone: 2, pan: 2, experience: 2, customer_base: 2, sales_marketing: 2,
  investment_capacity: 3, staff_available: 3, vehicle_available: 3,
  document_pan: 4, document_address_proof: 4,
};
export function stepOfField(f: string): number { return FIELD_STEP[f] ?? 5; }

// First step that still has required data missing, for resuming a draft.
export function resumeStep(a: Application | null, docs: DocRow[]): number {
  if (!a) return 0;
  if (!a.businessName || !a.city || !a.state || !a.pincode || !a.form.business_type) return 1;
  if (!a.form.name || !a.form.phone || !a.panLast4) return 2;
  if (!a.form.investment_capacity) return 3;
  const have = new Set(docs.filter((d) => d.status !== 'rejected').map((d) => d.type));
  if (REQUIRED_DOCS.some((t) => !have.has(t))) return 4;
  return 5;
}

export type Stage = { key: string; title: string; text: string; state: 'done' | 'current' | 'todo' };
// What the applicant sees after submitting. Honest copy: no promise of emails or timelines we do not run yet.
export function stages(appStatus: string, partnerStatus: string | null): Stage[] {
  const order = ['submitted', 'under_review', 'approved', 'agreement_pending', 'payment_pending', 'onboarding', 'active'];
  const at = partnerStatus && order.includes(partnerStatus) ? order.indexOf(partnerStatus) : order.indexOf(appStatus === 'documents_required' ? 'under_review' : appStatus);
  const defs: Array<[string, string, string]> = [
    ['submitted', 'Application received', 'Ntagz has your application.'],
    ['under_review', 'Under review', 'The Ntagz team checks your details and documents.'],
    ['approved', 'Approved', 'Your Partner ID has been issued.'],
    ['agreement_pending', 'Partner agreement', 'Ntagz records your signed agreement.'],
    ['payment_pending', 'Opening stock order', 'Ntagz records the payment for your opening stock order.'],
    ['onboarding', 'Final checks', 'Last checks before your access opens.'],
    ['active', 'Active partner', 'Your partner dashboard is open.'],
  ];
  return defs.map(([key, title, text], i) => ({ key, title, text, state: i < at ? 'done' : i === at ? (key === 'active' ? 'done' : 'current') : 'todo' }));
}
