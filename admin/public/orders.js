// Orders screen: chips, search, list, side panel with timeline, status actions, shipment form, AWB corrections, payment recording.
// Shares $, el, api, inr, when with app.js. All text is inserted with textContent.
const O = { page: 1, pages: 1, view: "", sort: "created_at", dir: "desc", loaded: false };
const VIEW_CHIPS = [["", "All"], ["new", "New"], ["paid", "Paid"], ["payment_pending", "Payment pending"], ["processing", "Processing"], ["packed", "Packed"], ["shipped", "Shipped"], ["out_for_delivery", "Out for delivery"], ["delivered", "Delivered"], ["preorders", "Pre-orders"], ["cancelled", "Cancelled"]];
const STATUS_TXT = { placed: "Order placed", confirmed: "Confirmed", processing: "Processing", packed: "Packed", shipped: "Shipped", out_for_delivery: "Out for delivery", delivered: "Delivered", on_hold: "On hold", cancelled: "Cancelled", delivery_failed: "Delivery failed", returned: "Returned" };
const COURIERS = ["Delhivery", "Blue Dart", "DTDC", "India Post", "Ekart Logistics", "Trackon", "Xpressbees", "Shiprocket", "Ecom Express"];
const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const dayText = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
const OKEY = "ntagz.admin.ofilters";

const payPill = (o) => el("span", { class: "pill " + o.payment_status }, o.payment_status === "paid" ? "Paid" : "Unpaid");
const fulPill = (o) => el("span", { class: "pill st-" + o.status }, STATUS_TXT[o.status] || o.status);
const methodTxt = (o) => (o.payment_method || "—").toUpperCase();
const orderRef = (o) => o.id.slice(0, 8);

