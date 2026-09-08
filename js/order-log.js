/* ═══════════════════════════════════════════════════════════════
   ntagz — ORDER LEDGER TRANSPORT (fire-and-forget)
   ───────────────────────────────────────────────────────────────
   Called from js/order.js when "Confirm Order via WhatsApp" is
   clicked. POSTs the last computed quote as JSON to the Apps Script
   web app (scripts/order-log-appscript.gs), which appends a row to
   the "orders" tab of the Google Sheet.

   Never blocks the WhatsApp handoff and never errors into the page
   UI: if writing the ledger fails, the customer still reaches
   WhatsApp and a local fallback record is kept.

   Config (set in order.html BEFORE this file loads):
     window.NTAGZ_ORDER_LOG_ENDPOINT = "https://script.google.com/macros/.../exec";
     window.NTAGZ_ORDER_LOG_KEY      = "";  // optional; must match the script's ALLOW_KEY

   POST uses Content-Type text/plain (a CORS "simple request"), so
   no preflight round-trip is needed against script.google.com.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var ENDPOINT = window.NTAGZ_ORDER_LOG_ENDPOINT || '';
  var KEY = window.NTAGZ_ORDER_LOG_KEY || '';

  /* Kept append-only in localStorage as a minimal receipt (ref/timestamp/
     total only — never customer PII) so nothing is lost even when the
     sheet write fails (network, deploy, etc.). Trimmed to the last 40. */
  function stash(data) {
    try {
      var list = JSON.parse(window.localStorage.getItem('ntagz.ledger') || '[]');
      list.push({ ts: data.ts, ref: data.ref, grandTotal: data.grandTotal });
      if (list.length > 40) list = list.slice(list.length - 40);
      window.localStorage.setItem('ntagz.ledger', JSON.stringify(list));
    } catch (e) { /* storage unavailable — the sheet write is best-effort */ }
  }

  function send(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      redirect: 'follow'
    }).catch(function () {
      /* Last resort: no-cors request (opaque response, result unreadable —
         the Apps Script append either happened or not; we already stashed). */
      return fetch(url, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: body
      });
    });
  }

  window.NTAGZ_LOG_ORDER = function (data) {
    if (!ENDPOINT || !data) return Promise.resolve(false);
    var body = JSON.stringify(data);
    if (KEY) body = JSON.stringify(Object.assign({ k: KEY }, data));

    stash(data); /* local fallback, always */
    return send(ENDPOINT, body).then(function (res) {
      /* Soft-ack: if the server answered, it accepted the row.
         Non-2xx is still not a page error. */
      return res && res.ok !== false ? true : false;
    }).catch(function () {
      return false;
    });
  };
})();