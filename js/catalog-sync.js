/* ═══════════════════════════════════════════════════════════════
   ntagz — HOMEPAGE ↔ ORDER PAGE SYNC
   ───────────────────────────────────────────────────────────────
   Reads js/catalog.js and keeps index.html in step with it:

   1. Every "Order Now" button deep-links to order.html?add=<id>,
      so the product arrives pre-selected on the order page.
   2. Any catalogue product marked  home: true  that has NO
      hand-written card in index.html gets one rendered here.

   Hand-written cards always win — this script never rewrites the
   copy of a card that already exists in the HTML, so the SEO text
   on index.html is safe. Set `homeStatic: true` in the catalogue
   for products that have one.

   Must load BEFORE js/index.js so the reveal/stagger observers in
   that file pick up the injected cards.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var CATALOG = window.NTAGZ_CATALOG;
  if (!CATALOG) return;

  var grid = document.getElementById('productsGrid');
  if (!grid) return;

  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  var fmtRate = function (n) {
    return '₹' + new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2
    }).format(n);
  };

  /* ── 1. Deep-link the existing "Order Now" buttons ──────────
     A static card is matched to its catalogue entry by the
     product-page path it already points at.                    */
  var byDetail = {};
  CATALOG.products.forEach(function (p) {
    if (p.detail) byDetail[p.detail.replace(/^\/+|\/+$/g, '')] = p;
  });

  Array.prototype.forEach.call(
    grid.querySelectorAll('.product-card[data-detail]'),
    function (card) {
      var key = (card.getAttribute('data-detail') || '').replace(/^\/+|\/+$/g, '');
      var p = byDetail[key];
      if (!p) return;
      card.setAttribute('data-product-id', p.id);
      Array.prototype.forEach.call(card.querySelectorAll('a.add-btn'), function (a) {
        var href = a.getAttribute('href') || '';
        if (href.indexOf('order.html') === 0 && href.indexOf('?') === -1) {
          a.setAttribute('href', 'order.html?add=' + encodeURIComponent(p.id));
        }
      });
    }
  );

  /* ── 2. Render cards for catalogue products with no card yet ── */
  var present = {};
  Array.prototype.forEach.call(
    grid.querySelectorAll('.product-card[data-product-id]'),
    function (c) { present[c.getAttribute('data-product-id')] = true; }
  );

  var missing = CATALOG.products.filter(function (p) {
    return p.home && !p.homeStatic && !present[p.id];
  });

  if (!missing.length) return;

  var PLACEHOLDER =
    '<svg class="product-photo-ph" viewBox="0 0 40 40" role="img" aria-label="Product photo coming soon">' +
    '<rect x="5" y="9" width="30" height="22" rx="3" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    '<path d="M22 15.5a6 6 0 0 1 0 9M25.5 13a10 10 0 0 1 0 14" fill="none" stroke="currentColor" ' +
    'stroke-width="1.4" stroke-linecap="round"/>' +
    '<rect x="9.5" y="14" width="6" height="5" rx="1.2" fill="currentColor" opacity=".5"/></svg>';

  function cardHtml(p) {
    var isRfid = p.category === 'rfid';
    var img = p.image
      ? '<img alt="' + esc(p.name) + ' — ntagz" class="product-photo" loading="lazy" ' +
        'decoding="async" src="' + esc(p.image) + '" onerror="this.remove()"/>'
      : PLACEHOLDER;

    var nameEl = p.detail
      ? '<a class="product-name" href="' + esc(p.detail) + '" style="display:block;">' + esc(p.name) + '</a>'
      : '<div class="product-name">' + esc(p.name) + '</div>';

    var unit = p.unitLabel || p.unit || 'pc';

    return '' +
      '<div class="product-card' + (isRfid ? ' rfid-card' : '') + '"' +
      ' data-cat="' + esc(p.homeCategory || p.category) + '"' +
      ' data-product-id="' + esc(p.id) + '"' +
      (p.detail ? ' data-detail="' + esc(p.detail) + '" role="link" tabindex="0"' +
        ' aria-label="View details for ' + esc(p.name) + '"' : '') + '>' +
      (p.badge ? '<span class="product-badge badge-new">' + esc(p.badge) + '</span>' : '') +
      '<span class="tech-badge ' + (isRfid ? 'tech-rfid">RFID' : 'tech-nfc">NFC') + '</span>' +
      '<div class="product-img" style="background:#fff;overflow:hidden;">' + img + '</div>' +
      '<div class="product-info">' +
      '<div class="product-tags">' +
      (p.tags || []).map(function (t) { return '<span class="ptag">' + esc(t) + '</span>'; }).join('') +
      '</div>' +
      nameEl +
      '<div class="product-desc">' + esc(p.desc || '') + '</div>' +
      '<div class="product-meta">' +
      '<div class="product-price">' +
      '<div class="price-from">Price</div>' +
      fmtRate(p.price) + ' <span class="price-unit">/ ' + esc(unit) + '</span>' +
      '<div class="price-gst">+GST</div>' +
      '</div>' +
      '<a class="add-btn" href="order.html?add=' + encodeURIComponent(p.id) + '">Order Now →</a>' +
      '</div></div></div>';
  }

  var frag = document.createElement('div');
  frag.innerHTML = missing.map(cardHtml).join('');
  var newCards = Array.prototype.slice.call(frag.children);

  /* Keep the "Don't see what you need?" card last. */
  var customCard = grid.querySelector('.custom-card');
  newCards.forEach(function (card) {
    if (customCard) grid.insertBefore(card, customCard);
    else grid.appendChild(card);
  });

  /* The card-click delegation in index.html runs at parse time, so
     these cards need the same behaviour wired up here. */
  newCards.forEach(function (card) {
    var href = card.getAttribute('data-detail');
    if (!href) return;
    var open = function (event) {
      if (event.target.closest('a, button, input, select, textarea')) return;
      if (event.type === 'keydown') {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
      }
      window.location.href = href;
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', open);
  });
})();
