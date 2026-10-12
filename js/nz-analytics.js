/* ntagz first-party shopping analytics: pages viewed, products viewed, cart changes, checkout start.
   Off unless the store owner switched it on AND the visitor said yes. No third parties, no cookies, no fingerprinting.
   Sends page paths only (never query strings, names, emails or payment details). Money/orders are NOT sent from here. */
(function () {
  'use strict';
  var CONSENT = 'nz_consent', SID = 'nz_sid', CFG = 'nz_cfg', CART = 'ntagz_cart_v1';
  if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true) return; // honour browser privacy signals
  function get(k, s) { try { return (s ? sessionStorage : localStorage).getItem(k); } catch (e) { return null; } }
  function set(k, v, s) { try { (s ? sessionStorage : localStorage).setItem(k, v); } catch (e) { /* storage blocked: stay off */ } }
  function del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function rid() { var a = new Uint8Array(12); (crypto || window.msCrypto).getRandomValues(a); return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }

  var queue = [], timer = 0, started = false, prevCart = {};
  function sid() { // random, rotates every 30 days, not derived from anything about the device
    var raw = get(SID), o = null; try { o = raw && JSON.parse(raw); } catch (e) { o = null; }
    if (!o || !o.id || Date.now() - o.t > 30 * 864e5) { o = { id: rid(), t: Date.now() }; set(SID, JSON.stringify(o)); }
    return o.id;
  }
  function flush() {
    clearTimeout(timer); timer = 0;
    if (!queue.length) return;
    var events = queue.splice(0, 20);
    try { fetch('/api/ev', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: events }) }).catch(function () {}); } catch (e) { /* analytics must never break the shop */ }
    if (queue.length) timer = setTimeout(flush, 500);
  }
  function ev(event, x) {
    var e = { id: rid(), sid: sid(), event: event, path: location.pathname };
    for (var k in x) if (x[k]) e[k] = x[k];
    queue.push(e); if (queue.length >= 20) flush(); else if (!timer) timer = setTimeout(flush, 2500);
  }
  function cart() { try { var c = JSON.parse(get(CART) || '{}'); return c && typeof c === 'object' ? c : {}; } catch (e) { return {}; } }
  function catOf(id) { try { var p = window.NTAGZ_CATALOG && window.NTAGZ_CATALOG.byId(id); return p && p.category ? String(p.category).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 30) : ''; } catch (e) { return ''; } }

  function start() {
    if (started) return; started = true;
    var q = new URLSearchParams(location.search), x = {};
    ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) { if (q.get(k)) x[k] = q.get(k); });
    if (q.get('nz_r')) { x.recipient_id = q.get('nz_r'); q.delete('nz_r'); try { history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash); } catch (e) { /* ignore */ } }
    ev('page_view', x);
    if (x.recipient_id) ev('email_click', x);
    var m = location.pathname.match(/^\/product\/([a-z0-9-]+)\/?/);
    if (m) ev('product_view', { product_id: m[1], category: catOf(m[1]) });
    if (/^\/membership/.test(location.pathname)) ev('membership_view', {});
    prevCart = cart();
    if (/^\/order(\.html)?\/?$/.test(location.pathname) && Object.keys(prevCart).length && !get('nz_bc', true)) { set('nz_bc', '1', true); ev('begin_checkout', {}); }
    document.addEventListener('ntagz:cart-change', function (e) {
      var now = (e && e.detail) || cart(), id;
      for (id in now) if (!prevCart[id] || now[id] > prevCart[id]) ev('add_to_cart', { product_id: id, category: catOf(id) });
      for (id in prevCart) if (!now[id]) ev('remove_from_cart', { product_id: id, category: catOf(id) });
      prevCart = JSON.parse(JSON.stringify(now));
    });
    var box = document.getElementById('productSearch'), st = 0;
    if (box) box.addEventListener('input', function () { clearTimeout(st); st = setTimeout(function () { var t = box.value.trim(); if (t.length >= 2) ev('search', { term: t.slice(0, 60) }); }, 1500); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', flush);
  }

  function bar() {
    if (document.getElementById('nz-consent')) return;
    var d = document.createElement('div'); d.id = 'nz-consent'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Analytics choice');
    d.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-width:520px;margin:0 auto;background:#fff;color:#1d1d1f;border:1px solid #e5e5ea;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.18);padding:14px 16px;font:14px/1.45 -apple-system,Segoe UI,sans-serif';
    d.innerHTML = '<p style="margin:0 0 10px">Can we count which pages and products people look at, to improve ntagz? No ads, no third parties, nothing about payments. <a href="/terms.html" style="color:#ff5a1f">Details</a></p>' +
      '<div style="display:flex;gap:10px"><button type="button" data-a="1" style="flex:1;min-height:44px;border:0;border-radius:10px;background:#ff5a1f;color:#fff;font:600 15px inherit;cursor:pointer">Yes, that\'s fine</button>' +
      '<button type="button" data-a="0" style="flex:1;min-height:44px;border:1px solid #e5e5ea;border-radius:10px;background:#fff;color:#1d1d1f;font:600 15px inherit;cursor:pointer">No thanks</button></div>';
    d.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; set(CONSENT, b.getAttribute('data-a') === '1' ? 'granted' : 'denied'); d.remove(); if (b.getAttribute('data-a') === '1') start(); });
    document.body.appendChild(d);
  }
  function enabled(cb) { // owner's switch, cached for an hour per tab session so it costs at most one tiny request
    var c = get(CFG, true), o = null; try { o = c && JSON.parse(c); } catch (e) { o = null; }
    if (o && Date.now() - o.t < 36e5) return cb(o.on);
    fetch('/api/ev/config').then(function (r) { return r.ok ? r.json() : { enabled: false }; }).catch(function () { return { enabled: false }; })
      .then(function (j) { set(CFG, JSON.stringify({ on: !!j.enabled, t: Date.now() }), true); cb(!!j.enabled); });
  }
  function init() {
    var c = get(CONSENT);
    if (c === 'denied') return;
    enabled(function (on) { if (!on) return; if (c === 'granted') start(); else bar(); });
  }
  window.NZ_ANALYTICS = { reset: function () { del(CONSENT); try { sessionStorage.removeItem(CFG); } catch (e) { /* ignore */ } location.reload(); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
