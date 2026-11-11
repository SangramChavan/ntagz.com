-- Out of stock now means pre-order for every stock-tracked product: no cap, 7-day dispatch, non-refundable.
-- Existing admin-written dispatch text / message are kept; only blanks are filled. Admin can still switch any product off.
UPDATE products SET
  preorder_enabled = 1,
  preorder_max = NULL,
  preorder_dispatch = COALESCE(NULLIF(trim(preorder_dispatch), ''), 'Dispatch within 7 days'),
  preorder_message = COALESCE(NULLIF(trim(preorder_message), ''), 'Out of stock right now. Pre-order and we dispatch within 7 days. Pre-orders are non-refundable.')
WHERE track_stock = 1;
