/* ═══════════════════════════════════════════════════════════════
   ntagz — CART UI
   ───────────────────────────────────────────────────────────────
   Renders the cart on top of the state in js/cart.js:
   1. A cart button + item-count badge, injected into the header's
      nav-ctas once components/header.html has loaded.
   2. A slide-in drawer listing cart lines, with a Checkout button
      that sends the customer to /order.html.
   3. Turns every "Order Now" button that points at order.html into
      an "Add to Cart" action (works for hand-written cards, cards
      injected by js/catalog-sync.js, and the RFID spec table row).

   Load order: catalog.js → cart.js → cart-ui.js.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var CATALOG = window.NTAGZ_CATALOG;
  var CART = window.NTAGZ_CART;
  if (!CATALOG || !CART) return;

  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };
  var fmt = function (n) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0
    }).format(n);
  };
  var fmtRate = function (n) {
    return '₹' + new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2
    }).format(n);
  };

  /* ── DRAWER MARKUP (built once, lives at the end of <body>) ── */
  var drawer = document.createElement('div');
  drawer.className = 'cart-drawer-root';
  drawer.innerHTML =
    '<div class="cart-overlay" data-cart-close></div>' +
    '<aside class="cart-drawer" role="dialog" aria-modal="true" aria-label="Your cart">' +
    '<div class="cart-drawer-head">' +
    '<span class="cart-drawer-title">Your Cart</span>' +
    '<button type="button" class="cart-drawer-close" data-cart-close aria-label="Close cart">' +
    '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round"/></svg></button>' +
    '</div>' +
    '<div class="cart-drawer-body" id="cartDrawerBody"></div>' +
    '<div class="cart-drawer-foot" id="cartDrawerFoot"></div>' +
    '</aside>';
  document.body.appendChild(drawer);

  var PLACEHOLDER = '<svg class="cart-thumb-ph" viewBox="0 0 40 40" aria-hidden="true">' +
    '<rect x="5" y="9" width="30" height="22" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<path d="M22 15.5a6 6 0 0 1 0 9M25.5 13a10 10 0 0 1 0 14" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round"/></svg>';

  function thumb(p) {
    if (!p.image) return '<span class="cart-thumb is-ph">' + PLACEHOLDER + '</span>';
    return '<span class="cart-thumb"><img src="' + esc(p.image) + '" alt="" loading="lazy" ' +
      'onerror="this.remove()"></span>';
  }

  function renderDrawer() {
    var cart = CART.read();
    var ids = Object.keys(cart);
    var body = document.getElementById('cartDrawerBody');
    var foot = document.getElementById('cartDrawerFoot');

    if (!ids.length) {
      body.innerHTML = '<div class="cart-empty">Your cart is empty.<br>Add a product to get a bulk quote.</div>';
      foot.innerHTML = '';
      return;
    }

    var subtotal = 0;
    body.innerHTML = ids.map(function (id) {
      var p = CATALOG.byId(id);
      if (!p) return '';
      var qty = p.fixed ? 1 : cart[id];
      var unit = p.unitLabel || p.unit || 'pc';
      var lineTotal = p.price * qty;
      subtotal += lineTotal;
      return '' +
        '<div class="cart-line" data-cart-line="' + esc(id) + '">' +
        thumb(p) +
        '<div class="cart-line-body">' +
        '<div class="cart-line-name">' + esc(p.name) + '</div>' +
        '<div class="cart-line-meta">' + (p.fixed
          ? esc(p.fixedLabel)
          : qty + ' ' + esc(unit) + (qty === 1 ? '' : 's') + ' · ' + fmtRate(p.price) + '/' + esc(unit)) +
        '</div>' +
        '</div>' +
        '<div class="cart-line-total">' + fmt(lineTotal) + '</div>' +
        '<button type="button" class="cart-line-remove" data-cart-remove="' + esc(id) +
        '" aria-label="Remove ' + esc(p.name) + '">' +
        '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" ' +
        'stroke-width="1.6" stroke-linecap="round"/></svg></button>' +
        '</div>';
    }).join('');

    foot.innerHTML =
      '<div class="cart-subtotal-row"><span>Subtotal</span><span>' + fmt(subtotal) + '</span></div>' +
      '<p class="cart-foot-note">GST, bulk discounts and shipping are calculated on the next step.</p>' +
      '<a href="order.html" class="btn btn-tagz btn-block cart-checkout-btn">Checkout →</a>';
  }

  /* ── HEADER BADGE ── */
  function ensureCartButton() {
    var ctas = document.querySelector('.nav-ctas');
    if (!ctas || ctas.querySelector('.cart-btn')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cart-btn';
    btn.setAttribute('aria-label', 'Open cart');
    btn.setAttribute('data-cart-open', '');
    btn.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 3h2l1.2 9.6a2 2 0 0 0 2 1.65h6.7a2 2 0 0 0 ' +
      '1.98-1.7L17 6.5H5.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
      'stroke-linejoin="round"/><circle cx="8" cy="17" r="1.3" fill="currentColor"/>' +
      '<circle cx="14.5" cy="17" r="1.3" fill="currentColor"/></svg>' +
      '<span class="cart-badge" id="cartBadge" hidden>0</span>';
    ctas.insertBefore(btn, ctas.firstChild);
  }

  function updateBadge() {
    var badge = document.getElementById('cartBadge');
    if (!badge) return;
    var n = CART.lineCount();
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.hidden = n === 0;
  }

  function openDrawer() {
    renderDrawer();
    drawer.classList.add('open');
    document.body.classList.add('cart-open-lock');
  }
  function closeDrawer() {
    drawer.classList.remove('open');
    document.body.classList.remove('cart-open-lock');
  }

  /* ── "ORDER NOW" → "ADD TO CART" ── */
  var byDetail = {};
  CATALOG.products.forEach(function (p) {
    if (p.detail) byDetail[p.detail.replace(/^\/+|\/+$/g, '')] = p;
  });

  function resolveProduct(el) {
    var explicit = el.getAttribute('data-product-id');
    if (!explicit) {
      var idCard = el.closest('[data-product-id]');
      if (idCard) explicit = idCard.getAttribute('data-product-id');
    }
    if (explicit) return CATALOG.byId(explicit);
    var card = el.closest('[data-detail]');
    if (card) return byDetail[(card.getAttribute('data-detail') || '').replace(/^\/+|\/+$/g, '')];
    return null;
  }

  function convertOrderButtons(root) {
    var scope = root || document;
    Array.prototype.forEach.call(
      scope.querySelectorAll(
        'a.add-btn[href="order.html"], a.add-btn[href$="/order.html"], ' +
        'a.add-btn[href^="order.html?"], a.add-btn[href*="/order.html?"]'
      ),
      function (a) {
        if (a.dataset.cartWired) return;
        var p = resolveProduct(a);
        if (!p) return;
        a.dataset.cartWired = '1';
        a.dataset.productId = p.id;
        a.setAttribute('href', '#');
        a.setAttribute('role', 'button');
        var label = a.textContent.replace(/Order( Now)?\s*→?/i, '').trim();
        a.textContent = label ? label : 'Add to Cart';
        if (!label) a.textContent = 'Add to Cart';
      }
    );
  }

  function flashAdded(el) {
    var original = el.textContent;
    el.classList.add('is-added');
    el.textContent = 'Added ✓';
    setTimeout(function () {
      el.classList.remove('is-added');
      el.textContent = original;
    }, 1400);
  }

  /* ── EVENT WIRING (delegated so it works for injected cards too) ── */
  document.addEventListener('click', function (e) {
    var addBtn = e.target.closest('[data-product-id][data-cart-wired]');
    if (addBtn) {
      e.preventDefault();
      var p = CATALOG.byId(addBtn.dataset.productId);
      if (p) {
        CART.add(p.id);
        flashAdded(addBtn);
      }
      return;
    }
    if (e.target.closest('[data-cart-open]')) {
      e.preventDefault();
      openDrawer();
      return;
    }
    if (e.target.closest('[data-cart-close]')) {
      closeDrawer();
      return;
    }
    var removeBtn = e.target.closest('[data-cart-remove]');
    if (removeBtn) {
      CART.remove(removeBtn.getAttribute('data-cart-remove'));
      renderDrawer();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
  });

  document.addEventListener('ntagz:cart-change', function () {
    updateBadge();
    if (drawer.classList.contains('open')) renderDrawer();
  });

  document.addEventListener('ntagz:header-loaded', function () {
    ensureCartButton();
    updateBadge();
  });

  /* The header is injected by an async fetch in component-loader.js,
     which can resolve — and fire ntagz:header-loaded — before this
     script has finished registering the listener above. A
     MutationObserver on the placeholder is immune to that race: it
     fires whenever the header actually appears, no matter which
     script loaded first. */
  var headerPlaceholder = document.getElementById('header-placeholder');
  if (headerPlaceholder) {
    if (headerPlaceholder.querySelector('.nav-ctas')) {
      ensureCartButton();
      updateBadge();
    } else {
      var headerObs = new MutationObserver(function () {
        if (headerPlaceholder.querySelector('.nav-ctas')) {
          ensureCartButton();
          updateBadge();
          headerObs.disconnect();
        }
      });
      headerObs.observe(headerPlaceholder, { childList: true });
    }
  }

  convertOrderButtons(document);

  /* Homepage cards injected later by catalog-sync.js. */
  var grid = document.getElementById('productsGrid');
  if (grid) {
    var mo = new MutationObserver(function () { convertOrderButtons(grid); });
    mo.observe(grid, { childList: true });
  }
})();
