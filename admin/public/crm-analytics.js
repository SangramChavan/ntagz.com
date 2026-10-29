// Customers > KPI strip + Analytics charts. Hand-written inline SVG (the admin CSP forbids external scripts and inline styles).
// Shares el, api (app.js) and the CRM shell (customers.js). All text is inserted with textContent; colours come from attributes/classes.
(() => {
const CRM = window.CRM;
if (!CRM) return;
const S = (CRM.range = CRM.range || { range: "30d", from: "", to: "" }); // shared with the directory and charts
const rangeQs = () => (S.from && S.to ? `from=${S.from}&to=${S.to}` : `range=${S.range}`);
const setRange = (p) => { Object.assign(S, p); window.dispatchEvent(new CustomEvent("crm-range")); };
const onRange = (root, fn) => { const h = () => { if (!root.isConnected) return window.removeEventListener("crm-range", h); fn(); }; window.addEventListener("crm-range", h); };
const go = (drill) => CRM.go("customers?rules=" + encodeURIComponent(JSON.stringify(drill)));

// ── formatting ──
const NA = "Not available";
const rs = (p) => (p == null ? NA : "₹" + Math.round(p / 100).toLocaleString("en-IN"));
const rsC = (p) => { const r = Math.abs(p) / 100; return (p < 0 ? "-" : "") + "₹" + (r >= 1e5 ? (r / 1e5).toFixed(r >= 1e6 ? 0 : 1).replace(/\.0$/, "") + "L" : r >= 1e3 ? (r / 1e3).toFixed(r >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k" : Math.round(r)); };
const num = (v) => (v == null ? NA : Number(v).toLocaleString("en-IN"));
const pct = (v) => (v == null ? NA : (v * 100).toFixed(1).replace(/\.0$/, "") + "%");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dShort = (iso) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;
const mShort = (ym) => `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;

// ── svg helpers ──
const NS = "http://www.w3.org/2000/svg";
const sv = (tag, a = {}, ...kids) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(a)) { if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
  for (const c of kids.flat()) n.append(c instanceof Node ? c : document.createTextNode(c ?? ""));
  return n;
};
const C1 = "#60a5fa", C2 = "#fbbf24", GRID = "#36363c", INK2 = "#b0b0ba", CARD = "#161618", INK = "#f2f2f4"; // contrast-safe chart tokens
let uid = 0;
  const stripes = (id) => sv("pattern", { id, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, sv("rect", { width: 6, height: 6, fill: CARD }), sv("rect", { width: 3, height: 6, fill: C2 }));
function niceTicks(max, count = 4, whole = false) {
  if (!(max > 0)) return { top: 1, t: [0, 1] };
  const raw = max / count, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag, step = Math.max(whole ? 1 : 0, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag), top = Math.ceil(max / step - 1e-9) * step, t = [];
  for (let v = 0; v <= top + step / 1e6; v += step) t.push(v);
  return { top, t };
}
const frame = (W, H, label) => sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "ca-svg", role: "img", "aria-label": label, preserveAspectRatio: "xMidYMid meet" });
const text = (x, y, s, o = {}) => sv("text", { x, y, "font-size": 11, fill: INK2, ...o }, s);

// stacked columns. cats: [{label, vals:[...]}], series: [{name, fill}]
function columns(W, cats, series, fmt, label) {
  const H = 220, L = 38, R = 6, T = 8, B = 26, pw = W - L - R, ph = H - T - B, svg = frame(W, H, label);
  const max = Math.max(0, ...cats.map((c) => c.vals.reduce((a, b) => a + b, 0))), { top, t } = niceTicks(max, 4, fmt === num), y = (v) => T + ph - (v / top) * ph;
  const ids = series.map((s) => (s.stripe ? "ca-p" + ++uid : null));
  svg.append(sv("defs", {}, ids.filter(Boolean).map((id) => stripes(id))));
  for (const v of t) svg.append(sv("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: GRID }), text(L - 4, y(v) + 4, fmt(v), { "text-anchor": "end" }));
  const band = pw / Math.max(cats.length, 1), bw = Math.max(2, Math.min(band * 0.7, 28)), every = Math.max(1, Math.ceil(cats.length / Math.max(1, Math.floor(pw / 46))));
  cats.forEach((c, i) => {
    const x = L + band * i + (band - bw) / 2; let acc = 0;
    c.vals.forEach((v, j) => { if (v > 0) { const h = (v / top) * ph; svg.append(sv("rect", { x, y: y(acc + v), width: bw, height: h, fill: ids[j] ? `url(#${ids[j]})` : series[j].fill, stroke: series[j].fill, "stroke-width": ids[j] ? 1 : 0 }, sv("title", {}, `${c.label}: ${series[j].name} ${fmt(v)}`))); } acc += v; });
    if (i % every === 0) svg.append(text(x + bw / 2, H - 8, c.short || c.label, { "text-anchor": "middle" }));
  });
  return svg;
}

// horizontal bars with the label above each bar. rows: [{label, v, text, drill}]
function hbars(W, rows, fill, label) {
  const RH = 42, H = Math.max(rows.length * RH, 10), svg = frame(W, H, label), max = Math.max(1, ...rows.map((r) => r.v)), bwMax = W - 96;
  rows.forEach((r, i) => {
    const y0 = i * RH, w = Math.max(r.v > 0 ? 3 : 0, (r.v / max) * bwMax);
    const g = sv("g", r.drill ? { class: "ca-hit", onclick: () => go(r.drill) } : {}, sv("rect", { x: 0, y: y0, width: W, height: RH - 4, fill: "transparent" }),
      text(0, y0 + 13, r.label, { fill: INK, "font-size": 12 }), sv("rect", { x: 0, y: y0 + 19, width: w, height: 14, rx: 3, fill }),
      text(Math.min(w + 6, W - 4), y0 + 31, r.text, { "font-size": 12, fill: INK, ...(w + 6 > W - 70 ? { "text-anchor": "end" } : {}) }), sv("title", {}, `${r.label}: ${r.text}${r.drill ? " (click to open customers)" : ""}`));
    svg.append(g);
  });
  return svg;
}

function line(W, pts, fmt, label) { // pts: [{label, v|null}], v is a fraction
  const H = 220, L = 38, R = 14, T = 12, B = 26, pw = W - L - R, ph = H - T - B, svg = frame(W, H, label);
  const { top, t } = niceTicks(Math.max(0, ...pts.map((p) => p.v ?? 0)) * 100), y = (v) => T + ph - ((v * 100) / top) * ph, x = (i) => L + (pts.length === 1 ? pw / 2 : (pw * i) / (pts.length - 1));
  for (const v of t) svg.append(sv("line", { x1: L, x2: W - R, y1: T + ph - (v / top) * ph, y2: T + ph - (v / top) * ph, stroke: GRID }), text(L - 4, T + ph - (v / top) * ph + 4, fmt(v / 100), { "text-anchor": "end" }));
  let seg = [];
  const flush = () => { if (seg.length > 1) svg.append(sv("polyline", { points: seg.join(" "), fill: "none", stroke: C1, "stroke-width": 2 })); seg = []; };
  pts.forEach((p, i) => { if (p.v == null) return flush(); seg.push(`${x(i)},${y(p.v)}`); });
  flush();
  const every = Math.max(1, Math.ceil(pts.length / Math.max(1, Math.floor(pw / 46))));
  pts.forEach((p, i) => {
    if (p.v != null) svg.append(sv("circle", { cx: x(i), cy: y(p.v), r: 3.5, fill: CARD, stroke: C1, "stroke-width": 2 }, sv("title", {}, `${p.label}: ${fmt(p.v)}`)));
    if (i % every === 0 || i === pts.length - 1) svg.append(text(x(i), H - 8, p.short || p.label, { "text-anchor": "middle" }));
  });
  const lp = [...pts].reverse().find((p) => p.v != null); if (lp) { const i = pts.indexOf(lp); svg.append(text(Math.min(x(i), W - 24), y(lp.v) - 8, fmt(lp.v), { "text-anchor": "middle", fill: INK, "font-size": 12 })); }
  return svg;
}

// ── generic UI bits ──
const table = (head, rows, caption) => el("div", { class: "ca-scroll" }, el("table", { class: "ca-table" }, caption ? el("caption", {}, caption) : "",
  el("thead", {}, el("tr", {}, head.map((h) => el("th", { scope: "col" }, h)))), el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c, i) => el(i ? "td" : "th", i ? {} : { scope: "row" }, c)))))));
