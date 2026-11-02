-- Payment links. Additive only: one new table, nothing existing is touched.
-- A link is a stored cart + customer details behind an unguessable token (id). The cart is re-priced by the payments Worker every time the
-- link is opened or paid, so nothing here is a price authority. The Razorpay order is created when the customer taps Pay, not when the link
-- is made; `txn_ids` lists every gateway order made for the link so "paid" can be read from orders (no code in the payment path).
-- Workers deployed before this migration keep working (agent checkout falls back to its old link format; the admin view says "apply 0020").

CREATE TABLE IF NOT EXISTS pay_links (
  id                   TEXT PRIMARY KEY,                       -- the token in the URL: 128 random bits, hex
  source               TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'agent')),
  created_by           TEXT NOT NULL,                          -- admin email, or 'agent'
  items_json           TEXT NOT NULL,                          -- [{id, qty}] the customer will pay for (may grow via a nudge)
  orig_items_json      TEXT NOT NULL,                          -- as created: a nudge can add to a line, never go below this
  name                 TEXT NOT NULL,
  phone                TEXT NOT NULL,                          -- 10 digits
  email                TEXT,
  address              TEXT NOT NULL,
  pincode              TEXT NOT NULL,
  state                TEXT NOT NULL,
  gstin                TEXT,
  note                 TEXT,                                   -- internal, never shown to the customer
  source_order_id      TEXT,                                   -- the unpaid WhatsApp/UPI order this link replaces (admin warns to cancel it once paid)
  quoted_paise         INTEGER,                                -- the total the customer/agent was told; the page says so if the price moved
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at           INTEGER NOT NULL,
  sent_at              INTEGER,                                -- first time the admin sent it (WhatsApp)
  reminder_count       INTEGER NOT NULL DEFAULT 0,
  last_reminded_at     INTEGER,
  first_opened_at      INTEGER,
  last_opened_at       INTEGER,
  open_count           INTEGER NOT NULL DEFAULT 0,
  start_count          INTEGER NOT NULL DEFAULT 0,             -- times Pay was tapped
  txn_id               TEXT,                                   -- latest Razorpay order id
  txn_ids              TEXT NOT NULL DEFAULT '[]',             -- every Razorpay order id made for this link
  started_amount_paise INTEGER,                                -- amount of the latest gateway order
  adjust_count         INTEGER NOT NULL DEFAULT 0,             -- times the customer added quantity from a suggestion
  last_adjusted_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pay_links_created ON pay_links(created_at);
CREATE INDEX IF NOT EXISTS idx_pay_links_phone ON pay_links(phone);
CREATE INDEX IF NOT EXISTS idx_pay_links_txn ON pay_links(txn_id);
