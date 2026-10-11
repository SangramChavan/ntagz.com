/* ntagz membership page. Prices come from the live catalogue (js/catalog.js + catalog-live.js); member discount % per
   product from GET /api/membership/pricing (the same settings checkout uses). The calculator shows an instant local estimate,
   then replaces it with the server's own guest-vs-member prices for the basket (POST /api/quote, compare). Checkout always
   recomputes prices, discounts and membership status on the server. */
(function () {
  'use strict';
  var GST = 0.18, DEFAULT_FEE = 999;
  var PREVIEW = ['black-nfc-card', 'white-nfc-card', 'ntag216-adhesive-tag', 'google-review-nfc-card', 'google-review-nfc-stand-10x10', 'nfc-coin'];
  var DEFAULT_ROWS = [['black-nfc-card', 500], ['google-review-nfc-stand-5x5', 50]];
  var C = window.NTAGZ_CATALOG;
  var $ = function (id) { return document.getElementById(id); };
  var inr = function (n) { return '₹' + Math.round(n).toLocaleString('en-IN'); };
  var inr2 = function (n) { return '₹' + (Math.round(n * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  var pct = {};          // product id -> member discount %
  var pricingLive = false;
  var fee = DEFAULT_FEE;
  var maxTotal = 30;     // combined bulk + member cap (server setting)
  var rows = [];         // [{id, qty}]
  var user = null, membership = null;

  /* ── eligibility ── */
  function eligible(p) { return p && !p.fixed && pct[p.id] > 0 && !(p.live && p.live.active === false); }

  /* ── calculator maths (mirrors the server: volume tier, then member %, GST on non-inclusive items) ── */
  function line(p, qty, pctOff) {
    var vol = C.discountFor(p, qty);
    if (vol + pctOff - vol * pctOff / 100 > maxTotal) pctOff = vol >= maxTotal ? 0 : (1 - (100 - maxTotal) / (100 - vol)) * 100; // same cap as checkout
    var base = p.price * qty * (100 - vol) / 100;
    var net = base * (100 - pctOff) / 100;
    var g = p.allInclusive ? 1 : 1 + GST;
    return { regular: base * g, member: net * g };
  }

  function totals() {
    var reg = 0, mem = 0;
    rows.forEach(function (r) {
      var p = C.byId(r.id); if (!p) return;
      var l = line(p, r.qty, pct[r.id] || 0);
      reg += l.regular; mem += l.member;
    });
    return { reg: reg, mem: mem };
  }

  /* Server prices for the basket (same engine as checkout). Debounced; a stale or failed answer is ignored. */
  var srv = { key: '', t: null, timer: null };
  function basketKey() { return JSON.stringify(rows.filter(function (r) { return r.qty >= C.moqFor(C.byId(r.id)); }).map(function (r) { return [r.id, r.qty]; })); }
  function askServer() {
    var key = basketKey(); if (key === srv.key || key === '[]') return;
    clearTimeout(srv.timer);
    srv.timer = setTimeout(function () {
      var items = JSON.parse(key).map(function (x) { return { id: x[0], qty: x[1] }; });
      fetch('/api/quote', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items, state: '', compare: true }) })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.guest || !d.member || basketKey() !== key) return;
          srv.key = key; srv.t = { reg: d.guest.amount, mem: d.member.amount };
          if (d.feePaise) fee = Math.round(d.feePaise / 100);
          renderResult();
        }).catch(function () { });
    }, 400);
  }

  function renderResult() {
    var box = $('mResult'); box.textContent = '';
    if (!pricingLive) { box.appendChild(el('p', 'm-fine', 'Member pricing is not available right now, so we can’t estimate savings. Please check back shortly.')); return; }
    if (!rows.length) { box.appendChild(el('p', 'm-fine', 'Add a product to see your savings.')); return; }
    var exact = srv.t && srv.key === basketKey();
    var t = exact ? srv.t : totals(), saved = t.reg - t.mem, net = saved - fee;
    if (!exact) askServer();
    [['Regular total', inr(t.reg)], ['Member total', inr(t.mem)], ['Product savings', inr(saved)], ['Annual membership', '− ' + inr(fee)]].forEach(function (x) {
      var d = el('div', 'm-line'); d.appendChild(el('span', null, x[0])); d.appendChild(el('b', null, x[1])); box.appendChild(d);
    });
    var n = el('div', 'm-net');
    n.appendChild(el('div', 'm-net-label', 'Net savings after membership'));
    n.appendChild(el('div', 'm-net-val', (net < 0 ? '− ' : '') + inr(Math.abs(net))));
    var rate = t.reg > 0 ? saved / t.reg : 0, msg;
    if (net >= 0) msg = 'On this basket, membership more than covers its ₹' + fee + ' fee.';
    else if (rate > 0) msg = 'Not yet worth it on this basket. You would break even after about ' + inr((fee - saved) / rate) + ' more of eligible purchases (incl. GST).';
    else msg = 'These products have no member discount.';
    n.appendChild(el('p', 'm-net-msg', msg));
    box.appendChild(n);
    box.appendChild(el('p', 'm-fine', exact ? 'Checked with our checkout prices.' : 'Estimate. Checking with our checkout prices…'));
  }

  function renderRows() {
    var host = $('mRows'); host.textContent = '';
    rows.forEach(function (r, i) {
      var p = C.byId(r.id);
      var row = el('div', 'm-row');
      var info = el('div'); info.appendChild(el('div', 'm-row-name', p.name));
      info.appendChild(el('div', 'm-row-sub', inr2(p.price) + ' per ' + (p.unit || 'pc') + (p.allInclusive ? ', all-inclusive' : ' + GST') + ' · member ' + pct[r.id] + '% off'));
      var q = el('div', 'm-qty');
      var inp = el('input'); inp.type = 'number'; inp.inputMode = 'numeric'; inp.min = C.moqFor(p); inp.max = 100000; inp.step = 1; inp.value = r.qty;
      inp.setAttribute('aria-label', 'Quantity of ' + p.name + ' (minimum ' + C.moqFor(p) + ')');
      inp.addEventListener('input', function () { var v = parseInt(inp.value, 10); r.qty = isFinite(v) ? Math.min(Math.max(v, 1), 100000) : 0; if (r.qty >= C.moqFor(p)) renderResult(); });
      inp.addEventListener('change', function () { r.qty = Math.min(Math.max(parseInt(inp.value, 10) || 0, C.moqFor(p)), 100000); inp.value = r.qty; renderResult(); });
      var rm = el('button', 'm-icon-btn', '×'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove ' + p.name);
      rm.addEventListener('click', function () { rows.splice(i, 1); renderRows(); renderResult(); });
      q.appendChild(inp); q.appendChild(rm);
      row.appendChild(info); row.appendChild(q); host.appendChild(row);
    });
    var sel = $('mAdd'); sel.textContent = '';
    sel.appendChild(new Option('Choose a product…', ''));
    C.products.filter(eligible).forEach(function (p) { if (!rows.some(function (r) { return r.id === p.id; })) sel.appendChild(new Option(p.name, p.id)); });
  }

  function renderCards() {
    var host = $('mGrid'); host.textContent = '';
    PREVIEW.forEach(function (id) {
      var p = C.byId(id); if (!p || (p.live && p.live.active === false)) return;
      var c = el('article', 'm-card');
      var img = el('div', 'm-card-img');
      if (p.image) { var im = el('img'); im.src = '../' + p.image; im.alt = p.name; im.loading = 'lazy'; im.width = 300; im.height = 300; img.appendChild(im); }
      c.appendChild(img);
      var b = el('div', 'm-card-body'); b.appendChild(el('h3', 'm-card-name', p.name));
      var off = pct[id] || 0;
      if (pricingLive && off > 0) {
        b.appendChild(el('div', 'm-was', 'Regular ' + inr2(p.price)));
        b.appendChild(el('div', 'm-now', inr2(p.price * (100 - off) / 100)));
        b.appendChild(el('div', 'm-save', 'Member price · save ' + off + '%'));
      } else b.appendChild(el('div', 'm-now', inr2(p.price)));
      b.appendChild(el('div', 'm-was', 'per ' + (p.unit || 'pc') + (p.allInclusive ? ', all-inclusive' : ', excl. GST')));
      var a = el('a', 'm-btn m-btn-ghost', 'View product'); a.href = p.detail ? '../' + p.detail : '../order.html?add=' + encodeURIComponent(id);
      b.appendChild(a); c.appendChild(b); host.appendChild(c);
    });
  }

  function fillPct() {
    var nfc = pct['black-nfc-card'], fin = pct['google-review-nfc-card'];
    document.querySelectorAll('[data-pct-nfc]').forEach(function (e) { if (nfc) e.textContent = nfc + '%'; });
    document.querySelectorAll('[data-pct-fin]').forEach(function (e) { if (fin) e.textContent = fin + '%'; });
  }

  /* ── data ── */
  function init() {
    var live = window.NTAGZ_LIVE ? window.NTAGZ_LIVE.ready.then(function (d) { if (d) window.NTAGZ_LIVE.apply(C, d); }) : Promise.resolve();
    var pr = fetch('/api/membership/pricing', { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    Promise.all([live, pr]).then(function (res) {
      var d = res[1];
      if (d && d.live && d.products) { pricingLive = true; pct = d.products; fee = Math.round((d.feePaise || DEFAULT_FEE * 100) / 100); if (typeof d.maxTotalDiscountPct === 'number') maxTotal = d.maxTotalDiscountPct; }
      rows = pricingLive ? DEFAULT_ROWS.filter(function (x) { return eligible(C.byId(x[0])); }).map(function (x) { return { id: x[0], qty: x[1] }; }) : [];
      document.querySelectorAll('[data-fee]').forEach(function (e) { e.textContent = fee; });
      fillPct(); renderCards(); renderRows(); renderResult();
      if (!pricingLive) $('mCalcOff').hidden = false;
    });
    $('mAdd').addEventListener('change', function (e) {
      var id = e.target.value; if (!id) return;
      rows.push({ id: id, qty: C.moqFor(C.byId(id)) }); renderRows(); renderResult();
    });
  }

  /* ── account + purchase (unchanged server flow: create-order → Razorpay → verify-payment) ── */
  var ctaIds = ['mHeroCta', 'mJoinCta', 'mStickyCta'];
  function setCta(text, on) { ctaIds.forEach(function (id) { var b = $(id); if (!b) return; b.textContent = text; if (on) b.onclick = on; }); }
  function status(msg, err) { var s = $('mStatus'); s.textContent = msg || ''; s.className = 'm-status' + (err ? ' err' : ''); }

  function checkStatus() {
    fetch('/api/accounts/me', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.user) return null; user = d.user;
      return fetch('/api/membership/status', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; });
    }).then(function (d) {
      if (!d || !d.membership || !d.membership.active) return;
      membership = d.membership;
      var exp = new Date(membership.expiresAt * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      status('Your membership is active until ' + exp + '.');
      setCta('Manage membership', function () { location.href = '/account/'; });
    }).catch(function () { });
  }

  function loadRzp(cb) {
    if (window.Razorpay) return cb();
    var sc = document.createElement('script'); sc.src = 'https://checkout.razorpay.com/v1/checkout.js';
    sc.onload = cb; sc.onerror = function () { status('Could not load the payment window. Please try again.', true); ctaIds.forEach(function (id) { var x = $(id); if (x) { x.disabled = false; x.textContent = 'Become a Member'; } }); };
    document.head.appendChild(sc);
  }

  function purchase() {
    if (membership && membership.active) { location.href = '/account/'; return; }
    if (!user) { location.href = '/account/login.html?next=' + encodeURIComponent('/membership/'); return; }
    var label = 'Become a Member', busy = function (b) { ctaIds.forEach(function (id) { var x = $(id); if (x) { x.disabled = b; x.textContent = b ? 'Please wait…' : label; } }); };
    busy(true); status('');
    fetch('/api/membership/create-order', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (!x.ok) { status(x.d.error || 'Could not start payment. Please try again.', true); busy(false); return; }
        loadRzp(function () {
        var rzp = new Razorpay({
          key: x.d.keyId, order_id: x.d.id, amount: x.d.amount, currency: x.d.currency, name: 'nTagz',
          description: 'ntagz Annual Membership', prefill: { email: user.email, contact: user.phone || '' }, theme: { color: '#FF6A21' },
          handler: function (resp) {
            status('Verifying your payment…');
            fetch('/api/membership/verify-payment', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ razorpay_payment_id: resp.razorpay_payment_id, razorpay_order_id: resp.razorpay_order_id, razorpay_signature: resp.razorpay_signature }) })
              .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
              .then(function (v) {
                if (v.ok && v.d.ok) location.href = '/account/?membership=activated';
                else { status('We could not verify the payment. Email hello@ntagz.com with payment ID ' + resp.razorpay_payment_id + '.', true); busy(false); }
              }).catch(function () { status('Network error while verifying. Email hello@ntagz.com with payment ID ' + resp.razorpay_payment_id + '.', true); busy(false); });
          },
          modal: { ondismiss: function () { busy(false); } }
        });
        rzp.open();
        });
      }).catch(function () { status('Something went wrong. Please try again.', true); busy(false); });
  }

  /* ── sticky CTA (mobile): visible only while neither the hero CTA nor the join card is on screen ── */
  function sticky() {
    var bar = $('mSticky'); if (!bar || !window.IntersectionObserver) return;
    var seen = {};
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { seen[e.target.id] = e.isIntersecting; });
      var show = !seen.mHeroCta && !seen.mJoin && window.scrollY > 200;
      bar.classList.toggle('show', show); document.body.classList.toggle('m-has-sticky', show);
    });
    io.observe($('mHeroCta')); io.observe($('mJoin'));
    window.addEventListener('scroll', function () { if (window.scrollY <= 200) { bar.classList.remove('show'); document.body.classList.remove('m-has-sticky'); } }, { passive: true });
  }

  ctaIds.forEach(function (id) { var b = $(id); if (b) b.onclick = purchase; });
  init(); checkStatus(); sticky();
})();
