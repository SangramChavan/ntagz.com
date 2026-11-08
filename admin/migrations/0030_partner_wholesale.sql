-- 0030: partner price lists, wholesale orders and opening-stock credit. Additive only. Money is integer paise.
-- NOTHING is seeded: no discount band and no minimum margin exist until HQ sets them (owner decisions are still open), and no product cost is
-- written here (products.cost_paise is empty in production; HQ enters it in Products). Until all three are set, partner pricing is refused.
--
-- Price list: one discount band per partner type, taken off the ex-GST retail price by the single pricing engine (functions/lib/pricing.js priceCart).
-- The minimum Ntagz margin is a system_settings row (key 'partner_min_margin_bp', basis points of COST, floor = cost x (1 + bp/10000)).
CREATE TABLE IF NOT EXISTS partner_price_bands (
  partner_type TEXT PRIMARY KEY REFERENCES partner_types(key),
  discount_bp  INTEGER NOT NULL CHECK (discount_bp >= 0 AND discount_bp <= 9000),
  updated_by   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Stock credit: the opening stock order a partner paid at onboarding (partner_fee_payments) becomes credit that wholesale orders draw down.
-- It is an append-only ledger; balance = SUM(delta_paise). A grant is tied to exactly one fee payment and a consume to exactly one order (both UNIQUE),
-- so neither can be applied twice. Nothing is ever refunded in cash. Credit held by an open payment link is NOT a ledger row: it is derived (see wholesale.js),
-- so an expired or cancelled link releases it with no background job.
CREATE TABLE IF NOT EXISTS partner_stock_credit (
  id             TEXT PRIMARY KEY,
  partner_id     TEXT NOT NULL REFERENCES partners(id),
  kind           TEXT NOT NULL CHECK (kind IN ('grant', 'consume')),
  delta_paise    INTEGER NOT NULL,
  fee_payment_id TEXT UNIQUE REFERENCES partner_fee_payments(id),
  order_id       TEXT UNIQUE REFERENCES orders(id),
  actor          TEXT NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((kind = 'grant'   AND delta_paise > 0 AND fee_payment_id IS NOT NULL AND order_id IS NULL)
      OR (kind = 'consume' AND delta_paise < 0 AND order_id IS NOT NULL AND fee_payment_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_partner_stock_credit_partner ON partner_stock_credit(partner_id, created_at);

-- A wholesale order is paid through the existing pay-link flow. pay_links.source has a CHECK that cannot be widened additively, so a partner link
-- is identified by partner_id (set by the partner API, never from a request). credit_paise = stock credit reserved against the link.
ALTER TABLE pay_links ADD COLUMN partner_id TEXT;
ALTER TABLE pay_links ADD COLUMN credit_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkout_intents ADD COLUMN partner_id TEXT;
ALTER TABLE checkout_intents ADD COLUMN credit_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN partner_id TEXT;                                   -- NULL for every customer order
ALTER TABLE orders ADD COLUMN stock_credit_paise INTEGER NOT NULL DEFAULT 0;     -- part of orders.total paid from stock credit
CREATE INDEX IF NOT EXISTS idx_pay_links_partner ON pay_links(partner_id);
CREATE INDEX IF NOT EXISTS idx_orders_partner ON orders(partner_id);

-- Opening payments already recorded become credit (the joining-fee wording is an opening stock order). Credit = amount received minus any GST recorded
-- with it; how GST on the opening order is treated is an owner/accountant decision (gst_rate_bp is still unset), so no tax is converted into credit.
INSERT OR IGNORE INTO partner_stock_credit (id, partner_id, kind, delta_paise, fee_payment_id, actor)
  SELECT lower(hex(randomblob(16))), partner_id, 'grant', amount_paise - gst_paise, id, 'migration-0030' FROM partner_fee_payments WHERE amount_paise > gst_paise;
