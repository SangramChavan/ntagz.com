/* /international-checkout.html — cart review (server-priced USD), shipping notice, country-aware details, order submission.
   The browser sends only product ids and quantities; the server prices the cart, validates the address for the chosen country,
   records the policy acknowledgement and creates the order unpaid with "shipping quotation required". */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  var usd = function (c) { return 'US$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var CART = function () { return window.NTAGZ_CART; };
  var cfg = null, countries = {}, priced = null, timer = null, subId = null;
  try { subId = sessionStorage.getItem('ntagz.intl.sub'); if (!subId) { subId = crypto.randomUUID(); sessionStorage.setItem('ntagz.intl.sub', subId); } } catch (e) { subId = crypto.randomUUID(); }

  function gate(msg) { var g = $('icoGate'); g.textContent = ''; g.appendChild(document.createTextNode(msg + ' ')); var a = el('a', null, 'Send an enquiry'); a.href = 'international.html#enquiry'; g.appendChild(a); g.hidden = false; $('icoForm').hidden = true; }

  /* add=<id>&qty=<n> from a product page */
  (function () {
    var q = new URLSearchParams(location.search), id = q.get('add');
    if (id && /^[a-z0-9-]{1,64}$/.test(id) && CART()) { var n = Math.min(Math.max(parseInt(q.get('qty'), 10) || 1, 1), 100000), cur = CART().read(); if (!cur[id]) CART().setQty(id, n); }
    if (id) history.replaceState(null, '', location.pathname);
  })();

  function renderCart() {
    var host = $('icoLines'); host.textContent = '';
    var cart = CART() ? CART().read() : {}, ids = Object.keys(cart);
    if (!ids.length) { host.appendChild(el('p', null, 'Your cart is empty. ')); var a = el('a', null, 'Browse products'); a.href = 'index.html#products'; host.lastChild.appendChild(a); $('icoForm').hidden = true; return; }
    $('icoForm').hidden = !(cfg && cfg.enabled);
    var lines = {}; if (priced && priced.lines) priced.lines.forEach(function (l) { lines[l.id] = l; });
    var t = el('table'), th = el('thead'), hr = el('tr');
    ['Product', 'Qty', 'Unit', 'Total'].forEach(function (h) { hr.appendChild(el('th', null, h)); }); th.appendChild(hr); t.appendChild(th);
    var tb = el('tbody');
    ids.forEach(function (id) {
      var C = window.NTAGZ_CATALOG, p = C && C.byId(id), ln = lines[id], tr = el('tr');
      var c1 = el('td'); c1.appendChild(el('div', null, p ? p.name : id)); var rm = el('button', 'fine', 'Remove'); rm.type = 'button'; rm.style.cssText = 'background:none;border:0;padding:0;text-decoration:underline;cursor:pointer'; rm.addEventListener('click', function () { CART().remove(id); refresh(); }); c1.appendChild(rm);
      var c2 = el('td'), q = el('input', 'qty'); q.type = 'number'; q.min = '1'; q.max = '100000'; q.value = cart[id]; q.setAttribute('aria-label', 'Quantity of ' + (p ? p.name : id));
      q.addEventListener('change', function () { CART().setQty(id, Math.max(parseInt(q.value, 10) || 1, 1)); refresh(); }); c2.appendChild(q);
      tr.appendChild(c1); tr.appendChild(c2); tr.appendChild(el('td', null, ln ? usd(ln.unitCents) + (ln.tierMinQty ? ' (quantity price)' : '') : '…')); tr.appendChild(el('td', null, ln ? usd(ln.lineCents) : '…')); tb.appendChild(tr);
    });
    t.appendChild(tb);
    var sub = el('tr', 'tot'); sub.appendChild(el('td', null, 'Product subtotal')); sub.appendChild(el('td')); sub.appendChild(el('td')); sub.appendChild(el('td', null, priced ? usd(priced.subtotalCents) : '…')); tb.appendChild(sub);
    host.appendChild(t);
    if (priced && priced.savingsCents) host.appendChild(el('p', 'fine', 'Includes quantity savings of ' + usd(priced.savingsCents) + '.'));
    host.appendChild(el('p', null, 'Shipping: quotation required. Taxes and duties: not included unless your quotation says so.'));
    if (priced && priced.leadDays) host.appendChild(el('p', 'fine', 'Estimated production lead time: about ' + priced.leadDays + ' days, before shipping.'));
    host.appendChild(el('p', 'fine', 'This order is currently product-only. Your quotation will show whether it covers products only, products plus shipping, or products, shipping and specified taxes.'));
    if (priced && priced.error) host.appendChild(el('p', 'err', priced.error));
  }

  function price() {
    var cart = CART() ? CART().read() : {}, items = Object.keys(cart).map(function (id) { return { id: id, qty: cart[id] }; });
    if (!items.length) { priced = null; renderCart(); return; }
    clearTimeout(timer);
    timer = setTimeout(function () {
      fetch('/api/intl/price', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items }) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) { priced = x.ok ? x.d : { error: x.d.error || 'We could not price your cart.' }; renderCart(); $('icoSubmit').disabled = !x.ok; })
        .catch(function () { priced = { error: 'We could not price your cart right now. Please try again.' }; renderCart(); $('icoSubmit').disabled = true; });
    }, 150);
  }
  function refresh() { renderCart(); price(); }

  function applyCountry() {
    var c = countries[$('fCountry').value];
    $('lRegion').textContent = c ? c.regionLabel : 'State / Province / Region'; $('lPostal').textContent = c ? c.postalLabel : 'Postal code';
    $('fRegion').required = !!(c && c.regionRequired); $('fPostal').required = !!(c && c.postalRequired);
    if (c && (!$('fPhone').value.trim() || /^\+\d{0,4}\s?$/.test($('fPhone').value.trim()))) $('fPhone').value = c.dial + ' ';
  }

  function fieldErr(k, msg) { var e = $('err-' + k); if (e) e.textContent = msg || ''; var map = { name: 'fName', email: 'fEmail', phone: 'fPhone', country: 'fCountry', address1: 'fAddr1', city: 'fCity', region: 'fRegion', postal: 'fPostal' }; var i = $(map[k]); if (i) i.classList.toggle('bad', !!msg); }
  ['name', 'email', 'phone', 'country', 'address1', 'city', 'region', 'postal', 'accept_terms'].forEach(function (k) { fieldErr(k, ''); });

  $('icoForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    ['name', 'email', 'phone', 'country', 'address1', 'city', 'region', 'postal', 'accept_terms'].forEach(function (k) { fieldErr(k, ''); }); $('icoErr').textContent = '';
    var cart = CART().read(), items = Object.keys(cart).map(function (id) { return { id: id, qty: cart[id] }; });
    var b = { submission_id: subId, items: items, country: $('fCountry').value, name: $('fName').value, company: $('fCompany').value, email: $('fEmail').value, address1: $('fAddr1').value, address2: $('fAddr2').value, city: $('fCity').value,
      region: $('fRegion').value, postal: $('fPostal').value, phone: $('fPhone').value, tax_id: $('fTax').value, notes: $('fNotes').value, accept_terms: $('fTerms').checked, website: $('fWeb').value };
    var btn = $('icoSubmit'); btn.disabled = true; btn.textContent = 'Submitting…';
    fetch('/api/intl/orders', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (!x.ok) { if (x.d.fields) Object.keys(x.d.fields).forEach(function (k) { fieldErr(k, x.d.fields[k]); }); $('icoErr').textContent = x.d.error || 'We could not submit your order. Please try again.'; var f = document.querySelector('.bad'); if (f) f.focus(); return; }
        CART().clear(); try { sessionStorage.removeItem('ntagz.intl.sub'); } catch (e) { }
        ['icoCart', 'icoForm'].forEach(function (id) { $(id).hidden = true; });
        var d = $('icoDone'); d.textContent = '';
        d.appendChild(el('h2', null, 'Order received')); d.lastChild.style.marginTop = '0';
        d.appendChild(el('p', null, 'Your order number is ' + x.d.orderNumber + '. We emailed you a confirmation. Nothing has been charged.'));
        d.appendChild(el('p', null, 'Next: we review your destination and send you a shipping quotation by email. You then accept or decline it, and pay only the accepted amount. Dispatch follows payment.'));
        var a = el('a', 'btn-primary', 'View your order'); a.href = x.d.viewUrl.replace('https://ntagz.com', ''); a.style.marginTop = '8px'; d.appendChild(a); d.hidden = false; d.scrollIntoView();
      })
      .catch(function () { $('icoErr').textContent = 'We could not submit your order. Please check your connection and try again. If it keeps failing, email hello@ntagz.com.'; })
      .then(function () { btn.disabled = false; btn.textContent = 'Submit order and request shipping quote'; });
  });

  fetch('/api/intl/config', { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : { enabled: false }; }).catch(function () { return { enabled: false }; }).then(function (c) {
    cfg = c;
    if (!c.enabled) { gate('Online international ordering is not open yet.'); renderCart(); return; }
    var sel = $('fCountry'); (c.countries || []).forEach(function (x) { countries[x.code] = x; sel.appendChild(new Option(x.name, x.code)); });
    try { var m = JSON.parse(localStorage.getItem('ntagz.market') || 'null'); if (m && countries[m.country]) sel.value = m.country; } catch (e) { }
    sel.addEventListener('change', applyCountry); applyCountry();
    document.addEventListener('ntagz:cart-change', function () { refresh(); });
    var tries = 0, w = setInterval(function () { if (CART() && window.NTAGZ_CATALOG) { clearInterval(w); refresh(); } else if (++tries > 40) { clearInterval(w); refresh(); } }, 100);
  });
})();
