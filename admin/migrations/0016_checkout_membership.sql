-- Membership bought inside checkout (one payment: merchandise + fee). ADDITIVE; ships OFF (checkout_offer = 0).
-- The fee is never sent by the browser: the server adds membership_config.fee_paise when the customer asks to add membership.
--   checkout_intents.membership_fee_paise / membership_days   what the order includes (frozen when priced)
--   orders.membership_fee_paise                               the part of the paid amount that is the membership fee
--   rules_json                                                the settings the order was priced under (rates, fee, term) — never rewritten
-- The membership row is created in the same batch as the order, keyed by the payment's txn id (memberships.razorpay_order_id is UNIQUE),
-- so a replayed callback cannot activate it twice.
-- Rollback: set checkout_offer = 0 (instant). Columns are inert if left in place.
ALTER TABLE checkout_intents ADD COLUMN membership_fee_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkout_intents ADD COLUMN membership_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkout_intents ADD COLUMN rules_json TEXT;
ALTER TABLE orders ADD COLUMN membership_fee_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN rules_json TEXT;
INSERT OR IGNORE INTO membership_config (key, value) VALUES ('checkout_offer', '0');
