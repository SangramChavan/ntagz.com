/* ═══════════════════════════════════════════════════════════════
   ntagz — SHARED CART STATE
   ───────────────────────────────────────────────────────────────
   Cart contents live in localStorage so they follow the customer
   from the homepage grid to the /order.html checkout. This file
   only manages state; js/cart-ui.js renders it (badge + drawer).

   Shape stored under KEY:  { "<productId>": <qty>, ... }
   `qty` is already in the product's own unit (pcs, kits, packs…).

   Requires js/catalog.js to be loaded first (for prices/MOQ/fixed
   quantities) — load order: catalog.js → cart.js → cart-ui.js.
   ═══════════════════════════════════════════════════════════════ */

(function (root) {
  'use strict';

  var KEY = 'ntagz_cart_v1';

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function write(cart) {
    try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch (e) { /* storage unavailable */ }
    document.dispatchEvent(new CustomEvent('ntagz:cart-change', { detail: cart }));
  }

  function catalog() { return root.NTAGZ_CATALOG; }

  /* Add `qty` of a product (defaults to its MOQ). Fixed-quantity
     products (the sample kit) always sit at 1 in the cart. */
  function add(id, qty) {
    var CATALOG = catalog();
    var p = CATALOG && CATALOG.byId(id);
    if (!p) return read();
    var cart = read();
    if (p.fixed) {
      cart[id] = 1;
    } else {
      var moq = CATALOG.moqFor(p);
      var current = cart[id] || 0;
      cart[id] = Math.max(moq, current + (qty || moq));
    }
    write(cart);
    return cart;
  }

  function setQty(id, qty) {
    var cart = read();
    if (!qty || qty <= 0) delete cart[id];
    else cart[id] = qty;
    write(cart);
    return cart;
  }

  function remove(id) {
    var cart = read();
    delete cart[id];
    write(cart);
    return cart;
  }

  function clear() {
    write({});
  }

  /* Replace the whole cart in one shot (used by order.html so every
     edit there — add, remove, quantity change — stays mirrored). */
  function replace(cart) {
    write(cart || {});
  }

  function lineCount(cart) {
    cart = cart || read();
    return Object.keys(cart).length;
  }

  /* Total pieces across the cart — a kit counts as its own fixedQty. */
  function totalPieces(cart) {
    cart = cart || read();
    var CATALOG = catalog();
    var total = 0;
    Object.keys(cart).forEach(function (id) {
      var p = CATALOG && CATALOG.byId(id);
      if (!p) return;
      total += p.fixed ? (p.fixedQty || 1) : cart[id];
    });
    return total;
  }

  root.NTAGZ_CART = {
    KEY: KEY,
    read: read,
    write: replace,
    add: add,
    setQty: setQty,
    remove: remove,
    clear: clear,
    lineCount: lineCount,
    totalPieces: totalPieces
  };

  /* Keep other tabs in sync (e.g. cart updated on the homepage tab
     while /order.html is open in another). */
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) {
      document.dispatchEvent(new CustomEvent('ntagz:cart-change', { detail: read() }));
    }
  });

})(window);
