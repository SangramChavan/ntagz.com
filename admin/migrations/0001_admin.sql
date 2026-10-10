-- Admin foundations. Additive only: no existing column, row or table is changed or dropped.
-- orders.status stays the FULFILMENT status (confirmed|packed|shipped|delivered|cancelled);
-- payment state lives in its own columns so the two can never be confused.

ALTER TABLE orders ADD COLUMN payment_method TEXT;                         -- razorpay|payu|cash|cod|upi|bank
ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'; -- unpaid|paid
ALTER TABLE orders ADD COLUMN paid_paise INTEGER NOT NULL DEFAULT 0;

-- Orders written by the existing public route carry a gateway; online gateways are only recorded after a
-- verified payment, so they start as paid. Anything else starts unpaid until an admin records collection.
CREATE TRIGGER trg_orders_payment_defaults AFTER INSERT ON orders
BEGIN
  UPDATE orders SET
    payment_method = lower(NEW.gateway),
    payment_status = CASE WHEN lower(NEW.gateway) IN ('razorpay','payu') THEN 'paid' ELSE 'unpaid' END,
    paid_paise     = CASE WHEN lower(NEW.gateway) IN ('razorpay','payu') THEN NEW.total ELSE 0 END
  WHERE id = NEW.id;
END;

CREATE TABLE payments (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  method          TEXT NOT NULL,
  amount_paise    INTEGER NOT NULL CHECK (amount_paise > 0),
  recorded_by     TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (order_id, idempotency_key)
);
-- Hard stop on double collection: at most one manual cash record per order.
CREATE UNIQUE INDEX uq_payments_one_cash ON payments(order_id) WHERE method IN ('cash','cod');

CREATE TABLE admin_otps (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  otp_hash   TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_admin_otps_email ON admin_otps(email, created_at);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  order_id   TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_audit_order ON audit_log(order_id, created_at);

CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_orders_pay     ON orders(payment_status, payment_method);
