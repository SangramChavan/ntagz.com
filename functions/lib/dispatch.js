// ntagz dispatch promise — the ONE place a "dispatches in N working days" date is computed.
// Pure functions, no I/O: given an instant, a target in working days and the admin's business calendar,
// returns the calendar date the order is promised to be dispatched. Used by the payments Worker (at verified
// payment, and for the pre-payment estimate) so the promise the customer sees is the one the order records.
//
// The calendar is admin-owned (membership_config) and ships with sensible defaults: Asia/Kolkata, Mon–Fri,
// no holidays, a 14:00 local cut-off (an order placed after it is treated as the next working day's order).
// A working day is a weekday in the week mask that is not a listed holiday. Time zones come from Intl, so
// this is correct across DST without carrying a tz database.

const DEFAULTS = { timezone: "Asia/Kolkata", weekdays: [1, 2, 3, 4, 5], holidays: [], cutoffMin: 14 * 60, standardDays: 3, memberDays: 1 };
const MAX_STEP = 400; // a promise this far out is a config error, not a date; bounds the loop.

const clampInt = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };
const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// A zone Intl rejects throws; keep the configured one only if it is real, else the default. Never throws.
function safeZone(tz, fallback) {
  const z = String(tz || "").trim();
  if (!z) return fallback;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: z }).format(new Date(0)); return z; } catch { return fallback; }
}

// membership_config rows (or a settings object) -> a typed calendar. Unknown/missing values fall back safely.
function fromCfg(cfg = {}) {
  const weekdays = [...new Set(String(cfg.business_days ?? "1,2,3,4,5").split(",").map((x) => parseInt(x, 10)).filter((x) => x >= 0 && x <= 6))];
  const c = String(cfg.business_cutoff ?? "").match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return {
    timezone: safeZone(cfg.business_timezone, DEFAULTS.timezone),
    weekdays: weekdays.length ? weekdays : DEFAULTS.weekdays.slice(),
    holidays: new Set(String(cfg.business_holidays ?? "").split(",").map((s) => s.trim()).filter(isIsoDate)),
    cutoffMin: c ? +c[1] * 60 + +c[2] : DEFAULTS.cutoffMin,
    standardDays: clampInt(cfg.dispatch_days_standard, DEFAULTS.standardDays, 0, 60),
    memberDays: clampInt(cfg.dispatch_days_member, DEFAULTS.memberDays, 0, 60),
  };
}

// The local calendar date and clock at `ms` in a zone, as plain numbers (no Date arithmetic across zones).
function localParts(ms, timezone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const y = +p.year, m = +p.month, d = +p.day;
  return { y, m, d, hh: +p.hour, mm: +p.minute, iso: `${p.year}-${p.month}-${p.day}`, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

function addDays(day, n) { const t = new Date(Date.UTC(day.y, day.m - 1, day.d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), iso: t.toISOString().slice(0, 10), dow: t.getUTCDay() }; }

const isBusinessDay = (day, cfg) => cfg.weekdays.includes(day.dow) && !cfg.holidays.has(day.iso);

// The date `days` working days after the order's effective start (the next day once the cut-off has passed).
// days = 0 means "the first working day on/after the start". Bounded, deterministic, never throws.
function promisedDispatch(ms, days, cfg) {
  const c = cfg && cfg.weekdays ? cfg : fromCfg(cfg || {});
  const target = clampInt(days, c.standardDays, 0, 60);
  const now = localParts(Number.isFinite(ms) ? ms : Date.now(), c.timezone);
  let cursor = now.hh * 60 + now.mm >= c.cutoffMin ? addDays(now, 1) : { y: now.y, m: now.m, d: now.d, iso: now.iso, dow: now.dow };
  let steps = 0;
  while (!isBusinessDay(cursor, c) && steps++ < MAX_STEP) cursor = addDays(cursor, 1);
  for (let i = 0; i < target && steps++ < MAX_STEP; i++) { do { cursor = addDays(cursor, 1); } while (!isBusinessDay(cursor, c) && steps++ < MAX_STEP); }
  return { date: cursor.iso, workingDays: target, timezone: c.timezone };
}

// The working-day target a priority build (member) or standard order gets under this calendar.
const targetDays = (cfg, priority) => ((cfg && cfg.weekdays ? cfg : fromCfg(cfg || {}))[priority ? "memberDays" : "standardDays"]);

module.exports = { DEFAULTS, fromCfg, localParts, promisedDispatch, targetDays, isBusinessDay };

// Runnable check: `node functions/lib/dispatch.js` (or the required assertions in the stage2 suite).
if (typeof require !== "undefined" && require.main === module) {
  const assert = require("node:assert/strict");
  const cfg = fromCfg({ business_timezone: "Asia/Kolkata", business_days: "1,2,3,4,5", business_cutoff: "14:00", business_holidays: "2026-10-20", dispatch_days_standard: "3", dispatch_days_member: "1" });
  const at = (iso) => Date.parse(iso);
  // Friday 2026-10-16 10:00 IST (04:30 UTC), before cut-off: 1 working day -> Monday 19th (skips the weekend).
  assert.equal(promisedDispatch(at("2026-10-16T04:30:00Z"), 1, cfg).date, "2026-10-19");
  // ...but Monday 19th is not a holiday; push the holiday into the window: Tuesday 20th is a holiday, so 1 working day -> 19th, 3 working days -> 22nd.
  assert.equal(promisedDispatch(at("2026-10-16T04:30:00Z"), 3, cfg).date, "2026-10-22");
  // Friday 2026-10-16 15:00 IST (09:30 UTC), after the 14:00 cut-off: counts from Saturday -> Monday 19th, then one
  // working day (Tue 20th is the holiday) -> Wednesday 21st.
  assert.equal(promisedDispatch(at("2026-10-16T09:30:00Z"), 1, cfg).date, "2026-10-21");
  // Weekends-only calendar and no holidays: 2 working days from a Wednesday -> Friday.
  const wdOnly = fromCfg({ business_timezone: "UTC", business_days: "1,2,3,4,5", business_cutoff: "23:59" });
  assert.equal(promisedDispatch(at("2026-10-14T12:00:00Z"), 2, wdOnly).date, "2026-10-16");
  // A bad zone falls back instead of throwing; days=0 returns the first working day on/after start.
  assert.equal(fromCfg({ business_timezone: "Not/AZone" }).timezone, DEFAULTS.timezone);
  assert.equal(promisedDispatch(at("2026-10-17T12:00:00Z"), 0, wdOnly).date, "2026-10-19"); // Saturday -> Monday
  console.log("dispatch.js self-check passed");
}
