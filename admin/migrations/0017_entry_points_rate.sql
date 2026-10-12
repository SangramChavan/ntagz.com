-- Entry earning rate fix. Until now pts_earn_per_100 = 5 while the first paid tier (Silver) pays 3, so a member earned 5
-- points per ₹100 and then DROPPED to 3 once their qualifying spend reached ₹5,000 — the ladder ran backwards. Set the flat
-- rate to 3 (Silver's rate) so earning only ever goes up: 3 to start, 5 at Gold (₹25,000), 10 at Diamond (₹50,000).
-- Data-only and idempotent: it touches the known-old value only, so an admin's own choice is never overwritten.
-- Rollback: set membership_config.pts_earn_per_100 back to '5' (Admin → Membership → Settings).
UPDATE membership_config SET value = '3' WHERE key = 'pts_earn_per_100' AND value = '5';
