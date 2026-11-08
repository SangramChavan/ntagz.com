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
  wholesale?: boolean; // the partner type may place wholesale orders (the generic customer role also carries orders.place.own, so the permission alone is not enough)
}

export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'quotation' | 'won' | 'lost';
export interface Lead {
  id: string; businessName: string; contactName: string; phone: string; email: string | null; city: string | null; state: string | null; pincode: string | null;
  interest: string | null; estQuantity: number | null; notes: string | null; status: LeadStatus; lostReason: string | null; createdAt: number; updatedAt: number; closedAt: number | null;
}
export interface LeadActivity { by: string; kind: 'created' | 'note' | 'call' | 'visit' | 'status' | 'assign'; body: string | null; at: number }
export type LeadCounts = Record<LeadStatus, number>;
export interface LeadInput { businessName: string; contactName: string; phone: string; email?: string; city?: string; state?: string; pincode?: string; interest?: string; estQuantity?: number | string; notes?: string }

export type QuoteStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'sent' | 'accepted' | 'declined' | 'expired' | 'cancelled';
export interface QuoteItem { productId: string; name: string; qty: number; unitPricePaise: number; bulkPct: number; lineNetPaise: number; allInclusive: boolean }
export interface Quote {
  id: string; number: string; leadId: string; leadBusiness: string | null; status: QuoteStatus; customerName: string; customerPhone: string; customerEmail: string | null; shipState: string | null;
  validUntil: number; notes: string | null; decisionNote: string | null; pieces: number; subtotalPaise: number; discountPaise: number; gstPaise: number; shippingPaise: number; totalPaise: number;
  sentAt: number | null; respondedAt: number | null; createdAt: number; updatedAt: number; items?: QuoteItem[]; shareText?: string;
}
export interface QuoteProduct { id: string; name: string; listPricePaise: number; moq: number; fixed: boolean; allInclusive: boolean; packSize: number }
export interface QuoteTotals { pieces: number; subtotalPaise: number; discountPaise: number; gstPaise: number; shippingPaise: number; totalPaise: number }
export interface QuoteInput { leadId?: string; items: Array<{ productId: string; qty: number }>; validDays?: number; notes?: string }

export type CommissionStatus = 'pending' | 'approved' | 'payable' | 'paid' | 'reversed' | 'disputed';
export interface Commission { id: string; status: CommissionStatus; basePaise: number; originalAmountPaise: number; amountPaise: number; holdUntil: number | null; disputeReason: string | null; reversedReason: string | null; createdAt: number; orderRef: string; leadBusiness: string | null; settlementNumber: string | null; terms?: { pctBp: number | null; fixedPaise: number | null; maxPaise: number | null; holdDays: number | null; refundPolicy: string | null } }
export interface LedgerEntry { kind: string; deltaPaise: number; reason: string; by: string; at: number }
export type CommissionTotals = Record<CommissionStatus, { n: number; amountPaise: number }>;
export interface Settlement { number: string; totalPaise: number; tdsPaise: number; tdsRateBp: number | null; netPaise: number; method: string; reference: string; commissions: number; at: number }

export interface Credit { grantedPaise: number; consumedPaise: number; heldPaise: number; availablePaise: number }
export interface WholesaleProduct { id: string; name: string; moq: number; fixed: boolean; packSize: number; retailExPaise: number; partnerExPaise: number | null; discountPct: number | null; priced: boolean }
export interface WholesaleCatalogue { ready: boolean; gstPct: number; products: WholesaleProduct[]; credit: Credit }
export interface WholesaleLine { productId: string; name: string; qty: number; unitExPaise: number; retailExUnitPaise: number; discountPct: number; lineExPaise: number }
export interface WholesalePrice {
  lines: WholesaleLine[]; totals: { pieces: number; retailExPaise: number; discountPaise: number; shippingPaise: number; gstPaise: number; totalPaise: number };
  creditPaise: number; payablePaise: number; availableCreditPaise: number;
}
export interface WholesaleOrder {
  kind: 'order' | 'link'; id: string; ref: string; at: number; status: string; totalPaise: number; creditPaise: number; payablePaise: number; expiresAt?: number; payUrl?: string | null;
  items: Array<{ productId: string; name: string; qty: number }>;
}
export interface WholesalePlaced { kind: 'order' | 'link'; orderRef?: string; linkId?: string; payUrl?: string; totalPaise: number; creditPaise: number; payablePaise: number }
export interface WholesaleAddress { address: string; pincode: string; state: string; phone: string; gstin?: string }
