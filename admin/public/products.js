// Products screen: list, inline price/stock, add/edit side panel, duplicate, safe delete. Shares $, el, api, inr, when with app.js.
// All text is inserted with textContent: product data is never parsed as HTML.
const P = { page: 1, pages: 1, loaded: false, cats: [] };
const FILTERS = ["pq", "pcat", "pactive", "pstock", "psort"];
const FKEY = "ntagz.admin.pfilters";
const IMG_BASE = "https://www.ntagz.com/";
const imgSrc = (u) => (u ? (u.startsWith("http") ? u : IMG_BASE + u) : "");
const rupees = (paise) => (paise / 100).toFixed(2);
const STOCK_LABEL = { in: "In stock", low: "Low stock", out: "Out of stock" };

let toastTimer;
function toast(msg, bad) { const t = $("toast"); t.textContent = msg; t.className = bad ? "err" : ""; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500); }
const newKey = () => crypto.randomUUID();

// ── filters (kept in sessionStorage so they survive switching tabs or reloads) ──
function restoreFilters() { try { const f = JSON.parse(sessionStorage.getItem(FKEY) || "{}"); for (const id of FILTERS) if (f[id] !== undefined && $(id)) $(id).value = f[id]; } catch { /* ignore */ } }
function persistFilters() { try { sessionStorage.setItem(FKEY, JSON.stringify(Object.fromEntries(FILTERS.map((id) => [id, $(id).value])))); } catch { /* ignore */ } }
const filtersActive = () => ["pq", "pcat", "pactive", "pstock"].some((id) => $(id).value);
function clearFilters() { ["pq", "pcat", "pactive", "pstock"].forEach((id) => { $(id).value = ""; }); persistFilters(); P.page = 1; loadProducts(); }
function pparams() {
  const q = new URLSearchParams();
  for (const [id, k] of [["pq", "q"], ["pcat", "category"], ["pstock", "stock"], ["pactive", "active"]]) if ($(id).value) q.set(k, $(id).value);
  const [sort, dir] = $("psort").value.split(":"); q.set("sort", sort); q.set("dir", dir); q.set("page", P.page);
  return q;
}

// ── small building blocks ────────────────────────────────────────────
function thumb(p) { return p.image_url ? el("img", { class: "thumb", src: imgSrc(p.image_url), alt: "", loading: "lazy", width: "40", height: "40" }) : el("span", { class: "thumb" }); }
const stockNote = (p) => el("span", { class: "stock-note " + p.stock_status }, el("i", { class: "dot", "aria-hidden": "true" }), STOCK_LABEL[p.stock_status],
  p.preorder_enabled ? el("span", { class: "pill pre" }, "Pre-order") : "", p.preordered_qty > 0 ? el("span", { class: "pre-note" }, `${p.preordered_qty} pre-ordered`) : "");

function commitOnEnter(input) { input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); else if (e.key === "Escape") { input.value = input.defaultValue; input.blur(); } }); }

function priceInput(p) {
  const input = el("input", { class: "inl", inputmode: "decimal", value: rupees(p.price_paise), "aria-label": `Selling price for ${p.name} in rupees` });
  commitOnEnter(input);
  input.addEventListener("change", async () => {
    const raw = input.value.trim(), num = Number(raw), paise = Math.round(num * 100);
    const revert = () => { input.value = rupees(p.price_paise); input.classList.remove("bad"); };
    if (raw === "" || !Number.isFinite(num) || num < 0 || Math.abs(paise - num * 100) > 1e-6) { input.classList.add("bad"); toast("Enter a valid price in rupees (max 2 decimals)", true); setTimeout(revert, 1200); return; }
    if (paise === p.price_paise) return revert();
    if (!(await ask("Confirm price change", [`${p.name}: ${inr(p.price_paise)} → ${inr(paise)}`, "Applies to future purchases only; past orders keep their prices."], "Save price"))) return revert();
    input.disabled = true;
    try { await api(`/api/products/${p.id}`, { price: raw }); toast(`Price saved: ${p.name} is now ${inr(paise)}`); } catch (e) { toast(e.message, true); }
    refresh();
  });
  return el("span", { class: "inl-wrap" }, el("span", {}, "₹"), input);
}

