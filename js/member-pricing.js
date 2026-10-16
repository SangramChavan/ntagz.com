/* ntagz — MEMBER PRICING IN THE SHOPPING FLOW
   First "Add to Cart" asks whether the customer is a member. The answer is only a UX hint kept for the session: whether
   someone IS a member is decided by the server (GET /api/membership/status, from their session cookie), and every price shown
   here is a server quote (POST /api/quote). Checkout re-prices again from the session, so nothing in this file can grant a discount.

   Requests: none for a visitor who has not chosen; one status check for a returning member or someone who answered "yes";
   one quote for the cards/product page and one for the cart, only for verified members (cached 60s / debounced). */
(function () {
  'use strict';

  var C = window.NTAGZ_CATALOG, CART = window.NTAGZ_CART;
  if (!C) return;
  try { var mkt = JSON.parse(localStorage.getItem('ntagz.market') || 'null'); if (mkt && mkt.country && mkt.country !== 'IN') return; } catch (e) { } // rewards and member prices are India-only

  var CK = 'ntagz.member.choice', HK = 'ntagz.member.hint', PK = 'ntagz.member.pending', QK = 'ntagz.member.q';
  var sget = function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } };
  var sset = function (k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { } };
  var lget = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var lset = function (k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { } };
  var nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  var money = function (n) { return '₹' + nf.format(Math.round(n * 100) / 100); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  var st = { member: false, loggedIn: false, tier: null, milestones: undefined, lines: null, pct: null };
  var esc = function (v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };   // lines: id -> {unit, was, pct} (server-quoted); pct: id -> % (public pricing)
  var statusP = null, pending = null;
  var choice = function () { return sget(CK); };

  /* ── server calls ── */
  function checkStatus() {
    return fetch('/api/membership/status', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) return { loggedIn: false, member: false };
      if (!r.ok) throw new Error('status');
      /* A price benefit is a paid membership and/or a spending-tier discount. The server decides; this is only what it reported. */
      return r.json().then(function (d) {
        var tier = d && d.tier ? d.tier : null;
        return { loggedIn: true, tier: tier, member: !!((d && d.membership && d.membership.active) || (tier && tier.discountPct > 0)) };
      });
    });
  }
  function applyStatus(res) {
    st.member = res.member; st.loggedIn = !!res.loggedIn; st.tier = res.tier || null;
    lset(HK, res.loggedIn ? '1' : null);        // hint only: a returning signed-in customer skips the question; the server still decides
    if (res.loggedIn) sset(CK, 'yes');
    return res;
  }
  function quote(items, compare) {
    return fetch('/api/quote', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items, compare: !!compare }) })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  /* ── product lookup (same rules as cart-ui) ── */
  var byDetail = {};
  C.products.forEach(function (p) { if (p.detail) { var k = p.detail.replace(/^\/+|\/+$/g, ''); (byDetail[k] = byDetail[k] || []).push(p); } });
  function productFor(card) {
    var b = card.querySelector('[data-product-id]') || card;
    var id = b.getAttribute && b.getAttribute('data-product-id');
    if (id) return C.byId(id);
    var d = (card.getAttribute('data-detail') || '').replace(/^\/+|\/+$/g, '');
    return byDetail[d] && byDetail[d].length === 1 ? byDetail[d][0] : null;
  }
  function targets() {
    var out = [];
    document.querySelectorAll('.product-card[data-detail]').forEach(function (card) {
      var p = productFor(card), pe = card.querySelector('.product-price'); if (p && pe) out.push({ p: p, after: pe });
    });
    var pp = document.querySelector('.prod-price'), m = /\/product\/([^/]+)\/?$/.exec(location.pathname);
    if (pp && m) { var l = byDetail['product/' + decodeURIComponent(m[1])]; if (l && l.length === 1) out.push({ p: l[0], after: pp }); }
    return out;
  }
  var quotable = function (p) {
    var v = p.live || {};
    return p && !p.fixed && v.active !== false && v.available !== false && !(v.left != null && v.left < C.moqFor(p));
  };

  /* ── price blocks on cards and product pages ── */
  function render() {
    document.querySelectorAll('.mp-block,.mp-unlock').forEach(function (n) { n.remove(); });
    targets().forEach(function (t) {
      var ln = st.member && st.lines && st.lines[t.p.id];
      var node = null;
      if (ln && ln.pct > 0) {
        node = el('div', 'mp-block');
        var row = el('div', 'mp-row');
        row.appendChild(el('s', 'mp-was', money(ln.was)));
        row.appendChild(el('strong', 'mp-now', money(ln.unit)));
        row.appendChild(el('span', 'mp-unit', '/ ' + (t.p.unit || 'pc') + (t.p.allInclusive ? ' all-inclusive' : ' + GST')));
        node.appendChild(row);
        node.appendChild(el('div', 'mp-tag', 'Member price · save ' + money(ln.was - ln.unit) + ' (' + Math.round(ln.pct * 100) / 100 + '%)'));
      } else if (!st.member && choice() === 'no' && st.pct && (st.pct[t.p.id] || (st.tierIds && st.tierIds[t.p.id]))) {
        node = el('a', 'mp-unlock', 'Unlock member pricing with Ntagz Rewards →'); node.href = '/membership/';
        node.addEventListener('click', function (e) { e.stopPropagation(); });
      }
      if (node) t.after.parentNode.insertBefore(node, t.after.nextSibling);
    });
  }
  var renderTimer = null;
  function schedule() { clearTimeout(renderTimer); renderTimer = setTimeout(refresh, 60); }

  function refresh() {
    var ts = targets();
    if (st.member) {
      var items = [], seen = {};
      ts.forEach(function (t) { if (quotable(t.p) && !seen[t.p.id]) { seen[t.p.id] = 1; items.push({ id: t.p.id, qty: C.moqFor(t.p) }); } });
      if (!items.length) { st.lines = null; return render(); }
      var key = JSON.stringify(items), c = null;
      try { c = JSON.parse(sget(QK) || 'null'); } catch (e) { }
      if (c && c.key === key && Date.now() - c.t < 60000) { st.lines = c.lines; return render(); }
      quote(items, true).then(function (d) {
        var lines = null;
        if (d && d.member && Array.isArray(d.member.lines)) {
          lines = {};
          d.member.lines.forEach(function (l) { lines[l.id] = { was: l.unitPrice, pct: l.memberPct, unit: l.unitPrice * (100 - l.memberPct) / 100 }; });
          sset(QK, JSON.stringify({ t: Date.now(), key: key, lines: lines }));
        }
        st.lines = lines; render();
      });
    } else if (choice() === 'no' && !st.pct) {
      fetch('/api/membership/pricing', { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        st.pct = d && d.live && d.products ? d.products : {};
        st.tierIds = {}; ((d && d.tierEligible) || []).forEach(function (id) { st.tierIds[id] = 1; });
        render();
      }).catch(function () { });
    } else render();
  }

  /* Public list of running cart milestones (cached 5 min by the browser). A server quote is only needed for the cart if one exists. */
  function loadMilestones() {
    if (st.milestones !== undefined) return;
    st.milestones = null;
    fetch('/api/rewards/tiers', { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      st.milestones = d && d.milestones ? d.milestones : [];
      document.dispatchEvent(new CustomEvent('ntagz:member-pricing'));
    }).catch(function () { st.milestones = []; });
  }

  /* ── cart drawer view (server-quoted, debounced): member prices, cart milestone and tier progress ── */
  var cv = { key: '', data: null, timer: null };
  function cartView(cart) {
    loadMilestones();
    if (!(st.member || (st.milestones && st.milestones.length) || (st.loggedIn && st.tier))) return null;
    var items = Object.keys(cart).map(function (id) { var p = C.byId(id); return p ? { id: id, qty: p.fixed ? 1 : cart[id] } : null; }).filter(Boolean);
    if (!items.length) return null;
    var key = JSON.stringify(items);
    if (cv.key === key) return cv.data;
    clearTimeout(cv.timer);
    cv.timer = setTimeout(function () {
      quote(items, true).then(function (d) {
        cv.key = key; cv.data = null;
        if (d && d.you && d.guest && Array.isArray(d.you.lines) && Array.isArray(d.guest.lines)) {
          var lines = {}, reg = 0, mem = 0;
          d.you.lines.forEach(function (y, i) { var g = d.guest.lines[i]; lines[y.id] = { regular: g.net, member: y.net, pct: y.memberPct }; reg += g.net; mem += y.net; });
          cv.data = { lines: lines, regularSub: reg, memberSub: mem, savings: Math.max(reg - mem, 0), rewards: d.rewards || null, total: d.you.amount };
        }
        document.dispatchEvent(new CustomEvent('ntagz:member-pricing'));
      });
    }, 200);
    return null;
  }
  document.addEventListener('ntagz:cart-change', function () { cv.key = ''; });

  var rupee = function (paise) { return '₹' + nf.format(Math.round(paise) / 100); };
  var rewardWord = function (c) { return c.type === 'free_shipping' ? 'free shipping' : c.value + '% off'; };

  /* Cart milestone (this cart) and tier progress (lifetime spend) are different numbers and shown on separate lines. */
  function rewardsHtml() {
    var cvd = cv.data, rw = cvd && cvd.rewards, h = '';
    if (!rw) return h;
    if (rw.campaign) h += '<p class="mp-reward"><b>Reward unlocked:</b> ' + esc(rw.campaign.name) + (rw.campaign.savingsPaise ? ' (saves ' + rupee(rw.campaign.savingsPaise) + ')' : '') + '</p>';
    if (rw.note) h += '<p class="mp-reward mp-muted">' + esc(rw.note) + '</p>';
    if (rw.next) {
      h += '<p class="mp-reward">Add ' + rupee(rw.next.remainingPaise) + ' of eligible products to unlock ' + esc(rewardWord(rw.next)) + '.</p>';
      if (rw.suggest && rw.suggest.length) h += '<div class="mp-sug">' + rw.suggest.map(function (x) {
        return '<button type="button" class="mp-link mp-add" data-mp-add="' + esc(x.id) + '" data-qty="' + x.qty + '">Add ' + x.qty + ' × ' + esc(x.name) + ' · about ' + rupee(x.valuePaise) + '</button>';
      }).join('') + '</div>';
    }
    if (rw.tier && rw.tier.current) {
      var t = rw.tier;
      h += '<p class="mp-reward mp-muted"><b>Ntagz Rewards:</b> ' + esc(t.current.name) + (t.next ? ' · ' + rupee(t.next.remainingPaise) + ' of qualifying spend to ' + esc(t.next.name) : ' · top tier') +
        (t.afterThisOrder && t.afterThisOrder.tier && t.afterThisOrder.tier.id !== t.current.id ? '. This order would take you to ' + esc(t.afterThisOrder.tier.name) + '.' : '') + '</p>';
    }
    return h;
  }

  function footHtml() {
    var h;
    if (st.member) h = 'Member pricing applied · <button type="button" class="mp-link" data-mp-change>Change</button>';
    else if (st.loggedIn) h = 'Signed in · <a class="mp-link" href="/membership/">How Ntagz Rewards work</a> · <button type="button" class="mp-link" data-mp-change>Change</button>';
    else if (choice() === 'yes') h = 'Not signed in · <a class="mp-link" href="/account/login.html?next=' + encodeURIComponent(location.pathname + location.search) + '">Sign in for member pricing</a> · <button type="button" class="mp-link" data-mp-change>Change</button>';
    else h = 'Member? <button type="button" class="mp-link" data-mp-change>Check member pricing</button> · <a class="mp-link" href="/membership/">Ntagz Rewards</a>';
    return rewardsHtml() + '<p class="mp-foot">' + h + '</p>';
  }

  /* ── styles (injected once at load: price blocks need them before the sheet is ever opened) ── */
  (function () {
    var css = document.createElement('style');
    css.textContent =
      '.mp-block{margin:6px 0 2px}.mp-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.mp-was{font-size:13px;opacity:.6}' +
      '.mp-now{font-size:22px;font-weight:700;color:inherit}.mp-unit{font-size:12px;opacity:.65}' +
      '.mp-tag{display:inline-block;margin-top:4px;font-size:12px;font-weight:700;color:#FF8A57;background:rgba(255,106,33,.16);border-radius:999px;padding:3px 10px}' +
      '.mp-unlock{display:inline-block;margin-top:6px;font-size:13px;font-weight:700;color:#FF8A57;text-decoration:none}.mp-unlock:hover{text-decoration:underline}' +
      '.prod-price-box .mp-tag{color:#B33000;background:#FFF0EB}.prod-price-box .mp-unlock{color:#B33000}' +
      '.mp-reward{font-size:13px;margin:10px 0 0;text-align:left;color:inherit}.mp-muted{opacity:.75}.mp-sug{display:grid;gap:6px;margin:6px 0 0;text-align:left}.mp-add{text-align:left;font-weight:600}' +
      '.mp-foot{font-size:13px;opacity:.8;margin:10px 0 0;text-align:center;color:inherit}.mp-link{background:none;border:0;padding:0;font:inherit;font-weight:700;color:#FF8A57;cursor:pointer;text-decoration:underline}' +
      '.cart-line-total s{display:block;font-size:12px;font-weight:400;opacity:.6}.cart-line-total .mp-save{display:block;font-size:11px;font-weight:700;color:#FF8A57}' +
      '.mp-sheet-root{position:fixed;inset:0;z-index:10050;display:none}.mp-sheet-root.open{display:block}.mp-ov{position:absolute;inset:0;background:rgba(26,23,20,.55)}' +
      '.mp-sheet{position:absolute;left:0;right:0;bottom:0;background:#fff;border-radius:22px 22px 0 0;padding:22px 20px calc(20px + env(safe-area-inset-bottom));box-shadow:0 -8px 32px rgba(0,0,0,.18);max-width:520px;margin:0 auto}' +
      '.mp-sheet h2{font-size:22px;margin:0 0 8px;color:#1A1714;line-height:1.2}.mp-sheet p{margin:0 0 16px;color:#4A4540;font-size:15px;line-height:1.45}' +
      '.mp-btns{display:grid;gap:10px}.mp-btn{min-height:50px;border-radius:14px;border:1.5px solid #E5E0D6;background:#fff;color:#1A1714;font-weight:700;font-size:16px;font-family:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;text-decoration:none;padding:0 16px}' +
      '.mp-btn.primary{background:#FF4500;border-color:#FF4500;color:#fff}.mp-btn[disabled]{opacity:.6;cursor:default}.mp-btn:focus-visible,.mp-link:focus-visible{outline:3px solid #FF8A57;outline-offset:2px}' +
      '.mp-sheet .mp-more{display:block;text-align:center;margin-top:12px;font-size:14px;font-weight:700;color:#B33000}' +
      '@media(min-width:640px){.mp-sheet{bottom:auto;top:50%;transform:translateY(-50%);border-radius:22px}}';
    document.head.appendChild(css);
  })();

  /* ── the first-add sheet ── */
  var sheet = null, body = null, lastFocus = null;
  function ensureSheet() {
    if (sheet) return;
    sheet = el('div', 'mp-sheet-root'); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'mpTitle');
    var ov = el('div', 'mp-ov'); ov.addEventListener('click', closeSheet);
    body = el('div', 'mp-sheet');
    sheet.appendChild(ov); sheet.appendChild(body); document.body.appendChild(sheet);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && sheet.classList.contains('open')) closeSheet(); });
  }
  function closeSheet() { if (sheet) sheet.classList.remove('open'); pending = null; if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { } } }
  function view(title, text, buttons, moreLink) {
    ensureSheet();
    body.textContent = '';
    var h = el('h2', null, title); h.id = 'mpTitle'; body.appendChild(h);
    if (text) body.appendChild(el('p', null, text));
    var box = el('div', 'mp-btns');
    buttons.forEach(function (b) {
      var x = b.href ? el('a', 'mp-btn' + (b.primary ? ' primary' : ''), b.label) : el('button', 'mp-btn' + (b.primary ? ' primary' : ''), b.label);
      if (b.href) x.href = b.href; else { x.type = 'button'; if (b.on) x.addEventListener('click', b.on); }
      if (b.disabled) x.disabled = true; box.appendChild(x);
    });
    body.appendChild(box);
    if (moreLink) { var a = el('a', 'mp-more', 'See how Ntagz Rewards work'); a.href = '/membership/'; body.appendChild(a); }
    if (!sheet.classList.contains('open')) lastFocus = document.activeElement;
    sheet.classList.add('open');
    var f = box.querySelector('button,a'); if (f) f.focus();
  }

  function proceed() {            // add what the customer was adding, then show the (re-priced) cart
    var p = pending; pending = null;
    if (sheet) sheet.classList.remove('open');
    if (p && p.btn && p.btn.isConnected) p.btn.click();
    else if (p && p.id && CART) { CART.add(p.id); var o = document.querySelector('[data-cart-open]'); if (o) o.click(); }
    cv.key = '';                                  // pricing mode may have changed: re-quote and redraw an open cart
    document.dispatchEvent(new CustomEvent('ntagz:member-pricing'));
    schedule();
  }
  function regularPrices() { sset(CK, 'no'); st.member = false; proceed(); }
  function ask() {
    view('Are you an Ntagz member?', 'Members get exclusive pricing on eligible products.', [
      { label: 'I’m a member', primary: true, on: verify },
      { label: 'I’m new to Ntagz', on: regularPrices }
    ], true);
  }
  function verify() {
    view('Checking your rewards…', 'One moment.', [{ label: 'Please wait', disabled: true }]);
    checkStatus().then(function (res) {
      applyStatus(res);
      if (res.member) { proceed(); schedule(); return; }
      var here = location.pathname + location.search;
      if (!res.loggedIn) view('Sign in to check your rewards', 'We’ll look up your membership and tier and keep your cart as it is.', [
        { label: 'Sign in', primary: true, on: function () { if (pending && pending.id) sset(PK, pending.id); location.href = '/account/login.html?next=' + encodeURIComponent(here); } },
        { label: 'Continue at regular prices', on: regularPrices }
      ], true);
      else view('No member pricing yet', res.tier && res.tier.next ? 'You’re on the ' + (res.tier.name || 'Free') + ' tier. ' + rupee(res.tier.next.remainingPaise) + ' more qualifying spend unlocks ' + res.tier.next.name + '.' : 'We couldn’t find member pricing on this account.', [
        { label: 'Continue', primary: true, on: function () { sset(CK, 'yes'); proceed(); } },
        { label: 'See how Ntagz Rewards work', href: '/membership/' }
      ]);
    }).catch(function () {
      view('Couldn’t check right now', 'You can try again, or continue at regular prices. Prices are confirmed again at checkout.', [
        { label: 'Try again', primary: true, on: verify },
        { label: 'Continue at regular prices', on: regularPrices }
      ]);
    });
  }

  /* Capture phase: runs before cart-ui's own click handler, so the first Add to Cart is held until the customer answers. */
  document.addEventListener('click', function (e) {
    var addS = e.target.closest && e.target.closest('[data-mp-add]');
    if (addS && CART) { e.preventDefault(); CART.add(addS.getAttribute('data-mp-add'), parseInt(addS.getAttribute('data-qty'), 10) || undefined); cv.key = ''; return; }
    var chg = e.target.closest && e.target.closest('[data-mp-change]');
    if (chg) { e.preventDefault(); sset(CK, null); st.member = false; pending = null; cv.key = ''; document.dispatchEvent(new CustomEvent('ntagz:member-pricing')); ask(); return; }
    var btn = e.target.closest && e.target.closest('[data-product-id][data-cart-wired]');
    if (!btn || choice()) return;
    e.preventDefault(); e.stopImmediatePropagation();
    pending = { btn: btn, id: btn.dataset.productId };
    if (lget(HK) && statusP) {      // returning member: wait for the server's answer instead of asking
      statusP.then(function () { if (st.member) proceed(); else ask(); });
      return;
    }
    ask();
  }, true);

  /* ── start ── */
  if (choice() === 'yes' || lget(HK)) {
    statusP = checkStatus().then(applyStatus).then(function (r) { schedule(); return r; }).catch(function () { });
  } else if (choice() === 'no') schedule();

  var back = sget(PK);             // returned from signing in with an add waiting
  if (back) {
    sset(PK, null);
    (statusP || (statusP = checkStatus().then(applyStatus).catch(function () { return null; }))).then(function (res) {
      if (!res || !res.loggedIn) return;
      pending = { id: back };
      if (res.member) { proceed(); } else view('No active membership', 'We couldn’t find an active membership on this account.', [
        { label: 'View membership plans', primary: true, href: '/membership/' },
        { label: 'Continue at regular prices', on: regularPrices }
      ]);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule); else schedule();
  if (window.NTAGZ_LIVE && window.NTAGZ_LIVE.ready) window.NTAGZ_LIVE.ready.then(schedule);
  var grid = document.getElementById('productsGrid');
  if (grid) new MutationObserver(schedule).observe(grid, { childList: true });

  window.NTAGZ_MEMBER = { cartView: cartView, footHtml: footHtml, isMember: function () { return st.member; } };
})();
