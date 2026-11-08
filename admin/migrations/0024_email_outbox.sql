-- 0024: generic email outbox for partner-network messages. Additive only.
-- A row is written in the SAME transaction as the state change that caused it, so an approval can never happen without its email being
-- queued, and sending (or failing to send) can never roll the approval back. `dedupe_key` is UNIQUE so a repeated request or a retry
-- cannot queue the same message twice. Order emails keep using `notifications` (it is tied to orders).
-- Never store secrets or ID numbers in data_json; it holds only what the message itself shows.

CREATE TABLE IF NOT EXISTS email_outbox (
  id              TEXT PRIMARY KEY,
  to_email        TEXT NOT NULL,
  template        TEXT NOT NULL,
  data_json       TEXT NOT NULL DEFAULT '{}',
  dedupe_key      TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_error      TEXT,                                   -- short reason, never a secret or the message body
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_email_outbox_due ON email_outbox(status, next_attempt_at);
