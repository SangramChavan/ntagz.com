// Orders screen: chips, search, list, side panel with timeline, status actions, shipment form, AWB corrections, payment recording.
// Shares $, el, api, inr, when with app.js. All text is inserted with textContent.
const O = { page: 1, pages: 1, view: "", sort: "created_at", dir: "desc", loaded: false };
const VIEW_CHIPS = [["", "All"], ["new", "New"], ["paid", "Paid"], ["payment_pending", "Payment pending"], ["processing", "Processing"], ["packed", "Packed"], ["shipped", "Shipped"], ["out_for_delivery", "Out for delivery"], ["delivered", "Delivered"], ["preorders", "Pre-orders"], ["awaiting_stock", "Awaiting stock"], ["cancelled", "Cancelled"]];
const STATUS_TXT = { placed: "Order placed", confirmed: "Confirmed", processing: "Processing", packed: "Packed", shipped: "Shipped", out_for_delivery: "Out for delivery", delivered: "Delivered", on_hold: "On hold", cancelled: "Cancelled", delivery_failed: "Delivery failed", returned: "Returned", preorder_confirmed: "Pre-order confirmed", awaiting_stock: "Awaiting stock", ready_to_pack: "Ready to pack" };
const COURIERS = ["Delhivery", "Blue Dart", "DTDC", "India Post", "Ekart Logistics", "Trackon", "Xpressbees", "Shiprocket", "Ecom Express"];
const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const dayText = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
const OKEY = "ntagz.admin.ofilters";
// What the customer ordered, e.g. "10 × NTAG 215 Coin 25mm, 50 × Black NFC Card" (long carts are cut with a count).
const itemsText = (o) => { const a = (o.items || []).map((i) => `${i.qty ?? 1} × ${i.name || i.id || "Item"}`); return a.length > 3 ? a.slice(0, 3).join(", ") + ` +${a.length - 3} more` : a.join(", ") || "—"; };

// WhatsApp follow-up link for an order. Indian mobiles (10 digits, or with a leading 0 / 91) get +91; anything that is not a plausible
// number stays plain text. The message is only pre-filled: the admin reads and sends it themselves. Opens in a new tab.
function waHref(phone, text) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "0") d = d.slice(1);
  if (d.length === 10) d = "91" + d;
  return /^\d{11,15}$/.test(d) ? "https://wa.me/" + d + (text ? "?text=" + encodeURIComponent(text) : "") : null;
}
const waText = (o) => `Hi ${(o.name || "").trim().split(/\s+/)[0] || "there"}, this is ntagz about your order ${orderRef(o)}.`;
function phoneLink(o) {
  const href = waHref(o.phone, waText(o));
  if (!href) return o.phone || "";
  const stop = (e) => e.stopPropagation(); // the table row opens the order; the number must not
  return el("a", { class: "wa", href, target: "_blank", rel: "noopener noreferrer", title: "Follow up on WhatsApp", "aria-label": "Follow up on WhatsApp: " + o.phone, onclick: stop, onkeydown: stop }, o.phone);
}

const payPill = (o) => el("span", { class: "pill " + o.payment_status }, o.payment_status === "paid" ? "Paid" : "Unpaid");
const fulPill = (o) => el("span", { class: "pill st-" + o.status }, STATUS_TXT[o.status] || o.status);
const methodTxt = (o) => (o.payment_method || "—").toUpperCase();
const orderMoney = (o, minor) => (window.intlMoney ? window.intlMoney(o, minor) : inr(minor)); // USD orders are cents, INR orders paise
const orderRef = (o) => o.id.slice(0, 8);
const dispatchLine = (o) => (o.is_preorder && o.expected_dispatch ? el("div", { class: "sub" }, "Dispatch: " + dayText(o.expected_dispatch)) : "");
const priPill = (o) => (o.priority_build ? el("span", { class: "pill pri" }, "Priority") : "");
const buildLine = (o) => (o.processing_target_days == null ? "" : el("div", { class: "sub" }, `Built in ~${o.processing_target_days} working day${o.processing_target_days === 1 ? "" : "s"}` + (o.promised_dispatch ? " · promised " + dayText(o.promised_dispatch) : "")));
const buildSection = (o) => (o.processing_target_days == null ? [] : [el("h3", { class: "sec" }, "Made to order"),
  el("dl", {}, ...row("Working days", `~${o.processing_target_days}`), ...row("Promised dispatch", dayText(o.promised_dispatch)), ...row("Priority build", o.priority_build ? "Yes (member)" : "No"))]);

