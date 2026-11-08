// Returns a prepared INSERT for audit_log so it can ride in the same db.batch() as the change it records.
export function auditStmt(db, { actor, action, entityType, entityId, before, after, orderId }) {
  const detail = JSON.stringify({ before: before ?? null, after: after ?? null });
  return db.prepare(
    'INSERT INTO audit_log (id, actor, action, order_id, detail, entity_type, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), actor, action, orderId ?? null, detail, entityType ?? null, entityId ?? null);
}
