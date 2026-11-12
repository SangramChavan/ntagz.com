-- Admin-editable domestic minimum order quantity. NULL = use the checkout default (functions/lib/pricing.js PRODUCTS[id].moq, else 10).
ALTER TABLE products ADD COLUMN moq INTEGER CHECK (moq IS NULL OR (moq >= 1 AND moq <= 100000));
