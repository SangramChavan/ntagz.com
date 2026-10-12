-- Ntagz Rewards Membership: points wallet, spending milestones, renewal notices. ADDITIVE ONLY; everything ships OFF (pts_live = 0),
-- so deploying this changes no price, no checkout total and sends no email until an admin switches it on.
-- Rollback: set pts_live=0 (instant). The new columns/tables are inert if left in place. Never drop points_ledger: it is the audit trail.

-- Per-product switch: does a purchase of this product earn points? (default yes; admin can exclude products)
ALTER TABLE products ADD COLUMN points_eligible INTEGER NOT NULL DEFAULT 1 CHECK (points_eligible IN (0, 1));

-- Frozen on the order when it is created (so later setting changes never rewrite history). All paise.
--   points_basis_paise    net product value of points-eligible lines of a MEMBER's order: after every discount incl. points redemption,
--                         without GST and shipping. 0 for non-members / below the minimum order. This is the only input to earning.
--   points_redeemed       points spent on this order; points_discount_paise = the rupee discount they bought.
--   member_saving_paise   what the paid-membership price took off this order (for "savings from member prices").
ALTER TABLE orders ADD COLUMN points_basis_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN points_redeemed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN points_discount_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN member_saving_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkout_intents ADD COLUMN points_basis_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkout_intents ADD COLUMN points_redeemed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkout_intents ADD COLUMN points_discount_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkout_intents ADD COLUMN member_saving_paise INTEGER NOT NULL DEFAULT 0;

-- Append-only ledger. A balance is ALWAYS derived from it (functions/lib/points.js), never stored. Corrections are new rows.
--   earn / bonus / restore / adjust(+)   credits, with expires_at
--   redeem / reverse / bonus_reverse / adjust(-) / expire   debits
--   reserve   points held while a checkout is open (counts only for a short time, and not once the order exists)
-- idem_key is UNIQUE: a retried callback or a concurrent request cannot write the same fact twice.
CREATE TABLE points_ledger (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL CHECK (kind IN ('earn', 'redeem', 'reserve', 'bonus', 'bonus_reverse', 'expire', 'reverse', 'restore', 'adjust')),
  points     INTEGER NOT NULL CHECK (points <> 0),
  order_id   TEXT,
  ref        TEXT,                    -- reserve: checkout txn id; bonus: milestone id
  expires_at INTEGER,                 -- credits only
  idem_key   TEXT NOT NULL UNIQUE,
  reason     TEXT,                    -- mandatory for manual adjustments
  actor      TEXT NOT NULL DEFAULT 'system',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_pl_user ON points_ledger(user_id, created_at);
CREATE INDEX idx_pl_order ON points_ledger(order_id);
CREATE INDEX idx_pl_expiry ON points_ledger(expires_at) WHERE expires_at IS NOT NULL;

-- Spending milestones (editable by admins; awards are recorded in the ledger so history survives edits).
CREATE TABLE reward_milestones (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL DEFAULT '',
  threshold_paise INTEGER NOT NULL CHECK (threshold_paise > 0),
  bonus_points    INTEGER NOT NULL CHECK (bonus_points > 0),
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO reward_milestones (id, threshold_paise, bonus_points, sort_order) VALUES
  ('m1', 250000, 50, 1), ('m2', 500000, 150, 2), ('m3', 1000000, 400, 3), ('m4', 2500000, 1250, 4);

-- One notice per (membership, kind): the unique key is what stops repeated expiry emails.
CREATE TABLE membership_notices (
  membership_id TEXT NOT NULL,
  kind          TEXT NOT NULL,        -- expiry_30 | expiry_7 | expired ...
  user_id       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | skipped | failed
  detail        TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (membership_id, kind)
);

-- Settings live in the existing key/value table. All integers. pts_live=0 means: nothing is earned, redeemed or shown as available.
INSERT OR IGNORE INTO membership_config (key, value) VALUES
  ('pts_live', '0'),
  ('pts_earn_per_100', '5'),          -- points per Rs 100 of eligible net merchandise spend
  ('pts_value_paise', '100'),         -- 1 point = Rs 1
  ('pts_min_redeem', '50'),
  ('pts_max_redeem_pct', '10'),       -- of eligible merchandise value per order
  ('pts_min_order_paise', '0'),       -- minimum eligible value for an order to earn
  ('pts_valid_days', '365'),
  ('pts_earn_on', 'delivered'),       -- delivered | paid
  ('pts_restore_on_cancel', '1'),     -- give redeemed points back when the order is cancelled/returned
  ('pts_clawback', '1'),              -- take a milestone bonus back if refunds drop spend below it (never below a 0 balance)
  ('renew_window_days', '30'),        -- customers may renew this many days before expiry
  ('renew_notice_days', '30,7');      -- expiry emails, days before expiry
CREATE INDEX IF NOT EXISTS idx_memberships_user_status ON memberships(user_id, status, expires_at);
