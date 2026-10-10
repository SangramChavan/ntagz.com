-- Fulfilment: order timeline, shipments (AWB / courier / tracking URL), shipment correction history.
-- Additive only. orders.status stays the fulfilment status; payment state is never touched by these tables.
ALTER TABLE orders ADD COLUMN is_preorder INTEGER NOT NULL DEFAULT 0;   -- set by the pre-order phase; used by the Pre-Orders filter

CREATE TABLE order_events (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  kind            TEXT NOT NULL,                -- status | shipment | shipment_update | note
  status          TEXT,                         -- resulting fulfilment status (status/shipment events)
  note            TEXT,                         -- internal, never shown to customers
  public_note     TEXT,                         -- shown to the customer in the order journey
  customer_visible INTEGER NOT NULL DEFAULT 1,
  actor           TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (order_id, idempotency_key)
);
CREATE INDEX idx_events_order ON order_events(order_id, created_at);

CREATE TABLE shipments (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  courier      TEXT NOT NULL,
  awb          TEXT NOT NULL,
  tracking_url TEXT,                             -- as pasted by the admin; never invented
  shipped_on   TEXT NOT NULL,                    -- YYYY-MM-DD
  est_delivery TEXT,                             -- YYYY-MM-DD, optional, an estimate not a promise
  notes        TEXT,                             -- internal
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (order_id, awb)
);
CREATE INDEX idx_shipments_order ON shipments(order_id, created_at);
CREATE INDEX idx_shipments_awb ON shipments(awb);

CREATE TABLE shipment_revisions (
  id          TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  changed_by  TEXT NOT NULL,
  changes     TEXT NOT NULL,                     -- JSON {field: {from, to}}
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_revisions_shipment ON shipment_revisions(shipment_id, created_at);
