-- 0025: leads (partner-registered prospects) and their activity log. Additive only.
-- Ownership rule: one OPEN lead per phone number across the whole network (partial unique index). The first partner to register a number owns it until
-- the lead is won or lost; a second partner registering the same number is refused without being told who owns it. HQ sees the attempt in the audit log.
-- 'quotation' is in the status list now (the quotations module uses it) because SQLite cannot change a CHECK constraint without rebuilding the table.
-- A lead becomes 'won' only when HQ links a real order (attribution for commissions); partners can never set won.

CREATE TABLE IF NOT EXISTS leads (
  id            TEXT PRIMARY KEY,
  partner_id    TEXT NOT NULL REFERENCES partners(id),
  created_by    TEXT NOT NULL,                              -- user id (partner) or admin email (HQ)
  source        TEXT NOT NULL DEFAULT 'partner' CHECK (source IN ('partner', 'hq')),
  business_name TEXT NOT NULL,
  contact_name  TEXT NOT NULL,
  phone         TEXT NOT NULL,                              -- 10 digits, normalised
  email         TEXT,
  city          TEXT,
  state         TEXT,
  pincode       TEXT,
  interest      TEXT,                                       -- what they want, in the partner's words
  est_quantity  INTEGER CHECK (est_quantity IS NULL OR est_quantity > 0),
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'quotation', 'won', 'lost')),
  lost_reason   TEXT,
  order_id      TEXT REFERENCES orders(id),                 -- set when won
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  closed_at     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_open_phone ON leads(phone) WHERE status IN ('new', 'contacted', 'qualified', 'quotation');
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_order ON leads(order_id) WHERE order_id IS NOT NULL;   -- an order can be credited to one lead only
CREATE INDEX IF NOT EXISTS idx_leads_partner ON leads(partner_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status, created_at);

CREATE TABLE IF NOT EXISTS lead_activities (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  actor      TEXT NOT NULL,                                 -- user id or admin email
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('partner', 'hq', 'system')),
  kind       TEXT NOT NULL CHECK (kind IN ('created', 'note', 'call', 'visit', 'status', 'assign')),
  body       TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities(lead_id, created_at);
