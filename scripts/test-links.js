// Internal link + CTA check on public pages. Run: node scripts/test-links.js
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const ids = new Set(require('vm').runInNewContext('(function(){var window={};' + fs.readFileSync(path.join(root, 'js/catalog.js'), 'utf8') + ';return window.NTAGZ_CATALOG.products.map(p=>p.id)})()'));
const pages = ['index.html', 'order.html', 'about.html', 'track.html', 'membership/index.html', ...fs.readdirSync(path.join(root, 'product'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => `product/${d.name}/index.html`), 'product/index.html'];
const errs = [], wa = new Set();
for (const f of pages) {
  const h = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of h.matchAll(/href=["']([^"']+)["']/g)) {
    const u = m[1];
    const w = u.match(/wa\.me\/(\d+)|phone=(\d+)/); if (w) wa.add(w[1] || w[2]);
    if (/^(https?:|mailto:|tel:|#|javascript:|data:)/.test(u) && !u.startsWith('https://ntagz.com')) continue;
    let [p, q] = u.replace('https://ntagz.com', '').split('#')[0].split('?');
    if (!p || p.includes("${")) continue;
    const t = p.startsWith('/') ? path.join(root, p) : path.join(root, path.dirname(f), p);
    const ok = fs.existsSync(t) && (fs.statSync(t).isFile() || fs.existsSync(path.join(t, 'index.html')));
    if (!ok) errs.push(`${f}: broken link ${u}`);
    const add = (q || '').match(/add=([^&]+)/); if (add && !ids.has(add[1])) errs.push(`${f}: unknown product in ${u}`);
  }
}
if (wa.size > 1) errs.push(`multiple WhatsApp numbers: ${[...wa]}`);
errs.forEach(e => console.log('ERROR', e)); console.log(`${errs.length} errors; whatsapp: ${[...wa]}`);
process.exit(errs.length ? 1 : 0);
