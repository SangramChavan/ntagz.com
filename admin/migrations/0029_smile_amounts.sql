-- Opening stock order amounts: Smile+ gets more than Smile (setup work and service revenue on top of the same retail stock),
-- so it should start larger. The seeded values were the wrong way round: Smile 19,999 / Smile+ 9,999.
-- Guarded on the seeded values so an amount HQ has already changed by hand is never overwritten.
-- No Smile or Smile+ application or partner existed when this was written (checked 2026-11-08).
UPDATE partner_types SET fee_paise = 999900,  updated_at = unixepoch() WHERE key = 'smile'      AND fee_paise = 1999900;
UPDATE partner_types SET fee_paise = 1999900, updated_at = unixepoch() WHERE key = 'smile_plus' AND fee_paise = 999900;
