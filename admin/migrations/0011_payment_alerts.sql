-- Verified gateway payments that could not be turned into an order. One row per (txn, reason); resolve by hand.
CREATE TABLE IF NOT EXISTS payment_alerts (
  id           TEXT PRIMARY KEY,
  txn_id       TEXT NOT NULL,
  gateway      TEXT,
  payment_ref  TEXT,
  amount_paise INTEGER,
  reason       TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (txn_id, reason)
);
CREATE INDEX IF NOT EXISTS idx_payment_alerts_open ON payment_alerts(resolved, created_at);
