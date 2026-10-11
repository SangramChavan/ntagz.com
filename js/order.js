/* ═══════════════════════════════════════════════════════════════
   ntagz — ORDER / QUOTE BUILDER
   ───────────────────────────────────────────────────────────────
   Product data lives in js/catalog.js and is shared with the
   homepage grid. Never hard-code a product in this file.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var CATALOG = window.NTAGZ_CATALOG;
  var CART = window.NTAGZ_CART;
  var PRODUCTS = CATALOG.products;
  var TIERS = CATALOG.tiers;
  var SHIP = CATALOG.shipping;

  /* Active category filter: 'nfc' | 'rfid' */
  var activeCategory = 'nfc';

  /* State */
  var selectedIds = [];
  var quantities = {};
  var fetchedCity = '', fetchedState = '';
  var $ = function (id) { return document.getElementById(id); };

  /* This page IS the cart's checkout step — every selection change
     is mirrored back into localStorage so the header badge (and any
     other tab) stays accurate. */
  function syncCart() {
    if (!CART) return;
    var cart = {};
    selectedIds.forEach(function (id) {
      var p = CATALOG.byId(id);
      var qty = p.fixed ? 1 : (quantities[id] || 0);
      if (qty > 0) cart[id] = qty;
    });
    CART.write(cart);
  }

  /* ── FORMATTING ───────────────────────────────────────────── */
  var fmt = function (n) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR',
      minimumFractionDigits: 0, maximumFractionDigits: 0
    }).format(n);
  };
  var fmtNum = function (n) {
    return new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: 0, maximumFractionDigits: 0
    }).format(n);
  };
  /* Unit rates can carry paise (e.g. ₹32.80) — keep them exact. */
  var fmtRate = function (n) {
    return '₹' + new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2
    }).format(n);
  };
  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };
  var sanitize = function (v, max) {
    return String(v || '').replace(/[^\w\s.,\-/#&()]/gi, '').trim().substring(0, max || 80);
  };

  /* Neutral tile drawn for products that have no photo yet. */
  var PLACEHOLDER = '<svg class="prod-thumb-ph" viewBox="0 0 40 40" aria-hidden="true">' +
    '<rect x="5" y="9" width="30" height="22" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<path d="M22 15.5a6 6 0 0 1 0 9M25.5 13a10 10 0 0 1 0 14" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round"/>' +
    '<rect x="9.5" y="14" width="6" height="5" rx="1.2" fill="currentColor" opacity=".55"/></svg>';

  function thumb(p, cls) {
    if (!p.image) return '<span class="' + cls + ' is-placeholder">' + PLACEHOLDER + '</span>';
    return '<span class="' + cls + '"><img src="' + esc(p.image) + '" alt="' + esc(p.name) +
      '" loading="lazy" decoding="async" onerror="this.remove()"></span>';
  }

  /* ── QUOTE HEADER ─────────────────────────────────────────── */
  var quoteNum = 'QT-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  $('quoteNum').textContent = quoteNum;

  var now = new Date();
  var valid = new Date(now); valid.setDate(valid.getDate() + 15);
  var fmtDate = function (d) {
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  $('quoteDate').textContent = fmtDate(now);
  $('quoteValidUntil').textContent = fmtDate(valid);

  /* ── UPI QR ───────────────────────────────────────────────── */
  var qrcodeContainer = new QRCode($('qrcode'), {
    width: 140, height: 140,
    colorDark: '#1A1714', colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });

  /* ── TIER TABLE (rendered from the catalogue) ─────────────── */
  function renderTiers() {
    var host = $('tierRows');
    if (!host) return;
    host.innerHTML = TIERS.map(function (t) {
      var range = t.max === Infinity
        ? fmtNum(t.min) + '+ pcs'
        : fmtNum(t.min) + ' – ' + fmtNum(t.max) + ' pcs';
      return '<div class="tier-row"><span>' + range + '</span><b>' + esc(t.label) + '</b></div>';
    }).join('');
  }

  /* ── PRE-ORDER HELPERS (live.preorder comes from the admin catalogue) ── */
  function preOf(p) { return (p.live && p.live.preorder) || null; }
  /* Largest quantity the server will accept; Infinity = uncapped. */
  function capFor(p) {
    var pre = preOf(p);
    return pre && pre.max_qty != null ? pre.ready_qty + pre.max_qty : Infinity;
  }
  function isUnavailable(p) {
    return !!(p.live && p.live.available === false) || (!p.fixed && capFor(p) < CATALOG.moqFor(p));
  }
  function clampQty(p, q) { return Math.min(q, capFor(p)); }
  /* "X ready to ship, Y pre-order (dispatch: …)" — empty unless part of the line is pre-order. */
  function splitText(p, qty) {
    var pre = preOf(p);
    if (!pre || qty <= 0) return '';
    var ready = Math.min(qty, pre.ready_qty), po = qty - ready;
    if (po <= 0) return '';
    return (ready > 0 ? fmtNum(ready) + ' ready to ship, ' : '') + fmtNum(po) + ' pre-order' +
      (pre.dispatch ? ' (dispatch: ' + pre.dispatch + ')' : '');
  }

  /* ── PRODUCT GRID ─────────────────────────────────────────── */
  function renderGrid() {
    var grid = $('productGrid');
    var visible = PRODUCTS.filter(function (p) {
      return (p.category === activeCategory || p.category === 'both') && !(p.live && p.live.active === false);
    });

    grid.innerHTML = visible.map(function (p) {
      var selected = selectedIds.indexOf(p.id) > -1;
      var unit = p.unitLabel || p.unit || 'pc';
      var soldOut = isUnavailable(p);
      var pre = preOf(p);
      var status = '';
      if (soldOut) status = '<span class="prod-oos">Out of stock</span>';
      else if (pre) {
        status = pre.ready_qty === 0
          ? '<span class="prod-pre">Pre-order</span>'
          : '<span class="prod-ready">Ready to order</span>';
        if (pre.message) status += '<span class="prod-premsg">' + esc(pre.message) + '</span>';
        if (pre.dispatch) status += '<span class="prod-premsg">Dispatch: ' + esc(pre.dispatch) + '</span>';
      }
      if (!soldOut && p.live && p.live.low && p.live.left) {
        status += '<span class="prod-low">Only ' + fmtNum(p.live.left) + ' left</span>';
      }
      return '' +
        '<button type="button" class="prod-card' + (p.fixed ? ' bundle-card' : '') +
        (selected ? ' selected' : '') + '" data-id="' + esc(p.id) + '" aria-pressed="' +
        (selected ? 'true' : 'false') + '"' + (soldOut ? ' disabled' : '') + '>' +
        '<span class="check" aria-hidden="true">' +
        '<svg viewBox="0 0 10 8"><path d="M1 4L3.5 6.5L9 1" stroke="#fff" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></span>' +
        thumb(p, 'prod-thumb') +
        '<span class="prod-body">' +
        (p.badge ? '<span class="prod-badge">' + esc(p.badge) + '</span>' : '') +
        '<span class="prod-name">' + esc(p.name) + '</span>' +
        '<span class="prod-code">' + esc(p.sku) + (p.fixed ? ' · 70 pcs' : '') + '</span>' +
        '<span class="prod-price">' + fmtRate(p.price) + '<span>/' + esc(unit) + '</span></span>' +
        status +
        '</span>' +
        '</button>';
    }).join('');
  }

  /* ── CATEGORY TOGGLE (NFC / RFID) ─────────────────────────── */
  function setCategory(cat) {
    if (cat === activeCategory) return;
    activeCategory = cat;

    var toggle = $('catToggle');
    toggle.classList.toggle('rfid-active', cat === 'rfid');
    Array.prototype.forEach.call(toggle.querySelectorAll('.cat-tab'), function (btn) {
      var isActive = btn.dataset.cat === cat;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    var grid = $('productGrid');
    grid.classList.add('switching');
    setTimeout(function () {
      renderGrid();
      grid.classList.remove('switching');
    }, 180);
  }

  /* ── SELECTED ITEMS (quantity rows) ───────────────────────── */
  function renderSelectedItems() {
    var section = $('selectedSection');
    var hint = $('emptyHint');
    var container = $('selectedItems');

    if (selectedIds.length === 0) {
      section.style.display = 'none';
      hint.style.display = 'block';
      return;
    }
    section.style.display = 'block';
    hint.style.display = 'none';

    container.innerHTML = selectedIds.map(function (id) {
      var p = CATALOG.byId(id);
      var qty = p.fixed ? 1 : (quantities[id] || 0);
      var subtotal = p.price * qty;
      var moq = CATALOG.moqFor(p);
      var unit = p.unitLabel || p.unit || 'pc';

      var cap = capFor(p);
      var qtyCtrl = p.fixed
        ? '<span class="fixed-qty-label">Fixed · 1 kit</span>'
        : '<button type="button" class="qty-btn" data-act="dec" data-id="' + esc(id) +
          '" aria-label="Decrease quantity">&minus;</button>' +
          '<input class="qty-input" type="number" min="' + moq + '"' + (cap !== Infinity ? ' max="' + cap + '"' : '') +
          ' step="1" value="' + qty +
          '" id="qty-' + esc(id) + '" data-id="' + esc(id) + '" aria-label="Quantity for ' + esc(p.name) + '">' +
          '<button type="button" class="qty-btn" data-act="inc" data-id="' + esc(id) +
          '" aria-label="Increase quantity">+</button>';

      return '' +
        '<div class="item-row' + (p.fixed ? ' bundle-row' : '') + '" id="row-' + esc(id) + '">' +
        thumb(p, 'item-thumb') +
        '<div class="item-label">' +
        '<div class="iname">' + esc(p.name) + '</div>' +
        '<div class="iprice">' + (p.fixed
          ? fmtRate(p.price) + '/kit · ' + esc(p.fixedLabel)
          : fmtRate(p.price) + '/' + esc(unit) + ' · ' + esc(p.sku)) + '</div>' +
        '<div class="isplit" id="split-' + esc(id) + '">' + esc(splitText(p, qty)) + '</div>' +
        (cap !== Infinity && !p.fixed ? '<div class="icap">Max ' + fmtNum(cap) + ' available</div>' : '') +
        '</div>' +
        '<div class="qty-ctrl">' + qtyCtrl + '</div>' +
        '<div class="item-total" id="total-' + esc(id) + '">' +
        (subtotal > 0 ? fmt(subtotal) : '—') + '</div>' +
        '<button type="button" class="item-remove" data-act="remove" data-id="' + esc(id) +
        '" aria-label="Remove ' + esc(p.name) + '">' +
        '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" ' +
        'stroke-width="1.6" stroke-linecap="round"/></svg></button>' +
        '</div>';
    }).join('');
  }

  /* ── SELECTION ────────────────────────────────────────────── */
  function toggleProduct(id) {
    var i = selectedIds.indexOf(id);
    if (i > -1) {
      selectedIds.splice(i, 1);
      delete quantities[id];
    } else {
      var p = CATALOG.byId(id);
      if (!p) return;
      selectedIds.push(id);
      if (!p.fixed && !quantities[id]) quantities[id] = CATALOG.moqFor(p);
    }
    renderGrid();
    renderSelectedItems();
    calculateQuote();
    syncCart();
  }

  function addProduct(id) {
    var p = CATALOG.byId(id);
    if (!p || selectedIds.indexOf(id) > -1) return;
    selectedIds.push(id);
    if (!p.fixed) quantities[id] = CATALOG.moqFor(p);
    if (p.category !== activeCategory) setCategory(p.category);
  }

  /* ── QUANTITY ─────────────────────────────────────────────── */
  function adjustQty(id, delta) {
    var p = CATALOG.byId(id);
    var moq = CATALOG.moqFor(p);
    var step = p.step || (moq >= 10 ? 10 : 1);
    var current = quantities[id] || moq;
    quantities[id] = Math.max(moq, clampQty(p, current + delta * step));
    var inp = $('qty-' + id);
    if (inp) inp.value = quantities[id];
    updateItemTotal(id);
    calculateQuote();
    syncCart();
  }

  function setQty(id, val) {
    // Allow free typing (multi-digit entry), but never go negative.
    var parsed = parseInt(val, 10);
    quantities[id] = isNaN(parsed) ? 0 : clampQty(CATALOG.byId(id), Math.max(0, parsed));
    if (!isNaN(parsed) && String(quantities[id]) !== String(val).trim()) {
      var inp = $('qty-' + id);
      if (inp) inp.value = quantities[id];
    }
    updateItemTotal(id);
    calculateQuote();
    syncCart();
  }

  function enforceMoq(id) {
    // Snap back up to the MOQ once the user leaves the field.
    var moq = CATALOG.moqFor(CATALOG.byId(id));
    if ((quantities[id] || 0) < moq) {
      quantities[id] = moq;
      var inp = $('qty-' + id);
      if (inp) inp.value = moq;
      updateItemTotal(id);
      calculateQuote();
      syncCart();
    }
  }

  function updateItemTotal(id) {
    var p = CATALOG.byId(id);
    var qty = p.fixed ? 1 : (quantities[id] || 0);
    var el = $('total-' + id);
    if (el) el.textContent = qty > 0 ? fmt(p.price * qty) : '—';
    var sp = $('split-' + id);
    if (sp) sp.textContent = splitText(p, qty);
  }

  /* ── PINCODE LOOKUP ───────────────────────────────────────── */
  function checkPincodeLength(val) {
    var clean = val.replace(/[^0-9]/g, '');
    if (clean.length === 6) { fetchLocationData(clean); return; }
    fetchedCity = ''; fetchedState = '';
    $('customerState').value = '';
    resetLocation('Auto-filled from pincode');
    $('pincodeLoader').style.display = 'none';
    calculateQuote();
  }

  function resetLocation(text) {
    var locDisplay = $('locationDisplay');
    var locText = $('locationText');
    locDisplay.classList.remove('filled');
    locText.className = 'location-placeholder';
    locText.textContent = text;
  }

  function fetchLocationData(pincode) {
    var loader = $('pincodeLoader');
    loader.style.display = 'block';
    loader.className = 'field-note';
    loader.textContent = 'Looking up pincode…';
    resetLocation('Looking up…');

    fetch('https://api.postalpincode.in/pincode/' + pincode)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data[0] && data[0].Status === 'Success') {
          var po = data[0].PostOffice[0];
          fetchedCity = po.District;
          fetchedState = po.State;
          $('customerState').value = fetchedState;

          var locDisplay = $('locationDisplay');
          var locText = $('locationText');
          locDisplay.classList.add('filled');
          locText.className = '';
          locText.innerHTML = '<span class="location-city">' + esc(fetchedCity) + '</span>' +
            '<span class="location-state">' + esc(fetchedState) + '</span>';

          loader.className = 'field-note is-ok';
          loader.textContent = fetchedCity + ', ' + fetchedState;
          setTimeout(function () { loader.style.display = 'none'; }, 2000);
        } else {
          loader.className = 'field-note is-error';
          loader.textContent = 'That pincode does not look valid. Please check it.';
          resetLocation('Auto-filled from pincode');
          $('customerState').value = '';
          fetchedCity = ''; fetchedState = '';
        }
        calculateQuote();
      })
      .catch(function () {
        loader.className = 'field-note is-error';
        loader.textContent = 'Could not reach the pincode service. Enter your city manually on WhatsApp.';
        resetLocation('Auto-filled from pincode');
        calculateQuote();
      });
  }

  /* ── MEMBER QUOTE (server-priced; members only) ───────────────
     One status check per page view; quotes are fetched only for active members, debounced, and only re-render when the
     server answers for the cart currently on screen. Any failure leaves the guest estimate (checkout re-prices anyway). */
  var MQ = { member: false, key: '', data: null, timer: null };
  function memberQuoteFor(lineItems, state) {
    if (!MQ || !MQ.member || !lineItems.length) return null;
    var items = lineItems.map(function (li) { return { id: li.p.id, qty: li.qty }; });
    var key = JSON.stringify([items, state]);
    if (MQ.key === key) return MQ.data;
    clearTimeout(MQ.timer);
    MQ.timer = setTimeout(function () {
      fetch('/api/quote', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items, state: state }) })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { MQ.key = key; MQ.data = d && d.you ? d.you : null; calculateQuote(); })
        .catch(function () { });
    }, 350);
    return null;
  }
  fetch('/api/membership/status', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && d.membership && d.membership.active) { MQ.member = true; calculateQuote(); } })
    .catch(function () { });

  /* ── MAIN CALCULATION ─────────────────────────────────────── */
  function calculateQuote() {
    // GST is mandatory on every order — always applied.
    var includeGst = true;

    var cName = sanitize($('customerName').value, 60) || '—';
    var cNumber = sanitize($('customerNumber').value, 20) || '—';
    var cAddress = sanitize($('customerAddress').value, 120) || '—';
    var cPincode = $('customerPincode').value.trim() || '—';
    var cGST = $('customerGST').value.trim().toUpperCase();
    var cState = $('customerState').value || '';

    $('outCustomerName').textContent = cName;
    $('outCustomerNumber').textContent = cNumber;
    $('outCustomerAddress').textContent = cAddress;
    $('outCustomerPincode').textContent = cPincode;
    $('outCustomerState').textContent =
      (fetchedCity && cState) ? fetchedCity + ', ' + cState : (cState || '—');

    var gstNumRow = $('gstNumberRow');
    if (includeGst && cGST.length >= 15) {
      $('outCustomerGST').textContent = cGST;
      gstNumRow.style.display = 'flex';
    } else {
      gstNumRow.style.display = 'none';
    }

    /* Line items. Products flagged `allInclusive` are priced with GST
       + shipping already absorbed — GST/shipping are only computed on
       the regular lines below. */
    var lineItems = [];
    var totalSubtotal = 0, totalDiscount = 0, totalPieces = 0;
    var allIncNet = 0, regNet = 0, hasAllInc = false;

    selectedIds.forEach(function (id) {
      var p = CATALOG.byId(id);
      var qty = p.fixed ? 1 : (quantities[id] || 0);
      if (qty <= 0) return;
      var disc = CATALOG.discountFor(p, qty);
      var sub = p.price * qty;
      var discAmt = sub * disc / 100;
      var net = sub - discAmt;
      if (p.allInclusive) { allIncNet += net; hasAllInc = true; }
      else { regNet += net; }
      lineItems.push({ p: p, qty: qty, sub: sub, disc: disc, discAmt: discAmt, net: net });
      totalSubtotal += sub;
      totalDiscount += discAmt;
      totalPieces += qty * (p.packSize || 1) * (p.fixed ? p.fixedQty : 1);
    });

    var netValue = totalSubtotal - totalDiscount;

    /* Shipping — included in the price of all-inclusive products. */
    var shippingCharge = 0;
    var pillEl = $('shippingInfoPill');
    if (hasAllInc) {
      shippingCharge = 0;
      pillEl.style.display = (cState !== '') ? 'inline-flex' : 'none';
      pillEl.className = 'shipping-info-pill';
      pillEl.textContent = 'Shipping included in price';
    } else if (cState !== '') {
      var isHome = cState === SHIP.homeState;
      if (netValue >= SHIP.freeAbove) {
        shippingCharge = 0;
        pillEl.style.display = 'inline-flex';
        pillEl.className = 'shipping-info-pill';
        pillEl.textContent = 'Free shipping applied to this order';
      } else {
        shippingCharge = isHome ? SHIP.homeStateRate : SHIP.restOfIndiaRate;
        pillEl.style.display = 'inline-flex';
        pillEl.className = 'shipping-info-pill paid';
        pillEl.textContent = isHome
          ? SHIP.homeState + ' flat rate: ' + fmt(SHIP.homeStateRate)
          : 'Rest of India: ' + fmt(SHIP.restOfIndiaRate);
      }
    } else {
      pillEl.style.display = 'none';
    }

    /* GST — 18% on the regular lines only; all-inclusive lines carry it. */
    var gstAmount = includeGst ? Math.round(regNet * 0.18) : 0;
    var cgst = includeGst ? Math.round(regNet * 0.09) : 0;
    var sgst = includeGst ? Math.round(regNet * 0.09) : 0;
    var grandTotal = regNet + gstAmount + allIncNet + shippingCharge;

    /* Member prices. Only the server knows whether this customer is an active member, so for members the quote shows the
       server's numbers for this exact cart: the same amount checkout will charge. Guests keep the local estimate. */
    var memberOff = 0, mq = memberQuoteFor(lineItems, cState);
    if (mq && mq.member) {
      memberOff = mq.memberDiscount;
      netValue = Math.round((netValue - memberOff) * 100) / 100;
      gstAmount = mq.gst; cgst = Math.round(mq.gst / 2); sgst = mq.gst - cgst;
      if (mq.shipping !== shippingCharge && cState !== '') {
        pillEl.className = mq.shipping === 0 ? 'shipping-info-pill' : 'shipping-info-pill paid';
        pillEl.textContent = mq.shipping === 0 ? 'Free shipping applied to this order' : 'Shipping: ' + fmt(mq.shipping);
      }
      shippingCharge = mq.shipping;
      grandTotal = mq.amount;
    }
    var mRow = $('memberDiscountRow');
    if (!mRow) {
      mRow = document.createElement('div'); mRow.id = 'memberDiscountRow'; mRow.className = 'qt-line discount';
      mRow.innerHTML = '<span class="qt-label">Member Discount</span><span class="qt-val" id="outMemberDiscount"></span>';
      var dl = $('outDiscountAmt').parentNode; dl.parentNode.insertBefore(mRow, dl.nextSibling);
    }
    mRow.style.display = memberOff > 0 ? 'flex' : 'none';
    $('outMemberDiscount').textContent = '− ' + fmt(memberOff);

    $('outSubtotal').textContent = fmt(totalSubtotal);
    $('outDiscountAmt').textContent = totalDiscount > 0 ? '− ' + fmt(totalDiscount) : '₹0';
    $('outNet').textContent = fmt(netValue);
    $('outTotal').textContent = fmtNum(grandTotal);

    /* UPI ceiling */
    var upiNotice = $('upiLimitNotice');
    if (grandTotal > 100000) {
      upiNotice.classList.add('show');
      switchPayTab('bank');
    } else {
      upiNotice.classList.remove('show');
    }

    $('bankQuoteRef').textContent = quoteNum;

    /* Pre-order note: ready lines ship now, pre-order parts later (no promise beyond the admin's message). */
    var note = $('preorderNote');
    if (!note) {
      note = document.createElement('p');
      note.id = 'preorderNote'; note.className = 'preorder-note';
      var gt = document.querySelector('.qc-grand-total');
      if (gt && gt.parentNode) gt.parentNode.insertBefore(note, gt);
    }
    var anyPre = false, anyReady = false;
    lineItems.forEach(function (li) {
      var pre = preOf(li.p);
      if (pre && li.qty > pre.ready_qty) anyPre = true;
      if (!pre || pre.ready_qty > 0) anyReady = true;
    });
    note.hidden = !anyPre;
    note.textContent = anyPre
      ? (anyReady ? 'Ready items ship now; pre-order items are dispatched later, as per their pre-order message.'
                  : 'Pre-order items are dispatched later, as per their pre-order message.')
      : '';

    /* Shipping row */
    var shRow = $('shippingRow');
    var outSh = $('outShipping');
    if (cState !== '') {
      shRow.style.display = 'flex';
      outSh.textContent = shippingCharge === 0 ? 'Free' : '+ ' + fmt(shippingCharge);
      shRow.className = shippingCharge === 0 ? 'qt-line shipping-free' : 'qt-line';
    } else {
      shRow.style.display = 'none';
    }

    /* GST rows */
    var gstRow = $('gstRow');
    var gstBreakdown = $('gstBreakdown');
    if (includeGst && regNet > 0) {
      gstRow.style.display = 'flex';
      $('outGst').textContent = '+ ' + fmt(gstAmount);
      $('outCgst').textContent = fmt(cgst);
      $('outSgst').textContent = fmt(sgst);
      gstBreakdown.classList.add('visible');
    } else {
      gstRow.style.display = 'none';
      gstBreakdown.classList.remove('visible');
    }

    /* Items table */
    var wrap = $('itemsTableWrap');
    if (lineItems.length === 0) {
      wrap.innerHTML = '<div class="qc-items-empty">No products selected yet.</div>';
    } else {
      wrap.innerHTML = '' +
        '<table class="q-items-table">' +
        '<thead><tr><th scope="col">Product</th><th scope="col">Qty</th>' +
        '<th scope="col">Rate</th><th scope="col">Amount</th></tr></thead><tbody>' +
        lineItems.map(function (li) {
          var unit = li.p.unitLabel || li.p.unit || 'pc';
          var sub = li.p.fixed
            ? esc(li.p.fixedLabel)
            : esc(li.p.sku) +
              (li.p.allInclusive ? ' · incl. GST &amp; shipping' : '') +
              (li.disc > 0
                ? ' · <span class="td-off">' + li.disc + '% off</span>' : '');
          return '<tr>' +
            '<td><div class="td-product">' + thumb(li.p, 'td-thumb') +
            '<div><div class="td-name">' + esc(li.p.name) + '</div>' +
            '<div class="td-sub">' + sub + '</div></div></div></td>' +
            '<td>' + (li.p.fixed ? '1 kit' : fmtNum(li.qty) + ' ' + CATALOG.unitLabel(li.p, li.qty)) + '</td>' +
            '<td>' + fmtRate(li.p.price) + '/' + esc(unit) + '</td>' +
            '<td>' + fmt(li.net) + '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table>';
    }

    /* UPI intent + QR */
    var upiVpa = 'mayatchavan@axl';
    var merchant = 'Sanjivani Chavan';
    var upiNote = ('ntagz ' + quoteNum).substring(0, 50);
    var upiParams = new URLSearchParams({
      pa: upiVpa, pn: merchant, am: grandTotal.toFixed(2), cu: 'INR', tn: upiNote
    });
    var upiString = 'upi://pay?' + upiParams.toString();
    $('upiLink').href = upiString;
    qrcodeContainer.clear();
    if (grandTotal > 0) qrcodeContainer.makeCode(upiString);

    /* WhatsApp handoff */
    var itemLines = lineItems.map(function (li) {
      var qtyTxt = li.p.fixed
        ? '1 kit (70 pcs)'
        : fmtNum(li.qty) + ' ' + CATALOG.unitLabel(li.p, li.qty);
      var unit = li.p.unitLabel || li.p.unit || 'pc';
      return '- ' + li.p.name + ' (' + li.p.sku + ') x ' + qtyTxt +
        ' @ ' + fmtRate(li.p.price) + '/' + unit +
        (li.p.allInclusive ? ' [GST & ship incl.]' : '') +
        (li.disc > 0 ? ' [-' + li.disc + '%]' : '') + ' = ' + fmt(li.net);
    }).join('\n');

    var gstLine;
    if (hasAllInc && regNet === 0) {
      gstLine = 'GST & Shipping: included in price';
    } else if (includeGst) {
      gstLine = 'GST (18%): + ' + fmt(gstAmount) + '\n  CGST (9%): ' + fmt(cgst) + '\n  SGST (9%): ' + fmt(sgst);
    } else {
      gstLine = 'GST: Not applied';
    }

    var waMsg = 'Hello,\n\n' +
      'I would like to proceed with the following bulk order quotation.\n\n' +
      'QUOTATION REF: ' + quoteNum + '\n' +
      'DATE: ' + fmtDate(now) + '\n\n' +
      'CUSTOMER DETAILS\n' +
      'Name: ' + cName + '\n' +
      'Phone: ' + cNumber + '\n' +
      'Address: ' + cAddress + '\n' +
      'Pincode: ' + cPincode + '\n' +
      'State: ' + (cState || '—') +
      (cGST.length >= 15 ? '\nGST Number: ' + cGST : '') + '\n\n' +
      'ORDER ITEMS\n' + (itemLines || '(no items)') + '\n\n' +
      'SUMMARY\n' +
      'Subtotal:       ' + fmt(totalSubtotal) + '\n' +
      'Bulk Discount:  - ' + fmt(totalDiscount) + '\n' +
      (memberOff > 0 ? 'Member Discount: - ' + fmt(memberOff) + '\n' : '') +
      'Net Value:      ' + fmt(netValue) + '\n' +
      'Shipping:       ' + (hasAllInc ? 'Included' : (cState ? (shippingCharge === 0 ? 'FREE' : fmt(shippingCharge)) : 'TBD')) + '\n' +
      gstLine + '\n' +
      '---------------------\n' +
      'Grand Total:    ' + fmt(grandTotal) + '\n\n' +
      'Please share the next steps for confirmation and dispatch.';

    $('waLink').href = 'https://wa.me/919960160016?text=' + encodeURIComponent(waMsg);
  }

  /* ── PAYMENT TABS ─────────────────────────────────────────── */
  function switchPayTab(tab) {
    $('tabUpi').classList.toggle('active', tab === 'upi');
    $('tabBank').classList.toggle('active', tab === 'bank');
    $('tabRazorpay').classList.toggle('active', tab === 'razorpay');
    $('tabPayu').classList.toggle('active', tab === 'payu');
    $('tabUpi').setAttribute('aria-selected', tab === 'upi' ? 'true' : 'false');
    $('tabBank').setAttribute('aria-selected', tab === 'bank' ? 'true' : 'false');
    $('tabRazorpay').setAttribute('aria-selected', tab === 'razorpay' ? 'true' : 'false');
    $('tabPayu').setAttribute('aria-selected', tab === 'payu' ? 'true' : 'false');
    $('panelUpi').classList.toggle('active', tab === 'upi');
    $('panelBank').classList.toggle('active', tab === 'bank');
    $('panelRazorpay').classList.toggle('active', tab === 'razorpay');
    $('panelPayu').classList.toggle('active', tab === 'payu');
  }

  /* ── COPY BANK DETAIL ─────────────────────────────────────── */
  function copyBankDetail(btn, text) {
    var done = function () {
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { legacyCopy(text); done(); });
    } else {
      legacyCopy(text); done();
    }
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* clipboard unavailable */ }
    document.body.removeChild(ta);
  }

  /* ── EVENT WIRING ─────────────────────────────────────────── */
  $('productGrid').addEventListener('click', function (e) {
    var card = e.target.closest('.prod-card');
    if (card) toggleProduct(card.dataset.id);
  });

  $('selectedItems').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var id = btn.dataset.id;
    if (btn.dataset.act === 'inc') adjustQty(id, 1);
    else if (btn.dataset.act === 'dec') adjustQty(id, -1);
    else if (btn.dataset.act === 'remove') toggleProduct(id);
  });

  $('selectedItems').addEventListener('input', function (e) {
    if (e.target.classList.contains('qty-input')) setQty(e.target.dataset.id, e.target.value);
  });

  $('selectedItems').addEventListener('blur', function (e) {
    if (e.target.classList.contains('qty-input')) enforceMoq(e.target.dataset.id);
  }, true);

  $('catToggle').addEventListener('click', function (e) {
    var tab = e.target.closest('.cat-tab');
    if (tab) setCategory(tab.dataset.cat);
  });

  Array.prototype.forEach.call(
    document.querySelectorAll('[data-recalc]'),
    function (el) { el.addEventListener('input', calculateQuote); }
  );

  $('customerGST').addEventListener('input', function () {
    this.value = this.value.toUpperCase();
    calculateQuote();
  });

  $('customerPincode').addEventListener('input', function () {
    checkPincodeLength(this.value);
  });

  Array.prototype.forEach.call(
    document.querySelectorAll('[data-copy]'),
    function (btn) {
      btn.addEventListener('click', function () { copyBankDetail(btn, btn.dataset.copy); });
    }
  );

  Array.prototype.forEach.call(
    document.querySelectorAll('[data-paytab]'),
    function (btn) {
      btn.addEventListener('click', function () { switchPayTab(btn.dataset.paytab); });
    }
  );

  var printBtn = $('printQuote');
  if (printBtn) printBtn.addEventListener('click', function () { window.print(); });

  /* Order has been handed off to WhatsApp for confirmation — the
     cart's job is done, so clear it rather than leaving stale items
     waiting for the next visit. */
  $('waLink').addEventListener('click', function () {
    recordOfflineOrder(); /* server prices + stores it as an UNPAID order; never blocks WA */
    if (CART && selectedIds.length) CART.clear();
  });

  function recordOfflineOrder() {
    if (!selectedIds.length) return;
    var tab = document.querySelector('.pay-tab.active');
    var pay = tab && tab.getAttribute('data-paytab');
    var items = selectedIds.map(function (id) { return { id: id, qty: CATALOG.byId(id).fixed ? 1 : (quantities[id] || 0) }; });
    fetch((window.paymentApi || '/api') + '/orders/offline', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({
        method: pay === 'bank' ? 'bank' : pay === 'upi' ? 'upi' : 'whatsapp', items: items, quoteRef: $('quoteNum').textContent,
        name: $('customerName').value.trim(), phone: $('customerNumber').value.trim(), address: $('customerAddress').value.trim(),
        pincode: $('customerPincode').value.trim(), state: $('customerState').value, gstin: $('customerGST').value.trim()
      })
    }).catch(function () { /* the WhatsApp message + sheet ledger remain the fallback record */ });
  }

  /* ── INITIAL SELECTION ──────────────────────────────────────
     This page is the cart's checkout step: whatever the customer
     added on the homepage is waiting in localStorage. The
     ?add=id,id2 query string is a secondary entry point (a direct
     link straight into the order page) and only applies when the
     cart is empty, so it can never clobber items the customer
     already picked. */
  function seedFromCart() {
    if (!CART) return false;
    var cart = CART.read();
    var ids = Object.keys(cart);
    ids.forEach(function (id) {
      var p = CATALOG.byId(id);
      if (!p) return;
      selectedIds.push(id);
      quantities[id] = p.fixed ? 1 : cart[id];
    });
    return ids.length > 0;
  }

  var seededFromCart = seedFromCart();
  if (!seededFromCart) {
    var deepLinkRaw = new URLSearchParams(location.search).get('add');
    if (deepLinkRaw) {
      deepLinkRaw.split(',').forEach(function (id) { addProduct(id.trim()); });
      syncCart();
    }
  }

  /* ── INIT ─────────────────────────────────────────────────── */
  renderTiers();
  renderGrid();
  renderSelectedItems();
  calculateQuote();


  /* ── Sticky mobile order bar: mirrors the quote total, hides when the quote card is
     on screen or a field has focus (so it never covers the keyboard / inputs). ── */
  (function () {
    var bar = $('orderBar'), quote = $('quote-card');
    if (!bar || !quote) return;
    var inView = false, typing = false;
    function sync() {
      var inputs = document.querySelectorAll('#selectedItems .qty-input');
      var pcs = 0;
      inputs.forEach(function (i) { pcs += parseInt(i.value, 10) || 0; });
      var n = selectedIds.length;
      $('obTotal').textContent = $('outTotal').textContent;
      $('obCount').textContent = n + (n === 1 ? ' product' : ' products') + (pcs ? ' · ' + pcs + ' pcs' : '');
      bar.hidden = !n || inView || typing;
      document.body.classList.toggle('has-order-bar', !bar.hidden);
    }
    new MutationObserver(sync).observe($('outTotal'), { childList: true, characterData: true, subtree: true });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (e) { inView = e[0].isIntersecting; sync(); }).observe(quote);
    }
    document.addEventListener('focusin', function (e) { typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName); sync(); });
    document.addEventListener('focusout', function () { typing = false; setTimeout(sync, 0); });
    sync();
  })();

  /* Live prices / availability from the admin catalogue (same numbers the server charges). Falls back silently. */
  if (window.NTAGZ_LIVE) {
    window.NTAGZ_LIVE.ready.then(function (data) {
      if (!data || !window.NTAGZ_LIVE.apply(CATALOG, data)) return;
      selectedIds = selectedIds.filter(function (id) {
        var p = CATALOG.byId(id);
        return !(p && p.live && p.live.active === false) && !(p && isUnavailable(p));
      });
      selectedIds.forEach(function (id) {
        var p = CATALOG.byId(id);
        if (!p.fixed && quantities[id]) quantities[id] = clampQty(p, quantities[id]);
      });
      renderGrid();
      renderSelectedItems();
      calculateQuote();
      syncCart();
    });
  }

  if (selectedIds.length) {
    var target = document.getElementById('products');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
})();
