/* ntagz — PRODUCT PAGE LIVE PRICE
   A product page's ₹ figure is written into its HTML as a fallback. The admin's catalogue (via
   NTAGZ_LIVE from js/catalog-live.js) is the source of truth, because the server charges that price.
   .prod-price is keyed by the page's product id (its folder name); pages showing several products
   (size pickers) mark each price with data-price-for="<product id>". If the live request fails,
   the static numbers stay. */
(function () {
  'use strict';

  var L = window.NTAGZ_LIVE;
  if (!L) return;
  var money = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  function setPrice(el, price) {
    Array.prototype.some.call(el.childNodes, function (n) {
      if (n.nodeType !== 3 || !/₹\s*[\d,]+(\.\d+)?/.test(n.textContent)) return false;
      n.textContent = n.textContent.replace(/₹\s*[\d,]+(\.\d+)?/, '₹' + money.format(price));
      return true;
    });
  }

  L.ready.then(function (data) {
    if (!Array.isArray(data)) return;
    var byId = {};
    data.forEach(function (r) { if (r && r.id) byId[r.id] = r; });

    function livePrice(id, el) {
      var row = byId[id];
      if (!el || !row || typeof row.price !== 'number' || !isFinite(row.price) || row.price < 0) return;
      setPrice(el, row.price);
    }

    var m = /\/product\/([^/]+)\/?$/.exec(window.location.pathname);
    if (m) livePrice(decodeURIComponent(m[1]), document.querySelector('.prod-price'));

    Array.prototype.forEach.call(document.querySelectorAll('[data-price-for]'), function (el) {
      livePrice(el.getAttribute('data-price-for'), el);
    });
  });
})();
