// Routing parity with GitHub Pages for workers/site/src/index.js, using an in-memory ASSETS stand-in. Run: npm run test:site
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
(async () => {
  const src = fs.readFileSync(path.join(__dirname, '../workers/site/src/index.js'), 'utf8').replace('export default', 'module.exports =');
  const m = { exports: {} }; new Function('module', src)(m);
  const files = new Set(['/index.html', '/order.html', '/product/sample-kit/index.html']);
  const env = { ASSETS: { fetch: async (req) => { const p = new URL(req.url).pathname; return new Response('x', { status: files.has(p) ? 200 : 404 }); } } };
  const run = async (u) => m.exports.fetch(new Request('https://ntagz.com' + u), env);
  let n = 0; const ok = (s) => console.log(`ok ${++n} ${s}`);
  assert.equal((await run('/')).status, 200); ok('/ serves index.html');
  assert.equal((await run('/order')).status, 200); ok('/order serves order.html (no redirect)');
  assert.equal((await run('/product/sample-kit/')).status, 200); ok('directory with slash serves index.html');
  const r = await run('/product/sample-kit?x=1'); assert.equal(r.status, 301); assert.equal(r.headers.get('location'), 'https://ntagz.com/product/sample-kit/?x=1'); ok('directory without slash 301s, keeps query');
  const w = await m.exports.fetch(new Request('https://www.ntagz.com/order.html?a=1'), env); assert.equal(w.status, 301); assert.equal(w.headers.get('location'), 'https://ntagz.com/order.html?a=1'); ok('www redirects to apex, keeps path and query');
  assert.equal((await run('/nope')).status, 404); assert.equal((await run('/nope/')).status, 404); ok('unknown paths 404');
  console.log('site worker routing checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
