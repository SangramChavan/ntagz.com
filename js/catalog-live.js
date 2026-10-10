/* ntagz — LIVE CATALOGUE OVERLAY
   js/catalog.js is the static fallback. The admin's catalogue (D1, via GET /api/catalog) is the source of truth for
   price, active/inactive and availability: the server charges those prices, so pages must show them. If the request
   fails, nothing changes and the static values stay. Cached for 60s in sessionStorage to avoid repeat requests. */
(function () {
  'use strict';
  var KEY = 'ntagz.catalog.live', TTL = 60000;

  function cached() {
    try {
      var c = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (c && Date.now() - c.t < TTL && Array.isArray(c.d)) return c.d;
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  function fetchLive() {
    var hit = cached();
    if (hit) return Promise.resolve(hit);
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 4000);
    return fetch('/api/catalog', { credentials: 'omit', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        clearTimeout(timer);
        if (!Array.isArray(d)) return null;
        try { sessionStorage.setItem(KEY, JSON.stringify({ t: Date.now(), d: d })); } catch (e) { }
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
      var live = { active: row.active !== false, available: row.available !== false, low: !!row.low };
      if (!p.live || p.live.active !== live.active || p.live.available !== live.available) changed = true;
      p.live = live;
    });
    return changed;
  }

  window.NTAGZ_LIVE = { ready: fetchLive(), apply: apply };
})();
