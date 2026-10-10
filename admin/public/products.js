// Products & inventory screen. Shares $, el, api, inr, when with app.js. All text goes in via textContent.
const P = { page: 1, pages: 1, loaded: false };
const IMG_BASE = "https://www.ntagz.com/";
const imgSrc = (u) => (u ? (u.startsWith("http") ? u : IMG_BASE + u) : "");
const rupees = (paise) => (paise / 100).toFixed(2);
const STATUS = { in: "In stock", low: "Low stock", out: "Out of stock" };

function thumb(p) { return p.image_url ? el("img", { class: "thumb", src: imgSrc(p.image_url), alt: "", loading: "lazy", width: "44", height: "44" }) : el("span", { class: "thumb" }); }
const statusPills = (p) => [...(p.track_stock ? [el("span", { class: "pill" }, "Tracked")] : []), el("span", { class: "pill " + p.stock_status }, STATUS[p.stock_status]), el("span", { class: "pill " + (p.active ? "paid" : "off") }, p.active ? "Active" : "Inactive")];

function pparams() {
  const q = new URLSearchParams();
  if ($("pq").value) q.set("q", $("pq").value);
  for (const [id, k] of [["pcat", "category"], ["pstock", "stock"], ["pactive", "active"]]) if ($(id).value) q.set(k, $(id).value);
  const [sort, dir] = $("psort").value.split(":"); q.set("sort", sort); q.set("dir", dir); q.set("page", P.page);
  return q;
}

async function loadSummary() {
  const s = await api("/api/products/summary");
  $("ptiles").replaceChildren(...[["Total products", s.total], ["Active", s.active], ["Low stock", s.low], ["Out of stock", s.out]].map(([l, v]) => el("div", { class: "tile" }, el("b", {}, String(v)), el("span", {}, l))));
  const cur = $("pcat").value;
  $("pcat").replaceChildren(el("option", { value: "" }, "All categories"), ...s.categories.map((c) => { const o = el("option", { value: c }, c); if (c === cur) o.selected = true; return o; }));
  return s.categories;
}

async function loadProducts() {
  $("plist").replaceChildren(el("p", { class: "sub" }, "Loading…"));
  try {
    const d = await api("/api/products?" + pparams());
    P.pages = d.pages; P.page = d.page;
    $("ppageInfo").textContent = `Page ${d.page} of ${d.pages} · ${d.total} products`;
    $("pprev").disabled = d.page <= 1; $("pnext").disabled = d.page >= d.pages;
    const acts = (p) => el("div", { class: "rowact" },
      el("button", { class: "btn", type: "button", onclick: () => editProduct(p.id) }, "Edit"),
      el("button", { class: "btn", type: "button", onclick: () => stockDialog(p.id) }, "Update stock"),
      el("button", { class: "btn", type: "button", onclick: () => toggleActive(p) }, p.active ? "Deactivate" : "Activate"));
    $("plist").replaceChildren(...(d.products.length ? d.products.map((p) => el("div", { class: "card" },
      el("div", { class: "top" }, thumb(p), el("div", { class: "grow" }, el("div", { class: "id" }, p.name), el("div", { class: "sub" }, `${p.sku} · ${p.category}`)), el("b", {}, inr(p.price_paise))),
      el("div", { class: "row sub" }, el("span", {}, `Stock: ${p.stock_qty} ${p.unit}`), el("span", {}, "Updated " + when(p.updated_at))),
      el("div", {}, statusPills(p)), acts(p))) : [el("p", { class: "sub" }, "No products match your filters.")]));
    $("prows").replaceChildren(...(d.products.length ? d.products.map((p) => el("tr", {},
      el("td", {}, thumb(p)), el("td", {}, p.name), el("td", {}, p.sku), el("td", {}, p.category), el("td", {}, inr(p.price_paise)),
      el("td", {}, String(p.stock_qty)), el("td", {}, statusPills(p)), el("td", {}, when(p.updated_at)), el("td", {}, acts(p)))) :
      [el("tr", {}, el("td", { colspan: "9" }, "No products match your filters."))]));
  } catch (e) {
    $("plist").replaceChildren(el("p", { class: "msg" }, "Could not load products: " + e.message, " ", el("button", { class: "btn", type: "button", onclick: loadProducts }, "Retry")));
    $("prows").replaceChildren();
  }
}
const refresh = () => Promise.all([loadSummary(), loadProducts()]);

