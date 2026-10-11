-- Phase 4: customer order notifications (email). One row per order event that triggered a message: the unique
-- (order_id, dedupe_key) is what guarantees a transition never emails the customer twice. Additive only.
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  event      TEXT NOT NULL,                    -- order_confirmed | payment_confirmed | packed | shipped | ...
  dedupe_key TEXT NOT NULL,                    -- order_events.id (or payment id) of the thing that caused it
  channel    TEXT NOT NULL DEFAULT 'email',
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped
  detail     TEXT,                             -- why skipped / failed; never contains secrets
  subject    TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (order_id, dedupe_key)
);
CREATE INDEX idx_notifications_order ON notifications(order_id, created_at);
