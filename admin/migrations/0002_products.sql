-- Product catalogue + inventory for the admin. Additive: does not touch orders, payments or existing tables.
-- The public storefront still prices from js/catalog.js; see README ("Storefront sync") before relying on admin prices there.

CREATE TABLE products (
  id                  TEXT PRIMARY KEY,                 -- same slug as js/catalog.js ids (order line items reference these)
  sku                 TEXT NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  category            TEXT NOT NULL DEFAULT 'nfc',
  image_url           TEXT,
  price_paise         INTEGER NOT NULL CHECK (price_paise >= 0),   -- selling price, ex-GST
  mrp_paise           INTEGER CHECK (mrp_paise IS NULL OR mrp_paise >= 0),
  gst_rate            INTEGER NOT NULL DEFAULT 18 CHECK (gst_rate IN (0,5,12,18,28)),
  all_inclusive       INTEGER NOT NULL DEFAULT 0,       -- 1 = price already includes GST + shipping (catalog.js allInclusive)
  unit                TEXT NOT NULL DEFAULT 'pc',
  stock_qty           INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 10 CHECK (low_stock_threshold >= 0),
  active              INTEGER NOT NULL DEFAULT 1,       -- archive instead of delete: orders and history reference products
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX uq_products_sku ON products(lower(sku));
CREATE INDEX idx_products_updated ON products(updated_at);
CREATE INDEX idx_products_cat ON products(category, active);

CREATE TABLE inventory_movements (
  id              TEXT PRIMARY KEY,
  product_id      TEXT NOT NULL REFERENCES products(id),
  type            TEXT NOT NULL CHECK (type IN ('opening','in','out','set')),
  qty_change      INTEGER NOT NULL,                     -- signed
  prev_stock      INTEGER NOT NULL,
  new_stock       INTEGER NOT NULL,
  reason          TEXT NOT NULL,
  reference       TEXT,                                 -- supplier / purchase ref / order id
  notes           TEXT,
  admin           TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (product_id, idempotency_key)
);
CREATE INDEX idx_movements_product ON inventory_movements(product_id, created_at);

-- Seeds the admin product table from js/catalog.js (17 products at time of writing). INSERT OR IGNORE, so re-running
-- never overwrites edits. Prices are ex-GST paise, matching catalog.js. Stock starts at 0: do a first count with "Set actual stock".
INSERT OR IGNORE INTO products (id, sku, name, description, category, image_url, price_paise, unit, all_inclusive) VALUES
  ('sample-kit', 'SMPL', 'Complete NFC Sample Kit', 'Ten pieces of every product in one box — black card, white card, anti-metal tag, adhesive tag, coin, mini tag and micro flex. Test before committing to a bulk run.', 'sample', 'images/black-nfc-card.png', 194000, 'kit', 0),
  ('black-nfc-card', 'BNC30', 'Black NFC 215 Card', 'Premium blank black PVC card with an NTAG215 chip. Built for UV printing and high-end digital business cards.', 'nfc', 'images/black-nfc-card.png', 3000, 'card', 0),
  ('white-nfc-card', 'WNC25', 'PVC NFC Business Card NTAG216', 'Blank white PVC card with the high-capacity NTAG216 chip. Ideal for corporate ID and full-colour sublimation printing.', 'nfc', 'images/white-nfc-card.jpeg', 2500, 'card', 0),
  ('white-inkjet-nfc-card', 'WBC33', 'White Inkjet NTAG215 Card', 'Inkjet-printable white PVC card with NTAG215, compatible with Epson L8050 and other PVC-tray card printers.', 'nfc', 'images/white-nfc-card.jpeg', 3280, 'card', 0),
  ('google-review-nfc-card', 'GRV95', 'Google Review NFC Card', 'Printed and pre-programmed review card — one tap opens your Google review form. Supplied ready to place on a counter.', 'review', 'images/google-review-card.jpg', 9500, 'card', 0),
  ('google-review-nfc-stand-5x5', 'GRS99', 'Google Review NFC Stand — 5×5 cm (NFC only)', 'Tap-to-review counter stand, 5×5 cm, NFC only. Pre-programmed with your Google review link before dispatch.', 'review', 'images/google-review-stand-10x10.jpg', 9900, 'pc', 1),
  ('google-review-nfc-stand-10x10', 'GRS150', 'Google Review NFC Stand — 9×9 cm (NFC only)', 'Tap-to-review counter stand, 9×9 cm, NFC only. Pre-programmed with your Google review link before dispatch.', 'review', 'images/google-review-stand-10x10.jpg', 14900, 'pc', 1),
  ('google-review-nfc-stand-12x12', 'GRQ200', 'Google Review NFC + QR Stand — 12×12 cm', 'Tap-to-review counter stand, 12×12 cm, NFC plus a printed QR fallback for phones without NFC. Pre-programmed before dispatch.', 'review', 'images/google-review-stand-12x12.jpg', 19900, 'pc', 1),
  ('nfc-card-custom-printing', 'PRN75', 'NFC Card with Custom Printing', 'Send us your artwork and we print, encode and dispatch finished NFC cards. Price includes printing and programming.', 'nfc', NULL, 7500, 'card', 0),
  ('anti-metal-tag', 'MNT20', 'Anti-Metal NFC Tag', 'Ferrite-isolated tag that keeps working on metal — machinery, laptops, tool cribs and phone backs.', 'tag', 'images/anti-metal-tag.jpg', 2000, 'pc', 0),
  ('ntag216-adhesive-tag', 'RNT18', 'NTAG216 Adhesive NFC Tag', 'High-capacity 888-byte adhesive tag for asset tagging, equipment logs and commercial tracking workflows.', 'tag', 'images/nfc-adhesive-tag.jpg', 1800, 'pc', 0),
  ('nfc-coin', 'NCN20', 'NTAG 215 Coin 25mm', 'Durable 25mm coin-format tag for inventory, outdoor tracking and embedding into physical objects.', 'tag', 'images/nfc-coin.jpeg', 2000, 'pc', 0),
  ('mini-nfc-tag', 'MNT16', 'Mini NFC Tag (3D Printing / Jewellery)', 'Ultra-compact tag for embedding into 3D prints, custom jewellery, smart rings and discreet packaging.', 'tag', 'images/mini-nfc-tag.jpeg', 1600, 'pc', 0),
  ('micro-flex-fpc', 'FNT75', 'Micro Flex NFC Tag (FPC)', 'Flexible polyimide micro-tag for very tight spaces. 5x5mm, 4x10mm, 6x15mm, 8mm and 10mm variants.', 'tag', 'images/micro-flex-fpc.jpeg', 7500, 'unit', 0),
  ('nfc-wristband', 'WRB80', 'NFC Wristband', 'Reusable silicone wristband with an embedded NFC inlay — event check-in, cashless stalls and gym access.', 'tag', NULL, 8000, 'pc', 0),
  ('uhf-rfid-label', 'URL249', 'UHF RFID Label Sticker 27×15mm', 'Self-adhesive UHF label, EPC Gen2, 860–960MHz, roughly 2m read range. Reader-based only — phones cannot read it. Sold on a roll in packs of 10.', 'rfid', 'images/UHF-RFID-Label-Sticker-27x15mm.jpg', 24900, 'pack of 10', 0),
  ('rfid-card-custom-printing', 'RFP75', 'RFID Card with Custom Printing', 'RFID access or membership card printed with your artwork and encoded in-house before dispatch.', 'rfid', NULL, 7500, 'card', 0);
