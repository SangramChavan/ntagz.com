// Quotes screen: quotations partners submit for approval. HQ approves or rejects (with a reason) and can record the customer's answer.
// Prices are frozen by the server from the checkout engine; nothing here can change a price. Shares $, el, when, toast, ask (app.js / products.js).
const QT = { status: "", q: "", data: null };
const QT_CHIPS = [["", "All"], ["pending_approval", "Needs approval"], ["approved", "Approved"], ["sent", "Sent"], ["accepted", "Accepted"], ["rejected", "Rejected"], ["declined", "Declined"], ["expired", "Expired"], ["cancelled", "Cancelled"]];
const QT_LABEL = { pending_approval: ["Needs approval", "unpaid"], approved: ["Approved", "paid"], rejected: ["Rejected", "cancelled"], sent: ["Sent to customer", "st-placed"], accepted: ["Accepted", "paid"], declined: ["Declined", "cancelled"], expired: ["Expired", "off"], cancelled: ["Cancelled", "off"], draft: ["Draft", "off"] };
const qtMoney = (p) => "₹" + (p / 100).toLocaleString("en-IN", { minimumFractionDigits: p % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
const qtDay = (ts) => new Date(ts * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const qtPill = (s) => el("span", { class: "pill " + QT_LABEL[s][1] }, QT_LABEL[s][0]);
const qtRoot = () => $("quotes-root");

async function qtCall(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" }, body: JSON.stringify(body) });
  if (r.status === 401) { location.reload(); throw new Error("signed out"); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) { const e = d.error || {}; throw new Error((e.message || "Request failed") + (e.fields ? ": " + Object.values(e.fields).join(", ") : "")); }
  return d.data;
}

async function qtLoad() {
  try { const p = new URLSearchParams(); if (QT.status) p.set("status", QT.status); if (QT.q) p.set("q", QT.q); QT.data = await qtCall("/api/v1/admin/quotes?" + p); }
  catch (e) { qtRoot().replaceChildren(el("p", { class: "sub" }, "Could not load quotations: " + e.message)); return; }
  qtRender();
}

function qtRender() {
  const d = QT.data; const total = Object.values(d.counts).reduce((a, b) => a + b, 0);
  const search = el("input", { id: "qtq", type: "search", placeholder: "Search quotation number, lead, partner or Partner ID", "aria-label": "Search quotations", autocomplete: "off", value: QT.q });
  let t; search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { QT.q = search.value.trim(); qtLoad().then(() => { const s = $("qtq"); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }); }, 300); });
  const chips = el("div", { class: "chips", role: "group", "aria-label": "Quotation status" }, QT_CHIPS.map(([k, l]) =>
    el("button", { class: "chip", type: "button", "aria-pressed": String(QT.status === k), onclick: () => { QT.status = k; qtLoad(); } }, `${l} (${k ? d.counts[k] : total})`)));
  const list = d.items.length
    ? d.items.map((x) => el("div", { class: "card pn-card" },
        el("div", { class: "pn-main" },
          el("div", {}, el("span", { class: "id" }, `${x.number} · ${x.leadBusiness || x.customerName}`), " ", qtPill(x.status)),
          el("div", { class: "sub" }, `${qtMoney(x.totalPaise)} · ${x.pieces.toLocaleString("en-IN")} pcs · valid until ${qtDay(x.validUntil)}`),
          el("div", { class: "sub" }, `${x.partnerCode} · ${x.partnerBusiness} · updated ${when(x.updatedAt)}`)),
        el("button", { class: "btn small", type: "button", onclick: () => qtOpen(x.id) }, x.status === "pending_approval" ? "Review" : "Open")))
    : [el("p", { class: "sub" }, QT.q || QT.status ? "No quotations match this filter." : "No quotations yet. They appear here when partners submit them for approval.")];
  qtRoot().replaceChildren(
    el("div", { class: "pv-head" }, el("div", {}, el("h1", { class: "pv-title" }, "Quotes"), el("p", { class: "sub" }, "Quotations partners submit for approval. Prices are frozen from the same engine checkout uses, so approving cannot change a price. Drafts stay private to the partner."))),
    el("div", { class: "pn-bar" }, search), chips, el("div", { class: "pn-list", "aria-live": "polite" }, list));
}

