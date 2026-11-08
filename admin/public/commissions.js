// Commissions screen: the approval queue, disputes, payables and payouts (Finance/HQ), and the commission terms (HQ only).
// Money is integer paise end to end; the server computes every amount. Shares $, el, when, toast, ask (app.js / products.js).
const CM = { status: "", q: "", tab: "queue", data: null };
const CM_CHIPS = [["", "All"], ["pending", "Needs approval"], ["disputed", "Disputed"], ["approved", "Approved"], ["payable", "Payable"], ["paid", "Paid"], ["reversed", "Reversed"]];
const CM_LABEL = { pending: ["Needs approval", "unpaid"], approved: ["Approved, in window", "st-placed"], payable: ["Payable", "paid"], paid: ["Paid", "paid"], reversed: ["Reversed", "cancelled"], disputed: ["Disputed", "unpaid"] };
const cmMoney = (p) => "₹" + (p / 100).toLocaleString("en-IN", { minimumFractionDigits: p % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
const cmDay = (ts) => new Date(ts * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const cmPill = (s) => el("span", { class: "pill " + CM_LABEL[s][1] }, CM_LABEL[s][0]);
const cmRoot = () => $("commissions-root");

async function cmCall(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" }, body: JSON.stringify(body) });
  if (r.status === 401) { location.reload(); throw new Error("signed out"); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) { const e = d.error || {}; throw new Error((e.message || "Request failed") + (e.fields ? ": " + Object.values(e.fields).join(", ") : "")); }
  return d.data;
}
// One small dialog for every input the screen needs (kdlg is the shared confirm dialog).
function cmForm(title, line, fields, okLabel, danger) {
  return new Promise((res) => {
    const dlg = $("kdlg"); let done = false; const err = el("div", { class: "err", role: "alert" });
    const inputs = fields.map((f, i) => { const id = "cmf" + i; const inp = f.multi ? el("textarea", { id, rows: "3", maxlength: "500" }) : el("input", { id, type: f.type || "text", maxlength: "120", autocomplete: "off", ...(f.step ? { step: f.step } : {}), ...(f.value !== undefined ? { value: String(f.value) } : {}) }); return [f, inp, id]; });
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); res(v); };
    const ok = () => { const out = {}; for (const [f, inp] of inputs) { const v = inp.value.trim(); if (f.required && !v) { err.textContent = `${f.label} is required.`; inp.focus(); return; } out[f.key] = v; } finish(out); };
    dlg.replaceChildren(el("h2", { id: "kdtitle", class: "h0" }, title), el("p", {}, line),
      ...inputs.map(([f, inp, id]) => el("div", { class: "field" }, el("label", { for: id }, f.label), inp)), err,
      el("div", { class: "actions" }, el("button", { class: "btn " + (danger ? "danger-solid" : "primary"), type: "button", onclick: ok }, okLabel), el("button", { class: "btn", type: "button", onclick: () => finish(null) }, "Cancel")));
    dlg.onclose = () => finish(null); dlg.showModal(); inputs[0][1].focus();
  });
}
const rupeesToPaise = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };

