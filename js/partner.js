/* Partner programme page (/partner/). Optional enhancements: the page reads fully and every link works without this file.
   - Plan amounts come live from the partner portal's public plan list (never hardcoded here).
   - Plan finder, earnings calculator, territory enquiry, sticky phone CTA.
   - Events go through the site's consent-gated first-party analytics (js/nz-analytics.js); nothing is sent without consent. */
(function () {
  'use strict';
  var API = 'https://partner.ntagz.com/api/v1/partner/types';
  var WA = 'https://wa.me/919960160016?text=';
  var slug = function (k) { return String(k).replace(/_/g, '-'); }; // analytics categories allow a-z, 0-9 and '-'
  function track(name, category) { try { if (window.NZ_ANALYTICS && window.NZ_ANALYTICS.track) window.NZ_ANALYTICS.track(name, category ? { category: slug(category) } : {}); } catch (e) { /* analytics never breaks the page */ } }
  var inr = function (paise) { return '₹' + Math.round(paise / 100).toLocaleString('en-IN'); };
  var money = function (n) { return '₹' + Math.round(n).toLocaleString('en-IN'); };

  // Analytics loads after this file on some visits; record the view once it is there.
  var tries = 0; (function pv() { if (window.NZ_ANALYTICS) return track('partner_page_view'); if (++tries < 20) setTimeout(pv, 500); })();

  // Campaign parameters travel to the application, so the portal sees the same source.
  var q = new URLSearchParams(location.search), carry = [];
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) { var v = q.get(k); if (v && /^[A-Za-z0-9._ -]{1,60}$/.test(v)) carry.push([k, v]); });
  document.querySelectorAll('a[href^="https://partner.ntagz.com/"]').forEach(function (a) {
    if (carry.length) { var u = new URL(a.href); carry.forEach(function (p) { u.searchParams.set(p[0], p[1]); }); a.href = u.toString(); }
    a.addEventListener('click', function () {
      var plan = a.getAttribute('data-plan-select');
      if (plan) track('partner_plan_select', plan); else track('partner_cta_click', a.getAttribute('data-apply') || 'apply');
      track('partner_application_start', plan || a.getAttribute('data-apply') || 'apply');
    });
  });
  document.querySelectorAll('[data-cta]').forEach(function (a) { a.addEventListener('click', function () { track('partner_cta_click', a.getAttribute('data-cta')); }); });
  document.querySelectorAll('[data-wa]').forEach(function (a) { a.addEventListener('click', function () { track('partner_whatsapp_click', a.getAttribute('data-wa')); }); });

  // Live plan amounts. If the request fails, the honest fallback text stays.
  fetch(API, { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (!j || !j.ok || !Array.isArray(j.data)) return;
    var fees = [];
    j.data.forEach(function (t) {
      var el = document.querySelector('[data-amt="' + t.key + '"]'); if (!el || !(t.feePaise > 0)) return;
      fees.push(t.feePaise);
      var what = t.key === 'smile' || t.key === 'smile_plus' ? 'Starter inventory' : 'Opening stock order';
      el.textContent = '';
      var s = document.createElement('strong'); s.textContent = inr(t.feePaise);
      el.append(what + ': ', s, t.gstRateBp === null ? ' plus taxes as applicable, returned to you as stock.' : ', returned to you as stock.');
    });
    if (fees.length) {
      var lo = Math.min.apply(null, fees), hi = Math.max.apply(null, fees), r = document.getElementById('pt-range');
      if (r) r.textContent = lo === hi ? 'Opening orders are ' + inr(lo) + '.' : 'Opening orders range from ' + inr(lo) + ' to ' + inr(hi) + ', depending on the plan.';
    }
  }).catch(function () { /* offline or blocked: fallback text stays */ });

  // Plan finder: highlights the matching card and table row, then scrolls to the card.
  var chips = document.querySelectorAll('[data-find]');
  chips.forEach(function (c) {
    c.setAttribute('aria-pressed', 'false');
    c.addEventListener('click', function () {
      var k = c.getAttribute('data-find');
      chips.forEach(function (x) { x.setAttribute('aria-pressed', String(x === c)); });
      document.querySelectorAll('[data-plan]').forEach(function (p) { p.classList.toggle('is-match', p.getAttribute('data-plan') === k); });
      var card = document.getElementById('plan-' + k);
      if (card) { window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - 90, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); card.querySelector('.pt-apply').focus({ preventScroll: true }); }
      track('partner_cta_click', 'finder-' + k);
    });
  });

  // Each plan card counts once as viewed when half of it is on screen.
  if ('IntersectionObserver' in window) {
    var seen = {};
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { var k = e.target.getAttribute('data-plan'); if (e.isIntersecting && !seen[k]) { seen[k] = 1; track('partner_plan_view', k); io.unobserve(e.target); } }); }, { threshold: 0.5 });
    document.querySelectorAll('.pt-plan[data-plan]').forEach(function (p) { io.observe(p); });
  }

  // Earnings calculator: gross figures only, from the visitor's own inputs.
  var f = document.getElementById('pt-calc-form');
  if (f) {
    var num = function (id) { var v = parseFloat(document.getElementById(id).value); return isFinite(v) && v >= 0 ? v : 0; };
    var put = function (id, text, need) { var d = document.getElementById(id); d.textContent = text; d.classList.toggle('pt-need', !!need); };
    var touched = false;
    var calc = function () {
      var units = num('c-cust') * num('c-qty'), rev = units * num('c-sell'), svc = num('c-cust') * num('c-svc');
      var buyRaw = document.getElementById('c-buy').value.trim(), hasBuy = buyRaw !== '' && isFinite(parseFloat(buyRaw)) && parseFloat(buyRaw) >= 0;
      put('o-rev', money(rev)); put('o-svc', money(svc));
      if (!hasBuy) { ['o-cost', 'o-margin', 'o-gross', 'o-year'].forEach(function (id) { put(id, 'Enter your partner price', true); }); return; }
      var cost = units * parseFloat(buyRaw), margin = rev - cost, gross = margin + svc;
      put('o-cost', money(cost)); put('o-margin', money(margin)); put('o-gross', money(gross)); put('o-year', money(gross * 12));
    };
    f.addEventListener('input', function () { calc(); if (!touched) { touched = true; track('partner_calculator_interaction'); } });
    f.addEventListener('submit', function (e) { e.preventDefault(); });
    (window.requestIdleCallback || function (cb) { setTimeout(cb, 200); })(calc); // first figures after load, off the critical path
  }

  // Territory enquiry: builds a WhatsApp message; nothing is sent to Ntagz from this page.
  var t = document.getElementById('pt-terr');
  if (t) t.addEventListener('submit', function (e) {
    e.preventDefault();
    var city = document.getElementById('t-city').value.trim().slice(0, 60);
    var msg = 'Hi Ntagz! I would like to know about partner opportunities' + (city ? ' in ' + city : '') + '.';
    track('partner_whatsapp_click', 'territory');
    window.open(WA + encodeURIComponent(msg), '_blank', 'noopener');
  });

  // Sticky apply bar on phones once the hero has left the screen, hidden again over the final call to action.
  var bar = document.getElementById('pt-sticky'), hero = document.getElementById('top'), fin = document.getElementById('final');
  if (bar && hero && fin && 'IntersectionObserver' in window) {
    var heroOut = false, finIn = false;
    var sync = function () { var show = heroOut && !finIn; bar.hidden = !show; document.body.classList.toggle('pt-has-sticky', show); };
    new IntersectionObserver(function (es) { heroOut = !es[0].isIntersecting; sync(); }).observe(hero);
    new IntersectionObserver(function (es) { finIn = es[0].isIntersecting; sync(); }).observe(fin);
  }
})();
