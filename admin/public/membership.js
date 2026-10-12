// Membership & Rewards screen (#/membership): points settings, milestones, product eligibility, customer wallets, analytics.
// Shares $, el, inr, when (app.js) and toast, ask (products.js). Text is inserted with textContent only; no inline styles (CSP).
(() => {
const M = { data: null, loaded: false, tab: "settings", an: null, anRange: "30d", anFrom: "", anTo: "", f: null, ms: null, stats: null, msErr: "", setErr: null, setBusy: false, msBusy: false, q: "", pq: "", cust: { q: "", page: 1, list: [], more: false, err: "" } };
const root = () => $("membership-root");
const rupeesStr = (paise) => (paise / 100).toFixed(2).replace(/\.00$/, "");
const num = (n) => Number(n || 0).toLocaleString("en-IN");
const pct = (v) => (v == null ? "—" : v + "%");
const slug = (s) => (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "ms") + "-" + Math.random().toString(16).slice(2, 6);
const KIND = { earn: "Earned", restore: "Restored", bonus: "Milestone bonus", redeem: "Redeemed", expire: "Expired", reverse: "Reversed", bonus_reverse: "Bonus taken back", adjust: "Manual adjustment" };
const day = (s) => new Date(s * 1000).toLocaleDateString("en-IN", { dateStyle: "medium" });

// own fetch wrapper: keeps the HTTP status and the server's list of validation errors (api() in app.js keeps only the message)
async function call(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" }, body: JSON.stringify(body) });
  if (r.status === 401) { location.reload(); throw new Error("signed out"); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(r.status === 403 ? "Only the owner account can do this." : d.error || "Request failed"); e.status = r.status; e.errors = d.errors || []; throw e; }
  return d;
}
const card = (title, sub, ...kids) => el("section", { class: "pcard" }, el("div", { class: "pcard-head" }, el("h2", {}, title)), sub ? el("p", { class: "sub" }, sub) : "", ...kids);
const field = (label, input, hint, err) => el("div", { class: "field" + (err ? " bad" : "") }, el("label", {}, label, input), hint ? el("div", { class: "hint" }, hint) : "", err ? el("div", { class: "err", role: "alert" }, err) : "");
const stateMsg = (text, retry) => el("div", { class: "crm-err" }, el("p", { role: "alert" }, text), retry ? el("button", { class: "btn small", type: "button", onclick: retry }, "Retry") : "");
const tile = (label, value, note) => el("div", { class: "ca-tile" }, el("div", { class: "ca-lab" }, label), el("b", { class: value === "—" ? "ca-na" : "" }, value), note ? el("span", { class: "ca-d" }, note) : "");
const owner = () => !!(M.data && M.data.permissions && M.data.permissions.export);
const rupeesToPaise = (v) => { const s = String(v).trim().replace(/,/g, ""); if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN; return Math.round(Number(s) * 100); };

// Responsive table: real table roles; stacked labelled cards on narrow screens (CSS .mb-table)
function table(cls, heads, rows) {
  return el("div", { class: "mb-table " + cls, role: "table" },
    el("div", { class: "mb-row mb-head", role: "row" }, heads.map((h) => el("div", { role: "columnheader" }, h))),
    rows.map((cells) => el("div", { class: "mb-row", role: "row" }, cells.map((c, i) => el("div", { role: "cell", "data-label": heads[i] }, c)))));
}
function switchBtn(on, label, onText, offText, onclick) {
  const b = el("button", { class: "switch", type: "button", role: "switch", "aria-checked": String(on), "aria-label": label }, el("i", { class: "knob" }), el("span", {}, on ? onText : offText));
  b.onclick = onclick; return b;
}

// ── load ─────────────────────────────────────────────────────────────
async function loadAll() {
  root().replaceChildren(el("p", { class: "sub" }, "Loading…"));
  try {
    const [d, a] = await Promise.all([call("/api/points"), call("/api/points/analytics?range=30d").catch(() => null)]);
    M.data = d; M.ovAn = a; resetDrafts(); render();
  } catch (e) { root().replaceChildren(stateMsg("Could not load Membership & Rewards: " + e.message, loadAll)); }
}
function resetDrafts() {
  const s = M.data.settings;
  M.f = { earn: String(s.earnPer100), value: rupeesStr(s.valuePaise), minRedeem: String(s.minRedeem), maxPct: String(s.maxRedeemPct), minOrder: rupeesStr(s.minOrderPaise), validDays: String(s.validDays), earnOn: s.earnOn,
    restore: s.restoreOnCancel, clawback: s.clawback, renewWin: String(s.renewWindowDays), notice: s.noticeDays.join(",") };
  M.f0 = JSON.stringify(M.f); M.setErr = null;
  M.ms = M.data.milestones.map((m) => ({ id: m.id, label: m.label || "", th: rupeesStr(m.threshold_paise), bonus: String(m.bonus_points), active: m.active, isNew: false })); M.ms0 = JSON.stringify(M.ms); M.msErr = "";
}
function render() {
  const tabs = [["settings", "Settings"], ["milestones", "Milestones"], ["products", "Products"], ["customers", "Customers"], ["analytics", "Analytics"]];
  root().replaceChildren(
    el("div", { class: "pv-head" }, el("div", {}, el("h1", { class: "pv-title" }, "Membership & Rewards"), el("p", { class: "sub" }, "Points, spending milestones and member wallets. The fee, duration and member prices are on the Pricing page."))),
    overview(),
    el("div", { class: "chips", role: "group", "aria-label": "Sections" }, tabs.map(([k, l]) => el("button", { class: "chip", type: "button", "aria-pressed": String(M.tab === k), onclick: () => { M.tab = k; render(); } }, l))),
    el("div", { id: "mb-body" }));
  const body = $("mb-body");
  ({ settings: settingsTab, milestones: milestonesTab, products: productsTab, customers: customersTab, analytics: analyticsTab })[M.tab](body);
}

// ── A. overview ──────────────────────────────────────────────────────
function overview() {
  const d = M.data, s = d.settings, a = M.ovAn, live = s.live;
  const sw = switchBtn(live, "Rewards points", "Rewards ON: points are earned and can be redeemed", "Rewards OFF: nothing earns or redeems", toggleLive);
  const err = el("p", { class: "msg", id: "mb-live-err", role: "alert" });
  return el("section", { class: "pcard" },
    el("div", { class: "pcard-head" }, el("h2", {}, "Overview"), sw), err,
    el("div", { class: "ca-tiles" },
      tile("Active members", num(d.counts.active_members)),
      tile("Expiring in 30 / 60 days", a ? `${a.memberships.expiring_30d} / ${a.memberships.expiring_60d}` : "—", "Members with no renewal queued"),
      tile("Points owed to customers", a ? inr(a.points.outstanding_liability_paise) : "—", a ? `${num(a.points.outstanding_points)} points held by ${num(a.points.holders)} customers` : "Could not load"),
      tile("Points ledger rows", num(d.counts.ledger_rows), d.counts.excluded_products ? `${d.counts.excluded_products} product(s) excluded from earning` : "")),
    d.warnings.length ? el("div", { class: "note warn", role: "region", "aria-label": "Warnings" }, el("b", {}, "Check before relying on this:"), el("ul", { class: "rules" }, d.warnings.map((w) => el("li", {}, w)))) : el("p", { class: "sub" }, "No warnings."));
}
async function toggleLive() {
  const d = M.data, next = !d.settings.live, err = $("mb-live-err");
  err.textContent = "";
  const lines = next ? ["Customers will start earning points on eligible orders and can redeem them at checkout straight away.", `Earning ${d.settings.earnPer100} points per ₹100; 1 point = ${inr(d.settings.valuePaise)}.`]
    : ["Nothing will earn or redeem while rewards are OFF. Existing balances, history and expiry dates are kept; pending orders are not lost."];
  if (d.warnings.length) lines.push("Warnings: " + d.warnings.join(" · "));
  if (!(await ask(next ? "Turn rewards ON?" : "Turn rewards OFF?", lines, next ? "Turn ON" : "Turn OFF", !next))) return;
  try { M.data = await call("/api/points/settings", { version: d.version, settings: { pts_live: next } }); toast(next ? "Rewards are ON." : "Rewards are OFF."); M.ovAn = await call("/api/points/analytics?range=30d").catch(() => M.ovAn); render(); }
  catch (e) { err.textContent = e.message; toast(e.message, true); }
}

// ── B. settings ──────────────────────────────────────────────────────
function parseDraft() {
  const f = M.f, e = {}, v = {};
  const int = (k, key, label, min, max) => { const n = Number(f[k]); if (String(f[k]).trim() === "" || !Number.isInteger(n) || n < min || n > max) e[k] = `${label} must be a whole number from ${min} to ${max}`; else v[key] = n; };
  int("earn", "pts_earn_per_100", "Points per ₹100", 0, 100); int("minRedeem", "pts_min_redeem", "Minimum redemption", 1, 100000); int("validDays", "pts_valid_days", "Validity", 1, 3650); int("renewWin", "renew_window_days", "Renewal window", 0, 365);
  const vp = rupeesToPaise(f.value); if (!Number.isFinite(vp) || vp < 1 || vp > 1000) e.value = "Point value must be between ₹0.01 and ₹10.00"; else v.pts_value_paise = vp;
  const mo = rupeesToPaise(f.minOrder); if (!Number.isFinite(mo) || mo > 100000000) e.minOrder = "Enter a rupee amount, 0 or more (max 2 decimals)"; else v.pts_min_order_paise = mo;
  const mp = Number(f.maxPct); if (String(f.maxPct).trim() === "" || !Number.isFinite(mp) || mp < 0 || mp > 50) e.maxPct = "Maximum redemption must be 0 to 50%"; else v.pts_max_redeem_pct = mp;
  const nl = String(f.notice).split(",").map((x) => x.trim()).filter(Boolean);
  if (nl.length > 4 || !nl.every((x) => /^\d{1,3}$/.test(x) && Number(x) >= 1 && Number(x) <= 365)) e.notice = "Up to 4 day-counts from 1 to 365, e.g. 30,7"; else v.renew_notice_days = nl.join(",");
  v.pts_earn_on = f.earnOn; v.pts_restore_on_cancel = !!f.restore; v.pts_clawback = !!f.clawback;
  return { e, v, ok: !Object.keys(e).length };
}
function previewNodes() {
  const { ok, v } = parseDraft();
  if (!ok) return [el("p", { class: "sub" }, "Fix the highlighted values to see the preview.")];
  const order = 270000, eligible = order >= v.pts_min_order_paise, pts = eligible ? Math.floor((order * v.pts_earn_per_100) / 10000) : 0;
  const cap = Math.floor((order * v.pts_max_redeem_pct) / 100 / v.pts_value_paise), val = v.pts_value_paise;
  const when_ = v.pts_earn_on === "paid" ? "once the order is paid" : "once the order is delivered";
  return [
    el("p", { class: "preview" }, `Customers see: “Earn ${v.pts_earn_per_100} point${v.pts_earn_per_100 === 1 ? "" : "s"} for every ₹100 you spend. 1 point = ${inr(val)}. Redeem from ${v.pts_min_redeem} points, up to ${v.pts_max_redeem_pct}% of an order. Points last ${v.pts_valid_days} days.”`),
    el("p", { class: "note" }, el("b", {}, "Worked example: "), `a ${inr(order)} order of eligible products ${eligible ? `earns ${pts} points (worth ${inr(pts * val)}) ${when_}` : `earns nothing, because it is under the ${inr(v.pts_min_order_paise)} minimum qualifying order`}. At most ${cap} points (${inr(cap * val)}) can be redeemed on it${cap < v.pts_min_redeem ? `, which is below the ${v.pts_min_redeem}-point minimum, so redemption would be refused` : ""}.`),
  ];
}
function settingsTab(body) {
  const f = M.f, p = parseDraft(), pv = el("div", { id: "mb-prev" }, previewNodes());
  const refresh = () => {
    const np = parseDraft();
    pv.replaceChildren(...previewNodes());
    document.querySelectorAll("[data-fk]").forEach((w) => { const m = np.e[w.dataset.fk]; w.classList.toggle("bad", !!m); w.querySelector(".err").textContent = m || ""; });
    $("mb-save").disabled = M.setBusy || M.f0 === JSON.stringify(M.f);
    $("mb-dirty").textContent = M.f0 === JSON.stringify(M.f) ? "" : "You have unsaved changes.";
  };
  const text = (k, label, hint, mode) => { const i = el("input", { value: f[k], inputmode: mode || "numeric", "aria-label": label }); i.oninput = () => { f[k] = i.value; refresh(); }; const w = field(label, i, hint, p.e[k]); w.dataset.fk = k; if (!w.querySelector(".err")) w.append(el("div", { class: "err", role: "alert" })); return w; };
  const sel = el("select", { "aria-label": "Earn points when" }, el("option", { value: "delivered" }, "The order is delivered (recommended)"), el("option", { value: "paid" }, "The order is paid")); sel.value = f.earnOn; sel.onchange = () => { f.earnOn = sel.value; refresh(); };
  const chk = (k, label, hint) => { const c = el("input", { type: "checkbox" }); c.checked = f[k]; c.onchange = () => { f[k] = c.checked; refresh(); }; return el("div", { class: "field" }, el("label", { class: "chk" }, c, " " + label), el("div", { class: "hint" }, hint)); };
  const plan = M.data.plan, withDisc = M.data.products.filter((x) => x.member_discount_pct > 0).length;
  const err = el("div", { id: "mb-seterr", role: "alert" });
  const save = el("button", { class: "btn primary", type: "button", id: "mb-save", onclick: saveSettings }, "Save settings");
  body.replaceChildren(
    card("Points rules", "Changes apply to new orders. Points already earned keep the expiry date they were given.",
      el("div", { class: "pgrid" },
        text("earn", "Points earned per ₹100", "Counted on eligible products, after discounts, without GST or shipping."),
        text("value", "Value of 1 point (₹)", "What one point is worth when redeemed. ₹1 is the usual choice.", "decimal"),
        text("minRedeem", "Minimum points to redeem", "Customers cannot redeem fewer than this in one order."),
        text("maxPct", "Maximum share of an order payable with points (%)", "Up to 50. Protects your margin.", "decimal"),
        text("minOrder", "Minimum qualifying order (₹)", "Orders with less eligible value than this earn no points and cannot redeem. 0 = no minimum.", "decimal"),
        text("validDays", "Points valid for (days)", "Each earning expires this long after it is credited."),
        field("Earn points when", sel, "Earning on delivery avoids rewarding orders that get returned."),
        text("renewWin", "Renewal window (days)", "How long before expiry a member can renew without losing days."),
        text("notice", "Expiry reminder emails (days before)", "Comma-separated, e.g. 30,7. One service email per threshold.", "text"),
        chk("restore", "Restore redeemed points when an order is cancelled or returned", "Off = points spent on a cancelled order are not given back."),
        chk("clawback", "Take back milestone bonuses if refunds drop spend under the threshold", "Never takes a balance below zero.")),
      err, el("div", { class: "actions" }, save), el("p", { class: "hint", id: "mb-dirty" })),
    card("What the customer sees", null, pv),
    card("Membership plan (read-only)", "The membership fee, duration and member prices are managed on the Pricing page.",
      el("dl", { class: "crm-dl" }, el("dt", {}, "Fee"), el("dd", {}, inr(plan.fee_paise)), el("dt", {}, "Duration"), el("dd", {}, `${plan.duration_days} days`),
        el("dt", {}, "Member prices"), el("dd", {}, plan.discounts_live ? `ON (${withDisc} product${withDisc === 1 ? "" : "s"} discounted)` : "OFF: members pay regular prices")),
      el("a", { class: "btn", href: "#/pricing" }, "Open Pricing")));
  refresh();
  if (M.setErr) showSetErr();
}
function showSetErr() {
  const box = $("mb-seterr"); if (!box || !M.setErr) return;
  box.replaceChildren(el("div", { class: "note bad" }, ...M.setErr.errors.length > 1 ? [el("ul", { class: "rules" }, M.setErr.errors.map((x) => el("li", {}, x)))] : [M.setErr.message],
    M.setErr.stale ? [" ", el("button", { class: "btn small", type: "button", onclick: async () => { M.setErr = null; await loadAll(); toast("Loaded the latest settings."); } }, "Reload latest (discard my edits)")] : ""));
}
async function saveSettings() {
  const p = parseDraft(); if (!p.ok || M.setBusy) { $("mb-seterr").replaceChildren(el("div", { class: "note bad" }, "Fix the highlighted values first.")); return; }
  const s = M.data.settings, lines = [`${p.v.pts_earn_per_100} points per ₹100; 1 point = ${inr(p.v.pts_value_paise)}; up to ${p.v.pts_max_redeem_pct}% of an order; min ${p.v.pts_min_redeem} points.`,
    s.live ? "Rewards are ON: customers see the new rules at their next checkout." : "Rewards are OFF: nothing changes for customers yet."];
  if (!(await ask("Save rewards settings?", lines, "Save"))) return;
  M.setBusy = true; $("mb-save").disabled = true; M.setErr = null; $("mb-seterr").replaceChildren();
  try { M.data = await call("/api/points/settings", { version: M.data.version, settings: p.v }); resetDraftSettingsOnly(); toast("Settings saved."); render(); }
  catch (e) { M.setErr = { message: e.message, errors: e.errors || [], stale: e.status === 409 }; toast(e.message, true); showSetErr(); }
  finally { M.setBusy = false; const b = $("mb-save"); if (b) b.disabled = M.f0 === JSON.stringify(M.f); }
}
function resetDraftSettingsOnly() { const ms = M.ms, ms0 = M.ms0, msErr = M.msErr; resetDrafts(); if (ms0 !== JSON.stringify(ms) ) { M.ms = ms; M.ms0 = ms0; M.msErr = msErr; } }

// ── C. milestones ────────────────────────────────────────────────────
async function loadStats() { try { M.stats = (await call("/api/points/milestone-stats")).milestones; } catch { M.stats = null; } }
function validateMs() {
  const out = [], seen = new Set(); let n = 0;
  M.ms.forEach((m, i) => {
    const e = {}, th = rupeesToPaise(m.th), b = Number(m.bonus);
    if (!Number.isFinite(th) || th < 100 || th > 1e9) e.th = "At least ₹1"; else if (m.active && seen.has(th)) e.th = "Another active milestone has this amount"; else if (m.active) seen.add(th);
    if (String(m.bonus).trim() === "" || !Number.isInteger(b) || b < 1 || b > 1e6) e.bonus = "1 to 1,000,000 points";
    if (Object.keys(e).length) n++;
    out[i] = e;
  });
  if (M.ms.length > 12) n++;
  return { errs: out, bad: n };
}
function milestonesTab(body) {
  if (M.stats === null && !M.statsTried) { M.statsTried = true; loadStats().then(() => { if (M.tab === "milestones") render(); }); }
  const v = validateMs(), s = M.data.settings, dirty = M.ms0 !== JSON.stringify(M.ms);
  const statOf = (id) => (M.stats || []).find((x) => x.id === id);
  const rows = M.ms.map((m, i) => {
    const th = el("input", { value: m.th, inputmode: "decimal", "aria-label": `Milestone ${i + 1} spend threshold in rupees` }), bo = el("input", { value: m.bonus, inputmode: "numeric", "aria-label": `Milestone ${i + 1} bonus points` }), lb = el("input", { value: m.label, maxlength: "60", "aria-label": `Milestone ${i + 1} label` });
    th.onchange = () => { m.th = th.value; render(); }; bo.onchange = () => { m.bonus = bo.value; render(); }; lb.oninput = () => { m.label = lb.value; M.msDirtyTick = 1; };
    lb.onchange = () => render();
    const st = statOf(m.id);
    const act = switchBtn(m.active, `Milestone ${i + 1} is ${m.active ? "active" : "off"}`, "Active", "Off", () => { m.active = !m.active; render(); });
    const rm = el("button", { class: "btn small danger", type: "button", onclick: () => { if (m.isNew) M.ms.splice(i, 1); else m.active = false; render(); } }, m.isNew ? "Remove" : "Turn off");
    return [field("", lb), el("div", {}, field("", th, null, v.errs[i].th)), el("div", {}, field("", bo, null, v.errs[i].bonus)), act,
      st ? `${num(st.awarded)} reached · about ${num(st.awarded * st.bonus_points)} bonus pts issued (at today's bonus) · ${num(st.taken_back)} pts taken back` : (m.isNew ? "New" : (M.stats === null ? "Loading…" : "—")), rm];
  });
  const add = el("button", { class: "btn", type: "button", onclick: () => { const last = M.ms.length ? Math.max(...M.ms.map((x) => rupeesToPaise(x.th) || 0)) : 0; M.ms.push({ id: slug("ms"), label: "", th: rupeesStr(last + 200000), bonus: "100", active: true, isNew: true }); render(); } }, "Add milestone");
  if (M.ms.length >= 12) add.disabled = true;
  const sort = el("button", { class: "btn", type: "button", onclick: () => { M.ms.sort((a, b) => (rupeesToPaise(a.th) || 0) - (rupeesToPaise(b.th) || 0)); render(); } }, "Sort by amount");
  const save = el("button", { class: "btn primary", type: "button", onclick: saveMilestones }, "Save milestones");
  if (!dirty || v.bad) save.disabled = true;
  body.replaceChildren(card("Spending milestones", "A member earns bonus points the first time their eligible spend in a membership year reaches each amount.",
    el("ul", { class: "rules" },
      el("li", {}, "Each milestone is awarded once per membership year (a renewal starts a new year)."),
      el("li", {}, "Editing a milestone never rewrites bonuses already awarded; it applies to future awards only."),
      el("li", {}, "Milestones are never deleted, so history stays correct. Removing one switches it off."),
      el("li", {}, s.clawback ? "Clawback is ON: a bonus is taken back if refunds drop spend under the amount (never below a zero balance)." : "Clawback is OFF: bonuses stay even if refunds drop spend under the amount. Change this in Settings.")),
    M.ms.length ? table("mb-ms", ["Label", "Spend reaches (₹)", "Bonus points", "Status", "Awarded so far", ""], rows) : el("div", { class: "empty" }, el("p", {}, "No milestones yet.")),
    M.msErr ? el("div", { class: "note bad", role: "alert" }, M.msErr, M.msStale ? [" ", el("button", { class: "btn small", type: "button", onclick: async () => { M.msErr = ""; M.msStale = false; await loadAll(); toast("Loaded the latest milestones."); } }, "Reload latest (discard my edits)")] : "") : "",
    v.bad ? el("p", { class: "msg", role: "alert" }, "Fix the highlighted values before saving.") : "",
    el("div", { class: "actions mb-actions" }, add, sort, save), dirty ? el("p", { class: "hint" }, "You have unsaved changes.") : ""));
}
async function saveMilestones() {
  if (M.msBusy || validateMs().bad) return;
  const list = [...M.ms].sort((a, b) => rupeesToPaise(a.th) - rupeesToPaise(b.th)).map((m) => ({ id: m.id, label: m.label.trim(), threshold_paise: rupeesToPaise(m.th), bonus_points: Number(m.bonus), active: m.active }));
  const act = list.filter((m) => m.active);
  const lines = [act.length ? "Active: " + act.map((m) => `${inr(m.threshold_paise)} → ${num(m.bonus_points)} pts`).join(", ") + "." : "No milestone will be active.", "Bonuses already awarded are not changed."];
  if (!(await ask("Save milestones?", lines, "Save"))) return;
  M.msBusy = true; M.msErr = ""; M.msStale = false;
  try { M.data = await call("/api/points/milestones", { version: M.data.version, milestones: list }); const f = M.f, f0 = M.f0; resetDrafts(); if (f0 !== JSON.stringify(f)) { M.f = f; M.f0 = f0; } M.statsTried = false; M.stats = null; toast("Milestones saved."); }
  catch (e) { M.msErr = e.message; M.msStale = e.status === 409; toast(e.message, true); }
  finally { M.msBusy = false; render(); }
}

// ── D. product eligibility ───────────────────────────────────────────
function productsTab(body) {
  const q = M.pq.trim().toLowerCase();
  const list = M.data.products.filter((p) => !q || (p.name + " " + p.id + " " + (p.category || "")).toLowerCase().includes(q));
  const search = el("input", { type: "search", value: M.pq, placeholder: "Search products", "aria-label": "Search products" });
  search.oninput = () => { M.pq = search.value; clearTimeout(M.pt); M.pt = setTimeout(() => { const pos = search.selectionStart; render(); const s2 = document.querySelector("#mb-body input[type=search]"); if (s2) { s2.focus(); s2.setSelectionRange(pos, pos); } }, 200); };
  const rows = list.slice(0, 150).map((p) => {
    const sw = switchBtn(p.points_eligible, `${p.name} earns points`, "Earns points", "Excluded", async () => {
      sw.disabled = true;
      try { await call(`/api/products/${p.id}`, { points_eligible: !p.points_eligible }); p.points_eligible = !p.points_eligible; M.data.counts.excluded_products += p.points_eligible ? -1 : 1; toast(`${p.name}: ${p.points_eligible ? "earns points" : "excluded from points"}.`); }
      catch (e) { toast(e.message, true); }
      render();
    });
    const warn = p.member_discount_pct > 0 && p.cost_paise == null;
    return [el("div", {}, el("b", {}, p.name), el("div", { class: "sub" }, p.id + (p.active ? "" : " · inactive"))), inr(p.price_paise), p.member_discount_pct > 0 ? p.member_discount_pct + "%" : "None", sw,
      warn ? el("span", { class: "pill warn" }, "Member discount but no cost price") : p.cost_paise == null ? el("span", { class: "sub" }, "No cost price") : ""];
  });
  body.replaceChildren(card("Product eligibility", "Only purchases of products that earn points count toward points and milestones. Changes save immediately and apply to new orders.", el("div", { class: "mb-search" }, search),
    rows.length ? table("mb-pr", ["Product", "Price", "Member discount", "Earns points", "Notes"], rows) : el("div", { class: "empty" }, el("p", {}, q ? "No products match." : "No products.")),
    list.length > 150 ? el("p", { class: "hint" }, `Showing 150 of ${list.length}. Search to narrow.`) : ""));
}

// ── E. customers & wallets ───────────────────────────────────────────
async function loadCustomers(append) {
  const c = M.cust; c.err = "";
  try { const d = await call(`/api/points/customers?q=${encodeURIComponent(c.q)}&page=${c.page}`); c.list = append ? c.list.concat(d.customers) : d.customers; c.more = d.more; c.loadedOnce = true; }
  catch (e) { c.err = e.message; }
  if (M.tab === "customers") customersTab($("mb-body"));
}
function customersTab(body) {
  const c = M.cust;
  if (!c.loadedOnce && !c.err && !c.loading) { c.loading = true; loadCustomers(false).finally(() => { c.loading = false; }); }
  const search = el("input", { type: "search", value: c.q, placeholder: "Search by name, email or phone", "aria-label": "Search customers" });
  search.oninput = () => { clearTimeout(M.ct); M.ct = setTimeout(() => { c.q = search.value.trim(); c.page = 1; loadCustomers(false).then(() => { const s = document.querySelector("#mb-body input[type=search]"); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }); }, 300); };
  const rows = c.list.map((u) => [el("div", {}, el("b", { class: "crm-name" }, u.name || u.email), u.name ? el("div", { class: "sub crm-wrap" }, u.email) : ""),
    el("span", { class: "pill " + (u.member ? "paid" : "") }, u.member ? "Member" : "Not a member"), u.expires_at ? day(u.expires_at) : "—", num(u.points) + " pts",
    el("button", { class: "btn small", type: "button", onclick: () => openCustomer(u.id) }, "Open")]);
  body.replaceChildren(card("Customers & wallets", "Search a customer to see their membership, points wallet, milestone progress, orders and full points history.", el("div", { class: "mb-search" }, search),
    owner() ? el("div", { class: "rowact" }, el("button", { class: "btn", type: "button", onclick: () => grantDialog("", null) }, "Activate membership manually")) : el("p", { class: "hint" }, "Adjusting points and activating or ending memberships is for the owner account only."),
    c.err ? stateMsg("Could not load customers: " + c.err, () => loadCustomers(false)) : !c.loadedOnce ? el("p", { class: "sub" }, "Loading…") :
      rows.length ? table("mb-cu", ["Customer", "Status", "Latest term ends", "Points ledger", ""], rows) : el("div", { class: "empty" }, el("p", {}, c.q ? "No customers match." : "No customers yet.")),
    c.more ? el("div", { class: "actions" }, el("button", { class: "btn", type: "button", onclick: () => { c.page++; loadCustomers(true); } }, "Load more")) : ""));
}

function panel() {
  let d = $("mcust");
  if (!d) { d = el("dialog", { class: "panel", id: "mcust", "aria-labelledby": "mcust-h" }); document.body.append(d); d.addEventListener("click", (e) => { if (e.target === d) d.close(); }); }
  return d;
}
async function openCustomer(id, keepScroll) {
  const d = panel(), body0 = d.querySelector(".opanel-body"), top = body0 ? body0.scrollTop : 0;
  if (!d.open) { d.replaceChildren(el("div", { class: "panel-head" }, el("h2", { class: "h0", id: "mcust-h" }, "Customer"), el("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: () => d.close() }, "✕")), el("div", { class: "opanel-body" }, el("p", { class: "sub" }, "Loading…"))); d.showModal(); }
  try {
    const x = await call(`/api/points/customers/${id}`);
    renderCustomer(d, id, x); if (keepScroll) d.querySelector(".opanel-body").scrollTop = top;
  } catch (e) { d.querySelector(".opanel-body").replaceChildren(stateMsg("Could not load this customer: " + e.message, () => openCustomer(id))); }
}
function renderCustomer(d, id, x) {
  const u = x.customer, s = x.summary, w = s.wallet, v = s.value, ms = s.milestones;
  const tile2 = (l, val, n) => tile(l, val, n);
  const terms = x.memberships.length ? x.memberships.map((m) => el("li", { class: "prow" },
    el("div", {}, el("span", { class: "pill " + (m.active ? "paid" : m.status === "active" ? "unpaid" : "cancelled") }, m.active ? "Active" : m.status === "active" ? "Active (past end)" : m.status[0].toUpperCase() + m.status.slice(1)), " ", `${day(m.purchased_at)} to ${day(m.expires_at)}`),
    el("div", { class: "sub" }, m.price_paid ? `Paid ${inr(m.price_paid)}` : "No fee (manual or free)", String(m.payment_id || "").startsWith("admin:") ? " · activated by admin" : ""),
    owner() && m.status === "active" ? el("div", { class: "rowact" }, el("button", { class: "btn small danger", type: "button", onclick: () => endDialog(m, id) }, "Cancel / mark refunded")) : "")) : [el("li", { class: "sub" }, "No membership terms.")];
  const ladder = ms.ladder.length ? el("ul", { class: "rules" }, ms.ladder.map((m) => el("li", {}, `${inr(m.thresholdPaise)}: ${num(m.bonusPoints)} pts · `, el("b", {}, m.awarded ? "awarded" : m.reached ? "reached (awaiting award)" : `${inr(m.thresholdPaise - ms.spendPaise)} to go`)))) : el("p", { class: "sub" }, s.membership.active ? "No active milestones." : "Milestones apply during an active membership year.");
  const orders = x.orders.length ? x.orders.map((o) => el("li", { class: "prow" }, el("div", {}, el("b", {}, "#" + o.id.slice(0, 8)), " ", when(o.created_at), " ", el("span", { class: "pill" }, o.status), el("span", { class: "pill " + (o.payment_status === "paid" ? "paid" : "unpaid") }, o.payment_status)),
    el("div", { class: "sub" }, `Total ${inr(o.total)} · points basis ${inr(o.points_basis_paise || 0)} · redeemed ${num(o.points_redeemed)} pts · member saving ${inr(o.member_saving_paise || 0)}${o.refunded_paise ? " · refunded " + inr(o.refunded_paise) : ""}`))) : [el("li", { class: "sub" }, "No orders.")];
  const ledger = el("ul", { class: "hlist", id: "mb-ledger" }); const more = el("div", {});
  const addEntries = (a) => { ledger.append(...a.entries.map((e) => el("li", {}, el("div", { class: "mb-lrow" }, el("b", { class: e.points < 0 ? "crm-neg" : "" }, (e.points > 0 ? "+" : "") + num(e.points)), el("span", {}, KIND[e.kind] || e.kind), el("span", { class: "sub" }, when(e.created_at))),
    el("div", { class: "sub" }, [e.order_ref ? "Order #" + e.order_ref : "", e.expires_at ? "expires " + day(e.expires_at) : "", e.reason || ""].filter(Boolean).join(" · "))))); more.replaceChildren(a.more ? el("button", { class: "btn", type: "button", onclick: async (ev) => { ev.target.disabled = true; try { const r = await call(`/api/points/customers/${id}?before=${a.entries[a.entries.length - 1].created_at}`); addEntries(r.activity); } catch (e) { toast(e.message, true); ev.target.disabled = false; } } }, "Load older") : ""); };
  if (!x.activity.entries.length) ledger.append(el("li", { class: "sub" }, "No points activity yet."));
  addEntries(x.activity);
  const actions = owner() ? el("div", { class: "rowact" }, el("button", { class: "btn primary", type: "button", onclick: () => adjustDialog(id, u, w.availablePoints) }, "Adjust points"), el("button", { class: "btn", type: "button", onclick: () => grantDialog(u.email, id) }, "Activate membership manually")) : el("p", { class: "hint" }, "Only the owner account can adjust points or change memberships.");
  d.replaceChildren(el("div", { class: "panel-head" }, el("div", {}, el("h2", { class: "h0 crm-name", id: "mcust-h" }, u.name || u.email), el("div", { class: "sub crm-wrap" }, [u.name ? u.email : "", u.phone || "", "Joined " + day(u.created_at)].filter(Boolean).join(" · "))), el("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: () => d.close() }, "✕")),
    el("div", { class: "opanel-body" }, actions,
      el("h3", { class: "sec" }, "Membership terms"), el("ul", { class: "mb-list" }, terms),
      el("h3", { class: "sec" }, "Points wallet"),
      el("div", { class: "ca-tiles" }, tile2("Available", num(w.availablePoints) + " pts", inr(w.availablePoints * w.valuePaise)), tile2("Pending", num(w.pendingPoints) + " pts", "Orders not yet delivered"), tile2("Expiring in 30 days", num(w.expiringSoon) + " pts"), tile2("Earned / bonus", `${num(w.earnedPoints)} / ${num(w.bonusPoints)}`),
        tile2("Redeemed", num(w.redeemedPoints)), tile2("Expired", num(w.expiredPoints)), tile2("Reversed", num(w.reversedPoints)), tile2("Owed back", num(w.owedPoints), "Reversals not yet covered")),
      el("h3", { class: "sec" }, "Realised value"),
      el("div", { class: "ca-tiles" }, tile2("Member price savings", inr(v.memberPriceSavingsPaise)), tile2("Points redeemed value", inr(v.redeemedValuePaise)), tile2("Membership fee paid", inr(v.feePaidPaise)), tile2("Net to the customer", (v.netRealizedPaise < 0 ? "−" : "") + inr(Math.abs(v.netRealizedPaise)), "Savings + points value − fee")),
      el("h3", { class: "sec" }, "Milestone progress"), el("p", { class: "sub" }, s.membership.active ? `Eligible spend this membership year: ${inr(ms.spendPaise)}` : "No active membership."), ladder,
      el("h3", { class: "sec" }, "Recent orders"), el("ul", { class: "mb-list" }, orders),
      el("h3", { class: "sec" }, "Referral activity"), el("p", { class: "sub" }, "Not available: referrals are not implemented."),
      el("h3", { class: "sec" }, "Points history"), ledger, more));
}

// form dialog shared by adjust / grant / end: validate -> ask() confirm -> POST; server errors stay inline
function formDialog({ title, intro, fields, okLabel, danger, validate, confirmLines, submit, done }) {
  let d = $("mdlg"); if (!d) { d = el("dialog", { class: "crm-dlg", id: "mdlg", "aria-labelledby": "mdlg-h" }); document.body.append(d); }
  const err = el("p", { class: "msg", role: "alert" }), ok = el("button", { class: "btn " + (danger ? "danger-solid" : "primary"), type: "button" }, okLabel);
  const go = async () => {
    err.textContent = ""; const bad = validate(); if (bad) { err.textContent = bad; return; }
    if (!(await ask(title, confirmLines(), okLabel, danger))) return;
    ok.disabled = true;
    try { const r = await submit(); d.close(); await done(r); } catch (e) { err.textContent = e.message; if (e.status === 403) toast(e.message, true); } finally { ok.disabled = false; }
  };
  ok.onclick = go;
  d.replaceChildren(el("h2", { class: "h0", id: "mdlg-h" }, title), intro ? el("p", { class: "sub" }, intro) : "", el("div", { class: "form" }, ...fields), err, el("div", { class: "actions" }, ok, el("button", { class: "btn", type: "button", onclick: () => d.close() }, "Cancel")));
  d.showModal();
}
function adjustDialog(id, u, avail) {
  const key = crypto.randomUUID(); // once per dialog open: a double click or retry cannot apply twice
  const pts = el("input", { inputmode: "numeric", placeholder: "e.g. 100 or -50", "aria-label": "Points to add (negative to remove)" }), reason = el("input", { maxlength: "200", "aria-label": "Reason" }), res = el("p", { class: "preview" });
  const upd = () => { const n = Number(pts.value); res.textContent = pts.value.trim() && Number.isInteger(n) ? `Balance after: ${num(avail + n)} pts (now ${num(avail)})` : `Current balance: ${num(avail)} pts`; };
  pts.oninput = upd; upd();
  formDialog({ title: "Adjust points", intro: `${u.name || u.email}. The change is permanent and shown in their history.`,
    fields: [field("Points (whole number; negative removes)", pts), field("Reason (required, at least 5 characters)", reason, "Recorded with your name in the audit log."), res],
    okLabel: "Apply adjustment",
    validate: () => { const n = Number(pts.value); if (!pts.value.trim() || !Number.isInteger(n) || n === 0 || Math.abs(n) > 100000) return "Enter a whole number of points, not 0 (up to 100,000)."; if (n < 0 && -n > avail) return `This would take the balance below zero (available ${num(avail)}).`; if (reason.value.trim().length < 5) return "A reason of at least 5 characters is required."; return ""; },
    confirmLines: () => [`${u.name || u.email}: ${Number(pts.value) > 0 ? "+" : ""}${num(Number(pts.value))} points. Balance becomes ${num(avail + Number(pts.value))}.`, "Reason: " + reason.value.trim()],
    submit: () => call(`/api/points/customers/${id}/adjust`, { points: Number(pts.value), reason: reason.value.trim(), idempotency_key: key, confirm: true }),
    done: async (r) => { toast(r.duplicate ? "That adjustment was already applied." : "Points adjusted."); await openCustomer(id, true); refreshOverview(); } });
}
function grantDialog(email, id) {
  const em = el("input", { type: "email", value: email, "aria-label": "Customer account email", autocomplete: "off" }), days = el("input", { inputmode: "numeric", value: String(M.data.plan.duration_days), "aria-label": "Days" }), reason = el("input", { maxlength: "200", "aria-label": "Reason" });
  formDialog({ title: "Activate membership manually", intro: "For a bank transfer or goodwill. No fee is recorded. If the customer is already a member, the new term starts when the current one ends.",
    fields: [field("Customer account email", em, "The customer must already have an account."), field("Days (1 to 1095)", days), field("Reason (required, at least 5 characters)", reason)], okLabel: "Activate membership",
    validate: () => { if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em.value.trim())) return "Enter the customer's account email."; const n = Number(days.value); if (!Number.isInteger(n) || n < 1 || n > 1095) return "Days must be a whole number from 1 to 1095."; if (reason.value.trim().length < 5) return "A reason of at least 5 characters is required."; return ""; },
    confirmLines: () => [`Give ${em.value.trim()} ${days.value} days of membership at no charge.`, "Reason: " + reason.value.trim()],
    submit: () => call("/api/members/grant", { email: em.value.trim(), days: Number(days.value), reason: reason.value.trim(), confirm: true }),
    done: async () => { toast("Membership activated."); if (id) await openCustomer(id, true); refreshOverview(); } });
}
function endDialog(m, userId) {
  const st = el("select", { "aria-label": "New status" }, el("option", { value: "cancelled" }, "Cancelled"), el("option", { value: "refunded" }, "Refunded")), reason = el("input", { maxlength: "200", "aria-label": "Reason" });
  formDialog({ title: "Cancel membership", intro: `Term ${day(m.purchased_at)} to ${day(m.expires_at)}. Member prices stop immediately. Points already earned are kept; reverse them with an adjustment if needed. This does not move any money.`,
    fields: [field("Mark as", st), field("Reason (required, at least 5 characters)", reason)], okLabel: "End membership", danger: true,
    validate: () => (reason.value.trim().length < 5 ? "A reason of at least 5 characters is required." : ""),
    confirmLines: () => [`End this membership as ${st.value}.`, "Reason: " + reason.value.trim()],
    submit: () => call(`/api/members/${m.id}/end`, { status: st.value, reason: reason.value.trim(), confirm: true }),
    done: async () => { toast("Membership ended."); await openCustomer(userId, true); refreshOverview(); } });
}
async function refreshOverview() { try { const [d, a] = await Promise.all([call("/api/points"), call("/api/points/analytics?range=30d").catch(() => M.ovAn)]); M.data.counts = d.counts; M.data.warnings = d.warnings; M.ovAn = a; M.data.version = d.version; render(); } catch { /* keep what is on screen */ } }

// ── F. analytics ─────────────────────────────────────────────────────
async function loadAnalytics() {
  M.anErr = ""; M.an = null; if (M.tab === "analytics") analyticsTab($("mb-body"));
  const qs = M.anRange === "from" ? `from=${M.anFrom}&to=${M.anTo}` : `range=${M.anRange}`;
  try { M.an = await call("/api/points/analytics?" + qs); } catch (e) { M.anErr = e.message; }
  if (M.tab === "analytics") analyticsTab($("mb-body"));
}
const SVGNS = "http://www.w3.org/2000/svg";
function svg(tag, attrs, ...kids) { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); n.append(...kids); return n; }
function pointsChart(p) {
  const rows = [["Issued", p.issued], ["Redeemed", p.redeemed], ["Expired", p.expired], ["Reversed", p.reversed]], max = Math.max(1, ...rows.map((r) => r[1]));
  const s = svg("svg", { viewBox: "0 0 320 130", class: "mb-chart", role: "img", "aria-label": "Points issued, redeemed, expired and reversed in the period. The table below has the same numbers." });
  rows.forEach(([l, v], i) => { const y = 8 + i * 30, w = Math.round((v / max) * 190); s.append(svg("text", { x: "0", y: y + 15, class: "lbl" }, l), svg("rect", { x: "70", y: String(y), width: String(Math.max(w, v ? 2 : 0)), height: "20", rx: "4", class: "bar" }), svg("text", { x: String(76 + w), y: y + 15, class: "lbl" }, num(v))); });
  return s;
}
function analyticsTab(body) {
  const chips = [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["90d", "90 days"], ["from", "Custom"]];
  const from = el("input", { type: "date", value: M.anFrom, "aria-label": "From date" }), to = el("input", { type: "date", value: M.anTo, "aria-label": "To date" });
  const apply = el("button", { class: "btn small", type: "button", onclick: () => { if (!from.value || !to.value || from.value > to.value) { toast("Choose a valid From and To date.", true); return; } M.anFrom = from.value; M.anTo = to.value; M.anRange = "from"; loadAnalytics(); } }, "Apply");
  const bar = el("div", {}, el("div", { class: "chips", role: "group", "aria-label": "Date range" }, chips.map(([k, l]) => el("button", { class: "chip", type: "button", "aria-pressed": String(M.anRange === k), onclick: () => { if (k === "from") { M.anRange = "from"; if (!M.anFrom) { const t = new Date().toISOString().slice(0, 10); M.anFrom = M.anTo = t; } render(); return; } M.anRange = k; loadAnalytics(); } }, l))),
    M.anRange === "from" ? el("div", { class: "ca-custom" }, el("label", {}, "From ", from), el("label", {}, "To ", to), apply) : "");
  if (M.anErr) { body.replaceChildren(card("Analytics", null, bar, stateMsg("Could not load analytics: " + M.anErr, loadAnalytics))); return; }
  if (!M.an) { body.replaceChildren(card("Analytics", null, bar, el("p", { class: "sub" }, "Loading…"))); if (!M.anTried) { M.anTried = true; loadAnalytics(); } return; }
  const a = M.an, m = a.memberships, o = a.orders, p = a.points, e = a.economics;
  const rr = m.renewal_rate == null ? "—" : m.renewal_rate + "%";
  body.replaceChildren(card("Analytics", `Orders and memberships dated in the selected range (IST). Points figures are for the range; liability is right now.`, bar,
    el("h3", { class: "sec" }, "Membership"),
    el("div", { class: "ca-tiles" }, tile("New paid memberships", num(m.new_in_range)), tile("Membership revenue", inr(m.revenue_paise), "Fees from active and expired terms"), tile("Renewal rate", rr, m.terms_ended ? `of ${num(m.terms_ended)} term${m.terms_ended === 1 ? "" : "s"} that ended` : "No paid terms ended in this period"),
      tile("Conversion (all time)", pct(m.conversion_rate), "Paying members ÷ customers who bought"), tile("Member order value", o.member_aov_paise == null ? "—" : inr(o.member_aov_paise), `average of ${num(o.member_orders)} order${o.member_orders === 1 ? "" : "s"}`), tile("Non-member order value", o.nonmember_aov_paise == null ? "—" : inr(o.nonmember_aov_paise), `average of ${num(o.nonmember_orders)} order${o.nonmember_orders === 1 ? "" : "s"}`)),
    el("h3", { class: "sec" }, "Points"),
    el("div", { class: "ca-tiles" }, tile("Issued", num(p.issued)), tile("Redeemed", num(p.redeemed)), tile("Expired", num(p.expired)), tile("Reversed", num(p.reversed)),
      tile("Owed to customers now", inr(p.outstanding_liability_paise), `${num(p.outstanding_points)} points, ${num(p.holders)} holders`), tile("Discounts / eligible sales", pct(e.discounts_pct_of_eligible_sales), "Member prices + points redeemed")),
    el("div", { class: "mb-chartwrap" }, pointsChart(p), table("mb-pt", ["Points", "Count"], [["Issued", num(p.issued)], ["Redeemed", num(p.redeemed)], ["Expired", num(p.expired)], ["Reversed", num(p.reversed)]])),
    el("p", { class: "hint" }, p.liability_note),
    el("h3", { class: "sec" }, "Economics"),
    el("div", { class: "note" }, el("b", {}, e.note)),
    el("div", { class: "ca-tiles" }, tile("Eligible net sales", inr(e.member_sales_eligible_paise)), tile("Member price savings", inr(e.member_price_savings_paise)), tile("Points discount", inr(e.points_discount_paise)),
      e.cost_data_complete ? tile("Product contribution", inr(e.product_contribution_paise), "Net sales − product cost, before shipping and fees") : tile("Product contribution", "—", "")),
    e.cost_data_complete ? "" : el("p", { class: "note warn" }, "Contribution is not shown because some products sold in this period have no cost price (or there were no eligible orders). Add cost prices on the Products page to see it.")));
}

window.membershipVisible = (on) => { if (on && !M.loaded) { M.loaded = true; loadAll(); } };
})();
