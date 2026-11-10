// Partners screen: the queue of partner applications and the onboarding of approved partners.
// Shares $, el, when, inr, toast, ask (app.js / products.js). All text goes in with textContent (applicant data is never parsed as HTML).
// The server decides what is allowed; the buttons shown here only mirror the state machine so HQ is not offered a move that will be refused.
const PN = { loaded: false, stage: "", q: "", data: null, open: null };
const PN_STAGES = [["", "All"], ["new", "New"], ["review", "In review"], ["docs", "Documents requested"], ["onboarding", "Onboarding"], ["active", "Active"], ["suspended", "Suspended"], ["rejected", "Rejected"]];
const PN_TYPE = { "360": "Ntagz360", enterprise: "Enterprise", flex: "Flex", smile: "Smile", smile_plus: "Smile+" };
const PN_DOC = { pan: "PAN card", address_proof: "Address proof", gst_certificate: "GST certificate", shop_photo: "Shop or office photo", bank_proof: "Bank proof", other: "Other" };
const PN_INVEST = { under_1l: "Under ₹1 lakh", "1l_to_3l": "₹1–3 lakh", "3l_to_5l": "₹3–5 lakh", "5l_to_10l": "₹5–10 lakh", over_10l: "Over ₹10 lakh" };
const PN_EVENT = {
  "partner.application.create": "Application started", "partner.application.submit": "Application submitted", "partner.document.upload": "Document uploaded", "partner.document.view": "Document opened by HQ",
  "partner.application.under_review": "Review started", "partner.application.documents_required": "More documents requested", "partner.application.rejected": "Application rejected", "partner.application.approved": "Application approved",
  "partner.create": "Partner ID issued", "partner.payment_pending": "Agreement recorded", "partner.fee.record": "Joining fee recorded", "partner.onboarding": "Moved to final checks", "partner.active": "Partner active", "partner.suspended": "Partner suspended",
};
const pnRoot = () => $("partners-root");
const pnMoney = (p) => "₹" + (p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });

async function pnCall(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" }, body: JSON.stringify(body) });
  if (r.status === 401) { location.reload(); throw new Error("signed out"); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) { const e = d.error || {}; const f = e.fields ? ": " + Object.values(e.fields).join(", ") : ""; throw new Error((e.message || "Request failed") + f); }
  return d.data;
}

// What the queue shows for one application, combining application status and partner status.
function pnLabel(a) {
  if (a.status === "approved" && a.partnerStatus) {
    return { agreement_pending: ["Agreement pending", "st-placed"], payment_pending: ["Fee pending", "unpaid"], onboarding: ["Final checks", "unpaid"], active: ["Active", "paid"], suspended: ["Suspended", "cancelled"], terminated: ["Terminated", "cancelled"] }[a.partnerStatus] || ["Approved", "paid"];
  }
  return { submitted: ["New", "unpaid"], under_review: ["In review", "st-placed"], documents_required: ["Documents requested", "unpaid"], rejected: ["Rejected", "cancelled"], approved: ["Approved", "paid"] }[a.status] || [a.status, "off"];
}
const pnPill = (a) => { const [t, c] = pnLabel(a); return el("span", { class: "pill " + c }, t); };

// ── list ─────────────────────────────────────────────────────────────
async function pnLoad() {
  const root = pnRoot();
  try {
    const p = new URLSearchParams(); if (PN.stage) p.set("stage", PN.stage); if (PN.q) p.set("q", PN.q);
    PN.data = await pnCall("/api/v1/admin/partner-applications?" + p);
  } catch (e) { root.replaceChildren(el("p", { class: "sub" }, "Could not load partners: " + e.message)); return; }
  pnRender();
}

