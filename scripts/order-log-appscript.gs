/**
 * ═══════════════════════════════════════════════════════════════
 * ntagz — ORDER LEDGER (Apps Script web app)
 * ───────────────────────────────────────────────────────────────
 * Attached to THE same Google Sheet that holds the products / tiers
 * tabs used for catalogue sync. The order page (order.html) POSTs a
 * JSON order every time a customer clicks "Confirm Order via
 * WhatsApp"; this appends one row to an "orders" tab.
 *
 * SETUP (one time):
 *   1. In the ntagz spreadsheet: Extensions → Apps Script.
 *   2. Paste this whole file, save.
 *   3. Deploy → New deployment → type "Web app":
 *        Execute as:  Me
 *        Who has access:  Anyone
 *   4. Copy the /exec  URL into order.html:
 *        window.NTAGZ_ORDER_LOG_ENDPOINT = "https://script.google.com/macros/.../exec"
 *   5. To filter spam, set ALLOW_KEY below to a random string and put
 *      the same value in order.html as window.NTAGZ_ORDER_LOG_KEY.
 *      (It is visible in page source — it stops casual noise, it is
 *      NOT a security boundary.)
 *
 * The "orders" tab (and its header row) is created automatically on
 * the first POST, so no manual tab setup is needed.
 * ═══════════════════════════════════════════════════════════════ */

/** Set to a random string to require a matching `k` in the payload. */
var ALLOW_KEY = '';

/** Column order — keep in sync with the header row below. */
var HEADERS = [
  'Timestamp', 'Ref', 'Name', 'Phone', 'Address', 'Pincode', 'State', 'GSTIN',
  'Items', 'Qty', 'Subtotal', 'Discount', 'Net', 'Shipping', 'GST Amt',
  'Grand Total', 'Status', 'Source'
];

function doPost(e) {
  try {
    var body = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (ALLOW_KEY && body.k !== ALLOW_KEY) return respond('forbidden', 403);

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('orders');
    if (!sh) sh = ss.insertSheet('orders');
    if (sh.getLastRow() === 0) sh.appendRow(HEADERS);

    var items = (body.items || []).map(function (it) {
      return (it.sku || '') + ' x ' + (it.qty || 0) +
        (it.disc > 0 ? ' (-' + it.disc + '%)' : '') +
        ' = ' + it.net;
    }).join(' | ');

    sh.appendRow([
      body.ts || new Date().toISOString(),
      body.ref || '', body.name || '', body.phone || '', body.address || '',
      body.pincode || '', body.state || '', body.gstin || '', items,
      body.qtyTotal || 0, body.subtotal || 0, body.discount || 0, body.netValue || 0,
      body.ship == null ? '' : String(body.ship),
      body.gstAmt == null ? '' : String(body.gstAmt),
      body.grandTotal || 0, 'NEW', body.source || 'order.html'
    ]);

    return respond('ok: ' + (body.ref || 'no-ref'));
  } catch (err) {
    return respond('error: ' + err.message, 500);
  }
}

/** Simple GET health check (also a handy manual test in a browser tab). */
function doGet(e) {
  if (ALLOW_KEY && e.parameter.k !== ALLOW_KEY) return respond('forbidden', 403);
  return respond('ntagz order ledger is up');
}

function respond(message, status) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: (status >= 400) ? 'error' : 'ok', message: message }))
    .setMimeType(ContentService.MimeType.JSON);
}