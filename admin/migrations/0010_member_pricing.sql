-- Member pricing managed from the admin. Additive only; apply BEFORE deploying the Workers that read member_discount_pct
-- (they fall back to "no member discount" if the column is missing, so a late migration never overcharges or breaks checkout).

-- Membership tables normally come from db/membership-schema.sql; repeated here (IF NOT EXISTS) so every database that
-- runs the migrations has them. Existing tables and rows are untouched.
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT DEFAULT 'active',
  purchased_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL, welcome_credit_paise INTEGER DEFAULT 50000,
  welcome_credit_used INTEGER DEFAULT 0, welcome_credit_order_id TEXT, price_paid INTEGER DEFAULT 99900, payment_id TEXT,
  razorpay_order_id TEXT, created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_expires ON memberships(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_memberships_rpo ON memberships(razorpay_order_id) WHERE razorpay_order_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS membership_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT (unixepoch()));
INSERT OR IGNORE INTO membership_config (key, value) VALUES
  ('fee_paise', '99900'), ('discounts_live', '0'), ('min_margin_pct', '20'),
  ('discount_nfc_consumables_pct', '5'), ('discount_finished_products_pct', '8');
-- New settings: membership length and the cap on bulk + member discount combined.
INSERT OR IGNORE INTO membership_config (key, value) VALUES ('duration_days', '365'), ('max_total_discount_pct', '30');

-- Member discount is now set per product (it follows the regular price automatically). Seeded from the old category
-- settings so live member prices do not change: same product -> category mapping the payments Worker used.
ALTER TABLE products ADD COLUMN member_discount_pct REAL NOT NULL DEFAULT 0 CHECK (member_discount_pct >= 0 AND member_discount_pct <= 50);
UPDATE products SET member_discount_pct = min(50, max(0, coalesce((SELECT CAST(value AS REAL) FROM membership_config WHERE key='discount_nfc_consumables_pct'), 0)))
  WHERE id IN ('black-nfc-card','white-nfc-card','white-inkjet-nfc-card','anti-metal-tag','ntag216-adhesive-tag','nfc-coin','mini-nfc-tag','micro-flex-fpc','nfc-wristband','uhf-rfid-label');
UPDATE products SET member_discount_pct = min(50, max(0, coalesce((SELECT CAST(value AS REAL) FROM membership_config WHERE key='discount_finished_products_pct'), 0)))
  WHERE id IN ('google-review-nfc-card','google-review-nfc-stand-5x5','google-review-nfc-stand-10x10','google-review-nfc-stand-12x12','nfc-card-custom-printing','rfid-card-custom-printing');
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at);
