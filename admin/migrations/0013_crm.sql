-- Customers / CRM. ADDITIVE ONLY: no existing table, column or row is changed or dropped. Apply BEFORE deploying code that reads it.
-- Rollback: nothing existing depends on these objects. DROP VIEW crm_customers, crm_orders and the new tables listed below to undo.
--
-- Identity (ckey): 'u:<users.id>' for a registered customer, otherwise 'g:<lower(trim(email))>' for a guest. A guest order is attached to a
-- registered customer ONLY when the order email is identical (case-insensitive) to the account email. Names and phones are never used to match.
-- Orders with neither a user nor an email have no ckey and stay out of per-customer views.

CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email));
CREATE INDEX IF NOT EXISTS idx_orders_email_lower ON orders(lower(trim(email)));

-- One row per order with the money split used by every CRM number. All money is paise.
--   counts        = 1 when the order is paid and not cancelled/returned (the only orders that are revenue)
--   gross_paise   = what was collected on a paid order (any status), refund_paise = refunds recorded against it (capped at gross)
--   net_*         = 0 unless counts=1; otherwise refund-adjusted in proportion (same rule as functions/lib/loyalty.js)
--   net_paise includes GST and shipping; net_product_paise is product value net of discounts, without GST and shipping (qualifying_paise)
CREATE VIEW crm_orders AS
SELECT x.*,
  CASE WHEN x.counts = 1 THEN x.gross_paise - x.refund_paise ELSE 0 END AS net_paise,
  CASE WHEN x.counts = 1 THEN CAST(round(x.gst * (x.gross_paise - x.refund_paise) * 1.0 / x.gross_paise) AS INTEGER) ELSE 0 END AS net_gst_paise,
  CASE WHEN x.counts = 1 THEN CAST(round(x.shipping_paise * (x.gross_paise - x.refund_paise) * 1.0 / x.gross_paise) AS INTEGER) ELSE 0 END AS net_shipping_paise,
  CASE WHEN x.counts = 1 THEN CAST(round(x.qualifying_paise * (x.gross_paise - x.refund_paise) * 1.0 / x.gross_paise) AS INTEGER) ELSE 0 END AS net_product_paise
FROM (
  SELECT o.id, o.created_at, o.status, o.payment_status, o.user_id, o.items_json, o.gst, o.shipping_paise, o.qualifying_paise, o.discount_paise,
    coalesce(o.campaign_discount_paise, 0) AS campaign_discount_paise, o.loyalty_tier,
    lower(trim(coalesce(o.email, ''))) AS email_n,
    CASE
      WHEN o.user_id IS NOT NULL THEN 'u:' || o.user_id
      WHEN trim(coalesce(o.email, '')) <> '' THEN coalesce((SELECT 'u:' || u.id FROM users u WHERE lower(u.email) = lower(trim(o.email))), 'g:' || lower(trim(o.email)))
    END AS ckey,
    CASE WHEN o.payment_status = 'paid' AND o.paid_paise > 0 AND o.status NOT IN ('cancelled', 'returned') THEN 1 ELSE 0 END AS counts,
    CASE WHEN o.payment_status = 'paid' THEN o.paid_paise ELSE 0 END AS gross_paise,
    CASE WHEN o.payment_status = 'paid' THEN min(o.refunded_paise, o.paid_paise) ELSE 0 END AS refund_paise
  FROM orders o
) x;

-- One row per customer: every registered user plus every guest email that has at least one order.
CREATE VIEW crm_customers AS
WITH agg AS (
  SELECT ckey,
    count(*) AS orders_all,
    sum(counts) AS paid_orders,
    sum(gross_paise * counts) AS gross_paise,
    sum(refund_paise * counts) AS refund_paise,
    sum(net_paise) AS net_paise,
    sum(net_product_paise) AS net_product_paise,
    min(CASE WHEN counts = 1 THEN created_at END) AS first_order_at,
    max(CASE WHEN counts = 1 THEN created_at END) AS last_order_at,
    max(created_at) AS last_any_order_at
  FROM crm_orders WHERE ckey IS NOT NULL GROUP BY ckey
)
SELECT 'u:' || u.id AS ckey, 'registered' AS type, u.id AS user_id, lower(u.email) AS email, u.name, u.phone,
  u.created_at AS first_seen_at, u.loyalty_tier_id,
  coalesce(a.orders_all, 0) AS orders_all, coalesce(a.paid_orders, 0) AS paid_orders, coalesce(a.gross_paise, 0) AS gross_paise,
  coalesce(a.refund_paise, 0) AS refund_paise, coalesce(a.net_paise, 0) AS net_paise, coalesce(a.net_product_paise, 0) AS net_product_paise,
  a.first_order_at, a.last_order_at, a.last_any_order_at