const drillBtn = (drill, label) => (drill ? el("button", { class: "btn small", type: "button", "aria-label": label, onclick: () => go(drill) }, "View customers") : "");
const retry = (msg, fn) => el("div", { class: "ca-state", role: "alert" }, el("span", { class: "msg" }, msg), " ", el("button", { class: "btn small", type: "button", onclick: fn }, "Retry"));
const legend = (items) => el("div", { class: "ca-legend" }, items.map((s) => el("span", {}, el("i", { class: "ca-sw" + (s.stripe ? " stripe" : ""), "data-c": s.key }), s.name)));

function chartCard(title, decision) {
  const body = el("div", { class: "ca-body" }, el("p", { class: "sub", role: "status" }, "Loading…"));
  return { box: el("section", { class: "ca-card" }, el("h3", {}, title), el("p", { class: "ca-why" }, decision), body), body };
}
// spec: { empty?: reason, svg, summary, legend?, note?, head, rows }  ->  chart + "Show data table" toggle
function paint(body, spec) {
  if (spec.empty) return body.replaceChildren(el("p", { class: "ca-empty" }, NA + ": " + spec.empty));
  spec.svg?.setAttribute("aria-label", spec.summary);
  const tbl = el("div", { hidden: "" }, table(spec.head, spec.rows, spec.summary));
  const tg = el("button", { class: "btn small ca-tg", type: "button", "aria-expanded": "false", onclick: () => { tbl.hidden = !tbl.hidden; tg.setAttribute("aria-expanded", String(!tbl.hidden)); tg.textContent = tbl.hidden ? "Show data table" : "Hide data table"; } }, "Show data table");
  body.replaceChildren(spec.legend || "", spec.svg ? el("div", { class: "ca-chart" }, spec.svg) : "", spec.note ? el("p", { class: "sub" }, spec.note) : "", tg, tbl);
}

