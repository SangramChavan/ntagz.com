-- 0028: commission engine. Additive only.
-- NO commercial terms are seeded: there are no rules and no TDS rate until HQ sets them (owner decisions are still open), so nothing accrues by accident.
-- Money is integer paise. A commission is created when HQ marks a lead WON with its order (the lead already carries the attribution), from the rule
-- that matched at that moment; the terms are copied onto the commission (rule_snapshot_json) so later rule edits never change an existing commission.
-- Duplicate attribution is impossible: one commission per order and earning type (UNIQUE). There is no recruitment or referral-of-partners earning type.
-- Release: pending -> approved (HQ/Finance) -> payable (only after the hold date, with the customer's payment cleared and no refund) -> paid (in a settlement).
-- Every change in amount is a row in commission_adjustments; amount_paise = original_amount_paise + SUM(delta_paise) (a test checks this).

CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_by TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS commission_rules (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  earning_type   TEXT NOT NULL DEFAULT 'lead_conversion'
                 CHECK (earning_type IN ('product_resale_margin', 'qualified_sales', 'lead_conversion', 'installation', 'nfc_setup', 'subscription_referral', 'enterprise_project')),
  partner_type   TEXT REFERENCES partner_types(key),          -- NULL = every partner type
  pct_bp         INTEGER CHECK (pct_bp IS NULL OR (pct_bp >= 0 AND pct_bp <= 10000)),   -- basis points of the order's qualifying value (ex-GST, after discounts)
  fixed_paise    INTEGER CHECK (fixed_paise IS NULL OR fixed_paise >= 0),
  min_order_paise INTEGER NOT NULL DEFAULT 0,
  max_paise      INTEGER CHECK (max_paise IS NULL OR max_paise > 0),                    -- cap per commission
  hold_days      INTEGER CHECK (hold_days IS NULL OR hold_days >= 0),                   -- NULL = use the default setting
  refund_policy  TEXT NOT NULL DEFAULT 'proportional' CHECK (refund_policy IN ('proportional', 'reverse_all')),
  active         INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (COALESCE(pct_bp, 0) > 0 OR COALESCE(fixed_paise, 0) > 0)                       -- a rule must pay something
);
CREATE INDEX IF NOT EXISTS idx_commission_rules_active ON commission_rules(active, earning_type, partner_type);

CREATE TABLE IF NOT EXISTS settlements (
  id           TEXT PRIMARY KEY,
  number       TEXT NOT NULL UNIQUE,                         -- S-2026-0001
  partner_id   TEXT NOT NULL REFERENCES partners(id),
  total_paise  INTEGER NOT NULL CHECK (total_paise > 0),     -- gross commissions settled
  tds_rate_bp  INTEGER,                                      -- the rate used (NULL = none configured)
  tds_paise    INTEGER NOT NULL DEFAULT 0,
  net_paise    INTEGER NOT NULL,                             -- what was actually paid to the partner
  method       TEXT NOT NULL CHECK (method IN ('bank_transfer', 'upi', 'other')),
  reference    TEXT NOT NULL UNIQUE,                         -- bank/UPI reference; one payout cannot be recorded twice
  recorded_by  TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_settlements_partner ON settlements(partner_id, created_at);

CREATE TABLE IF NOT EXISTS commissions (
  id                    TEXT PRIMARY KEY,
  partner_id            TEXT NOT NULL REFERENCES partners(id),
  lead_id               TEXT REFERENCES leads(id),
  order_id              TEXT NOT NULL REFERENCES orders(id),
  rule_id               TEXT REFERENCES commission_rules(id),
  rule_snapshot_json    TEXT NOT NULL,                       -- the terms as they were when this was created
  earning_type          TEXT NOT NULL,
  base_paise            INTEGER NOT NULL,                    -- qualifying value of the order at creation
  original_amount_paise INTEGER NOT NULL CHECK (original_amount_paise > 0),
  amount_paise          INTEGER NOT NULL CHECK (amount_paise >= 0),   -- current, after refund adjustments
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'payable', 'paid', 'reversed', 'disputed')),
  prior_status          TEXT,                                -- where a disputed commission goes back to
  dispute_reason        TEXT,
  reversed_reason       TEXT,
  hold_until            INTEGER,                             -- set on approval
  approved_by           TEXT,
  approved_at           INTEGER,
  settlement_id         TEXT REFERENCES settlements(id),
  created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (order_id, earning_type)                            -- an order earns each kind of commission once, for one partner
);
CREATE INDEX IF NOT EXISTS idx_commissions_partner ON commissions(partner_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_commissions_status ON commissions(status, hold_until);
CREATE INDEX IF NOT EXISTS idx_commissions_settlement ON commissions(settlement_id);

CREATE TABLE IF NOT EXISTS commission_adjustments (
  id            TEXT PRIMARY KEY,
  commission_id TEXT NOT NULL REFERENCES commissions(id),
  kind          TEXT NOT NULL CHECK (kind IN ('refund_partial', 'refund_full', 'refund_after_payment', 'dispute', 'manual')),
  delta_paise   INTEGER NOT NULL,                            -- negative reduces the commission
  reason        TEXT,
  actor         TEXT NOT NULL,                               -- admin email, partner user id or 'system'
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_commission_adjustments_c ON commission_adjustments(commission_id, created_at);
