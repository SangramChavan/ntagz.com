// Generates /pricing.md (machine-readable prices for AI agents) from js/catalog.js so it can't drift. Run: node scripts/build-pricing-md.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
const win = {}; vm.runInNewContext(fs.readFileSync(path.join(root, 'js/catalog.js'), 'utf8'), { window: win });
const C = win.NTAGZ_CATALOG, S = C.shipping;
const rows = C.products.map(p => `- ${p.name}: ₹${p.price} per ${p.unit || 'pc'}${p.allInclusive ? ' (all-inclusive: GST and shipping included)' : ' + 18% GST'}, minimum order ${C.moqFor(p)}${p.detail ? ` — https://ntagz.com/${p.detail}` : ''}`);
const tiers = C.tiers.filter(t => t.percent || t.custom).map(t => `- ${t.min}${t.max === Infinity ? '+' : '–' + t.max} pieces: ${t.custom ? 'custom rate on request' : t.percent + '% off'}`);
fs.writeFileSync(path.join(root, 'pricing.md'), `# Pricing — ntagz (Ambivert Technologies Private Limited)

Prices in INR, per line item, before GST unless stated. Generated from the site catalogue; the order page https://ntagz.com/order.html is the live source of truth.

## Products
${rows.join('\n')}

## Bulk discounts (per line item, by quantity)
${tiers.join('\n')}

## Shipping (India)
- Free when the order value before GST, after discounts, is ₹${S.freeAbove} or more
- Otherwise ₹${S.homeStateRate} within ${S.homeState}, ₹${S.restOfIndiaRate} elsewhere in India
- International orders: priced in USD, shipping quoted per order — https://ntagz.com/international.html
`);
