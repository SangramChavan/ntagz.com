// Payment links screen: make a link for a customer, send it on WhatsApp, see who opened it and who has not paid, remind them in one tap.
// Shares $, el, api, inr, when, toast, ask, newKey (app.js / products.js) and waHref (orders.js). All text goes in with textContent.
// The total shown while creating is an ESTIMATE from the server (guest prices); the customer's page shows the exact amount.
const PL = { loaded: false, data: null, status: "", q: "", page: 1, panel: null };
const PL_CHIPS = [["", "All"], ["awaiting", "Awaiting payment"], ["opened", "Opened, not paid"], ["paid", "Paid"], ["closed", "Expired / cancelled"]];
const PL_STATUS = { new: ["Not sent", "off"], sent: ["Sent", "st-placed"], opened: ["Opened, not paid", "unpaid"], paid: ["Paid", "paid"], expired: ["Expired", "off"], cancelled: ["Cancelled", "cancelled"] };
const PL_HOURS = [[6, "6 hours"], [12, "12 hours"], [24, "24 hours"], [48, "2 days"], [72, "3 days"], [168, "7 days"]];
const PL_STATES = ["Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh", "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal"];

async function plCall(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" }, body: JSON.stringify(body) });
  if (r.status === 401) { location.reload(); throw new Error("signed out"); }
  return { ok: r.ok, status: r.status, d: await r.json().catch(() => ({})) };
}
const plAgo = (ts) => { const s = Math.max(0, Math.floor(Date.now() / 1000) - ts); return s < 90 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago"; };
const plLeft = (ts) => { const s = ts - Math.floor(Date.now() / 1000); return s <= 0 ? "expired" : s < 3600 ? "in " + Math.max(1, Math.round(s / 60)) + " min" : s < 86400 ? "in " + Math.round(s / 3600) + " h" : "in " + Math.round(s / 86400) + " d"; };
const plDur = (s) => (s < 5400 ? Math.max(1, Math.round(s / 60)) + " min" : s < 172800 ? (s / 3600).toFixed(1).replace(/\.0$/, "") + " h" : Math.round(s / 86400) + " d");
const plWhen = (ts) => new Date(ts * 1000).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const plItems = (l) => l.items.map((i) => `${i.qty} × ${i.name}`).join(", ");
const plRoot = () => $("paylinks-root");

function plMessage(l, kind) {
  const first = String(l.name || "").trim().split(/\s+/)[0] || "there";
  return kind === "remind"
    ? `Hi ${first}, a quick reminder about your ntagz order (${plItems(l)}). Your payment link is still open until ${plWhen(l.expires_at)}: ${l.url}\nAnything we can help with?`
    : `Hi ${first}, thanks for your order enquiry with ntagz.\nYour order: ${plItems(l)}.\nPay securely here (UPI, cards or netbanking): ${l.url}\nThe exact total with GST and shipping is on the page. This link is valid until ${plWhen(l.expires_at)}.\nReply here if you would like any change.`;
}
async function plCopy(text, done) { try { await navigator.clipboard.writeText(text); toast(done || "Copied"); } catch { toast("Copy failed. Select the link and copy it by hand.", true); } }
// Opens WhatsApp with the message ready (the admin reads it and presses send), then records that it went out.
function plWhatsApp(l, kind, after) {
  const href = waHref(l.phone, plMessage(l, kind));
  if (!href) return toast("This phone number cannot be opened on WhatsApp", true);
  window.open(href, "_blank", "noopener");
  plCall(`/api/paylinks/${l.id}/sent`, { kind }).then(() => { if (after) after(); }, () => {});
}

// ── list ─────────────────────────────────────────────────────────────
async function plLoad() {
  try {
    const p = new URLSearchParams({ page: PL.page }); if (PL.status) p.set("status", PL.status); if (PL.q) p.set("q", PL.q);
    const r = await plCall("/api/paylinks?" + p);
    if (!r.ok) throw new Error(r.d.error || "Could not load payment links");
    PL.data = r.d; plRender();
  } catch (e) { plRoot().replaceChildren(el("p", { class: "msg" }, e.message, " ", el("button", { class: "btn small", type: "button", onclick: plLoad }, "Retry"))); }
}

function plStats(s) {
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "–");
  const parts = [["Made", s.created], ["Opened", `${s.opened} (${pct(s.opened, s.created)})`], ["Paid", `${s.paid} (${pct(s.paid, s.created)})`], ["Paid through links", inr(s.revenue_paise)],
    ["Average time to pay", s.paid ? plDur(Math.round(s.avg_secs_to_pay)) : "–"], ["Paid after taking a suggestion", s.paid_after_suggestion]];
  return el("div", { class: "stats" }, parts.map(([l, v]) => el("span", {}, el("b", {}, String(v)), " " + l)), el("span", { class: "sub" }, "(last 30 days)"));
}