function oparams() {
  const p = new URLSearchParams();
  if (O.view) p.set("view", O.view);
  for (const id of ["q", "payment_method", "market", "country", "quote_status", "dispatch", "from", "to"]) if ($(id).value) p.set(id, $(id).value);
  p.set("page", O.page); p.set("sort", O.sort); p.set("dir", O.dir);
  return p;
}
function persistO() { try { sessionStorage.setItem(OKEY, JSON.stringify({ view: O.view, q: $("q").value, payment_method: $("payment_method").value, market: $("market").value, country: $("country").value, quote_status: $("quote_status").value, dispatch: $("dispatch").value, from: $("from").value, to: $("to").value })); } catch { /* ignore */ } }
function restoreO() { try { const f = JSON.parse(sessionStorage.getItem(OKEY) || "{}"); O.view = f.view || ""; for (const id of ["q", "payment_method", "market", "country", "quote_status", "dispatch", "from", "to"]) if (f[id]) $(id).value = f[id]; } catch { /* ignore */ } }

function drawChips() {
  $("ochips").replaceChildren(...VIEW_CHIPS.map(([v, l]) => el("button", { class: "chip", type: "button", "aria-pressed": String(O.view === v), onclick: () => { O.view = v; O.page = 1; persistO(); drawChips(); load(); } }, l)));
}

async function load() {
  $("list").replaceChildren(el("p", { class: "sub" }, "Loading…")); $("rows").replaceChildren();
  try {
    const d = await api("/api/orders?" + oparams());
    O.pages = d.pages; O.page = d.page;
    $("pageInfo").textContent = `Page ${d.page} of ${d.pages} · ${d.total} orders`;
    $("prev").disabled = d.page <= 1; $("next").disabled = d.page >= d.pages;
    $("csv").href = "/api/orders.csv?" + oparams();
    if (!d.orders.length) { const e = el("div", { class: "empty" }, el("p", {}, O.view || $("q").value ? "No orders match this view or search." : "No orders yet."), O.view || $("q").value ? el("button", { class: "btn", type: "button", onclick: clearO }, "Clear filters") : ""); $("list").replaceChildren(e); $("rows").replaceChildren(el("tr", {}, el("td", { colspan: "9" }, e.cloneNode(true)))); return; }
    $("list").replaceChildren(...d.orders.map((o) => el("button", { class: "card ocard", type: "button", onclick: () => openOrder(o.id) },
      el("div", { class: "row" }, el("span", { class: "id" }, o.name || "Guest"), el("b", {}, orderMoney(o, o.total))),
      el("div", { class: "sub" }, `${orderRef(o)} · ${when(o.created_at)}`),
      el("div", { class: "oitems" }, itemsText(o)),
      el("div", {}, payPill(o), fulPill(o), priPill(o), o.is_preorder ? el("span", { class: "pill pre" }, "Pre-order") : "", window.intlPills ? window.intlPills(o) : ""),
      dispatchLine(o),
      buildLine(o),
      o.tracking_id ? el("div", { class: "sub" }, `${o.courier || ""} · ${o.tracking_id}`) : "")));
    $("rows").replaceChildren(...d.orders.map((o) => el("tr", { tabindex: "0", onclick: () => openOrder(o.id), onkeydown: (e) => { if (e.key === "Enter") openOrder(o.id); } },
      el("td", { class: "mono" }, orderRef(o)), el("td", {}, when(o.created_at)), el("td", {}, o.name || "Guest", el("div", { class: "sub" }, phoneLink(o))),
      el("td", { class: "oitems" }, itemsText(o)),
      el("td", {}, payPill(o), el("div", { class: "sub" }, methodTxt(o))), el("td", {}, fulPill(o), priPill(o), window.intlPills ? window.intlPills(o) : "", o.is_preorder ? el("span", { class: "pill pre" }, "Pre-order") : "", dispatchLine(o), buildLine(o)),
      el("td", {}, orderMoney(o, o.total)), el("td", {}, o.courier || "—"), el("td", { class: "mono" }, o.tracking_id || "—"))));
  } catch (e) {
    $("list").replaceChildren(el("p", { class: "msg" }, "Could not load orders: " + e.message, " ", el("button", { class: "btn small", type: "button", onclick: load }, "Retry")));
  }
}
function clearO() { O.view = ""; for (const id of ["q", "payment_method", "market", "country", "quote_status", "dispatch", "from", "to"]) $(id).value = ""; O.page = 1; persistO(); drawChips(); load(); }