function oparams() {
  const p = new URLSearchParams();
  if (O.view) p.set("view", O.view);
  for (const id of ["q", "payment_method", "from", "to"]) if ($(id).value) p.set(id, $(id).value);
  p.set("page", O.page); p.set("sort", O.sort); p.set("dir", O.dir);
  return p;
}
function persistO() { try { sessionStorage.setItem(OKEY, JSON.stringify({ view: O.view, q: $("q").value, payment_method: $("payment_method").value, from: $("from").value, to: $("to").value })); } catch { /* ignore */ } }
function restoreO() { try { const f = JSON.parse(sessionStorage.getItem(OKEY) || "{}"); O.view = f.view || ""; for (const id of ["q", "payment_method", "from", "to"]) if (f[id]) $(id).value = f[id]; } catch { /* ignore */ } }

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
    if (!d.orders.length) { const e = el("div", { class: "empty" }, el("p", {}, O.view || $("q").value ? "No orders match this view or search." : "No orders yet."), O.view || $("q").value ? el("button", { class: "btn", type: "button", onclick: clearO }, "Clear filters") : ""); $("list").replaceChildren(e); $("rows").replaceChildren(el("tr", {}, el("td", { colspan: "8" }, e.cloneNode(true)))); return; }
    $("list").replaceChildren(...d.orders.map((o) => el("button", { class: "card ocard", type: "button", onclick: () => openOrder(o.id) },
      el("div", { class: "row" }, el("span", { class: "id" }, o.name || "Guest"), el("b", {}, inr(o.total))),
      el("div", { class: "sub" }, `${orderRef(o)} · ${when(o.created_at)}`),
      el("div", {}, payPill(o), fulPill(o), o.is_preorder ? el("span", { class: "pill pre" }, "Pre-order") : ""),
      o.tracking_id ? el("div", { class: "sub" }, `${o.courier || ""} · ${o.tracking_id}`) : "")));
    $("rows").replaceChildren(...d.orders.map((o) => el("tr", { tabindex: "0", onclick: () => openOrder(o.id), onkeydown: (e) => { if (e.key === "Enter") openOrder(o.id); } },
      el("td", { class: "mono" }, orderRef(o)), el("td", {}, when(o.created_at)), el("td", {}, o.name || "Guest", el("div", { class: "sub" }, o.phone || "")),
      el("td", {}, payPill(o), el("div", { class: "sub" }, methodTxt(o))), el("td", {}, fulPill(o), o.is_preorder ? el("span", { class: "pill pre" }, "Pre-order") : ""),
      el("td", {}, inr(o.total)), el("td", {}, o.courier || "—"), el("td", { class: "mono" }, o.tracking_id || "—"))));
  } catch (e) {
    $("list").replaceChildren(el("p", { class: "msg" }, "Could not load orders: " + e.message, " ", el("button", { class: "btn small", type: "button", onclick: load }, "Retry")));
  }
}
function clearO() { O.view = ""; for (const id of ["q", "payment_method", "from", "to"]) $(id).value = ""; O.page = 1; persistO(); drawChips(); load(); }

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
function shipFields(s) {
  const courier = el("input", { id: "courier", list: "courierlist", value: s ? s.courier : "", maxlength: "60", placeholder: "e.g. Delhivery", autocomplete: "off" });
  const awb = el("input", { id: "awb", value: s ? s.awb : "", maxlength: "40", placeholder: "Paste AWB / tracking number", autocomplete: "off", spellcheck: "false" });
  const url = el("input", { id: "tracking_url", type: "url", value: s && s.tracking_url ? s.tracking_url : "", placeholder: "https:// link from the courier (optional)" });
  const on = el("input", { id: "shipped_on", type: "date", value: s ? s.shipped_on : todayIST() });
  const est = el("input", { id: "est_delivery", type: "date", value: s && s.est_delivery ? s.est_delivery : "" });
  const notes = el("textarea", { id: "snotes", rows: "2", maxlength: "500", placeholder: "Internal shipping notes (optional)" }); notes.value = s && s.notes ? s.notes : "";
  const nodes = [labeled("courier", "Courier / logistics provider *", courier), labeled("awb", "AWB / tracking number *", awb), labeled("tracking_url", "Tracking link", url, "Paste the courier's own link. We never make one up."),
    el("div", { class: "two" }, labeled("shipped_on", "Shipping date *", on), labeled("est_delivery", "Estimated delivery", est)), labeled("snotes", "Notes", notes), el("datalist", { id: "courierlist" }, COURIERS.map((c) => el("option", { value: c })))];
  return { nodes, values: () => ({ courier: courier.value, awb: awb.value, tracking_url: url.value, shipped_on: on.value, est_delivery: est.value, notes: notes.value }) };
}
function shipDialog(o) {
  const f = shipFields(null), k = key(), pub = el("textarea", { id: "apub", rows: "2", maxlength: "300", placeholder: "Message the customer will see (optional)" });
  const extra = ["shipped", "out_for_delivery"].includes(o.status);
  actionDialog(extra ? "Add another shipment" : "Ship order", [el("p", { class: "sub" }, `${o.name || "Order"} · ${orderRef(o)}`), ...f.nodes, labeled("apub", "Note for the customer", pub)], extra ? "Save shipment" : "Save & mark as shipped", {
    onSubmit: async () => { const d = await postForm(`/api/orders/${o.id}/ship`, { ...f.values(), public_note: pub.value, idempotency_key: k }); toast("Shipment saved"); $("adlg").close(); await openOrder(o.id, d); load(); },
  });
}
function editShipmentDialog(o, s) {
  const f = shipFields(s);
  actionDialog("Correct shipment", [el("p", { class: "sub" }, "Changes are saved with your name and the time, and the old values are kept."), ...f.nodes], "Save correction", {
    onSubmit: async () => { const v = f.values(); const d = await postForm(`/api/orders/${o.id}/shipments/${s.id}`, v); toast("Shipment updated"); $("adlg").close(); await openOrder(o.id, d); load(); },
  });
}

// ── record payment (cash / UPI / bank), unchanged rules ──────────────
function paymentDialog(o) {
  const manual = !["cash", "cod"].includes(o.payment_method), k = key();
  const method = el("select", { id: "pm" }, [["upi", "UPI"], ["bank", "Bank transfer"]].map(([v, l]) => el("option", { value: v }, l)));
  const ref = el("input", { id: "pref", maxlength: "64", placeholder: "Payment reference / UTR" });
  actionDialog(manual ? "Record payment received" : "Mark cash as received", [el("p", {}, `Order ${o.id}`), el("p", {}, "Outstanding: ", el("b", {}, inr(o.outstanding_paise))), ...(manual ? [labeled("pm", "Received by", method), labeled("pref", "Reference (required)", ref)] : []), el("p", { class: "sub" }, "Only confirm after the money has actually arrived. This is recorded against your account.")], `Confirm ${inr(o.outstanding_paise)} received`, {
    onSubmit: async () => { const b = { confirm_amount_paise: o.outstanding_paise, idempotency_key: k }; if (manual) { b.method = method.value; b.reference = ref.value; } const d = await postForm(`/api/orders/${o.id}/payment-received`, b); toast("Payment recorded"); $("adlg").close(); await openOrder(o.id, d); load(); },
  });
}

