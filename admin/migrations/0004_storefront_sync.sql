-- Storefront sync: let each product opt in to stock enforcement at checkout. Off by default, so the all-zero seeded stock
-- never blocks sales; turn it on per product in the admin after the first stock count.
ALTER TABLE products ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 0;