function stockInput(p) {
  const input = el("input", { class: "inl stock", inputmode: "numeric", value: String(p.stock_qty), "aria-label": `Stock for ${p.name}` });
  commitOnEnter(input);
  input.addEventListener("change", async () => {
    const raw = input.value.trim(), n = Number(raw);
    const revert = () => { input.value = String(p.stock_qty); input.classList.remove("bad"); };
    if (raw === "" || !Number.isInteger(n) || n < 0 || n > 1000000) { input.classList.add("bad"); toast("Stock must be a whole number, 0 or more", true); setTimeout(revert, 1200); return; }
    if (n === p.stock_qty) return revert();
    const reason = await askReason("Confirm stock count", `${p.name}: ${p.stock_qty} → ${n} ${p.unit} (${n - p.stock_qty > 0 ? "+" : ""}${n - p.stock_qty}). Recorded in stock history.`, "Stock count correction");
    if (reason === null) return revert();
    input.disabled = true;
    try { await api(`/api/products/${p.id}/stock`, { type: "set", quantity: String(n), expected_stock: p.stock_qty, reason, idempotency_key: newKey() }); toast(`Stock saved: ${p.name} is now ${n}`); } catch (e) { toast(e.message, true); }
    refresh();
  });
  return el("span", { class: "inl-wrap" }, input);
}

function statusSwitch(p) {
  const b = el("button", { class: "switch", type: "button", role: "switch", "aria-checked": String(p.active), "aria-label": `${p.name} is ${p.active ? "active" : "inactive"}. Toggle.` }, el("i", { class: "knob" }), el("span", {}, p.active ? "Active" : "Inactive"));
  b.addEventListener("click", () => toggleActive(p));
  return b;
}

function actions(p) {
  return el("div", { class: "rowact" },
    el("button", { class: "btn small", type: "button", onclick: () => openPanel(p.id) }, "Edit"),
    el("button", { class: "btn small", type: "button", onclick: () => duplicate(p) }, "Duplicate"),
    el("button", { class: "btn small danger", type: "button", onclick: () => deleteProduct(p) }, "Delete"));
}

// ── list ─────────────────────────────────────────────────────────────
async function loadSummary() {
  const s = await api("/api/products/summary");
  P.cats = s.categories;
  $("ptiles").replaceChildren(...[["Total products", s.total], ["Active", s.active], ["Low stock", s.low], ["Out of stock", s.out]].map(([l, v]) => el("span", {}, el("b", {}, String(v)), " " + l)));
  const cur = $("pcat").value;
  $("pcat").replaceChildren(el("option", { value: "" }, "All categories"), ...s.categories.map((c) => { const o = el("option", { value: c }, c); if (c === cur) o.selected = true; return o; }));
  return s;
}

function emptyState(total) {
  if (filtersActive()) return el("div", { class: "empty" }, el("p", {}, "No products match your search or filters."), el("button", { class: "btn", type: "button", onclick: clearFilters }, "Clear filters"));
  if (total === 0) return el("div", { class: "empty" }, el("p", {}, "No products yet."), el("button", { class: "btn primary", type: "button", onclick: () => openPanel(null) }, "Add your first product"));
  return el("div", { class: "empty" }, el("p", {}, "Nothing to show."));
}

async function loadProducts() {
  $("plist").replaceChildren(el("p", { class: "sub" }, "Loading…")); $("prows").replaceChildren();
  try {
    const d = await api("/api/products?" + pparams());
    P.pages = d.pages; P.page = d.page;
    $("ppageInfo").textContent = `Page ${d.page} of ${d.pages} · ${d.total} products`;
    $("pprev").disabled = d.page <= 1; $("pnext").disabled = d.page >= d.pages;
    if (!d.products.length) { const e = emptyState(d.total); $("plist").replaceChildren(e); $("prows").replaceChildren(el("tr", {}, el("td", { colspan: "7" }, emptyState(d.total)))); return; }
    $("plist").replaceChildren(...d.products.map((p) => el("div", { class: "prow" },
      el("div", { class: "top" }, thumb(p), el("div", { class: "grow" }, el("button", { class: "name", type: "button", onclick: () => openPanel(p.id) }, p.name), el("div", { class: "sub" }, `${p.sku} · ${p.category}`)), statusSwitch(p)),
      el("div", { class: "editrow" }, el("label", {}, "Price", priceInput(p)), el("label", {}, "Stock", stockInput(p), stockNote(p))),
      actions(p))));
    $("prows").replaceChildren(...d.products.map((p) => el("tr", {},
      el("td", {}, el("div", { class: "pcell" }, thumb(p), el("button", { class: "name", type: "button", onclick: () => openPanel(p.id) }, p.name))),
      el("td", { class: "mono" }, p.sku), el("td", {}, p.category), el("td", {}, priceInput(p)),
      el("td", {}, stockInput(p), stockNote(p)), el("td", {}, statusSwitch(p)), el("td", {}, actions(p)))));
  } catch (e) {
    $("plist").replaceChildren(el("p", { class: "msg" }, "Could not load products: " + e.message, " ", el("button", { class: "btn small", type: "button", onclick: loadProducts }, "Retry")));
    $("prows").replaceChildren();
  }
}
const refresh = () => Promise.all([loadSummary(), loadProducts()]);