// ── confirm dialog: resolves true/false ───────────────────────────────
function ask(title, lines, okLabel) {
  return new Promise((res) => {
    const d = $("kdlg");
    d.replaceChildren(el("h2", { id: "kdtitle", class: "h0" }, title), ...lines.map((l) => el("p", {}, l)),
      el("div", { class: "actions" }, el("button", { class: "btn primary", type: "button", onclick: () => { d.close("ok"); } }, okLabel), el("button", { class: "btn", type: "button", onclick: () => d.close("no") }, "Cancel")));
    d.onclose = () => res(d.returnValue === "ok"); d.returnValue = ""; d.showModal();
  });
}

async function toggleActive(p) {
  const to = !p.active;
  if (!to && !(await ask("Deactivate product?", [`${p.name} (${p.sku}) will disappear from the storefront and checkout. History and past orders are kept.`], "Deactivate"))) return;
  try { await api(`/api/products/${p.id}/active`, { active: to }); refresh(); } catch (e) { alert(e.message); }
}

// ── add / edit ───────────────────────────────────────────────────────
function field(id, label, input, hint) { return el("div", { class: "field", id: "f-" + id }, el("label", { for: id }, label), input, el("div", { class: "err", id: "e-" + id, role: "alert" }, hint || "")); }
function showErrors(fields) {
  document.querySelectorAll("#pdlg .field").forEach((f) => { f.classList.remove("bad"); f.querySelector(".err").textContent = ""; });
  for (const [k, m] of Object.entries(fields || {})) { const f = $("f-" + k); if (f) { f.classList.add("bad"); f.querySelector(".err").textContent = m; } }
}

