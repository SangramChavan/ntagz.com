-- Phase 2: unguessable per-order tracking token (128-bit random). The public tracking page needs order id + token.
-- A trigger sets it on every insert path (gateway, offline, fixtures), so no application code can forget it.
ALTER TABLE orders ADD COLUMN track_token TEXT;
UPDATE orders SET track_token = lower(hex(randomblob(16))) WHERE track_token IS NULL;
CREATE UNIQUE INDEX uq_orders_track_token ON orders(track_token);
CREATE TRIGGER trg_orders_track_token AFTER INSERT ON orders WHEN NEW.track_token IS NULL
BEGIN
  UPDATE orders SET track_token = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
