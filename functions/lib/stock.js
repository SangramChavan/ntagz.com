// Shared by the payments Worker (paid and offline orders) and the partner API (stock-credit orders), so stock is deducted one way only.
// Statements that deduct sold quantities from tracked products, each guarded by "this order row exists" so a repeat or an
// ignored insert deducts nothing. Deduction is clamped at zero (never negative) and every change gets a movement row.
function stockStatements(db, orderId, txnId, items) {
  const out = [];
  const merged = new Map(); // one stock line per product (order_stock_lines is keyed by order+product)
  for (const it of items) {
    if (!it || typeof it.id !== "string" || !Number.isInteger(it.qty) || it.qty < 1) continue;
    merged.set(it.id, (merged.get(it.id) || 0) + it.qty);
  }
  for (const [id, qty] of merged) {
    // Order matters: allocation reads stock_qty, so it runs before the deduction below.
    out.push(
      db.prepare(
        `INSERT OR IGNORE INTO order_stock_lines (order_id,product_id,ready_qty,pre_qty)
         SELECT ?1,id,min(stock_qty,?2),CASE WHEN preorder_enabled=1 THEN ?2-min(stock_qty,?2) ELSE 0 END
         FROM products WHERE id=?3 AND track_stock=1 AND EXISTS (SELECT 1 FROM orders WHERE id=?1)`
      ).bind(orderId, qty, id),
      db.prepare( // non-preorder shortfall (concurrent buyers): hold the paid order for the admin instead of silently shipping short
        `UPDATE orders SET status='on_hold' WHERE id=?1 AND status IN ('placed','confirmed')
         AND EXISTS (SELECT 1 FROM order_stock_lines WHERE order_id=?1 AND product_id=?3 AND pre_qty=0 AND ready_qty<?2)`
      ).bind(orderId, qty, id),
      db.prepare(
        `UPDATE products SET preordered_qty=preordered_qty+coalesce((SELECT pre_qty FROM order_stock_lines WHERE order_id=?1 AND product_id=?2),0), updated_at=unixepoch()
         WHERE id=?2 AND preorder_enabled=1 AND track_stock=1 AND EXISTS (SELECT 1 FROM orders WHERE id=?1)`
      ).bind(orderId, id),
      db.prepare(
        `INSERT INTO inventory_movements (id,product_id,type,qty_change,prev_stock,new_stock,reason,reference,admin,idempotency_key)
         SELECT ?1,id,'out',-min(stock_qty,?2),stock_qty,max(stock_qty-?2,0),'Order sale',?3,'system',?4
         FROM products WHERE id=?5 AND track_stock=1 AND stock_qty>0 AND EXISTS (SELECT 1 FROM orders WHERE id=?4)`
      ).bind(crypto.randomUUID(), qty, txnId, orderId, id),
      db.prepare(
        `UPDATE products SET stock_qty=max(stock_qty-?1,0), updated_at=unixepoch()
         WHERE id=?2 AND track_stock=1 AND EXISTS (SELECT 1 FROM orders WHERE id=?3)`
      ).bind(qty, id, orderId),
    );
  }
  out.push(db.prepare(
    `UPDATE orders SET is_preorder=1, status='preorder_confirmed' WHERE id=?1 AND status IN ('placed','confirmed')
     AND EXISTS (SELECT 1 FROM order_stock_lines WHERE order_id=?1 AND pre_qty>0)`
  ).bind(orderId));
  return out;
}

// Returns a customer-facing message if any item can't be sold right now, else null.
function unavailableReason(items, pricing) {
  if (!pricing || !Array.isArray(items)) return null;
  for (const item of items) {
    const row = pricing[item && item.id];
    if (!row) continue;
    const name = row.name || item.id;
    if (!row.active) return `${name} is currently unavailable`;
    if (row.track_stock && Number.isInteger(item.qty)) {
      const room = row.preorder_enabled ? (row.preorder_max == null ? Infinity : Math.max(row.preorder_max - row.preordered_qty, 0)) : 0;
      if (item.qty > row.stock_qty + room) {
        if (!row.preorder_enabled) return row.stock_qty > 0 ? `Only ${row.stock_qty} of ${name} available` : `${name} is out of stock`;
        return `Only ${row.stock_qty + room} of ${name} available (${row.stock_qty} ready to ship, ${room} for pre-order)`;
      }
    }
  }
  return null;
}

module.exports = { stockStatements, unavailableReason };
