/* ntagz /membership/ — a signed-in customer's own spending-tier standing (the public tier picker lives in js/membership.js, fed by /api/membership/pricing). Standing:
   GET /api/rewards/me (derived on the server from their paid orders). Nothing here is trusted for pricing; checkout re-derives it all. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  var rupee = function (paise) { return '₹' + nf.format(Math.round(paise) / 100); };
  var pct = function (n) { return nf.format(n) + '%'; };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  var when = function (s) { return new Date(s * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };

  var tiers = [], me = null, live = false, baseRate = 0, ptsLive = false;

  function stat(label, value) { var d = el('div', 'm-stat'); d.appendChild(el('span', null, label)); d.appendChild(el('b', null, value)); return d; }

  function renderMine() {
    var sec = $('tiers'), host = $('rwMine'); if (!me) { sec.hidden = true; return; }
    sec.hidden = false; host.textContent = '';
    var a = el('div', 'card');
    a.appendChild(el('h3', null, (me.tier ? me.tier.name : 'Free') + ' tier'));
    a.appendChild(stat('Qualifying spend', rupee(me.spendPaise)));
    if (me.tier && me.tier.pointsPer100 > 0) a.appendChild(stat('Points rate at your tier', nf.format(me.tier.pointsPer100) + ' points per ₹100'));
    if (!(me.tier && me.tier.pointsPer100 > 0) || me.discountPct > 0) a.appendChild(stat('Your member discount', me.live ? (me.discountPct > 0 ? pct(me.discountPct) + ' on eligible products' : 'None at this tier') : 'Not switched on yet'));
    a.appendChild(stat('Saved with Ntagz so far', rupee(me.savingsPaise)));
    if (me.paidMembership && me.paidMembership.active) a.appendChild(stat('Paid membership', 'Active until ' + when(me.paidMembership.expiresAt)));
    host.appendChild(a);

    var b = el('div', 'card');
    if (me.topTier || !me.next) {
      b.appendChild(el('h3', null, 'You’re on our top tier'));
      b.appendChild(el('p', 'm-fine', me.discountPct > 0 ? 'You get ' + pct(me.discountPct) + ' off eligible products. Thank you for shopping with Ntagz.' : 'There is no higher tier to reach.'));
    } else {
      var span = me.next.minSpendPaise, done = Math.min(Math.max(me.spendPaise, 0), span); /* progress = qualifying spend ÷ the next threshold */
      b.appendChild(el('h3', null, rupee(me.next.remainingPaise) + ' to ' + me.next.name));
      b.appendChild(el('p', 'm-fine', me.next.discountPct > 0 ? me.next.name + ' gives ' + pct(me.next.discountPct) + ' off eligible products.' : me.next.pointsPer100 > 0 ? me.next.name + ' earns ' + nf.format(me.next.pointsPer100) + ' points for every ₹100 of eligible spend.' : ''));
      var bar = el('div', 'm-bar'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
      var w = span > 0 ? Math.round(done / span * 100) : 0; bar.setAttribute('aria-valuenow', String(w)); bar.setAttribute('aria-label', 'Progress to ' + me.next.name);
      var fill = el('i'); fill.style.width = w + '%'; bar.appendChild(fill); b.appendChild(bar);
      b.appendChild(el('p', 'm-fine', rupee(me.spendPaise) + ' of ' + rupee(me.next.minSpendPaise) + ' (' + w + '%)'));
    }
    host.appendChild(b);

    if (me.suggest && me.suggest.length) {
      var c = el('div', 'card wide'); c.appendChild(el('h3', null, 'Ideas for your next order'));
      c.appendChild(el('p', 'm-fine', 'Products that would help you reach ' + (me.next ? me.next.name : 'your next tier') + ', based on what you have bought before.'));
      var r = el('div', 'm-recs');
      me.suggest.forEach(function (x) { var l = el('a'); l.href = '../order.html?add=' + encodeURIComponent(x.id); l.appendChild(el('span', null, x.qty + ' × ' + x.name)); l.appendChild(el('b', null, 'about ' + rupee(x.valuePaise))); r.appendChild(l); });
      c.appendChild(r); host.appendChild(c);
    }

    var h = el('div', 'card wide'), det = el('details', 'm-hist'); det.appendChild(el('summary', null, 'Your spending and tier history'));
    var ul = el('ul');
    (me.orders || []).forEach(function (o) {
      ul.appendChild(el('li', null, when(o.createdAt) + ' · order ' + o.ref.slice(0, 18) + ' · ' + (o.counted ? 'counts ' + rupee(o.qualifyingPaise) : 'does not count (' + o.status + ')') + (o.refundedPaise ? ' · refunded ' + rupee(o.refundedPaise) : '')));
    });
    (me.adjustments || []).forEach(function (x) { ul.appendChild(el('li', null, when(x.at) + ' · adjustment ' + (x.deltaPaise > 0 ? '+' : '−') + rupee(Math.abs(x.deltaPaise)) + ' · ' + x.reason)); });
    (me.tierHistory || []).forEach(function (x) { ul.appendChild(el('li', null, when(x.at) + ' · tier ' + (x.from || '—') + ' → ' + (x.to || '—') + ' · ' + x.reason)); });
    if (!ul.children.length) ul.appendChild(el('li', null, 'No orders yet. Your first paid order will appear here.'));
    det.appendChild(ul); h.appendChild(det); host.appendChild(h);
  }

  /* Runs only when the membership page reports (via js/membership.js) that spending tiers are live: no extra requests otherwise. */
  function start() {
    fetch('/api/rewards/me', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      me = d; renderMine(); document.dispatchEvent(new CustomEvent('ntagz:rewards-me', { detail: d }));
    }).catch(function () { });
  }
  var started = false;
  function maybe(P) { if (started || !P || !P.loyaltyLive) return; started = true; if (P.points) { ptsLive = true; baseRate = Number(P.points.earnPer100) || 0; } start(); }
  document.addEventListener('ntagz:pricing', function (e) { maybe(e.detail); });
  maybe(window.NTAGZ_PRICING);
})();