// ── generic action dialog ────────────────────────────────────────────
function actionDialog(title, bodyNodes, okLabel, { danger, onSubmit }) {
  const d = $("adlg"), msg = el("div", { class: "msg", role: "alert" });
  const go = el("button", { class: "btn " + (danger ? "danger-solid" : "primary"), type: "submit" }, okLabel);
  const form = el("form", { class: "form", novalidate: "" }, ...bodyNodes, msg, el("div", { class: "actions" }, go, el("button", { class: "btn", type: "button", onclick: () => d.close() }, "Cancel")));
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); if (go.disabled) return; msg.textContent = ""; go.disabled = true; go.textContent = "Saving…";
    try { await onSubmit(msg); } catch (err) { msg.textContent = err.message; go.disabled = false; go.textContent = okLabel; }
  });
  d.replaceChildren(el("h2", { id: "adtitle", class: "h0" }, title), form); if (!d.open) d.showModal();
  const first = form.querySelector("input,textarea,select"); if (first) first.focus();
}
const labeled = (id, label, input, hint) => el("div", { class: "field", id: "f-" + id }, el("label", { for: id }, label), input, hint ? el("div", { class: "hint" }, hint) : "", el("div", { class: "err", id: "e-" + id, role: "alert" }));
function fieldErrors(fields) { document.querySelectorAll("#adlg .field").forEach((f) => { f.classList.remove("bad"); const e = f.querySelector(".err"); if (e) e.textContent = ""; }); for (const [k, m] of Object.entries(fields || {})) { const f = $("f-" + k); if (f) { f.classList.add("bad"); const e = f.querySelector(".err"); if (e) e.textContent = m; } } }
async function postForm(path, body, msgEl) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { location.reload(); throw new Error("signed out"); }
  if (!r.ok) { fieldErrors(d.fields); throw new Error(d.error || "Request failed"); }
  return d;
}

// ── status actions ───────────────────────────────────────────────────
function startAction(o, a) {
  if (a.form) return shipDialog(o);
  const note = el("textarea", { id: "anote", maxlength: "500", rows: "2", placeholder: "Internal note (optional)" });
  const pub = el("textarea", { id: "apub", maxlength: "300", rows: "2", placeholder: "Message the customer will see (optional)" });
  const needsDialog = a.confirm || a.to === "delivered";
  const run = async () => { const d = await postForm(`/api/orders/${o.id}/status`, { to: a.to, idempotency_key: key(), confirm: true, note: note.value, public_note: pub.value }); toast(`${o.name || "Order"} is now ${STATUS_TXT[a.to]}`); if ($("adlg").open) $("adlg").close(); await openOrder(o.id, d); load(); };
  if (!needsDialog) return run().catch((e) => toast(e.message, true));
  const msg = { cancelled: "Cancelling does not refund any payment automatically.", returned: "Record this only when the goods have come back.", on_hold: "The order stays on hold until you resume or cancel it.", delivery_failed: "Add a short reason the customer can see.", delivered: "Delivered does not mark an unpaid order as paid." }[a.to];
  actionDialog(`${a.label}?`, [el("p", {}, `${o.name || "Order"} · ${orderRef(o)}`), el("p", { class: "sub" }, msg || ""), labeled("anote", "Internal note", note), labeled("apub", "Note for the customer", pub, "Shown on their tracking page")], a.label, { danger: ["cancelled", "returned"].includes(a.to), onSubmit: run });
}
const key = () => crypto.randomUUID();

