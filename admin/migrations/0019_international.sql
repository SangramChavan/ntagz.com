-- International customers (USD price list, shipping quotations, staged payment). ADDITIVE ONLY: no table or column is dropped and no
-- existing row is changed except by column defaults. International ordering ships OFF (membership_config.intl_enabled = '0'), so deploying
-- this changes nothing for existing customers. Every country, currency, tax and payment-mode rule below is configuration, not code.
-- Rollback / recovery: set intl_enabled = '0' (instant). The new columns/tables are harmless if left in place; never drop them while
-- international orders exist. Data loss only: D1 Time Travel to the bookmark taken before applying this migration.

-- Existing amount columns (subtotal, gst, total, paid_paise, ...) hold MINOR units of orders.currency (paise for INR, cents for USD).
ALTER TABLE orders ADD COLUMN market TEXT NOT NULL DEFAULT 'IN' CHECK (market IN ('IN', 'INTL'));
ALTER TABLE orders ADD COLUMN currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency IN ('INR', 'USD'));
ALTER TABLE orders ADD COLUMN country TEXT;
ALTER TABLE orders ADD COLUMN city TEXT;
ALTER TABLE orders ADD COLUMN company TEXT;
ALTER TABLE orders ADD COLUMN tax_id TEXT;
ALTER TABLE orders ADD COLUMN order_notes TEXT;
ALTER TABLE orders ADD COLUMN price_list TEXT;                 -- e.g. 'INTL-USD' (the list this order was priced from)
ALTER TABLE orders ADD COLUMN quote_status TEXT CHECK (quote_status IS NULL OR quote_status IN ('required', 'sent', 'accepted', 'declined', 'expired'));
ALTER TABLE orders ADD COLUMN destination_status TEXT CHECK (destination_status IS NULL OR destination_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE orders ADD COLUMN terms_version TEXT;              -- policy acknowledgement recorded at checkout
ALTER TABLE orders ADD COLUMN terms_accepted_at INTEGER;
ALTER TABLE orders ADD COLUMN pay_link_url TEXT;               -- a payment link an admin attached for the outstanding balance
ALTER TABLE orders ADD COLUMN pay_link_minor INTEGER;
ALTER TABLE orders ADD COLUMN pay_link_at INTEGER;
ALTER TABLE orders ADD COLUMN dispatch_override_reason TEXT;   -- set only when an admin deliberately ships before payment/approval
CREATE INDEX idx_orders_market ON orders(market, quote_status, created_at);
CREATE INDEX idx_orders_country ON orders(country);

ALTER TABLE payments ADD COLUMN currency TEXT NOT NULL DEFAULT 'INR';
-- Domestic rule kept exactly (one manual payment per INR order); international orders may take several staged manual payments.
DROP INDEX IF EXISTS uq_payments_one_manual;
CREATE UNIQUE INDEX uq_payments_one_manual ON payments(order_id) WHERE recorded_by <> 'gateway' AND currency = 'INR';
ALTER TABLE order_refunds ADD COLUMN currency TEXT NOT NULL DEFAULT 'INR';

-- Configurable destinations. Postal/region rules are data, so no country logic is hardcoded in the app.
CREATE TABLE intl_countries (
  code            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  dial_code       TEXT NOT NULL,
  region_label    TEXT NOT NULL DEFAULT 'State / Province / Region',
  region_required INTEGER NOT NULL DEFAULT 0 CHECK (region_required IN (0, 1)),
  postal_label    TEXT NOT NULL DEFAULT 'Postal code',
  postal_required INTEGER NOT NULL DEFAULT 1 CHECK (postal_required IN (0, 1)),
  postal_regex    TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0
);
-- A starter list for the owner to review (destination eligibility, export controls and sanctions are a business/legal decision).
-- India is the domestic market and is deliberately not here. Countries not listed are handled as "contact us".
INSERT INTO intl_countries (code, name, dial_code, region_label, region_required, postal_label, postal_required, postal_regex, sort_order) VALUES
 ('US','United States','+1','State',1,'ZIP code',1,'^\d{5}(-\d{4})?$',10),
 ('CA','Canada','+1','Province / Territory',1,'Postal code',1,'^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$',11),
 ('GB','United Kingdom','+44','County (optional)',0,'Postcode',1,'^[A-Za-z]{1,2}\d[A-Za-z\d]?\s?\d[A-Za-z]{2}$',12),
 ('AU','Australia','+61','State / Territory',1,'Postcode',1,'^\d{4}$',13),
 ('NZ','New Zealand','+64','Region (optional)',0,'Postcode',1,'^\d{4}$',14),
 ('IE','Ireland','+353','County (optional)',0,'Eircode',0,'^[A-Za-z\d]{3}\s?[A-Za-z\d]{4}$',15),
 ('DE','Germany','+49','State (optional)',0,'Postcode',1,'^\d{5}$',20),
 ('FR','France','+33','Region (optional)',0,'Postcode',1,'^\d{5}$',21),
 ('IT','Italy','+39','Province (optional)',0,'Postcode',1,'^\d{5}$',22),
 ('ES','Spain','+34','Province (optional)',0,'Postcode',1,'^\d{5}$',23),
 ('NL','Netherlands','+31','Province (optional)',0,'Postcode',1,'^\d{4}\s?[A-Za-z]{2}$',24),
 ('SE','Sweden','+46','County (optional)',0,'Postcode',1,'^\d{3}\s?\d{2}$',25),
 ('CH','Switzerland','+41','Canton (optional)',0,'Postcode',1,'^\d{4}$',26),
 ('AE','United Arab Emirates','+971','Emirate',1,'PO box / postal code (optional)',0,NULL,30),
 ('SA','Saudi Arabia','+966','Region (optional)',0,'Postal code',1,'^\d{5}$',31),
 ('QA','Qatar','+974','Municipality (optional)',0,'Postal code (optional)',0,NULL,32),
 ('OM','Oman','+968','Governorate (optional)',0,'Postal code (optional)',0,NULL,33),
 ('KW','Kuwait','+965','Governorate (optional)',0,'Postal code (optional)',0,NULL,34),
 ('BH','Bahrain','+973','Governorate (optional)',0,'Postal code (optional)',0,NULL,35),
 ('SG','Singapore','+65','Region (optional)',0,'Postal code',1,'^\d{6}$',40),
 ('MY','Malaysia','+60','State',1,'Postcode',1,'^\d{5}$',41),
 ('JP','Japan','+81','Prefecture',1,'Postal code',1,'^\d{3}-?\d{4}$',42),
 ('KR','South Korea','+82','Province / City',1,'Postal code',1,'^\d{5}$',43),
 ('LK','Sri Lanka','+94','Province (optional)',0,'Postal code',1,'^\d{5}$',50),
 ('NP','Nepal','+977','Province (optional)',0,'Postal code',1,'^\d{5}$',51),
 ('BD','Bangladesh','+880','Division (optional)',0,'Postcode',1,'^\d{4}$',52),
 ('ZA','South Africa','+27','Province',1,'Postal code',1,'^\d{4}$',60),
 ('KE','Kenya','+254','County (optional)',0,'Postal code (optional)',0,NULL,61),
 ('NG','Nigeria','+234','State',1,'Postal code (optional)',0,NULL,62);

INSERT OR IGNORE INTO membership_config (key, value) VALUES
  ('intl_enabled', '0'),                                      -- master switch for the international storefront
  ('intl_payment_mode', 'manual_link'),                       -- 'none' (no payment instructions yet) | 'manual_link' (admin attaches a provider link / records verified payments)
  ('intl_quote_valid_days', '7'),
  ('intl_paylink_hosts', 'rzp.io,razorpay.com,paypal.com,paypal.me,stripe.com,wise.com'),
  ('intl_terms_version', '2026-10-16');

-- Per-product international data (all optional; a product is sold internationally only when intl_enabled = 1 AND a USD price exists).
ALTER TABLE products ADD COLUMN price_usd_cents INTEGER CHECK (price_usd_cents IS NULL OR price_usd_cents > 0);
ALTER TABLE products ADD COLUMN intl_enabled INTEGER NOT NULL DEFAULT 0 CHECK (intl_enabled IN (0, 1));
ALTER TABLE products ADD COLUMN intl_moq INTEGER CHECK (intl_moq IS NULL OR intl_moq > 0);
ALTER TABLE products ADD COLUMN intl_lead_days INTEGER CHECK (intl_lead_days IS NULL OR (intl_lead_days >= 0 AND intl_lead_days <= 365));
ALTER TABLE products ADD COLUMN intl_custom_quote INTEGER NOT NULL DEFAULT 0 CHECK (intl_custom_quote IN (0, 1));
ALTER TABLE products ADD COLUMN weight_g INTEGER CHECK (weight_g IS NULL OR weight_g > 0);
ALTER TABLE products ADD COLUMN dims_mm TEXT;                -- e.g. '86x54x0.8' (informational, for the shipping quote)
ALTER TABLE products ADD COLUMN intl_tax_treatment TEXT NOT NULL DEFAULT 'excl' CHECK (intl_tax_treatment IN ('excl', 'incl', 'quoted'));
-- Quantity breaks for the USD list: the unit price at or above each minimum quantity.
CREATE TABLE product_intl_tiers (
  product_id TEXT NOT NULL REFERENCES products(id),
  min_qty    INTEGER NOT NULL CHECK (min_qty > 1),
  unit_cents INTEGER NOT NULL CHECK (unit_cents > 0),
  PRIMARY KEY (product_id, min_qty)
);

-- Shipping quotations. A new quote supersedes the previous one; acceptance is an explicit customer (or recorded admin) action.
CREATE TABLE intl_quotes (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES orders(id),
  version        INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('sent', 'accepted', 'declined', 'expired', 'superseded')),
  currency       TEXT NOT NULL,
  products_minor INTEGER NOT NULL CHECK (products_minor >= 0),
  shipping_minor INTEGER NOT NULL CHECK (shipping_minor >= 0),
  taxes_minor    INTEGER NOT NULL DEFAULT 0 CHECK (taxes_minor >= 0),
  other_minor    INTEGER NOT NULL DEFAULT 0 CHECK (other_minor >= 0),
  total_minor    INTEGER NOT NULL,
  quote_type     TEXT NOT NULL CHECK (quote_type IN ('product_only', 'product_shipping', 'product_shipping_taxes')),
  carrier        TEXT,
  method         TEXT,
  est_from       TEXT,
  est_to         TEXT,
  expires_at     INTEGER NOT NULL,
  charges_note   TEXT,
  note           TEXT,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  decided_at     INTEGER,
  decided_by     TEXT,                                   -- 'customer' or the admin who recorded an offline decision
  decision_note  TEXT,
  UNIQUE (order_id, version)
);
CREATE INDEX idx_quotes_order ON intl_quotes(order_id, version);

-- International enquiries (bulk, custom, shipping-quote requests).
CREATE TABLE intl_enquiries (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  country       TEXT NOT NULL,
  company       TEXT,
  product       TEXT,
  quantity      TEXT,
  customization TEXT,
  shipping_pref TEXT,
  message       TEXT,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'closed')),
  notes         TEXT,
  ip_hash       TEXT,
  handled_by    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_enq_status ON intl_enquiries(status, created_at);
CREATE INDEX idx_enq_ip ON intl_enquiries(ip_hash, created_at);

-- Payment-provider webhook events already processed: a retried or replayed delivery is recognised and ignored.
CREATE TABLE provider_events (
  provider   TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  type       TEXT NOT NULL,
  order_id   TEXT,
  outcome    TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (provider, event_id)
);
