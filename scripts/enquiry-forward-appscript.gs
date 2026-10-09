/**
 * ═══════════════════════════════════════════════════════════════
 * ntagz — ENQUIRY FORWARDER (Apps Script onEdit trigger)
 * ───────────────────────────────────────────────────────────────
 * Attached to the same ntagz Google Sheet that holds the products /
 * tiers / orders tabs. Runs the moment you PASTE A CONTACT NUMBER
 * into the "Enquiry" tab: it reads the whole row (all columns) and
 * auto-forwards the full customer details to you.
 *
 * Free route (no API keys, nothing to buy):
 *   1. An instant email alert to your inbox with every detail.
 *   2. A one-tap WhatsApp link, pre-filled with the same details,
 *      so you can open the chat with that customer and follow up.
 *
 * (A fully-automatic WhatsApp send — no tap needed — requires a
 * WhatsApp Business gateway API like Interakt/2Chat/Twilio, which is
 * a paid, separate setup. Say the word if you want that route.)
 *
 * SETUP (one time):
 *   1. Open the ntagz spreadsheet → Extensions → Apps Script.
 *   2. Paste this whole file at the end (next to the order ledger
 *      functions if they live in the same project), save.
 *   3. In the "Triggers" ⏰ sidebar: Add trigger →
 *        Function:  onEnquiryEdit
 *        Event:     On edit
 *        Fires:     Head
 *      (or run installTrigger() once — it creates the same trigger.)
 *   4. Edit CONFIG below: your alert email address / WhatsApp number.
 *   5. Test: type a phone number into the Enquiry tab → email lands
 *      in your inbox within seconds, with a pre-filled wa.me link.
 *
 * How it stays quiet:
 *   - Only the "Enquiry" tab (case-insensitive name match).
 *   - Only when the edited cell is a phone/contact/mobile column and
 *     actually LOOKS like a number (10-15 digits).
 *   - Only when the value CHANGED (no repeat emails on re-edits),
 *     and a short 2-minute dedupe guard stops double fires.
 * ═══════════════════════════════════════════════════════════════ */

var CONFIG = {
  /* Your inbox — where the forwarded details arrive. */
  ALERT_EMAIL: 'you@example.com',

  /* Your WhatsApp number with country code, NO +, e.g. '9198xxxxxxxx'.
     Used only to build the one-tap wa.me follow-up link in the email. */
  WHATSAPP_NUMBER: '9198xxxxxxxx',

  /* Which tab counts as "Enquiry" (regex, case-insensitive). */
  TAB_PATTERN: 'enquir',

  /* The column header(s) that hold the pasted number. */
  PHONE_COL_PATTERN: /phone|contact|mobile|whatsapp|number/i
};

/* Installs the onEdit trigger for onEnquiryEdit (run once from the
   Script Editor, or add the trigger manually in the Triggers UI). */
function installTrigger() {
  var ss = SpreadsheetApp.getActive();
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'onEnquiryEdit') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('onEnquiryEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();
}

function onEnquiryEdit(e) {
  try {
    if (!e || !e.range) return;

    var sh = e.range.getSheet();
    if (!sh || !new RegExp(CONFIG.TAB_PATTERN, 'i').test(sh.getName())) return;

    var row = e.range.getRow();
    var col = e.range.getColumn();
    if (row <= 1) return; // header row

    var value = String(e.value || '').trim();
    if (!isPhone(value)) return; // not a pasted contact number
    if (e.oldValue === e.value) return; // value did not change

    var header = sh.getRange(1, col).getValue();
    if (!CONFIG.PHONE_COL_PATTERN.test(String(header).trim()) &&
        !isPhone(value)) return;

    /* Dedupe: remember the last (tab,row,phone) we already alerted. */
    var key = sh.getName() + '|' + row + '|' + value;
    var store = PropertiesService.getScriptProperties();
    var last = store.getProperty('LAST_ALERT');
    if (last === key) return; // already sent for this exact paste
    store.setProperty('LAST_ALERT', key);

    var details = buildRowText(sh, row, value);

    var waText = encodeURIComponent('New enquiry:\n' + details);
    var waLink = 'https://wa.me/' + CONFIG.WHATSAPP_NUMBER + '?text=' + waText;

    var body =
      'New enquiry from the ntagz sheet "' + sh.getName() + '" (row ' + row + '):\n\n' +
      details +
      '\n\nOne-tap WhatsApp follow-up:\n' + waLink;

    MailApp.sendEmail({
      to: CONFIG.ALERT_EMAIL,
      subject: 'nTagz new enquiry — ' + value,
      body: body
    });
  } catch (err) {
    /* Alert failures should never break the sheet. */
    console.error('enquiry-forward', err.message);
  }
}

function isPhone(v) {
  var digits = v.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

/* Reads the whole row, labels each column with its header, and drops
   empty cells so the email only carries real information. */
function buildRowText(sh, row, phone) {
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var rowVals = sh.getRange(row, 1, 1, lastCol).getValues()[0];

  var lines = [];
  for (var c = 0; c < lastCol; c++) {
    var raw = rowVals[c];
    if (raw === '' || raw === null || raw === undefined) continue;
    var label = String(headers[c] || ('Column ' + (c + 1))).trim() || ('Column ' + (c + 1));
    lines.push(label + ': ' + String(raw).trim());
  }
  lines.push('Alerted at: ' + new Date().toLocaleString('en-IN'));
  return lines.join('\n');
}