async function qtOpen(id) {
  let d; try { d = await qtCall("/api/v1/admin/quotes/" + id); } catch (e) { return toast(e.message, true); }
  const x = d.quote; const dlg = $("qtpanel");
  const row = (k, v) => (v === undefined || v === null || v === "" ? null : el("div", {}, el("dt", {}, k), el("dd", {}, String(v))));
  const sec = (title, ...kids) => el("section", { class: "pn-sec" }, el("h3", {}, title), ...kids);
  const body = el("div", { class: "pn-body" },
    el("div", {}, qtPill(x.status), " ", el("b", {}, x.partnerCode)),
    x.decisionNote ? el("p", { class: "sub" }, "Reason given: " + x.decisionNote) : "",
    sec("Quotation", el("dl", { class: "pn-dl" }, [
      row("Number", x.number), row("Lead", x.leadBusiness), row("Customer", `${x.customerName} · ${x.customerPhone}${x.customerEmail ? " · " + x.customerEmail : ""}`), row("Partner", `${x.partnerCode} · ${x.partnerBusiness}`),
      row("Delivering to", x.shipState || "not set (shipping not included)"), row("Valid until", qtDay(x.validUntil)), row("Partner's notes", x.notes), row("Approved by", x.approvedBy),
    ].filter(Boolean))),
    sec("Lines", el("ul", { class: "pn-docs" }, x.items.map((i) => el("li", {}, el("span", {}, `${i.qty.toLocaleString("en-IN")} × ${i.name}${i.bulkPct > 0 ? ` (${i.bulkPct}% qty discount)` : ""}`), el("b", {}, qtMoney(i.lineNetPaise))))),
      el("dl", { class: "pn-dl" }, [row("List price", qtMoney(x.subtotalPaise)), x.discountPaise > 0 ? row("Quantity discount", "−" + qtMoney(x.discountPaise)) : null, row("GST", qtMoney(x.gstPaise)), row("Shipping", x.shipState ? (x.shippingPaise > 0 ? qtMoney(x.shippingPaise) : "Free") : "Extra"), row("Total", qtMoney(x.totalPaise))].filter(Boolean))),
    x.status === "accepted" ? sec("Payment", ...qtPay(x)) : "");
  dlg.replaceChildren(
    el("div", { class: "panel-head" }, el("h2", { id: "qttitle", class: "h0" }, x.number), el("button", { class: "btn small", type: "button", onclick: () => dlg.close() }, "Close")),
    body, el("div", { class: "panel-actions", id: "qtactions" }, qtActions(x)));
  if (!dlg.open) dlg.showModal();
}

// Accepted quotation -> payment link (the existing pay-links tool) -> paid order -> lead won. The payments Worker prices and collects; nothing here sets a price.
const qtHours = () => (typeof PL_HOURS !== "undefined" ? PL_HOURS : [[24, "24 hours"], [72, "3 days"], [168, "7 days"]]);
function qtPay(x) {
  const pl = x.payLink; const kids = [];
  if (pl && pl.status === "paid") {
    kids.push(el("p", { class: "sub" }, `Paid. Order ${pl.paidOrderId.slice(0, 8)} · ${qtMoney(pl.paidTotalPaise)}. The lead is not won until you confirm it here.`));
    const go = el("button", { class: "btn small primary", type: "button" }, "Mark lead won with this order");
    go.onclick = async () => {
      if (!(await ask("Mark the lead won?", [`${x.leadBusiness} will be won with order ${pl.paidOrderId.slice(0, 8)} (${qtMoney(pl.paidTotalPaise)}). The partner sees it as won. This cannot be undone.`], "Mark won"))) return;
      go.disabled = true; try { await qtCall(`/api/v1/admin/leads/${x.leadId}/status`, { status: "won", orderId: pl.paidOrderId }); toast("Lead marked won"); await qtOpen(x.id); } catch (e) { toast(e.message, true); go.disabled = false; }
    };
    kids.push(go); return kids;
  }
  if (pl && !["cancelled", "expired"].includes(pl.status)) {
    const state = { new: "Created, not sent yet", sent: "Sent, waiting for the customer", opened: "The customer opened it" }[pl.status] || pl.status;
    const url = el("input", { id: "qturl", readonly: "readonly", value: pl.url, "aria-label": "Payment link" });
    kids.push(el("p", { class: "sub" }, `${state}. Valid until ${qtDay(pl.expiresAt)}. The customer's page shows the exact amount and tells them if prices changed since the quotation.`), el("div", { class: "field" }, el("label", { for: "qturl" }, "Payment link"), url));
    const copy = el("button", { class: "btn small", type: "button" }, "Copy link"); copy.onclick = async () => { try { await navigator.clipboard.writeText(pl.url); toast("Link copied"); } catch { toast("Copy failed. Select the link and copy it by hand.", true); } };
    kids.push(copy);
    if (typeof waHref === "function") { const first = String(x.customerName || "").trim().split(/\s+/)[0] || "there"; const href = waHref(x.customerPhone, `Hi ${first}, here is your payment link for Ntagz quotation ${x.number}: ${pl.url}\nThe link is valid until ${qtDay(pl.expiresAt)}.`); if (href) kids.push(el("a", { class: "btn small", href, target: "_blank", rel: "noopener" }, "Open WhatsApp")); }
    kids.push(el("p", { class: "sub" }, "To cancel or extend this link, use Pay links."), el("a", { class: "btn small", href: "#/paylinks" }, "Open Pay links"));
    return kids;
  }
  if (pl) kids.push(el("p", { class: "sub" }, `The previous payment link ${pl.status === "cancelled" ? "was cancelled" : "expired"}. Make a new one.`));
  kids.push(el("p", { class: "sub" }, "The customer accepted. Make a payment link for them. Enter the delivery address; the lines and customer details come from the quotation."));
  const address = el("textarea", { id: "qtaddr", rows: "3", maxlength: "500", "aria-label": "Delivery address" });
  const pin = el("input", { id: "qtpin", inputmode: "numeric", maxlength: "6", "aria-label": "Pincode" });
  const st = el("select", { id: "qtstate", "aria-label": "Delivery state" }, [el("option", { value: "" }, "Choose…"), ...(typeof PL_STATES !== "undefined" ? PL_STATES : []).map((s) => el("option", { value: s, ...(s === x.shipState ? { selected: "selected" } : {}) }, s))]);
  const hrs = el("select", { id: "qthrs", "aria-label": "Link valid for" }, qtHours().map(([h, l]) => el("option", { value: String(h), ...(h === 72 ? { selected: "selected" } : {}) }, l)));
  const msg = el("div", { class: "err", role: "alert" });
  const go = el("button", { class: "btn primary", type: "button" }, "Create payment link");
  go.onclick = async () => {
    msg.textContent = ""; go.disabled = true;
    try {
      const r = await qtCall(`/api/v1/admin/quotes/${x.id}/payment-link`, { address: address.value, pincode: pin.value, state: st.value, expiresInHours: Number(hrs.value) });
      toast(r.priceMoved ? `Link created. Prices changed since the quotation: ${qtMoney(r.quotedPaise)} quoted, ${qtMoney(r.currentPaise)} now.` : "Payment link created", r.priceMoved); await qtOpen(x.id);
    } catch (e) { msg.textContent = e.message; go.disabled = false; }
  };
  kids.push(el("div", { class: "pn-fee" },
    el("div", { class: "field" }, el("label", { for: "qtaddr" }, "Delivery address"), address), el("div", { class: "field" }, el("label", { for: "qtpin" }, "Pincode"), pin),
    el("div", { class: "field" }, el("label", { for: "qtstate" }, "State"), st), el("div", { class: "field" }, el("label", { for: "qthrs" }, "Link valid for"), hrs), msg, go));
  return kids;
}

