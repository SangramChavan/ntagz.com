-- 0021: roles and permissions (RBAC), login attempt log, audit_log entity columns, users status columns.
-- Additive only. Seeds come from docs/platform/CONTRACTS.md section 3. Nothing existing is renamed or dropped.
-- scope: 'all' = any record, 'own' = records linked to the caller, 'region' = records in the caller's assigned regions.
-- Code must enforce scope in the SQL WHERE clause (see packages/platform-core).

CREATE TABLE IF NOT EXISTS roles (
  key        TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('customer', 'partner', 'staff')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS permissions (
  key    TEXT PRIMARY KEY,
  label  TEXT NOT NULL,
  module TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_key       TEXT NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  scope          TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'own', 'region')),
  PRIMARY KEY (role_key, permission_key)
);

CREATE TABLE IF NOT EXISTS user_roles (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key   TEXT NOT NULL REFERENCES roles(key),
  granted_by TEXT NOT NULL,                       -- admin email, 'system' or the user id (self-service customer role)
  granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at INTEGER,
  UNIQUE (user_id, role_key)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,                       -- lower-cased email or phone
  ip         TEXT,
  portal     TEXT NOT NULL,                       -- 'customer' | 'partner' | 'admin'
  stage      TEXT NOT NULL,                       -- 'send' | 'verify'
  success    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ident ON login_attempts(identifier, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, created_at);

-- Account state for the unified identity. NULL status is treated as 'active' (all existing rows).
ALTER TABLE users ADD COLUMN status TEXT;                -- NULL/'active' | 'suspended'
ALTER TABLE users ADD COLUMN phone_verified_at INTEGER;
ALTER TABLE users ADD COLUMN last_login_at INTEGER;

-- Audit entries for non-order entities (partners, prices, commissions ...). Order entries keep using order_id.
ALTER TABLE audit_log ADD COLUMN entity_type TEXT;
ALTER TABLE audit_log ADD COLUMN entity_id TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id, created_at);

INSERT OR IGNORE INTO roles (key, label, kind) VALUES
  ('customer', 'Customer', 'customer'),
  ('partner_360', 'Ntagz360 Partner', 'partner'),
  ('partner_enterprise', 'Enterprise Partner', 'partner'),
  ('partner_flex', 'Flex Partner', 'partner'),
  ('partner_smile', 'Smile Partner', 'partner'),
  ('partner_smile_plus', 'Smile+ Partner', 'partner'),
  ('hq_admin', 'HQ Admin', 'staff'),
  ('operations', 'Operations Manager', 'staff'),
  ('finance', 'Finance Manager', 'staff'),
  ('inventory', 'Inventory Manager', 'staff'),
  ('support', 'Support Executive', 'staff'),
  ('regional', 'Regional Manager', 'staff');

INSERT OR IGNORE INTO permissions (key, label, module) VALUES
  ('catalog.read', 'View catalogue', 'catalog'),
  ('catalog.wholesale.read', 'View wholesale catalogue and prices', 'catalog'),
  ('orders.place.own', 'Place orders', 'orders'),
  ('orders.read.own', 'View own orders', 'orders'),
  ('orders.read.all', 'View all orders', 'orders'),
  ('orders.fulfil', 'Fulfil orders', 'orders'),
  ('orders.refund', 'Refund orders', 'orders'),
  ('partners.apply', 'Apply to become a partner', 'partners'),
  ('partners.review', 'Review partner applications', 'partners'),
  ('partners.activate', 'Approve and activate partners', 'partners'),
  ('partners.suspend', 'Suspend partners', 'partners'),
  ('leads.manage.own', 'Manage own leads', 'leads'),
  ('leads.read.all', 'View all leads', 'leads'),
  ('leads.assign', 'Assign leads', 'leads'),
  ('quotes.create', 'Create quotations', 'quotes'),
  ('quotes.approve', 'Approve quotations', 'quotes'),
  ('pricing.manage', 'Manage price lists', 'pricing'),
  ('inventory.manage', 'Manage inventory', 'inventory'),
  ('commissions.read.own', 'View own commissions', 'commissions'),
  ('commissions.approve', 'Approve commissions', 'commissions'),
  ('settlements.manage', 'Manage settlements', 'commissions'),
  ('service_jobs.manage.own', 'Manage own service jobs', 'service'),
  ('service_jobs.assign', 'Assign service jobs', 'service'),
  ('territories.read', 'View territories', 'territories'),
  ('territories.manage', 'Manage territories', 'territories'),
  ('tickets.create', 'Raise support tickets', 'support'),
  ('tickets.manage', 'Manage support tickets', 'support'),
  ('staff.manage', 'Manage staff and roles', 'system'),
  ('settings.manage', 'Manage system settings', 'system'),
  ('audit.read', 'Read audit log', 'system'),
  ('reports.read', 'View reports', 'reports');

