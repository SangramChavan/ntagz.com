// Static SEO audit of public pages. Run: node scripts/seo-check.js  (exit 1 on any ERROR)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const ORIGIN = 'https://ntagz.com';
const SKIP = /^(dist|admin|node_modules|graphify-out|components|functions|db|cutline|\.claude)\b|_preview/;

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const p = path.join(d, e.name), rel = path.relative(root, p);
  if (SKIP.test(rel)) return [];
  return e.isDirectory() ? walk(p) : rel.endsWith('.html') ? [rel] : [];
});
const urlOf = f => ORIGIN + '/' + f.replace(/index\.html$/, '');

const sm = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
const smUrls = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
const errs = [], warns = [];
const titles = {}, descs = {};

for (const f of walk(root)) {
  const h = fs.readFileSync(path.join(root, f), 'utf8');
  const url = urlOf(f);
  const get = re => (h.match(re) || [])[1];
  const tag = re => (h.match(re) || [])[0] || '';
  const attr = (t, a) => (t.match(new RegExp(a + '=["\']([^"\']*)', 'i')) || [])[1];
  const metaTag = n => tag(new RegExp('<meta\\b[^>]*name=["\']' + n + '["\'][^>]*>', 'i'));
  const robots = attr(metaTag('robots'), 'content') || '';
  const noindex = /noindex/i.test(robots);
  const inMap = smUrls.includes(url);
  if (noindex && inMap) errs.push(`${f}: noindex page is in sitemap`);
  if (noindex) continue;
  const title = get(/<title>([^<]*)<\/title>/i);
  const desc = attr(metaTag('description'), 'content');
  const canon = attr(tag(/<link\b[^>]*rel=["']canonical["'][^>]*>/i), 'href');
  const h1s = (h.match(/<h1[\s>]/gi) || []).length;
  if (!title) errs.push(`${f}: missing <title>`);
  else (titles[title] ||= []).push(f);
  if (!desc) errs.push(`${f}: missing meta description`);
  else (descs[desc] ||= []).push(f);
  if (!canon) errs.push(`${f}: missing canonical`);
  else if (canon !== url) warns.push(`${f}: canonical ${canon} != ${url}`);
  if (h1s !== 1) warns.push(`${f}: ${h1s} <h1> tags`);
  if (!/<html[^>]+lang=/i.test(h)) warns.push(`${f}: no html lang`);
  if (title && title.length > 65) warns.push(`${f}: title ${title.length} chars`);
  if (desc && desc.length > 170) warns.push(`${f}: description ${desc.length} chars`);
  for (const m of h.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi))
    try { JSON.parse(m[1]); } catch (e) { errs.push(`${f}: invalid JSON-LD (${e.message})`); }
  for (const m of h.matchAll(/<img\b(?![^>]*\balt=)[^>]*>/gi)) warns.push(`${f}: img without alt ${m[0].slice(0, 60)}`);
  if (!inMap) warns.push(`${f}: indexable but not in sitemap`);
}
for (const [k, v] of Object.entries(titles)) if (v.length > 1) errs.push(`duplicate title "${k}": ${v.join(', ')}`);
for (const [k, v] of Object.entries(descs)) if (v.length > 1) errs.push(`duplicate description: ${v.join(', ')}`);
for (const u of smUrls) {
  const rel = u.replace(ORIGIN + '/', '');
  const file = rel === '' || rel.endsWith('/') ? rel + 'index.html' : rel;
  if (!fs.existsSync(path.join(root, file))) errs.push(`sitemap URL has no file: ${u}`);
}
const robotsTxt = fs.readFileSync(path.join(root, 'robots.txt'), 'utf8');
if (!robotsTxt.includes(`Sitemap: ${ORIGIN}/sitemap.xml`)) errs.push('robots.txt missing Sitemap line');

console.log(`sitemap URLs: ${smUrls.length}`);
warns.forEach(w => console.log('WARN ', w));
errs.forEach(e => console.log('ERROR', e));
console.log(`${errs.length} errors, ${warns.length} warnings`);
process.exit(errs.length ? 1 : 0);