function plCard(l) {
  const [label, cls] = PL_STATUS[l.status], isAgent = l.source === "agent", active = ["new", "sent", "opened"].includes(l.status);
  const meta = [`Made ${plAgo(l.created_at)} by ${isAgent ? "an AI assistant" : l.created_by}` + (active ? ` · valid ${plLeft(l.expires_at)}` : "")];
  meta.push(l.sent_at ? `Sent ${plAgo(l.sent_at)}` + (l.reminder_count ? ` · reminded ${l.reminder_count}× (last ${plAgo(l.last_reminded_at)})` : "") : isAgent ? "Created for an AI assistant to give the customer" : "Not sent yet");
  meta.push(l.open_count ? `Opened ${l.open_count}× (last ${plAgo(l.last_opened_at)})` + (l.start_count ? ` · tapped Pay ${l.start_count}×` : "") : "Not opened");
  if (l.adjusted) meta.push("Customer added " + l.items.filter((i) => i.qty > i.orig_qty).map((i) => `${i.qty - i.orig_qty} more ${i.name}`).join(", ") + " from a suggestion");
  if (l.source_order_ref) meta.push(`Replaces unpaid order ${l.source_order_ref}`);
  const amount = l.paid_total_paise != null ? el("div", { class: "pl-amt" }, inr(l.paid_total_paise), el("span", { class: "sub" }, "paid")) : l.est_paise != null ? el("div", { class: "pl-amt" }, "≈ " + inr(l.est_paise), el("span", { class: "sub" }, "estimate")) : "";
  const acts = [];
  if (active) {
    acts.push(el("button", { class: "btn primary", type: "button", onclick: () => plWhatsApp(l, l.sent_at ? "remind" : "send", plLoad) }, l.sent_at ? "Remind on WhatsApp" : "Send on WhatsApp"));
    acts.push(el("button", { class: "btn", type: "button", onclick: () => plCopy(l.url, "Link copied") }, "Copy link"));
    acts.push(el("button", { class: "btn", type: "button", onclick: () => plExtend(l) }, "Extend"));
    acts.push(el("button", { class: "btn link danger", type: "button", onclick: () => plCancel(l) }, "Cancel link"));
  } else if (l.status === "expired") {
    acts.push(el("button", { class: "btn primary", type: "button", onclick: () => plExtend(l) }, "Extend and reuse"));
    acts.push(el("button", { class: "btn", type: "button", onclick: () => plCopy(l.url, "Link copied") }, "Copy link"));
  } else if (l.status === "paid") {
    acts.push(el("a", { class: "btn", href: "#/orders?q=" + l.paid_order_ref }, "View order " + l.paid_order_ref));
  }
  const warn = l.dup_order_open ? el("div", { class: "pl-warn" }, el("span", {}, `Paid. The unpaid order ${l.source_order_ref} it replaced is still open and holds stock.`),
    el("button", { class: "btn small danger-solid", type: "button", onclick: () => plCancelDuplicate(l) }, "Cancel order " + l.source_order_ref)) : "";
  return el("div", { class: "pl-card" },
    el("div", { class: "pl-top" }, el("div", {}, el("b", {}, l.name), el("div", { class: "sub" }, `${l.phone} · ${l.state}`), el("span", { class: "pill " + cls }, label)), amount),
    el("div", { class: "pl-items" }, plItems(l)), el("div", { class: "pl-meta" }, meta.map((m) => el("span", {}, m))), warn, acts.length ? el("div", { class: "pl-actions" }, acts) : "");
}