// ── ship / correct shipment ──────────────────────────────────────────
function dateShift(ymd, days) {
  const [y, m, d] = (ymd || "").split("-").map(Number);
  if (!y || !m || !d || !days) return "";
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function shipFields(s, o) {
  const courier = el("input", { id: "courier", list: "courierlist", value: s ? s.courier : "", maxlength: "60", placeholder: "e.g. Delhivery", autocomplete: "off" });
  const awb = el("input", { id: "awb", value: s ? s.awb : "", maxlength: "40", placeholder: "Paste AWB / tracking number", autocomplete: "off", spellcheck: "false" });
  const url = el("input", { id: "tracking_url", type: "url", value: s && s.tracking_url ? s.tracking_url : "", placeholder: "https:// link from the courier (optional)" });
  const on = el("input", { id: "shipped_on", type: "date", value: s ? s.shipped_on : todayIST() });
  const onYmd = on.value ? on.value : todayIST();
  const suggested = (o && o.transit_days) ? dateShift(onYmd, o.transit_days) : "";
  const est = el("input", { id: "est_delivery", type: "date", value: (s && s.est_delivery) || suggested });
  const notes = el("textarea", { id: "snotes", rows: "2", maxlength: "500", placeholder: "Internal shipping notes (optional)" }); notes.value = s && s.notes ? s.notes : "";
  const hint = o && o.transit_days != null ? `From Pune origin · ~${o.transit_days} calendar transit day${o.transit_days === 1 ? "" : "s"}` : "";
  const nodes = [labeled("courier", "Courier / logistics provider *", courier), labeled("awb", "AWB / tracking number *", awb), labeled("tracking_url", "Tracking link", url, "Paste the courier's own link. We never make one up."),
    el("div", { class: "two" }, labeled("shipped_on", "Shipping date *", on), labeled("est_delivery", "Estimated delivery", est, hint)), labeled("snotes", "Notes", notes), el("datalist", { id: "courierlist" }, COURIERS.map((c) => el("option", { value: c })))];
  return { nodes, values: () => ({ courier: courier.value, awb: awb.value, tracking_url: url.value, shipped_on: on.value, est_delivery: est.value || null, notes: notes.value }) };
}
function shipDialog(o) {
  const f = shipFields(null, o), k = key(), pub = el("textarea", { id: "apub", rows: "2", maxlength: "300", placeholder: "Message the customer will see (optional)" });
  const extra = ["shipped", "out_for_delivery"].includes(o.status);
  // International orders ship only when the quotation is accepted and fully paid; anything else needs a written, recorded override.
  const needsOv = o.market === "INTL" && (o.payment_status !== "paid" || o.quote_status !== "accepted");
  const ov = el("textarea", { id: "ovr", rows: "2", maxlength: "300", placeholder: "Why is this being shipped before payment or approval? (required, kept on the order)" });
  actionDialog(extra ? "Add another shipment" : "Ship order", [el("p", { class: "sub" }, `${o.name || "Order"} · ${orderRef(o)}`), ...(needsOv ? [el("p", { class: "msg" }, "This international order is not accepted and fully paid yet."), labeled("ovr", "Override reason", ov, "Only for an arrangement agreed in writing. It is recorded and audited.")] : []), ...f.nodes, labeled("apub", "Note for the customer", pub, o.email ? `Shipment details will be emailed to ${o.email}.` : "No customer email is on this order; add an email at checkout to send shipment notifications.")], extra ? "Save shipment" : "Save & mark as shipped", {
    onSubmit: async () => { const d = await postForm(`/api/orders/${o.id}/ship`, { ...f.values(), public_note: pub.value, idempotency_key: k, ...(needsOv ? { override_reason: ov.value } : {}) }); toast(o.email ? "Shipment saved · email notification attempted" : "Shipment saved · no customer email on file"); $("adlg").close(); await openOrder(o.id, d); load(); },
  });
}
function editShipmentDialog(o, s) {
  const f = shipFields(s, o);
  actionDialog("Correct shipment", [el("p", { class: "sub" }, "Changes are saved with your name and the time, and the old values are kept."), ...f.nodes, el("p", { class: "sub" }, o.market === "INTL" ? "For international orders, updated tracking details are emailed to the customer." : "For India orders, the shipment email is sent when the AWB is first added.")], "Save correction", {
    onSubmit: async () => { const v = f.values(); const d = await postForm(`/api/orders/${o.id}/shipments/${s.id}`, v); toast("Shipment updated"); $("adlg").close(); await openOrder(o.id, d); load(); },
  });
}

// ── pre-order: expected dispatch date ────────────────────────────────
function dispatchDialog(o) {
  const date = el("input", { id: "expected_dispatch", type: "date", value: o.expected_dispatch || "" });
  const pub = el("textarea", { id: "apub", rows: "2", maxlength: "300", placeholder: "Message the customer will see (optional)" }), k = key();
  actionDialog("Update expected dispatch", [el("p", { class: "sub" }, `${o.name || "Order"} · ${orderRef(o)}`), labeled("expected_dispatch", "Expected dispatch date", date, "A planning date, not a delivery promise. Clear it to remove."), labeled("apub", "Note for the customer", pub, "Optional. Otherwise the date is shown as-is on their tracking page.")], "Save", {
    onSubmit: async () => { const d = await postForm(`/api/orders/${o.id}/dispatch`, { expected_dispatch: date.value, public_note: pub.value, idempotency_key: k }); toast("Expected dispatch updated"); $("adlg").close(); await openOrder(o.id, d); load(); },
  });
}
const preorderSection = (o) => !o.is_preorder ? [] : [el("h3", { class: "sec" }, "Pre-order"),
  el("div", { class: "preorder" },
    ...(o.stock_lines.length ? o.stock_lines.map((l) => el("div", { class: "row" }, el("span", {}, l.name), el("span", { class: "sub" }, `ready ${l.ready_qty} / pre-order ${l.pre_qty}`))) : [el("p", { class: "sub" }, "No stock reservation recorded for this order.")]),
    el("div", { class: "row" }, el("span", {}, "Expected dispatch: ", el("b", {}, dayText(o.expected_dispatch))), !["cancelled", "returned", "delivered"].includes(o.status) ? el("button", { class: "btn small", type: "button", onclick: () => dispatchDialog(o) }, "Update expected dispatch") : ""))];

// ── record payment (cash / UPI / bank), unchanged rules ──────────────
function paymentDialog(o) {
  const manual = !["cash", "cod"].includes(o.payment_method), k = key();
  const method = el("select", { id: "pm" }, [["upi", "UPI"], ["bank", "Bank transfer"]].map(([v, l]) => el("option", { value: v }, l)));
  const ref = el("input", { id: "pref", maxlength: "64", placeholder: "Payment reference / UTR" });
  actionDialog(manual ? "Record payment received" : "Mark cash as received", [el("p", {}, `Order ${o.id}`), el("p", {}, "Outstanding: ", el("b", {}, inr(o.outstanding_paise))), ...(manual ? [labeled("pm", "Received by", method), labeled("pref", "Reference (required)", ref)] : []), el("p", { class: "sub" }, "Only confirm after the money has actually arrived. This is recorded against your account.")], `Confirm ${inr(o.outstanding_paise)} received`, {
    onSubmit: async () => { const b = { confirm_amount_paise: o.outstanding_paise, idempotency_key: k }; if (manual) { b.method = method.value; b.reference = ref.value; } const d = await postForm(`/api/orders/${o.id}/payment-received`, b); toast("Payment recorded"); $("adlg").close(); await openOrder(o.id, d); load(); },
  });
}

// ── edit quantity / unit price (unpaid, unshipped orders only; the server decides eligibility and recomputes every total) ──
function editItemsDialog(o) {
  const L = o.edit.lines;
  const preview = el("p", { class: "sub", role: "status" }, "Change a quantity or price to see the new total.");
  const reason = el("textarea", { id: "reason", maxlength: "200", rows: "2", placeholder: "Why is this changing? Saved in the audit log" });
  const rows = L.map((l, i) => {
    const q = el("input", { id: "qty-" + i, type: "number", inputmode: "numeric", min: "1", step: "1", value: String(l.qty), ...(l.fixed ? { disabled: "" } : {}) });
    const u = el("input", { id: "unit-" + i, type: "number", inputmode: "decimal", min: "0.01", step: "0.01", value: l.unit_paise == null ? "" : (l.unit_paise / 100).toFixed(2) });
    return { q, u, node: el("div", { class: "editline" }, el("b", {}, l.name),
      labeled("qty-" + i, "Quantity", q, l.qty_locked ? "Reserved stock is adjusted to the new quantity" : l.fixed ? "Fixed kit: always 1" : ""),
      labeled("unit-" + i, l.all_inclusive ? "Price each (incl. GST)" : "Price each (ex-GST)", u, l.unit_from === "catalogue" ? "Starts at the catalogue price. Enter what this customer pays." : "")) };
  });
  // Products added to this order: each row is { id, q, u, node }; the server checks stock, price and duplicates.
  const addable = o.edit.addable || [], added = [], addBox = el("div", {});
  const body = (extra) => ({ lines: L.map((l, i) => ({ id: l.id, qty: rows[i].q.value, unit_rupees: rows[i].u.value })), add: added.map((a) => ({ id: a.sel.value, qty: a.q.value, unit_rupees: a.u.value })), ...extra });
  let timer = 0, seq = 0;
  const refresh = () => { clearTimeout(timer); timer = setTimeout(async () => {
    const mine = ++seq;
    try { const d = await api(`/api/orders/${o.id}/items`, body({ dry_run: true })); if (mine === seq) preview.textContent = `Total ${inr(d.before.total)} → ${inr(d.after.total)} (GST ${inr(d.after.gst)})`; }
    catch (e) { if (mine === seq) preview.textContent = e.message; }
  }, 400); };
  for (const r of rows) { r.q.addEventListener("input", refresh); r.u.addEventListener("input", refresh); }
  const addRow = () => {
    const j = added.length;
    const sel = el("select", { id: "add-id-" + j }, [el("option", { value: "" }, "Choose a product…"), ...addable.map((p) => el("option", { value: p.id }, p.name))]);
    const q = el("input", { id: "add-qty-" + j, type: "number", inputmode: "numeric", min: "1", step: "1", value: "1" });
    const u = el("input", { id: "add-unit-" + j, type: "number", inputmode: "decimal", min: "0.01", step: "0.01", value: "" });
    const a = { sel, q, u };
    const hint = el("div", { class: "hint" });
    sel.addEventListener("change", () => { // start from the catalogue price; the admin enters what this customer pays
      const p = addable.find((x) => x.id === sel.value);
      u.value = p ? (p.unit_paise / 100).toFixed(2) : ""; if (p && p.fixed) q.value = "1";
      hint.textContent = p ? (p.all_inclusive ? "Price each is incl. GST" : "Price each is ex-GST") : ""; refresh();
    });
    q.addEventListener("input", refresh); u.addEventListener("input", refresh);
    a.node = el("div", { class: "editline" }, el("b", {}, "New product"), labeled("add-id-" + j, "Product", sel), labeled("add-qty-" + j, "Quantity", q), labeled("add-unit-" + j, "Price each", u, ""), hint,
      el("button", { class: "btn link", type: "button", onclick: () => { const k = added.indexOf(a); added.splice(k, 1); a.node.remove(); renumber(); refresh(); } }, "Remove"));
    added.push(a); addBox.append(a.node); addBtn.disabled = added.length >= addable.length;
  };
  // Field ids must match the server's add-*-<index> error keys after a row is removed.
  const renumber = () => { added.forEach((a, j) => { for (const [k, n] of [["id", a.sel], ["qty", a.q], ["unit", a.u]]) { n.id = `add-${k}-${j}`; const f = a.node.querySelector(`[id^="f-add-${k}-"]`); if (f) { f.id = `f-add-${k}-${j}`; f.querySelector("label").htmlFor = n.id; f.querySelector(".err").id = `e-add-${k}-${j}`; } } }); addBtn.disabled = added.length >= addable.length; };
  const addBtn = el("button", { class: "btn small", type: "button", onclick: addRow }, "+ Add another product");
  if (!addable.length) addBtn.disabled = true;
  actionDialog("Edit order items", [el("p", { class: "sub" }, `${o.name || "Order"} · ${orderRef(o)} · currently ${inr(o.total)}`), ...rows.map((r) => r.node), addBox, addBtn, preview,
    labeled("reason", "Reason (required)", reason), el("p", { class: "sub" }, "The customer is not emailed. The change is saved with your name, and the old values are kept in the audit log.")], "Save changes", {
    onSubmit: async () => { await postForm(`/api/orders/${o.id}/items`, body({ confirm: true, reason: reason.value })); toast("Order updated"); $("adlg").close(); await openOrder(o.id); load(); },
  });
}

// ── order side panel ─────────────────────────────────────────────────
function copyBtn(text) { return el("button", { class: "btn small", type: "button", onclick: async (e) => { try { await navigator.clipboard.writeText(text); e.target.textContent = "Copied"; setTimeout(() => { e.target.textContent = "Copy"; }, 1500); } catch { toast("Copy failed", true); } } }, "Copy"); }
const row = (k, v) => [el("dt", {}, k), el("dd", {}, v)];

async function openOrder(id, preloaded) {
  let o = preloaded;
  if (!o || !o.timeline) { try { o = await api("/api/orders/" + id); } catch (e) { return toast(e.message, true); } }
  const manualPay = ["cash", "cod", "upi", "bank", "whatsapp"].includes(o.payment_method) && o.payment_status === "unpaid" && o.status !== "cancelled" && (o.payment_method !== "cod" || o.status === "delivered");
  const primary = o.actions.find((a) => ["confirmed", "preorder_confirmed", "awaiting_stock", "ready_to_pack", "processing", "packed", "shipped", "out_for_delivery", "delivered"].includes(a.to));
  const others = o.actions.filter((a) => a !== primary);
  const actionBtn = (a, main) => el("button", { class: main ? "btn primary" : "btn small" + (["cancelled", "returned"].includes(a.to) ? " danger" : ""), type: "button", onclick: () => startAction(o, a) }, a.label);
  const shipCards = o.shipments.map((s) => el("div", { class: "ship" },
    el("div", { class: "ship-top" }, el("b", {}, s.courier), el("span", { class: "sub" }, `Shipped ${dayText(s.shipped_on)}${s.est_delivery ? " · est. " + dayText(s.est_delivery) : ""}`)),
    el("div", { class: "awb" }, el("span", { class: "mono" }, s.awb), copyBtn(s.awb), s.tracking_url ? el("a", { class: "btn small", href: s.tracking_url, target: "_blank", rel: "noopener noreferrer" }, "Track") : ""),
    s.notes ? el("div", { class: "sub" }, s.notes) : "",
    s.revisions.length ? el("details", { class: "sub" }, el("summary", {}, `${s.revisions.length} correction${s.revisions.length > 1 ? "s" : ""}`), ...s.revisions.map((r) => el("div", {}, `${when(r.created_at)} · ${r.changed_by}: ` + Object.entries(r.changes).map(([k, v]) => `${k} ${v.from ?? "—"} → ${v.to ?? "—"}`).join(", ")))) : "",
    !["cancelled", "returned"].includes(o.status) ? el("button", { class: "btn link", type: "button", onclick: () => editShipmentDialog(o, s) }, "Correct details") : ""));
  const tl = o.timeline.map((t, i) => el("li", { class: "tl " + (i === o.timeline.length - 1 ? "now" : "done") },
    el("div", { class: "tl-title" }, t.label, t.customer_visible === false ? el("span", { class: "pill off" }, "Internal") : ""),
    el("div", { class: "sub" }, when(t.at) + (t.actor ? ` · ${t.actor}` : "")),
    t.public_note ? el("div", { class: "tl-note" }, "To customer: " + t.public_note) : "", t.note ? el("div", { class: "sub" }, "Note: " + t.note) : ""));
  const items = o.items.length ? o.items.map((i) => el("tr", {}, el("td", {}, String(i.name || i.id || "Item")), el("td", {}, "× " + (i.qty ?? 1) + (Number.isInteger(i.unit_paise) ? " @ " + inr(i.unit_paise) : "")))) : [el("tr", {}, el("td", {}, "—"))];
  $("opanel").replaceChildren(
    el("div", { class: "panel-head" }, el("div", {}, el("h2", { id: "optitle", class: "h0" }, "Order " + orderRef(o)), el("div", {}, payPill(o), fulPill(o), priPill(o), o.is_preorder ? el("span", { class: "pill pre" }, "Pre-order") : "")), el("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: () => $("opanel").close() }, "✕")),
    el("div", { class: "opanel-body" },
      o.track_url ? el("button", { class: "btn small", type: "button", onclick: async () => { try { await navigator.clipboard.writeText(o.track_url); toast("Tracking link copied"); } catch { toast("Copy failed", true); } } }, "Copy customer tracking link") : "",
      el("div", { class: "next" }, primary ? actionBtn(primary, true) : el("span", { class: "sub" }, o.actions.length ? "" : `This order is ${o.status_label.toLowerCase()}.`), ...others.map((a) => actionBtn(a, false))),
      manualPay ? el("button", { class: "btn", type: "button", onclick: () => paymentDialog(o) }, ["cash", "cod"].includes(o.payment_method) ? "Mark cash as received" : "Record payment received") : "",
      manualPay && ["upi", "bank", "whatsapp"].includes(o.payment_method) && o.market !== "INTL" && window.openPayLinkFor ? el("button", { class: "btn", type: "button", onclick: () => { $("opanel").close(); window.openPayLinkFor(o.id); } }, "Send payment link") : "",
      ...(window.intlOrderSection ? window.intlOrderSection(o) : []),
      ...preorderSection(o),
      el("h3", { class: "sec" }, "Customer"), el("dl", {}, ...row("Name", o.name || "—"), ...row("Phone", o.phone ? phoneLink(o) : "—"), ...row("Email", o.email || "—"), ...row("Ship to", [o.address, o.state, o.pincode].filter(Boolean).join(", ") || "—"), ...row("GSTIN", o.gstin || "—")),
      el("h3", { class: "sec" }, "Items & payment"), el("table", { class: "items" }, el("tbody", {}, items)),
      o.edit && o.edit.allowed ? el("button", { class: "btn small", type: "button", onclick: () => editItemsDialog(o) }, "Edit quantity & price") : "",
      el("dl", {}, ...row("Subtotal", orderMoney(o, o.subtotal)), ...row(o.market === "INTL" ? "Taxes" : "GST", orderMoney(o, o.gst)), ...row("Total", orderMoney(o, o.total)), ...row("Paid", orderMoney(o, o.paid_paise)), ...row("Outstanding", orderMoney(o, o.outstanding_paise)), ...row("Method", methodTxt(o)), ...row("Order ID", o.id), ...row("Transaction", o.txn_id || "—"), ...row("Placed", when(o.created_at))),
      o.payments.length ? el("p", { class: "sub" }, o.payments.map((p) => `${orderMoney(o, p.amount_paise)} ${p.method}${p.reference ? " (" + p.reference + ")" : ""} · ${p.recorded_by}`).join(" · ")) : "",
      ...buildSection(o),
      el("h3", { class: "sec" }, "Shipments"), ...(shipCards.length ? shipCards : [el("p", { class: "sub" }, "Nothing shipped yet.")]),
      el("h3", { class: "sec" }, "Order journey"), el("ol", { class: "timeline" }, tl),
      el("h3", { class: "sec" }, "Customer emails"),
      ...(o.notifications.length ? o.notifications.map((n) => el("div", { class: "sub" }, `${when(n.created_at)} · ${n.subject || n.event} · ${n.status}${n.detail ? " (" + n.detail + ")" : ""}`)) : [el("p", { class: "sub" }, o.email ? "Nothing sent yet. Emails go out when the order is confirmed, packed, shipped, out for delivery or delivered." : "No customer email on this order, so no emails are sent.")])
    )
  );
  if (!$("opanel").open) $("opanel").showModal();
}

// ── wiring ───────────────────────────────────────────────────────────
let ot; $("filters").addEventListener("input", () => { persistO(); clearTimeout(ot); ot = setTimeout(() => { O.page = 1; load(); }, 250); });
$("filters").addEventListener("submit", (e) => e.preventDefault());
$("oclear").onclick = clearO;
$("prev").onclick = () => { O.page--; load(); }; $("next").onclick = () => { O.page++; load(); };
restoreO(); drawChips();
