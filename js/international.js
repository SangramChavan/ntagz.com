/* /international.html — destination picker (sets the display market) and the enquiry form. Server rules apply; this only guides. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var KEY = 'ntagz.market';
  var cfg = null;

  function fillCountries(list) {
    var sel = $('icCountry'), dl = $('eCountries');
    list.forEach(function (c) { sel.appendChild(new Option(c.name, c.code)); var o = document.createElement('option'); o.value = c.name; dl.appendChild(o); });
    try { var m = JSON.parse(localStorage.getItem(KEY) || 'null'); if (m && m.country && m.country !== 'IN') sel.value = m.country; } catch (e) { }
    $('icShop').disabled = !sel.value;
  }

  fetch('/api/intl/config', { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : { enabled: false }; }).catch(function () { return { enabled: false }; }).then(function (c) {
    cfg = c;
    if (c.enabled) { $('icStatus').textContent = 'International ordering is open. Pick your country to see USD prices.'; fillCountries(c.countries || []); $('icUnsupported').hidden = false; }
    else { $('icStatus').textContent = 'Online international ordering is not open yet. Please send us an enquiry below and we will help with your order and shipping quotation.'; $('icCountry').disabled = true; }
  });
  $('icCountry').addEventListener('change', function () { $('icShop').disabled = !this.value; });
  $('icShop').addEventListener('click', function () {
    var v = $('icCountry').value; if (!v) return;
    try { localStorage.setItem(KEY, JSON.stringify({ country: v })); sessionStorage.removeItem('ntagz.market.notice'); } catch (e) { }
    location.href = 'index.html#products';
  });

  var form = $('icEnq');
  var show = function (id, msg) { var e = $('err-' + id); if (e) e.textContent = msg || ''; };
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    ['name', 'email', 'country', 'message'].forEach(function (k) { show(k, ''); }); $('eErr').textContent = ''; $('eOk').hidden = true;
    var b = { name: $('eName').value, email: $('eEmail').value, country: $('eCountry').value, company: $('eCompany').value, product: $('eProduct').value, quantity: $('eQty').value, customization: $('eCustom').value, shipping_pref: $('eShip').value, message: $('eMsg').value, website: $('eWeb').value };
    var bad = false;
    if (b.name.trim().length < 2) { show('name', 'Enter your name'); bad = true; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(b.email.trim())) { show('email', 'Enter a valid email'); bad = true; }
    if (b.country.trim().length < 2) { show('country', 'Enter your country'); bad = true; }
    if (b.message.trim().length < 5 && b.product.trim().length < 2) { show('message', 'Tell us what you need'); bad = true; }
    if (bad) return;
    var btn = $('eSend'); btn.disabled = true; btn.textContent = 'Sending…';
    fetch('/api/intl/enquiries', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (x.ok) { form.reset(); var o = $('eOk'); o.textContent = 'Thank you. We received your enquiry' + (x.d.reference ? ' (reference ' + x.d.reference + ')' : '') + ' and will reply by email.'; o.hidden = false; }
        else { if (x.d.fields) Object.keys(x.d.fields).forEach(function (k) { show(k, x.d.fields[k]); }); $('eErr').textContent = x.d.error || 'We could not send your enquiry. Please email hello@ntagz.com.'; }
      })
      .catch(function () { $('eErr').textContent = 'We could not send your enquiry. Please check your connection or email hello@ntagz.com.'; })
      .then(function () { btn.disabled = false; btn.textContent = 'Send enquiry'; });
  });
})();
