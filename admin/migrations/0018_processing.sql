-- Priority custom-order processing. Every order is made to order, so every order carries a processing
-- target in WORKING days and the date it is promised to dispatch. A paid member's order is prioritised
-- (fewer working days); priority is granted only after a verified payment, never from the cart alone.
-- ADDITIVE ONLY. The business calendar is admin-owned (membership_config); the defaults below make the
-- promise calculable immediately and can be edited from the admin. Rollback: the columns are inert if left
-- in place; the code falls back to "no promise" when they are absent.
--   orders.processing_target_days   working days granted to this order (frozen at payment)
--   orders.priority_build           1 when the member priority shortened it, else 0
--   orders.promised_dispatch        YYYY-MM-DD the order is promised to dispatch (working-day date)
-- checkout_intents mirrors the target+priority so what the customer was shown is what the order gets.
ALTER TABLE orders ADD COLUMN processing_target_days INTEGER;
ALTER TABLE orders ADD COLUMN priority_build INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN promised_dispatch TEXT;
ALTER TABLE checkout_intents ADD COLUMN processing_target_days INTEGER;
ALTER TABLE checkout_intents ADD COLUMN priority_build INTEGER NOT NULL DEFAULT 0;

-- Business calendar + dispatch targets. INSERT OR IGNORE so re-running never overwrites an admin's choice.
INSERT OR IGNORE INTO membership_config (key, value) VALUES
  ('business_timezone', 'Asia/Kolkata'),
  ('business_days', '1,2,3,4,5'),
  ('business_holidays', ''),
  ('business_cutoff', '14:00'),
  ('dispatch_days_standard', '3'),
  ('dispatch_days_member', '1');
