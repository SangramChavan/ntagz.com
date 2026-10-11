// Pricing & Membership screen. Shares $, el, api, inr, when (app.js) and toast, ask (products.js).
// Every number shown here comes from the server, which prices with the same engine as checkout (functions/lib/pricing.js).
// Edits are a local DRAFT (kept in sessionStorage); the server previews the draft and only publish changes live prices.
const PR = { data: null, view: null, draft: { settings: {}, products: {} }, basket: [], state: "Maharashtra", loaded: false, busy: false };
const DKEY = "ntagz.admin.pricingDraft";
const r2paise = (rupees) => Math.round(rupees * 100);
const pctTxt = (n) => `${Number(n).toFixed(2).replace(/\.?0+$/, "")}%`;
const draftCount = () => Object.keys(PR.draft.settings).length + Object.keys(PR.draft.products).length;

function saveDraft() { try { sessionStorage.setItem(DKEY, JSON.stringify({ draft: PR.draft, basket: PR.basket, state: PR.state, version: PR.data && PR.data.version })); } catch { /* ignore */ } }
function restoreDraft(version) {
  try {
    const d = JSON.parse(sessionStorage.getItem(DKEY) || "null");
    if (!d) return;
    PR.basket = Array.isArray(d.basket) ? d.basket : []; PR.state = typeof d.state === "string" ? d.state : PR.state;
    if (d.version === version) PR.draft = d.draft; // a draft made against older live values is dropped, never silently re-applied
    else if (d.draft && (Object.keys(d.draft.settings || {}).length || Object.keys(d.draft.products || {}).length)) toast("Live pricing changed since your last draft, so the draft was discarded.", true);
  } catch { /* ignore */ }
}

async function loadPricing() {
  $("pricing").replaceChildren(el("p", { class: "sub" }, "Loading…"));
  try {
    PR.data = await api("/api/pricing");
    restoreDraft(PR.data.version);
    if (!PR.basket.length) PR.basket = defaultBasket();
    await previewDraft();
  } catch (e) { $("pricing").replaceChildren(el("p", { class: "msg" }, "Could not load pricing: " + e.message, " ", el("button", { class: "btn small", type: "button", onclick: loadPricing }, "Retry"))); }
}
function defaultBasket() {
  const ok = PR.data.products.filter((p) => p.sellable && p.active && !p.fixed && p.member_discount_pct > 0);
  return ok.slice(0, 2).map((p) => ({ id: p.id, qty: 500 }));
}

let pvTimer;
function schedulePreview() { clearTimeout(pvTimer); pvTimer = setTimeout(previewDraft, 300); }
async function previewDraft() {
  try {
    const items = PR.basket.filter((b) => b.id && b.qty > 0);
    PR.view = await api("/api/pricing/preview", { draft: PR.draft, items, state: PR.state });
    PR.view.error = null;
  } catch (e) {
    if (!PR.view) PR.view = { ...PR.data, basket: null };
    PR.view.error = e.message;
  }
  render();
}

function setSetting(key, value, live) {
  const cur = PR.data.settings;
  const same = key === "fee" ? r2paise(Number(value)) === cur.fee_paise : key === "live" ? value === cur.live : Number(value) === Number(cur[key]);
  if (same || value === "") delete PR.draft.settings[key]; else PR.draft.settings[key] = value;
  saveDraft(); live ? schedulePreview() : previewDraft();
}
function setPct(p, value) {
  const live = PR.data.products.find((x) => x.id === p.id);
  if (value === "" || Number(value) === Number(live.member_discount_pct)) delete PR.draft.products[p.id]; else PR.draft.products[p.id] = value;
  saveDraft(); schedulePreview();
}

