// Cutline nesting checks: known counts, unit handling, and a property test (inside sheet, no overlap, gap >= kerf).
const assert = require("node:assert/strict");
const { plan, toMm, SHEET } = require("../cutline/nest.js");
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

assert.ok(near(toMm(1, "ft"), 304.8) && near(toMm("25,4", "mm"), 25.4) && near(toMm(10, "cm"), 100) && Number.isNaN(toMm("abc", "mm")) && Number.isNaN(toMm(1, "in"))); ok("unit conversion ft/cm/mm, comma decimal, rejects junk");
assert.ok(near(SHEET.w, 2438.4) && near(SHEET.h, 1219.2)); ok("sheet is 8 x 4 ft");

assert.equal(plan({ w: 100, h: 100, unit: "mm" }).perSheet, 24 * 12); ok("100x100 mm -> 288");
assert.equal(plan({ w: 10, h: 10, unit: "cm" }).perSheet, 288); ok("same piece in cm -> same count");
assert.equal(plan({ w: 4, h: 2, unit: "ft" }).perSheet, 4); ok("4x2 ft -> 4");
assert.equal(plan({ w: 8, h: 4, unit: "ft" }).perSheet, 1); ok("exact 8x4 ft -> 1, no waste");
assert.ok(near(plan({ w: 8, h: 4, unit: "ft" }).wastePct, 0, 1e-6)); ok("exact fit has 0% waste");
assert.equal(plan({ w: 4.1, h: 4.1, unit: "ft" }).ok, false); ok("piece taller than the sheet is rejected");
assert.equal(plan({ w: 5, h: 3, unit: "ft" }).perSheet, 1); ok("5x3 ft -> 1");
assert.equal(plan({ w: 1219.2, h: 2438.4, unit: "mm", rotate: false }).ok, false); ok("long piece with rotation off does not fit");
assert.equal(plan({ w: 1219.2, h: 2438.4, unit: "mm", rotate: true }).perSheet, 1); ok("same piece with rotation on fits");
assert.equal(plan({ w: 100, h: 100, unit: "mm", kerf: 3 }).perSheet, Math.floor(2441.4 / 103) * Math.floor(1222.2 / 103)); ok("3 mm gap reduces count correctly");
const q = plan({ w: 100, h: 100, unit: "mm", qty: 1000 }); assert.equal(q.sheets, 4); assert.equal(q.spare, 4 * 288 - 1000); ok("1000 pcs -> 4 sheets, 152 spare");
for (const bad of [{ w: 0, h: 5 }, { w: -1, h: 5 }, { w: "x", h: 5 }, { w: 5, h: 5, kerf: -2 }, { w: 5, h: 5, kerf: 500 }]) assert.equal(plan({ unit: "cm", ...bad }).ok, false); ok("invalid inputs rejected");

let s = 12345; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
for (let t = 0; t < 400; t++) {
  const w = 20 + rnd() * 900, h = 20 + rnd() * 900, k = rnd() < 0.5 ? 0 : rnd() * 8, rot = rnd() < 0.7;
  const r = plan({ w, h, unit: "mm", kerf: k, rotate: rot }); if (!r.ok) continue;
  const E = 1e-6, rs = r.rects;
  for (const a of rs) {
    assert.ok(a.x >= -E && a.y >= -E && a.x + a.w <= SHEET.w + E && a.y + a.h <= SHEET.h + E, "inside sheet");
    assert.ok(near(a.rot ? a.h : a.w, w) && near(a.rot ? a.w : a.h, h), "piece dimensions preserved");
  }
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const a = rs[i], b = rs[j];
    const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
    assert.ok(Math.max(gapX, gapY) >= k - 1e-6, `pieces too close (${w},${h},k=${k})`);
  }
  assert.ok(r.perSheet * w * h <= SHEET.w * SHEET.h + 1e-6, "cannot beat the sheet area");
}
ok("400 random cases: inside sheet, no overlaps, gap >= kerf, never above area limit");
console.log(`\nall ${n} cutline checks passed`);