async function editProduct(id) {
  const p = id ? await api("/api/products/" + id) : null;
  const cats = [...$("pcat").options].map((o) => o.value).filter(Boolean);
  const v = (k, d = "") => (p && p[k] != null ? String(p[k]) : d);
  const dl = el("datalist", { id: "catlist" }, cats.map((c) => el("option", { value: c })));
  const name = el("input", { id: "name", value: v("name"), maxlength: "120", required: "" });
  const sku = el("input", { id: "sku", value: v("sku"), maxlength: "32", required: "", autocapitalize: "characters" });
  const desc = el("textarea", { id: "description", maxlength: "2000" }); desc.value = v("description");
  const cat = el("input", { id: "category", value: v("category", cats[0] || "nfc"), list: "catlist", required: "" });
  const img = el("input", { id: "image_url", value: v("image_url"), placeholder: "images/product.jpg" });
  const price = el("input", { id: "price", value: p ? rupees(p.price_paise) : "", inputmode: "decimal", required: "" });
  const mrp = el("input", { id: "mrp", value: p && p.mrp_paise != null ? rupees(p.mrp_paise) : "", inputmode: "decimal" });
  const gst = el("select", { id: "gst_rate" }, [0, 5, 12, 18, 28].map((r) => { const o = el("option", { value: String(r) }, r + "%"); if (r === (p ? p.gst_rate : 18)) o.selected = true; return o; }));
  const thr = el("input", { id: "low_stock_threshold", value: v("low_stock_threshold", "10"), inputmode: "numeric" });
  const open = el("input", { id: "opening_stock", value: "0", inputmode: "numeric" });
  const track = el("input", { id: "track_stock", type: "checkbox" }); track.checked = !!(p && p.track_stock);
  const act = el("select", { id: "active" }, [["1", "Active"], ["0", "Inactive"]].map(([val, l]) => { const o = el("option", { value: val }, l); if (val === (p && !p.active ? "0" : "1")) o.selected = true; return o; }));
  const form = el("form", { class: "form", novalidate: "" },
    field("name", "Product name", name), field("sku", "SKU / product code", sku), field("description", "Description", desc),
    el("div", { class: "two" }, field("category", "Category", cat), field("image_url", "Image path or URL", img)),
    el("div", { class: "two" }, field("price", "Selling price (₹, ex-GST)", price), field("mrp", "MRP / list price (₹, optional)", mrp)),
    el("div", { class: "two" }, field("gst_rate", "GST rate", gst), field("low_stock_threshold", "Low-stock alert at", thr)),
    p ? el("p", { class: "sub" }, `Current stock ${p.stock_qty} ${p.unit}. Change it with “Update stock”, so every change is recorded.`) : field("opening_stock", "Opening stock", open),
    field("active", "Status", act),
    el("div", { class: "field" }, el("label", { class: "check" }, track, " Track stock on the storefront"), el("div", { class: "sub" }, "On: checkout blocks quantities above stock and deducts sold units. Leave off until you have done a stock count.")), dl,
    el("div", { class: "msg", id: "pmsg", role: "alert" }),
    el("div", { class: "actions" }, el("button", { class: "btn primary", id: "psave", type: "submit" }, p ? "Save changes" : "Add product"), el("button", { class: "btn", type: "button", onclick: () => $("pdlg").close() }, "Cancel")));
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); $("pmsg").textContent = ""; showErrors({});
    const body = { name: name.value, sku: sku.value, description: desc.value, category: cat.value, image_url: img.value, price: price.value, mrp: mrp.value, gst_rate: Number(gst.value), low_stock_threshold: thr.value, active: act.value === "1", track_stock: track.checked };
    if (!p) body.opening_stock = open.value;
    if (p) {
      const notes = [];
      const np = Number(price.value);
      if (price.value.trim() !== "" && Number.isFinite(np) && np >= 0 && Math.round(np * 100) !== p.price_paise) notes.push(`Price: ${inr(p.price_paise)} → ${inr(Math.round(np * 100))}. Applies to future purchases only; past orders keep their prices.`);
      if (sku.value.trim().toUpperCase() !== p.sku) notes.push(`SKU: ${p.sku} → ${sku.value.trim().toUpperCase()}.`);
      if (!body.active && p.active) notes.push("The product will be marked inactive and disappear from the storefront and checkout.");
      if (body.track_stock && !p.track_stock) notes.push(`Stock tracking will be turned on. Customers will be blocked from ordering more than the current stock (${p.stock_qty}).`);
      if (notes.length && !(await ask("Confirm changes", notes, "Save changes"))) return;
    }
    $("psave").disabled = true;
    try {
      const r = await fetch(p ? `/api/products/${p.id}` : "/api/products", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) return location.reload();
      if (!r.ok) { showErrors(d.fields); $("pmsg").textContent = d.error || "Could not save"; $("psave").disabled = false; return; }
      $("pdlg").close(); refresh();
    } catch { $("pmsg").textContent = "Network error. Nothing was saved."; $("psave").disabled = false; }
  });
  $("pdlg").replaceChildren(el("h2", { id: "pdtitle", class: "h0" }, p ? "Edit product" : "Add product"), form);
  $("pdlg").showModal();
}