// ── rendering ────────────────────────────────────────────────────────
function render() {
  const v = PR.view, s = v.settings, live = PR.data.settings;
  const n = draftCount();
  $("draftbar").hidden = !n; $("draftinfo").textContent = n ? `${n} unpublished change${n === 1 ? "" : "s"} · customers still see the live prices` : "";
  document.body.classList.toggle("has-draftbar", !!n);
  const errBox = v.error ? el("p", { class: "msg", role: "alert" }, v.error) : "";
  const blockers = (v.blockers || []).map((b) => el("div", { class: "note bad" }, b));
  // Re-rendering replaces the inputs; keep focus and caret on the field being typed in (matched by data-k).
  const a = document.activeElement, k = a && a.dataset && a.dataset.k, pos = a && typeof a.selectionStart === "number" ? a.selectionStart : null;
  $("pricing").replaceChildren(errBox, ...blockers, planCard(s, live, v), limitsCard(s, live, v), productsCard(v), previewCard(v), historyCard());
  const again = k && document.querySelector(`#pricing [data-k="${CSS.escape(k)}"]`);
  if (again) { again.focus(); if (pos !== null && typeof again.setSelectionRange === "function") try { again.setSelectionRange(pos, pos); } catch { /* not a text input */ } }
}

const changedMark = (on) => (on ? el("span", { class: "pill pre" }, "Draft") : "");
function numInput(id, value, opts = {}) {
  const i = el("input", { id, "data-k": id, class: "pin", value: String(value), inputmode: "decimal", autocomplete: "off", "aria-label": opts.label || id });
  i.addEventListener("input", () => opts.onInput(i.value.trim()));
  return i;
}

function planCard(s, live, v) {
  const d = PR.draft.settings, m = v.members || {}, e = v.economics || {};
  const sw = el("button", { class: "switch", type: "button", role: "switch", "aria-checked": String(s.live), id: "plive" }, el("i", { class: "knob" }), el("span", {}, s.live ? "Member pricing ON" : "Member pricing OFF"));
  sw.addEventListener("click", () => setSetting("live", !s.live));
  const fee = numInput("pfee", d.fee ?? (live.fee_paise / 100), { label: "Membership fee in rupees", onInput: (x) => setSetting("fee", x, true) });
  const dur = numInput("pdur", d.duration_days ?? live.duration_days, { label: "Membership length in days", onInput: (x) => setSetting("duration_days", x, true) });
  const be = e.break_even_spend_min_inr == null ? "No eligible products, so membership has no value yet."
    : e.break_even_spend_min_inr === e.break_even_spend_max_inr ? `A member must spend about ${inr(e.break_even_spend_min_inr * 100)} (before GST) a year on eligible products before the fee pays for itself.`
      : `A member must spend ${inr(e.break_even_spend_min_inr * 100)}–${inr(e.break_even_spend_max_inr * 100)} (before GST) a year on eligible products (${pctTxt(e.max_member_pct)}–${pctTxt(e.min_member_pct)} off) before the fee pays for itself.`;
  return el("section", { class: "pcard" },
    el("div", { class: "pcard-head" }, el("h2", {}, "Membership plan"), sw, changedMark(d.live !== undefined)),
    el("p", { class: "sub" }, s.live ? "Signed-in members with an unexpired membership get member prices at checkout. The membership can be bought." : "Nobody gets member prices and the membership cannot be bought."),
    el("div", { class: "pgrid" },
      el("label", { class: "field" }, el("span", {}, "Annual fee (₹, incl. GST) ", changedMark(d.fee !== undefined)), fee, el("span", { class: "hint" }, `You keep ${inr(Math.round((e.fee_ex_gst_inr || 0) * 100))} after GST. Changes apply to new purchases only.`)),
      el("label", { class: "field" }, el("span", {}, "Length (days) ", changedMark(d.duration_days !== undefined)), dur, el("span", { class: "hint" }, "One-time payment, no auto-renewal."))),
    el("div", { class: "note" }, el("b", {}, "Is it worth it for customers? "), be, " Customers buying less than this lose money on membership; the calculator on the membership page shows them the same numbers."),
    el("div", { class: "stats" }, ...[["Active members", m.active || 0], ["Expiring in 30 days", m.expiring || 0], ["Memberships sold", m.total || 0], ["Fees collected", inr(m.revenue_paise || 0)]].map(([l, x]) => el("span", {}, el("b", {}, String(x)), " " + l))));
}