// ── dialogs (resolve from buttons, not only the close event) ─────────
function ask(title, lines, okLabel, danger) {
  return new Promise((res) => {
    const d = $("kdlg"); let done = false;
    const finish = (v) => { if (done) return; done = true; if (d.open) d.close(); res(v); };
    d.replaceChildren(el("h2", { id: "kdtitle", class: "h0" }, title), ...lines.map((l) => el("p", {}, l)),
      el("div", { class: "actions" }, el("button", { class: "btn " + (danger ? "danger-solid" : "primary"), type: "button", onclick: () => finish(true) }, okLabel), el("button", { class: "btn", type: "button", onclick: () => finish(false) }, "Cancel")));
    d.onclose = () => finish(false); d.showModal();
  });
}
function askReason(title, line, defaultReason) {
  return new Promise((res) => {
    const d = $("kdlg"), reason = el("input", { id: "kreason", value: defaultReason, maxlength: "200", "aria-label": "Reason" }); let done = false;
    const finish = (v) => { if (done) return; done = true; if (d.open) d.close(); res(v); };
    const ok = () => { if (reason.value.trim().length < 3) { reason.classList.add("bad"); return; } finish(reason.value.trim()); };
    d.replaceChildren(el("h2", { id: "kdtitle", class: "h0" }, title), el("p", {}, line),
      el("div", { class: "field" }, el("label", { for: "kreason" }, "Reason (required)"), reason),
      el("div", { class: "actions" }, el("button", { class: "btn primary", type: "button", onclick: ok }, "Save stock"), el("button", { class: "btn", type: "button", onclick: () => finish(null) }, "Cancel")));
    d.onclose = () => finish(null); d.showModal(); reason.select();
  });
}

