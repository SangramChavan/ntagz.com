// Leads screen: every lead partners have registered, who owns it, and what HQ can do (move it on, add a note, reassign, mark won with its order, mark lost).
// Shares $, el, when, toast, ask (app.js / products.js). All text goes in with textContent. The server decides what is allowed.
const LD = { stage: "", q: "", data: null, partners: null };
const LD_CHIPS = [["", "All"], ["new", "New"], ["contacted", "Contacted"], ["qualified", "Qualified"], ["quotation", "Quotation"], ["won", "Won"], ["lost", "Lost"]];
const LD_LABEL = { new: ["New", "unpaid"], contacted: ["Contacted", "st-placed"], qualified: ["Qualified", "st-placed"], quotation: ["Quotation", "st-placed"], won: ["Won", "paid"], lost: ["Lost", "cancelled"] };
const LD_EVENT = { created: "Registered", note: "Note", call: "Call", visit: "Visit", status: "Status", assign: "Reassigned" };
const ldRoot = () => $("leads-root");
const ldPill = (s) => el("span", { class: "pill " + LD_LABEL[s][1] }, LD_LABEL[s][0]);

async function ldCall(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" }, body: JSON.stringify(body) });
  if (r.status === 401) { location.reload(); throw new Error("signed out"); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) { const e = d.error || {}; throw new Error((e.message || "Request failed") + (e.fields ? ": " + Object.values(e.fields).join(", ") : "")); }
  return d.data;
}

async function ldLoad() {
  try {
    const p = new URLSearchParams(); if (LD.stage) p.set("status", LD.stage); if (LD.q) p.set("q", LD.q);
    LD.data = await ldCall("/api/v1/admin/leads?" + p);
  } catch (e) { ldRoot().replaceChildren(el("p", { class: "sub" }, "Could not load leads: " + e.message)); return; }
  ldRender();
}

function ldRender() {
  const d = LD.data; const total = Object.values(d.counts).reduce((a, b) => a + b, 0);
  const search = el("input", { id: "ldq", type: "search", placeholder: "Search business, contact, phone or Partner ID", "aria-label": "Search leads", autocomplete: "off", value: LD.q });
  let t; search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { LD.q = search.value.trim(); ldLoad().then(() => { const s = $("ldq"); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }); }, 300); });
  const chips = el("div", { class: "chips", role: "group", "aria-label": "Lead status" }, LD_CHIPS.map(([k, l]) =>
    el("button", { class: "chip", type: "button", "aria-pressed": String(LD.stage === k), onclick: () => { LD.stage = k; ldLoad(); } }, `${l} (${k ? d.counts[k] : total})`)));
  const list = d.items.length
    ? d.items.map((l) => el("div", { class: "card pn-card" },
        el("div", { class: "pn-main" },
          el("div", {}, el("span", { class: "id" }, l.businessName), " ", ldPill(l.status)),
          el("div", { class: "sub" }, [l.contactName, l.phone, l.city].filter(Boolean).join(" · ") + (l.estQuantity ? ` · ${l.estQuantity.toLocaleString("en-IN")} pcs` : "")),
          el("div", { class: "sub" }, `${l.partnerCode} · ${l.partnerBusiness} · updated ${when(l.updatedAt)}`)),
        el("button", { class: "btn small", type: "button", onclick: () => ldOpen(l.id) }, "Open")))
    : [el("p", { class: "sub" }, LD.q || LD.stage ? "No leads match this filter." : "No leads yet. They appear here when partners register them in the partner portal.")];
  ldRoot().replaceChildren(
    el("div", { class: "pv-head" }, el("div", {}, el("h1", { class: "pv-title" }, "Leads"), el("p", { class: "sub" }, "Prospects registered by partners. One open lead per phone number across the whole network. Only you can mark a lead won, and it needs the order it produced."))),
    el("div", { class: "pn-bar" }, search), chips, el("div", { class: "pn-list", "aria-live": "polite" }, list));
}

async function ldOpen(id) {
  let d; try { d = await ldCall("/api/v1/admin/leads/" + id); } catch (e) { return toast(e.message, true); }
  if (!LD.partners) { try { LD.partners = await ldCall("/api/v1/admin/active-partners"); } catch { LD.partners = []; } }
  const l = d.lead; const dlg = $("ldpanel");
  const row = (k, v) => (v === undefined || v === null || v === "" ? null : el("div", {}, el("dt", {}, k), el("dd", {}, String(v))));
  const sec = (title, ...kids) => el("section", { class: "pn-sec" }, el("h3", {}, title), ...kids);
  const open = ["new", "contacted", "qualified", "quotation"].includes(l.status);
  const body = el("div", { class: "pn-body" },
    el("div", {}, ldPill(l.status), " ", el("b", {}, l.partnerCode)),
    sec("Lead", el("dl", { class: "pn-dl" }, [
      row("Business", l.businessName), row("Contact", l.contactName), row("Mobile", l.phone), row("Email", l.email), row("Location", [l.city, l.state, l.pincode].filter(Boolean).join(", ")),
      row("Needs", l.interest), row("Quantity", l.estQuantity ? l.estQuantity.toLocaleString("en-IN") + " pcs" : ""), row("Partner's notes", l.notes), row("Owner", `${l.partnerCode} · ${l.partnerBusiness}`),
      row("Registered", when(l.createdAt)), row("Why lost", l.lostReason), row("Order", l.orderId),
    ].filter(Boolean))),
    d.conflicts.length ? sec("Ownership conflicts", el("p", { class: "sub" }, `${d.conflicts.length} time${d.conflicts.length > 1 ? "s" : ""} another partner tried to register this number (most recent ${when(d.conflicts[0].at)}). They were refused and not told who owns it.`)) : "",
    open ? sec("Reassign", ldReassign(l)) : "",
    open ? sec("Add a note", ldNoteForm(l)) : "",
    sec("History", d.activities.length ? el("ol", { class: "pn-hist" }, d.activities.map((a) => el("li", {}, el("span", { class: "sub" }, `${when(a.at)} · ${a.by}`), el("span", {}, `${LD_EVENT[a.kind] || a.kind}${a.body ? ": " + a.body : ""}`)))) : el("p", { class: "sub" }, "No activity yet.")));
  dlg.replaceChildren(
    el("div", { class: "panel-head" }, el("h2", { id: "ldtitle", class: "h0" }, l.businessName), el("button", { class: "btn small", type: "button", onclick: () => dlg.close() }, "Close")),
    body, el("div", { class: "panel-actions", id: "ldactions" }, ldActions(l)));
  if (!dlg.open) dlg.showModal();
}