async function cmLoad() {
  try {
    if (CM.tab === "queue") { const p = new URLSearchParams(); if (CM.status) p.set("status", CM.status); if (CM.q) p.set("q", CM.q); CM.data = await cmCall("/api/v1/admin/commissions?" + p); }
    else if (CM.tab === "payouts") CM.data = { payables: await cmCall("/api/v1/admin/payables"), settlements: await cmCall("/api/v1/admin/settlements") };
    else CM.data = { rules: await cmCall("/api/v1/admin/commission-rules"), payables: await cmCall("/api/v1/admin/payables").catch(() => null) };
  } catch (e) { cmRoot().replaceChildren(cmTabs(), el("p", { class: "sub" }, "Could not load: " + e.message)); return; }
  cmRender();
}
function cmTabs() {
  return el("div", { class: "chips", role: "group", "aria-label": "Commission sections" }, [["queue", "Commissions"], ["payouts", "Payouts"], ["terms", "Terms"]].map(([k, l]) =>
    el("button", { class: "chip", type: "button", "aria-pressed": String(CM.tab === k), onclick: () => { CM.tab = k; cmLoad(); } }, l)));
}
function cmRender() {
  const head = el("div", { class: "pv-head" }, el("div", {}, el("h1", { class: "pv-title" }, "Commissions"), el("p", { class: "sub" }, "Partners earn only on customer orders from their own leads. Nothing is payable until the customer's payment has cleared and the refund window has passed. No commission is ever paid for recruiting partners.")));
  if (CM.tab === "queue") return cmQueue(head);
  if (CM.tab === "payouts") return cmPayouts(head);
  return cmTerms(head);
}
function cmQueue(head) {
  const d = CM.data; const total = Object.values(d.totals).reduce((a, b) => a + b.n, 0);
  const search = el("input", { id: "cmq", type: "search", placeholder: "Search Partner ID, partner or lead", "aria-label": "Search commissions", autocomplete: "off", value: CM.q });
  let t; search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { CM.q = search.value.trim(); cmLoad().then(() => { const s = $("cmq"); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }); }, 300); });
  const chips = el("div", { class: "chips", role: "group", "aria-label": "Commission status" }, CM_CHIPS.map(([k, l]) => el("button", { class: "chip", type: "button", "aria-pressed": String(CM.status === k), onclick: () => { CM.status = k; cmLoad(); } }, `${l} (${k ? d.totals[k].n : total})`)));
  const list = d.items.length ? d.items.map((x) => el("div", { class: "card pn-card" },
      el("div", { class: "pn-main" },
        el("div", {}, el("span", { class: "id" }, `${cmMoney(x.amountPaise)} · ${x.leadBusiness || "order " + x.orderRef}`), " ", cmPill(x.status)),
        el("div", { class: "sub" }, `${x.partnerCode} · ${x.partnerBusiness} · ${cmDay(x.createdAt)}${x.settlementNumber ? " · " + x.settlementNumber : ""}`)),
      el("button", { class: "btn small", type: "button", onclick: () => cmOpen(x.id) }, x.status === "pending" || x.status === "disputed" ? "Review" : "Open")))
    : [el("p", { class: "sub" }, CM.q || CM.status ? "Nothing matches this filter." : "No commissions yet. One is created when a lead is marked won with a paid order and an active rule applies.")];
  cmRoot().replaceChildren(head, cmTabs(), el("div", { class: "pn-bar" }, search), chips, el("div", { class: "pn-list", "aria-live": "polite" }, list));
}
function cmPayouts(head) {
  const { payables: p, settlements: s } = CM.data; const tds = p.settings.tdsRateBp;
  const rows = p.items.length ? p.items.map((x) => el("div", { class: "card pn-card" },
      el("div", { class: "pn-main" }, el("div", {}, el("span", { class: "id" }, `${x.partnerCode} · ${x.partnerBusiness}`)), el("div", { class: "sub" }, `${x.count} commission${x.count === 1 ? "" : "s"} · ${cmMoney(x.totalPaise)} payable${tds != null ? ` · TDS ${tds / 100}% withheld` : " · no TDS rate set"}`)),
      el("button", { class: "btn small primary", type: "button", onclick: () => cmSettle(x) }, "Record payout")))
    : [el("p", { class: "sub" }, "Nothing is payable right now.")];
  const hist = s.items.length ? s.items.map((x) => el("div", { class: "card pn-card" }, el("div", { class: "pn-main" },
      el("div", {}, el("span", { class: "id" }, `${x.number} · ${x.partnerCode}`)), el("div", { class: "sub" }, `${cmMoney(x.netPaise)} net of ${cmMoney(x.totalPaise)}${x.tdsPaise > 0 ? ` (TDS ${cmMoney(x.tdsPaise)})` : ""} · ${x.commissions} commission${x.commissions === 1 ? "" : "s"} · ref ${x.reference} · ${cmDay(x.at)} · ${x.recordedBy}`)))) : [el("p", { class: "sub" }, "No payouts recorded yet.")];
  cmRoot().replaceChildren(head, cmTabs(), el("h2", {}, "Payable now"), el("p", { class: "sub" }, "A payout covers every payable commission of the partner. Pay the money first (bank or UPI), then record it here with the bank reference. Ntagz does not move money from this screen."), el("div", { class: "pn-list" }, rows), el("h2", {}, "Recorded payouts"), el("div", { class: "pn-list" }, hist));
}
async function cmSettle(x) {
  const v = await cmForm("Record payout for " + x.partnerCode, `${x.count} commission${x.count === 1 ? "" : "s"}, ${cmMoney(x.totalPaise)} before any TDS. Record this only after the money has been sent.`,
    [{ key: "method", label: "Method (bank_transfer or upi)", required: true, value: "bank_transfer" }, { key: "reference", label: "Bank/UPI reference (unique)", required: true }], "Record payout");
  if (!v) return;
  try { const r = await cmCall("/api/v1/admin/settlements", { partnerId: x.partnerId, method: v.method, reference: v.reference }); toast(`Recorded ${r.settlement.number}: ${cmMoney(r.settlement.netPaise)} net`); await cmLoad(); } catch (e) { toast(e.message, true); }
}
function cmTerms(head) {
  const { rules, payables } = CM.data; const st = payables ? payables.settings : null;
  const rs = rules.rules.length ? rules.rules.map((r) => el("div", { class: "card pn-card" }, el("div", { class: "pn-main" },
      el("div", {}, el("span", { class: "id" }, r.name), " ", el("span", { class: "pill " + (r.active ? "paid" : "off") }, r.active ? "Active" : "Off")),
      el("div", { class: "sub" }, `${r.partnerType || "All partner types"} · ${r.pctBp ? r.pctBp / 100 + "%" : ""}${r.pctBp && r.fixedPaise ? " + " : ""}${r.fixedPaise ? cmMoney(r.fixedPaise) : ""} of order value before GST${r.minOrderPaise ? " · min " + cmMoney(r.minOrderPaise) : ""}${r.maxPaise ? " · max " + cmMoney(r.maxPaise) : ""} · hold ${r.holdDays == null ? "default" : r.holdDays + " days"} · refunds: ${r.refundPolicy === "reverse_all" ? "reverse fully" : "proportional"}`)),
      el("button", { class: "btn small", type: "button", onclick: async () => { try { await cmCall("/api/v1/admin/commission-rules/" + r.id, { active: !r.active }); await cmLoad(); } catch (e) { toast(e.message, true); } } }, r.active ? "Turn off" : "Turn on")))
    : [el("p", { class: "sub" }, "No rules yet, so no commission is created. Add one below.")];
  const setBtn = el("button", { class: "btn small", type: "button", onclick: async () => {
    const v = await cmForm("Commission settings", "The default hold is how many days after the order a commission waits before it can be paid (the refund window). TDS applies to future payouts only; leave it empty if none applies.",
      [{ key: "hold", label: "Default hold (days)", type: "number", required: true, value: st ? st.defaultHoldDays : 30 }, { key: "tds", label: "TDS rate % (leave empty for none)", type: "number", step: "0.01", value: st && st.tdsRateBp != null ? st.tdsRateBp / 100 : "" }], "Save settings");
    if (!v) return; try { await cmCall("/api/v1/admin/commission-settings", { defaultHoldDays: Number(v.hold), tdsRateBp: v.tds === "" ? null : Math.round(Number(v.tds) * 100) }); toast("Settings saved"); await cmLoad(); } catch (e) { toast(e.message, true); } } }, "Change settings");
  const add = el("button", { class: "btn small primary", type: "button", onclick: async () => {
    const v = await cmForm("New commission rule", "Pays on customer orders from a partner's own won leads. Leave a field empty to skip it. The most specific rule wins.",
      [{ key: "name", label: "Rule name", required: true }, { key: "partnerType", label: "Partner type (flex, smile, smile_plus, 360, enterprise; empty for all)" }, { key: "pct", label: "Percent of order value before GST", type: "number", step: "0.01" }, { key: "fixed", label: "Fixed rupees per order", type: "number", step: "0.01" },
        { key: "min", label: "Minimum order rupees", type: "number", step: "0.01" }, { key: "max", label: "Maximum commission rupees", type: "number", step: "0.01" }, { key: "hold", label: "Hold days (empty for default)", type: "number" }, { key: "policy", label: "On refund: proportional or reverse_all", value: "proportional" }], "Add rule");
    if (!v) return; const body = { name: v.name, refundPolicy: v.policy || "proportional" };
    if (v.partnerType) body.partnerType = v.partnerType; if (v.pct !== "") body.pctBp = Math.round(Number(v.pct) * 100); if (v.fixed !== "") body.fixedPaise = rupeesToPaise(v.fixed); if (v.min !== "") body.minOrderPaise = rupeesToPaise(v.min); if (v.max !== "") body.maxPaise = rupeesToPaise(v.max); if (v.hold !== "") body.holdDays = Number(v.hold);
    try { await cmCall("/api/v1/admin/commission-rules", body); toast("Rule added"); await cmLoad(); } catch (e) { toast(e.message, true); } } }, "Add a rule");
  cmRoot().replaceChildren(head, cmTabs(), el("p", { class: "sub" }, st ? `Default hold ${st.defaultHoldDays} days · TDS ${st.tdsRateBp != null ? st.tdsRateBp / 100 + "%" : "not set"}. Only HQ can change terms; Finance can view settings here.` : "Only HQ can see and change commission terms."), el("div", { class: "actions" }, add, setBtn), el("div", { class: "pn-list" }, rs));
}

