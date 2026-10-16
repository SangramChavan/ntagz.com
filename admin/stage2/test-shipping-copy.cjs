// The shipping policy text must match what checkout actually charges (functions/lib/pricing.js is the source of truth).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");
const { SHIPPING } = require(path.join(root, "functions", "lib", "pricing.js"));
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);

const shipping = fs.readFileSync(path.join(root, "shipping-policy.html"), "utf8");
const llms = fs.readFileSync(path.join(root, "llms.txt"), "utf8");
const inr = (v) => "₹" + v.toLocaleString("en-IN");

// the numbers the server charges are the numbers the page states
for (const [name, text] of [["shipping-policy.html", shipping], ["llms.txt", llms]]) {
  assert.ok(text.includes(inr(SHIPPING.freeAbove)), `${name} states the free-shipping threshold ${inr(SHIPPING.freeAbove)}`);
  assert.ok(text.includes(inr(SHIPPING.home)), `${name} states the ${SHIPPING.homeState} rate ${inr(SHIPPING.home)}`);
  assert.ok(text.includes(inr(SHIPPING.rest)), `${name} states the rest-of-India rate ${inr(SHIPPING.rest)}`);
  assert.ok(!/₹\s?90\b/.test(text), `${name} no longer states the old ₹90 flat rate`);
}
ok(`shipping-policy.html and llms.txt state ${inr(SHIPPING.home)} (${SHIPPING.homeState}), ${inr(SHIPPING.rest)} (elsewhere) and free from ${inr(SHIPPING.freeAbove)}, as checkout charges`);

// the storefront's client-side table agrees with the server's
const vm = require("node:vm"); const sb = { window: {}, document: { addEventListener() {}, getElementById() { return null; } }, localStorage: { getItem() { return null; }, setItem() {} } };
sb.window = sb; sb.self = sb; vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(root, "js", "catalog.js"), "utf8"), sb);
const ship = sb.NTAGZ_CATALOG && (sb.NTAGZ_CATALOG.SHIPPING || sb.NTAGZ_CATALOG.shipping);
if (ship) { assert.equal(ship.freeAbove, SHIPPING.freeAbove); assert.equal(ship.homeStateRate, SHIPPING.home); assert.equal(ship.restOfIndiaRate, SHIPPING.rest); ok("js/catalog.js shipping table equals the server's"); }
else { const src = fs.readFileSync(path.join(root, "js", "catalog.js"), "utf8"); assert.match(src, new RegExp(`freeAbove:\\s*${SHIPPING.freeAbove}`)); assert.match(src, new RegExp(`homeStateRate:\\s*${SHIPPING.home}`)); assert.match(src, new RegExp(`restOfIndiaRate:\\s*${SHIPPING.rest}`)); ok("js/catalog.js shipping table equals the server's"); }
console.log(`\n${n} shipping-copy checks passed`);
