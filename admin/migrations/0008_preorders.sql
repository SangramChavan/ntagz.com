-- Phase 3: pre-orders. Additive only.
-- Pre-orders only make sense for products with track_stock=1: ready stock ships now, anything beyond it is a pre-order.
ALTER TABLE products ADD COLUMN preorder_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN preorder_message TEXT;          -- shown to customers, admin-written
ALTER TABLE products ADD COLUMN preorder_dispatch TEXT;         -- free text lead time, e.g. "Within 7-10 business days"
ALTER TABLE products ADD COLUMN preorder_max INTEGER CHECK (preorder_max IS NULL OR preorder_max >= 0);   -- NULL = no cap
ALTER TABLE products ADD COLUMN preordered_qty INTEGER NOT NULL DEFAULT 0 CHECK (preordered_qty >= 0);   -- units committed to pre-orders, not yet released

ALTER TABLE orders ADD COLUMN expected_dispatch TEXT;           -- YYYY-MM-DD, an expected dispatch date, not a delivery promise

-- What each order took from stock: ready_qty came out of ready stock, pre_qty is the pre-order part.
-- Written in the same atomic batch that creates the order; used to release stock if the order is cancelled.
CREATE TABLE order_stock_lines (
  order_id   TEXT NOT NULL REFERENCES orders(id),
  product_id TEXT NOT NULL,
  ready_qty  INTEGER NOT NULL CHECK (ready_qty >= 0),
  pre_qty    INTEGER NOT NULL CHECK (pre_qty >= 0),
  released   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (order_id, product_id)
);