// ── date filter ──
function filterBar() {
  const bar = el("div", { class: "ca-bar" });
  const chips = [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["90d", "90 days"]].map(([k, l]) => el("button", { class: "chip", type: "button", "data-k": k, onclick: () => setRange({ range: k, from: "", to: "" }) }, l));
  const f = el("input", { type: "date", "aria-label": "From date" }), t = el("input", { type: "date", "aria-label": "To date" }), err = el("span", { class: "msg", role: "alert" });
  const apply = el("button", { class: "btn small", type: "button", onclick: () => {
    if (!f.value || !t.value || f.value > t.value) { err.textContent = "Pick a start date on or before the end date."; return; }
    err.textContent = ""; setRange({ range: "custom", from: f.value, to: t.value });
  } }, "Apply");
  const sync = () => { chips.forEach((c) => c.setAttribute("aria-pressed", String(!S.from && S.range === c.dataset.k))); f.value = S.from || ""; t.value = S.to || ""; };
  bar.append(el("div", { class: "chips", role: "group", "aria-label": "Date range" }, chips), el("div", { class: "ca-custom" }, f, el("span", { class: "sub" }, "to"), t, apply), err);
  sync(); window.addEventListener("crm-range", () => { if (bar.isConnected) sync(); });
  return bar;
}

