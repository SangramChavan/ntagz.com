export type AppStatus = 'draft' | 'submitted' | 'under_review' | 'documents_required' | 'approved' | 'rejected';
export type PartnerStatus = 'approved' | 'agreement_pending' | 'payment_pending' | 'onboarding' | 'active' | 'suspended' | 'terminated';
export type DocType = 'pan' | 'gst_certificate' | 'address_proof' | 'shop_photo' | 'bank_proof' | 'other';

export interface PartnerType { key: string; label: string; feePaise: number; gstRateBp: number | null }
export interface FormExtras {
  name?: string; phone?: string; business_type?: string; experience?: string; shop_details?: string; customer_base?: string;
  sales_marketing?: string; investment_capacity?: string; staff_available?: number; vehicle_available?: boolean;
}
export interface Application {
  id: string; status: AppStatus; typeKey: string; businessName: string | null; city: string | null; state: string | null;
  pincode: string | null; panLast4: string | null; form: FormExtras; decisionNote: string | null; submittedAt: number | null;
}
export interface DocRow { id: string; type: DocType; mime: string; size: number; status: 'uploaded' | 'accepted' | 'rejected'; note: string | null }
export interface Mine { application: Application | null; partner: { partnerCode: string; status: PartnerStatus } | null; documents?: DocRow[] }
export interface Me {
  email: string; roles: string[]; permissions: string[];
  partner: { partner_code: string; type_key: string; status: PartnerStatus; business_name: string } | null;
}
