-- 0026: quotations (a priced, frozen offer for one lead) and their lines. Additive only.
-- Prices come from the SAME engine checkout uses (functions/lib/pricing.js, guest pricing), so a quote matches what the customer would be charged.
-- The totals and every line are a SNAPSHOT taken when the quote is saved: later price changes never alter an existing quote.
-- Flow: draft -> pending_approval -> approved | rejected; approved -> sent -> accepted | declined; approved/sent -> expired by date. Partners cannot approve.

CREATE TABLE IF NOT EXISTS quotations (
  id              TEXT PRIMARY KEY,
  number          TEXT NOT NULL UNIQUE,                       -- Q-2026-0001
  lead_id         TEXT NOT NULL REFERENCES leads(id),
  partner_id      TEXT NOT NULL REFERENCES partners(id),
  created_by      TEXT NOT NULL,                              -- user id or admin email
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'sent', 'accepted', 'declined', 'expired', 'cancelled')),
  customer_name   TEXT NOT NULL,
  customer_phone  TEXT NOT NULL,
  customer_email  TEXT,
  ship_state      TEXT,                                       -- drives shipping; NULL = shipping not included
  valid_until     INTEGER NOT NULL,
  notes           TEXT,
  decision_note   TEXT,                                       -- HQ's reason when rejected
  pieces          INTEGER NOT NULL DEFAULT 0,
  subtotal_paise  INTEGER NOT NULL DEFAULT 0,                 -- list price of all lines, before discounts and GST
  discount_paise  INTEGER NOT NULL DEFAULT 0,                 -- quantity (bulk) discount
  gst_paise       INTEGER NOT NULL DEFAULT 0,
  shipping_paise  INTEGER NOT NULL DEFAULT 0,
  total_paise     INTEGER NOT NULL DEFAULT 0,                 -- what the customer pays, as checkout would charge
  approved_by     TEXT,
  approved_at     INTEGER,
  sent_at         INTEGER,
  responded_at    INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_quotations_partner ON quotations(partner_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_quotations_lead ON quotations(lead_id);

CREATE TABLE IF NOT EXISTS quotation_items (
  id               TEXT PRIMARY KEY,
  quotation_id     TEXT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_id       TEXT NOT NULL,
  name             TEXT NOT NULL,                             -- as named when quoted
  qty              INTEGER NOT NULL CHECK (qty > 0),
  unit_price_paise INTEGER NOT NULL,                          -- list price per unit when quoted
  bulk_pct         REAL NOT NULL DEFAULT 0,
  line_net_paise   INTEGER NOT NULL,                          -- after the quantity discount, before GST
  all_inclusive    INTEGER NOT NULL DEFAULT 0,                -- price already includes GST (stands)
  position         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_quotation_items_q ON quotation_items(quotation_id, position);
