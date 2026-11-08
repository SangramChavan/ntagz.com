-- 0022: partner network core. Additive only; nothing existing is touched.
-- Money is integer paise. Fees and tax are HQ-configurable data, not code. See docs/platform/CONTRACTS.md sections 1 and 5.
--
-- Privacy: full PAN and other ID numbers are NOT stored in these tables. Only the last four characters and a keyed hash (for duplicate
-- detection) are kept; the document image lives in the private R2 bucket under `partner_documents.r2_key`.

CREATE TABLE IF NOT EXISTS partner_types (
  key           TEXT PRIMARY KEY,                          -- 'flex', 'smile', ...
  label         TEXT NOT NULL,
  role_key      TEXT NOT NULL REFERENCES roles(key),
  fee_paise     INTEGER NOT NULL CHECK (fee_paise >= 0),   -- proposed joining fee, HQ editable
  gst_rate_bp   INTEGER,                                   -- basis points; NULL = HQ has not decided (owner decision O5). Never guessed here
  active        INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 0,
  config_json   TEXT,                                      -- eligibility, onboarding requirements, flags (HQ editable)
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS partners (
  id             TEXT PRIMARY KEY,
  partner_code   TEXT UNIQUE,                              -- 'NTZ-FLX-0001', issued at approval
  user_id        TEXT NOT NULL UNIQUE REFERENCES users(id),
  type_key       TEXT NOT NULL REFERENCES partner_types(key),
  status         TEXT NOT NULL DEFAULT 'approved'
                 CHECK (status IN ('approved', 'agreement_pending', 'payment_pending', 'onboarding', 'active', 'suspended', 'terminated')),
  business_name  TEXT NOT NULL,
  business_type  TEXT,
  gstin          TEXT,
  pan_last4      TEXT,
  pan_hash       TEXT UNIQUE,                              -- HMAC of the PAN (secret in env), blocks duplicate partners
  city           TEXT,
  state          TEXT,
  pincode        TEXT,
  region         TEXT,                                     -- for Regional Manager scope
  approved_by    TEXT,
  approved_at    INTEGER,
  activated_at   INTEGER,
  suspended_at   INTEGER,
  suspend_reason TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_partners_status ON partners(status, type_key);
CREATE INDEX IF NOT EXISTS idx_partners_region ON partners(region);

CREATE TABLE IF NOT EXISTS partner_applications (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  type_key        TEXT NOT NULL REFERENCES partner_types(key),
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'submitted', 'under_review', 'documents_required', 'approved', 'rejected')),
  form_json       TEXT NOT NULL DEFAULT '{}',              -- the multi-step answers (no raw ID numbers)
  business_name   TEXT,
  city            TEXT,
  state           TEXT,
  pincode         TEXT,
  pan_last4       TEXT,
  pan_hash        TEXT,
  submitted_at    INTEGER,
  reviewed_by     TEXT,
  reviewed_at     INTEGER,
  decision_note   TEXT,                                    -- shown to the applicant on rejection / documents_required
  partner_id      TEXT REFERENCES partners(id),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
-- One open application per person; a rejected one can be followed by a new one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_app_open ON partner_applications(user_id)
  WHERE status IN ('draft', 'submitted', 'under_review', 'documents_required');
CREATE INDEX IF NOT EXISTS idx_partner_app_status ON partner_applications(status, submitted_at);

CREATE TABLE IF NOT EXISTS partner_documents (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES partner_applications(id) ON DELETE CASCADE,
  partner_id     TEXT REFERENCES partners(id),
  doc_type       TEXT NOT NULL CHECK (doc_type IN ('pan', 'gst_certificate', 'address_proof', 'shop_photo', 'bank_proof', 'other')),
  r2_key         TEXT NOT NULL,                            -- private bucket key; never a public URL
  mime           TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL CHECK (size_bytes > 0),
  status         TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'accepted', 'rejected')),
  reviewed_by    TEXT,
  note           TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_partner_docs_app ON partner_documents(application_id);

CREATE TABLE IF NOT EXISTS partner_agreements (
  id          TEXT PRIMARY KEY,
  partner_id  TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  version     TEXT NOT NULL,                               -- template version, legal review owned by the owner (O5)
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'expired', 'terminated')),
  sent_at     INTEGER,
  signed_at   INTEGER,
  signed_ip   TEXT,
  doc_r2_key  TEXT,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_partner_agreements_partner ON partner_agreements(partner_id, status);

-- The five partner types. Fees are the proposed amounts; gst_rate_bp is intentionally NULL until the owner decides (see PHASE0-REPORT O5).
INSERT OR IGNORE INTO partner_types (key, label, role_key, fee_paise, sort) VALUES
  ('360',        'Ntagz360 Partner',    'partner_360',        9999900, 1),
  ('enterprise', 'Ntagz Enterprise Partner', 'partner_enterprise', 4999900, 2),
  ('flex',       'Ntagz Flex Partner',  'partner_flex',       2499900, 3),
  ('smile',      'Ntagz Smile Partner', 'partner_smile',      1999900, 4),
  ('smile_plus', 'Ntagz Smile+ Partner','partner_smile_plus',  999900, 5);