FROM users u LEFT JOIN agg a ON a.ckey = 'u:' || u.id
UNION ALL
SELECT a.ckey, 'guest', NULL, substr(a.ckey, 3),
  (SELECT o.name FROM orders o WHERE o.user_id IS NULL AND lower(trim(o.email)) = substr(a.ckey, 3) AND trim(coalesce(o.name, '')) <> '' ORDER BY o.created_at DESC LIMIT 1),
  (SELECT o.phone FROM orders o WHERE o.user_id IS NULL AND lower(trim(o.email)) = substr(a.ckey, 3) AND trim(coalesce(o.phone, '')) <> '' ORDER BY o.created_at DESC LIMIT 1),
  (SELECT min(o.created_at) FROM orders o WHERE o.user_id IS NULL AND lower(trim(o.email)) = substr(a.ckey, 3)), NULL,
  a.orders_all, coalesce(a.paid_orders, 0), coalesce(a.gross_paise, 0), coalesce(a.refund_paise, 0), coalesce(a.net_paise, 0), coalesce(a.net_product_paise, 0),
  a.first_order_at, a.last_order_at, a.last_any_order_at
FROM agg a WHERE a.ckey LIKE 'g:%';

-- ── Marketing consent (separate from having ordered) ──────────────────────────────────────────────────────────
-- Keyed by normalised email so it works for guests and registered customers alike. A row exists only after an explicit opt-in, an
-- unsubscribe, or a suppression. Customers with NO row are NOT eligible for marketing.
CREATE TABLE marketing_contacts (
  email              TEXT PRIMARY KEY,                                     -- lower(trim(email))
  user_id            TEXT,
  status             TEXT NOT NULL CHECK (status IN ('subscribed', 'unsubscribed', 'suppressed')),
  source             TEXT NOT NULL,                                        -- account_page | checkout | admin_import | unsubscribe_link | webhook ...
  policy_version     TEXT,
  consented_at       INTEGER,
  unsubscribed_at    INTEGER,
  suppression_reason TEXT CHECK (suppression_reason IS NULL OR suppression_reason IN ('bounce', 'complaint', 'manual')),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_mc_status ON marketing_contacts(status);
CREATE INDEX idx_mc_user ON marketing_contacts(user_id);

-- Append-only record of every consent change (who/what/when/which policy). Never updated or deleted by the app except by a verified erasure.
CREATE TABLE consent_log (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  action         TEXT NOT NULL,                                            -- opt_in | unsubscribe | suppress | unsuppress
  source         TEXT NOT NULL,
  policy_version TEXT,
  actor          TEXT NOT NULL,                                            -- 'customer' | admin email | 'system'
  detail         TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_consent_email ON consent_log(email, created_at);

-- ── Internal tags / notes (admin-only; never shown to customers) ───────────────────────────────────────────────
CREATE TABLE crm_tags (
  ckey       TEXT NOT NULL,
  tag        TEXT NOT NULL,
  actor      TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (ckey, tag)
);
CREATE INDEX idx_crm_tags_tag ON crm_tags(tag);
CREATE TABLE crm_notes (
  id         TEXT PRIMARY KEY,
  ckey       TEXT NOT NULL,
  body       TEXT NOT NULL,
  actor      TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_crm_notes_ckey ON crm_notes(ckey, created_at);

-- ── First-party activity events (tracked only after the visitor consents; see functions/lib/crm.js) ────────────
-- These are behavioural analytics. They are NEVER a source of revenue: money always comes from orders/payments.
CREATE TABLE crm_events (
  id           TEXT PRIMARY KEY,                -- client-generated, validated; INSERT OR IGNORE makes retries idempotent
  ts           INTEGER NOT NULL,                -- server time
  sid          TEXT NOT NULL,                   -- anonymous session id (random, rotates after 30 days)
  event        TEXT NOT NULL,
  user_id      TEXT,                            -- set by the SERVER from the signed-in session cookie, never from the request body
  product_id   TEXT,
  category     TEXT,
  path         TEXT,                            -- pathname only: no query string, no fragment
  term         TEXT,                            -- search text (trimmed, 60 chars max)
  utm_source   TEXT, utm_medium TEXT, utm_campaign TEXT,
  recipient_id TEXT                             -- campaign_recipients.id when the visit came from a campaign email
);
CREATE INDEX idx_ev_user ON crm_events(user_id, ts);
CREATE INDEX idx_ev_event ON crm_events(event, ts);
CREATE INDEX idx_ev_sid ON crm_events(sid, ts);
CREATE INDEX idx_ev_ts ON crm_events(ts);

-- ── Saved segments ───────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE crm_segments (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  rules_json    TEXT NOT NULL,                  -- {op:'and'|'or', rules:[{field,cmp,value}]}; validated against a fixed field list
  archived      INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_count    INTEGER,
  last_eligible INTEGER,
  last_eval_at  INTEGER
);

-- ── Campaigns ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE campaigns (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  subject       TEXT NOT NULL DEFAULT '',
  preview_text  TEXT NOT NULL DEFAULT '',
  body_json     TEXT NOT NULL DEFAULT '{}',     -- {template, heading, body, products:[id], cta:{label, path}, offer:{...}}
  segment_id    TEXT REFERENCES crm_segments(id),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed')),
  scheduled_at  INTEGER,
  send_limit    INTEGER,                        -- campaign-level cap on recipients
  utm_campaign  TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at    INTEGER,
  finished_at   INTEGER,
  eligible_at_send INTEGER                      -- audience size frozen when sending started
);
CREATE INDEX idx_campaigns_status ON campaigns(status, scheduled_at);

-- One row per (campaign, email): the unique key is what makes sending twice impossible. id doubles as the unguessable click-attribution token.
CREATE TABLE campaign_recipients (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id),
  email        TEXT NOT NULL,
  user_id      TEXT,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'skipped')),
  provider_id  TEXT,                            -- email provider message id
  detail       TEXT,                            -- skip/fail reason; never contains secrets
  attempts     INTEGER NOT NULL DEFAULT 0,
  sent_at      INTEGER, delivered_at INTEGER, bounced_at INTEGER, complained_at INTEGER, clicked_at INTEGER, click_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (campaign_id, email)
);
CREATE INDEX idx_cr_campaign ON campaign_recipients(campaign_id, status);
CREATE INDEX idx_cr_provider ON campaign_recipients(provider_id);
CREATE INDEX idx_cr_email ON campaign_recipients(email);

