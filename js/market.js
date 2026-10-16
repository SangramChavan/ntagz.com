/* ntagz — MARKET (India / international) selector, USD prices and the international cart.
   Loaded only when a visitor has chosen a destination outside India (component-loader.js) or on the international pages, so Indian
   shoppers make no extra requests. Everything shown here comes from the server (GET /api/intl/config, /api/intl/catalog and
   POST /api/intl/price); the browser never supplies a price. USD here is the DISPLAY price list: the payment currency is stated at checkout. */
(function () {
  'use strict';
  var KEY = 'ntagz.market', NOTICE_KEY = 'ntagz.market.notice';
  var get = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var set = function (k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { } };
  var sget = function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } };
  var sset = function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) { } };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  var usd = function (cents) { return 'US$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

  function market() { try { var m = JSON.parse(get(KEY) || 'null'); return m && /^[A-Z]{2}$/.test(m.country) ? m : { country: 'IN' }; } catch (e) { return { country: 'IN' }; } }
  var isIntl = function () { return market().country !== 'IN'; };
  var base = (function () { var d = location.pathname.split('/').filter(function (s) { return s && !/\.html?$/.test(s); }).length; return d ? new Array(d + 1).join('../') : ''; })();

  var cfgP = null, catP = null;
  function config() { return cfgP || (cfgP = fetch('/api/intl/config', { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : { enabled: false }; }).catch(function () { return { enabled: false }; })); }
  function catalog() {
    return catP || (catP = fetch('/api/intl/catalog', { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : { products: [] }; }).then(function (d) {
      var by = {}; (d.products || []).forEach(function (p) { by[p.id] = p; }); return by;
    }).catch(function () { return {}; }));
  }

  /* ── styles (small; the full page styles live in css/intl.css) ── */
  (function () {
    var css = document.createElement('style');
    css.textContent =
      '.mk-btn{display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:0 12px;border-radius:999px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font:600 13px inherit;font-family:inherit;cursor:pointer;margin-right:8px}' +
      '.mk-btn svg{width:16px;height:16px}.mk-banner{background:#FFF2EA;color:#4A2208;font-size:13px;line-height:1.45;padding:10px 16px;text-align:center}.mk-banner button{margin-left:10px;background:none;border:0;font:inherit;font-weight:700;text-decoration:underline;color:inherit;cursor:pointer}' +
      '.mk-price{margin:8px 0 4px}.mk-now{font-size:22px;font-weight:700;color:inherit}.mk-unit{font-size:12px;opacity:.7;margin-left:4px}.mk-sub{font-size:12px;opacity:.75;line-height:1.5;margin-top:3px}.mk-tier{font-size:12px;font-weight:700;color:#FF8A57;margin-top:3px}' +
      '.mk-intl .product-price,.mk-intl .prod-price{display:none!important}.mk-na{font-size:13px;opacity:.8}.mk-na a{color:#FF8A57;font-weight:700}' +
      '.mk-sheet-root{position:fixed;inset:0;z-index:10060;display:none}.mk-sheet-root.open{display:block}.mk-ov{position:absolute;inset:0;background:rgba(26,23,20,.55)}' +
      '.mk-sheet{position:absolute;left:0;right:0;bottom:0;background:#fff;color:#1A1714;border-radius:22px 22px 0 0;padding:22px 20px calc(20px + env(safe-area-inset-bottom));max-width:520px;margin:0 auto;box-shadow:0 -8px 32px rgba(0,0,0,.18)}' +
      '.mk-sheet h2{font-size:22px;margin:0 0 8px}.mk-sheet p{font-size:14px;line-height:1.5;color:#4A4540;margin:0 0 12px}.mk-sheet label{display:block;font-weight:700;font-size:14px;margin:10px 0 6px}' +
      '.mk-sheet select{width:100%;min-height:48px;border:1px solid #E5E0D6;border-radius:12px;padding:0 12px;font:500 16px inherit;font-family:inherit;background:#fff;color:#1A1714}' +
      '.mk-actions{display:grid;gap:10px;margin-top:14px}.mk-go{min-height:50px;border-radius:14px;border:0;background:#FF4500;color:#fff;font-weight:700;font-size:16px;cursor:pointer;font-family:inherit}.mk-cancel{min-height:46px;border-radius:14px;border:1.5px solid #E5E0D6;background:#fff;color:#1A1714;font-weight:700;font-size:15px;cursor:pointer;font-family:inherit}' +
      '.mk-line input[type=number]{width:72px;min-height:36px;border:1px solid rgba(128,128,128,.4);border-radius:8px;background:transparent;color:inherit;text-align:center;font:600 14px inherit}.mk-note{font-size:12px;opacity:.8;margin:8px 0 0;line-height:1.5}.mk-warn{font-size:13px;color:#FF8A57;margin:8px 0 0}' +
      '@media(min-width:640px){.mk-sheet{bottom:auto;top:50%;transform:translateY(-50%);border-radius:22px}}';
    document.head.appendChild(css);
  })();

  /* ── selector ── */
  var sheet = null;
  function openSelector() {
    if (!sheet) { sheet = el('div', 'mk-sheet-root'); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'mkTitle'); document.body.appendChild(sheet); }
    sheet.textContent = '';
    var ov = el('div', 'mk-ov'); ov.addEventListener('click', close);
    var box = el('div', 'mk-sheet'), h = el('h2', null, 'Where are you ordering from?'); h.id = 'mkTitle';
    box.appendChild(h);
    box.appendChild(el('p', null, 'India: prices in INR (₹) with GST, and our usual checkout. Other countries: prices in USD where available. International shipping is quoted separately for your destination and order, and confirmed with you before dispatch.'));
    var lab = el('label', null, 'Country'); lab.setAttribute('for', 'mkCountry'); var sel = el('select'); sel.id = 'mkCountry';
    sel.appendChild(new Option('India (INR ₹)', 'IN'));
    config().then(function (c) {
      if (c.enabled) (c.countries || []).forEach(function (x) { sel.appendChild(new Option(x.name + ' (USD)', x.code)); });
      sel.value = market().country; if (sel.value !== market().country) sel.value = 'IN';
      if (!c.enabled) note.textContent = 'International ordering is not open yet. Please send us an enquiry and we will help.';
    });
    var note = el('p', 'mk-note'); note.textContent = 'Selecting USD sets how prices are displayed. The payment currency, and any conversion, is shown before you pay.';
    var go = el('button', 'mk-go', 'Continue'); go.type = 'button';
    go.addEventListener('click', function () { set(KEY, sel.value === 'IN' ? null : JSON.stringify({ country: sel.value })); sset(NOTICE_KEY, ''); location.reload(); });
    var cancel = el('button', 'mk-cancel', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', close);
    var more = el('a', 'mk-note', 'More about international orders'); more.href = base + 'international.html';
    var act = el('div', 'mk-actions'); act.appendChild(go); act.appendChild(cancel);
    box.appendChild(lab); box.appendChild(sel); box.appendChild(note); box.appendChild(act); box.appendChild(more);
    sheet.appendChild(ov); sheet.appendChild(box); sheet.classList.add('open'); sel.focus();
  }
  function close() { if (sheet) sheet.classList.remove('open'); }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  function mountButton() {
    var ctas = document.querySelector('.nav-ctas'); if (!ctas || ctas.querySelector('.mk-btn')) return !!ctas;
    var b = el('button', 'mk-btn'); b.type = 'button'; b.setAttribute('aria-label', 'Choose country and currency');
    b.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 10h15M10 2.5c2.2 2.2 3.2 4.7 3.2 7.5s-1 5.3-3.2 7.5c-2.2-2.2-3.2-4.7-3.2-7.5s1-5.3 3.2-7.5z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
    var t = el('span', null, market().country === 'IN' ? 'IN · ₹' : market().country + ' · US$'); b.appendChild(t);
    b.addEventListener('click', openSelector); ctas.insertBefore(b, ctas.firstChild); return true;
  }

  function banner() {
    if (!isIntl() || sget(NOTICE_KEY) === 'x' || document.querySelector('.mk-banner')) return;
    var d = el('div', 'mk-banner'); d.setAttribute('role', 'note');
    d.appendChild(document.createTextNode('Ordering from outside India? Product prices are shown in USD where available. International shipping is quoted separately for your destination and order. We will confirm shipping charges with you before dispatch.'));
    var x = el('button', null, 'Dismiss'); x.type = 'button'; x.addEventListener('click', function () { sset(NOTICE_KEY, 'x'); d.remove(); }); d.appendChild(x);
    document.body.insertBefore(d, document.body.firstChild);
  }

  /* ── USD price blocks on cards and product pages ── */
  var byDetail = {};
  function productFor(card) {
    var C = window.NTAGZ_CATALOG; if (!C) return null;
    var b = card.querySelector('[data-product-id]') || card, id = b.getAttribute && b.getAttribute('data-product-id'); if (id) return C.byId(id);
    var d = (card.getAttribute('data-detail') || '').replace(/^\/+|\/+$/g, ''), list = [];
    C.products.forEach(function (p) { if (p.detail && p.detail.replace(/^\/+|\/+$/g, '') === d) list.push(p); });
    return list.length === 1 ? list[0] : null;
  }
  function priceBlock(p, info) {
    var b = el('div', 'mk-price');
    if (!info) { var na = el('div', 'mk-na', 'Not available for online international orders. '); var a = el('a', null, 'Send an enquiry'); a.href = base + 'international.html#enquiry'; na.appendChild(a); b.appendChild(na); return b; }
    if (info.customQuote) { var cq = el('div', 'mk-na', 'Made to order. '); var a2 = el('a', null, 'Request a quotation'); a2.href = base + 'international.html#enquiry'; cq.appendChild(a2); b.appendChild(cq); return b; }
    var row = el('div'); row.appendChild(el('span', 'mk-now', usd(info.priceCents))); row.appendChild(el('span', 'mk-unit', '/ ' + ((p && p.unit) || 'pc')));
    b.appendChild(row);
    if (info.tiers && info.tiers.length) { var last = info.tiers[info.tiers.length - 1]; b.appendChild(el('div', 'mk-tier', 'Quantity prices from ' + usd(last.unitCents) + ' at ' + last.minQty + '+')); }
    var bits = ['Excl. shipping and taxes', 'Shipping quoted separately'];
    if (info.moq > 1) bits.push('Min. order ' + info.moq);
    if (info.leadDays) bits.push('Lead time about ' + info.leadDays + ' days');
    b.appendChild(el('div', 'mk-sub', bits.join(' · ')));
    return b;
  }
  function overlay() {
    if (!isIntl()) return;
    Promise.all([catalog(), config()]).then(function (r) {
      var cat = r[0], cfg = r[1]; if (!cfg.enabled) return;
      document.querySelectorAll('.mk-price').forEach(function (n) { n.remove(); });
      var targets = [];
      document.querySelectorAll('.product-card[data-detail]').forEach(function (card) { var p = productFor(card), pe = card.querySelector('.product-price'); if (p && pe) { card.classList.add('mk-intl'); targets.push({ p: p, after: pe, card: card }); } });
      var pp = document.querySelector('.prod-price'), m = /\/product\/([^/]+)\/?$/.exec(location.pathname);
      if (pp && m) {
        document.body.classList.add('mk-intl'); var C = window.NTAGZ_CATALOG, list = [];
        if (C) C.products.forEach(function (p) { if (p.detail && p.detail.replace(/^\/+|\/+$/g, '') === 'product/' + decodeURIComponent(m[1])) list.push(p); });
        if (list.length === 1) targets.push({ p: list[0], after: pp, page: true });
      }
      targets.forEach(function (t) {
        var info = cat[t.p.id], blk = priceBlock(t.p, info); t.after.parentNode.insertBefore(blk, t.after.nextSibling);
        if (t.page) {
          var row = document.querySelector('.prod-cta-row');
          if (row && info && !info.customQuote) { row.textContent = ''; var a = el('a', 'btn btn-tagz', 'Order internationally'); a.href = base + 'international-checkout.html?add=' + encodeURIComponent(t.p.id) + '&qty=' + info.moq; row.appendChild(a); }
          else if (row) { row.textContent = ''; var e = el('a', 'btn btn-tagz', 'Send an enquiry'); e.href = base + 'international.html#enquiry'; row.appendChild(e); }
        }
        if (t.card && (!info || info.customQuote)) { var btn = t.card.querySelector('[data-product-id][data-cart-wired]'); if (btn) { btn.setAttribute('data-mk-na', '1'); btn.textContent = 'Enquire'; } }
      });
    });
  }

  /* ── cart (capture phase so the domestic add-to-cart and member prompt never see international clicks) ── */
  var CART = function () { return window.NTAGZ_CART; };
  document.addEventListener('click', function (e) {
    if (!isIntl()) return;
    var btn = e.target.closest && e.target.closest('[data-product-id][data-cart-wired]'); if (!btn) return;
    e.preventDefault(); e.stopImmediatePropagation();
    var id = btn.dataset.productId;
    catalog().then(function (cat) {
      var info = cat[id];
      if (!info || info.customQuote) { location.href = base + 'international.html#enquiry'; return; }
      var cart = CART().read(); if (!cart[id]) CART().setQty(id, info.moq || 1); else CART().setQty(id, cart[id]);
      btn.classList.add('is-added'); setTimeout(function () { btn.classList.remove('is-added'); }, 1200);
      var o = document.querySelector('[data-cart-open]'); if (o) o.click();
    });
  }, true);

  /* the drawer: USD lines priced by the server, quantity editing (quantity breaks matter), shipping status, request-a-quote button */
  var price = { key: '', data: null, err: null, timer: null };
  function itemsOf(cart) { return Object.keys(cart).map(function (id) { return { id: id, qty: cart[id] }; }); }
  function fetchPrice(cart, done) {
    var items = itemsOf(cart), key = JSON.stringify(items);
    if (!items.length) { price = { key: key, data: null, err: null, timer: null }; return; }
    if (price.key === key) return;
    clearTimeout(price.timer);
    price.timer = setTimeout(function () {
      fetch('/api/intl/price', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items }) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) { price.key = key; price.data = x.ok ? x.d : null; price.err = x.ok ? null : x.d; done(); })
        .catch(function () { price.key = key; price.data = null; price.err = { error: 'We could not price your cart right now. Please try again.' }; done(); });
    }, 200);
  }
  function renderDrawer(cart, body, foot) {
    var ids = Object.keys(cart);
    body.textContent = ''; foot.textContent = '';
    if (!ids.length) { body.appendChild(el('div', 'cart-empty', 'Your cart is empty.')); return true; }
    var again = function () { var d = document.querySelector('.cart-drawer-root'); if (d && d.classList.contains('open')) renderDrawer(CART().read(), document.getElementById('cartDrawerBody'), document.getElementById('cartDrawerFoot')); };
    fetchPrice(cart, again);
    var lines = {}; if (price.data && price.data.lines) price.data.lines.forEach(function (l) { lines[l.id] = l; });
    ids.forEach(function (id) {
      var C = window.NTAGZ_CATALOG, p = C && C.byId(id), ln = lines[id];
      var row = el('div', 'cart-line mk-line'), info = el('div', 'cart-line-body');
      info.appendChild(el('div', 'cart-line-name', p ? p.name : id));
      var q = el('input'); q.type = 'number'; q.min = '1'; q.max = '100000'; q.value = cart[id]; q.setAttribute('aria-label', 'Quantity of ' + (p ? p.name : id));
      q.addEventListener('change', function () { var v = Math.max(parseInt(q.value, 10) || 1, 1); CART().setQty(id, v); });
      info.appendChild(q);
      if (ln) info.appendChild(el('div', 'cart-line-meta', usd(ln.unitCents) + ' each' + (ln.tierMinQty ? ' · quantity price' : '')));
      row.appendChild(info);
      row.appendChild(el('div', 'cart-line-total', ln ? usd(ln.lineCents) : '…'));
      var rm = el('button', 'cart-line-remove', '×'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove ' + (p ? p.name : id)); rm.addEventListener('click', function () { CART().remove(id); });
      row.appendChild(rm); body.appendChild(row);
    });
    var sub = el('div', 'cart-subtotal-row'); sub.appendChild(el('span', null, 'Product subtotal')); sub.appendChild(el('span', null, price.data ? usd(price.data.subtotalCents) : '…')); foot.appendChild(sub);
    if (price.data && price.data.savingsCents) { var sv = el('div', 'cart-subtotal-row'); sv.appendChild(el('span', null, 'Quantity savings')); sv.appendChild(el('span', null, '− ' + usd(price.data.savingsCents))); foot.appendChild(sv); }
    foot.appendChild(el('p', 'mk-note', 'Shipping: quotation required. International shipping is quoted separately and confirmed with you before dispatch. Prices exclude taxes unless a quotation says otherwise.'));
    if (price.err) foot.appendChild(el('p', 'mk-warn', price.err.error));
    if (price.data && price.data.leadDays) foot.appendChild(el('p', 'mk-note', 'Estimated production lead time: about ' + price.data.leadDays + ' days.'));
    var go = el('a', 'btn btn-tagz btn-block cart-checkout-btn', 'Request shipping quote →'); go.href = base + 'international-checkout.html';
    if (!price.data) go.setAttribute('aria-disabled', 'true'); foot.appendChild(go);
    var sw = el('p', 'mp-foot'); var ch = el('button', 'mp-link', 'Change country'); ch.type = 'button'; ch.addEventListener('click', openSelector); sw.appendChild(document.createTextNode('Destination: ' + market().country + ' · ')); sw.appendChild(ch); foot.appendChild(sw);
    return true;
  }
  document.addEventListener('ntagz:cart-change', function () { price.key = ''; });

  /* ── order.html is the India checkout ── */
  if (isIntl() && /\/order\.html$/.test(location.pathname)) { location.replace(base + 'international-checkout.html'); }

  function start() {
    mountButton(); banner(); overlay();
    document.addEventListener('ntagz:header-loaded', function () { mountButton(); });
    var tries = 0, t = setInterval(function () { mountButton(); if (++tries > 40) clearInterval(t); }, 150);   // the header is injected asynchronously
    if (window.NTAGZ_LIVE && window.NTAGZ_LIVE.ready) window.NTAGZ_LIVE.ready.then(function () { setTimeout(overlay, 60); });
    var grid = document.getElementById('productsGrid'); if (grid) new MutationObserver(function () { setTimeout(overlay, 80); }).observe(grid, { childList: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  window.NTAGZ_MARKET = { isIntl: isIntl, country: function () { return market().country; }, config: config, catalog: catalog, open: openSelector, renderDrawer: renderDrawer, usd: usd,
    set: function (code) { set(KEY, !code || code === 'IN' ? null : JSON.stringify({ country: code })); } };
})();
