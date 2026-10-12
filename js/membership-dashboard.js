/* ntagz — Rewards Membership dashboard (account page + /membership/#rewards). Shows ONLY what the server returns:
   GET /api/membership/me (summary, wallet, realised value, milestones, renewal) and GET /api/membership/activity (ledger).
   Every server string goes in through textContent. Nothing here grants or computes a price; "net realised value" is the server's figure. */
(function () {
  'use strict';
  var nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  var nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  var rupee = function (paise) { var v = Math.round(paise) / 100; return (v < 0 ? '−' : '') + '₹' + nf.format(Math.abs(v)); };
  var pts = function (n) { return nf0.format(n); };
  var day = function (s) { return new Date(s * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  var getJson = function (url) {
    return fetch(url, { credentials: 'include' }).then(function (r) {
      if (r.status === 401) return { signedOut: true };
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  };
  var KINDS = { earn: 'Points earned', bonus: 'Milestone bonus', redeem: 'Used at checkout', reverse: 'Reversed (refund or return)', bonus_reverse: 'Bonus reversed',
    expire: 'Expired', restore: 'Restored (order cancelled)', adjust: 'Adjustment' };

  /* Milestone ladder. items: [{id,label,thresholdPaise,bonusPoints,reached?,awarded?}], spend: paise or null (illustrative/no progress). */
  function ladder(host, items, spend, o) {
    o = o || {}; host.textContent = '';
    var ol = el('ol', 'md-ladder'), next = null, prev = 0;
    items.forEach(function (m, i) {
      var reached = spend != null && (m.reached != null ? m.reached : spend >= m.thresholdPaise);
      if (!reached && !next) next = { m: m, prev: prev };
      var li = el('li', 'md-ms' + (reached ? ' done' : next && next.m === m ? ' next' : ''));
      var dot = el('span', 'md-ms-dot', reached ? '✓' : String(i + 1)); dot.setAttribute('aria-hidden', 'true');
      var lbl = m.label || ('Milestone ' + (i + 1));   // admin milestones may have no name yet; never show a blank heading
      var body = el('div', 'md-ms-body');
      body.appendChild(el('b', null, lbl));
      body.appendChild(el('span', null, rupee(m.thresholdPaise) + ' eligible spend · +' + pts(m.bonusPoints) + ' bonus points'));
      var st = reached ? (m.awarded ? 'Bonus added' : 'Reached') : (next && next.m === m ? 'Next' : 'Locked');
      var tag = el('em', 'md-ms-tag', st);
      li.appendChild(dot); li.appendChild(body); li.appendChild(tag);
      if (next && next.m === m && spend != null) {
        var span = m.thresholdPaise - prev, w = span > 0 ? Math.max(0, Math.min(100, Math.round((spend - prev) / span * 100))) : 0;
        var bar = el('div', 'md-bar'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(w)); bar.setAttribute('aria-label', 'Progress to ' + lbl);
        var f = el('i'); f.style.width = w + '%'; bar.appendChild(f); li.appendChild(bar);
        li.appendChild(el('p', 'md-ms-more', rupee(m.thresholdPaise - spend) + ' more to reach ' + lbl + ' (+' + pts(m.bonusPoints) + ' points).'));
      }
      prev = m.thresholdPaise; ol.appendChild(li);
    });
    host.appendChild(ol);
    if (spend != null && !next && items.length) host.appendChild(el('p', 'md-fine', 'You have reached every milestone this membership year.'));
  }

  function row(label, value, cls) { var d = el('div', 'md-row' + (cls ? ' ' + cls : '')); d.appendChild(el('span', null, label)); d.appendChild(el('b', null, value)); return d; }
  function card(title, sub) { var c = el('div', 'md-card'); c.appendChild(el('h3', null, title)); if (sub) c.appendChild(el('p', 'md-fine', sub)); return c; }

  function summaryCard(me, pr, o) {
    var m = me.membership || {}, r = me.renewal || {}, c = card('Membership');
    var pill = el('span', 'md-pill ' + (m.active ? 'on' : 'off'), m.active ? 'Active' : (m.lastExpiry ? 'Ended' : 'Not a member'));
    c.firstChild.appendChild(document.createTextNode(' ')); c.firstChild.appendChild(pill);
    var now = Date.now() / 1000;
    if (m.active) {
      c.appendChild(row('Member since', day(m.since)));
      c.appendChild(row('Valid until', day(m.expiresAt)));
      if (m.feePaid != null) c.appendChild(row('Fee paid (this term)', rupee(m.feePaid)));
    } else if (m.lastExpiry) c.appendChild(row('Ended on', day(m.lastExpiry)));
    var perks = el('ul', 'md-perks');
    if (pr && pr.live) perks.appendChild(el('li', null, 'Member prices on eligible products, applied automatically at checkout while you are signed in.'));
    if (me.live) perks.appendChild(el('li', null, 'Rewards points on eligible orders, and bonus points at spending milestones.'));
    if (perks.children.length) c.appendChild(perks);

    var note = null, why = null;
    if (m.active && r.canRenew) {
      var left = Math.max(0, Math.ceil((m.expiresAt - now) / 86400));
      note = 'Your membership ends in ' + left + (left === 1 ? ' day' : ' days') + ' (' + day(m.expiresAt) + '). Renewing now adds a new year that starts on ' + day(r.startsAt || m.expiresAt) + ', when your current term ends, so you lose no time.';
    } else if (m.active && r.windowDays) {
      why = 'You can renew from ' + day(m.expiresAt - r.windowDays * 86400) + ' (' + r.windowDays + ' days before your term ends).';
    } else if (!m.active && r.canRenew) {
      note = (m.lastExpiry ? 'Your membership ended on ' + day(m.lastExpiry) + '. Member prices and new points are paused. ' : 'You are not a member yet. ') +
        (me.live ? 'Points you already hold stay until their own expiry; join' + (m.lastExpiry ? ' again' : '') + ' to use them and earn more.' : '');
    }
    if (note) {
      var box = el('div', 'md-prompt'); box.appendChild(el('p', null, note));
      var label = m.active ? 'Renew membership' : (m.lastExpiry ? 'Renew membership' : 'Join membership');
      var price = r.feePaise ? ' · ' + rupee(r.feePaise) : '';
      var b;
      if (o.onRenew) { b = el('button', 'md-btn', label + price); b.type = 'button'; b.addEventListener('click', o.onRenew); }
      else { b = el('a', 'md-btn', label + price); b.href = o.renewHref || '/membership/#join'; }
      box.appendChild(b); c.appendChild(box);
    }
    if (why) c.appendChild(el('p', 'md-fine', why));
    return c;
  }

  function walletCard(me, pr) {
    var w = me.wallet, c = card('Rewards points'), p = pr && pr.points;
    var big = el('div', 'md-big'); big.appendChild(el('b', null, pts(w.availablePoints))); big.appendChild(el('span', null, 'points available'));
    c.appendChild(big);
    c.appendChild(el('p', 'md-fine', 'Worth about ' + rupee(w.availablePoints * w.valuePaise) + ' at checkout. ' + (p ? 'Use at least ' + pts(p.minRedeem) + ' points per order, up to ' + p.maxRedeemPct + '% of its eligible value.' : '')));
    if (w.owedPoints > 0) {
      c.appendChild(el('p', 'md-warn', 'You owe ' + pts(w.owedPoints) + ' points: a refund or return reversed points you had already spent. New points you earn go towards this first, and redemption resumes once your balance is positive again.'));
    }
    var g = el('div', 'md-grid');
    var pend = el('div', 'md-stat');
    var pl = el('span', null, 'Pending '); var tipId = 'mdTip' + Math.random().toString(36).slice(2, 7);
    var tb = el('button', 'md-tip', 'i'); tb.type = 'button'; tb.setAttribute('aria-label', 'What does pending mean?'); tb.setAttribute('aria-expanded', 'false'); tb.setAttribute('aria-controls', tipId);
    pl.appendChild(tb); pend.appendChild(pl); pend.appendChild(el('b', null, pts(w.pendingPoints)));
    g.appendChild(pend);
    [['Expiring within 30 days', w.expiringSoon], ['Earned from orders', w.earnedPoints], ['Milestone bonuses', w.bonusPoints], ['Redeemed', w.redeemedPoints], ['Expired', w.expiredPoints], ['Reversed (refunds)', w.reversedPoints]]
      .forEach(function (x) { var s = el('div', 'md-stat'); s.appendChild(el('span', null, x[0])); s.appendChild(el('b', null, pts(x[1] || 0))); g.appendChild(s); });
    c.appendChild(g);
    var when = p && p.earnOn === 'paid' ? 'Points are added as soon as an order is paid, so pending stays at zero.' : 'Pending points are on orders that are paid but not delivered yet. They become available once the order is delivered.';
    var tip = el('p', 'md-fine md-tiptext', when + ' Available points can be used at checkout; pending points cannot.'); tip.id = tipId; tip.hidden = true;
    tb.addEventListener('click', function () { tip.hidden = !tip.hidden; tb.setAttribute('aria-expanded', String(!tip.hidden)); });
    c.appendChild(tip);
    if (p) c.appendChild(el('p', 'md-fine', 'Points expire ' + p.validDays + ' days after they are earned; the oldest are used first.'));
    return c;
  }

  function valueCard(me) {
    var v = me.value, w = me.wallet, c = card('What membership has saved you', 'Only what you have actually saved or used. Points you still hold are shown separately and not counted here.');
    c.appendChild(row('Eligible purchases', rupee(v.eligibleSpendPaise), 'muted'));
    c.appendChild(row('Member-price savings', '+ ' + rupee(v.memberPriceSavingsPaise)));
    if (me.live || v.redeemedValuePaise > 0) c.appendChild(row('Value of points you used', '+ ' + rupee(v.redeemedValuePaise)));
    c.appendChild(row('Membership fee paid', '− ' + rupee(v.feePaidPaise)));
    var net = row('Net realised value', rupee(v.netRealizedPaise), 'net'); c.appendChild(net);
    if (me.live) {
      var e = el('div', 'md-est');
      e.appendChild(el('h4', null, 'Not yet realised (estimate, not included above)'));
      e.appendChild(row('Available points', '≈ ' + rupee(w.availablePoints * w.valuePaise)));
      e.appendChild(row('Pending points', '≈ ' + rupee(v.pendingPointsValuePaise)));
      e.appendChild(el('p', 'md-fine', 'These become value only when you use them at checkout, and points expire if unused.'));
      c.appendChild(e);
    }
    return c;
  }

  function milestoneCard(me, pr) {
    var ms = me.milestones || {}, items = ms.ladder && ms.ladder.length ? ms.ladder : (pr && pr.milestones) || [];
    if (!items.length) return null;
    var c = card('Spending milestones', 'Bonus points when your eligible orders in a membership year reach each level' + (pr && pr.points && pr.points.earnOn === 'paid' ? ' (counted once paid).' : ' (counted once delivered).'));
    var host = el('div'); c.appendChild(host);
    if (me.membership && me.membership.active) { c.appendChild(row('Eligible spend this membership year', rupee(ms.spendPaise || 0), 'muted')); ladder(host, items, ms.spendPaise || 0); }
    else { ladder(host, items, null); c.appendChild(el('p', 'md-fine', 'Milestones count while your membership is active.')); }
    return c;
  }

  function activityCard() {
    var c = card('Points activity'), list = el('ul', 'md-act'), msg = el('p', 'md-fine'), more = el('button', 'md-btn md-ghost', 'Load more');
    more.type = 'button'; more.hidden = true; msg.setAttribute('role', 'status');
    c.appendChild(list); c.appendChild(msg); c.appendChild(more);
    var before = 0, busy = false, shown = 0;
    function load() {
      if (busy) return; busy = true; more.disabled = true; msg.textContent = shown ? '' : 'Loading activity…';
      getJson('/api/membership/activity?limit=30' + (before ? '&before=' + before : '')).then(function (d) {
        busy = false; more.disabled = false;
        if (d.signedOut) { msg.textContent = 'Sign in to see your activity.'; return; }
        (d.entries || []).forEach(function (e) {
          var li = el('li', 'md-a'), main = el('div', 'md-a-main');
          main.appendChild(el('b', null, KINDS[e.kind] || 'Activity'));
          var bits = [day(e.created_at)]; if (e.order_ref) bits.push('order ' + e.order_ref);
          if (e.expires_at && (e.kind === 'earn' || e.kind === 'bonus' || e.kind === 'restore')) bits.push('expires ' + day(e.expires_at));
          main.appendChild(el('span', null, bits.join(' · ')));
          if (e.reason) main.appendChild(el('span', null, e.reason));
          li.appendChild(main);
          li.appendChild(el('strong', e.points < 0 ? 'neg' : 'pos', (e.points < 0 ? '−' : '+') + pts(Math.abs(e.points))));
          list.appendChild(li); shown++; before = e.created_at;
        });
        more.hidden = !d.more;
        msg.textContent = shown ? '' : 'No points activity yet. Points appear here after your first eligible order.';
      }).catch(function () {
        busy = false; more.disabled = false; msg.textContent = 'Could not load activity. ';
        var rt = el('button', 'md-link', 'Try again'); rt.type = 'button'; rt.addEventListener('click', load); msg.appendChild(rt);
      });
    }
    more.addEventListener('click', load); load();
    return c;
  }

  /* host: element. o: { me?, pricing?, onRenew?, renewHref? }. Resolves to the rendered `me` (or null). */
  function mount(host, o) {
    o = o || {}; host.textContent = '';
    host.classList.add('md');
    var sk = el('p', 'md-fine', 'Loading your membership…'); sk.setAttribute('role', 'status'); host.appendChild(sk);
    var pP = o.pricing ? Promise.resolve(o.pricing) : getJson('/api/membership/pricing').catch(function () { return null; });
    var mP = o.me ? Promise.resolve(o.me) : getJson('/api/membership/me');
    return Promise.all([pP, mP]).then(function (res) {
      var pr = res[0], me = res[1];
      host.textContent = '';
      if (me.signedOut) {
        host.appendChild(el('p', null, 'Sign in to see your membership.'));
        var a = el('a', 'md-btn', 'Sign in'); a.href = '/account/login.html?next=' + encodeURIComponent(location.pathname); host.appendChild(a);
        return null;
      }
      if (me.available === false || !me.membership) {
        host.appendChild(el('p', 'md-fine', 'Membership details are not available right now. Please check back shortly.'));
        return null;
      }
      host.appendChild(summaryCard(me, pr, o));
      if (me.live && me.wallet) { host.appendChild(walletCard(me, pr)); host.appendChild(valueCard(me)); var mc = milestoneCard(me, pr); if (mc) host.appendChild(mc); host.appendChild(activityCard()); }
      else if (me.value) host.appendChild(valueCard(me));
      return me;
    }).catch(function () {
      host.textContent = '';
      var p = el('p', 'md-fine', 'Could not load your membership. ');
      var rt = el('button', 'md-link', 'Try again'); rt.type = 'button'; rt.addEventListener('click', function () { mount(host, { pricing: o.pricing, onRenew: o.onRenew, renewHref: o.renewHref }); });
      p.appendChild(rt); host.appendChild(p); return null;
    });
  }

  window.NTAGZ_MEMDASH = { mount: mount, ladder: ladder };
})();
