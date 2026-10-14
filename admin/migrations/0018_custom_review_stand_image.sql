-- Product image for the Custom Google Review NFC + QR Stand (GRC2000). 0017 seeded the 12x12 photo as a placeholder.
-- Additive, one UPDATE; 0017 is already applied in production so it is left untouched.
-- Rollback: UPDATE products SET image_url = 'images/google-review-stand-12x12.jpg' WHERE id = 'google-review-nfc-qr-stand-custom-10x10';
UPDATE products SET image_url = 'images/custom-google-review-stand-10x10.png', updated_at = unixepoch() WHERE id = 'google-review-nfc-qr-stand-custom-10x10';
