-- ntagz D1 schema
-- Run: npx wrangler d1 execute ntagz-db --file=db/schema.sql --remote

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT,
  phone       TEXT,
  gstin       TEXT,
  loyalty_spend INTEGER DEFAULT 0, -- total paid in paise (₹×100)
  loyalty_tier  TEXT DEFAULT 'standard', -- 'standard' | 'pro'
  created_at  INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS otp_tokens (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  otp         TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used        INTEGER DEFAULT 0,
  created_at  INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS addresses (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT DEFAULT 'Address',
  name        TEXT,
  phone       TEXT,
  line1       TEXT,
  city        TEXT,
  state       TEXT,
  pincode     TEXT,
  is_default  INTEGER DEFAULT 0,
  created_at  INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id),  -- NULL = guest
  txn_id      TEXT UNIQUE NOT NULL,
  gateway     TEXT NOT NULL,              -- 'razorpay' | 'payu'
  status      TEXT DEFAULT 'confirmed',   -- 'confirmed' | 'shipped' | 'delivered'
  quote_ref   TEXT,
  items_json  TEXT NOT NULL DEFAULT '[]',
  name        TEXT,
  phone       TEXT,
  email       TEXT,
  address     TEXT,
  pincode     TEXT,
  state       TEXT,
  gstin       TEXT,
  subtotal    INTEGER DEFAULT 0,          -- paise
  gst         INTEGER DEFAULT 0,          -- paise
  total       INTEGER DEFAULT 0,          -- paise
  tracking_id TEXT,
  courier     TEXT,
  created_at  INTEGER DEFAULT (unixepoch()),
  updated_at  INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_sessions_user     ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_addresses_user    ON addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user       ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_txn        ON orders(txn_id);
CREATE INDEX IF NOT EXISTS idx_otp_email         ON otp_tokens(email);
