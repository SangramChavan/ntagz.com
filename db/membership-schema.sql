-- NTAGZ Trade Pass — membership schema
-- Run: npx wrangler d1 execute ntagz-db --file=db/membership-schema.sql --remote

CREATE TABLE IF NOT EXISTS memberships (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                    TEXT DEFAULT 'active',       -- 'active' | 'expired' | 'cancelled'
  purchased_at              INTEGER DEFAULT (unixepoch()),
  expires_at                INTEGER NOT NULL,            -- unix timestamp, 1 year from purchase
  welcome_credit_paise      INTEGER DEFAULT 50000,       -- ₹500
  welcome_credit_used       INTEGER DEFAULT 0,           -- 0 or 1
  welcome_credit_order_id   TEXT,                        -- orders.id that consumed the credit
  price_paid                INTEGER DEFAULT 99900,       -- paise
  payment_id                TEXT,                        -- Razorpay payment ID
  razorpay_order_id         TEXT,
  created_at                INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_memberships_user    ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_expires ON memberships(expires_at);
CREATE INDEX IF NOT EXISTS idx_memberships_status  ON memberships(status);

-- Admin-configurable settings for the membership programme
CREATE TABLE IF NOT EXISTS membership_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Defaults — admin must set discounts_live=1 before member pricing is applied at checkout
INSERT OR IGNORE INTO membership_config (key, value) VALUES
  ('fee_paise',                      '99900'),   -- ₹999/year
  ('welcome_credit_paise',           '50000'),   -- ₹500
  ('welcome_credit_min_order_paise', '499900'),  -- qualifying order ≥ ₹4,999
  ('welcome_credit_combinable',      '0'),        -- 0 = cannot combine with other discounts
  ('discount_nfc_consumables_pct',   '5'),        -- indicative; not applied until approved
  ('discount_finished_products_pct', '8'),        -- indicative
  ('min_margin_pct',                 '20'),       -- floor: never discount below 20% margin
  ('discounts_live',                 '0');        -- 0 = pricing feature disabled (safe default)
