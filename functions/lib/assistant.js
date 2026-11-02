// Shopping-assistant helpers: turn what a customer typed ("ntagz.com i need 10 coin nfc") into a catalogue product and a quantity, and turn a
// priced order into the reply block an AI assistant shows. Pure functions, no I/O. Prices, stock and totals are NEVER computed here: the Worker
// gets them from the live catalogue and the checkout's own pricing; this module only finds the product, reads the quantity and formats text.
// Product pages come from assistant-catalog.js (generated from the site catalogue, files verified to exist), so a URL is never invented.

const CAT = require("./assistant-catalog.js");

const STOP = new Set(("i need want wants to buy order get me my some of for the a an and or with from can could you please pls give show send link price prices " +
  "cost how much does do is are it in on at have has looking checkout payment pay purchase ntagz com www https http quote about").split(" "));
const UNITS = new Set("pcs pc piece pieces unit units nos no card cards tag tags coin coins ring rings label labels sticker stickers stand stands pack packs packet packets kit kits band bands wristband wristbands".split(" "));
const GENERIC = new Set("pcs pc piece pieces unit units nos qty quantity pack packs packet packets".split(" "));
const QTY_CUES = new Set("x qty quantity need want buy order get of".split(" "));
const SYN = { bracelet: "wristband", disc: "coin", disk: "coin", token: "coin", visiting: "card", business: "card" };
const singular = (t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);

// "ntag215 coin 25mm" -> ["ntag","215","coin","25","mm"]; "5x5" and "12×12" stay one token.
function tokens(s) {
  return (String(s).toLowerCase().replace(/×/g, "x").match(/\d+(?:,\d{3})*(?:\.\d+)?k?(?=\b)|\d+x\d+|[a-z]+|\d+/g) || []).map((t) => t.replace(/,/g, ""));
}

// Reads a quantity out of the customer's words and returns it with the query that is left for matching. A number counts as a quantity when it
// is next to a unit word ("10 pcs", "50 cards"), follows a cue ("need 10", "x 50", "qty 100"), or stands alone at either end. It does NOT when it is
// part of a model or size ("NTAG215", "25 mm", "5x5", "9 cm"). "1k" is 1000. Returns { qty: number|null, rest: string[] }.
function readQuantity(query) {
  const raw = String(query).toLowerCase().replace(/×/g, "x");
  const re = /(\d+(?:,\d{3})*)\s*(k\b)?/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index, end = start + m[0].length, before = raw.slice(0, start), after = raw.slice(end);
    const prevWord = (before.match(/([a-z]+)\s*$/) || [])[1] || "", nextWord = (after.match(/^\s*([a-z]+)/) || [])[1] || "";
    const attached = /[a-z]$/.test(before) && !/\s$/.test(before);       // "ntag215", "v2"
    const touchesX = /x$/.test(before.trimEnd()) && /\dx$/.test(before.trimEnd()) || /^x\d/.test(after.trimStart()) && /\d$/.test(raw.slice(0, end)); // 5x5
    if (attached || touchesX || /^(mm|cm|m|inch|in|gb|mb|kb|byte|bytes|bit|v|w|mah|hz|khz|mhz|ghz)$/.test(nextWord) || prevWord === "ntag") continue;
    const n = parseInt(m[1].replace(/,/g, ""), 10) * (m[2] ? 1000 : 1);
    const unitNext = UNITS.has(nextWord) || UNITS.has(singular(nextWord));
    const cuePrev = QTY_CUES.has(prevWord);
    const alone = before.replace(/[^a-z0-9]/g, "").length === 0 || after.replace(/[^a-z0-9]/g, "").length === 0;
    if (!(unitNext || cuePrev || alone)) continue;
    if (!Number.isSafeInteger(n) || n < 1 || n > 100000) return { qty: null, rest: tokens(raw) };
    const rest = tokens(before + " " + (unitNext && !["card", "cards", "tag", "tags", "coin", "coins", "ring", "rings", "label", "labels", "stand", "stands", "band", "bands", "wristband", "wristbands", "kit", "kits"].includes(nextWord) ? after.replace(/^\s*[a-z]+/, "") : after));
    return { qty: n, rest };
  }
  return { qty: null, rest: tokens(raw) };
}

