-- Stage 2: trusted order recording. Apply TOGETHER WITH deploying the updated payments Worker (see stage2/README.md).
-- Orders become server-created only, so the insert-time trigger from 0001 (which trusted `gateway`) is no longer needed.
DROP TRIGGER IF EXISTS trg_orders_payment_defaults;

-- What the server priced at checkout start. Promoted to an order only after the gateway payment is verified.
CREATE TABLE checkout_intents (
  txn_id         TEXT PRIMARY KEY,                -- Razorpay order id, or PayU txnid
  gateway        TEXT NOT NULL,
  user_id        TEXT,
  items_json     TEXT NOT NULL DEFAULT '[]',
  name           TEXT, phone TEXT, email TEXT, address TEXT, pincode TEXT, state TEXT, gstin TEXT, quote_ref TEXT,
  subtotal_paise INTEGER NOT NULL,
  gst_paise      INTEGER NOT NULL,
  amount_paise   INTEGER NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_intents_created ON checkout_intents(created_at);

-- Per-IP (hashed) rate limit for the public offline-order endpoint.
CREATE TABLE order_attempts (
  ip_hash    TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_attempts ON order_attempts(ip_hash, created_at);

-- Manual payment records now cover UPI/bank too (with a reference such as a UTR); still at most one per order.
ALTER TABLE payments ADD COLUMN reference TEXT;
DROP INDEX IF EXISTS uq_payments_one_cash;
CREATE UNIQUE INDEX uq_payments_one_manual ON payments(order_id) WHERE recorded_by <> 'gateway';
