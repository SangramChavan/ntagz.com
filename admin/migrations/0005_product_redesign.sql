-- Products page redesign: optional cost price, and a flag for the storefront's built-in catalogue products.
-- built_in products power the live storefront/checkout fallback, so they can be deactivated but never deleted.
ALTER TABLE products ADD COLUMN cost_paise INTEGER CHECK (cost_paise IS NULL OR cost_paise >= 0);
ALTER TABLE products ADD COLUMN built_in INTEGER NOT NULL DEFAULT 0;
UPDATE products SET built_in = 1;
CREATE INDEX idx_products_created ON products(created_at);
