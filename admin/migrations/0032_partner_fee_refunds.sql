-- 0032: record a refund of a partner joining fee. The money goes back outside the system (HQ records it, as with customer refunds).
-- The fee's stock credit is reversed in the same ledger, so balances stay true. Rebuilds partner_stock_credit only to allow kind 'reversal'.
CREATE TABLE IF NOT EXISTS partner_fee_refunds (
  id             TEXT PRIMARY KEY,
  fee_payment_id TEXT NOT NULL UNIQUE REFERENCES partner_fee_payments(id),
  partner_id     TEXT NOT NULL REFERENCES partners(id),
  amount_paise   INTEGER NOT NULL CHECK (amount_paise > 0),
  reason         TEXT NOT NULL,
  actor          TEXT NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE partner_stock_credit_new (
  id             TEXT PRIMARY KEY,
  partner_id     TEXT NOT NULL REFERENCES partners(id),
  kind           TEXT NOT NULL CHECK (kind IN ('grant', 'consume', 'reversal')),
  delta_paise    INTEGER NOT NULL,
  fee_payment_id TEXT UNIQUE REFERENCES partner_fee_payments(id),
  order_id       TEXT UNIQUE REFERENCES orders(id),
  refund_id      TEXT UNIQUE REFERENCES partner_fee_refunds(id),
  actor          TEXT NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((kind = 'grant'    AND delta_paise > 0 AND fee_payment_id IS NOT NULL AND order_id IS NULL AND refund_id IS NULL)
      OR (kind = 'consume'  AND delta_paise < 0 AND order_id IS NOT NULL AND fee_payment_id IS NULL AND refund_id IS NULL)
      OR (kind = 'reversal' AND delta_paise < 0 AND refund_id IS NOT NULL AND fee_payment_id IS NULL AND order_id IS NULL))
);
INSERT INTO partner_stock_credit_new (id, partner_id, kind, delta_paise, fee_payment_id, order_id, actor, created_at)
  SELECT id, partner_id, kind, delta_paise, fee_payment_id, order_id, actor, created_at FROM partner_stock_credit;
DROP TABLE partner_stock_credit;
ALTER TABLE partner_stock_credit_new RENAME TO partner_stock_credit;
CREATE INDEX IF NOT EXISTS idx_partner_stock_credit_partner ON partner_stock_credit(partner_id, created_at);