function limitsCard(s, live, v) {
  const d = PR.draft.settings;
  const cap = numInput("pcap", d.max_total_discount_pct ?? live.max_total_discount_pct, { label: "Maximum combined discount percent", onInput: (x) => setSetting("max_total_discount_pct", x, true) });
  const mar = numInput("pmar", d.min_margin_pct ?? live.min_margin_pct, { label: "Minimum margin percent", onInput: (x) => setSetting("min_margin_pct", x, true) });
  return el("section", { class: "pcard" },
    el("div", { class: "pcard-head" }, el("h2", {}, "How discounts combine")),
    el("ol", { class: "rules" },
      el("li", {}, "Regular price (set in Products)."),
      el("li", {}, "Bulk discount for everyone: ", v.bulk_tiers.map((t) => `${t.min_pieces}+ pcs ${t.pct}%`).join(" · "), "."),
      el("li", {}, "Member discount on top, for active members only. Kits never get it."),
      el("li", {}, "Safety limits below only ever reduce the member part; guest prices never change. There are no coupons or other discounts to stack.")),
    el("div", { class: "pgrid" },
      el("label", { class: "field" }, el("span", {}, "Max combined discount (%) ", changedMark(d.max_total_discount_pct !== undefined)), cap, el("span", { class: "hint" }, "Bulk + member together never exceed this.")),
      el("label", { class: "field" }, el("span", {}, "Minimum margin (%) ", changedMark(d.min_margin_pct !== undefined)), mar, el("span", { class: "hint" }, "Member price stays at or above cost ÷ (1 − margin). Needs a cost price on the product."))),
    ...(v.warnings || []).map((w) => el("div", { class: "note warn" }, w)));
}