// ── KPI strip ──
const kind = { money: rs, int: num, dec: (v) => (v == null ? NA : v.toFixed(2)), pct };
const GROUPS = [
  ["Revenue", [["net_paid", "Net revenue", "money"], ["gross_paid", "Gross collected", "money"], ["refunds", "Refunds", "money"], ["net_product", "Net product (ex GST, shipping)", "money"], ["gst", "GST", "money"], ["shipping", "Shipping", "money"], ["aov", "Average order value", "money"]]],
  ["Customers", [["total_customers", "Total customers", "int"], ["new_accounts", "New accounts", "int"], ["new_customers", "New customers", "int"], ["first_purchasers", "First purchasers", "int"], ["returning_customers", "Returning customers", "int"], ["active_customers", "Active customers", "int"], ["lapsed_customers", "Lapsed customers", "int"], ["orders_per_customer", "Orders per customer", "dec"], ["repeat_rate", "Repeat rate", "pct"], ["ltv", "Lifetime value", "money"]]],
  ["Not revenue", [["pending_unpaid_value", "Unpaid orders (not revenue)", "money"], ["cancelled_value", "Cancelled / returned (not revenue)", "money"]]],
  ["Members and email", [["MEMBERS"], ["email_subscribers", "Email subscribers", "int"], ["unsubscribed", "Unsubscribed", "int"], ["suppressed", "Suppressed", "int"], ["CAMPAIGNS"]]],
];
const REASON = { aov: "No paid orders in this period", orders_per_customer: "No customers with a paid order in this period", repeat_rate: "No customers with a paid order yet", ltv: "No customers with a paid order yet" };
function delta(k, cur, prev, type) {
  if (cur == null || prev == null || typeof cur !== "number") return "";
  if (type === "pct") { const d = (cur - prev) * 100; return d === 0 ? "No change vs previous period" : `${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)} pts vs previous period`; }
  if (prev === 0) return cur === 0 ? "No change vs previous period" : "▲ up from 0 in previous period";
  const d = ((cur - prev) / Math.abs(prev)) * 100;
  return d === 0 ? "No change vs previous period" : `${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)}% vs previous period`;
}
function tile(label, defText, valueNode, sub, wide) {
  const def = el("p", { class: "ca-def", hidden: "" }, defText || "");
  const i = el("button", { class: "ca-i", type: "button", "aria-expanded": "false", "aria-label": `What does "${label}" mean?`, onclick: () => { def.hidden = !def.hidden; i.setAttribute("aria-expanded", String(!def.hidden)); } }, "ⓘ");
  return el("div", { class: "ca-tile" + (wide ? " wide" : "") }, el("div", { class: "ca-lab" }, el("span", {}, label), defText ? i : ""), valueNode, sub ? el("span", { class: "ca-d" }, sub) : "", def);
}
function renderKpis(box, d) {
  const { kpis: K, prev: P, defs } = d, na = (v, reason) => el("div", {}, el("b", { class: "ca-na" }, NA), el("span", { class: "ca-d" }, reason || "No data in this period"));
  const note = el("p", { class: "sub" }, `${d.range.from_day} to ${d.range.to_day} (IST, both days included), compared with the previous ${d.range.days} day${d.range.days === 1 ? "" : "s"}. Unpaid, cancelled and returned orders are never counted as revenue.`);
  const groups = GROUPS.map(([title, items]) => el("section", { class: "ca-group" }, el("h3", {}, title), el("div", { class: "ca-tiles" }, items.map(([key, label, type]) => {
    if (key === "MEMBERS") {
      const m = K.members_by_tier || [];
      return tile("Members by tier", defs.members_by_tier, m.length ? el("ul", { class: "ca-tiers" }, m.map((t) => el("li", {}, t.drill ? el("button", { class: "ca-lk", type: "button", "aria-label": `Open ${t.name} members`, onclick: () => go(t.drill) }, `${t.name}: ${num(t.count)}`) : `${t.name}: ${num(t.count)}`))) : na(null, "No registered customers yet"), "", true);
    }
    if (key === "CAMPAIGNS") {
      const c = K.campaigns;
      return tile("Campaigns sent", defs.campaigns, c ? el("ul", { class: "ca-tiers" }, [`Campaigns: ${num(c.sent_campaigns)}`, `Recipients: ${num(c.recipients)}`, `Delivered: ${c.delivered == null ? NA + " (no delivery events yet)" : num(c.delivered)}`, `Bounced: ${c.bounced == null ? NA : num(c.bounced)}`, `Unique clicks: ${num(c.unique_clicks)}`].map((s) => el("li", {}, s))) : na(null, "No campaign was sent in this period"), "", true);
    }
    const v = K[key];
    return tile(label, defs[key], v == null ? na(null, REASON[key]) : el("b", {}, kind[type](v)), P && key in P ? delta(key, v, P[key], type) : "");
  }))));
  box.replaceChildren(note, ...groups);
}