function qtAskNote(title, line, label, okLabel) {
  return new Promise((res) => {
    const dlg = $("kdlg"); let done = false;
    const inp = el("textarea", { id: "qtask", rows: "3", maxlength: "500", "aria-label": label }); const err = el("div", { class: "err", role: "alert" });
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); res(v); };
    const ok = () => { if (inp.value.trim().length < 3) { err.textContent = "Write at least a few words."; return; } finish(inp.value.trim()); };
    dlg.replaceChildren(el("h2", { id: "kdtitle", class: "h0" }, title), el("p", {}, line), el("div", { class: "field" }, el("label", { for: "qtask" }, label), inp, err),
      el("div", { class: "actions" }, el("button", { class: "btn danger-solid", type: "button", onclick: ok }, okLabel), el("button", { class: "btn", type: "button", onclick: () => finish(null) }, "Cancel")));
    dlg.onclose = () => finish(null); dlg.showModal(); inp.focus();
  });
}

function qtActions(x) {
  const btns = [];
  const act = (label, cls, fn) => btns.push(el("button", { class: "btn " + cls, type: "button", onclick: async (e) => { e.target.disabled = true; try { await fn(); } catch (err) { toast(err.message, true); } finally { e.target.disabled = false; } } }, label));
  const post = async (path, body, done) => { await qtCall(`/api/v1/admin/quotes/${x.id}${path}`, body); toast(done); await qtOpen(x.id); await qtLoad(); };
  if (x.status === "pending_approval") {
    act("Approve", "primary", async () => { if (await ask("Approve " + x.number + "?", [`${qtMoney(x.totalPaise)} for ${x.leadBusiness}, valid until ${qtDay(x.validUntil)}.`, "The partner is emailed and the lead moves to 'quotation'. The partner can then send it to the customer."], "Approve")) await post("/approve", {}, "Quotation approved"); });
    act("Reject", "danger", async () => { const n = await qtAskNote("Reject " + x.number + "?", "The partner sees this reason and can revise and resubmit.", "What should change?", "Reject quotation"); if (n) await post("/reject", { note: n }, "Quotation rejected"); });
  }
  if (["approved", "sent"].includes(x.status)) {
    act("Customer accepted", "primary", async () => { if (await ask("Record acceptance?", [`The customer accepted ${x.number} (${qtMoney(x.totalPaise)}). This cannot be undone.`], "Customer accepted")) await post("/response", { outcome: "accepted" }, "Recorded as accepted"); });
    act("Customer declined", "", async () => { if (await ask("Record decline?", [`The customer declined ${x.number}.`], "Customer declined", true)) await post("/response", { outcome: "declined" }, "Recorded as declined"); });
  }
  if (!btns.length) btns.push(el("span", { class: "sub" }, "No action needed."));
  return btns;
}
window.quotesVisible = (on) => { if (on) qtLoad(); };