function productsCard(v) {
  const rows = v.products.filter((p) => p.sellable || p.member_discount_pct > 0);
  const all = el("input", { id: "pall", "data-k": "pall", class: "pin", inputmode: "decimal", placeholder: "e.g. 10", "aria-label": "Member discount for all eligible products" });
  const apply = el("button", { class: "btn small", type: "button", onclick: () => {
    const x = all.value.trim(); if (x === "" || !Number.isFinite(Number(x))) return toast("Enter a percentage", true);
    rows.filter((p) => p.sellable && !p.fixed && p.active).forEach((p) => { const lv = PR.data.products.find((q) => q.id === p.id); if (Number(x) === Number(lv.member_discount_pct)) delete PR.draft.products[p.id]; else PR.draft.products[p.id] = x; });
    saveDraft(); previewDraft();
  } }, "Set for all");
  const head = ["Product", "Regular", "Cost", "Member %", "Member price", "At 5,000+ pcs", "Notes"];
  const cells = (p) => {
    const lv = PR.data.products.find((q) => q.id === p.id), dv = PR.draft.products[p.id];
    const inp = el("input", { class: "inl pct", "data-k": "t:" + p.id, inputmode: "decimal", value: String(dv ?? lv.member_discount_pct), "aria-label": `Member discount percent for ${p.name}` });
    if (p.fixed || !p.sellable) inp.disabled = true;
    inp.addEventListener("input", () => setPct(p, inp.value.trim()));
    const t0 = p.tiers[0], t3 = p.tiers[p.tiers.length - 1];
    const cost = p.cost_paise == null ? el("span", { class: "sub" }, "—") : inr(p.cost_paise);
    // Builders, not nodes: the table and the phone list each need their own copy.
    const mp = () => (t0.memberPct > 0 ? el("span", {}, el("b", {}, inr(r2paise(t0.unitPrice))), el("span", { class: "sub" }, ` −${pctTxt(t0.memberPct)}`)) : el("span", { class: "sub" }, "No member price"));
    const deep = () => el("span", {}, inr(r2paise(t3.unitPrice)), el("span", { class: "sub" }, ` (${t3.bulkPct}% + ${pctTxt(t3.memberPct)})`));
    // Short tags per row; the full sentence is in the tooltip. Shared advice (e.g. add cost prices) is shown once above.
    const tag = (w) => /^No cost price/.test(w) ? ["No cost price", "warn"] : /cap/.test(w) ? ["Capped at " + w.split(" at ").pop().replace(/\.$/, ""), "warn"]
      : /margin/.test(w) ? ["Margin floor at " + w.split(" at ").pop().replace(/\.$/, ""), "warn"] : /below cost/.test(w) ? ["Price below cost", "bad"] : /^Fixed-price/.test(w) ? null : [w, "warn"];
    const notes = () => [!p.active ? ["Inactive", "off"] : null, p.fixed ? ["Kit: no member price", "off"] : null, ...p.warnings.map((w) => { const t = tag(w); return t && [...t, w]; })]
      .filter(Boolean).map(([t, cls, full]) => el("span", { class: "pill " + (cls === "warn" ? "low" : cls === "bad" ? "out" : "off"), title: full || t }, t));
    return { inp, cost, mp, deep, notes, draft: dv !== undefined, p };
  };
  const data = rows.map(cells);
  const table = el("table", { class: "ptable prtable" }, el("thead", {}, el("tr", {}, ...head.map((h) => el("th", {}, h)))),
    el("tbody", {}, data.map((c) => el("tr", { class: c.draft ? "drafted" : "" },
      el("td", {}, el("span", { class: "pname" }, c.p.name), el("div", { class: "sub mono" }, c.p.sku)), el("td", {}, inr(c.p.price_paise), c.p.all_inclusive ? el("div", { class: "sub" }, "all-inclusive") : ""),
      el("td", {}, c.cost), el("td", {}, el("span", { class: "inl-wrap" }, c.inp, el("span", {}, "%"))), el("td", {}, c.mp()), el("td", {}, c.deep()),
      el("td", { class: "notes" }, c.notes().length ? c.notes() : el("span", { class: "pill in" }, "OK"))))));
  const list = el("div", { class: "plist" }, data.map((c) => {
    const inp2 = c.inp.cloneNode(); inp2.value = c.inp.value; inp2.dataset.k = "l:" + c.p.id; inp2.addEventListener("input", () => setPct(c.p, inp2.value.trim()));
    return el("div", { class: "prow" + (c.draft ? " drafted" : "") },
      el("div", { class: "top" }, el("div", { class: "grow" }, el("b", {}, c.p.name), el("div", { class: "sub" }, `Regular ${inr(c.p.price_paise)}${c.p.cost_paise != null ? " · cost " + inr(c.p.cost_paise) : ""}`))),
      el("div", { class: "editrow" }, el("label", {}, "Member %", el("span", { class: "inl-wrap" }, inp2, el("span", {}, "%"))), el("label", {}, "Member price", c.mp()), el("label", {}, "At 5,000+", c.deep())),
      c.notes().length ? el("div", { class: "notes" }, c.notes()) : "");
  }));
  return el("section", { class: "pcard" },
    el("div", { class: "pcard-head" }, el("h2", {}, "Member prices"), el("span", { class: "inl-wrap" }, all, el("span", {}, "%"), apply)),
    el("p", { class: "sub" }, "A percentage off the regular price, so member prices follow any regular price change automatically. Regular prices and cost prices are edited in Products."),
    list, table);
}

