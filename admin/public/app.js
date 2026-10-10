const $ = (id) => document.getElementById(id);
const state = { page: 1, sort: "created_at", dir: "desc", pages: 1 };
const inr = (paise) => "₹" + (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (s) => new Date(s * 1000).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

// Build DOM with textContent only: order data is customer-supplied and never parsed as HTML.
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
  for (const k of kids.flat()) n.append(k instanceof Node ? k : document.createTextNode(k ?? ""));
  return n;
}
async function api(path, body) {
  const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" }, body: JSON.stringify(body) };
  const r = await fetch(path, opts);
  if (r.status === 401) { location.reload(); throw new Error("signed out"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}
const pills = (o) => [
  el("span", { class: "pill " + o.payment_status }, o.payment_status),
  el("span", { class: "pill" }, o.payment_method || "—"),
  el("span", { class: "pill " + (o.status === "cancelled" ? "cancelled" : "") }, o.status),
];
const params = () => {
  const p = new URLSearchParams();
  for (const id of ["q", "payment_status", "payment_method", "fulfilment", "from", "to"]) if ($(id).value) p.set(id, $(id).value);
  return p;
};

async function load() {
  const p = params(); p.set("page", state.page); p.set("sort", state.sort); p.set("dir", state.dir);
  const d = await api("/api/orders?" + p);
  state.pages = d.pages; state.page = d.page;
  $("pageInfo").textContent = `Page ${d.page} of ${d.pages} · ${d.total} orders`;
  $("prev").disabled = d.page <= 1; $("next").disabled = d.page >= d.pages;
  const empty = el("p", { class: "sub" }, "No orders match.");
  $("list").replaceChildren(...(d.orders.length ? d.orders.map((o) =>
    el("button", { class: "card", type: "button", onclick: () => open(o.id) },
      el("div", { class: "row" }, el("span", { class: "id" }, o.name || "Guest"), el("b", {}, inr(o.total))),
      el("div", { class: "sub" }, `${o.id.slice(0, 8)} · ${when(o.created_at)}`),
      el("div", {}, pills(o)))) : [empty]));
  $("rows").replaceChildren(...d.orders.map((o) =>
    el("tr", { tabindex: "0", onclick: () => open(o.id), onkeydown: (e) => { if (e.key === "Enter") open(o.id); } },
      el("td", {}, when(o.created_at)), el("td", {}, o.id.slice(0, 8)),
      el("td", {}, o.name || "Guest", el("div", { class: "sub" }, o.phone || "")),
      el("td", {}, inr(o.total)), el("td", {}, pills(o).slice(0, 2)), el("td", {}, pills(o)[2]))));
  $("csv").href = "/api/orders.csv?" + params();
}

async function open(id) {
  const o = await api("/api/orders/" + id);
  const dlg = $("dlg");
  const msg = el("div", { class: "msg", role: "alert" });
  const items = o.items.length ? o.items.map((i) => el("tr", {}, el("td", {}, String(i.name || i.id || "Item")), el("td", {}, "× " + (i.qty ?? i.quantity ?? 1)))) : [el("tr", {}, el("td", {}, "—"))];
  const ful = el("select", { id: "fsel", "aria-label": "Fulfilment status" }, ["confirmed", "packed", "shipped", "delivered", "cancelled"].map((s) => { const x = el("option", { value: s }, s); if (s === o.status) x.selected = true; return x; }));
  const trk = el("input", { id: "trk", placeholder: "Tracking ID", value: o.tracking_id || "", maxlength: "64" });
  const cour = el("input", { id: "cour", placeholder: "Courier", value: o.courier || "", maxlength: "64" });
  const eligible = ["cash", "cod"].includes(o.payment_method) && o.payment_status === "unpaid" && o.status !== "cancelled" && (o.payment_method !== "cod" || o.status === "delivered");
  const actions = [
    el("div", { class: "field" }, el("label", { for: "fsel" }, "Fulfilment"), ful, trk, cour,
      el("button", { class: "btn", type: "button", onclick: async () => { try { await api(`/api/orders/${id}/fulfilment`, { status: ful.value, tracking_id: trk.value, courier: cour.value }); await open(id); load(); } catch (e) { msg.textContent = e.message; } } }, "Update fulfilment")),
  ];
  if (eligible) actions.push(el("button", { class: "btn primary", type: "button", onclick: () => confirmCash(o) }, "Mark cash as received"));
  else if (o.payment_status === "unpaid") actions.push(el("p", { class: "sub" }, o.payment_method === "cod" ? "Cash on delivery can be recorded once the order is delivered." : "Online/other payments cannot be marked received here."));
  dlg.replaceChildren(
    el("h2", { id: "dtitle", class: "h0" }, "Order " + o.id.slice(0, 8)), el("div", {}, pills(o)),
    el("dl", {},
      ...[["Placed", when(o.created_at)], ["Customer", o.name || "—"], ["Phone", o.phone || "—"], ["Email", o.email || "—"],
        ["Ship to", [o.address, o.state, o.pincode].filter(Boolean).join(", ") || "—"], ["GSTIN", o.gstin || "—"],
        ["Order ID", o.id], ["Transaction", o.txn_id || "—"], ["Subtotal", inr(o.subtotal)], ["GST", inr(o.gst)], ["Total", inr(o.total)],
        ["Paid", inr(o.paid_paise)], ["Outstanding", inr(o.outstanding_paise)]].flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])),
    el("table", { class: "items" }, el("tbody", {}, items)),
    ...(o.payments.length ? [el("p", { class: "sub" }, o.payments.map((p) => `${inr(p.amount_paise)} ${p.method} recorded by ${p.recorded_by} on ${when(p.created_at)}`).join(" · "))] : []),
    el("div", { class: "actions" }, actions, msg, el("button", { class: "btn", type: "button", onclick: () => dlg.close() }, "Close")));
  if (!dlg.open) dlg.showModal();
}

