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
  var cta = null;        // current primary action {label, href, act, disabled, ghost}
  var avgPct = 0, minPct = 0, maxPct = 0, nProducts = 0;

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
    return pts(p.earnPer100) + ' points per ₹100 to begin with, then ' + t.map(function (x) { return pts(x.pointsPer100) + ' from ' + paise(x.minSpendPaise) + ' of qualifying spend (' + x.name + ')'; }).join(', ') + '.';
  }
  function hasPts() { return !!(P && P.points); }
  function msList() { return hasPts() && P.milestones ? P.milestones : []; }

  /* The estimate itself lives in js/member-calc.js (pure, tested against the real pricing engine and points rules). */
  var calc = window.NTAGZ_CALC;

  /* ── hero / copy that depends on what is switched on ── */
  function renderHero() {
    var live = !!P.live, p = hasPts();
    $('mTag').textContent = live && p ? 'Shop smarter. Get exclusive member prices and earn rewards as you shop.' : live ? 'Buy smarter. Save on member prices.' : p ? 'Buy smarter. Earn rewards every time you shop.' : 'Membership is not open right now.';
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
    if (msList().length) add('Bonus points at milestones');
    if (canBuy()) add('No auto-renewal');
    $('mJoinPrice').textContent = canBuy() ? paise(P.feePaise) + ' / ' + duration(P.durationDays) : '';
  }

  function benefitCard(h, body) { var c = el('div', 'm-box'); c.appendChild(el('h3', null, h)); c.appendChild(el('p', null, body)); return c; }
  function renderBenefits() {
    var host = $('mBenefits'); host.textContent = '';
    var p = P.points;
    if (P.live && maxPct > 0) host.appendChild(benefitCard('Member-only prices', 'Lower prices on eligible products, up to ' + maxPct + '% off, applied automatically at checkout while you are signed in. Quantity and member discounts together never go beyond ' + P.maxTotalDiscountPct + '%.'));
    if (p) {
      host.appendChild(benefitCard('Rewards points', 'Earn ' + rateText() + ' of eligible product value you buy, depending on your spending tier. Each point is worth ' + paise(p.valuePaise) + ' at checkout.'));
      host.appendChild(benefitCard('Use points at checkout', 'Redeem from ' + pts(p.minRedeem) + ' points, for up to ' + p.maxRedeemPct + '% of an order’s eligible value. Points last ' + duration(p.validDays) + ' from the day they are earned.'));
    }
    var ms = msList();
    if (ms.length) host.appendChild(benefitCard('Spending milestones', 'Bonus points when your eligible spend in a membership year reaches ' + ms.slice(0, 3).map(function (m) { return paise(m.thresholdPaise) + ' (+' + pts(m.bonusPoints) + ')'; }).join(', ') + (ms.length > 3 ? ' and more' : '') + '.'));
    host.appendChild(benefitCard('Simple and honest', canBuy() ? 'One payment of ' + paise(P.feePaise) + ' for ' + duration(P.durationDays) + '. No automatic renewal. For small one-off orders it may not pay for itself, so use the estimate below.' : 'Membership is not on sale right now. You can still shop at regular prices.'));
  }

  function renderSteps() {
    var host = $('mSteps'); host.textContent = '';
    var p = P.points, step = function (h, t) { var li = el('li'); li.appendChild(el('h3', null, h)); li.appendChild(el('p', null, t)); host.appendChild(li); };
    step('Join', canBuy() ? 'Pay ' + paise(P.feePaise) + ' once for ' + duration(P.durationDays) + ', counted from the day your payment is confirmed. Sign in with your email so the membership is linked to your account.' : 'Membership is not on sale right now.');
    step('Shop as usual', (P.live ? 'Member prices appear on eligible products in your cart and at checkout while you are signed in. ' : '') +
      (p ? 'Earn ' + rateText() + ' of eligible value (without GST or shipping). They are added ' + (p.earnOn === 'paid' ? 'once your payment is confirmed.' : 'once the order is delivered; until then they show as pending.') : ''));
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
    if (msList().length) row('Milestone bonus points', 'No', msList().length + (msList().length === 1 ? ' milestone' : ' milestones') + ' per year');
    row('Cost', 'Free', paise(P.feePaise) + ' / ' + duration(P.durationDays));
    sec.hidden = false;
  }

  /* ── calculator ── */
  function calcCfg() { var p = P.points; return { pct: P.live ? Math.min(avgPct, P.maxTotalDiscountPct || 100) : 0, fee: P.feePaise / 100, pts: p ? { earnPer100: p.earnPer100, value: p.valuePaise / 100, maxRedeemPct: p.maxRedeemPct, minOrder: p.minOrderPaise / 100, tiers: (p.tiers || []).map(function (t) { return { minSpend: t.minSpendPaise / 100, pointsPer100: t.pointsPer100 }; }) } : null }; }
  function line(box, label, value, cls) { var d = el('div', 'm-line' + (cls ? ' ' + cls : '')); d.appendChild(el('span', null, label)); d.appendChild(el('b', null, value)); box.appendChild(d); }
  function group(box, t) { box.appendChild(el('h3', 'm-grp', t)); }
  function renderCalc() {
    if (!canBuy()) return;
    var c = calcCfg(), r = calc({ order: $('cOrder').value, count: $('cCount').value, share: $('cShare').value, use: $('cUse').value }, c), box = $('cOut'); box.textContent = '';
    line(box, 'Your annual spend (estimate)', rs(r.annual));
    if (P.live) {
      group(box, 'Member-price savings (estimate)');
      line(box, 'Spent on member-price products', rs(r.eligible), 'sub');
      line(box, 'Savings at ' + nf.format(Math.round(c.pct * 10) / 10) + '% average member discount', '+ ' + rs(r.savings));
    }
    if (c.pts) {
      group(box, 'Estimated rewards');
      line(box, 'Points earned in a year', pts(r.earned) + ' pts');
      if (r.rate != null) line(box, 'Points rate you would reach', pts(r.rate) + ' per ₹100', 'sub');
      line(box, 'Points you expect to use', pts(r.used) + ' pts → + ' + rs(r.usedValue));
      line(box, 'Points left unused (not counted)', pts(r.unused) + ' pts', 'sub');
    }
    group(box, 'Cost');
    line(box, 'Membership fee', '− ' + rs(r.fee));
    var n = el('div', 'm-net');
    n.appendChild(el('div', 'm-net-label', 'Estimated net value'));
    n.appendChild(el('div', 'm-net-val', rs(r.net)));
    var msg;
    if (r.net >= 0) msg = 'On these numbers, membership could cover its ' + rs(r.fee) + ' fee. Only points you actually use are counted.';
    else if (r.breakEven) msg = 'Not worth it on these numbers. You would roughly break even at about ' + rs(Math.round(r.breakEven)) + ' of annual spend with the same habits.';
    else msg = 'Not worth it on these numbers: nothing here earns a saving or a reward.';
    n.appendChild(el('p', 'm-net-msg', msg)); box.appendChild(n);
    box.appendChild(el('p', 'm-fine', 'Estimate only. It uses the average member discount across ' + nProducts + ' eligible products (' + minPct + '% to ' + maxPct + '%)' + (c.pts ? ', and assumes your spend earns points; some products may not, and points need a minimum of ' + pts(P.points.minRedeem) + ' to use' : '') + '. Your real prices and points are set by our server at checkout.'));
  }
  function initCalc() {
    var sec = $('calculator');
    if (!canBuy()) { sec.hidden = true; return; }
    sec.hidden = false; $('cUseWrap').hidden = !hasPts();
    ['cOrder', 'cCount', 'cShare', 'cUse'].forEach(function (id) {
      var i = $(id);
      i.addEventListener('input', renderCalc);
      i.addEventListener('change', function () { var lo = Number(i.min), hi = Number(i.max), v = Number(i.value); if (!isFinite(v) || i.value === '') v = lo; i.value = Math.min(Math.max(v, lo), hi); renderCalc(); });
    });
    renderCalc();
  }

  /* ── milestones: the member's real progress, or a clearly labelled example ── */
  function renderMilestones() {
    var sec = $('milestones'), ms = msList(); sec.hidden = !ms.length; if (!ms.length) return;
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
    [$('mHeroCta'), $('mFinalCta')].forEach(function (a) {
      a.textContent = cta.label; a.setAttribute('href', cta.href || (cta.act ? LOGIN : '#')); a.classList.toggle('is-disabled', !!cta.disabled);
      if (cta.disabled) a.setAttribute('aria-disabled', 'true'); else a.removeAttribute('aria-disabled');
    });
    var g = $('mHeroGhost'), gg = cta.ghost || (canBuy() ? { label: 'Calculate My Savings', href: '#calculator' } : { label: 'See how it works', href: '#how' });
    g.textContent = gg.label; g.setAttribute('href', gg.href);
    var m = M && M.membership, note = '';
    if (m && m.active) note = 'Active until ' + day(m.expiresAt) + '.' + (M.renewal && M.renewal.canRenew && M.renewal.startsAt ? ' Renewing now starts a new year on ' + day(M.renewal.startsAt) + ', when your current term ends, so no time is lost.' : '');
    else if (m && m.lastExpiry) note = 'Your membership ended on ' + day(m.lastExpiry) + '. Renew to get member prices' + (hasPts() ? ' and earn points' : '') + ' again.';
    $('mHeroNote').textContent = note;
    var joinText = $('mJoinText');
    if (m && m.active) joinText.textContent = 'You are a member. Your membership is active until ' + day(m.expiresAt) + '.';
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
  function status(msg, err) { ['mHeroStatus', 'mFinalStatus'].forEach(function (id) { var s = $(id); s.textContent = msg || ''; s.className = 'm-status' + (err ? ' err' : ''); }); }
  function busy(b) { [$('mHeroCta'), $('mFinalCta')].forEach(function (a) { if (!cta) return; a.textContent = b ? 'Please wait…' : cta.label; a.classList.toggle('is-disabled', !!b); if (b) a.setAttribute('aria-disabled', 'true'); else a.removeAttribute('aria-disabled'); }); working = b; }
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
  [$('mHeroCta'), $('mFinalCta')].forEach(function (a) {
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
    stats(); renderHero(); renderBenefits(); renderSteps(); renderCompare(); renderFaq(); initCalc(); renderMilestones(); applyCta();
    $('tiers').hidden = !P.loyaltyLive;
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
    $('mSteps').textContent = '';
  }

  fetch('/api/membership/pricing', { credentials: 'omit' }).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); }).then(function (d) {
    P = d; render();
    return fetch('/api/membership/me', { credentials: 'include' }).then(function (r) { return r.status === 401 ? null : r.ok ? r.json() : null; }).catch(function () { return null; });
  }).then(function (d) {
    if (!P) return;
    return onMe(d);
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
  cartLink();
})();
