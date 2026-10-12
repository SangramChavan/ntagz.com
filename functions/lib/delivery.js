// Pune-origin courier transit, in CALENDAR days (couriers run most days; the working-day model is for build time).
// Deterministic region table from Pune; priority = express courier tier (membership), -1 day, never below 1.
// ponytail: hardcoded Pune SLA table; plumb admin overrides when the courier's terms actually change.
"use strict";

const DEFAULTS = {
  originPincode: "411001",
  daySame: 1, dayNear: 2, dayMetro: 3, dayDefault: 5, dayFar: 6,
  same: [[411000, 412999]],
  near: [[400000, 444999]],
  metro: [[110000, 134999], [380000, 396999], [500000, 533999], [560000, 591999], [600000, 643999], [700000, 743999]],
  far: [[180000, 199999], [737000, 737999], [744000, 744999], [780000, 799999]],
};

const inRanges = (n, ranges) => !!ranges.find(([a, b]) => n >= a && n <= b);

// Transit (calendar) days from Pune to pincode; null when the pincode is not a 6-digit number.
function transitFor(pincode, priority) {
  const cfg = DEFAULTS;
  const n = /^\d{6}$/.test(String(pincode || "")) ? parseInt(String(pincode), 10) : NaN;
  if (Number.isNaN(n)) return null;
  let days = cfg.dayDefault;
  if (inRanges(n, cfg.same)) days = cfg.daySame;
  else if (inRanges(n, cfg.near)) days = cfg.dayNear;
  else if (inRanges(n, cfg.metro)) days = cfg.dayMetro;
  else if (inRanges(n, cfg.far)) days = cfg.dayFar;
  return priority ? Math.max(1, days - 1) : days;
}

// Calendar-date add on YYYY-MM-DD | epoch-ms. UTC arithmetic (no DST surprises in India).
function deliveryDate(from, transitDays) {
  const ms = typeof from === "number" ? from
    : Date.parse(String(from).slice(0, 10) + "T00:00:00Z");
  return new Date(ms + transitDays * 86400000).toISOString().slice(0, 10);
}

// {from,to}(+transitDays) window; null for an invalid pincode. `to` is from+1 for a range, not a promise.
function deliveryRange(from, pincode, opts) {
  const o = opts || {};
  const t = transitFor(pincode, !!o.priority);
  if (t === null) return null;
  return { transitDays: t, from: deliveryDate(from, t), to: deliveryDate(from, t + 1) };
}

const api = { DEFAULTS, transitFor, deliveryDate, deliveryRange };
if (require.main === module) {
  const ok = (name, cond) => { console.log((cond ? "ok  " : "FAIL") + " " + name); if (!cond) process.exitCode = 1; };
  ok("pune same-day-ish = 1", transitFor("411001") === 1);
  ok("maharashtra = 2", transitFor("440032") === 2);
  ok("mumbai = 2", transitFor("400001") === 2);
  ok("delhi metro = 3", transitFor("110001") === 3);
  ok("bangalore metro = 3", transitFor("560001") === 3);
  ok("north-east far = 6", transitFor("781001") === 6);
  ok("kashmir far = 6", transitFor("190001") === 6);
  ok("default = 5", transitFor("460001") === 5);
  ok("invalid = null", transitFor("abc") === null && transitFor("12345") === null && transitFor(null) === null);
  ok("priority min 1", transitFor("411001", true) === 1);
  ok("priority shaves a day", transitFor("740001", true) === 2);
  ok("date add", deliveryDate("2026-10-14", 3) === "2026-10-17");
  ok("range to = from+1", (() => { const r = deliveryRange(Date.UTC(2026, 9, 14), "416001", {}); return r.transitDays === 2 && r.from === "2026-10-16" && r.to === "2026-10-17"; })());
  ok("named import api", typeof api.transitFor === "function");
}
module.exports = api;