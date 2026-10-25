// Checks that prices/tiers/shipping agree across client catalogue, server pricing engine and product-page JSON-LD.
// Run: node scripts/test-pricing-consistency.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
const win = {}; vm.runInNewContext(fs.readFileSync(path.join(root, 'js/catalog.js'), 'utf8'), { window: win });
const C = win.NTAGZ_CATALOG, S = require('../functions/lib/pricing.js');
const errs = [];

for (const p of C.products) {
  const sp = S.PRODUCTS[p.id];
  if (!sp) { errs.push(`catalog product "${p.id}" not sellable on server`); continue; }
  if (sp.price !== p.price) errs.push(`${p.id}: client ₹${p.price} vs server ₹${sp.price}`);
  if (!!sp.allInclusive !== !!p.allInclusive) errs.push(`${p.id}: allInclusive differs`);
  if (p.detail) {
    const f = path.join(root, p.detail, 'index.html');
    if (!fs.existsSync(f)) { errs.push(`${p.id}: detail page ${p.detail} missing`); continue; }
    const prices = [...fs.readFileSync(f, 'utf8').matchAll(/"price":\s*"([\d.]+)"/g)].map(m => +m[1]);
    if (prices.length && !prices.includes(p.price)) errs.push(`${p.id}: JSON-LD price ${prices} != catalog ${p.price}`);
  }
}
for (const t of S.BULK_TIERS) {
  const c = C.tiers.find(x => x.min === t.min);
  if (!c || c.percent !== t.pct) errs.push(`tier ${t.min}: client ${c && c.percent}% vs server ${t.pct}%`);
}
const sh = C.shipping, ss = S.SHIPPING;
if (sh.freeAbove !== ss.freeAbove || sh.homeStateRate !== ss.home || sh.restOfIndiaRate !== ss.rest) errs.push('shipping mismatch');

const maxPct = Math.max(...S.BULK_TIERS.map(t => t.pct));
for (const f of ['index.html', 'order.html', 'llms.txt']) {
  for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/up\s?to (\d+)%/gi))
    if (+m[1] > maxPct) errs.push(`${f}: claims up to ${m[1]}% but max tier is ${maxPct}%`);
}
errs.forEach(e => console.log('ERROR', e));
console.log(`${errs.length} errors`); process.exit(errs.length ? 1 : 0);
