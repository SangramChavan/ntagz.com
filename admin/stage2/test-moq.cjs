// Admin-editable MOQ: a live products.moq overrides the static default; NULL falls back to the static table; fixed kits stay at 1.
const assert = require("node:assert/strict");
const path = require("node:path");
const PRICING = require(path.join(__dirname, "..", "..", "functions", "lib", "pricing.js"));
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);

assert.equal(PRICING.moqFor({ fixed: true, moq: 10 }, { moq: 3 }), 1); ok("fixed kit: MOQ is always 1");
assert.equal(PRICING.moqFor({ moq: 10 }, { moq: 3 }), 3); ok("admin moq 3 overrides static 10");
assert.equal(PRICING.moqFor({ moq: 1 }, { moq: null }), 1); ok("NULL moq falls back to static table");
assert.equal(PRICING.moqFor({}, null), 10); ok("no row, no static moq: default 10");
assert.equal(PRICING.moqFor({ moq: 4 }, { moq: 0 }), 4); ok("invalid admin moq (0) ignored");

const id = "anti-metal-tag", products = PRICING.PRODUCTS;
const cart = (qty) => [{ id, qty }];
const row = (moq) => ({ [id]: { id, price_paise: 1000, active: 1, member_discount_pct: 0, cost_paise: null, moq } });
assert.notEqual(PRICING.priceCart(cart(2), { products, live: row(2) }), null);
assert.equal(PRICING.priceCart(cart(1), { products, live: row(2) }), null); ok("live moq 2: qty 2 accepted, qty 1 rejected");
assert.equal(PRICING.priceCart(cart(2), { products, live: row(null) }), null); ok("live moq NULL: static default still enforced");

// Google Review (GR*) group: each line MOQ 5, but the GR lines together must total 10.
{
  const P = PRICING.PRODUCTS, a = "google-review-nfc-stand-5x5", b = "google-review-nfc-stand-12x12", c = "google-review-nfc-card", other = "black-nfc-card";
  const q = (items) => PRICING.priceCart(items, { products: P, live: null });
  assert.equal(q([{ id: a, qty: 5 }]), null); ok("GR: 5 alone is below the group total of 10");
  assert.equal(q([{ id: a, qty: 4 }, { id: b, qty: 6 }]), null); ok("GR: a line under 5 is rejected even if the total is 10");
  assert.notEqual(q([{ id: a, qty: 5 }, { id: b, qty: 5 }]), null); ok("GR: 5 + 5 across two SKUs accepted");
  assert.notEqual(q([{ id: a, qty: 5 }, { id: c, qty: 6 }]), null); ok("GR: 5 + 6 (stand + card) accepted");
  assert.notEqual(q([{ id: a, qty: 10 }]), null); ok("GR: 10 of one SKU accepted");
  assert.equal(q([{ id: a, qty: 5 }, { id: other, qty: 10 }]), null); ok("GR: other products do not count toward the group total");
  assert.equal(q([{ id: other, qty: 9 }]), null); ok("non-GR products keep MOQ 10");
  assert.notEqual(q([{ id: "google-review-nfc-qr-stand-custom-10x10", qty: 1 }]), null); ok("custom GRC stand stays exempt (MOQ 1)");
}
