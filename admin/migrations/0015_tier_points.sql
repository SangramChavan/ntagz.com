-- Tier-based points rates. ADDITIVE; tier DISCOUNTS (loyalty_live) stay as they are, off by default.
-- loyalty_tiers.points_per_100: points a member earns per Rs 100 of eligible spend while in this tier. NULL = use the flat pts_earn_per_100.
-- orders/checkout_intents.points_rate_x100: that rate (x100, integer) FROZEN when the order is priced; NULL = pre-0015 order (flat rate).
-- Rollback: code ignoring these columns keeps working; leave them in place.
ALTER TABLE loyalty_tiers ADD COLUMN points_per_100 REAL CHECK (points_per_100 IS NULL OR (points_per_100 >= 0 AND points_per_100 <= 100));
ALTER TABLE orders ADD COLUMN points_rate_x100 INTEGER;
ALTER TABLE checkout_intents ADD COLUMN points_rate_x100 INTEGER;

-- Default programme: Silver Rs 5,000 / Gold Rs 25,000 / Diamond Rs 50,000 at 3 / 5 / 10 points per Rs 100 (1 point = Rs 1 via pts_value_paise).
-- Only tiers still at their original seeded values are touched, so an admin's own edits are never overwritten.
UPDATE loyalty_tiers SET min_spend_paise = 500000,  discount_pct = 0, points_per_100 = 3, perks = '3 points per ₹100', updated_at = unixepoch() WHERE id = 'silver'   AND min_spend_paise = 100000  AND discount_pct = 3;
UPDATE loyalty_tiers SET min_spend_paise = 2500000, discount_pct = 0, points_per_100 = 5, perks = '5 points per ₹100', updated_at = unixepoch() WHERE id = 'gold'     AND min_spend_paise = 300000  AND discount_pct = 5;
UPDATE loyalty_tiers SET active = 0, updated_at = unixepoch() WHERE id = 'platinum' AND min_spend_paise = 1000000 AND discount_pct = 8
  AND EXISTS (SELECT 1 FROM loyalty_tiers WHERE id = 'gold' AND points_per_100 = 5);
INSERT OR IGNORE INTO loyalty_tiers (id, name, min_spend_paise, discount_pct, points_per_100, sort_order, perks)
  SELECT 'diamond', 'Diamond', 5000000, 0, 10, 3, '10 points per ₹100' WHERE EXISTS (SELECT 1 FROM loyalty_tiers WHERE id = 'platinum' AND active = 0);
-- Cached tier per user is history only; prices/points re-derive it. Clear so the log re-syncs on the next order.
UPDATE users SET loyalty_tier_id = NULL WHERE loyalty_tier_id IN ('silver', 'gold', 'platinum');
