/* ═══════════════════════════════════════════════════════════════
   ntagz — PRICE LIST TABLE (reads the shared catalogue)
   ───────────────────────────────────────────────────────────────
   Load AFTER js/catalog.js. Renders every product's unit price and
   bulk-tier effective prices using the SAME DISCOUNT_TIERS and
   discountFor() maths the order page quote uses, so this table can
   never drift from what a buyer is actually quoted.

   Tags: requires an element with id="tableHost". The tier columns
   come straight from the catalogue; fixed / noDiscount products get
   a "—" where a discount would otherwise apply.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var CATALOG = window.NTAGZ_CATALOG;
  if (!CATALOG) return;

  var host = document.getElementById('tableHost');
  var headHost = document.getElementById('headHost');
  if (!host) return;

  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  var fmtNum = function (n) {
    return '₹' + new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: n % 1 ? 2 : 0,
      maximumFractionDigits: 2
    }).format(n);
  };

  var products = CATALOG.products;
  var tiers = CATALOG.tiers;

  /* ── Bulk tier pills (the "how it works" strip) ── */
  var pillsHost = document.getElementById('tierPills');
  if (pillsHost) {
    pillsHost.innerHTML = tiers.map(function (t) {
      var range = fmtNum(t.min).replace('₹', '') + '–' +
        (t.max === Infinity ? '+' : (t.max === 499 ? '499' : fmtNum(t.max).replace('₹', '')));
      return '<span class="tier-pill">' + esc(range + (t.percent > 0 ? ' · −' + t.percent + '%' : ' · ' + t.label)) + '</span>';
    }).join('');
  }

  /* Discount columns only — skip the 10–499 "no discount" first tier. */
  var discTiers = tiers.filter(function (t) { return t.percent > 0; });

  var tierHead = function (t) {
    var head = fmtNum(t.min).replace('₹', '') + '+';
    return head + (t.custom ? ' (Custom)' : '  −' + t.percent + '%');
  };
  var tierLabel = function (t) {
    return t.custom ? 'Custom Rate' : t.label + ' · ' + t.percent + '% OFF';
  };

  var unitOf = function (p) {
    var u = p.unitLabel || p.unit || 'pc';
    return u;
  };

  var brandStyle = document.createElement('style');
  brandStyle.textContent =
    'th.t-lbl,td.t-price{white-space:nowrap;font-variant-numeric:tabular-nums;}' +
    'td.t-price{text-align:right;}' +
    '.p-supply{color:var(--ink-2);font-size:.86em;font-weight:500;}' +
    '.m-end{display:block;color:var(--ink-3);font-weight:400;font-size:.8em;}';
  document.head.appendChild(brandStyle);

  /* ── Header ── */
  if (headHost) {
    headHost.innerHTML =
      '<tr>' +
      '<th scope="col">SKU</th><th scope="col">Product</th>' +
      '<th scope="col">Unit (MOQ 10)</th>' +
      discTiers.map(function (t) { return '<th scope="col">' + esc(tierHead(t)) + '</th>'; }).join('') +
      '</tr>';
  }

  /* ── Rows ── */
  var r = '<tbody>';

  products.forEach(function (p) {
    var discounted = p.fixed || p.noDiscount;
    var unitText = unitOf(p);
    var priceTxt = fmtNum(p.price) + (p.price % 1 ? '' : '/') + esc(unitText);
    if (p.fixed && p.fixedQty) priceTxt += ' · ' + esc(p.fixedLabel || '');

    r += '<tr>';
    r += '<th scope="row" data-label="SKU">' + esc(p.sku) +
      (p.badge ? '<span class="m-end">' + esc(p.badge) + '</span>' : '') + '</th>';
    r += '<td data-label="Product">' + esc(p.name) + '</td>';
    r += '<td class="t-price" data-label="Unit (MOQ 10)">' + priceTxt + '</td>';

    discTiers.forEach(function (t) {
      var cell = '—';
      if (!discounted) {
        var pct = CATALOG.discountFor(p, t.min);
        var eff = p.price * (100 - pct) / 100;
        cell = fmtNum(eff) + '<span class="p-supply">/' + esc(unitText) + '</span>';
        if (t.custom) {
          cell = '<a class="p-cta" href="https://wa.me/919960160016?text=Hi%20ntagz!%20Quote%20me%20for%20' +
            encodeURIComponent(p.sku) + '%20at%2010%2C000%2B">Custom quote →</a>';
        }
      }
      r += '<td class="t-price" data-label="' + esc(tierLabel(t)) + '">' + cell + '</td>';
    });

    r += '</tr>';
  });
  r += '</tbody>';

  host.innerHTML = r;
})();