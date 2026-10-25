// /membership/ page wiring: every element id the page scripts look up exists in the HTML, and the calculator's starting-tier option is sound.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");
const html = fs.readFileSync(path.join(root, "membership", "index.html"), "utf8");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);

for (const f of ["membership.js", "rewards-page.js", "membership-dashboard.js"]) {
  const src = fs.readFileSync(path.join(root, "js", f), "utf8");
  const used = new Set([...src.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)].map((m) => m[1]));
  if (f === "membership.js") for (const m of src.matchAll(/\[((?:'[A-Za-z]+',? ?)+)\]\.map\(function \(id\)/g)) for (const x of m[1].matchAll(/'([A-Za-z]+)'/g)) used.add(x[1]);
  if (f === "membership-dashboard.js") continue; // mounts into containers it creates itself
  const missing = [...used].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `${f} looks up ids that are not in membership/index.html`);
  ok(`${f}: every looked-up id exists in the page`);
}
assert.equal([...html.matchAll(/\bid="([^"]+)"/g)].length, ids.size, "duplicate ids in membership/index.html");
ok("no duplicate ids");

const { calc } = require(path.join(root, "js", "member-calc.js"));
const c = { pct: 10, fee: 999, pts: { earnPer100: 3, value: 1, maxRedeemPct: 10, minOrder: 0, tiers: [{ minSpend: 5000, pointsPer100: 3 }, { minSpend: 25000, pointsPer100: 5 }, { minSpend: 50000, pointsPer100: 10 }] } };
const base = { order: 5000, count: 6, share: 60, use: 50 };
const a = calc(base, c), b = calc({ ...base, start: 50000 }, c), z = calc({ ...base, start: 0 }, c);
assert.equal(z.earned, a.earned, "start 0 equals no start");
assert.equal(b.rate, 10); assert.ok(b.earned > a.earned, "a higher starting tier earns more on the same spend");
assert.equal(calc({ ...base, start: -5 }, c).earned, a.earned, "negative start is clamped");
assert.equal(calc({ order: 0, count: 0, share: 0, use: 0 }, c).net, -999, "no spend: net is just the fee");
ok("calculator starting tier: clamps, raises earn, boundary no-spend");
console.log(`all ${n} membership page checks passed`);
