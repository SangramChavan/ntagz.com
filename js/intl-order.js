/* /order/international.html — the customer's own order: quotation (accept / decline), payment instructions, timeline, tracking.
   Everything displayed comes from GET /api/intl/order (secret link token). "Paid" is shown only when the server says it is. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  var q = new URLSearchParams(location.search), O = q.get('o'), T = q.get('t');
  var money = function (c, cur) { return (cur === 'USD' ? 'US$' : cur === 'INR' ? '₹' : cur + ' ') + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var when = function (s) { return new Date(s * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  var day = function (s) { return s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : ''; };
  var httpsOnly = function (u) { try { var x = new URL(u); return x.protocol === 'https:' ? x.href : ''; } catch (e) { return ''; } };
  var row = function (a, b) { var tr = el('tr'); tr.appendChild(el('td', null, a)); tr.appendChild(el('td', null, b)); return tr; };

  function statusChips(d) {
    var box = el('div');
    var chip = function (t, cls) { box.appendChild(el('span', 'status ' + (cls || ''), t)); };
    chip(d.paymentStatus === 'paid' ? 'Paid' : d.paidMinor > 0 ? 'Part paid' : 'Payment pending', d.paymentStatus === 'paid' ? 'good' : 'warn');
    var qs = { required: 'Shipping quotation required', sent: 'Quotation awaiting your answer', accepted: 'Quotation accepted', declined: 'Quotation declined', expired: 'Quotation expired' };
    chip(qs[d.quoteStatus] || d.quoteStatus, d.quoteStatus === 'accepted' ? 'good' : 'warn');
    if (d.destinationStatus === 'rejected') chip('Destination not supported', 'warn');
    var f = { placed: 'Order received', confirmed: 'Confirmed', processing: 'Processing', packed: 'Packed', shipped: 'Dispatched', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled', returned: 'Returned', on_hold: 'On hold' };
    chip(f[d.fulfilment] || d.fulfilment, d.fulfilment === 'shipped' || d.fulfilment === 'delivered' ? 'good' : '');
    return box;
  }

  function render(d) {
    var host = $('ioBody'); host.textContent = ''; $('ioLoad').hidden = true; host.hidden = false;
    var head = el('section', 'ix-card');
    head.appendChild(el('p', 'fine', 'Order number')); head.appendChild(el('h2', null, d.orderNumber)); head.lastChild.style.margin = '0 0 8px';
    head.appendChild(statusChips(d)); head.appendChild(el('p', 'fine', 'Placed ' + when(d.createdAt) + ' · Destination ' + d.country + ' · Prices in ' + d.currency));
    host.appendChild(head);

    var items = el('section', 'ix-card'); items.appendChild(el('h3', null, 'Items'));
    var t = el('table'), tb = el('tbody');
    var C = window.NTAGZ_CATALOG;
    d.items.forEach(function (i) { var tr = el('tr'); tr.appendChild(el('td', null, i.qty + ' × ' + i.name)); tr.appendChild(el('td', null, i.lineMinor != null ? money(i.lineMinor, d.currency) : '')); tb.appendChild(tr); });
    tb.appendChild(row('Product subtotal', money(d.productsMinor, d.currency)));
    if (d.quote && (d.quoteStatus === 'accepted')) { tb.appendChild(row('Shipping', money(d.quote.shippingMinor, d.currency))); if (d.quote.taxesMinor + d.quote.otherMinor) tb.appendChild(row('Taxes and additional charges', money(d.quote.taxesMinor + d.quote.otherMinor, d.currency))); }
    else tb.appendChild(row('Shipping', 'Not included yet (quotation required)'));
    var tot = row(d.quoteStatus === 'accepted' ? 'Final payable amount' : 'Total so far (products only)', money(d.totalMinor, d.currency)); tot.className = 'tot'; tb.appendChild(tot);
    if (d.paidMinor) tb.appendChild(row('Paid', money(d.paidMinor, d.currency))); if (d.paidMinor && d.outstandingMinor) tb.appendChild(row('Outstanding', money(d.outstandingMinor, d.currency)));
    t.appendChild(tb); items.appendChild(t); items.appendChild(el('p', 'fine', d.priceNote)); host.appendChild(items);

    if (d.quote && d.quote.status !== 'superseded') host.appendChild(quoteCard(d));
    host.appendChild(paymentCard(d));
    if (d.shipments && d.shipments.length) {
      var s = el('section', 'ix-card'); s.appendChild(el('h3', null, 'Dispatch and tracking'));
      d.shipments.forEach(function (x) { s.appendChild(el('p', null, x.courier + ' · tracking number ' + x.awb + (x.shipped_on ? ' · dispatched ' + day(x.shipped_on) : '') + (x.est_delivery ? ' · estimated delivery ' + day(x.est_delivery) + ' (an estimate, not a guarantee)' : ''))); var u = httpsOnly(x.tracking_url); if (u) { var a = el('a', null, 'Open carrier tracking'); a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; s.appendChild(a); } });
      host.appendChild(s);
    }
    var tl = el('section', 'ix-card'); tl.appendChild(el('h3', null, 'Timeline')); var ul = el('ul', 'tl');
    d.timeline.forEach(function (e) { var li = el('li', null, e.label); li.appendChild(el('time', null, when(e.at))); ul.appendChild(li); }); tl.appendChild(ul); host.appendChild(tl);
    var help = el('section', 'ix-card'); help.appendChild(el('h3', null, 'Need help?'));
    var p = el('p', null, 'Email '); var a1 = el('a', null, 'hello@ntagz.com'); a1.href = 'mailto:hello@ntagz.com?subject=' + encodeURIComponent('Order ' + d.orderNumber); p.appendChild(a1); p.appendChild(document.createTextNode(' or WhatsApp +91 9960 160016 and quote your order number. Policies: '));
    [['terms-and-conditions.html', 'Terms'], ['shipping-policy.html', 'Shipping'], ['refund-policy.html', 'Refunds'], ['privacy-policy.html', 'Privacy']].forEach(function (l, i) { var a = el('a', null, l[1]); a.href = '../' + l[0]; if (i) p.appendChild(document.createTextNode(' · ')); p.appendChild(a); });
    help.appendChild(p); host.appendChild(help);
  }

  function quoteCard(d) {
    var qd = d.quote, c = el('section', 'ix-card'); c.appendChild(el('h3', null, 'Shipping quotation (version ' + qd.version + ')'));
    var t = el('table'), tb = el('tbody');
    tb.appendChild(row('Covers', qd.typeLabel)); tb.appendChild(row('Product subtotal', money(qd.productsMinor, d.currency))); tb.appendChild(row('Shipping', money(qd.shippingMinor, d.currency)));
    tb.appendChild(row('Taxes and additional charges', qd.taxesMinor + qd.otherMinor ? money(qd.taxesMinor + qd.otherMinor, d.currency) : 'None specified'));
    var tot = row('Final payable amount', money(qd.totalMinor, d.currency)); tot.className = 'tot'; tb.appendChild(tot);
    var how = [qd.carrier, qd.method].filter(Boolean).join(' · '); if (how) tb.appendChild(row('Shipping method', how));
    if (qd.estFrom || qd.estTo) tb.appendChild(row('Estimated delivery window', [day(qd.estFrom), day(qd.estTo)].filter(Boolean).join(' to ') + ' (an estimate, not a guarantee)'));
    tb.appendChild(row('Valid until', when(qd.expiresAt))); t.appendChild(tb); c.appendChild(t);
    if (qd.chargesNote) c.appendChild(el('p', 'fine', qd.chargesNote));
    c.appendChild(el('p', 'fine', 'Customs duties, import taxes and other destination-country charges may be payable by you unless this quotation says otherwise.'));
    if (qd.status === 'sent') {
      var act = el('div', 'actions'), yes = el('button', 'btn-primary', 'Accept quotation'), no = el('button', 'btn-ghost', 'Decline'); yes.type = 'button'; no.type = 'button';
      var msg = el('p', 'err'); msg.setAttribute('role', 'alert');
      var confirmBox = el('div'); confirmBox.hidden = true;
      var decide = function (decision) {
        yes.disabled = no.disabled = true; msg.textContent = '';
        fetch('/api/intl/order/quote', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ o: O, t: T, quote_id: qd.id, decision: decision }) })
          .then(function (r) { return r.json().then(function (x) { return { ok: r.ok, d: x }; }); })
          .then(function (x) { if (x.ok) render(x.d); else { msg.textContent = x.d.error || 'We could not record your answer.'; yes.disabled = no.disabled = false; } })
          .catch(function () { msg.textContent = 'We could not record your answer. Please try again.'; yes.disabled = no.disabled = false; });
      };
      yes.addEventListener('click', function () {
        confirmBox.textContent = ''; confirmBox.hidden = false; confirmBox.className = 'ix-notice';
        confirmBox.appendChild(el('p', null, 'By accepting you agree to pay ' + money(qd.totalMinor, d.currency) + ' for this order (products ' + money(qd.productsMinor, d.currency) + ', shipping ' + money(qd.shippingMinor, d.currency) + (qd.taxesMinor + qd.otherMinor ? ', taxes and charges ' + money(qd.taxesMinor + qd.otherMinor, d.currency) : '') + '). You will then be asked to pay the outstanding amount. Nothing is charged by accepting.'));
        var go = el('button', 'btn-primary', 'Confirm: accept ' + money(qd.totalMinor, d.currency)); go.type = 'button'; go.addEventListener('click', function () { decide('accept'); }); confirmBox.appendChild(go);
      });
      no.addEventListener('click', function () { decide('decline'); });
      act.appendChild(yes); act.appendChild(no); c.appendChild(act); c.appendChild(confirmBox); c.appendChild(msg);
    } else if (qd.status === 'accepted') c.appendChild(el('p', null, 'You accepted this quotation.'));
    else if (qd.status === 'declined') c.appendChild(el('p', null, 'You declined this quotation. Contact us if you would like another.'));
    else if (qd.status === 'expired') c.appendChild(el('p', 'err', 'This quotation has expired. Please contact us and we will send a new one.'));
    return c;
  }

  function paymentCard(d) {
    var c = el('section', 'ix-card'); c.appendChild(el('h3', null, 'Payment'));
    c.appendChild(el('p', null, d.payment.message));
    if (d.payment.canPay) {
      c.appendChild(el('p', 'fine', 'This order is payable in ' + d.currency + '. If your card or bank converts or charges fees, those are set by them and are not included in the amounts above.'));
      var u = httpsOnly(d.payment.link);
      if (u) { var a = el('a', 'btn-primary', 'Pay ' + money(d.payment.linkAmountMinor || d.outstandingMinor, d.currency)); a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; c.appendChild(a); c.appendChild(el('p', 'fine', 'You will be taken to our payment provider. Your order shows as paid only after the provider confirms the payment to us. Returning to this page is not proof of payment.')); }
    }
    return c;
  }

  if (!/^[0-9a-fA-F-]{8,64}$/.test(O || '') || !/^[0-9a-f]{32}$/.test(T || '')) { $('ioLoad').textContent = ''; $('ioLoad').appendChild(el('p', null, 'This link is not valid. Please use the link from your order email, or contact hello@ntagz.com.')); return; }
  fetch('/api/intl/order?o=' + encodeURIComponent(O) + '&t=' + encodeURIComponent(T), { credentials: 'omit', cache: 'no-store' })
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (x) { if (x.ok) render(x.d); else { $('ioLoad').textContent = ''; $('ioLoad').appendChild(el('p', null, 'We could not find that order. Please check the link in your email, or contact hello@ntagz.com.')); } })
    .catch(function () { $('ioLoad').textContent = ''; $('ioLoad').appendChild(el('p', null, 'We could not load your order right now. Please try again shortly.')); });
})();
