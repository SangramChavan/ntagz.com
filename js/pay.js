/* ntagz payment page. Two kinds of link:
   - pay.html?t=<token>   a payment link: the server prices the order fresh, we show it, then open Razorpay for exactly that amount.
   - pay.html?o=<order>&k=<key>   the first agent links (an order that already exists). Kept so links already sent keep working.
   Every number and word that came from the server is inserted with textContent, never as HTML. */
(function () {
  'use strict';
  var q = new URLSearchParams(location.search), TOKEN = q.get('t') || '', ORDER = q.get('o') || '', KEY = q.get('k') || '';
  var API = '/api'; /* same origin: ntagz.com/api/* is the payments Worker, so a signed-in member's cookie reaches it and member prices apply */
  var WA = '919960160016';
  var root = document.getElementById('root'), view = null, busy = false;

  var inr = function (n) { n = Number(n) || 0; return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function waHref(msg) { return 'https://wa.me/' + WA + '?text=' + encodeURIComponent(msg); }

  /* ── screens that are not the order ── */
  function stateCard(title, text, withWa) {
    clear(root);
    var c = el('div', 'card state'); c.appendChild(el('h1', null, title)); if (text) c.appendChild(el('p', 'sub', text));
    if (withWa) { var a = el('a', 'btn', 'Message us on WhatsApp'); a.href = waHref('Hi ntagz, I need help with my payment link' + (TOKEN ? ' (ref ' + TOKEN.slice(0, 8) + ')' : '') + '.'); a.target = '_blank'; a.rel = 'noopener'; c.appendChild(a); }
    root.appendChild(c);
  }

  /* ── api ── */
  function api(path, body) {
    var opts = body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return fetch(API + path, opts).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); });
  }

  /* ── the order ── */
  function when(ts) { return new Date(ts * 1000).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
  function leftText(ts) { var s = ts - Math.floor(Date.now() / 1000); if (s <= 0) return ''; var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h >= 24 ? '' : h >= 1 ? ' (' + h + ' h ' + m + ' min left)' : ' (' + Math.max(m, 1) + ' min left)'; }
  function lineOf(id) { for (var i = 0; i < view.lines.length; i++) if (view.lines[i].id === id) return view.lines[i]; return null; }

  function nudgeCard(n) {
    var l = lineOf(n.id), c = el('div', 'nudge'), extra = n.extraAmount;
    var cost = extra > 0 ? ' This adds ' + inr(extra) + ' to your total (incl. GST).' : ' Your total stays about the same.';
    if (n.type === 'tier') {
      c.appendChild(el('b', null, 'Add ' + n.addQty + ' more ' + n.name + ' and pay less per piece'));
      c.appendChild(el('p', null, 'At ' + n.tierMinPieces + '+ pieces every one costs ' + inr(n.unitNext) + ' instead of ' + inr(n.unitNow) + ' (' + n.tierPct + '% off), which saves ' + inr(n.savingOnCurrent) + ' on the ' + (l ? l.qty : '') + ' you already have (before GST).' + cost));
    } else {
      c.appendChild(el('b', null, 'You are ' + inr(n.remaining) + ' away from free shipping'));
      c.appendChild(el('p', null, 'Add ' + n.addQty + ' more ' + n.name + ' and we cover the ' + inr(n.shippingSaved) + ' shipping.' + (extra > 0 ? ' Net extra: ' + inr(extra) + ' incl. GST.' : '')));
    }
    var b = el('button', 'small', 'Add ' + n.addQty + ' more'); b.type = 'button'; b.addEventListener('click', function () { adjust(n.action.id, n.action.qty, b); });
    c.appendChild(b); return c;
  }

  function totalsRows(t) {
    var wrap = document.createDocumentFragment();
    function row(label, val, cls) { var r = el('div', 'row' + (cls ? ' ' + cls : '')); r.appendChild(el('span', null, label)); r.appendChild(el('span', null, val)); wrap.appendChild(r); }
    row('Items (before discounts)', inr(t.listTotal));
    if (t.bulkDiscount > 0) row('Quantity discount', '− ' + inr(t.bulkDiscount), 'off');
    if (t.memberDiscount > 0) row('Member discount', '− ' + inr(t.memberDiscount), 'off');
    if (t.partnerDiscount > 0) row('Partner price', '− ' + inr(t.partnerDiscount), 'off');
    if (t.offer && t.offer.discount > 0) row(t.offer.name, '− ' + inr(t.offer.discount), 'off');
    if (t.gst > 0) row('GST (18%)', '+ ' + inr(t.gst));
    row('Shipping', t.shipping > 0 ? '+ ' + inr(t.shipping) : 'Free');
    if (t.stockCredit > 0) { row('Order total', inr(t.orderTotal)); row('Paid from your opening stock credit', '− ' + inr(t.stockCredit), 'off'); }
    return wrap;
  }

  function render() {
    clear(root);
    var t = view.totals, head = el('div', 'card');
    head.appendChild(el('h1', null, 'Hi ' + view.name + ', your order is ready'));
    head.appendChild(el('p', 'sub', 'Check it over, then pay securely. This link is valid until ' + when(view.expiresAt) + leftText(view.expiresAt) + '.'));
    root.appendChild(head);
    if (view.priceChanged) root.appendChild(el('div', 'note', 'The price has changed since this link was made: ' + inr(view.priceChanged.was) + ' before, ' + inr(view.priceChanged.now) + ' now. Please check the total below.'));
    if (view.memberPricing) root.appendChild(el('div', 'note', 'Member prices applied.'));

    var items = el('div', 'card'); items.appendChild(el('h2', null, 'Your order'));
    view.lines.forEach(function (l) {
      var r = el('div', 'line'), b = el('b', null, l.name); r.appendChild(b); r.appendChild(el('span', 'amt', inr(l.total)));
      var meta = l.qty + ' × ' + inr(l.unit) + (l.unit < l.listUnit - 0.004 ? ' (list ' + inr(l.listUnit) + ')' : '') + (l.inclusive ? ' · GST & shipping included' : '') + (l.qty !== l.origQty ? ' · you added ' + (l.qty - l.origQty) : '');
      r.appendChild(el('span', 'meta', meta)); items.appendChild(r);
    });
    root.appendChild(items);

    view.nudges.forEach(function (n) { root.appendChild(nudgeCard(n)); });
    if (view.adjusted) { var u = el('button', 'link', 'Undo my changes'); u.type = 'button'; u.addEventListener('click', undo); var uw = el('div'); uw.style.textAlign = 'center'; uw.appendChild(u); root.appendChild(uw); }

    var sum = el('div', 'card'); sum.appendChild(totalsRows(t));
    var tot = el('div', 'total'); tot.appendChild(el('span', null, t.stockCredit > 0 ? 'To pay now' : 'Total')); tot.appendChild(el('span', null, inr(t.amount))); sum.appendChild(tot);
    sum.appendChild(el('p', 'sub', 'Delivering to ' + view.deliverTo.pincode + ', ' + view.deliverTo.state + '.' + (view.dispatchDays ? ' Made to order: dispatch within ' + view.dispatchDays + ' working days of payment.' : '')));
    root.appendChild(sum);

    var pay = el('button', 'primary', 'Pay ' + inr(t.amount)); pay.type = 'button'; pay.id = 'pay'; pay.addEventListener('click', function () { start(pay); });
    root.appendChild(pay);
    var err = el('p'); err.id = 'err'; err.setAttribute('role', 'alert'); root.appendChild(err);
    var trust = el('div', 'trust'); ['UPI, cards and netbanking', 'Secure payment by Razorpay', 'GST invoice after payment'].forEach(function (x) { trust.appendChild(el('span', null, x)); });
    root.appendChild(trust);
    var help = el('p', 'sub'); help.style.textAlign = 'center'; help.style.marginTop = '12px'; help.appendChild(document.createTextNode('Questions? '));
    var a = el('a', null, 'Message us on WhatsApp'); a.href = waHref('Hi ntagz, a question about my payment link (ref ' + TOKEN.slice(0, 8) + ').'); a.target = '_blank'; a.rel = 'noopener'; help.appendChild(a); root.appendChild(help);
  }

  function say(msg) { var e = document.getElementById('err'); if (e) e.textContent = msg || ''; }

  function showResult(r) {
    var d = r.d || {};
    if (r.status === 404) return stateCard('This payment link is not valid', 'Please check the link, or message us and we will send a new one.', true);
    if (r.status === 503) return stateCard('Payment links are not available yet', 'Please try again in a little while, or message us on WhatsApp.', true);
    if (r.status === 429) return stateCard('Too many attempts', 'Please wait a few minutes and try again.', true);
    if (d.status === 'paid') return stateCard('This order is already paid', 'Thank you! We will keep you updated on WhatsApp.', false);
    if (d.status === 'expired') return stateCard('This payment link has expired', 'Prices and stock change, so links only last a short time. Message us and we will send a fresh one.', true);
    if (d.status === 'cancelled') return stateCard('This payment link was cancelled', 'Message us if you would like a new one.', true);
    if (d.status === 'unavailable' || d.status === 'error') return stateCard('We cannot take this order right now', d.message || 'Something in this order is no longer available.', true);
    if (d.status === 'active') { view = d; return render(); }
    return stateCard('Something went wrong', 'Please try again, or message us on WhatsApp.', true);
  }

  function load() { return api('/pay/' + TOKEN).then(showResult, function () { stateCard('Could not load your order', 'Check your connection and reload this page.', true); }); }

  function adjust(id, qty, btn) {
    if (busy) return; busy = true; if (btn) btn.disabled = true;
    api('/pay/' + TOKEN + '/adjust', { id: id, qty: qty }).then(function (r) { busy = false; if (r.ok && r.d.status === 'active') showResult(r); else { if (btn) btn.disabled = false; say(r.d.error || 'Could not change the order. Please try again.'); } }, function () { busy = false; if (btn) btn.disabled = false; say('Network problem. Please try again.'); });
  }
  function undo() { /* put every changed line back to the quantity the link was made with, one call per line */
    var pending = view.lines.filter(function (l) { return l.qty !== l.origQty; });
    if (!pending.length || busy) return; busy = true;
    (function next(i, last) {
      if (i >= pending.length) { busy = false; return showResult(last); }
      api('/pay/' + TOKEN + '/adjust', { id: pending[i].id, qty: pending[i].origQty }).then(function (r) { if (!r.ok) { busy = false; return say(r.d.error || 'Could not undo. Please try again.'); } next(i + 1, r); }, function () { busy = false; say('Network problem. Please try again.'); });
    })(0, null);
  }

  /* ── paying ── */
  function loadRzp(cb) {
    if (window.Razorpay) return cb();
    var s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js'; s.onload = cb;
    s.onerror = function () { say('Could not load the payment window. Allow checkout.razorpay.com and try again.'); var b = document.getElementById('pay'); if (b) b.disabled = false; };
    document.head.appendChild(s);
  }
  function done(ok, paymentId) {
    /* confirm.html reads an order.html snapshot (invoice, account link); a leftover one would belong to a different order. */
    if (ok) try { localStorage.removeItem('ntagz_pending_order'); } catch (e) { }
    location.href = '/order/confirm.html?' + new URLSearchParams(ok ? { status: 'success', gateway: 'razorpay', orderId: paymentId } : { status: 'failed', gateway: 'razorpay' });
  }
  function openRazorpay(key, orderId, amountPaise, prefill, btn) {
    loadRzp(function () {
      var rz = new Razorpay({
        key: key, order_id: orderId, amount: amountPaise, currency: 'INR', name: 'nTagz', description: 'Order payment', prefill: prefill || {}, theme: { color: '#e5470d' },
        /* UPI first; show_default_blocks keeps every other method available after it, so nothing can be lost if the config is ignored. */
        config: { display: { blocks: { upi: { name: 'Pay with UPI', instruments: [{ method: 'upi' }] } }, sequence: ['block.upi'], preferences: { show_default_blocks: true } } },
        handler: function (r) {
          api('/verify-payment', { razorpay_order_id: r.razorpay_order_id, razorpay_payment_id: r.razorpay_payment_id, razorpay_signature: r.razorpay_signature })
            .then(function (x) { done(x.ok, r.razorpay_payment_id); }, function () { done(false); });
        },
        modal: { ondismiss: function () { if (btn) btn.disabled = false; } }
      });
      rz.on('payment.failed', function (r) { if (btn) btn.disabled = false; say('The payment did not go through' + (r && r.error && r.error.description ? ': ' + r.error.description : '') + '. You can try again.'); });
      rz.open();
    });
  }
  function start(btn) {
    if (busy) return; busy = true; btn.disabled = true; say('');
    api('/pay/' + TOKEN + '/start', {}).then(function (r) {
      busy = false;
      if (!r.ok) { btn.disabled = false; if (r.status === 409 || r.status === 404) return load(); return say(r.d.error || 'Could not start the payment. Please try again.'); }
      /* Pay only the amount the customer was shown. If the price moved since, show the new total and ask again. */
      if (r.d.amountPaise !== Math.round(view.totals.amount * 100)) { load().then(function () { say('The price changed just now. Please check the new total and tap Pay again.'); }); return; }
      openRazorpay(r.d.keyId, r.d.orderId, r.d.amountPaise, r.d.prefill, btn);
    }, function () { busy = false; btn.disabled = false; say('Network problem. Please try again.'); });
  }

  /* ── first-generation agent links: the order already exists, so there is nothing to show but the button ── */
  function legacy() {
    clear(root);
    var c = el('div', 'card state'); c.appendChild(el('h1', null, 'Pay for your order')); c.appendChild(el('p', 'sub', 'Secure payment by Razorpay (UPI, cards, netbanking).'));
    var b = el('button', 'primary', 'Pay now'); b.type = 'button'; c.appendChild(b); var err = el('p'); err.id = 'err'; err.setAttribute('role', 'alert'); c.appendChild(err); root.appendChild(c);
    b.addEventListener('click', function () { b.disabled = true; say(''); openRazorpay(KEY, ORDER, undefined, null, b); });
  }

  if (/^[0-9a-f]{32}$/.test(TOKEN)) load();
  else if (/^order_\w{6,40}$/.test(ORDER) && /^rzp_(live|test)_\w{6,40}$/.test(KEY)) legacy();
  else stateCard('This payment link is not valid', 'Please check the link, or message us and we will send a new one.', true);
})();