// ── row actions ──────────────────────────────────────────────────────
async function toggleActive(p) {
  const to = !p.active;
  if (!to && !(await ask("Deactivate product?", [`${p.name} will disappear from the storefront and checkout. History and past orders are kept.`], "Deactivate"))) return;
  try { await api(`/api/products/${p.id}/active`, { active: to }); toast(`${p.name} is now ${to ? "active" : "inactive"}`); } catch (e) { toast(e.message, true); }
  refresh();
}
async function duplicate(p) {
  try { const c = await api(`/api/products/${p.id}/duplicate`, {}); toast("Copy created. It is inactive with 0 stock until you review it."); await refresh(); openPanel(c.id); } catch (e) { toast(e.message, true); }
}
async function deleteProduct(p, fromPanel) {
  if (!(await ask("Delete product?", [`${p.name} (${p.sku}) will be removed.`, "If it has orders or stock history it is deactivated instead, so records are never lost."], "Delete", true))) return;
  try {
    const r = await fetch(`/api/products/${p.id}/delete`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" }, body: "{}" });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) return location.reload();
    if (r.status === 409 && d.deactivate) {
      if (p.active && (await ask("Deactivate instead?", [d.error], "Deactivate"))) await api(`/api/products/${p.id}/active`, { active: false });
      else if (!p.active) toast("This product is part of the storefront catalogue, so it stays (inactive).");
    } else if (!r.ok) throw new Error(d.error || "Could not delete");
    else toast(d.deleted ? `${p.name} deleted` : d.message);
    if (fromPanel) closePanel(true);
  } catch (e) { toast(e.message, true); }
  refresh();
}

// ── add / edit side panel ────────────────────────────────────────────
const PANEL = { id: null, snapshot: "", dirty: false, saving: false };
const fval = (id) => { const n = $(id); return n ? (n.type === "checkbox" ? String(n.checked) : n.value) : ""; };
const FORM_IDS = ["name", "price", "opening_stock", "sku", "description", "category", "image_url", "cost", "low_stock_threshold", "mrp", "gst_rate", "active", "track_stock", "preorder_enabled", "preorder_message", "preorder_dispatch", "preorder_max"];
const snapshot = () => JSON.stringify(FORM_IDS.map(fval));
const markDirty = () => { PANEL.dirty = snapshot() !== PANEL.snapshot; };

function field(id, label, input, opts = {}) {
  return el("div", { class: "field", id: "f-" + id }, el("label", { for: id }, label, opts.required ? el("span", { class: "req", "aria-hidden": "true" }, " *") : ""), input, opts.hint ? el("div", { class: "hint" }, opts.hint) : "", el("div", { class: "err", id: "e-" + id, role: "alert" }));
}
function showErrors(fields) {
  document.querySelectorAll("#ppanel .field").forEach((f) => { f.classList.remove("bad"); const e = f.querySelector(".err"); if (e) e.textContent = ""; });
  const map = { stock: "opening_stock" }; let first = null;
  for (const [k, m] of Object.entries(fields || {})) { const f = $("f-" + (map[k] || k)); if (f) { f.classList.add("bad"); const e = f.querySelector(".err"); if (e) e.textContent = m; first = first || f; } }
  if (first) { const more = first.closest("details"); if (more) more.open = true; first.querySelector("input,select,textarea").focus(); }
}

async function openPanel(id) {
  let p = null;
  if (id) { try { p = await api("/api/products/" + id); } catch (e) { return toast(e.message, true); } }
  PANEL.id = id; PANEL.saving = false;
  const v = (k, d = "") => (p && p[k] != null ? String(p[k]) : d);
  const cats = P.cats.length ? P.cats : ["nfc"];
  const name = el("input", { id: "name", value: v("name"), maxlength: "120", autocomplete: "off" });
  const price = el("input", { id: "price", value: p ? rupees(p.price_paise) : "", inputmode: "decimal", placeholder: "0.00" });
  const stock = el("input", { id: "opening_stock", value: p ? String(p.stock_qty) : "0", inputmode: "numeric" });
  const sku = el("input", { id: "sku", value: v("sku"), maxlength: "32", autocapitalize: "characters", placeholder: "Auto-generated if left blank" });
  const desc = el("textarea", { id: "description", maxlength: "2000", placeholder: "Short description (optional)" }); desc.value = v("description");
  const cat = el("input", { id: "category", value: v("category", cats[0]), list: "catlist" });
  const img = el("input", { id: "image_url", value: v("image_url"), placeholder: "images/product.jpg" });
  const cost = el("input", { id: "cost", value: p && p.cost_paise != null ? rupees(p.cost_paise) : "", inputmode: "decimal", placeholder: "Optional" });
  const thr = el("input", { id: "low_stock_threshold", value: v("low_stock_threshold", "10"), inputmode: "numeric" });
  const mrp = el("input", { id: "mrp", value: p && p.mrp_paise != null ? rupees(p.mrp_paise) : "", inputmode: "decimal", placeholder: "Optional" });
  const gst = el("select", { id: "gst_rate" }, [0, 5, 12, 18, 28].map((r) => { const o = el("option", { value: String(r) }, r + "%"); if (r === (p ? p.gst_rate : 18)) o.selected = true; return o; }));
  const active = el("input", { id: "active", type: "checkbox" }); active.checked = p ? p.active : true;
  const track = el("input", { id: "track_stock", type: "checkbox" }); track.checked = !!(p && p.track_stock);

  const pre = el("input", { id: "preorder_enabled", type: "checkbox" }); pre.checked = !!(p && p.preorder_enabled);
  const preMsg = el("input", { id: "preorder_message", value: v("preorder_message"), maxlength: "200", placeholder: "Shown to customers, e.g. Ships after the next batch arrives" });
  const preDisp = el("input", { id: "preorder_dispatch", value: v("preorder_dispatch"), maxlength: "100", placeholder: "e.g. Within 7-10 business days" });
  const preMax = el("input", { id: "preorder_max", value: v("preorder_max"), inputmode: "numeric", placeholder: "No limit" });
  const syncPre = () => { // pre-orders need stock tracking
    if (!track.checked) pre.checked = false;
    pre.disabled = !track.checked; [preMsg, preDisp, preMax].forEach((x) => { x.disabled = !pre.checked; });
  };
  track.addEventListener("change", syncPre); pre.addEventListener("change", syncPre); syncPre();

  const save = el("button", { class: "btn primary", id: "psave", type: "submit" }, "Save Product");
  const again = p ? "" : el("button", { class: "btn", id: "psaveagain", type: "button" }, "Save & Add Another");
  const msg = el("div", { class: "msg", id: "pmsg", role: "alert" });
  const form = el("form", { class: "form", novalidate: "", id: "pform" },
    field("name", "Product Name", name, { required: true }),
    el("div", { class: "two" }, field("price", "Selling Price (₹)", price, { required: true, hint: "Excluding GST" }), field("opening_stock", p ? "Stock Quantity" : "Stock Quantity", stock, { required: true })),
    field("sku", "SKU", sku), field("category", "Category", cat), field("description", "Description", desc),
    el("div", { class: "two" }, field("cost", "Cost Price (₹)", cost), field("low_stock_threshold", "Low Stock Alert", thr, { hint: "Warn at or below this" })),
    field("image_url", "Product Image", img, { hint: "Path in the site's images folder or an ntagz.com image URL" }),
    el("div", { class: "field" }, el("label", { class: "check" }, active, " Active (available to customers)")),
    el("details", { class: "more" }, el("summary", {}, "More options"),
      el("div", { class: "two" }, field("mrp", "MRP / List Price (₹)", mrp), field("gst_rate", "GST Rate", gst)),
      el("div", { class: "field" }, el("label", { class: "check" }, track, " Track stock on the storefront"), el("div", { class: "hint" }, "On: checkout blocks quantities above stock and deducts sold units. Turn on after a stock count.")),
      el("div", { class: "field", id: "f-preorder_enabled" }, el("label", { class: "check" }, pre, " Allow pre-orders"), el("div", { class: "hint" }, "When stock runs out, customers can still order. Needs stock tracking. Ready stock ships first; the rest is a pre-order you fulfil later."), el("div", { class: "err", id: "e-preorder_enabled", role: "alert" })),
      field("preorder_message", "Pre-order message", preMsg), field("preorder_dispatch", "Expected dispatch", preDisp),
      field("preorder_max", "Max pre-order quantity", preMax, { hint: "Leave blank for no limit" }),
      p ? el("div", { class: "hint" }, `Pre-ordered so far: ${p.preordered_qty} (updated automatically, not editable)`) : ""),
    el("datalist", { id: "catlist" }, cats.map((c) => el("option", { value: c }))), msg,
    el("div", { class: "panel-actions" }, save, again, el("button", { class: "btn", type: "button", onclick: () => requestClose() }, "Cancel")));
  const extras = p ? el("div", { class: "panel-extra" },
    el("button", { class: "btn link", type: "button", onclick: () => stockDialog(p.id) }, "Adjust stock (in / out) and history"),
    el("button", { class: "btn link", type: "button", onclick: () => { closePanel(true); duplicate(p); } }, "Duplicate"),
    el("button", { class: "btn link danger", type: "button", onclick: () => deleteProduct(p, true) }, "Delete")) : "";
  $("ppanel").replaceChildren(el("div", { class: "panel-head" }, el("h2", { id: "pptitle", class: "h0" }, p ? "Edit Product" : "Add Product"), el("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: () => requestClose() }, "✕")), form, extras);

  const submit = async (another) => {
    if (PANEL.saving) return; // duplicate-submit guard
    showErrors({}); $("pmsg").textContent = "";
    const body = { name: name.value, sku: sku.value, description: desc.value, category: cat.value, image_url: img.value, price: price.value, mrp: mrp.value, cost: cost.value, gst_rate: Number(gst.value), low_stock_threshold: thr.value, active: active.checked, track_stock: track.checked, preorder_enabled: pre.checked, preorder_message: preMsg.value, preorder_dispatch: preDisp.value, preorder_max: preMax.value };
    if (!p) body.opening_stock = stock.value;
    const notes = [];
    if (body.preorder_enabled && !(p && p.preorder_enabled)) notes.push("Pre-orders turn on: customers can order beyond ready stock and the extra units are tracked as pre-orders.");
    if (p) {
      const np = Number(price.value);
      if (price.value.trim() !== "" && Number.isFinite(np) && np >= 0 && Math.round(np * 100) !== p.price_paise) notes.push(`Price: ${inr(p.price_paise)} → ${inr(Math.round(np * 100))}. Applies to future purchases only; past orders keep their prices.`);
      if (sku.value.trim() && sku.value.trim().toUpperCase() !== p.sku) notes.push(`SKU: ${p.sku} → ${sku.value.trim().toUpperCase()}.`);
      if (!body.active && p.active) notes.push("The product will become inactive and disappear from the storefront and checkout.");
      if (body.track_stock && !p.track_stock) notes.push(`Stock tracking turns on: customers can't order more than the current stock (${p.stock_qty}).`);
    }
    if (notes.length && !(await ask("Confirm changes", notes, "Save changes"))) return;
    PANEL.saving = true; save.disabled = true; if (again) again.disabled = true; save.textContent = "Saving…";
    try {
      const r = await fetch(p ? `/api/products/${p.id}` : "/api/products", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) return location.reload();
      if (!r.ok) { showErrors(d.fields); $("pmsg").textContent = d.error || "Could not save"; return; }
      if (p) { // stock edited in the form is recorded as a count correction, never a silent overwrite
        const n = Number(stock.value);
        if (stock.value.trim() === "" || !Number.isInteger(n) || n < 0) { showErrors({ opening_stock: "Stock must be a whole number, 0 or more" }); $("pmsg").textContent = "Details saved, but stock was not changed."; await refresh(); return; }
        if (n !== p.stock_qty) {
          try { await api(`/api/products/${p.id}/stock`, { type: "set", quantity: String(n), expected_stock: p.stock_qty, reason: "Edited in product form", idempotency_key: newKey() }); }
          catch (e) { $("pmsg").textContent = "Details saved, but stock was not changed: " + e.message; await refresh(); return; }
        }
      }
      toast(p ? "Product saved" : `Product added: ${d.name}`);
      if (!p) { ["pq", "pcat", "pactive", "pstock"].forEach((x) => { $(x).value = ""; }); $("psort").value = "newest:desc"; persistFilters(); P.page = 1; }
      if (another) { PANEL.dirty = false; await refresh(); openPanel(null); return; }
      closePanel(true); await refresh();
    } catch { $("pmsg").textContent = "Network error. Nothing was lost; your entries are still here."; }
    finally { PANEL.saving = false; save.disabled = false; if (again) again.disabled = false; save.textContent = "Save Product"; }
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); submit(false); });
  if (again) again.addEventListener("click", () => submit(true));
  form.addEventListener("input", markDirty); form.addEventListener("change", markDirty);
  PANEL.snapshot = snapshot_after(); PANEL.dirty = false;
  if (!$("ppanel").open) $("ppanel").showModal();
  name.focus();
}
function snapshot_after() { return snapshot(); }

async function requestClose() {
  if (PANEL.dirty && !(await ask("Discard changes?", ["You have unsaved changes in this form."], "Discard", true))) return;
  closePanel(true);
}
function closePanel(force) { PANEL.dirty = false; const d = $("ppanel"); if (d.open) d.close(); }
$("ppanel").addEventListener("cancel", (e) => { if (PANEL.dirty) { e.preventDefault(); requestClose(); } }); // Esc with unsaved changes
window.addEventListener("beforeunload", (e) => { if (PANEL.dirty && $("ppanel").open) { e.preventDefault(); e.returnValue = ""; } });

// ── stock in/out dialog with history (unchanged behaviour) ───────────
async function stockDialog(id) {
  const p = await api("/api/products/" + id), key = newKey();
  const type = el("select", { id: "stype" }, [["in", "Stock In (received)"], ["out", "Stock Out (damaged / lost)"], ["set", "Set Actual Stock (physical count)"]].map(([v, l]) => el("option", { value: v }, l)));
  const qty = el("input", { id: "squantity", inputmode: "numeric", required: "" });
  const reason = el("input", { id: "sreason", maxlength: "200", required: "", placeholder: "e.g. Supplier delivery, damaged in transit, physical count" });
  const ref = el("input", { id: "sreference", maxlength: "100", placeholder: "Supplier / purchase ref (optional)" });
  const notes = el("input", { id: "snotes", maxlength: "500", placeholder: "Notes (optional)" });
  const prev = el("div", { class: "preview", "aria-live": "polite" });
  const msg = el("div", { class: "msg", role: "alert" });
  const save = el("button", { class: "btn primary", type: "submit" }, "Record adjustment");
  const calc = () => {
    const n = Number(qty.value), ok = Number.isInteger(n) && n >= (type.value === "set" ? 0 : 1) && qty.value.trim() !== "";
    const res = !ok ? null : type.value === "in" ? p.stock_qty + n : type.value === "out" ? p.stock_qty - n : n;
    prev.textContent = res === null ? `Current stock ${p.stock_qty}` : type.value === "set" ? `Current ${p.stock_qty} → Actual ${n} = new stock ${res}` : `Current ${p.stock_qty} ${type.value === "in" ? "+" : "−"} ${n} = new stock ${res}`;
    save.disabled = res === null || res < 0; if (res !== null && res < 0) prev.textContent += " (cannot go below 0)";
  };
  const hist = p.movements.length ? el("table", { class: "hist" }, el("thead", {}, el("tr", {}, ...["When", "Type", "Change", "Stock", "Reason", "By"].map((h) => el("th", {}, h)))),
    el("tbody", {}, p.movements.map((m) => el("tr", {}, el("td", {}, when(m.created_at)), el("td", {}, m.type), el("td", {}, (m.qty_change > 0 ? "+" : "") + m.qty_change), el("td", {}, `${m.prev_stock}→${m.new_stock}`), el("td", {}, m.reason + (m.reference ? ` (${m.reference})` : "")), el("td", {}, m.admin))))) : el("p", { class: "sub" }, "No stock movements yet.");
  const form = el("form", { class: "form", novalidate: "" },
    el("p", {}, el("b", {}, p.name), ` · ${p.sku}`), el("div", { class: "preview" }, `Current stock: ${p.stock_qty} ${p.unit}`),
    field("stype", "Adjustment type", type), field("squantity", "Quantity", qty), field("sreason", "Reason (required)", reason), ref, notes, prev, msg,
    el("div", { class: "actions" }, save, el("button", { class: "btn", type: "button", onclick: () => $("sdlg").close() }, "Close")), el("h3", { class: "h0" }, "Stock history"), hist);
  [type, qty].forEach((x) => x.addEventListener("input", calc)); calc();
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); msg.textContent = ""; save.disabled = true;
    try {
      const body = { type: type.value, quantity: qty.value, reason: reason.value, reference: ref.value, notes: notes.value, idempotency_key: key };
      if (type.value === "set") body.expected_stock = p.stock_qty;
      await api(`/api/products/${p.id}/stock`, body); $("sdlg").close(); toast("Stock updated"); refresh();
      if ($("ppanel").open) { PANEL.dirty = false; openPanel(p.id); }
    } catch (err) { msg.textContent = err.message; save.disabled = false; }
  });
  $("sdlg").replaceChildren(el("h2", { id: "sdtitle", class: "h0" }, "Adjust stock"), form); $("sdlg").showModal();
}

// ── wiring & routing ─────────────────────────────────────────────────
let st; $("pfilters").addEventListener("input", () => { persistFilters(); clearTimeout(st); st = setTimeout(() => { P.page = 1; loadProducts(); }, 250); });
$("pfilters").addEventListener("submit", (e) => e.preventDefault());
$("pclear").onclick = clearFilters;
$("padd").onclick = () => openPanel(null);
$("pprev").onclick = () => { P.page--; loadProducts(); }; $("pnext").onclick = () => { P.page++; loadProducts(); };
function route() {
  const products = location.hash === "#/products";
  $("view-orders").hidden = products; $("view-products").hidden = !products;
  $("nav-orders").setAttribute("aria-current", products ? "false" : "page"); $("nav-products").setAttribute("aria-current", products ? "page" : "false");
  if (products) { if (!P.loaded) { P.loaded = true; restoreFilters(); refresh(); } } else load().catch(() => {});
}
document.querySelectorAll("nav a").forEach((a) => a.addEventListener("click", () => setTimeout(route, 0)));
window.addEventListener("hashchange", route); route();