-- Webhook idempotency (provider message id + event type).
CREATE TABLE email_webhook_events (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ── Automated journeys (small scheduler, not a workflow engine) ────────────────────────────────────────────────
CREATE TABLE journeys (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('welcome', 'abandoned_cart', 'first_purchase', 'membership_milestone', 'repeat_reminder', 'reengagement')),
  name        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  test_mode   INTEGER NOT NULL DEFAULT 1 CHECK (test_mode IN (0, 1)),   -- test mode records what WOULD be sent and sends nothing
  config_json TEXT NOT NULL DEFAULT '{}',                               -- delay_hours, window_days, min_gap_days, product_filter, copy
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX uq_journeys_kind ON journeys(kind);
CREATE TABLE journey_runs (
  id         TEXT PRIMARY KEY,
  journey_id TEXT NOT NULL REFERENCES journeys(id),
  email      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('sent', 'would_send', 'skipped', 'error')),
  detail     TEXT,
  dedupe_key TEXT NOT NULL,                                             -- e.g. order id or week bucket: the same trigger never fires twice
  provider_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (journey_id, email, dedupe_key)
);
CREATE INDEX idx_jr_journey ON journey_runs(journey_id, created_at);
CREATE INDEX idx_jr_email ON journey_runs(email, created_at);

-- Every journey ships OFF and in test mode. Nothing sends until an admin turns it on and leaves test mode.
INSERT INTO journeys (id, kind, name) VALUES
  ('welcome', 'welcome', 'Welcome series'),
  ('abandoned_cart', 'abandoned_cart', 'Abandoned cart'),
  ('first_purchase', 'first_purchase', 'First purchase follow-up'),
  ('membership_milestone', 'membership_milestone', 'Membership milestone'),
  ('repeat_reminder', 'repeat_reminder', 'Repeat purchase reminder'),
  ('reengagement', 'reengagement', 'Inactive customer re-engagement');

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
