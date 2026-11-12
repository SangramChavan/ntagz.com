// Verifies tracking date formatting for Unix timestamps and shipment date-only fields.
// Run: node scripts/test-track-dates.js
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync('js/track.js', 'utf8');
const errors = [];
const listeners = {};
const root = { hidden: true, replaceChildren(...nodes) { this.nodes = nodes; } };
const document = {
  getElementById(id) {
    if (id === 'orderView') return root;
    if (id === 'orderForm') return { addEventListener() {} };
    if (id === 'orderLink') return { value: '', setAttribute() {}, focus() {} };
    if (id === 'orderLinkErr') return { hidden: true };
    if (id === 'carrier') return { addEventListener() {} };
    if (id === 'trackingForm') return {};
    if (id === 'trackBtn' || id === 'trackCopied' || id === 'trackingId') return { addEventListener() {}, hidden: true };
    return null;
  },
  querySelector() { return null; },
  createElement(tag) {
    return { tag, children: [], append(...nodes) { this.children.push(...nodes); }, setAttribute() {}, addEventListener() {}, remove() {},
      scrollIntoView() {}, after() {}, classList: { add() {} }, style: {} };
  },
  head: { appendChild() {} },
};
const window = { open() {} };
const context = {
  window, document, URLSearchParams, URL, Date, Intl, Number, Math,
  location: { search: '?o=12345678&t=0123456789abcdef0123456789abcdef' },
  matchMedia: () => ({ matches: true }),
  fetch: async () => ({ ok: true, status: 200, json: async () => ({
    ref: '12345678', placed_at: 1793353200, status: 'shipped', status_label: 'Shipped', payment_status: 'paid',
    items: [], total_paise: 1000, shipments: [{ courier: 'Delhivery', awb: '1234567890', shipped_on: '2026-10-30', est_delivery: '2026-11-06' }], journey: []
  }) }),
  setTimeout, clearTimeout, navigator: { clipboard: { writeText: async () => {} } },
};
vm.runInNewContext(src, context);
setImmediate(() => {
  const content = JSON.stringify(root.nodes, (key, value) => key === 'parentElement' ? undefined : value);
  if (content.includes('Invalid Date')) errors.push('date-only shipment dates formatted as Invalid Date');
  if (!content.includes('30 Oct 2026')) errors.push('shipped date was not rendered');
  if (!content.includes('6 Nov 2026')) errors.push('estimated delivery date was not rendered');
  console.log(content);
  console.log(`${errors.length} errors`);
  process.exit(errors.length ? 1 : 0);
});
