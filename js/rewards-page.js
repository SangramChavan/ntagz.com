/* ntagz /membership/ — the free spending tiers. Tier list: GET /api/rewards/tiers (public). A signed-in customer's own standing:
   GET /api/rewards/me (derived on the server from their paid orders). Nothing here is trusted for pricing; checkout re-derives it all. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  var rupee = function (paise) { return '₹' + nf.format(Math.round(paise) / 100); };
  var pct = function (n) { return nf.format(n) + '%'; };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  var when = function (s) { return new Date(s * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };

  var tiers = [], me = null, live = false;

  function renderTiers() {
    var host = $('rwTiers'); host.textContent = '';
    if (!tiers.length) { host.appendChild(el('p', 'm-fine', 'Tiers are not available right now. Please check back shortly.')); return; }
    tiers.forEach(function (t) {
      var card = el('article', 'm-tier' + (me && me.tier && me.tier.id === t.id ? ' current' : ''));
      if (me && me.tier && me.tier.id === t.id) card.appendChild(el('span', 't-you', 'Your tier'));
      card.appendChild(el('h3', null, t.name));
      card.appendChild(el('div', 't-spend', t.minSpendPaise === 0 ? 'Everyone starts here' : 'From ' + rupee(t.minSpendPaise) + ' qualifying spend'));
      var off = el('div', 't-off', t.discountPct > 0 ? pct(t.discountPct) + ' ' : 'Standard pricing');
      if (t.discountPct > 0) off.appendChild(el('small', null, 'off eligible products'));
      card.appendChild(off);
      var dup = t.perks === 'Standard pricing' || t.perks === nf.format(t.discountPct) + '% off eligible products';  // don't repeat what the discount line already says
      if (t.perks && !dup) card.appendChild(el('p', 't-perk', t.perks));
      if (me && me.next && me.tier && t.id === me.next.id) card.appendChild(el('p', 't-perk', rupee(me.next.remainingPaise) + ' to go'));
      host.appendChild(card);
    });
  }

  function stat(label, value) { var d = el('div', 'm-stat'); d.appendChild(el('span', null, label)); d.appendChild(el('b', null, value)); return d; }

  function renderMine() {
    var sec = $('rewards'), host = $('rwMine'); if (!me) { sec.hidden = true; return; }
    sec.hidden = false; host.textContent = '';
    var a = el('div', 'card');
    a.appendChild(el('h3', null, (me.tier ? me.tier.name : 'Free') + ' tier'));
    a.appendChild(stat('Qualifying spend', rupee(me.spendPaise)));
    a.appendChild(stat('Your member discount', me.live ? (me.discountPct > 0 ? pct(me.discountPct) + ' on eligible products' : 'None at this tier') : 'Not switched on yet'));
    a.appendChild(stat('Saved with Ntagz so far', rupee(me.savingsPaise)));
    if (me.paidMembership && me.paidMembership.active) a.appendChild(stat('Paid membership', 'Active until ' + when(me.paidMembership.expiresAt)));
    host.appendChild(a);

    var b = el('div', 'card');
    if (me.topTier || !me.next) {
      b.appendChild(el('h3', null, 'You’re on our top tier'));
      b.appendChild(el('p', 'm-fine', me.discountPct > 0 ? 'You get ' + pct(me.discountPct) + ' off eligible products. Thank you for shopping with Ntagz.' : 'There is no higher tier to reach.'));
    } else {
      var from = me.tier ? me.tier.minSpendPaise : 0, span = me.next.minSpendPaise - from, done = Math.min(Math.max(me.spendPaise - from, 0), span);
      b.appendChild(el('h3', null, rupee(me.next.remainingPaise) + ' to ' + me.next.name));
      b.appendChild(el('p', 'm-fine', me.next.name + ' gives ' + pct(me.next.discountPct) + ' off eligible products.'));
      var bar = el('div', 'm-bar'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
      var w = span > 0 ? Math.round(done / span * 100) : 0; bar.setAttribute('aria-valuenow', String(w)); bar.setAttribute('aria-label', 'Progress to ' + me.next.name);
      var fill = el('i'); fill.style.width = w + '%'; bar.appendChild(fill); b.appendChild(bar);
      b.appendChild(el('p', 'm-fine', rupee(me.spendPaise) + ' of ' + rupee(me.next.minSpendPaise)));
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

  function cta() {
    var b = $('mRewardsCta'); if (!b) return;
    if (me) { b.textContent = 'View My Rewards'; b.setAttribute('href', '#rewards'); }
    else { b.textContent = 'Join Free'; b.setAttribute('href', '/account/login.html?next=' + encodeURIComponent('/membership/#rewards')); }
  }

  fetch('/api/rewards/tiers', { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (d) {
      tiers = d.tiers || []; live = !!d.live; $('rwOff').hidden = live;
      var c = $('rwCombine'); if (c && d.combine === 'stack') c.textContent = 'If you have both, the two discounts can combine on a product, up to a combined limit.';
    }
    renderTiers();
  }).catch(function () { renderTiers(); });

  fetch('/api/rewards/me', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    me = d; cta(); renderTiers(); renderMine();
    if (me && location.hash === '#rewards') { var s = $('rewards'); if (s) s.scrollIntoView(); }
  }).catch(function () { cta(); });
})();
