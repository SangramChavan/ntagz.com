// Rewards screen: spending tiers, product eligibility, cart milestones, customers (adjustments, refunds) and the change log.
// Shares $, el, api, inr, when (app.js) and toast, ask (products.js). Text is inserted with textContent only.
(() => {
const RW = { data: null, camps: null, loaded: false, busy: false, tiers: [], settings: {}, dirty: false, q: "", page: 1 };
const rupeesStr = (paise) => (paise / 100).toFixed(2).replace(/\.00$/, "");
const toPaise = (v) => { const n = Number(String(v).trim().replace(/,/g, "")); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const slug = (s) => (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "tier") + "-" + Math.random().toString(16).slice(2, 6);
const rewardText = (c) => (c.reward_type === "free_shipping" ? "free shipping" : `${c.reward_value}% off`);

async function loadRewards() {
  $("rewards").replaceChildren(el("p", { class: "sub" }, "Loading…"));
  try {
    const [d, c] = await Promise.all([api("/api/rewards"), api("/api/campaigns")]);
    RW.data = d; RW.camps = c; RW.settings = { ...d.settings }; RW.tiers = d.tiers.map((t) => ({ ...t })); RW.dirty = false;
    renderRewards();
  } catch (e) { $("rewards").replaceChildren(el("p", { class: "msg" }, "Could not load rewards: " + e.message, " ", el("button", { class: "btn small", type: "button", onclick: loadRewards }, "Retry"))); }
}

const card = (title, sub, ...kids) => el("section", { class: "pcard" }, el("div", { class: "pcard-head" }, el("h2", {}, title)), sub ? el("p", { class: "sub" }, sub) : "", ...kids);
const field = (label, input, hint) => el("div", { class: "field" }, el("label", {}, label, input), hint ? el("div", { class: "hint" }, hint) : "");

// ── settings + tiers ─────────────────────────────────────────────────
function settingsCard() {
  const live = el("button", { class: "switch", type: "button", role: "switch", "aria-checked": String(RW.settings.live) }, el("i", { class: "knob" }), el("span", {}, RW.settings.live ? "Rewards ON: tier discounts apply" : "Rewards OFF: spend is counted, no tier discounts"));
  live.onclick = () => { RW.settings.live = !RW.settings.live; RW.dirty = true; renderRewards(); };
  const combine = el("select", { "aria-label": "When a customer has both a tier and a paid membership" }, el("option", { value: "best_of" }, "Customer gets the better of the two (recommended)"), el("option", { value: "stack" }, "Both can combine (up to the combined limit)"));
  combine.value = RW.settings.combine; combine.onchange = () => { RW.settings.combine = combine.value; RW.dirty = true; };
  return card("Rewards settings", "Tier discounts are a percentage taken off eligible products at checkout. The combined-discount cap and minimum margin on the Pricing page still apply.",
    el("div", { class: "field" }, live), field("Tier and paid membership", combine, `Combined limit today: ${RW.settings.max_total_discount_pct}% (edit on the Pricing page).`));
}

function tiersCard() {
  const rows = RW.tiers.map((t, i) => {
    const name = el("input", { value: t.name, maxlength: "30", "aria-label": "Tier name" }), th = el("input", { value: rupeesStr(t.min_spend_paise), inputmode: "decimal", "aria-label": "Minimum qualifying spend in rupees" });
    const off = el("input", { value: String(t.discount_pct), inputmode: "decimal", "aria-label": "Discount percent" }), perks = el("input", { value: t.perks || "", maxlength: "300", "aria-label": "Description shown to customers" });
    const act = el("input", { type: "checkbox", "aria-label": "Active" }); act.checked = t.active;
    name.oninput = () => { t.name = name.value; RW.dirty = true; };
    th.oninput = () => { t.min_spend_paise = toPaise(th.value); RW.dirty = true; };
    off.oninput = () => { t.discount_pct = Number(off.value); RW.dirty = true; };
    perks.oninput = () => { t.perks = perks.value; RW.dirty = true; };
    act.onchange = () => { t.active = act.checked; RW.dirty = true; };
    return el("div", { class: "prow rw-row" },
      el("div", { class: "grow" }, field("Name", name)),
      el("div", { class: "rw-two" }, field("From spend (₹)", th), field("Discount %", off)),
      field("Shown to customers", perks),
      el("label", { class: "chk" }, act, " Active", t.min_spend_paise === 0 ? el("span", { class: "hint" }, "  (the base tier, must start at ₹0)") : ""));
  });
  const add = el("button", { class: "btn", type: "button", onclick: () => { const last = RW.tiers[RW.tiers.length - 1]; RW.tiers.push({ id: slug("tier"), name: "New tier", min_spend_paise: (last ? last.min_spend_paise : 0) + 100000, discount_pct: last ? Number(last.discount_pct) : 0, active: true, perks: "" }); RW.dirty = true; renderRewards(); } }, "Add a tier");
  const save = el("button", { class: "btn primary", type: "button", onclick: saveRewardsAll }, "Save rewards settings");
  return card("Tiers", "Qualifying spend is what a customer's paid orders are worth after discounts, without GST or shipping. Thresholds must rise and discounts must not fall. Tiers are never deleted: untick Active to retire one.",
    ...rows, el("div", { class: "actions" }, add, save), RW.dirty ? el("p", { class: "hint" }, "You have unsaved changes.") : "");
}

async function saveRewardsAll() {
  if (RW.busy) return;
  const tiers = RW.tiers.map((t) => ({ id: t.id, name: String(t.name || "").trim(), min_spend_paise: t.min_spend_paise, discount_pct: Number(t.discount_pct), active: t.active, perks: t.perks || "" }));
  const lines = [`${tiers.filter((t) => t.active).length} active tiers: ${tiers.filter((t) => t.active).map((t) => `${t.name} from ${inr(t.min_spend_paise)} at ${t.discount_pct}%`).join(", ")}.`,
    RW.settings.live ? "Rewards will be ON: customers with a tier discount get it on eligible products straight away." : "Rewards will be OFF: nobody gets a tier discount."];
  if (!(await ask("Save rewards settings?", lines, "Save"))) return;
  RW.busy = true;
  try { RW.data = await api("/api/rewards", { version: RW.data.version, tiers, settings: { live: RW.settings.live, combine: RW.settings.combine } }); toast("Rewards settings saved."); await loadRewards(); }
  catch (e) { toast(e.message, true); } finally { RW.busy = false; }
}

// ── product eligibility ──────────────────────────────────────────────
function eligibilityCard() {
  const rows = RW.data.products.map((p) => {
    const chk = el("input", { type: "checkbox", "aria-label": "Eligible for tier discounts: " + p.name }); chk.checked = p.loyalty_eligible;
    const cap = el("input", { value: p.loyalty_max_pct == null ? "" : String(p.loyalty_max_pct), inputmode: "decimal", placeholder: "no ceiling", "aria-label": "Highest tier discount for " + p.name });
    const save = async (patch) => { try { await api(`/api/products/${p.id}`, patch); toast(`${p.name} updated.`); } catch (e) { toast(e.message, true); loadRewards(); } };
    chk.onchange = () => save({ loyalty_eligible: chk.checked });
    cap.onchange = () => save({ loyalty_max_pct: cap.value.trim() === "" ? null : Number(cap.value) });
    return el("div", { class: "prow rw-elig" },
      el("div", {}, el("div", { class: "name" }, p.name), el("div", { class: "sub" }, `${p.sku} · ${inr(p.price_paise)}${p.cost_paise == null ? " · no cost price" : ""}`)),
      el("label", { class: "chk" }, chk, " Eligible"), cap);
  });
  return card("Product eligibility", "Untick Eligible to exclude a product from tier discounts, or set a ceiling (0 = excluded; blank = the tier's own %). Fixed-price kits never get tier discounts. Changes save immediately.", ...rows);
}

// ── cart milestones ──────────────────────────────────────────────────
function campaignCard() {
  const items = RW.camps.campaigns.map((c) => el("div", { class: "prow rw-camp" },
    el("div", { class: "name" }, c.name, " ", el("span", { class: "pill " + (c.active ? "paid" : "") }, c.active ? "Active" : "Off")),
    el("div", { class: "sub" }, `From ${inr(c.threshold_paise)} of product value · ${rewardText(c)} · ${c.audience === "all" ? "everyone" : c.audience === "signed_in" ? "signed-in customers" : "members"}${c.combinable ? " · combinable" : ""}`),
    el("div", { class: "sub" }, `${c.redemptions} redeemed${c.max_redemptions ? ` of ${c.max_redemptions}` : ""}${c.starts_at ? " · from " + when(c.starts_at) : ""}${c.ends_at ? " · until " + when(c.ends_at) : ""}`),
    ...c.warnings.map((w) => el("p", { class: "msg" }, w)),
    el("div", { class: "rowact" }, el("button", { class: "btn small", type: "button", onclick: () => campaignForm(c) }, "Edit"))));
  return card("Cart milestones", "Rewards a customer unlocks when their cart reaches a spend. Nothing is applied by itself: each milestone has an explicit reward, dates and limits. Suggested starting points are ₹500, ₹1,000 and ₹2,000.",
    ...(items.length ? items : [el("p", { class: "sub" }, "No milestones yet.")]),
    el("div", { class: "actions" }, el("button", { class: "btn primary", type: "button", onclick: () => campaignForm(null) }, "Add a milestone")));
}

function dateVal(ts, end) { return ts ? new Date((ts - (end ? 86399 : 0)) * 1000).toISOString().slice(0, 10) : ""; }
function campaignForm(c) {
  const f = {
    name: el("input", { value: c ? c.name : "", maxlength: "60" }), th: el("input", { value: c ? rupeesStr(c.threshold_paise) : "500", inputmode: "decimal" }),
    type: el("select", {}, el("option", { value: "free_shipping" }, "Free shipping"), el("option", { value: "percent_off" }, "Percentage off the cart")),
    val: el("input", { value: c && c.reward_type === "percent_off" ? String(c.reward_value) : "5", inputmode: "decimal" }),
    aud: el("select", {}, el("option", { value: "all" }, "Everyone"), el("option", { value: "signed_in" }, "Signed-in customers"), el("option", { value: "members" }, "Customers with a member benefit")),
    comb: el("input", { type: "checkbox" }), act: el("input", { type: "checkbox" }),
    from: el("input", { type: "date", value: c ? dateVal(c.starts_at, false) : "" }), to: el("input", { type: "date", value: c ? dateVal(c.ends_at, true) : "" }),
    max: el("input", { value: c && c.max_redemptions ? String(c.max_redemptions) : "", inputmode: "numeric", placeholder: "no limit" }), per: el("input", { value: c && c.per_customer_limit ? String(c.per_customer_limit) : "", inputmode: "numeric", placeholder: "no limit" }),
  };
  if (c) { f.type.value = c.reward_type; f.aud.value = c.audience; f.comb.checked = c.combinable; f.act.checked = c.active; }
  const preview = el("p", { class: "bp-sum" }), err = el("p", { class: "msg" });
  const upd = () => { const t = Number(f.th.value) || 0, sample = Math.max(Math.round(t * 0.1), 1); f.val.parentNode.parentNode.hidden = f.type.value !== "percent_off"; preview.textContent = `Customers will see: “Add ₹${sample} of eligible products to unlock ${f.type.value === "free_shipping" ? "free shipping" : (f.val.value || "0") + "% off"}.”`; };
  Object.values(f).forEach((x) => x.addEventListener("input", upd)); f.type.addEventListener("change", upd);
  const save = el("button", { class: "btn primary", type: "button" }, "Save milestone");
  save.onclick = async () => {
    err.textContent = ""; save.disabled = true;
    try {
      RW.camps = await api("/api/campaigns", { id: c ? c.id : undefined, confirm: true, name: f.name.value, threshold_rupees: f.th.value, reward_type: f.type.value, reward_value: f.type.value === "percent_off" ? Number(f.val.value) : 0, audience: f.aud.value,
        combinable: f.comb.checked, active: f.act.checked, starts: f.from.value || null, ends: f.to.value || null, max_redemptions: f.max.value.trim() || null, per_customer_limit: f.per.value.trim() || null });
      $("rdlg").close(); toast("Milestone saved."); renderRewards();
    } catch (e) { err.textContent = e.message; } finally { save.disabled = false; }
  };
  $("rdlg").replaceChildren(el("div", { class: "panel-head" }, el("h2", { class: "h0" }, c ? "Edit milestone" : "Add milestone"), el("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: () => $("rdlg").close() }, "✕")),
    el("div", { class: "form" },
      field("Name", f.name), field("Cart value that unlocks it (₹, without GST)", f.th), field("Reward", f.type), el("div", {}, field("Percent off (max 20)", f.val)),
      field("Who gets it", f.aud), el("label", { class: "chk" }, f.comb, " Can combine with member and quantity discounts (off by default)"),
      field("Starts", f.from), field("Ends", f.to), field("Total redemptions (optional)", f.max), field("Per customer (optional)", f.per),
      el("label", { class: "chk" }, f.act, " Active"), preview, err),
    el("div", { class: "panel-actions" }, save, el("button", { class: "btn", type: "button", onclick: () => $("rdlg").close() }, "Cancel")));
  upd(); $("rdlg").showModal();
}

// ── customers ────────────────────────────────────────────────────────
const CU = { rows: [], more: false };
async function searchCustomers() {
  const out = $("rwcust"); out.replaceChildren(el("p", { class: "sub" }, "Searching…"));
  try {
    const d = await api(`/api/customers?q=${encodeURIComponent(RW.q)}&page=${RW.page}`); CU.rows = d.customers; CU.more = d.more;
    out.replaceChildren(...(d.customers.length ? d.customers.map((c) => el("div", { class: "prow rw-cust" },
      el("div", {}, el("div", { class: "name" }, c.name || c.email), el("div", { class: "sub" }, `${c.email} · ${c.orders} order${c.orders === 1 ? "" : "s"}`)),
      el("div", { class: "rowact" }, el("span", { class: "pill" }, `${c.tier_name || "—"} · ${inr(c.spend_paise)}`), el("button", { class: "btn small", type: "button", onclick: () => customerPanel(c.id) }, "View")))) : [el("p", { class: "sub" }, "No customers found.")]),
      el("div", { class: "pager" }, el("button", { class: "btn", type: "button", disabled: RW.page <= 1, onclick: () => { RW.page--; searchCustomers(); } }, "Previous"), el("span", {}, `Page ${RW.page}`), el("button", { class: "btn", type: "button", disabled: !d.more, onclick: () => { RW.page++; searchCustomers(); } }, "Next")));
  } catch (e) { out.replaceChildren(el("p", { class: "msg" }, e.message)); }
}
function customersCard() {
  const q = el("input", { type: "search", value: RW.q, placeholder: "Search email, name or phone", "aria-label": "Search customers", autocomplete: "off" });
  const form = el("form", { class: "ofilters", role: "search", onsubmit: (e) => { e.preventDefault(); RW.q = q.value.trim(); RW.page = 1; searchCustomers(); } }, q, el("button", { class: "btn primary", type: "submit" }, "Search"));
  const wrap = card("Customers", "Standing, spending history, refunds and audited corrections. Spend is always recalculated from orders; a correction is a signed amount with a reason, never an overwrite.", form, el("div", { id: "rwcust" }));
  setTimeout(searchCustomers, 0); return wrap;
}

async function customerPanel(id) {
  let d; try { d = await api(`/api/customers/${id}`); } catch (e) { return toast(e.message, true); }
  const c = d.customer;
  const delta = el("input", { inputmode: "decimal", placeholder: "e.g. 500 or -200", "aria-label": "Adjustment in rupees" }), why = el("input", { maxlength: "200", placeholder: "Why is this correction needed?", "aria-label": "Reason" }), err = el("p", { class: "msg" });
  const key = crypto.randomUUID();
  const adj = el("button", { class: "btn", type: "button" }, "Record adjustment");
  adj.onclick = async () => {
    err.textContent = "";
    if (!(await ask("Record this adjustment?", [`${c.email}: ${delta.value || "0"} ₹ of qualifying spend.`, `Reason: ${why.value}`, "This is permanent and is recorded with your name."], "Record adjustment"))) return;
    adj.disabled = true;
    try { await api(`/api/customers/${id}/adjust`, { delta_rupees: delta.value.trim(), reason: why.value, idempotency_key: key, confirm: true }); toast("Adjustment recorded."); customerPanel(id); searchCustomers(); }
    catch (e) { err.textContent = e.message; adj.disabled = false; }
  };
  const orders = d.orders.map((o) => el("div", { class: "prow rw-camp" },
    el("div", { class: "name" }, `${when(o.created_at)} · ${o.txn_id.slice(0, 20)}`),
    el("div", { class: "sub" }, `${o.status} · ${o.payment_status} · paid ${inr(o.paid_paise)}${o.refunded_paise ? ` · refunded ${inr(o.refunded_paise)}` : ""} · ${o.counts ? `counts ${inr(o.effective_paise)}` : "does not count"}${o.discount_paise ? ` · member discount ${inr(o.discount_paise)}` : ""}`),
    o.payment_status === "paid" && o.paid_paise > o.refunded_paise ? el("div", { class: "rowact" }, el("button", { class: "btn small", type: "button", onclick: () => refundForm(o, id) }, "Record refund")) : ""));
  $("rdlg").replaceChildren(el("div", { class: "panel-head" }, el("h2", { class: "h0" }, c.name || c.email), el("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: () => $("rdlg").close() }, "✕")),
    el("div", { class: "form" },
      el("p", { class: "bp-sum" }, `${d.tier ? d.tier.name : "—"} tier · ${inr(d.spend_paise)} qualifying spend`),
      el("p", { class: "sub" }, d.next ? `${inr(d.remaining_paise)} to ${d.next.name}. ` : "Top tier. ", `Member discounts received: ${inr(d.savings_paise)}.`, c.email ? ` ${c.email}` : ""),
      el("h3", {}, "Orders"), ...(orders.length ? orders : [el("p", { class: "sub" }, "No orders.")]),
      el("h3", {}, "Tier history"), ...(d.tier_history.length ? d.tier_history.map((t) => el("p", { class: "sub" }, `${when(t.created_at)} · ${t.from_tier || "—"} → ${t.to_tier || "—"} at ${inr(t.spend_paise)} · ${t.reason}`)) : [el("p", { class: "sub" }, "No tier changes recorded yet.")]),
      el("h3", {}, "Adjustments"), ...(d.adjustments.length ? d.adjustments.map((a) => el("p", { class: "sub" }, `${when(a.created_at)} · ${a.delta_paise > 0 ? "+" : "−"}${inr(Math.abs(a.delta_paise))} (${inr(a.spend_before)} → ${inr(a.spend_after)}) · ${a.actor} · ${a.reason}`)) : [el("p", { class: "sub" }, "None.")]),
      el("h3", {}, "Correct qualifying spend"), field("Amount in ₹ (negative to reduce)", delta), field("Reason (required)", why), err, adj),
    el("div", { class: "panel-actions" }, el("button", { class: "btn", type: "button", onclick: () => $("rdlg").close() }, "Close")));
  if (!$("rdlg").open) $("rdlg").showModal();
}

function refundForm(o, cid) {
  const amt = el("input", { inputmode: "decimal", value: rupeesStr(o.paid_paise - o.refunded_paise), "aria-label": "Refund amount in rupees" }), why = el("input", { maxlength: "200", placeholder: "Reason", "aria-label": "Reason" }), err = el("p", { class: "msg" }), key = crypto.randomUUID();
  const go = el("button", { class: "btn primary", type: "button" }, "Record refund");
  go.onclick = async () => {
    err.textContent = "";
    if (!(await ask("Record this refund?", [`₹${amt.value} of order ${o.txn_id}.`, "This records a refund you have already made or will make outside this system, and reduces the customer's qualifying spend in proportion."], "Record refund", true))) return;
    go.disabled = true;
    try { await api(`/api/orders/${o.id}/refund`, { amount_rupees: amt.value.trim(), reason: why.value, idempotency_key: key, confirm: true }); toast("Refund recorded."); customerPanel(cid); searchCustomers(); }
    catch (e) { err.textContent = e.message; go.disabled = false; }
  };
  $("rdlg").replaceChildren(el("div", { class: "panel-head" }, el("h2", { class: "h0" }, "Record refund"), el("button", { class: "btn small", type: "button", "aria-label": "Back", onclick: () => customerPanel(cid) }, "✕")),
    el("div", { class: "form" }, el("p", { class: "sub" }, `Paid ${inr(o.paid_paise)}, already refunded ${inr(o.refunded_paise)}.`), field("Refund amount (₹)", amt), field("Reason (required)", why), err),
    el("div", { class: "panel-actions" }, go, el("button", { class: "btn", type: "button", onclick: () => customerPanel(cid) }, "Cancel")));
}

function historyCard() {
  const h = RW.data.history || [];
  const say = (e) => {
    const d = e.detail || {};
    if (e.action === "rewards_settings") return "Changed rewards settings or tiers" + (d.settings && d.settings.from && d.settings.to && d.settings.from.live !== d.settings.to.live ? ` (rewards turned ${d.settings.to.live ? "ON" : "OFF"})` : "");
    if (e.action === "rewards_adjust") return `Spend adjustment ${d.delta_paise > 0 ? "+" : "−"}${inr(Math.abs(d.delta_paise))} · ${d.reason}`;
    if (e.action === "order_refund") return `Refund ${inr(d.amount_paise)} · ${d.reason}`;
    if (e.action === "campaign_save") return `Milestone ${d.to && d.to.name ? "“" + d.to.name + "”" : ""} saved`;
    return e.action;
  };
  return card("Change log", "Every settings change, milestone edit, adjustment and refund, with who did it.", h.length ? el("ul", { class: "hlist" }, h.map((e) => el("li", {}, el("span", { class: "sub" }, `${when(e.created_at)} · ${e.actor}`), el("div", {}, say(e))))) : el("p", { class: "sub" }, "Nothing yet."));
}

function renderRewards() {
  $("rewards").replaceChildren(settingsCard(), tiersCard(), eligibilityCard(), campaignCard(), customersCard(), historyCard());
}
window.rewardsVisible = (on) => { if (on && !RW.loaded) { RW.loaded = true; loadRewards(); } };
})();