// ── stock ────────────────────────────────────────────────────────────
async function stockDialog(id) {
  const p = await api("/api/products/" + id), key = crypto.randomUUID();
  const type = el("select", { id: "stype" }, [["in", "Stock In (received)"], ["out", "Stock Out (damaged / lost)"], ["set", "Set Actual Stock (physical count)"]].map(([v, l]) => el("option", { value: v }, l)));
  const qty = el("input", { id: "squantity", inputmode: "numeric", required: "" });
  const reason = el("input", { id: "sreason", maxlength: "200", required: "", placeholder: "e.g. Supplier delivery, damaged in transit, physical count" });
  const ref = el("input", { id: "sreference", maxlength: "100", placeholder: "Supplier / purchase ref (optional)" });
  const notes = el("input", { id: "snotes", maxlength: "500", placeholder: "Notes (optional)" });
  const prev = el("div", { class: "preview", "aria-live": "polite" });
  const msg = el("div", { class: "msg", role: "alert" });
  const calc = () => {
    const n = Number(qty.value), ok = Number.isInteger(n) && n >= (type.value === "set" ? 0 : 1) && qty.value.trim() !== "";
    const res = !ok ? null : type.value === "in" ? p.stock_qty + n : type.value === "out" ? p.stock_qty - n : n;
    prev.textContent = res === null ? `Current stock ${p.stock_qty}` : type.value === "set" ? `Current ${p.stock_qty} → Actual ${n} = new stock ${res}` : `Current ${p.stock_qty} ${type.value === "in" ? "+" : "−"} ${n} = new stock ${res}`;
    save.disabled = res === null || res < 0; if (res !== null && res < 0) prev.textContent += " (cannot go below 0)";
  };
  const save = el("button", { class: "btn primary", type: "submit" }, "Record adjustment");
  const hist = p.movements.length ? el("table", { class: "hist" }, el("thead", {}, el("tr", {}, ...["When", "Type", "Change", "Stock", "Reason", "By"].map((h) => el("th", {}, h)))),
    el("tbody", {}, p.movements.map((m) => el("tr", {}, el("td", {}, when(m.created_at)), el("td", {}, m.type), el("td", {}, (m.qty_change > 0 ? "+" : "") + m.qty_change), el("td", {}, `${m.prev_stock}→${m.new_stock}`), el("td", {}, m.reason + (m.reference ? ` (${m.reference})` : "")), el("td", {}, m.admin))))) : el("p", { class: "sub" }, "No stock movements yet.");
  const form = el("form", { class: "form", novalidate: "" },
    el("p", {}, el("b", {}, p.name), ` · ${p.sku}`), el("div", { class: "preview" }, `Current stock: ${p.stock_qty} ${p.unit}`),
    field("stype", "Adjustment type", type), field("squantity", type.value === "set" ? "Actual quantity" : "Quantity", qty), field("sreason", "Reason (required)", reason), ref, notes, prev, msg,
    el("div", { class: "actions" }, save, el("button", { class: "btn", type: "button", onclick: () => $("sdlg").close() }, "Close")), el("h3", { class: "h0" }, "Stock history"), hist);
  [type, qty].forEach((x) => x.addEventListener("input", calc)); calc();
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); msg.textContent = ""; save.disabled = true;
    try {
      const body = { type: type.value, quantity: qty.value, reason: reason.value, reference: ref.value, notes: notes.value, idempotency_key: key };
      if (type.value === "set") body.expected_stock = p.stock_qty;
      await api(`/api/products/${p.id}/stock`, body); $("sdlg").close(); refresh();
    } catch (err) { msg.textContent = err.message; save.disabled = false; }
  });
  $("sdlg").replaceChildren(el("h2", { id: "sdtitle", class: "h0" }, "Update stock"), form); $("sdlg").showModal();
}

// ── routing (hash) ───────────────────────────────────────────────────
let st; $("pfilters").addEventListener("input", () => { clearTimeout(st); st = setTimeout(() => { P.page = 1; loadProducts(); }, 250); });
$("pfilters").addEventListener("submit", (e) => e.preventDefault());
$("padd").onclick = () => editProduct(null);
$("pprev").onclick = () => { P.page--; loadProducts(); }; $("pnext").onclick = () => { P.page++; loadProducts(); };
function route() {
  const products = location.hash === "#/products";
  $("view-orders").hidden = products; $("view-products").hidden = !products;
  $("nav-orders").setAttribute("aria-current", products ? "false" : "page"); $("nav-products").setAttribute("aria-current", products ? "page" : "false");
  if (products) { if (!P.loaded) { P.loaded = true; refresh(); } } else load().catch(() => {});
}
document.querySelectorAll("nav a").forEach((a) => a.addEventListener("click", () => setTimeout(route, 0)));
window.addEventListener("hashchange", route); route();
