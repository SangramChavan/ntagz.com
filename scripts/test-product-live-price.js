// Checks that the storefront live-price swap updates both .prod-price (single product page) and
// [data-price-for] (pages that show several products, like the review stand size picker).
// Run: node scripts/test-product-live-price.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'js/product-live-price.js'), 'utf8');
const errs = [];

function textEl(text) { return { childNodes: [{ nodeType: 3, textContent: text }] }; }

async function run(pathname, sizeIds) {
  const prod = textEl('₹30 <span>/ card + GST</span>');
  const sizes = sizeIds.map((id) => {
    const el = textEl('₹99 <span>/ pc</span>');
    el.getAttribute = (name) => (name === 'data-price-for' ? id : null);
    return el;
  });
  const window = {
    location: { pathname },
    NTAGZ_LIVE: {
      ready: Promise.resolve([
        { id: 'black-nfc-card', price: 35 },
        { id: 'google-review-nfc-stand-5x5', price: 105.5 },
        { id: 'google-review-nfc-qr-stand-custom-10x10', price: 200 }
      ])
    }
  };
  const document = {
    querySelector: (sel) => (sel === '.prod-price' ? prod : null),
    querySelectorAll: (sel) => (sel === '[data-price-for]' ? sizes : [])
  };
  vm.runInNewContext(src, { window, document, Intl, decodeURIComponent, isFinite });
  await Promise.resolve();
  await Promise.resolve();
  return { prod, sizes };
}

(async () => {
  const single = await run('/product/black-nfc-card/', ['google-review-nfc-qr-stand-custom-10x10', 'unknown-id']);
  if (!single.prod.childNodes[0].textContent.startsWith('₹35 ')) errs.push(`.prod-price not updated: ${single.prod.childNodes[0].textContent}`);
  const [custom, unknown] = single.sizes;
  if (!custom.childNodes[0].textContent.startsWith('₹200 ')) errs.push(`data-price-for not updated: ${custom.childNodes[0].textContent}`);
  if (unknown.childNodes[0].textContent.startsWith('₹200')) errs.push('unknown product must keep its fallback price');

  const multi = await run('/product/google-review-nfc-stand/', ['google-review-nfc-stand-5x5']);
  if (!multi.sizes[0].childNodes[0].textContent.startsWith('₹105.5 ')) errs.push(`decimal price not formatted: ${multi.sizes[0].childNodes[0].textContent}`);

  const stand = fs.readFileSync(path.join(root, 'product/google-review-nfc-stand/index.html'), 'utf8');
  if (!stand.includes('data-price-for="google-review-nfc-qr-stand-custom-10x10"')) errs.push('custom stand price is not wired to the live catalogue');
  if (!stand.includes('js/product-live-price.js')) errs.push('stand page does not load the live-price script');

  const listing = fs.readFileSync(path.join(root, 'product/index.html'), 'utf8');
  if (!listing.includes('catalog-live.js')) errs.push('product listing does not load the live catalogue');
  if (!listing.includes('livePrices[p.id]')) errs.push('product listing does not render the admin price override');
  if (!listing.includes('window.NTAGZ_LIVE.ready')) errs.push('product listing does not refresh when live prices load');

  errs.forEach((e) => console.log('ERROR', e));
  console.log(`${errs.length} errors`);
  process.exit(errs.length ? 1 : 0);
})();