function pnRender() {
  const root = pnRoot(); const d = PN.data;
  const search = el("input", { id: "pnq", type: "search", placeholder: "Search business, city, Partner ID or email", "aria-label": "Search partners", autocomplete: "off", value: PN.q });
  let t; search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { PN.q = search.value.trim(); pnLoad().then(() => { const s = $("pnq"); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }); }, 300); });
  const chips = el("div", { class: "chips", role: "group", "aria-label": "Partner queue" }, PN_STAGES.map(([k, l]) => {
    const n = k ? d.counts[k] : null;
    return el("button", { class: "chip", type: "button", "aria-pressed": String(PN.stage === k), onclick: () => { PN.stage = k; pnLoad(); } }, n === null ? l : `${l} (${n})`);
  }));
  const list = d.items.length
    ? d.items.map((a) => el("div", { class: "card pn-card" },
        el("div", { class: "pn-main" },
          el("div", {}, el("span", { class: "id" }, a.businessName || "Unnamed business"), " ", pnPill(a)),
          el("div", { class: "sub" }, [PN_TYPE[a.typeKey] || a.typeKey, [a.city, a.state].filter(Boolean).join(", "), a.partnerCode, a.email].filter(Boolean).join(" · ")),
          el("div", { class: "sub" }, a.submittedAt ? "Submitted " + when(a.submittedAt) : "")),
        el("button", { class: "btn small", type: "button", onclick: () => pnOpen(a.id) }, "Open")))
    : [el("p", { class: "sub" }, PN.q || PN.stage ? "No partners match this filter." : "No applications yet. They appear here when applicants submit from partner.ntagz.com.")];
  root.replaceChildren(
    el("div", { class: "pv-head" }, el("div", {}, el("h1", { class: "pv-title" }, "Partners"), el("p", { class: "sub" }, "Review applications, approve partners and follow their onboarding. Approving issues a Partner ID but gives no access until the agreement and joining fee are recorded and you activate the partner."))),
    el("div", { class: "pn-bar" }, search), chips, el("div", { class: "pn-list", "aria-live": "polite" }, list));
}

// ── detail panel ─────────────────────────────────────────────────────
async function pnOpen(id) {
  let d; try { d = await pnCall("/api/v1/admin/partner-applications/" + id); } catch (e) { return toast(e.message, true); }
  PN.open = id;
  const dlg = $("pnpanel");
  const f = d.form || {};
  const row = (k, v) => (v === undefined || v === null || v === "" ? null : el("div", {}, el("dt", {}, k), el("dd", {}, String(v))));
  const section = (title, ...kids) => el("section", { class: "pn-sec" }, el("h3", {}, title), ...kids);
  const body = el("div", { class: "pn-body" },
    el("div", {}, pnPill(d), " ", d.partnerCode ? el("b", {}, d.partnerCode) : ""),
    d.decisionNote ? el("p", { class: "sub" }, (d.status === "rejected" ? "Reason given: " : "Last note to applicant: ") + d.decisionNote) : "",
    section("Applicant", el("dl", { class: "pn-dl" }, [
      row("Name", f.name), row("Email", d.email), row("Mobile", f.phone), row("Category", PN_TYPE[d.typeKey] || d.typeKey), row("Business", d.businessName), row("Business type", f.business_type),
      row("Location", [d.city, d.state, d.pincode].filter(Boolean).join(", ")), row("PAN", d.panLast4 ? "ending " + d.panLast4 : ""), row("Can invest", PN_INVEST[f.investment_capacity] || f.investment_capacity),
      row("Helpers", f.staff_available), row("Vehicle", f.vehicle_available === undefined ? "" : f.vehicle_available ? "Yes" : "No"),
      row("Experience", f.experience), row("Shop or office", f.shop_details), row("Existing customers", f.customer_base), row("How they find customers", f.sales_marketing),
    ].filter(Boolean))),
    section("Documents", d.documents.length
      ? el("ul", { class: "pn-docs" }, d.documents.map((x) => el("li", {}, el("span", {}, `${PN_DOC[x.type] || x.type} · ${x.mime.replace("application/", "").replace("image/", "").toUpperCase()} · ${Math.max(1, Math.round(x.size / 1024))} KB`),
          el("a", { class: "btn small", href: "/api/v1/admin/partner-documents/" + x.id, target: "_blank", rel: "noopener" }, "View"))))
      : el("p", { class: "sub" }, "No documents uploaded."),
      el("p", { class: "sub" }, "Every time you open a document it is written to the audit log.")),
    d.partner ? pnOnboarding(d) : "",
    section("History", d.history.length
      ? el("ol", { class: "pn-hist" }, d.history.map((h) => el("li", {}, el("span", { class: "sub" }, when(h.at) + " · " + h.actor), el("span", {}, PN_EVENT[h.action] || h.action))))
      : el("p", { class: "sub" }, "No activity yet.")));
  dlg.replaceChildren(
    el("div", { class: "panel-head" }, el("h2", { id: "pntitle", class: "h0" }, d.businessName || "Application"), el("button", { class: "btn small", type: "button", onclick: () => dlg.close() }, "Close")),
    body, el("div", { class: "panel-actions", id: "pnactions" }, pnActions(d)));
  dlg.onclose = () => { PN.open = null; };
  if (!dlg.open) dlg.showModal();
}

