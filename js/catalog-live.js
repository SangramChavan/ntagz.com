/* ntagz — LIVE CATALOGUE OVERLAY
   js/catalog.js is the static fallback. The admin's catalogue (D1, via GET /api/catalog) is the source of truth for
   price, active/inactive and availability: the server charges those prices, so pages must show them. If the request
   fails, nothing changes and the static values stay. Revalidate on every page so admin changes are visible
   immediately; the API response is the shared source for all storefront pages. */
(function () {
  'use strict';
  function fetchLive() {
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 4000);
    return fetch('/api/catalog', { credentials: 'omit', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        clearTimeout(timer);
        if (!Array.isArray(d)) return null;
        return d;
      })
      .catch(function () { clearTimeout(timer); return null; });
  }

  /* Updates catalogue products in place; returns true if anything changed. */
  function apply(catalog, data) {
    var changed = false;
    (data || []).forEach(function (row) {
      var p = catalog.byId && catalog.byId(row.id);
      if (!p || typeof row.price !== 'number' || !isFinite(row.price) || row.price < 0) return;
      if (p.price !== row.price) { p.price = row.price; changed = true; }
      var pre = row.preorder && typeof row.preorder === 'object' ? {
        message: typeof row.preorder.message === 'string' ? row.preorder.message : '',
        dispatch: typeof row.preorder.dispatch === 'string' ? row.preorder.dispatch : '',
        ready_qty: Math.max(0, parseInt(row.preorder.ready_qty, 10) || 0),
        max_qty: row.preorder.max_qty == null ? null : Math.max(0, parseInt(row.preorder.max_qty, 10) || 0)
      } : null;
      var left = row.low && Number.isInteger(row.left) && row.left > 0 ? row.left : null;
      var live = { active: row.active !== false, available: row.available !== false, low: !!row.low, left: left, preorder: pre };
      if (!p.live || p.live.active !== live.active || p.live.available !== live.available || p.live.low !== live.low ||
          p.live.left !== live.left || JSON.stringify(p.live.preorder) !== JSON.stringify(live.preorder)) changed = true;
      p.live = live;
    });
    return changed;
  }

  window.NTAGZ_LIVE = { ready: fetchLive(), apply: apply };
})();