function ldReassign(l) {
  const sel = el("select", { id: "ldto", "aria-label": "Reassign to" }, [el("option", { value: "" }, "Choose a partner…"), ...(LD.partners || []).filter((p) => p.id !== l.partnerId).map((p) => el("option", { value: p.id }, `${p.partnerCode} · ${p.businessName}`))]);
  const err = el("div", { class: "err", role: "alert" });
  const go = el("button", { class: "btn small", type: "button" }, "Reassign");
  go.onclick = async () => {
    err.textContent = ""; if (!sel.value) { err.textContent = "Choose a partner."; return; }
    const name = sel.options[sel.selectedIndex].text;
    if (!(await ask("Reassign this lead?", [`${l.businessName} will move to ${name}. The current partner loses access to it immediately.`], "Reassign"))) return;
    go.disabled = true; try { await ldCall(`/api/v1/admin/leads/${l.id}/assign`, { partnerId: sel.value }); toast("Lead reassigned"); await ldRefresh(l.id); } catch (e) { err.textContent = e.message; go.disabled = false; }
  };
  return el("div", { class: "pn-fee" }, el("div", { class: "field" }, el("label", { for: "ldto" }, "Move this lead to another active partner"), sel), err, go);
}

function ldNoteForm(l) {
  const note = el("textarea", { id: "ldnote", rows: "3", maxlength: "1000", "aria-label": "Note" }); const err = el("div", { class: "err", role: "alert" });
  const go = el("button", { class: "btn small", type: "button" }, "Save note");
  go.onclick = async () => {
    err.textContent = ""; if (!note.value.trim()) { err.textContent = "Write something first."; return; }
    go.disabled = true; try { await ldCall(`/api/v1/admin/leads/${l.id}/note`, { body: note.value.trim() }); toast("Note saved"); await ldRefresh(l.id); } catch (e) { err.textContent = e.message; go.disabled = false; }
  };
  return el("div", { class: "pn-fee" }, note, err, go);
}

// One small dialog for the two moves that need extra input.
function ldAskText(title, line, label, okLabel, danger, minLen) {
  return new Promise((res) => {
    const dlg = $("kdlg"); let done = false;
    const inp = el("textarea", { id: "ldask", rows: "3", maxlength: "500", "aria-label": label }); const err = el("div", { class: "err", role: "alert" });
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); res(v); };
    const ok = () => { if (inp.value.trim().length < minLen) { err.textContent = minLen > 5 ? "Enter the full order ID." : "Write at least a few words."; return; } finish(inp.value.trim()); };
    dlg.replaceChildren(el("h2", { id: "kdtitle", class: "h0" }, title), el("p", {}, line), el("div", { class: "field" }, el("label", { for: "ldask" }, label), inp, err),
      el("div", { class: "actions" }, el("button", { class: "btn " + (danger ? "danger-solid" : "primary"), type: "button", onclick: ok }, okLabel), el("button", { class: "btn", type: "button", onclick: () => finish(null) }, "Cancel")));
    dlg.onclose = () => finish(null); dlg.showModal(); inp.focus();
  });
}

function ldActions(l) {
  const btns = [];
  const act = (label, cls, fn) => btns.push(el("button", { class: "btn " + cls, type: "button", onclick: async (e) => { e.target.disabled = true; try { await fn(); } catch (err) { toast(err.message, true); } finally { e.target.disabled = false; } } }, label));
  const move = async (status, extra, done) => { await ldCall(`/api/v1/admin/leads/${l.id}/status`, { status, ...extra }); toast(done); await ldRefresh(l.id); };
  if (["new", "contacted"].includes(l.status)) act("Mark qualified", "primary", () => move("qualified", {}, "Marked qualified"));
  if (l.status === "new") act("Mark contacted", "", () => move("contacted", {}, "Marked contacted"));
  if (["new", "contacted", "qualified"].includes(l.status)) act("Quotation in progress", "", () => move("quotation", {}, "Moved to quotation"));
  if (["new", "contacted", "qualified", "quotation"].includes(l.status)) {
    act("Mark won", "primary", async () => { const o = await ldAskText("Mark this lead won", "Enter the order this lead produced. Each order can be credited to one lead only.", "Order ID", "Mark won", false, 6); if (o) await move("won", { orderId: o }, "Lead marked won"); });
    act("Mark lost", "danger", async () => { const r = await ldAskText("Mark this lead lost", "The partner will see the reason.", "Why was it lost?", "Mark lost", true, 3); if (r) await move("lost", { reason: r }, "Lead marked lost"); });
  }
  if (!btns.length) btns.push(el("span", { class: "sub" }, "This lead is closed."));
  return btns;
}

async function ldRefresh(id) { await ldOpen(id); await ldLoad(); }
window.leadsVisible = (on) => { if (on) ldLoad(); };