function plRender() {
  const d = PL.data;
  const head = el("div", { class: "pv-head" }, el("div", {}, el("h1", { class: "pv-title" }, "Payment links"), el("p", { class: "sub" }, "Send a customer a link that opens their UPI app. When they pay, the order is created and marked paid automatically.")),
    el("button", { class: "btn primary", id: "plnew", type: "button", onclick: () => plPanel() }, "+ New payment link"));
  if (!d.available) return plRoot().replaceChildren(head, el("div", { class: "note warn" }, "Payment links need database migration 0020 before they can be used. Apply it, then reload this page."));
  const chips = el("div", { class: "chips", role: "group", "aria-label": "Link views" }, PL_CHIPS.map(([v, l]) => el("button", { class: "chip", type: "button", "aria-pressed": String(PL.status === v), onclick: () => { PL.status = v; PL.page = 1; plLoad(); } }, l)));
  const search = el("input", { class: "pl-search", type: "search", placeholder: "Search name or phone", "aria-label": "Search payment links", value: PL.q, autocomplete: "off" });
  let tm; search.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(() => { PL.q = search.value.trim(); PL.page = 1; plLoad(); }, 300); });
  const list = d.links.length ? el("div", { class: "pl-list" }, d.links.map(plCard)) : el("div", { class: "empty" }, el("p", {}, PL.status || PL.q ? "No links match this view." : "No payment links yet."), PL.status || PL.q ? "" : el("button", { class: "btn primary", type: "button", onclick: () => plPanel() }, "Make your first link"));
  const pager = d.pages > 1 ? el("div", { class: "pager" }, el("button", { class: "btn", type: "button", disabled: d.page <= 1, onclick: () => { PL.page--; plLoad(); } }, "Previous"), el("span", {}, `Page ${d.page} of ${d.pages}`), el("button", { class: "btn", type: "button", disabled: d.page >= d.pages, onclick: () => { PL.page++; plLoad(); } }, "Next")) : "";
  const hadFocus = document.activeElement === document.querySelector(".pl-search");
  plRoot().replaceChildren(head, plStats(d.stats), chips, search, list, pager);
  if (hadFocus) { const s = document.querySelector(".pl-search"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

// ── row actions ──────────────────────────────────────────────────────
function plExtend(l) {
  const hours = el("select", { id: "plhours" }, PL_HOURS.map(([h, t]) => el("option", { value: String(h), ...(h === 24 ? { selected: "" } : {}) }, t)));
  actionDialog("Extend payment link", [el("p", {}, `${l.name}: ${plItems(l)}`), el("p", { class: "sub" }, "The customer's price is always recalculated when they open the link, so extending never locks an old price."), labeled("plhours", "Valid for another", hours)], "Extend", {
    onSubmit: async (msg) => { const r = await plCall(`/api/paylinks/${l.id}/extend`, { hours: Number(hours.value) }); if (!r.ok) { msg.textContent = r.d.error || "Could not extend"; throw new Error(r.d.error || "Could not extend"); } $("adlg").close(); toast("Link extended"); plLoad(); },
  });
}
async function plCancel(l) {
  if (!(await ask("Cancel this payment link?", [`${l.name}: ${plItems(l)}`, "The customer will see that it was cancelled and can no longer pay with it."], "Cancel link", true))) return;
  const r = await plCall(`/api/paylinks/${l.id}/cancel`, {}); toast(r.ok ? "Link cancelled" : r.d.error || "Could not cancel", !r.ok); plLoad();
}
async function plCancelDuplicate(l) {
  if (!(await ask("Cancel the old unpaid order?", [`Order ${l.source_order_ref} was replaced by the payment link that was just paid. Cancelling it puts its reserved stock back.`], "Cancel order", true))) return;
  try { await api(`/api/orders/${l.source_order_id}/status`, { to: "cancelled", confirm: true, idempotency_key: newKey() }); toast("Old order cancelled"); } catch (e) { toast(e.message, true); }
  plLoad();
}

// ── create panel ─────────────────────────────────────────────────────
const plFld = (id, label, input, hint) => el("div", { class: "field", id: "plf-" + id }, el("label", { for: id }, label), input, hint ? el("div", { class: "hint" }, hint) : "", el("div", { class: "err", role: "alert" }));
function plShowErrors(fields) {
  document.querySelectorAll("#plpanel .field").forEach((f) => { f.classList.remove("bad"); const e = f.querySelector(".err"); if (e) e.textContent = ""; });
  let first = null;
  for (const [k, m] of Object.entries(fields || {})) { const f = $("plf-" + k); if (f) { f.classList.add("bad"); f.querySelector(".err").textContent = m; first = first || f; } }
  if (first) { const i = first.querySelector("input,select,textarea"); if (i) i.focus(); }
}

// opts: { orderId } prefills from an unpaid order (the "Send payment link" button in the order panel)
async function plPanel(opts = {}) {
  if (!PL.data) { try { const r = await plCall("/api/paylinks"); if (!r.ok) throw 0; PL.data = r.d; } catch { return toast("Could not load the product list", true); } }
  if (!PL.data.available) return toast("Apply database migration 0020 first", true);
  const catalog = PL.data.catalog, st = { items: [{ id: "", qty: "" }], source: null };
  const phone = el("input", { id: "plphone", inputmode: "tel", autocomplete: "off", placeholder: "10-digit mobile" });
  const name = el("input", { id: "plname", autocomplete: "off", maxlength: "100" }), email = el("input", { id: "plemail", type: "email", autocomplete: "off" });
  const addr = el("textarea", { id: "pladdress", maxlength: "500", placeholder: "House / plot, street, area, city" });
  const pin = el("input", { id: "plpincode", inputmode: "numeric", maxlength: "6", autocomplete: "off" });
  const state = el("select", { id: "plstate" }, el("option", { value: "" }, "Choose…"), PL_STATES.map((s) => el("option", { value: s }, s)));
  const gst = el("input", { id: "plgstin", maxlength: "15", autocapitalize: "characters", placeholder: "Optional" });
  const hours = el("select", { id: "plhours2" }, PL_HOURS.map(([h, t]) => el("option", { value: String(h), ...(h === 24 ? { selected: "" } : {}) }, t)));
  const note = el("input", { id: "plnote", maxlength: "500", placeholder: "Optional, only you see this" });
  const known = el("div", { id: "plknown" }), rows = el("div", { id: "plitems" }), est = el("div", { class: "pl-est", "aria-live": "polite" }, "Add a product to see the estimate."), msg = el("div", { class: "msg", role: "alert" });
  const submit = el("button", { class: "btn primary", type: "submit", id: "plsubmit" }, "Create link");
  const body = () => ({ name: name.value, phone: phone.value, email: email.value, address: addr.value, pincode: pin.value, state: state.value, gstin: gst.value, note: note.value, expires_in_hours: Number(hours.value),
    items: st.items.filter((i) => i.id && Number(i.qty) > 0).map((i) => ({ id: i.id, qty: Number(i.qty) })), ...(st.source ? { source_order_id: st.source } : {}) });

  let et; const estimate = () => { clearTimeout(et); et = setTimeout(async () => {
    const b = body(); if (!b.items.length) { est.className = "pl-est"; est.textContent = "Add a product to see the estimate."; return; }
    const r = await plCall("/api/paylinks", { dry_run: true, state: b.state, items: b.items });
    est.className = "pl-est" + (r.ok ? "" : " bad");
    est.textContent = r.ok ? `Estimated total ≈ ${inr(r.d.est_paise)} including GST${b.state ? " and shipping" : " (choose a state to include shipping)"}. The customer's page shows the exact amount, using today's prices.` : (r.d.error || "Check the items");
  }, 400); };

  const drawRows = () => {
    rows.replaceChildren(...st.items.map((it, i) => {
      const sel = el("select", { "aria-label": "Product" }, el("option", { value: "" }, "Choose a product…"), catalog.map((p) => el("option", { value: p.id, ...(p.id === it.id ? { selected: "" } : {}) }, `${p.name} (${inr(p.price * 100)})`)));
      const p = catalog.find((x) => x.id === it.id), qty = el("input", { inputmode: "numeric", value: String(it.qty || ""), placeholder: p ? "min " + p.min : "Qty", "aria-label": "Quantity" });
      sel.addEventListener("change", () => { it.id = sel.value; const c = catalog.find((x) => x.id === it.id); if (c && !it.qty) it.qty = c.min; drawRows(); estimate(); });
      qty.addEventListener("input", () => { it.qty = qty.value.replace(/\D/g, ""); estimate(); });
      return el("div", { class: "pl-item" }, sel, qty, el("button", { class: "btn small", type: "button", "aria-label": "Remove", onclick: () => { st.items.splice(i, 1); if (!st.items.length) st.items.push({ id: "", qty: "" }); drawRows(); estimate(); } }, "✕"));
    }));
  };
  const fill = (c) => { if (c.name) name.value = c.name; if (c.email) email.value = c.email; if (c.address) addr.value = c.address; if (c.pincode) pin.value = c.pincode; if (c.state) state.value = c.state; if (c.gstin) gst.value = c.gstin; };
  const setItems = (its) => { st.items = its.map((i) => ({ id: i.id, qty: String(i.qty) })); drawRows(); estimate(); };

  const lookup = async () => {
    const digits = phone.value.replace(/\D/g, "").slice(-10); if (digits.length !== 10) { known.replaceChildren(); return; }
    const r = await plCall("/api/paylinks/prefill?phone=" + digits); if (!r.ok || !r.d.found) { known.replaceChildren(); return; }
    const d = r.d, box = el("div", { class: "pl-known" });
    box.appendChild(el("div", { class: "row" }, el("span", {}, el("b", {}, "Returning customer: " + (d.customer.name || digits)), ` · ${d.orders} order${d.orders > 1 ? "s" : ""}, last ${plAgo(d.last_order_at)}`), el("button", { class: "btn small", type: "button", onclick: () => { fill(d.customer); estimate(); toast("Saved details filled in"); } }, "Use saved details")));
    if (d.last_paid_items.length) box.appendChild(el("div", { class: "row" }, el("span", {}, "Last paid order: " + d.last_paid_items.map((i) => `${i.qty} × ${i.name}`).join(", ")), el("button", { class: "btn small", type: "button", onclick: () => setItems(d.last_paid_items) }, "Reorder these")));
    d.unpaid_orders.forEach((o) => box.appendChild(el("div", { class: "row" }, el("span", {}, `Unpaid order ${o.ref} (${inr(o.total_paise)}): ` + o.items.map((i) => `${i.qty} × ${i.name}`).join(", ")), el("button", { class: "btn small", type: "button", onclick: () => { st.source = o.id; setItems(o.items); fill(d.customer); box.appendChild(el("p", { class: "sub" }, `This link will replace order ${o.ref}. After the customer pays, cancel that order from the list.`)); } }, "Replace with a link"))));
    known.replaceChildren(box);
  };
  let lt; phone.addEventListener("input", () => { clearTimeout(lt); lt = setTimeout(lookup, 350); });
  state.addEventListener("change", estimate);

  const form = el("form", { class: "form", novalidate: "", id: "plform" },
    plFld("phone", "Customer's phone", phone, "We look for earlier orders so you can reuse their address and GST number"), known,
    plFld("name", "Name", name), plFld("address", "Delivery address", addr), el("div", { class: "two" }, plFld("pincode", "Pincode", pin), plFld("state", "State", state)),
    el("div", { class: "two" }, plFld("email", "Email", email), plFld("gstin", "GST number", gst)),
    el("div", { class: "field", id: "plf-items" }, el("label", {}, "Products"), rows, el("button", { class: "btn small", type: "button", onclick: () => { st.items.push({ id: "", qty: "" }); drawRows(); } }, "+ Add product"), el("div", { class: "err", role: "alert" })), est,
    plFld("expires_in_hours", "Link valid for", hours, "After this the customer must ask for a new link. Prices are recalculated every time the link is opened."), plFld("note", "Internal note", note), msg,
    el("div", { class: "panel-actions" }, submit, el("button", { class: "btn", type: "button", onclick: () => $("plpanel").close() }, "Cancel")));
  $("plpanel").replaceChildren(el("div", { class: "panel-head" }, el("h2", { id: "pltitle", class: "h0" }, "New payment link"), el("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: () => $("plpanel").close() }, "✕")), form);
  drawRows(); if (!$("plpanel").open) $("plpanel").showModal(); phone.focus();

  if (opts.orderId) { const r = await plCall("/api/paylinks/prefill?order=" + encodeURIComponent(opts.orderId)); if (r.ok) { st.source = r.d.order.id; phone.value = r.d.customer.phone || ""; fill(r.d.customer); setItems(r.d.order.items); lookup(); known.before(el("p", { class: "sub" }, `This link will replace unpaid order ${r.d.order.ref}. After the customer pays, cancel that order from the Payment links list.`)); } }

  form.addEventListener("submit", async (e) => {
    e.preventDefault(); if (submit.disabled) return; msg.textContent = ""; plShowErrors({}); submit.disabled = true; submit.textContent = "Creating…";
    try {
      const r = await plCall("/api/paylinks", body());
      if (!r.ok) { plShowErrors(r.d.fields); msg.textContent = r.d.error || "Could not create the link"; return; }
      PL.status = ""; PL.q = ""; PL.page = 1; plLoad();
      const l = { ...body(), id: r.d.id, url: r.d.url, expires_at: r.d.expires_at, items: body().items.map((i) => ({ ...i, name: (catalog.find((c) => c.id === i.id) || {}).name || i.id })) };
      plCreated(l, r.d.est_paise);
    } catch { msg.textContent = "Network problem. Nothing was lost; your entries are still here."; }
    finally { submit.disabled = false; submit.textContent = "Create link"; }
  });
}

// The link exists: show it, with the message ready to send.
function plCreated(l, estPaise) {
  const url = el("input", { class: "pl-url", readonly: "", value: l.url, "aria-label": "Payment link" }); url.addEventListener("focus", () => url.select());
  $("plpanel").replaceChildren(el("div", { class: "panel-head" }, el("h2", { id: "pltitle", class: "h0" }, "Link ready"), el("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: () => $("plpanel").close() }, "✕")),
    el("div", { class: "form" }, el("p", {}, `For ${l.name} (${l.phone}). Estimated total ≈ ${inr(estPaise)}. Valid until ${plWhen(l.expires_at)}.`), url, el("h3", { class: "sec" }, "Message"), el("div", { class: "pl-msg" }, plMessage(l, "send")),
      el("div", { class: "panel-actions" }, el("button", { class: "btn primary", type: "button", onclick: () => plWhatsApp(l, "send", () => { $("plpanel").close(); plLoad(); }) }, "Send on WhatsApp"),
        el("button", { class: "btn", type: "button", onclick: () => plCopy(l.url, "Link copied") }, "Copy link"), el("button", { class: "btn", type: "button", onclick: () => plCopy(plMessage(l, "send"), "Message copied") }, "Copy message"), el("button", { class: "btn link", type: "button", onclick: () => $("plpanel").close() }, "Done"))));
}

window.paylinksVisible = (on) => { if (on && !PL.loaded) { PL.loaded = true; plLoad(); } else if (on) plLoad(); };
window.openPayLinkFor = (orderId) => { location.hash = "#/paylinks"; setTimeout(() => plPanel({ orderId }), 50); };