INSERT OR IGNORE INTO role_permissions (role_key, permission_key, scope) VALUES
  ('customer', 'catalog.read', 'all'),
  ('partner_360', 'catalog.read', 'all'),
  ('partner_enterprise', 'catalog.read', 'all'),
  ('partner_flex', 'catalog.read', 'all'),
  ('partner_smile', 'catalog.read', 'all'),
  ('partner_smile_plus', 'catalog.read', 'all'),
  ('hq_admin', 'catalog.read', 'all'),
  ('operations', 'catalog.read', 'all'),
  ('finance', 'catalog.read', 'all'),
  ('inventory', 'catalog.read', 'all'),
  ('support', 'catalog.read', 'all'),
  ('regional', 'catalog.read', 'all'),
  ('partner_360', 'catalog.wholesale.read', 'all'),
  ('partner_enterprise', 'catalog.wholesale.read', 'all'),
  ('partner_flex', 'catalog.wholesale.read', 'all'),
  ('partner_smile', 'catalog.wholesale.read', 'all'),
  ('hq_admin', 'catalog.wholesale.read', 'all'),
  ('operations', 'catalog.wholesale.read', 'all'),
  ('finance', 'catalog.wholesale.read', 'all'),
  ('inventory', 'catalog.wholesale.read', 'all'),
  ('regional', 'catalog.wholesale.read', 'all'),
  ('customer', 'orders.place.own', 'own'),
  ('partner_360', 'orders.place.own', 'own'),
  ('partner_enterprise', 'orders.place.own', 'own'),
  ('partner_flex', 'orders.place.own', 'own'),
  ('partner_smile', 'orders.place.own', 'own'),
  ('customer', 'orders.read.own', 'own'),
  ('partner_360', 'orders.read.own', 'own'),
  ('partner_enterprise', 'orders.read.own', 'own'),
  ('partner_flex', 'orders.read.own', 'own'),
  ('partner_smile', 'orders.read.own', 'own'),
  ('partner_smile_plus', 'orders.read.own', 'own'),
  ('hq_admin', 'orders.read.all', 'all'),
  ('operations', 'orders.read.all', 'all'),
  ('finance', 'orders.read.all', 'all'),
  ('inventory', 'orders.read.all', 'all'),
  ('support', 'orders.read.all', 'all'),
  ('regional', 'orders.read.all', 'region'),
  ('hq_admin', 'orders.fulfil', 'all'),
  ('operations', 'orders.fulfil', 'all'),
  ('inventory', 'orders.fulfil', 'all'),
  ('hq_admin', 'orders.refund', 'all'),
  ('finance', 'orders.refund', 'all'),
  ('customer', 'partners.apply', 'own'),
  ('hq_admin', 'partners.review', 'all'),
  ('operations', 'partners.review', 'all'),
  ('regional', 'partners.review', 'region'),
  ('hq_admin', 'partners.activate', 'all'),
  ('hq_admin', 'partners.suspend', 'all'),
  ('operations', 'partners.suspend', 'all'),
  ('partner_360', 'leads.manage.own', 'own'),
  ('partner_enterprise', 'leads.manage.own', 'own'),
  ('partner_flex', 'leads.manage.own', 'own'),
  ('partner_smile_plus', 'leads.manage.own', 'own'),
  ('hq_admin', 'leads.read.all', 'all'),
  ('operations', 'leads.read.all', 'all'),
  ('regional', 'leads.read.all', 'region'),
  ('hq_admin', 'leads.assign', 'all'),
  ('operations', 'leads.assign', 'all'),
  ('regional', 'leads.assign', 'region'),
  ('partner_360', 'quotes.create', 'own'),
  ('partner_enterprise', 'quotes.create', 'own'),
  ('hq_admin', 'quotes.create', 'all'),
  ('operations', 'quotes.create', 'all'),
  ('hq_admin', 'quotes.approve', 'all'),
  ('operations', 'quotes.approve', 'all'),
  ('hq_admin', 'pricing.manage', 'all'),
  ('finance', 'pricing.manage', 'all'),
  ('partner_360', 'inventory.manage', 'own'),
  ('hq_admin', 'inventory.manage', 'all'),
  ('inventory', 'inventory.manage', 'all'),
  ('partner_360', 'commissions.read.own', 'own'),
  ('partner_enterprise', 'commissions.read.own', 'own'),
  ('partner_flex', 'commissions.read.own', 'own'),
  ('partner_smile', 'commissions.read.own', 'own'),
  ('partner_smile_plus', 'commissions.read.own', 'own'),
  ('hq_admin', 'commissions.approve', 'all'),
  ('finance', 'commissions.approve', 'all'),
  ('hq_admin', 'settlements.manage', 'all'),
  ('finance', 'settlements.manage', 'all'),
  ('partner_smile', 'service_jobs.manage.own', 'own'),
  ('partner_smile_plus', 'service_jobs.manage.own', 'own'),
  ('hq_admin', 'service_jobs.assign', 'all'),
  ('operations', 'service_jobs.assign', 'all'),
  ('regional', 'service_jobs.assign', 'region'),
  ('hq_admin', 'territories.read', 'all'),
  ('operations', 'territories.read', 'all'),
  ('regional', 'territories.read', 'region'),
  ('hq_admin', 'territories.manage', 'all'),
  ('customer', 'tickets.create', 'own'),
  ('partner_360', 'tickets.create', 'own'),
  ('partner_enterprise', 'tickets.create', 'own'),
  ('partner_flex', 'tickets.create', 'own'),
  ('partner_smile', 'tickets.create', 'own'),
  ('partner_smile_plus', 'tickets.create', 'own'),
  ('hq_admin', 'tickets.manage', 'all'),
  ('operations', 'tickets.manage', 'all'),
  ('support', 'tickets.manage', 'all'),
  ('hq_admin', 'staff.manage', 'all'),
  ('hq_admin', 'settings.manage', 'all'),
  ('hq_admin', 'audit.read', 'all'),
  ('finance', 'audit.read', 'all'),
  ('partner_360', 'reports.read', 'own'),
  ('partner_enterprise', 'reports.read', 'own'),
  ('partner_flex', 'reports.read', 'own'),
  ('partner_smile', 'reports.read', 'own'),
  ('partner_smile_plus', 'reports.read', 'own'),
  ('hq_admin', 'reports.read', 'all'),
  ('operations', 'reports.read', 'all'),
  ('finance', 'reports.read', 'all'),
  ('inventory', 'reports.read', 'all'),
  ('regional', 'reports.read', 'region');