const docTokens = (p) => new Set(tokens([p.name, p.id.replace(/-/g, " "), p.sku, ...(p.keywords || [])].join(" ")).map(singular));

// products: [{id, name}] (live, active, purchasable). Returns { status: "match"|"choose"|"none", best, candidates }.
// Words that few products share ("coin") count for more than words most share ("nfc"); a clear winner is a match, near ties are a choice.
function matchProducts(restTokens, products) {
  const q = [...new Set(restTokens.map(singular).map((t) => SYN[t] || t).filter((t) => !STOP.has(t) && !GENERIC.has(t)))];
  if (!q.length || !products.length) return { status: "none", candidates: [] };
  const docs = products.map((p) => ({ p, set: docTokens({ ...p, ...(CAT[p.id] || {}) }) }));
  const df = (t) => docs.filter((d) => d.set.has(t)).length;
  const scored = docs.map((d) => ({ p: d.p, score: q.reduce((s, t) => s + (d.set.has(t) ? Math.log(1 + docs.length / df(t)) : 0), 0) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name));
  if (!scored.length) return { status: "none", candidates: [] };
  // Every query word must be explained by the winner, otherwise it is a guess (e.g. "laptop sticker" must not return the sticker).
  const unknown = q.filter((t) => !docs.some((d) => d.set.has(t)));
  const top = scored[0], second = scored[1];
  const candidates = scored.slice(0, 4).map((x) => x.p);
  if (unknown.length && unknown.length >= q.length - 1 && q.length > 1) return { status: "choose", candidates };
  if (second && second.score >= top.score * 0.8) return { status: "choose", candidates };
  return { status: "match", best: top.p, candidates };
}

const STATES = ["Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh", "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal"];
function normaliseState(s) {
  const k = String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!k) return null;
  if (k === "orissa") return "Odisha"; if (k === "pondicherry") return "Puducherry"; if (k === "new delhi" || k === "nct of delhi") return "Delhi";
  return STATES.find((x) => x.toLowerCase() === k) || null;
}

// ₹1,23,456 / ₹20 / ₹32.80 (Indian digit grouping, paise only when present)
function inr(n) {
  const neg = n < 0, v = Math.abs(Math.round(n * 100) / 100), [i, d] = v.toFixed(2).split(".");
  const g = i.length > 3 ? i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + i.slice(-3) : i;
  return (neg ? "-" : "") + "₹" + g + (d === "00" ? "" : "." + d);
}

// The block the assistant shows. The purchase link is ALWAYS the last line. o = { name, qty, unit, discountPct, subtotal, gst, gstIncluded, shipping:{amount,text},
// total, totalBeforeShipping, availability, notes:[], cta:{label,url} }.
function buildMarkdown(o) {
  const L = [];
  L.push(`**Your order: ${o.qty} × ${o.name}**`);
  L.push(`- Quantity: ${o.qty}`);
  L.push(`- Unit price: ${inr(o.unit)}${o.discountPct > 0 ? ` (after ${o.discountPct}% quantity discount)` : ""}${o.gstIncluded ? "" : " + GST"}`);
  L.push(`- Subtotal: ${inr(o.subtotal)}${o.gstIncluded ? "" : " (before GST)"}`);
  L.push(`- GST: ${o.gstIncluded ? "included in the price" : inr(o.gst) + " (18%)"}`);
  L.push(`- Shipping: ${o.shipping.text}`);
  L.push(`- Total: ${o.total == null ? `confirmed at checkout (${inr(o.totalBeforeShipping)} plus shipping)` : inr(o.total)}`);
  if (o.availability) L.push(`- Availability: ${o.availability}`);
  for (const n of o.notes || []) L.push(`\n_${n}_`);
  L.push("");
  L.push(`[${o.cta.label}](${o.cta.url})`);
  return L.join("\n");
}

module.exports = { CAT, tokens, readQuantity, matchProducts, normaliseState, inr, buildMarkdown, STATES };
