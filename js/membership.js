/* ntagz /membership/ — Ntagz Rewards Membership.
   One public request (GET /api/membership/pricing) drives every number on the page: fee, validity, member discounts, earn rate, point value,
   redemption limits, expiry, milestones, renewal window. If rewards points are off (`points: null`) no points/milestone claims are rendered at all.
   GET /api/membership/me runs once for signed-in customers (a 401 means signed out) and only changes which buttons/dashboard are shown.
   The calculator is an ESTIMATE from those same numbers; checkout always re-prices on the server. Purchase flow: create-order -> Razorpay ->
   verify-payment; a success state is never shown before verify-payment answers ok. All server strings use textContent. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  var nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  var rs = function (r) { return (r < 0 ? '−' : '') + '₹' + nf.format(Math.abs(Math.round(r * 100) / 100)); };   // rupees
  var paise = function (p) { return rs(p / 100); };
  var pts = function (n) { return nf0.format(n); };
  var day = function (s) { return new Date(s * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  var LOGIN = '/account/login.html?next=' + encodeURIComponent('/membership/?join=1');   // ?join=1: after sign-in, carry straight on to payment

  var P = null;          // /api/membership/pricing
  var M = null;          // /api/membership/me (null = signed out or unknown)
  var CM = [];           // cart milestones from /api/rewards/tiers (free shipping / % off — a separate programme from spending milestones)
  var CTAS = ['mPlanCta', 'mFinalCta', 'mStickyCta'].map(function (id) { return document.getElementById(id); });
  var cta = null;        // current primary action {label, href, act, disabled, ghost}
  var avgPct = 0, minPct = 0, maxPct = 0, nProducts = 0;
  var selTier = 0, myTier = null;   // tier picker state; myTier = the signed-in customer's real tier name

  function duration(d) {
    if (d % 365 === 0) return d / 365 === 1 ? '1 year' : d / 365 + ' years';
    if (d % 30 === 0 && d >= 60) return d / 30 + ' months';
    return d + ' days';
  }
  function canBuy() { return !!(P && P.live && P.feePaise >= 100); }
  /* Earn rate in words, from the server's configuration: the flat rate below the first tier, then each tier's rate. */
  function rateText() {
    var p = P.points, t = p.tiers || [], all = t.map(function (x) { return x.pointsPer100; }).concat(p.earnPer100), lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    return lo === hi ? pts(lo) + ' points per ₹100' : pts(lo) + ' to ' + pts(hi) + ' points per ₹100';
  }
  function rateDetail() {
    var p = P.points, t = p.tiers || [];
    if (!t.length) return pts(p.earnPer100) + ' points per ₹100.';
    // Only name the tiers that actually change the rate, so the sentence reads in order and never contradicts itself.
    var rate = p.earnPer100, parts = [pts(rate) + ' points per ₹100 to start'];
    t.forEach(function (x) {
      if (x.pointsPer100 === rate) return;
      rate = x.pointsPer100;
      parts.push(pts(rate) + ' from ' + paise(x.minSpendPaise) + ' of qualifying spend (' + x.name + ')');
    });
    return parts.join(', ') + '.';
  }
  function hasPts() { return !!(P && P.points); }
  function msList() { return hasPts() && P.milestones ? P.milestones : []; }

  /* The estimate itself lives in js/member-calc.js (pure, tested against the real pricing engine and points rules). */
  var calc = window.NTAGZ_CALC;

  /* ── hero / copy that depends on what is switched on ── */
  function renderHero() {
    var live = !!P.live, p = hasPts();
    if (!(live && p)) $('mTag').textContent = live ? 'Buy smarter. Save on member prices.' : p ? 'Buy smarter. Earn rewards every time you shop.' : 'Membership is not on sale right now.';
    var pr = $('mPrice'); pr.textContent = '';
    if (canBuy()) {
      pr.appendChild(document.createTextNode(paise(P.feePaise) + ' '));
      pr.appendChild(el('small', null, '/ ' + duration(P.durationDays) + ' · incl. GST · one payment'));
    } else pr.textContent = 'Membership is not on sale right now';
    var parts = [];
    if (live) parts.push('Member prices lower what you pay on eligible products');
    if (p) parts.push('Rewards points are extra credit you earn on orders and spend on later ones');
    $('mHonest').textContent = parts.length ? parts.join('. ') + '. What you save depends on what you buy and how often, so check the estimate below before you join.' : 'Please check back soon.';
    var chips = $('mChips'); chips.textContent = '';
    var add = function (t) { chips.appendChild(el('li', null, t)); };
    if (live && maxPct > 0) add('Member prices up to ' + maxPct + '% off');
    if (p) add('Earn ' + rateText());
    if (canBuy()) add('No auto-renewal');
    $('mJoinPrice').textContent = canBuy() ? paise(P.feePaise) + ' / ' + duration(P.durationDays) : '';
  }

  var ICO = {
    tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
    star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    wallet: '<path d="M3 7h15a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l12-3v3"/><circle cx="17" cy="14" r="1.2"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    cycle: '<path d="M20 11a8 8 0 0 0-14-4M4 4v4h4M4 13a8 8 0 0 0 14 4M20 20v-4h-4"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>'
  };
  /* Static icon markup only (no server text is ever put through innerHTML). */
  function benefitCard(icon, h, short, body) {
    var c = el('details', 'm-box m-ben'), s = el('summary'), ic = el('span', 'm-ico'), t = el('span', 'm-ben-t');
    ic.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICO[icon] + '</svg>';
    t.appendChild(el('b', null, h)); t.appendChild(el('span', null, short));
    s.appendChild(ic); s.appendChild(t); c.appendChild(s); c.appendChild(el('p', 'm-ben-d', body)); return c;
  }
  function renderBenefits() {
    var host = $('mBenefits'); host.textContent = '';
    var p = P.points, ms = msList();
    if (P.live && maxPct > 0) host.appendChild(benefitCard('tag', 'Member-only prices', 'Up to ' + maxPct + '% off eligible products', 'Lower prices on eligible products, up to ' + maxPct + '% off, applied automatically at checkout while you are signed in. Quantity and member discounts together never go beyond ' + P.maxTotalDiscountPct + '%.'));
    if (p) {
      host.appendChild(benefitCard('star', 'Rewards points', 'Earn ' + rateText() + ' on eligible purchases', 'Earn ' + rateText() + ' of eligible product value you buy, depending on your spending tier. Each point is worth ' + paise(p.valuePaise) + ' at checkout.'));
      host.appendChild(benefitCard('wallet', 'Use points at checkout', 'Each point is worth ' + paise(p.valuePaise), 'Redeem from ' + pts(p.minRedeem) + ' points, for up to ' + p.maxRedeemPct + '% of an order’s eligible value. Points last ' + duration(p.validDays) + ' from the day they are earned.'));
      if (ms.length) host.appendChild(benefitCard('flag', 'Milestone bonuses', 'Bonus points as your spend grows', 'Reach ' + paise(ms[0].thresholdPaise) + ' of eligible spend in a membership year to earn ' + pts(ms[0].bonusPoints) + ' bonus points, with more at higher levels. See Milestones below.'));
    }
    if (canBuy()) host.appendChild(benefitCard('cycle', 'Easy renewal', 'Renew early without losing time', (P.renewWindowDays > 0 ? 'You can renew from ' + P.renewWindowDays + ' days before your membership ends. ' : 'Once your membership ends you can renew straight away. ') + 'An early renewal starts when your current term ends, so you do not lose any time.'));
    host.appendChild(benefitCard('check', 'Simple and honest', canBuy() ? 'One payment. No auto-renewal.' : 'Not on sale right now', canBuy() ? 'One payment of ' + paise(P.feePaise) + ' for ' + duration(P.durationDays) + '. No automatic renewal. For small one-off orders it may not pay for itself, so use the estimate below.' : 'Membership is not on sale right now. You can still shop at regular prices.'));
  }

  function renderSteps() {
    var host = $('mSteps'); host.textContent = '';
    var p = P.points, step = function (h, t) { var li = el('li'); li.appendChild(el('h3', null, h)); li.appendChild(el('p', null, t)); host.appendChild(li); };
    step('Join', canBuy() ? 'Pay ' + paise(P.feePaise) + ' once for ' + duration(P.durationDays) + ', counted from the day your payment is confirmed. Sign in with your email so the membership is linked to your account.' : 'Membership is not on sale right now.');
    step('Shop as usual', (P.live ? 'Member prices apply automatically at checkout while you are signed in. ' : '') +
      (p ? 'Points are added ' + (p.earnOn === 'paid' ? 'once your payment is confirmed.' : 'once your order is delivered; until then they show as pending.') : ''));
    step(p ? 'Use your points' : 'Save at checkout', p ? 'Each point is worth ' + paise(p.valuePaise) + '. Use at least ' + pts(p.minRedeem) + ' points, up to ' + p.maxRedeemPct + '% of an order’s eligible value, when you pay online. Points expire ' + duration(p.validDays) + ' after you earn them.' : 'You pay the member price, calculated by our server at checkout.');
  }

  function renderCompare() {
    var sec = $('compare'), body = $('mCompare'); body.textContent = '';
    if (!canBuy()) { sec.hidden = true; return; }
    var p = P.points, row = function (a, b, c) { var tr = el('tr'); tr.appendChild(el('th', null, a)); tr.lastChild.setAttribute('scope', 'row'); tr.appendChild(el('td', null, b)); tr.appendChild(el('td', 'yes', c)); body.appendChild(tr); };
    if (P.live && maxPct > 0) row('Prices on eligible products', 'Regular price', 'Member price, up to ' + maxPct + '% off');
    if (p) {
      row('Rewards points', 'Not earned', rateText());
      row('Use points at checkout', 'No', 'Up to ' + p.maxRedeemPct + '% of an order');
    }
    row('Cost', 'Free', paise(P.feePaise) + ' / ' + duration(P.durationDays));
    renderTierCompare(); sec.hidden = false;
  }

  /* ── plans: the paid membership card, the free spending-tier picker, the sticky mobile bar ── */
  function tierList() {
    var p = P.points; if (!p) return [];
    var t = [{ name: 'Starter', min: 0, rate: p.earnPer100 }];
    (p.tiers || []).forEach(function (x) { t.push({ name: x.name, min: x.minSpendPaise / 100, rate: x.pointsPer100 }); });
    return t;
  }
  function renderPlan() {
    var ok = canBuy(), p = P.points, pp = $('mPlanPrice'); pp.textContent = '';
    if (ok) { pp.appendChild(document.createTextNode(paise(P.feePaise) + ' ')); pp.appendChild(el('small', null, '/ ' + duration(P.durationDays) + ' · incl. GST · one payment')); }
    else pp.textContent = 'Not on sale right now';
    var ul = $('mPlanList'); ul.textContent = '';
    var add = function (t) { ul.appendChild(el('li', null, t)); };
    if (P.live && maxPct > 0) add('Member prices up to ' + maxPct + '% off eligible products');
    if (p) { add('Earn ' + rateText() + ' on eligible purchases'); add('Each point is worth ' + paise(p.valuePaise) + ' at checkout'); }
    if (ok) add('No automatic renewal');
    var best = $('mPlanBest'); best.textContent = '';
    if (ok) {
      var r = calc(calcIn(3000, 5000, 60, 50, 0), calcCfg());
      best.textContent = r.breakEven ? 'Best for regular buyers. On the calculator’s starting assumptions it covers its fee from about ' + rs(Math.ceil(r.breakEven / 1000) * 1000) + ' of spend a year.' : 'Use the calculator below to see whether it suits how you shop.';
    }
    var t = $('mPlanTerms'); t.textContent = '';
    var term = function (s) { t.appendChild(el('li', null, s)); };
    if (ok) {
      term('Valid for ' + duration(P.durationDays) + ' from the day your payment is confirmed. One payment, no automatic renewal.');
      term('Linked to the email account you sign in with, so you can use it on any device.');
    }
    if (P.live) term('Member prices apply to eligible products only (' + minPct + '% to ' + maxPct + '% off, depending on the product).');
    if (p) term('Points are earned on eligible product value after discounts, without GST or shipping, and added ' + (p.earnOn === 'paid' ? 'once your payment is confirmed' : 'once your order is delivered') + '. Spend them from ' + pts(p.minRedeem) + ' points, up to ' + p.maxRedeemPct + '% of an order. They expire ' + duration(p.validDays) + ' after the day they are earned.');
    if (ok) term('Terms specific to the membership fee are not published yet. Email hello@ntagz.com before paying if this matters to you.');
    $('mPlanMore').hidden = !t.children.length;
  }
  function selectTier(i, quiet) {
    var T = tierList(); if (!T.length) return;
    selTier = Math.min(Math.max(i, 0), T.length - 1);
    var t = T[selTier], prev = T[selTier - 1], next = T[selTier + 1], p = P.points, per10k = t.rate * 100;
    Array.prototype.forEach.call($('mTierPick').children, function (b, k) { b.setAttribute('aria-checked', k === selTier ? 'true' : 'false'); b.tabIndex = k === selTier ? 0 : -1; b.classList.toggle('on', k === selTier); });
    var pn = $('mTierPanel'); pn.textContent = '';
    var h = el('div', 'tp-h'); h.appendChild(el('b', null, t.name)); if (myTier && myTier === t.name) h.appendChild(el('span', 't-you', 'Your tier')); pn.appendChild(h);
    var big = el('div', 'tp-rate', pts(t.rate) + ' '); big.appendChild(el('small', null, 'points per ₹100')); pn.appendChild(big);
    var ln = function (a, b) { var d = el('div', 'm-line'); d.appendChild(el('span', null, a)); d.appendChild(el('b', null, b)); pn.appendChild(d); };
    ln('Qualifying spend', t.min === 0 ? 'Everyone starts here' : 'From ' + rs(t.min));
    ln('On ₹10,000 of eligible orders', pts(per10k) + ' points ≈ ' + rs(per10k * p.valuePaise / 100));
    pn.appendChild(el('p', 'tp-note', (prev ? (t.rate === prev.rate ? 'Same rate as ' + prev.name + '. ' : pts(t.rate - prev.rate) + ' more points per ₹100 than ' + prev.name + '. ') : '') +
      (next ? 'Next: ' + next.name + ' from ' + rs(next.min) + ' of qualifying spend (' + pts(next.rate) + ' points per ₹100).' : 'This is the top tier.')));
    pn.appendChild(el('p', 'tp-note', (selTier === 0 ? 'Best for: trying membership. ' : 'Best for: customers who reach ' + rs(t.min) + ' of qualifying spend. ') + 'Points are spent at checkout only, from ' + pts(p.minRedeem) + ' points, up to ' + p.maxRedeemPct + '% of an order.'));
    var ct = $('cTier'); if (ct && ct.value !== String(selTier)) ct.value = String(selTier);
    Array.prototype.forEach.call(document.querySelectorAll('[data-t]'), function (c) { c.classList.toggle('sel', c.getAttribute('data-t') === String(selTier)); });
    if (!quiet) renderCalc();
  }
  function renderTierBox() {
    var T = tierList(), box = $('mTierBox'), pick = $('mTierPick'); box.hidden = !T.length; pick.textContent = '';
    if (!T.length) return;
    T.forEach(function (t, i) {
      var b = el('button', 'm-tp'); b.type = 'button'; b.setAttribute('role', 'radio');
      b.appendChild(el('b', null, t.name)); b.appendChild(el('span', null, t.min === 0 ? 'Start' : 'From ' + rs(t.min)));
      b.addEventListener('click', function () { selectTier(i); });
      b.addEventListener('keydown', function (e) {
        var d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return;
        e.preventDefault(); var n = (i + d + T.length) % T.length; selectTier(n); pick.children[n].focus();
      });
      pick.appendChild(b);
    });
    selectTier(myTier ? Math.max(T.map(function (t) { return t.name; }).indexOf(myTier), 0) : selTier, true);
  }
  /* Sticky mobile bar: only while the plan card and final CTA are out of view and the hero has scrolled past. */
  var stick = { hero: true, plan: false, join: false, foot: false, ok: false };
  function stickyShow() { $('mSticky').hidden = !(stick.ok && !stick.hero && !stick.plan && !stick.join && !stick.foot); }
  function initSticky() {
    if (!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { stick[e.target.getAttribute('data-s')] = e.isIntersecting; }); stickyShow(); });
    [['top', 'hero'], ['mPlan', 'plan'], ['join', 'join'], ['footer-placeholder', 'foot']].forEach(function (x) { var n = $(x[0]); if (n) { n.setAttribute('data-s', x[1]); io.observe(n); } });
  }

  /* ── comparison: member or not, and (when points are on) the spending tiers ── */
  function renderTierCompare() {
    var T = tierList(), btn = $('cmpBtnT'), p = P.points; btn.hidden = !T.length;
    var hd = $('mCmpTHead'), bd = $('mCmpTBody'); hd.textContent = ''; bd.textContent = '';
    if (!T.length) return;
    var tr = el('tr'); tr.appendChild(el('th', null, 'Tier')); tr.firstChild.setAttribute('scope', 'col');
    T.forEach(function (t, i) { var th = el('th', null, t.name); th.setAttribute('scope', 'col'); th.setAttribute('data-t', i); tr.appendChild(th); });
    hd.appendChild(tr);
    var row = function (label, f) { var r = el('tr'), th = el('th', null, label); th.setAttribute('scope', 'row'); r.appendChild(th); T.forEach(function (t, i) { var td = el('td', null, f(t)); td.setAttribute('data-t', i); r.appendChild(td); }); bd.appendChild(r); };
    row('Qualifying spend', function (t) { return t.min === 0 ? 'Everyone starts here' : 'From ' + rs(t.min); });
    row('Points per ₹100', function (t) { return pts(t.rate); });
    row('Points on ₹10,000', function (t) { return pts(t.rate * 100); });
    row('Worth at checkout', function (t) { return rs(t.rate * 100 * p.valuePaise / 100); });
    $('cmpNote').textContent = 'Tiers are free and automatic: you move up when your qualifying spend reaches the next level. Points are spent at checkout from ' + pts(p.minRedeem) + ' points, up to ' + p.maxRedeemPct + '% of an order, and expire ' + duration(p.validDays) + ' after they are earned.';
  }
  function initCompareToggle() {
    var bm = $('cmpBtnM'), bt = $('cmpBtnT');
    var show = function (t) { bm.classList.toggle('on', !t); bt.classList.toggle('on', t); bm.setAttribute('aria-pressed', String(!t)); bt.setAttribute('aria-pressed', String(t)); $('cmpM').hidden = t; $('cmpT').hidden = !t; $('cmpNote').hidden = !t; };
    bm.addEventListener('click', function () { show(false); }); bt.addEventListener('click', function () { show(true); }); show(false);
  }

  /* ── calculator ── */
  function calcCfg() { var p = P.points; return { pct: P.live ? Math.min(avgPct, P.maxTotalDiscountPct || 100) : 0, fee: P.feePaise / 100, pts: p ? { earnPer100: p.earnPer100, value: p.valuePaise / 100, maxRedeemPct: p.maxRedeemPct, minOrder: p.minOrderPaise / 100, tiers: (p.tiers || []).map(function (t) { return { minSpend: t.minSpendPaise / 100, pointsPer100: t.pointsPer100 }; }) } : null }; }
  /* Monthly spend and typical order size -> the order count and size the shared estimate takes. Annual spend is kept exact. */
  function calcIn(month, order, share, use, start) {
    var cl = function (v, lo, hi) { v = Number(v); if (!isFinite(v)) v = lo; return Math.min(Math.max(v, lo), hi); };
    var annual = cl(month, 0, 800000) * 12, o = cl(order, 100, 1e7), n = annual > 0 ? Math.min(365, Math.max(1, Math.round(annual / o))) : 0;
    return { order: n ? annual / n : 0, count: n, share: share, use: use, start: start };
  }
  function line(box, label, value, cls) { var d = el('div', 'm-line' + (cls ? ' ' + cls : '')); d.appendChild(el('span', null, label)); d.appendChild(el('b', null, value)); box.appendChild(d); }
  function group(box, t) { box.appendChild(el('h3', 'm-grp', t)); }
  function renderCalc() {
    if (!canBuy()) return;
    var T = tierList(), c = calcCfg(), start = T.length ? T[selTier].min : 0, month = Number($('cMonth').value) || 0;
    var r = calc(calcIn($('cMonth').value, $('cOrder').value, $('cShare').value, $('cUse').value, start), c), box = $('cOut'); box.textContent = '';
    line(box, 'Your annual spend (estimate)', rs(r.annual));
    line(box, 'About ' + rs(Math.min(Math.max(month, 0), 800000)) + ' a month', '', 'sub');
    if (P.live) {
      group(box, 'Cash savings from member prices');
      line(box, 'Spent on member-price products', rs(r.eligible), 'sub');
      line(box, 'Savings at ' + nf.format(Math.round(c.pct * 10) / 10) + '% average member discount', '+ ' + rs(r.savings));
    }
    if (c.pts) {
      group(box, 'Reward points (spent at checkout, not paid out as cash)');
      line(box, 'Points earned in a year', pts(r.earned) + ' pts');
      if (r.rate != null) line(box, 'Points rate you would reach', pts(r.rate) + ' per ₹100', 'sub');
      line(box, 'Points you expect to use', pts(r.used) + ' pts → + ' + rs(r.usedValue));
      line(box, 'Points left unused (not counted)', pts(r.unused) + ' pts', 'sub');
    }
    group(box, 'Membership cost');
    line(box, 'Membership fee', '− ' + rs(r.fee));
    var value = r.savings + r.usedValue, cover = r.fee > 0 ? Math.min(100, Math.round(value / r.fee * 100)) : 100;
    var n = el('div', 'm-net');
    n.appendChild(el('div', 'm-net-label', 'Estimated net benefit'));
    n.appendChild(el('div', 'm-net-val', rs(r.net)));
    var bar = el('div', 'm-bar'), fill = el('i'); fill.style.width = cover + '%'; bar.appendChild(fill);
    bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(cover)); bar.setAttribute('aria-label', 'Share of the membership fee these savings and points cover');
    n.appendChild(bar); n.appendChild(el('p', 'm-fine m-tight', 'Savings and points you expect to use cover ' + cover + '% of the ' + rs(r.fee) + ' fee.'));
    var msg;
    if (r.net >= 0) msg = 'On these numbers, membership could cover its ' + rs(r.fee) + ' fee. Only points you actually use are counted.';
    else if (r.breakEven) msg = 'Not worth it on these numbers. You would roughly break even at about ' + rs(Math.round(r.breakEven)) + ' of annual spend (about ' + rs(Math.round(r.breakEven / 12)) + ' a month) with the same habits.';
    else msg = 'Not worth it on these numbers: nothing here earns a saving or a reward.';
    n.appendChild(el('p', 'm-net-msg', msg));
    if (r.net >= 0 && r.breakEven) n.appendChild(el('p', 'm-net-msg', 'Break-even: about ' + rs(Math.round(r.breakEven)) + ' of annual spend with the same habits.'));
    box.appendChild(n);
    box.appendChild(el('p', 'm-fine', 'Estimate only, not a guarantee. It uses the average member discount across ' + nProducts + ' eligible products (' + minPct + '% to ' + maxPct + '%)' + (c.pts ? ', values each point at ' + paise(P.points.valuePaise) + ', and counts only points you expect to use, within the ' + P.points.maxRedeemPct + '% per-order limit' : '') + '. Checkout always recalculates with the real prices.'));
  }
  function initCalc() {
    var sec = $('calculator');
    if (!canBuy()) { sec.hidden = true; return; }
    sec.hidden = false; $('cUseWrap').hidden = !hasPts();
    var T = tierList(), ct = $('cTier'); ct.textContent = ''; $('cTierWrap').hidden = !T.length;
    T.forEach(function (t, i) { var o = el('option', null, t.name + (t.min ? ' (from ' + rs(t.min) + ' spend)' : ' (new member)')); o.value = String(i); ct.appendChild(o); });
    ct.value = String(selTier);
    ct.addEventListener('change', function () { selectTier(Number(ct.value)); });
    ['cMonth', 'cOrder', 'cShare', 'cUse'].forEach(function (id) {
      var i = $(id);
      i.addEventListener('input', renderCalc);
      i.addEventListener('change', function () { var lo = Number(i.min), hi = Number(i.max), v = Number(i.value); if (!isFinite(v) || i.value === '') v = lo; i.value = Math.min(Math.max(v, lo), hi); renderCalc(); });
    });
    renderCalc();
  }

  /* ── milestones: both kinds in one section — spending (bonus points) and cart (checkout rewards) ── */
  function renderMilestones() {
    var sec = $('milestones'), ms = msList(), spend = $('msSpend');
    if (ms.length) {
      var p = P.points, real = M && M.live && M.membership && M.membership.active && M.milestones && M.milestones.ladder && M.milestones.ladder.length;
      $('msLede').textContent = 'Reach each level of eligible spend in a membership year and earn bonus points on top of the points you earn on orders. Spend counts ' + (p.earnOn === 'paid' ? 'once your payment is confirmed' : 'once orders are delivered') + ', after discounts and refunds.';
      if (real) {
        window.NTAGZ_MEMDASH.ladder($('msLadder'), M.milestones.ladder, M.milestones.spendPaise || 0);
        $('msNote').textContent = 'This is your real progress for the current membership year.';
      } else {
        var a = ms[0].thresholdPaise, ex = ms.length > 1 ? a + Math.floor((ms[1].thresholdPaise - a) / 2) : Math.floor(a / 2);
        window.NTAGZ_MEMDASH.ladder($('msLadder'), ms.map(function (m) { return { id: m.id, label: m.label, thresholdPaise: m.thresholdPaise, bonusPoints: m.bonusPoints, reached: ex >= m.thresholdPaise, awarded: ex >= m.thresholdPaise }; }), ex);
        $('msNote').textContent = 'Example only: this shows a member who has spent ' + paise(ex) + '. It is not your spend. Join to track your own progress.';
      }
      spend.hidden = false;
    } else spend.hidden = true;
    renderCartMilestones();
    sec.hidden = !(ms.length || CM.length);
  }
  /* Cart milestones (free shipping / % off) — a separate programme from spending milestones, shown in the same section but in its own block. */
  function renderCartMilestones() {
    var block = $('msCart'), list = $('msCartList'), up = CM.filter(function (m) { return m && m.thresholdPaise != null; });
    if (!up.length) { block.hidden = true; return; }
    list.textContent = '';
    up.forEach(function (m) {
      var li = el('li', 'm-ms-item');
      li.appendChild(el('span', 'm-ms-cond', 'Add ' + paise(m.thresholdPaise) + ' of eligible products'));
      var what = m.type === 'free_shipping' ? 'Free shipping' : m.type === 'percent_off' ? nf.format(m.value) + '% off' : (m.name || 'A reward');
      li.appendChild(el('b', 'm-ms-reward', what + (m.audience === 'members' ? ' (members)' : m.audience === 'signed_in' ? ' (signed in)' : '')));
      list.appendChild(li);
    });
    $('msCartNote').textContent = 'Cart rewards are limited-time offers. They apply automatically when you pay online, based on the eligible product value in your cart, and do not combine with member or quantity discounts unless stated.';
    block.hidden = false;
  }
  function loadCartMilestones() {
    return fetch('/api/rewards/tiers', { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      CM = d && Array.isArray(d.milestones) ? d.milestones : [];
    }).catch(function () { CM = []; });
  }

  /* ── FAQ, all from the configuration ── */
  function renderFaq() {
    var host = $('mFaq'); host.textContent = '';
    var p = P.points, ms = msList(), fee = canBuy() ? paise(P.feePaise) : null, dur = duration(P.durationDays || 365);
    var q = function (qq, answers, link) {
      var d = el('details'), s = el('summary', null, qq), a = el('div', 'a');
      answers.forEach(function (t) { a.appendChild(el('p', null, t)); });
      if (link) { var an = el('a', null, link.text); an.href = link.href; a.lastChild.appendChild(document.createTextNode(' ')); a.lastChild.appendChild(an); }
      d.appendChild(s); d.appendChild(a); host.appendChild(d);
    };
    if (fee) {
      q('How much does it cost?', [fee + ' for ' + dur + ', including GST. It is one payment with no automatic renewal.']);
      q('How long is it valid?', ['Membership lasts ' + dur + ' from the day your payment is confirmed. It is linked to the email account you sign in with, so sign in on any device to use it.']);
    }
    if (P.live) q('Which products have member prices?', ['Member prices apply to eligible products only, from ' + minPct + '% to ' + maxPct + '% off depending on the product. Some products, such as fixed-price kits, are excluded. Quantity discounts and member prices combine up to ' + P.maxTotalDiscountPct + '%. The price you see at checkout is final.']);
    if (p) {
      q('How do I earn points?', ['You earn points on eligible product value, counted after discounts and without GST or shipping, on orders placed while signed in as an active member. The rate depends on your spending tier: ' + rateDetail() + ' ' +
        (p.earnOn === 'paid' ? 'Points are added once your payment is confirmed.' : 'Points are added once the order is delivered. Until then they show as pending in your account.') +
        (p.minOrderPaise > 0 ? ' Orders with less than ' + paise(p.minOrderPaise) + ' of eligible value do not earn points.' : '')]);
      q('What is a point worth?', ['Each point is worth ' + paise(p.valuePaise) + ' off at checkout.']);
      q('How do I use my points?', ['When you pay online with Razorpay or PayU, a “Use points” option appears once you have at least ' + pts(p.minRedeem) + ' points. You can use up to ' + p.maxRedeemPct + '% of the order’s eligible value. Orders confirmed over WhatsApp or paid by UPI or bank transfer cannot use points.']);
      q('Do points expire?', ['Yes. Points expire ' + duration(p.validDays) + ' after the day they are earned, and the oldest points are used first. Your account shows what is expiring soon.']);
      q('What happens to my points if I cancel or return an order?', [
        (p.restoreOnCancel ? 'Points you spent on an order that is cancelled or returned are given back to your balance. ' : 'Points you spent on an order that is cancelled or returned are not given back. ') +
        (p.clawback ? 'Points earned on that order are reversed in proportion to what is refunded' + (ms.length ? ', and a milestone bonus can be taken back if refunds drop your spend below that milestone' : '') + '. If you had already spent them, your balance shows what you owe and new points go towards it first.' : 'Points already earned on the order stay with you.')]);
      q('Can I combine points with coupons?', ['We do not use coupon codes. Points are the only extra discount you can apply, and they come off after every other discount (quantity, member price and any cart reward).']);
    }
    if (fee) {
      q('What happens when my membership ends?', ['Member prices' + (p ? ' and earning points' : '') + ' stop.' + (p ? ' Points you hold stay in your account until their own expiry date, but you need an active membership to use them.' : '') + ' You can rejoin at any time.']);
      q('Can I renew early?', [(P.renewWindowDays > 0 ? 'Yes. You can renew from ' + P.renewWindowDays + ' days before your membership ends. ' : 'Once your membership ends you can renew straight away. ') + 'An early renewal starts when your current term ends, so you do not lose any time.']);
    }
    q('Can I shop without membership?', ['Yes. Everything is available at regular prices without a membership, and you can check out as a guest.']);
    if (fee) q('Is there a refund policy for the membership fee?', ['Terms specific to the membership fee are not published yet. Please email hello@ntagz.com before paying if this matters to you. Product orders follow our'], { text: 'Returns & Refunds Policy.', href: '../terms.html' });
  }

  /* ── account state: buttons, notes, dashboard ── */
  function ctaFor() {
    var m = M && M.membership, active = !!(m && m.active);
    if (!P) return { label: 'Join Membership', href: LOGIN };
    if (active) {
      if (M.renewal && M.renewal.canRenew && canBuy()) return { label: 'Renew Membership · ' + paise(P.feePaise), act: buy, ghost: { label: 'View my rewards', href: dashShown() ? '#rewards' : '/account/' } };
      return { label: dashShown() && M.live ? 'View my rewards' : 'View my membership', href: dashShown() ? '#rewards' : '/account/' };
    }
    if (!canBuy()) return { label: 'Not available right now', disabled: true };
    var price = paise(P.feePaise);
    if (m && m.lastExpiry) return { label: 'Renew Membership · ' + price, act: buy };
    return { label: 'Become a Member · ' + price + '/' + (P.durationDays === 365 ? 'year' : duration(P.durationDays)), act: buy };
  }
  function dashShown() { var m = M && M.membership; return !!(m && (m.active || m.lastExpiry)); }
  function applyCta(override) {
    cta = override || ctaFor();
    CTAS.forEach(function (a) {
      a.textContent = cta.label; a.setAttribute('href', cta.href || (cta.act ? LOGIN : '#')); a.classList.toggle('is-disabled', !!cta.disabled);
      if (cta.disabled) a.setAttribute('aria-disabled', 'true'); else a.removeAttribute('aria-disabled');
    });
    var h = $('mHeroCta'), hh = dashShown() ? { label: 'View my rewards', href: '#rewards' } : { label: 'Explore Memberships', href: '#plans' };
    h.textContent = hh.label; h.setAttribute('href', hh.href);
    var g = $('mHeroGhost'), gg = canBuy() ? { label: 'Calculate My Savings', href: '#calculator' } : { label: 'See how it works', href: '#how' };
    g.textContent = gg.label; g.setAttribute('href', gg.href);
    var m = M && M.membership, note = '';
    if (m && m.active) note = 'Active until ' + day(m.expiresAt) + '.' + (M.renewal && M.renewal.canRenew && M.renewal.startsAt ? ' Renewing now starts a new year on ' + day(M.renewal.startsAt) + ', when your current term ends, so you lose no time.' : '');
    else if (m && m.lastExpiry) note = 'Your membership ended on ' + day(m.lastExpiry) + '. Renew to get member prices' + (hasPts() ? ' and earn points' : '') + ' again.';
    $('mHeroNote').textContent = note;
    var joinText = $('mJoinText');
    if (m && m.active) joinText.textContent = 'You are a member. Your membership is active until ' + day(m.expiresAt) + '.';
    stick.ok = !!(P && canBuy() && !cta.disabled && (cta.act || cta.href === LOGIN));
    $('mStickyT').textContent = stick.ok ? 'Rewards Membership · ' + paise(P.feePaise) + ' / ' + duration(P.durationDays) : '';
    stickyShow();
  }
  function showDash() {
    var sec = $('rewards'); sec.hidden = !dashShown();
    if (sec.hidden || !window.NTAGZ_MEMDASH) return;
    window.NTAGZ_MEMDASH.mount($('mDash'), { pricing: P, me: M, onRenew: function () { buy(); } }).then(function () {
      if (location.hash === '#rewards') sec.scrollIntoView();
    });
  }
  function onMe(d) {
    if (d && d.available === false) {   // wallet tables not ready: fall back to the plain status so buttons are still right
      return fetch('/api/membership/status', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
        var mm = s && s.membership;
        M = mm && mm.active ? { live: false, membership: { active: true, since: mm.purchasedAt, expiresAt: mm.expiresAt }, renewal: { canRenew: false } } : null;
      });
    }
    M = d && d.membership ? d : null;
  }

  /* ── purchase: create-order -> Razorpay -> verify-payment (a success state only after verify-payment says ok) ── */
  function status(msg, err) {
    ['mPlanStatus', 'mFinalStatus'].forEach(function (id) { var s = $(id); s.textContent = msg || ''; s.className = 'm-status' + (err ? ' err' : ''); });
    var s = $('mPlanStatus'), r = s.getBoundingClientRect();   // the message lives in the plan card: bring it into view if the sticky bar started the purchase
    if (msg && (r.bottom < 0 || r.top > window.innerHeight)) s.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function busy(b) { CTAS.forEach(function (a) { if (!cta) return; a.textContent = b ? 'Please wait…' : cta.label; a.classList.toggle('is-disabled', !!b); if (b) a.setAttribute('aria-disabled', 'true'); else a.removeAttribute('aria-disabled'); }); working = b; }
  var working = false;
  function cartCount() { try { return Object.keys(JSON.parse(localStorage.getItem('ntagz_cart_v1') || '{}')).length; } catch (e) { return 0; } }
  function cartLink() {
    var n = cartCount(), a = $('mCartLink'); if (!a || !n) return;
    a.hidden = false; a.textContent = 'Return to your cart (' + n + (n === 1 ? ' item' : ' items') + ') →';
  }
  function loadRzp(cb) {
    if (window.Razorpay) return cb();
    var sc = document.createElement('script'); sc.src = 'https://checkout.razorpay.com/v1/checkout.js';
    sc.onload = cb; sc.onerror = function () { status('Could not load the payment window. Please try again.', true); busy(false); };
    document.head.appendChild(sc);
  }
  /* Shown only after verify-payment answered ok: status, validity and what to do next. No automatic redirect, so nothing is lost on refresh. */
  function confirmed(d) {
    status('');
    var box = $('mDone'); box.textContent = '';
    box.appendChild(el('h2', null, d.renewed ? 'Your membership is renewed' : 'Welcome to Ntagz Rewards Membership'));
    box.appendChild(el('p', null, 'Payment confirmed. ' + (d.renewed ? 'Your new year begins when your current term ends and runs until ' : 'Your membership is active until ') + day(d.expiresAt) + '.'));
    var ul = el('ul'), item = function (t, href) { var li = el('li'), a = el('a', null, t); a.href = href; li.appendChild(a); ul.appendChild(li); };
    if (cartCount()) item('Return to your cart. Member prices apply at checkout while you are signed in.', '/order.html');
    item('Browse products', '/product/'); item('See your membership and rewards in your account', '/account/');
    box.appendChild(ul); box.hidden = false; box.focus();
    M = { live: hasPts(), membership: { active: true, expiresAt: d.expiresAt }, renewal: { canRenew: false } };
    working = false; applyCta({ label: 'You are a member', href: '/account/', ghost: { label: 'Keep shopping', href: '/product/' } });
  }
  function jsonRes(r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); }
  function buy() {
    if (working || !canBuy()) return;
    busy(true); status('');
    fetch('/api/accounts/me', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (a) {
      if (!a || !a.user) { location.href = LOGIN; return null; }
      var user = a.user;
      return fetch('/api/membership/create-order', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(jsonRes).then(function (x) {
        if (!x.ok) { status(x.d.error || 'Could not start payment. Please try again.', true); busy(false); return; }   // e.g. 409: not within the renewal window
        loadRzp(function () {
          var rzp = new window.Razorpay({
            key: x.d.keyId, order_id: x.d.id, amount: x.d.amount, currency: x.d.currency, name: 'nTagz',
            description: 'Ntagz Rewards Membership', prefill: { email: user.email, contact: user.phone || '' }, theme: { color: '#FF6A21' },
            handler: function (resp) {
              status('Verifying your payment…');
              fetch('/api/membership/verify-payment', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ razorpay_payment_id: resp.razorpay_payment_id, razorpay_order_id: resp.razorpay_order_id, razorpay_signature: resp.razorpay_signature }) })
                .then(jsonRes).then(function (v) {
                  if (v.ok && v.d && v.d.ok) {
                    try { sessionStorage.setItem('ntagz.member.choice', 'yes'); localStorage.setItem('ntagz.member.hint', '1'); } catch (e) { }
                    confirmed(v.d);
                  } else { status('We could not verify the payment. Email hello@ntagz.com with payment ID ' + resp.razorpay_payment_id + '.', true); busy(false); }
                }).catch(function () { status('Network error while verifying. Email hello@ntagz.com with payment ID ' + resp.razorpay_payment_id + '.', true); busy(false); });
            },
            modal: { ondismiss: function () { busy(false); } }
          });
          rzp.open();
        });
      });
    }).catch(function () { status('Something went wrong. Please try again.', true); busy(false); });
  }
  CTAS.forEach(function (a) {
    a.addEventListener('click', function (e) {
      if (!cta || cta.disabled) { e.preventDefault(); return; }
      if (cta.act) { e.preventDefault(); cta.act(); }
    });
  });

  /* ── boot ── */
  function stats() {
    var v = Object.keys(P.products || {}).map(function (k) { return Number(P.products[k]); }).filter(function (n) { return n > 0; });
    nProducts = v.length; if (!v.length) { avgPct = minPct = maxPct = 0; return; }
    avgPct = v.reduce(function (a, b) { return a + b; }, 0) / v.length; minPct = Math.min.apply(null, v); maxPct = Math.max.apply(null, v);
  }
  function render() {
    stats(); renderHero(); renderBenefits(); renderSteps(); renderPlan(); renderTierBox(); renderCompare(); renderFaq(); initCalc(); renderMilestones(); applyCta();
    window.NTAGZ_PRICING = P; document.dispatchEvent(new CustomEvent('ntagz:pricing', { detail: P }));
  }
  function fail() {
    $('mTag').textContent = 'We could not load the current membership details.';
    $('mPrice').textContent = '';
    ['mBenefits', 'mFaq'].forEach(function (id) {
      var h = $(id); h.textContent = '';
      var p = el('p', 'm-fine', 'Please check your connection. '), b = el('button', 'm-link', 'Try again'); b.type = 'button'; b.addEventListener('click', function () { location.reload(); });
      p.appendChild(b); h.appendChild(p);
    });
    $('mSteps').textContent = ''; $('mPlanPrice').textContent = 'Membership details are unavailable.'; CTAS.forEach(function (a) { a.classList.add('is-disabled'); a.setAttribute('aria-disabled', 'true'); });
  }

  fetch('/api/membership/pricing', { credentials: 'omit' }).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); }).then(function (d) {
    P = d; render();
    return fetch('/api/membership/me', { credentials: 'include' }).then(function (r) { return r.status === 401 ? null : r.ok ? r.json() : null; }).catch(function () { return null; });
  }).then(function (d) {
    if (!P) return;
    return onMe(d);
  }).then(function () {
    return P ? loadCartMilestones() : null;
  }).then(function () {
    if (!P) return;
    applyCta(); renderMilestones(); showDash(); resumeJoin();
  }).catch(function () { if (!P) fail(); });
  /* Signed-out visitors who pressed Join come back from sign-in with ?join=1: carry straight on to payment (buy() re-checks the session). */
  function resumeJoin() {
    if (!/[?&]join=1(&|$)/.test(location.search)) return;
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { }
    var m = M && M.membership;
    if (canBuy() && !(m && m.active && !(M.renewal && M.renewal.canRenew))) buy();
  }
  document.addEventListener('ntagz:rewards-me', function (e) { var me = e.detail; myTier = me && me.tier ? (me.tier.id === 'free' ? 'Starter' : me.tier.name) : null; if (P && myTier) renderTierBox(); });
  initSticky(); initCompareToggle(); cartLink();
  /* Gentle reveal on scroll; skipped for reduced motion or without IntersectionObserver, so nothing depends on it. */
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var rv = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('m-in'); rv.unobserve(e.target); } }); }, { threshold: 0.1 });
    var seen = function () { document.querySelectorAll('.m-steps li:not(.m-rvd),.m-ben:not(.m-rvd),.m-plan:not(.m-rvd)').forEach(function (n) { n.classList.add('m-rvd'); if (n.getBoundingClientRect().top > window.innerHeight) { n.classList.add('m-pre'); rv.observe(n); } }); };
    document.addEventListener('ntagz:pricing', function () { setTimeout(seen, 0); }); seen();
  }
})();