// ── order side panel ─────────────────────────────────────────────────
function copyBtn(text) { return el("button", { class: "btn small", type: "button", onclick: async (e) => { try { await navigator.clipboard.writeText(text); e.target.textContent = "Copied"; setTimeout(() => { e.target.textContent = "Copy"; }, 1500); } catch { toast("Copy failed", true); } } }, "Copy"); }
const row = (k, v) => [el("dt", {}, k), el("dd", {}, v)];

async function openOrder(id, preloaded) {
  let o = preloaded;
  if (!o || !o.timeline) { try { o = await api("/api/orders/" + id); } catch (e) { return toast(e.message, true); } }
  const manualPay = ["cash", "cod", "upi", "bank", "whatsapp"].includes(o.payment_method) && o.payment_status === "unpaid" && o.status !== "cancelled" && (o.payment_method !== "cod" || o.status === "delivered");
  const primary = o.actions.find((a) => ["confirmed", "processing", "packed", "shipped", "out_for_delivery", "delivered"].includes(a.to));
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
  const items = o.items.length ? o.items.map((i) => el("tr", {}, el("td", {}, String(i.name || i.id || "Item")), el("td", {}, "× " + (i.qty ?? 1)))) : [el("tr", {}, el("td", {}, "—"))];
  $("opanel").replaceChildren(
    el("div", { class: "panel-head" }, el("div", {}, el("h2", { id: "optitle", class: "h0" }, "Order " + orderRef(o)), el("div", {}, payPill(o), fulPill(o), o.is_preorder ? el("span", { class: "pill pre" }, "Pre-order") : "")), el("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: () => $("opanel").close() }, "✕")),
    el("div", { class: "opanel-body" },
      o.track_url ? el("button", { class: "btn small", type: "button", onclick: async () => { try { await navigator.clipboard.writeText(o.track_url); toast("Tracking link copied"); } catch { toast("Copy failed", true); } } }, "Copy customer tracking link") : "",
      el("div", { class: "next" }, primary ? actionBtn(primary, true) : el("span", { class: "sub" }, o.actions.length ? "" : `This order is ${o.status_label.toLowerCase()}.`), ...others.map((a) => actionBtn(a, false))),
      manualPay ? el("button", { class: "btn", type: "button", onclick: () => paymentDialog(o) }, ["cash", "cod"].includes(o.payment_method) ? "Mark cash as received" : "Record payment received") : "",
      el("h3", { class: "sec" }, "Shipments"), ...(shipCards.length ? shipCards : [el("p", { class: "sub" }, "Nothing shipped yet.")]),
      el("h3", { class: "sec" }, "Order journey"), el("ol", { class: "timeline" }, tl),
      el("h3", { class: "sec" }, "Customer"), el("dl", {}, ...row("Name", o.name || "—"), ...row("Phone", o.phone || "—"), ...row("Email", o.email || "—"), ...row("Ship to", [o.address, o.state, o.pincode].filter(Boolean).join(", ") || "—"), ...row("GSTIN", o.gstin || "—")),
      el("h3", { class: "sec" }, "Items & payment"), el("table", { class: "items" }, el("tbody", {}, items)),
      el("dl", {}, ...row("Subtotal", inr(o.subtotal)), ...row("GST", inr(o.gst)), ...row("Total", inr(o.total)), ...row("Paid", inr(o.paid_paise)), ...row("Outstanding", inr(o.outstanding_paise)), ...row("Method", methodTxt(o)), ...row("Order ID", o.id), ...row("Transaction", o.txn_id || "—"), ...row("Placed", when(o.created_at))),
      o.payments.length ? el("p", { class: "sub" }, o.payments.map((p) => `${inr(p.amount_paise)} ${p.method}${p.reference ? " (" + p.reference + ")" : ""} · ${p.recorded_by}`).join(" · ")) : "")
  );
  if (!$("opanel").open) $("opanel").showModal();
}

// ── wiring ───────────────────────────────────────────────────────────
let ot; $("filters").addEventListener("input", () => { persistO(); clearTimeout(ot); ot = setTimeout(() => { O.page = 1; load(); }, 250); });
$("filters").addEventListener("submit", (e) => e.preventDefault());
$("oclear").onclick = clearO;
$("prev").onclick = () => { O.page--; load(); }; $("next").onclick = () => { O.page++; load(); };
restoreO(); drawChips();
