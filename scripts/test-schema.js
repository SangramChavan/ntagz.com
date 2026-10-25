// Validates required/recommended Product + Offer properties in JSON-LD (per Google Product guidelines). Run: node scripts/test-schema.js
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const pages = ['index.html', ...fs.readdirSync(path.join(root, 'product'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => `product/${d.name}/index.html`)];
const errs = [], warns = [];
const flat = n => Array.isArray(n) ? n.flatMap(flat) : n && typeof n === 'object' ? [n, ...Object.values(n).flatMap(flat)] : [];
for (const f of pages) {
  const h = fs.readFileSync(path.join(root, f), 'utf8');
  const nodes = [...h.matchAll(/<script[^>]+ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].flatMap(m => { try { return flat(JSON.parse(m[1])); } catch { return []; } });
  const prods = nodes.filter(n => [].concat(n['@type']).includes('Product'));
  if (f !== 'index.html' && !prods.length) errs.push(`${f}: no Product JSON-LD`);
  for (const p of prods) {
    const t = `${f} [${p.name}]`;
    if (!p.name) errs.push(`${t}: no name`);
    if (!p.image) errs.push(`${t}: no image`);
    if (!p.sku) warns.push(`${t}: no sku`);
    for (const o of flat(p.offers).filter(n => n['@type'] === 'Offer')) {
      if (!o.price && !o.priceSpecification) errs.push(`${t}: offer has no price`);
      if (!o.priceCurrency && !o.priceSpecification) errs.push(`${t}: offer has no priceCurrency`);
      if (!o.availability) errs.push(`${t}: offer has no availability`);
      if (!o.url) warns.push(`${t}: offer has no url`);
    }
    if (!p.offers) errs.push(`${t}: no offers`);
    if (p.aggregateRating) warns.push(`${t}: aggregateRating present - must be backed by genuine visible reviews`);
  }
}
errs.forEach(e => console.log('ERROR', e)); warns.forEach(w => console.log('WARN ', w));
console.log(`${errs.length} errors, ${warns.length} warnings`); process.exit(errs.length ? 1 : 0);
