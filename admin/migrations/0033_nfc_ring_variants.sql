-- New products: NFC Ring in black and white, sizes 9 and 10 (replaces the single 'nfc-ring' listing in code).
-- ADDITIVE (four INSERTs). Price Rs 399 ex-GST = 39900 paise. built_in = 1: also listed in functions/lib/pricing.js and js/catalog.js.
-- Rollback: UPDATE products SET active = 0 WHERE id LIKE 'nfc-ring-%';  (orders may reference them, so never DELETE)
INSERT INTO products (id, sku, name, description, category, image_url, price_paise, unit, all_inclusive, built_in, track_stock, active)
VALUES
  ('nfc-ring-black-9',  'NR-B9',  'NFC Ring — Black, Size 9',  'Stainless steel NFC ring with a black centre band, size 9.', 'nfc', 'images/nfc-ring-black.jpg', 39900, 'pc', 0, 1, 0, 1),
  ('nfc-ring-black-10', 'NR-B10', 'NFC Ring — Black, Size 10', 'Stainless steel NFC ring with a black centre band, size 10.', 'nfc', 'images/nfc-ring-black.jpg', 39900, 'pc', 0, 1, 0, 1),
  ('nfc-ring-white-9',  'NR-W9',  'NFC Ring — White, Size 9',  'Stainless steel NFC ring with a white NFC-printed band, size 9.', 'nfc', 'images/nfc-ring-white.jpg', 39900, 'pc', 0, 1, 0, 1),
  ('nfc-ring-white-10', 'NR-W10', 'NFC Ring — White, Size 10', 'Stainless steel NFC ring with a white NFC-printed band, size 10.', 'nfc', 'images/nfc-ring-white.jpg', 39900, 'pc', 0, 1, 0, 1);