function previewCard(v) {
  const eligible = PR.data.products.filter((p) => p.sellable && p.active);
  const rows = PR.basket.map((b, i) => {
    const sel = el("select", { "aria-label": "Product" }, el("option", { value: "" }, "Choose…"), ...eligible.map((p) => { const o = el("option", { value: p.id }, p.name); if (p.id === b.id) o.selected = true; return o; }));
    const qty = el("input", { class: "inl", "data-k": "bq:" + i, inputmode: "numeric", value: String(b.qty || ""), "aria-label": "Quantity" });
    sel.addEventListener("change", () => { b.id = sel.value; saveDraft(); previewDraft(); });
    qty.addEventListener("input", () => { b.qty = parseInt(qty.value, 10) || 0; saveDraft(); schedulePreview(); });
    return el("div", { class: "brow" }, sel, qty, el("button", { class: "btn small", type: "button", "aria-label": "Remove", onclick: () => { PR.basket.splice(i, 1); saveDraft(); previewDraft(); } }, "✕"));
  });
  const st = el("select", { "aria-label": "Delivery state" }, ...[["Maharashtra", "Maharashtra (₹40 shipping)"], ["Karnataka", "Other state (₹80 shipping)"], ["", "No state yet"]].map(([val, l]) => { const o = el("option", { value: val }, l); if (val === PR.state) o.selected = true; return o; }));
  st.addEventListener("change", () => { PR.state = st.value; saveDraft(); previewDraft(); });
  const b = v.basket;
  let result = el("p", { class: "sub" }, "Add products to see what each customer pays.");
  if (b) {
    const g = b.guest, m = b.member, fee = v.settings.fee_paise / 100;
    const line = (l, a, c) => el("div", { class: "qline" }, el("span", {}, l), el("b", {}, a), el("b", {}, c));
    const money = (x) => inr(r2paise(x));
    result = el("div", {},
      el("div", { class: "qline qhead" }, el("span", {}), el("b", {}, "Guest / customer"), el("b", {}, "Member")),
      line("Regular value", money(g.subtotal), money(m.subtotal)), line("Bulk discount", "−" + money(g.bulkDiscount), "−" + money(m.bulkDiscount)),
      line("Member discount", "—", "−" + money(m.memberDiscount)), line("GST (18%)", money(g.gst), money(m.gst)), line("Shipping", g.shipping ? money(g.shipping) : "Free", m.shipping ? money(m.shipping) : "Free"),
      line("Checkout total", money(g.amount), money(m.amount)),
      el("div", { class: "note" }, b.member_pricing_live ? `A member saves ${money(g.amount - m.amount)} on this basket. ${g.amount - m.amount >= fee ? "That alone covers the " + money(fee) + " fee." : `They need about ${Math.ceil(fee / Math.max(g.amount - m.amount, 0.01))} orders like this a year to cover the ${money(fee)} fee.`}` : "Member pricing is OFF in this draft, so members pay the same as everyone else."),
      m.lines.some((l) => l.limit) ? el("div", { class: "note warn" }, "Member discount limited by a safety limit on: " + m.lines.filter((l) => l.limit).map((l) => `${(PR.data.products.find((p) => p.id === l.id) || {}).name} (${l.limit === "cap" ? "combined cap" : "minimum margin"}, ${pctTxt(l.memberPct)} instead of ${pctTxt(l.requestedMemberPct)})`).join("; ")) : "",
      b.note ? el("div", { class: "note warn" }, b.note) : "");
  }
  return el("section", { class: "pcard" },
    el("div", { class: "pcard-head" }, el("h2", {}, "Price check"), changedMark(draftCount() > 0)),
    el("p", { class: "sub" }, draftCount() ? "Priced with your DRAFT settings by the checkout engine." : "Priced with the live settings by the checkout engine. Exactly what checkout would charge."),
    ...rows, el("div", { class: "brow" }, el("button", { class: "btn small", type: "button", onclick: () => { PR.basket.push({ id: "", qty: 10 }); render(); } }, "+ Add product"), st), result);
}

function historyCard() {
  const h = PR.data.history || [];
  const fmtPct = (x) => (x == null ? "—" : pctTxt(x));
  const names = Object.fromEntries(PR.data.products.map((p) => [p.id, p.name]));
  const SET = { fee_paise: ["Fee", (x) => inr(Number(x))], duration_days: ["Length", (x) => x + " days"], discounts_live: ["Member pricing", (x) => (x === "1" ? "ON" : "OFF")], max_total_discount_pct: ["Max combined", (x) => x + "%"], min_margin_pct: ["Min margin", (x) => x + "%"] };
  const describe = (e) => {
    if (e.action === "pricing_publish") return [
      ...Object.entries(e.detail.settings || {}).map(([k, c]) => `${(SET[k] || [k])[0]}: ${c.from == null ? "—" : (SET[k] ? SET[k][1](c.from) : c.from)} → ${SET[k] ? SET[k][1](c.to) : c.to}`),
      ...Object.entries(e.detail.products || {}).map(([id, c]) => `${names[id] || id} member: ${fmtPct(c.from)} → ${fmtPct(c.to)}`)].join(" · ");
    const pc = (e.detail.changed || {}).price_paise;
    if (pc) return `${names[e.detail.id] || e.detail.id} regular price: ${inr(pc.from)} → ${inr(pc.to)}`;
    return `${names[e.detail.id] || e.detail.id || "Product"} created`;
  };
  return el("section", { class: "pcard" }, el("div", { class: "pcard-head" }, el("h2", {}, "Recent price changes")),
    h.length ? el("ul", { class: "hlist" }, h.map((e) => el("li", {}, el("span", { class: "sub" }, `${when(e.created_at)} · ${e.actor}`), el("div", {}, describe(e))))) : el("p", { class: "sub" }, "No price changes recorded yet."));
}