function pnOnboarding(d) {
  const p = d.partner; const steps = [];
  steps.push(el("li", {}, el("b", {}, "Agreement: "), p.agreement ? (p.agreement.status === "signed" ? "signed " + when(p.agreement.signedAt) : "waiting for the signed agreement (version " + p.agreement.version + ")") : "not created"));
  steps.push(el("li", {}, el("b", {}, "Joining fee: "), p.feePayments.length ? p.feePayments.map((x) => pnFeeLine(d, x)) : "due " + pnMoney(p.feePaise) + " before tax"));
  if (p.status === "suspended" && p.suspendReason) steps.push(el("li", {}, el("b", {}, "Suspended: "), p.suspendReason));
  return el("section", { class: "pn-sec" }, el("h3", {}, "Onboarding"), el("ul", { class: "pn-steps" }, steps),
    p.status === "payment_pending" ? pnFeeForm(d) : "");
}

// One recorded fee payment. A refund is allowed only while onboarding or suspended; the server also refuses it if any stock credit was used or held.
function pnFeeLine(d, x) {
  const p = d.partner; const box = el("div", {}, `${pnMoney(x.amountPaise)} (${x.method.replace("_", " ")}, ref ${x.reference})`);
  if (x.refund) box.append(el("div", { class: "sub" }, `Refunded ${pnMoney(x.refund.amountPaise)} on ${when(x.refund.at)}: ${x.refund.reason}`));
  else if (["onboarding", "suspended"].includes(p.status)) box.append(el("button", { class: "btn small", type: "button", onclick: () => pnRefundFee(d, x) }, "Record refund"));
  return box;
}
async function pnRefundFee(d, x) {
  const why = await pnNote("Record refund of the joining fee?", `${pnMoney(x.amountPaise)} (ref ${x.reference}) paid back outside Ntagz. This reverses the stock credit from this payment. The partner cannot be activated or reinstated afterwards. It cannot be undone.`, "Reason (kept in the audit log)", "Record refund", true);
  if (!why) return;
  try { await pnCall(`/api/v1/admin/partners/${d.partner.id}/fee-refund`, { feePaymentId: x.id, reason: why }); toast("Refund recorded"); await pnRefresh(d.id); }
  catch (e) { toast(e.message, true); }
}

function pnFeeForm(d) {
  const p = d.partner;
  const amount = el("input", { id: "pnfee", inputmode: "decimal", value: String(p.feePaise / 100), "aria-describedby": "pnfeeh" });
  const gst = el("input", { id: "pngst", inputmode: "decimal", placeholder: "0" });
  const method = el("select", { id: "pnmethod" }, [["bank_transfer", "Bank transfer"], ["upi", "UPI"], ["razorpay", "Razorpay"], ["payu", "PayU"], ["cash", "Cash"], ["other", "Other"]].map(([v, l]) => el("option", { value: v }, l)));
  const ref = el("input", { id: "pnref", maxlength: "80", placeholder: "Bank, UPI or gateway reference", autocomplete: "off" });
  const msg = el("div", { class: "err", role: "alert" });
  const go = el("button", { class: "btn primary", type: "button" }, "Record fee payment");
  go.onclick = async () => {
    msg.textContent = "";
    const amountPaise = Math.round(parseFloat(amount.value) * 100), gstPaise = gst.value.trim() ? Math.round(parseFloat(gst.value) * 100) : 0;
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) { msg.textContent = "Enter the amount received in rupees."; return; }
    if (!Number.isFinite(gstPaise) || gstPaise < 0) { msg.textContent = "Enter the tax part in rupees, or leave it empty."; return; }
    if (ref.value.trim().length < 4) { msg.textContent = "Enter the payment reference."; return; }
    if (!(await ask("Record joining fee?", [`${pnMoney(amountPaise)} received by ${method.options[method.selectedIndex].text}, reference ${ref.value.trim()}.`, "This moves the partner to final checks. It cannot be undone."], "Record fee"))) return;
    go.disabled = true;
    try { await pnCall(`/api/v1/admin/partners/${p.id}/fee-payment`, { amountPaise, gstPaise, method: method.value, reference: ref.value.trim() }); toast("Fee recorded"); await pnRefresh(d.id); }
    catch (e) { msg.textContent = e.message; go.disabled = false; }
  };
  return el("div", { class: "pn-fee" },
    el("div", { class: "field" }, el("label", { for: "pnfee" }, "Amount received (₹, total including any tax)"), amount, el("p", { class: "sub", id: "pnfeeh" }, "Must be at least " + pnMoney(p.feePaise) + " (the joining fee before tax).")),
    el("div", { class: "field" }, el("label", { for: "pngst" }, "Of which tax (₹, optional)"), gst),
    el("div", { class: "field" }, el("label", { for: "pnmethod" }, "Method"), method),
    el("div", { class: "field" }, el("label", { for: "pnref" }, "Reference"), ref), msg, go);
}

