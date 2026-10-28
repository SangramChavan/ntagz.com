/* ntagz — PRODUCT PAGE LIVE PRICE
   A product page's ₹ figure is written into its HTML as a fallback. The admin's catalogue (via
   NTAGZ_LIVE from js/catalog-live.js) is the source of truth, because the server charges that price.
    This updates the price in .prod-price from the shared catalogue, keyed by the page's product id (its folder name).
   If the live request fails, the static number stays. */
(function () {
  'use strict';

  var L = window.NTAGZ_LIVE;
  var m = /\/product\/([^/]+)\/?$/.exec(window.location.pathname);
  if (!L || !m) return;
  var id = decodeURIComponent(m[1]);
  var money = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  L.ready.then(function (data) {
    if (!Array.isArray(data)) return;
    var row = null;
    for (var i = 0; i < data.length; i++) {
      if (data[i] && data[i].id === id) { row = data[i]; break; }
    }
    if (!row || typeof row.price !== 'number' || !isFinite(row.price) || row.price < 0) return;

    var catalog = window.NTAGZ_CATALOG;
    if (!catalog || typeof catalog.byId !== 'function') return;
    L.apply(catalog, data);

    var id = m[1];
    var product = catalog.byId(id);
    if (!product) return;
    var els = document.querySelectorAll('.prod-price');
    Array.prototype.forEach.call(els, function (el) {
      Array.prototype.some.call(el.childNodes, function (n) {
        if (n.nodeType !== 3 || !/₹\s*[\d,]+(\.\d+)?/.test(n.textContent)) return false;
        n.textContent = n.textContent.replace(/₹\s*[\d,]+(\.\d+)?/, '₹' + money.format(product.price));
        return true;
      });
    });
  });
})();