async function cmOpen(id) {
  let d; try { d = await cmCall("/api/v1/admin/commissions/" + id); } catch (e) { return toast(e.message, true); }
  const x = d.commission; const dlg = $("cmpanel"); const o = x.order; const t = x.terms || {};
  const row = (k, v) => (v === undefined || v === null || v === "" ? null : el("div", {}, el("dt", {}, k), el("dd", {}, String(v))));
  const sec = (title, ...kids) => el("section", { class: "pn-sec" }, el("h3", {}, title), ...kids);
  const body = el("div", { class: "pn-body" }, el("div", {}, cmPill(x.status), " ", el("b", {}, x.partnerCode)),
    x.disputeReason ? el("p", { class: "sub" }, "Partner's dispute: " + x.disputeReason) : "", x.reversedReason ? el("p", { class: "sub" }, "Reversed: " + x.reversedReason) : "",
    sec("Commission", el("dl", { class: "pn-dl" }, [row("Amount", cmMoney(x.amountPaise)), row("Original amount", cmMoney(x.originalAmountPaise)), row("Partner", `${x.partnerCode} · ${x.partnerBusiness}`), row("Lead", x.leadBusiness),
      row("Rule", t.ruleName), row("Terms", [t.pctBp ? t.pctBp / 100 + "%" : "", t.fixedPaise ? cmMoney(t.fixedPaise) : "", t.maxPaise ? "max " + cmMoney(t.maxPaise) : ""].filter(Boolean).join(" + ")), row("Refund policy", t.refundPolicy), row("Payable after", x.holdUntil ? cmDay(x.holdUntil) : ""), row("Approved by", x.approvedBy), row("Settlement", x.settlementNumber)].filter(Boolean))),
    o ? sec("Order", el("dl", { class: "pn-dl" }, [row("Order", o.id), row("Payment", o.paymentStatus), row("Order value before GST", cmMoney(o.qualifyingPaise)), row("Paid", cmMoney(o.paidPaise)), row("Refunded", cmMoney(o.refundedPaise)), row("Ordered", cmDay(o.createdAt))].filter(Boolean))) : "",
    d.ledger.length ? sec("History", el("ul", { class: "pn-docs" }, d.ledger.map((l) => el("li", {}, el("span", {}, `${l.kind.replace(/_/g, " ")}${l.reason ? ": " + l.reason : ""} · ${l.by} · ${cmDay(l.at)}`), el("b", {}, l.deltaPaise ? (l.deltaPaise > 0 ? "+" : "−") + cmMoney(Math.abs(l.deltaPaise)) : ""))))) : "");
  dlg.replaceChildren(el("div", { class: "panel-head" }, el("h2", { id: "cmtitle", class: "h0" }, cmMoney(x.amountPaise) + " · " + x.partnerCode), el("button", { class: "btn small", type: "button", onclick: () => dlg.close() }, "Close")), body, el("div", { class: "panel-actions" }, cmActions(x)));
  if (!dlg.open) dlg.showModal();
}
function cmActions(x) {
  const btns = []; const post = async (path, body, done) => { await cmCall(`/api/v1/admin/commissions/${x.id}${path}`, body); toast(done); await cmOpen(x.id); await cmLoad(); };
  const act = (label, cls, fn) => btns.push(el("button", { class: "btn " + cls, type: "button", onclick: async (e) => { e.target.disabled = true; try { await fn(); } catch (err) { toast(err.message, true); } finally { e.target.disabled = false; } } }, label));
  if (x.status === "pending") act("Approve", "primary", async () => { if (await ask("Approve this commission?", [`${cmMoney(x.amountPaise)} for ${x.partnerCode}.`, "It becomes payable once the refund window has passed and the order stays paid."], "Approve")) await post("/approve", {}, "Approved"); });
  if (["pending", "approved", "payable"].includes(x.status)) act("Adjust amount", "", async () => { const v = await cmForm("Adjust commission", "Enter the change in rupees (negative to reduce). The reason is shown to the partner.", [{ key: "delta", label: "Change in rupees", type: "number", step: "0.01", required: true }, { key: "reason", label: "Reason", multi: true, required: true }], "Adjust"); if (v) await post("/adjust", { deltaPaise: rupeesToPaise(v.delta), reason: v.reason }, "Adjusted"); });
  if (["pending", "approved", "payable"].includes(x.status) || (x.status === "disputed" && x.priorStatus !== "paid")) act("Reverse", "danger", async () => { const v = await cmForm("Reverse this commission?", "It becomes zero and cannot be paid. The partner sees the reason.", [{ key: "reason", label: "Reason", multi: true, required: true }], "Reverse", true); if (v) await post("/reverse", { reason: v.reason }, "Reversed"); });
  if (x.status === "disputed") {
    act("Let it stand", "primary", async () => { const v = await cmForm("Let the commission stand?", "It goes back to where it was.", [{ key: "note", label: "Your decision (shown in the history)", multi: true, required: true }], "Let it stand"); if (v) await post("/resolve", { action: "restore", note: v.note }, "Dispute closed"); });
  }
  if (!btns.length) btns.push(el("span", { class: "sub" }, x.status === "paid" ? "Paid out. Raise any correction with Finance." : "No action needed."));
  return btns;
}
window.commissionsVisible = (on) => { if (on) { CM.tab = "queue"; cmLoad(); } };