// A note is required for anything the applicant or partner will be told, or that restricts access.
function pnNote(title, line, label, okLabel, danger) {
  return new Promise((res) => {
    const dlg = $("kdlg"); let done = false;
    const note = el("textarea", { id: "pnnote", rows: "4", maxlength: "1000", "aria-label": label });
    const err = el("div", { class: "err", role: "alert" });
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); res(v); };
    const ok = () => { if (note.value.trim().length < 3) { err.textContent = "Write at least a few words."; return; } finish(note.value.trim()); };
    dlg.replaceChildren(el("h2", { id: "kdtitle", class: "h0" }, title), el("p", {}, line),
      el("div", { class: "field" }, el("label", { for: "pnnote" }, label), note, err),
      el("div", { class: "actions" }, el("button", { class: "btn " + (danger ? "danger-solid" : "primary"), type: "button", onclick: ok }, okLabel), el("button", { class: "btn", type: "button", onclick: () => finish(null) }, "Cancel")));
    dlg.onclose = () => finish(null); dlg.showModal(); note.focus();
  });
}

function pnActions(d) {
  const btns = []; const p = d.partner;
  const act = (label, cls, fn) => btns.push(el("button", { class: "btn " + cls, type: "button", onclick: async (e) => { e.target.disabled = true; try { await fn(); } catch (err) { toast(err.message, true); } finally { e.target.disabled = false; } } }, label));
  const post = async (path, body, done) => { await pnCall(path, body); toast(done); await pnRefresh(d.id); };
  const A = "/api/v1/admin/partner-applications/" + d.id, P = p ? "/api/v1/admin/partners/" + p.id : "";
  if (d.status === "submitted") act("Start review", "primary", () => post(A + "/start-review", {}, "Review started"));
  if (d.status === "under_review") {
    act("Approve", "primary", async () => { if (await ask("Approve " + (d.businessName || "this application") + "?", ["This issues a Partner ID and creates the agreement record.", "The partner gets no access yet. Access opens only after the agreement and joining fee are recorded and you activate them."], "Approve")) await post(A + "/approve", {}, "Approved. Partner ID issued"); });
    act("Request documents", "", async () => { const n = await pnNote("Ask the applicant for more", "They will see this message on their status page and can update and resubmit.", "What do you need from them?", "Send request"); if (n) await post(A + "/request-documents", { note: n }, "Request sent"); });
    act("Reject", "danger", async () => { const n = await pnNote("Reject this application?", "The applicant will see this reason. They can apply again later.", "Reason for rejection", "Reject application", true); if (n) await post(A + "/reject", { note: n }, "Application rejected"); });
  }
  if (p && p.status === "agreement_pending") act("Record agreement signed", "primary", async () => { if (await ask("Record the signed agreement?", ["Only confirm if you hold the signed agreement for " + (d.businessName || "this partner") + "."], "Agreement is signed")) await post(P + "/agreement-signed", {}, "Agreement recorded"); });
  if (p && p.status === "onboarding") act("Activate partner", "primary", async () => { if (await ask("Activate " + (d.businessName || "this partner") + "?", ["The agreement and joining fee are on record. Activating opens their partner dashboard now."], "Activate")) await post(P + "/activate", {}, "Partner is active"); });
  if (p && p.status === "active") act("Suspend", "danger", async () => { const n = await pnNote("Suspend this partner?", "They are signed out immediately and lose partner access. You can reinstate them later.", "Reason (kept in the audit log)", "Suspend partner", true); if (n) await post(P + "/suspend", { reason: n }, "Partner suspended"); });
  if (p && p.status === "suspended") act("Reinstate", "primary", async () => { if (await ask("Reinstate this partner?", ["They can sign in and use partner access again."], "Reinstate")) await post(P + "/reinstate", {}, "Partner reinstated"); });
  if (!btns.length) btns.push(el("span", { class: "sub" }, d.status === "documents_required" ? "Waiting for the applicant to respond." : p && p.status === "payment_pending" ? "Record the joining fee above to continue." : "No action needed."));
  return btns;
}

async function pnRefresh(id) { await pnOpen(id); await pnLoad(); }

window.partnersVisible = (on) => { if (on) { PN.loaded = true; pnLoad(); } };