CRM.register("kpis", (root) => {
  const box = el("div", { class: "ca-kpis", "aria-live": "polite" });
  root.replaceChildren(filterBar(), box);
  let seq = 0;
  const run = async () => {
    const me = ++seq; box.replaceChildren(el("p", { class: "sub", role: "status" }, "Loading…"));
    try { const d = await api("/api/crm/overview?" + rangeQs()); if (me === seq) renderKpis(box, d); }
    catch (e) { if (me === seq) box.replaceChildren(retry("Could not load the summary: " + e.message, run)); }
  };
  onRange(root, run); run();
});

// ── charts page ──
const HEAT = (v, max) => (v == null ? "ca-h-x" : v <= 0 || max <= 0 ? "ca-h0" : "ca-h" + Math.min(5, Math.max(1, Math.ceil((v / max) * 5))));
function specs(d, W) {
  const nvr = d.new_vs_returning, unit = d.bucket === "day" ? "day" : "week (starting that day)";
  const S1 = { name: "New customers", fill: C1, key: "new" }, S2 = { name: "Returning customers", fill: C2, stripe: true, key: "ret" };
  const tot = nvr.reduce((a, b) => a + b.active, 0);
  const out = {};
  out.nvr = tot === 0 ? { empty: "no paid orders from identifiable customers in this period." } : {
    svg: columns(W, nvr.map((b) => ({ label: (d.bucket === "week" ? "Week of " : "") + dShort(b.label), short: dShort(b.label), vals: [b.new, b.returning] })), [S1, S2], num, ""),
    summary: `Stacked columns of customers per ${unit}: ${nvr.reduce((a, b) => a + b.new, 0)} new and ${nvr.reduce((a, b) => a + b.returning, 0)} returning in total.`,
    legend: legend([S1, S2]), head: ["Starting", "New", "Returning", "Orders", "Net revenue"], rows: nvr.map((b) => [dShort(b.label), num(b.new), num(b.returning), num(b.orders), rs(b.net_paise)]),
    note: "A customer is counted once per " + (d.bucket === "day" ? "day" : "week") + ". Returning means they had a paid order before that " + (d.bucket === "day" ? "day" : "week") + "." };
  const acq = d.acquisition, A1 = { name: "Registered", fill: C1, key: "new" }, A2 = { name: "Guest (checked out without an account)", fill: C2, stripe: true, key: "ret" };
  out.acq = acq.every((b) => b.new === 0) ? { empty: "no first-time purchasers in this period." } : {
    svg: columns(W, acq.map((b) => ({ label: dShort(b.label), vals: [b.registered, b.guest] })), [A1, A2], num, ""),
    summary: `Stacked columns of first-time purchasers per ${unit}: ${acq.reduce((a, b) => a + b.new, 0)} in total.`, legend: legend([A1, A2]),
    head: ["Starting", "Registered", "Guest", "Total"], rows: acq.map((b) => [dShort(b.label), num(b.registered), num(b.guest), num(b.new)]) };
  const rt = d.repeat_trend;
  out.rep = rt.every((p) => p.repeat_rate == null) ? { empty: "no customer has bought yet." } : {
    svg: line(W, rt.map((p) => ({ label: mShort(p.month), v: p.repeat_rate })), pct, ""),
    summary: `Line chart of repeat rate by month end. Latest ${mShort(rt[rt.length - 1].month)}: ${pct(rt[rt.length - 1].repeat_rate)}.`,
    head: ["Month end", "Customers who bought", "Of them, 2+ orders", "Repeat rate"], rows: rt.map((p) => [mShort(p.month), num(p.buyers), num(p.repeaters), pct(p.repeat_rate)]), note: "Cumulative: customers with 2+ paid orders ÷ customers with 1+, counted as at the end of each month." };
  const co = d.cohorts, mx = Math.max(0, ...co.flatMap((c) => c.cells.filter((x) => x != null)));
  out.coh = co.every((c) => c.customers === 0) ? { empty: "no first orders in the last 12 months." } : { heat: true, co, mx, head: [], rows: [], summary: "" };
  const rt2 = d.revenue_by_tier, rtMax = rt2.reduce((a, b) => a + b.net_paise, 0);
  out.tier = rt2.length === 0 ? { empty: "no paid orders in this period." } : {
    svg: hbars(W, rt2.map((t) => ({ label: t.tier, v: t.net_paise, text: `${rsC(t.net_paise)} · ${num(t.orders)} orders`, drill: t.drill })), C1, ""),
    summary: `Horizontal bars of net revenue by tier: ${rt2.map((t) => `${t.tier} ${rs(t.net_paise)}`).join(", ")}.`,
    head: ["Tier", "Net revenue", "Share", "Orders", "Customers now in tier"], rows: rt2.map((t) => [t.tier, rs(t.net_paise), pct(rtMax ? t.net_paise / rtMax : null), num(t.orders), drillBtn(t.drill, `Open ${t.tier} members`)]), note: d.notes.revenue_by_tier };
  const sp = d.spend_distribution, spTot = sp.reduce((a, b) => a + b.customers, 0);
  out.spend = spTot === 0 ? { empty: "no customers yet." } : {
    svg: hbars(W, sp.map((s) => ({ label: s.label, v: s.customers, text: num(s.customers) + " customers", drill: s.drill })), C1, ""),
    summary: `Horizontal bars of customers by lifetime spend: ${sp.map((s) => `${s.label} ${s.customers}`).join(", ")}.`,
    head: ["Lifetime spend", "Customers", "Share", "List"], rows: sp.map((s) => [s.label, num(s.customers), pct(s.customers / spTot), drillBtn(s.drill, `Open customers with spend ${s.label}`)]), note: d.notes.spend_distribution };
  const ct = d.categories;
  out.cat = ct.length === 0 ? { empty: "no paid orders with products in this period." } : {
    svg: hbars(W, ct.map((c) => ({ label: c.category, v: c.units, text: `${num(c.units)} units${c.approx_net_paise == null ? "" : " · ≈ " + rsC(c.approx_net_paise)}`, drill: c.drill })), C1, ""),
    summary: `Horizontal bars of units sold by category: ${ct.map((c) => `${c.category} ${c.units}`).join(", ")}. Revenue shown is approximate.`,
    head: ["Category", "Units (exact)", "Orders", "Net revenue (approximate)", "All-time buyers"], rows: ct.map((c) => [c.category, num(c.units), num(c.orders), c.approx_net_paise == null ? NA : "≈ " + rs(c.approx_net_paise), drillBtn(c.drill, `Open buyers of ${c.category}`)]), note: d.notes.categories };
  return out;
}
function paintCohort(body, s, notes) {
  const head = ["Cohort (first order)", "Customers", ...Array.from({ length: 12 }, (_, k) => (k === 0 ? "Month 0" : "+" + k))];
  const t = el("table", { class: "ca-table ca-heat" }, el("caption", {}, "Net revenue by first-order month and months since. Blank cells are months that have not happened yet."), el("thead", {}, el("tr", {}, head.map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, s.co.map((c) => el("tr", {}, el("th", { scope: "row" }, mShort(c.cohort)), el("td", {}, num(c.customers)), c.cells.map((v) => el("td", { class: HEAT(v, s.mx) }, v == null ? "" : rsC(v)))))));
  body.replaceChildren(el("div", { class: "ca-scroll" }, t), el("p", { class: "sub" }, notes.cohorts + " Darker cells = more revenue; every cell also shows its value."));
}
function paintEmail(body, rows, notes) {
  if (!rows.length) return body.replaceChildren(el("p", { class: "ca-empty" }, NA + ": no campaign was sent in this period."));
  const c = (v) => (v == null ? NA : num(v));
  body.replaceChildren(table(["Campaign", "Audience at send", "Sent", "Delivered", "Bounced", "Unsubscribed", "Unique clicks", "Attributed orders", "Attributed revenue"],
    rows.map((r) => [r.name, c(r.eligible_at_send), num(r.sent), c(r.delivered), c(r.bounced), c(r.unsubscribed), num(r.unique_clicks), c(r.attributed_orders), r.attributed_net_paise == null ? NA : rs(r.attributed_net_paise)], "Email engagement per campaign")),
  el("p", { class: "sub" }, "Revenue is attributed to the last tracked click, it is not proof the email caused the sale. " + notes.email_engagement + " Not available = the data was not recorded."));
}

CRM.register("analytics", (root) => {
  const defs = [["nvr", "New vs returning customers", "Is growth coming from new buyers or from people coming back? Shift effort between acquisition and retention."],
    ["acq", "New customer acquisition", "Are we winning new buyers, and are they signing up or checking out as guests? Decide whether to push account creation."],
    ["rep", "Repeat rate by month", "Are customers coming back more often over time? A falling line means follow-ups or loyalty perks need work."],
    ["coh", "Revenue by first-order cohort", "Do customers keep spending after their first order? Shows which acquisition months were worth the most."],
    ["tier", "Revenue by Rewards tier", "Which tiers earn the revenue? Decide whether tier discounts are paying for themselves."],
    ["spend", "Customers by lifetime spend", "How concentrated is spend? Find the high-value group to look after and the large low-spend group to grow."],
    ["cat", "Categories sold", "What do customers actually buy? Guide stock, bundles and cross-sell campaigns."],
    ["mail", "Email campaign engagement", "Which campaigns got read and led to orders? Repeat the ones that work, fix the ones that do not."]];
  const cards = Object.fromEntries(defs.map(([k, t, w]) => [k, chartCard(t, w)]));
  const grid = el("div", { class: "ca-grid" }, defs.map(([k]) => cards[k].box));
  root.replaceChildren(document.querySelector(".ca-bar") ? "" : filterBar(), grid);
  let seq = 0, data = null, lastW = 0;
  const draw = () => {
    const W = Math.max(280, Math.min(720, Math.floor((grid.querySelector(".ca-body")?.clientWidth || 340))));
    lastW = W; const s = specs(data, W);
    for (const k of ["nvr", "acq", "rep", "tier", "spend", "cat"]) paint(cards[k].body, s[k]);
    if (s.coh.empty) paint(cards.coh.body, s.coh); else paintCohort(cards.coh.body, s.coh, data.notes);
    paintEmail(cards.mail.body, data.email_engagement, data.notes);
  };
  const run = async () => {
    const me = ++seq; for (const c of Object.values(cards)) c.body.replaceChildren(el("p", { class: "sub", role: "status" }, "Loading…"));
    try { const d = await api("/api/crm/analytics?" + rangeQs()); if (me !== seq) return; data = d; draw(); }
    catch (e) { if (me === seq) for (const c of Object.values(cards)) c.body.replaceChildren(retry("Could not load this chart: " + e.message, run)); }
  };
  let t; window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { if (root.isConnected && data && Math.abs((grid.querySelector(".ca-body")?.clientWidth || lastW) - lastW) > 24) draw(); }, 150); });
  onRange(root, run); run();
});
})();