// ── publish ──────────────────────────────────────────────────────────
async function publish() {
  if (PR.busy) return;
  await previewDraft();
  const v = PR.view;
  if (v.error) return toast(v.error, true);
  const ch = v.changes || { settings: {}, products: {} };
  const names = Object.fromEntries(PR.data.products.map((p) => [p.id, p.name]));
  const lines = [
    ...Object.entries(ch.settings).map(([k, c]) => `${k.replace(/_/g, " ")}: ${c.from ?? "—"} → ${c.to}`),
    ...Object.entries(ch.products).map(([id, c]) => `${names[id]}: member ${pctTxt(c.from)} → ${pctTxt(c.to)}`)];
  if (!lines.length) { PR.draft = { settings: {}, products: {} }; saveDraft(); return render(); }
  if (v.blockers.length) return ask("Cannot publish", v.blockers, "OK");
  const msg = [...lines, ...(v.warnings.length ? ["Warnings:", ...v.warnings] : []), "Takes effect at checkout within about a minute. Orders already placed keep their prices."];
  if (!(await ask(`Publish ${lines.length} change${lines.length === 1 ? "" : "s"}?`, msg, "Publish to live"))) return;
  PR.busy = true;
  try {
    PR.data = await api("/api/pricing/publish", { draft: PR.draft, version: PR.data.version, confirm: true });
    PR.draft = { settings: {}, products: {} }; saveDraft(); toast("Published. Live prices updated.");
    await previewDraft();
  } catch (e) { toast(e.message, true); }
  finally { PR.busy = false; }
}
function discard() { PR.draft = { settings: {}, products: {} }; saveDraft(); previewDraft(); }

async function membersDialog() {
  const d = $("sdlg"), body = el("div", {}, el("p", { class: "sub" }, "Loading…"));
  d.replaceChildren(el("div", { class: "panel-head" }, el("h2", { id: "sdtitle", class: "h0" }, "Members"), el("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: () => d.close() }, "✕")), body);
  d.showModal();
  try {
    const { memberships } = await api("/api/memberships");
    body.replaceChildren(memberships.length ? el("table", { class: "hist" }, el("thead", {}, el("tr", {}, ...["Customer", "Status", "Since", "Expires", "Paid", "Orders since"].map((h) => el("th", {}, h)))),
      el("tbody", {}, memberships.map((m) => el("tr", {}, el("td", {}, m.email || "—", m.name ? el("div", { class: "sub" }, m.name) : ""),
        el("td", {}, el("span", { class: "pill " + (m.active ? "paid" : "off") }, m.active ? "Active" : m.status === "active" ? "Expired" : m.status)),
        el("td", {}, new Date(m.purchased_at * 1000).toLocaleDateString("en-IN")), el("td", {}, new Date(m.expires_at * 1000).toLocaleDateString("en-IN")),
        el("td", {}, inr(m.price_paid || 0)), el("td", {}, String(m.orders_since)))))) : el("p", { class: "sub" }, "No memberships sold yet."));
  } catch (e) { body.replaceChildren(el("p", { class: "msg" }, e.message)); }
}

$("draftpublish").onclick = publish; $("draftdiscard").onclick = discard; $("mlistBtn").onclick = membersDialog;
window.pricingVisible = (on) => {
  if (!on) { $("draftbar").hidden = true; document.body.classList.remove("has-draftbar"); return; }
  if (!PR.loaded) { PR.loaded = true; loadPricing(); } else if (PR.view) render();
};
