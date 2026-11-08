// Wholesale screen: partner price lists (a discount band per partner type, the minimum Ntagz margin), the resulting price of every product with the reasons it
// is limited or refused, and each partner's stock credit and wholesale orders. Nothing here is seeded: until HQ sets a band, a margin and product costs, partners
// get no price. Money is integer paise; the server computes every figure. Shares $, el, toast (app.js / products.js).
const WH = { tab: "prices", type: "", cfg: null, partners: null };
const whMoney = (p) => "₹" + (p / 100).toLocaleString("en-IN", { minimumFractionDigits: p % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
const whDay = (ts) => new Date(ts * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const whPct = (bp) => (bp === null || bp === undefined ? "not set" : bp / 100 + "%");
const whRoot = () => $("wholesale-root");

async function whCall(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" }, body: JSON.stringify(body) });
  if (r.status === 401) { location.reload(); throw new Error("signed out"); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) { const e = d.error || {}; throw new Error((e.message || "Request failed") + (e.fields ? ": " + Object.values(e.fields).join(", ") : "")); }
  return d.data;
}
async function whLoad() {
  try {
    if (WH.tab === "prices") { WH.cfg = await whCall("/api/v1/admin/wholesale/config"); if (!WH.type || !WH.cfg.types.some((t) => t.key === WH.type)) WH.type = (WH.cfg.types.find((t) => t.canOrder) || WH.cfg.types[0] || {}).key || ""; }
    else WH.partners = await whCall("/api/v1/admin/wholesale/partners");
  } catch (e) { whRoot().replaceChildren(whTabs(), el("p", { class: "sub" }, "Could not load: " + e.message)); return; }
  whRender();
}
function whTabs() {
  return el("div", { class: "chips", role: "group", "aria-label": "Wholesale sections" }, [["prices", "Price lists"], ["partners", "Partner credit and orders"]].map(([k, l]) =>
    el("button", { class: "chip", type: "button", "aria-pressed": String(WH.tab === k), onclick: () => { WH.tab = k; whLoad(); } }, l)));
}
function whRender() {
  const head = el("div", { class: "pv-head" }, el("div", {}, el("h1", { class: "pv-title" }, "Wholesale"),
    el("p", { class: "sub" }, "Partner price = the ex-GST retail price less the partner type's discount, never below product cost plus the minimum Ntagz margin. Nothing is set until you set it, and a product with no cost cannot be sold to partners. The opening stock order is stock credit that wholesale orders use up; it is never refunded in cash.")));
  whRoot().replaceChildren(head, whTabs(), WH.tab === "prices" ? whPrices() : whPartners());
}

async function whSave(path, body, done) { try { WH.cfg = await whCall(path, body); toast(done); whRender(); } catch (e) { toast(e.message, true); } }

function whPrices() {
  const c = WH.cfg; const out = [];
  const m = el("input", { id: "whm", type: "number", min: "0", max: "100", step: "0.01", inputmode: "decimal", value: c.minMarginBp === null ? "" : String(c.minMarginBp / 100), "aria-label": "Minimum Ntagz margin in percent of cost" });
  out.push(el("div", { class: "card" }, el("div", { class: "field" }, el("label", { for: "whm" }, "Minimum Ntagz margin (% of product cost)"), m),
    el("p", { class: "sub" }, `Floor price = cost × (1 + margin). Currently ${whPct(c.minMarginBp)}.`),
    el("div", { class: "editrow" }, el("button", { class: "btn primary", type: "button", onclick: () => { const v = m.value.trim(); whSave("/api/v1/admin/wholesale/margin", { minMarginBp: v === "" ? null : Math.round(Number(v) * 100) }, "Margin saved"); } }, "Save margin"))));
  if (c.missingCost.length) {
    const names = c.products.filter((p) => c.missingCost.includes(p.id)).map((p) => p.name);
    out.push(el("div", { class: "card" }, el("div", { class: "row" }, el("span", { class: "id" }, `${names.length} active product${names.length === 1 ? "" : "s"} with no cost price`), el("span", { class: "pill unpaid" }, "Partners cannot buy these")),
      el("div", { class: "sub" }, names.join(", ") + ". Enter each cost in Products; partner pricing is refused until then.")));
  }
  out.push(el("h2", { class: "h0" }, "Discount band per partner type"));
  for (const t of c.types) {
    const inp = el("input", { type: "number", min: "0", max: "90", step: "0.01", inputmode: "decimal", placeholder: "e.g. 10", value: t.discountBp === null ? "" : String(t.discountBp / 100), "aria-label": `${t.label} discount in percent` });
    const pct = el("label", { class: "wh-pct" }, el("span", {}, "Discount %"), inp);
    out.push(el("div", { class: "card" }, el("div", { class: "row" }, el("span", { class: "id" }, t.label), t.canOrder ? el("span", { class: "pill paid" }, "Can order") : el("span", { class: "pill unpaid" }, "Cannot order (no ordering permission)")),
      el("div", { class: "sub" }, `Opening stock order ${whMoney(t.openingPaise)} · discount ${whPct(t.discountBp)}`),
      el("div", { class: "editrow" }, pct,
        el("button", { class: "btn primary", type: "button", onclick: () => { const v = inp.value.trim(); whSave("/api/v1/admin/wholesale/bands", { partnerType: t.key, discountBp: v === "" ? null : Math.round(Number(v) * 100) }, "Band saved"); } }, "Save"),
        el("button", { class: "btn", type: "button", onclick: () => whSave("/api/v1/admin/wholesale/bands", { partnerType: t.key, discountBp: null }, "Band cleared") }, "Clear"))));
  }
  out.push(el("h2", { class: "h0" }, "Resulting prices"));
  out.push(el("div", { class: "chips", role: "group", "aria-label": "Partner type" }, c.types.map((t) => el("button", { class: "chip", type: "button", "aria-pressed": String(WH.type === t.key), onclick: () => { WH.type = t.key; whRender(); } }, t.label))));
  const LABEL = { priced: ["Priced", "paid"], no_band: ["No band", "unpaid"], no_margin: ["No margin", "unpaid"], no_cost: ["No cost: refused", "unpaid"] };
  for (const p of c.products) {
    const r = p.byType[WH.type]; if (!r) continue;
    const lab = r.status === "priced" && r.limit ? [r.limit === "floor" ? "Limited by floor" : "Retail only", "low"] : LABEL[r.status];
    out.push(el("div", { class: "card" }, el("div", { class: "row" }, el("span", { class: "id" }, p.name), el("span", { class: "pill " + lab[1] }, lab[0])),
      el("div", { class: "sub" }, `Retail ex-GST ${whMoney(r.retailExPaise)} · cost ${p.costPaise ? whMoney(p.costPaise) : "not set"}` + (r.unitExPaise !== null ? ` · partner ${whMoney(r.unitExPaise)} (−${r.pct}%) · floor ${whMoney(r.floorPaise)}` : "")),
      ...r.warnings.map((w) => el("div", { class: "sub" }, "⚠ " + w))));
  }
  return el("div", { class: "pn-list" }, out);
}

function whPartners() {
  const d = WH.partners; const out = [];
  if (d.problems.length) out.push(el("div", { class: "card" }, el("div", { class: "row" }, el("span", { class: "id" }, "Credit books do not balance"), el("span", { class: "pill unpaid" }, `${d.problems.length} problem${d.problems.length === 1 ? "" : "s"}`)), ...d.problems.slice(0, 10).map((x) => el("div", { class: "sub" }, x))));
  else out.push(el("p", { class: "sub" }, "Credit check: every balance equals the opening payments less the orders that used it."));
  if (!d.items.length) out.push(el("p", { class: "sub" }, "No partners yet."));
  for (const x of d.items) {
    out.push(el("div", { class: "card pn-card" }, el("div", { class: "pn-main" },
      el("div", {}, el("span", { class: "id" }, `${x.partnerCode || "—"} · ${x.business}`), " ", x.canOrder ? "" : el("span", { class: "pill unpaid" }, "Cannot order")),
      el("div", { class: "sub" }, `Credit ${whMoney(x.credit.availablePaise)} available of ${whMoney(x.credit.grantedPaise)} · used ${whMoney(x.credit.consumedPaise)}${x.credit.heldPaise ? " · reserved on open links " + whMoney(x.credit.heldPaise) : ""} · ${x.ordersN} order${x.ordersN === 1 ? "" : "s"}, ${whMoney(x.ordersPaise)}`)),
      el("button", { class: "btn small", type: "button", onclick: () => whOrders(x.id) }, "Orders")));
  }
  return el("div", { class: "pn-list" }, out);
}

async function whOrders(id) {
  let d; try { d = await whCall(`/api/v1/admin/wholesale/partners/${id}/orders`); } catch (e) { return toast(e.message, true); }
  const dlg = $("cmpanel");
  const rows = d.orders.map((o) => el("li", {}, el("span", {}, `${o.ref} · ${whDay(o.at)} · ${o.status} · ${o.items.map((i) => `${i.qty} × ${i.name}`).join(", ")}`), el("b", {}, `${whMoney(o.totalPaise)}${o.creditPaise ? " (credit " + whMoney(o.creditPaise) + ")" : ""}`)));
  const links = d.links.map((l) => el("li", {}, el("span", {}, `Link ${l.ref} · ${whDay(l.at)} · ${l.status.replace("_", " ")}`), el("b", {}, `${whMoney(l.totalPaise)}${l.creditPaise ? " (credit " + whMoney(l.creditPaise) + " reserved)" : ""}`)));
  const sec = (t, kids, none) => el("section", { class: "pn-sec" }, el("h3", {}, t), kids.length ? el("ul", { class: "pn-docs" }, kids) : el("p", { class: "sub" }, none));
  dlg.replaceChildren(el("div", { class: "panel-head" }, el("h2", { id: "cmtitle", class: "h0" }, `${d.partner.partnerCode || ""} ${d.partner.business}`), el("button", { class: "btn small", type: "button", onclick: () => dlg.close() }, "Close")),
    el("div", { class: "pn-body" }, el("p", { class: "sub" }, `Credit available ${whMoney(d.credit.availablePaise)} of ${whMoney(d.credit.grantedPaise)}; used ${whMoney(d.credit.consumedPaise)}.`), sec("Orders", rows, "No wholesale orders yet."), sec("Payment links not yet paid", links, "None.")));
  if (!dlg.open) dlg.showModal();
}
window.wholesaleVisible = (on) => { if (on) { WH.tab = "prices"; whLoad(); } };