function confirmCash(o) {
  const c = $("cdlg"), key = crypto.randomUUID(); // one key per dialog: a double click can never record twice
  const msg = el("div", { class: "msg", role: "alert" });
  const go = el("button", { class: "btn primary", type: "button" }, "Confirm " + inr(o.outstanding_paise) + " received");
  go.addEventListener("click", async () => {
    go.disabled = true;
    try { await api(`/api/orders/${o.id}/cash-received`, { confirm_amount_paise: o.outstanding_paise, idempotency_key: key }); c.close(); await open(o.id); load(); }
    catch (e) { msg.textContent = e.message; go.disabled = false; }
  });
  c.replaceChildren(el("h2", { id: "ctitle", class: "h0" }, "Confirm cash received"),
    el("p", {}, `Order ${o.id}`), el("p", {}, "Outstanding amount: ", el("b", {}, inr(o.outstanding_paise))),
    el("p", { class: "sub" }, "Only confirm after you have physically received this cash. This is recorded against your account and cannot be undone."),
    msg, el("div", { class: "actions" }, go, el("button", { class: "btn", type: "button", onclick: () => c.close() }, "Cancel")));
  c.showModal();
}

let t;
$("filters").addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { state.page = 1; load().catch(() => {}); }, 250); });
$("filters").addEventListener("submit", (e) => e.preventDefault());
$("prev").onclick = () => { state.page--; load(); };
$("next").onclick = () => { state.page++; load(); };
document.querySelectorAll("th.sort").forEach((th) => th.addEventListener("click", () => {
  state.dir = state.sort === th.dataset.sort && state.dir === "desc" ? "asc" : "desc"; state.sort = th.dataset.sort; load();
}));
$("out").onclick = async () => { await api("/api/auth/logout", {}); location.reload(); };
api("/api/me").then((m) => { $("who").textContent = m.email; }).catch(() => {});
