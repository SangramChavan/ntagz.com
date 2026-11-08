import { AppError } from './errors.js';

// Loads what a user may do. Rules (docs/platform/CONTRACTS.md section 2):
//  - a suspended user has no permissions at all;
//  - a revoked role grants nothing;
//  - a partner role grants nothing until that person's partner record is 'active' (so a suspended or not-yet-onboarded partner is locked out);
//  - the same permission granted by several roles takes the widest scope (all > region > own).
const RANK = { own: 1, region: 2, all: 3 };

export async function loadAccess(db, userId) {
  const user = await db.prepare('SELECT id, status FROM users WHERE id = ?').bind(userId).first();
  if (!user || (user.status && user.status !== 'active')) return { userId, roles: [], permissions: new Map(), partnerId: null, region: null };
  const partner = await db.prepare('SELECT id, status, region FROM partners WHERE user_id = ?').bind(userId).first();
  const partnerActive = !!partner && partner.status === 'active';
  const rows = (await db.prepare(
    `SELECT ur.role_key, r.kind, rp.permission_key, rp.scope
       FROM user_roles ur
       JOIN roles r ON r.key = ur.role_key
       LEFT JOIN role_permissions rp ON rp.role_key = ur.role_key
      WHERE ur.user_id = ? AND ur.revoked_at IS NULL`).bind(userId).all()).results;
  const roles = new Set();
  const permissions = new Map();
  for (const row of rows) {
    if (row.kind === 'partner' && !partnerActive) continue;
    roles.add(row.role_key);
    if (!row.permission_key) continue;
    const have = permissions.get(row.permission_key);
    if (!have || RANK[row.scope] > RANK[have]) permissions.set(row.permission_key, row.scope);
  }
  return { userId, roles: [...roles], permissions, partnerId: partnerActive ? partner.id : null, region: partner ? partner.region : null };
}

// Returns the scope ('all' | 'region' | 'own') the caller has for `permission`, or throws.
// The caller MUST apply that scope in the SQL WHERE clause (never fetch first and filter after).
export function requirePermission(access, permission) {
  if (!access || !access.userId) throw new AppError('UNAUTHENTICATED', 'Sign in required');
  const scope = access.permissions.get(permission);
  if (!scope) throw new AppError('FORBIDDEN', 'You do not have access to this');
  return scope;
}

// Builds the WHERE fragment and binds for a scope. `column` is a trusted constant, never user input.
export function scopeClause(scope, access, { ownColumn, regionColumn }) {
  if (scope === 'all') return { sql: '1=1', binds: [] };
  if (scope === 'own') {
    const owner = ownColumn === 'user_id' ? access.userId : access.partnerId;
    if (!owner) return { sql: '1=0', binds: [] };
    return { sql: `${ownColumn} = ?`, binds: [owner] };
  }
  if (scope === 'region' && regionColumn && access.region) return { sql: `${regionColumn} = ?`, binds: [access.region] };
  return { sql: '1=0', binds: [] };
}
