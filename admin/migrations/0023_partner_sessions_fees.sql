-- 0023: session metadata for the partner portal, and a ledger for partner joining-fee payments. Additive only.
-- Partner-portal sessions store the SHA-256 of the cookie token in sessions.id (the raw token is never stored) and are tagged
-- portal='partner'. Existing customer sessions keep portal NULL and are unaffected.

ALTER TABLE sessions ADD COLUMN portal TEXT;
ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN ua TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
ALTER TABLE sessions ADD COLUMN revoked_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_sessions_user_portal ON sessions(user_id, portal);

-- Joining fee received from a partner. Separate from `payments` (customer orders). Recorded by HQ today (bank/UPI); a gateway flow can
-- write the same table later. `reference` is unique so one bank/UPI reference cannot be recorded twice.
CREATE TABLE IF NOT EXISTS partner_fee_payments (
  id            TEXT PRIMARY KEY,
  partner_id    TEXT NOT NULL REFERENCES partners(id),
  amount_paise  INTEGER NOT NULL CHECK (amount_paise > 0),   -- total received, including any tax
  gst_paise     INTEGER NOT NULL DEFAULT 0 CHECK (gst_paise >= 0),
  method        TEXT NOT NULL CHECK (method IN ('bank_transfer', 'upi', 'razorpay', 'payu', 'cash', 'other')),
  reference     TEXT NOT NULL UNIQUE,
  recorded_by   TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_partner_fee_payments_partner ON partner_fee_payments(partner_id);
