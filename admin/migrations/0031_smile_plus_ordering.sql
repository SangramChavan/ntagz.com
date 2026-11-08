-- 0031: Smile+ partners may place wholesale orders (same permission as Smile and the other partner types).
-- Additive only: one permission grant. Pricing, credit and the opening-stock amount are unchanged.
INSERT OR IGNORE INTO role_permissions (role_key, permission_key, scope) VALUES
  ('partner_smile_plus', 'orders.place.own', 'own');
