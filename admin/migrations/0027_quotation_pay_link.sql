-- 0027: connect an accepted quotation to the payment link that collects its money. Additive only (one nullable column).
-- The link itself is the existing pay_links table (priced fresh by the payments Worker when opened/paid, so checkout stays the price authority).
ALTER TABLE quotations ADD COLUMN pay_link_id TEXT;
CREATE INDEX IF NOT EXISTS idx_quotations_pay_link ON quotations(pay_link_id);
