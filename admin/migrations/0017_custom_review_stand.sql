-- New product: Custom Google Review NFC + QR Stand, 10x10 cm, Rs 2,000 including GST. ADDITIVE (one INSERT).
-- price_paise holds the all-inclusive price because all_inclusive = 1 (same convention as the other review stands).
-- built_in = 1: it is also listed in functions/lib/pricing.js PRODUCTS and js/catalog.js, so it can be deactivated but not deleted.
-- Sold singly, so its minimum order is 1 (moq lives in those two code tables, not in the database).
-- Rollback: UPDATE products SET active = 0 WHERE id = 'google-review-nfc-qr-stand-custom-10x10';  (orders may reference it, so never DELETE)
INSERT INTO products (id, sku, name, description, category, image_url, price_paise, unit, all_inclusive, built_in, track_stock, active)
VALUES ('google-review-nfc-qr-stand-custom-10x10', 'GRC2000', 'Custom Google Review NFC + QR Stand — 10×10 cm',
  'Custom-made 10×10 cm tabletop stand with NFC tap and a printed QR code, both pointing to your Google review link. Send us your logo and review link when you order.',
  'review', 'images/google-review-stand-12x12.jpg', 200000, 'pc', 1, 1, 0, 1);
