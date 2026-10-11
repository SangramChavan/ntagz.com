-- Spending tiers ("Ntagz Rewards"). ADDITIVE ONLY: no table or column is dropped, no existing row is deleted, and rewards stay OFF
-- (membership_config.loyalty_live = '0') until an admin switches them on, so deploying this changes no price.
-- Rollback / recovery: the app works without any of this; to undo, set loyalty_live=0. The new columns are harmless if left in place.
-- Existing customers are not reset: spend is derived from their paid orders, which are backfilled below.

CREATE TABLE loyalty_tiers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  min_spend_paise INTEGER NOT NULL CHECK (min_spend_paise >= 0),
  discount_pct    REAL NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 50),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  perks           TEXT NOT NULL DEFAULT '',
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO loyalty_tiers (id, name, min_spend_paise, discount_pct, sort_order, perks) VALUES
  ('free',     'Free',     0,       0, 0, 'Standard pricing'),
  ('silver',   'Silver',   100000,  3, 1, '3% off eligible products'),
  ('gold',     'Gold',     300000,  5, 2, '5% off eligible products'),
  ('platinum', 'Platinum', 1000000, 8, 3, '8% off eligible products');

INSERT OR IGNORE INTO membership_config (key, value) VALUES ('loyalty_live', '0'), ('loyalty_combine', 'best_of');

-- Per-product rules for tier discounts: eligible or excluded; optional ceiling (0 = excluded) so a low-margin product can be capped.
ALTER TABLE products ADD COLUMN loyalty_eligible INTEGER NOT NULL DEFAULT 1 CHECK (loyalty_eligible IN (0, 1));
ALTER TABLE products ADD COLUMN loyalty_max_pct REAL CHECK (loyalty_max_pct IS NULL OR (loyalty_max_pct >= 0 AND loyalty_max_pct <= 50));

-- What each order is worth to the tiers, frozen when the order is created (so changing tier settings never rewrites history).
ALTER TABLE orders ADD COLUMN shipping_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN discount_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN qualifying_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN loyalty_tier TEXT;
ALTER TABLE orders ADD COLUMN refunded_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkout_intents ADD COLUMN shipping_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkout_intents ADD COLUMN discount_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkout_intents ADD COLUMN qualifying_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkout_intents ADD COLUMN loyalty_tier TEXT;

-- Cart milestones. A campaign has an explicit reward (free shipping, or a capped percentage off), a spend threshold, an audience, dates,
-- and optional limits; nothing is applied just because a threshold is crossed. None are seeded: the admin creates them.
CREATE TABLE cart_campaigns (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  active             INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  threshold_paise    INTEGER NOT NULL CHECK (threshold_paise > 0),
  reward_type        TEXT NOT NULL CHECK (reward_type IN ('free_shipping', 'percent_off')),
  reward_value       REAL NOT NULL DEFAULT 0 CHECK (reward_value >= 0 AND reward_value <= 20),
  audience           TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'signed_in', 'members')),
  combinable         INTEGER NOT NULL DEFAULT 0 CHECK (combinable IN (0, 1)),
  starts_at          INTEGER,
  ends_at            INTEGER,
  max_redemptions    INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  per_customer_limit INTEGER CHECK (per_customer_limit IS NULL OR per_customer_limit > 0),
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);
ALTER TABLE orders ADD COLUMN campaign_id TEXT;
ALTER TABLE orders ADD COLUMN campaign_discount_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkout_intents ADD COLUMN campaign_id TEXT;
ALTER TABLE checkout_intents ADD COLUMN campaign_discount_paise INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_orders_campaign ON orders(campaign_id, user_id);

-- Refunds (none were recorded before). A partial refund reduces the order's qualifying value in proportion.
CREATE TABLE order_refunds (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  amount_paise    INTEGER NOT NULL CHECK (amount_paise > 0),
  reason          TEXT NOT NULL,
  actor           TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_refunds_order ON order_refunds(order_id);

-- Audited manual corrections to a customer's qualifying spend (never an overwrite: a signed delta with a reason and who did it).
CREATE TABLE loyalty_adjustments (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  delta_paise     INTEGER NOT NULL CHECK (delta_paise <> 0),
  reason          TEXT NOT NULL,
  actor           TEXT NOT NULL,
  spend_before    INTEGER NOT NULL,
  spend_after     INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_adjust_user ON loyalty_adjustments(user_id, created_at);

-- Persisted tier + why it changed (promotion / demotion history). Recomputable from orders at any time.
ALTER TABLE users ADD COLUMN loyalty_tier_id TEXT;
CREATE TABLE loyalty_tier_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  from_tier   TEXT,
  to_tier     TEXT,
  spend_paise INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_tierlog_user ON loyalty_tier_log(user_id, created_at);
CREATE INDEX idx_orders_user_paid ON orders(user_id, payment_status, status);

-- Backfill existing PAID orders so current customers keep their standing. Shipping was not stored before, so it is ESTIMATED from the
-- store's own rule (free at ₹2,000+, ₹40 Maharashtra / ₹80 elsewhere, none on all-inclusive stands); qualifying = total - GST - shipping.
UPDATE orders SET shipping_paise = CASE
    WHEN items_json LIKE '%google-review-nfc-stand%' THEN 0
    WHEN state = 'Maharashtra' AND total - gst - 4000 > 0 AND total - gst - 4000 < 200000 THEN 4000
    WHEN coalesce(state, '') NOT IN ('', 'Maharashtra') AND total - gst - 8000 > 0 AND total - gst - 8000 < 200000 THEN 8000
    ELSE 0 END
  WHERE payment_status = 'paid';
UPDATE orders SET qualifying_paise = max(total - gst - shipping_paise, 0) WHERE payment_status = 'paid';
