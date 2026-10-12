// Customers / CRM shell + Directory, Profile, Segments, Settings pages. Shares $, el, api, inr, when, toast, ask with the other admin scripts.
// Every string from the server is inserted with textContent via el(): nothing here parses data as HTML. CSP is script-src 'self'.
(() => {
"use strict";
const CRM = window.CRM = { pages: {}, range: { range: "30d", from: "", to: "" }, register(name, fn) { this.pages[name] = fn; }, go(hashPath) { location.hash = "#/" + hashPath; } };
const root = $("crm-root");
const S = { perms: { view: false, manage: false, export: false, send: false }, settings: null, meta: null, hash: null, page: null, tok: 0, dirHash: "#/customers" };
const NAV = [["overview", "Overview", "customers"], ["segments", "Segments", "customers/segments"], ["campaigns", "Campaigns", "customers/campaigns"], ["journeys", "Journeys", "customers/journeys"], ["analytics", "Analytics", "customers/analytics"], ["settings", "Settings", "customers/settings"]];

// ── helpers ─────────────────────────────────────────────────────────
async function jget(path, signal) {
  const r = await fetch(path, { signal });
  if (r.status === 401) { location.reload(); throw new Error("signed out"); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || (r.status === 403 ? "You do not have permission for this action" : "Request failed")), { status: r.status });
  return d;
}
const day = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—");
const dt = (ts) => (ts ? when(ts) : "—");
const m = (p) => (p === null || p === undefined ? "—" : inr(p));
const cap = (s) => String(s).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const enc = encodeURIComponent;
const pill = (text, cls) => el("span", { class: "pill " + (cls || "") }, text);
const p = (text, cls) => el("p", { class: cls || "sub" }, text);
const aborted = (e) => e && e.name === "AbortError";
const profileHref = (ckey) => "#/customers/" + enc(ckey);
const CONSENT = { subscribed: ["Subscribed", "ok"], unsubscribed: ["Unsubscribed", "warn"], suppressed: ["Blocked", "bad"], none: ["No opt-in", "mute"] };
const consentPill = (s) => { const c = CONSENT[s] || CONSENT.none; return pill(c[0], c[1]); };
function errBox(e, retry) {
  return el("div", { class: "crm-err", role: "alert" }, el("p", {}, e.status === 403 ? "You do not have permission to see this. " + e.message : e.message || "Something went wrong."), retry ? el("button", { class: "btn", type: "button", onclick: retry }, "Retry") : "");
}
// Fill `box` from async `fn`, with loading and error+Retry states. `tok` guards against a newer render replacing the page meanwhile.
async function load(box, fn, msg) {
  const tok = S.tok;
  box.replaceChildren(p(msg || "Loading…"));
  try { await fn(); } catch (e) { if (aborted(e) || tok !== S.tok) return; box.replaceChildren(errBox(e, () => load(box, fn, msg))); }
}
function download(blob, name) {
  const a = el("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const safeHttps = (u) => { try { return new URL(u).protocol === "https:" ? u : null; } catch { return null; } };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// Generic modal form. fields: [{name,label,type:text|textarea|select|number,required,min,max,hint,options:[[v,l]],value,check(v)}].
// submit(values) may be async and throws to show an inline error; the dialog resolves with its return value (or null when cancelled).
let DLG;
function formDlg({ title, intro = [], fields = [], ok = "Save", danger, submit }) {
  return new Promise((res) => {
    if (!DLG) { DLG = el("dialog", { class: "crm-dlg", "aria-labelledby": "crm-dlg-t" }); document.body.append(DLG); }
    const inputs = {}, msg = el("p", { class: "msg", role: "alert" }); let done = false, busy = false;
    const finish = (v) => { if (done) return; done = true; if (DLG.open) DLG.close(); res(v); };
    const rows = fields.map((f, i) => {
      const id = "crm-f-" + i;
      const inp = f.type === "textarea" ? el("textarea", { id, rows: "3" }) : f.type === "select" ? el("select", { id }, (f.options || []).map(([v, l]) => el("option", { value: v }, l))) : el("input", { id, type: f.type || "text" });
      if (f.max) inp.setAttribute("maxlength", String(f.max));
      if (f.type === "number") { inp.setAttribute("step", f.step || "1"); inp.setAttribute("min", "0"); }
      if (f.value !== undefined && f.value !== null) inp.value = f.value;
      if (f.autocomplete) inp.setAttribute("autocomplete", f.autocomplete);
      inputs[f.name] = inp;
      return el("div", { class: "field" }, el("label", { for: id }, f.label + (f.required ? " (required)" : "")), inp, f.hint ? el("span", { class: "hint" }, f.hint) : "");
    });
    const okBtn = el("button", { class: "btn " + (danger ? "danger-solid" : "primary"), type: "submit" }, ok);
    const cancel = el("button", { class: "btn", type: "button", onclick: () => !busy && finish(null) }, "Cancel");
    const form = el("form", { class: "form", novalidate: "" }, ...intro.map((t) => el("p", {}, t)), rows, msg, el("div", { class: "actions" }, okBtn, cancel));
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); if (busy) return;
      const v = {}; for (const f of fields) v[f.name] = inputs[f.name].value.trim();
      for (const f of fields) {
        const bad = (f.required && !v[f.name]) ? `${f.label} is required.` : (f.min && v[f.name].length < f.min) ? `${f.label} needs at least ${f.min} characters.` : f.check ? f.check(v) : "";
        if (bad) { msg.textContent = bad; inputs[f.name].focus(); return; }
      }
      msg.textContent = ""; busy = true; okBtn.disabled = true;
      try { finish(submit ? await submit(v) : v); } catch (err) { msg.textContent = err.message || "Failed"; busy = false; okBtn.disabled = false; }
    });
    DLG.replaceChildren(el("h2", { id: "crm-dlg-t", class: "h0" }, title), form);
    DLG.onclose = () => finish(null); DLG.showModal();
    const first = fields.length ? inputs[fields[0].name] : okBtn; first.focus();
  });
}

// ── shell ───────────────────────────────────────────────────────────
async function ensureSettings(force) {
  if (!S.settings || force) { S.settings = await jget("/api/crm/settings"); S.perms = S.settings.permissions || S.perms; }
  return S.settings;
}
const getMeta = async () => S.meta || (S.meta = await jget("/api/crm/segments/meta").catch((e) => { S.meta = null; throw e; }));
function parseHash(h) {
  const [path, query = ""] = h.split("?"), seg = path.replace(/^#\/customers\/?/, ""), q = new URLSearchParams(query);
  if (!seg) return { page: "overview", q };
  if (["segments", "campaigns", "journeys", "analytics", "settings"].includes(seg)) return { page: seg, q };
  let ckey = ""; try { ckey = decodeURIComponent(seg); } catch { /* invalid */ }
  return { page: "profile", ckey, q };
}
function shell(page) {
  const nav = el("nav", { class: "crm-sub", "aria-label": "Customers sections" }, NAV.map(([k, label, path]) => el("a", { href: "#/" + path, ...(k === page ? { "aria-current": "page" } : {}) }, label)));
  const body = el("div", { class: "crm-body" });
  root.replaceChildren(el("div", { class: "pv-head" }, el("div", {}, el("h1", { class: "pv-title" }, "Customers"), el("p", { class: "sub" }, "Everyone who has an account or has ordered, with their orders, activity and marketing consent."))), nav, body);
  return body;
}
function notAvailable(box, name) { box.replaceChildren(el("div", { class: "pcard" }, el("h2", { class: "h0" }, "Not available yet"), p(`The ${name} section has not been installed on this admin yet.`))); }
async function callPage(name, box, arg) {
  if (!CRM.pages[name]) return notAvailable(box, name);
  try { await CRM.pages[name](box, arg); } catch (e) { box.replaceChildren(errBox(e, () => callPage(name, box, arg))); }
}
async function render() {
  const h = location.hash, r = parseHash(h);
  if (S.hash === h) return;
  if (r.page === "overview" && S.page === "overview" && S.dirApi) { S.hash = h; S.dirApi.sync(); return; }
  S.hash = h; S.page = r.page; const tok = ++S.tok;
  if (r.page === "overview" || r.page === "settings") S.dirHash = r.page === "overview" ? h : S.dirHash;
  root.replaceChildren(p("Loading…"));
  S.dirApi = null;
  try { await ensureSettings(r.page === "settings"); } catch (e) { if (tok === S.tok) root.replaceChildren(errBox(e, () => { S.hash = null; render(); })); return; }
  if (tok !== S.tok) return;
  if (!S.perms.view) { root.replaceChildren(el("div", { class: "pcard" }, el("h2", { class: "h0" }, "No access"), p("You do not have permission to view customers."))); return; }
  const body = shell(r.page);
  if (r.page === "overview") {
    const kp = el("div", { class: "crm-kpis" }), dir = el("div");
    body.append(kp, dir);
    if (CRM.pages.kpis) callPage("kpis", kp, r.q); else kp.hidden = true;
    S.dirApi = mountDirectory(dir, r.q);
  } else if (r.page === "profile") { if (!r.ckey) body.append(errBox(new Error("Invalid customer link"))); else mountProfile(body, r.ckey); }
  else if (r.page === "segments") mountSegments(body, r.q);
  else if (r.page === "settings") mountSettings(body);
  else callPage(r.page, body, r.q);
  const h1 = root.querySelector("h1"); if (h1) h1.scrollIntoView({ block: "start" });
}
window.customersVisible = (on) => { if (on) render(); else { S.hash = null; S.tok++; if (S.dirApi) S.dirApi.stop(); } };
window.addEventListener("crm-range", () => { if (S.dirApi) S.dirApi.reload(); });

// ── Directory ───────────────────────────────────────────────────────
const FKEYS = ["q", "preset", "type", "tier", "product", "category", "tag", "spend_min", "spend_max", "orders_min", "orders_max", "consent", "engaged", "last_from", "last_to", "rules", "sort", "dir", "page"];
const FORMKEYS = ["q", "type", "tier", "product", "category", "tag", "spend_min", "spend_max", "orders_min", "orders_max", "consent", "engaged", "last_from", "last_to"];
const CHIPS = [["new", "New"], ["never", "Never purchased"], ["one_time", "One-time"], ["repeat", "Repeat"], ["high_value", "High-value"], ["inactive", "Inactive 90d"]];
const SORTS = [["recent", "Newest customers"], ["last_order", "Last order"], ["first_order", "First order"], ["orders", "Paid orders"], ["spend", "Net paid"], ["name", "Name"], ["email", "Email"]];
const GUEST_TIP = "Membership-qualifying spend only exists for signed-in accounts. Guests have none.";
const cleanSp = (q) => { const sp = new URLSearchParams(); for (const k of FKEYS) { const v = q.get(k); if (v) sp.set(k, v.slice(0, 8000)); } return sp; };

// Directory filters -> rule tree (mirrors the server's directoryWhere) so "Save as segment" means exactly what the table shows.
function filtersTree(sp) {
  const st = S.settings, rules = [], bad = [], r = (field, cmp, value) => rules.push({ field, cmp, value });
  if (sp.get("q")) r("search", "contains", sp.get("q"));
  const PR = { new: () => r("days_since_first_seen", "lte", 30), never: () => r("never_purchased", "is", true), one_time: () => r("paid_orders", "eq", 1), repeat: () => r("paid_orders", "gte", 2),
    high_value: () => r("net_paise", "gte", st.high_value_paise), inactive: () => r("days_since_last_order", "gte", st.inactive_days) };
  for (const x of (sp.get("preset") || "").split(",")) if (PR[x]) PR[x]();
  if (sp.get("type")) r("type", "eq", sp.get("type"));
  if (sp.get("tier")) r("tier", "eq", sp.get("tier"));
  if (sp.get("product")) r("bought_product", "has", sp.get("product"));
  if (sp.get("category")) r("bought_category", "has", sp.get("category"));
  if (sp.get("tag")) r("tag", "has", sp.get("tag"));
  const num = (k, mult) => (sp.get(k) !== null && sp.get(k) !== "" && Number.isFinite(Number(sp.get(k))) ? Math.round(Number(sp.get(k)) * mult) : null);
  const smin = num("spend_min", 100), smax = num("spend_max", 100), omin = num("orders_min", 1), omax = num("orders_max", 1);
  if (smin !== null) r("net_paise", "gte", smin); if (smax !== null) r("net_paise", "lte", smax);
  if (omin !== null) r("paid_orders", "gte", omin); if (omax !== null) r("paid_orders", "lte", omax);
  if (sp.get("consent") === "subscribed") r("marketing_eligible", "is", true); else if (sp.get("consent")) bad.push("marketing consent other than Subscribed");
  if (sp.get("engaged")) bad.push("clicked a campaign email");
  if (sp.get("last_from") || sp.get("last_to")) bad.push("last-purchase dates");
  if (sp.get("rules")) { try { const t = JSON.parse(sp.get("rules")); if (t && Array.isArray(t.rules) && t.op !== "or") rules.push(...t.rules); else rules.push(t); } catch { bad.push("invalid rules"); } }
  return { tree: { op: "and", rules }, bad };
}

function mountDirectory(box, q0) {
  const D = { sp: cleanSp(q0), sel: new Map(), data: null, ctl: null, stopped: false };
  const F = {}, mq = matchMedia("(min-width:900px)");
  const field = (key, label, input) => { F[key] = input; return el("div", { class: "field" }, el("label", { for: "crmf-" + key }, label), input); };
  const inp = (key, attrs) => el("input", { id: "crmf-" + key, ...attrs });
  const sel = (key, first) => el("select", { id: "crmf-" + key }, el("option", { value: "" }, first));
  F.q = el("input", { id: "crmf-q", type: "search", placeholder: "Search name, email, phone or customer id", "aria-label": "Search customers", autocomplete: "off", maxlength: "80" });
  const typeSel = sel("type", "Any type"); typeSel.append(el("option", { value: "registered" }, "Registered"), el("option", { value: "guest" }, "Guest"));
  const consentSel = sel("consent", "Any consent"); for (const [k, [l]] of Object.entries(CONSENT)) consentSel.append(el("option", { value: k }, l));
  const more = el("details", { class: "more crm-more" }, el("summary", {}, "More filters"), el("div", { class: "crm-fgrid" },
    field("type", "Customer type", typeSel), field("tier", "Rewards tier", sel("tier", "Any tier")),
    field("spend_min", "Net paid from (₹)", inp("spend_min", { type: "number", min: "0", step: "1", inputmode: "decimal" })), field("spend_max", "Net paid up to (₹)", inp("spend_max", { type: "number", min: "0", step: "1", inputmode: "decimal" })),
    field("orders_min", "Paid orders from", inp("orders_min", { type: "number", min: "0", step: "1", inputmode: "numeric" })), field("orders_max", "Paid orders up to", inp("orders_max", { type: "number", min: "0", step: "1", inputmode: "numeric" })),
    field("product", "Bought product", sel("product", "Any product")), field("category", "Bought from category", sel("category", "Any category")),
    field("tag", "Has tag", inp("tag", { type: "text", maxlength: "30", autocomplete: "off" })), field("consent", "Marketing consent", consentSel),
    field("last_from", "Last purchase from", inp("last_from", { type: "date" })), field("last_to", "Last purchase to", inp("last_to", { type: "date" })),
    el("div", { class: "field chk" }, F.engaged = inp("engaged", { type: "checkbox" }), el("label", { for: "crmf-engaged" }, "Clicked a campaign email"))));
  const chips = el("div", { class: "chips", role: "group", "aria-label": "Quick filters" });
  const rulesNote = el("div", { class: "note", hidden: "" });
  const count = el("span", { class: "crm-count", "aria-live": "polite" });
  const sortSel = el("select", { "aria-label": "Sort by" }, SORTS.map(([v, l]) => el("option", { value: v }, l)));
  const dirBtn = el("button", { class: "btn small", type: "button" });
  const selAll = el("input", { type: "checkbox", id: "crm-selall" });
  const selInfo = el("span", { class: "crm-selinfo", "aria-live": "polite" });
  const bar = el("div", { class: "crm-bar" });
  const exportNote = el("div", { class: "note warn", hidden: "" });
  const list = el("div", { class: "crm-list", "aria-live": "polite" });
  const prev = el("button", { class: "btn", type: "button" }, "Previous"), next = el("button", { class: "btn", type: "button" }, "Next"), pageInfo = el("span", {});
  const pager = el("div", { class: "pager" }, prev, pageInfo, next);
  const clearBtn = el("button", { class: "btn link", type: "button" }, "Clear filters");
  const form = el("form", { class: "crm-filters", role: "search" }, F.q, chips, more, el("div", { class: "crm-fbar" }, clearBtn));
  box.replaceChildren(form, rulesNote,
    el("div", { class: "crm-resbar" }, count, el("label", { class: "crm-sort" }, el("span", { class: "sub" }, "Sort"), sortSel, dirBtn)),
    bar, exportNote, el("div", { class: "crm-selrow" }, el("label", { class: "chk", for: "crm-selall" }, selAll, "Select this page"), selInfo), list, pager);

  const sortOf = () => [D.sp.get("sort") || "recent", D.sp.get("dir") === "asc" ? "asc" : "desc"];
  function syncForm() {
    for (const k of FORMKEYS) { if (k === "engaged") F.engaged.checked = D.sp.get("engaged") === "clicked"; else F[k].value = D.sp.get(k) || ""; }
    const pr = D.sp.get("preset") || "";
    chips.replaceChildren(el("button", { class: "chip", type: "button", "aria-pressed": String(!pr), onclick: () => setPreset("") }, "All"),
      ...CHIPS.map(([k, l]) => el("button", { class: "chip", type: "button", "aria-pressed": String(pr === k), onclick: () => setPreset(k) }, l)));
    const [s, d] = sortOf(); sortSel.value = s; dirBtn.textContent = d === "asc" ? "↑ Ascending" : "↓ Descending"; dirBtn.setAttribute("aria-label", "Sort order: " + (d === "asc" ? "ascending" : "descending") + ". Toggle.");
    const hasRules = D.sp.has("rules");
    rulesNote.hidden = !hasRules; rulesNote.replaceChildren();
    if (hasRules) { let t = "custom rules"; try { t = summarise(JSON.parse(D.sp.get("rules")), S.meta); } catch { /* keep generic */ } rulesNote.append(el("b", {}, "Rules applied: "), t + " ", el("button", { class: "btn link", type: "button", onclick: () => { D.sp.delete("rules"); D.sp.delete("page"); commit("pushState"); } }, "Remove rules"));
    }
    if (F.engaged.checked || ["spend_min", "spend_max", "orders_min", "orders_max", "type", "tier", "product", "category", "tag", "consent", "last_from", "last_to"].some((k) => D.sp.get(k))) more.open = true;
  }
  function fillMeta(meta) {
    const add = (k, items) => { const s = F[k], v = D.sp.get(k) || ""; s.replaceChildren(s.firstChild ? s.options[0] : "", ...items.map(([val, l]) => el("option", { value: val }, l))); s.value = v; };
    add("tier", meta.tiers.map((t) => [t.id, t.name])); add("product", meta.products.map((x) => [x.id, x.name])); add("category", meta.categories.map((c) => [c, c]));
  }
  function formSp() {
    const sp = new URLSearchParams();
    if (D.sp.get("preset")) sp.set("preset", D.sp.get("preset"));
    for (const k of FORMKEYS) { const v = k === "engaged" ? (F.engaged.checked ? "clicked" : "") : F[k].value.trim(); if (v) sp.set(k, v); }
    for (const k of ["rules", "sort", "dir"]) if (D.sp.get(k)) sp.set(k, D.sp.get(k));
    return cleanSp(sp);
  }
  function commit(mode) {
    D.sel.clear();
    const s = D.sp.toString(), h = "#/customers" + (s ? "?" + s : "");
    if (h !== location.hash) history[mode](null, "", h);
    S.hash = h; S.dirHash = h; syncForm(); loadDir();
  }
  const applyForm = (mode) => { const sp = formSp(); if (sp.toString() === D.sp.toString()) return; D.sp = sp; commit(mode); };
  function setPreset(k) { if (k) D.sp.set("preset", k); else D.sp.delete("preset"); D.sp.delete("page"); commit("pushState"); }
  const typing = debounce(() => applyForm("replaceState"), 300);
  form.addEventListener("input", (e) => { if (e.target.matches("input:not([type=date]):not([type=checkbox])")) typing(); });
  form.addEventListener("change", (e) => { if (e.target.matches("select, input[type=date], input[type=checkbox]")) applyForm("pushState"); });
  form.addEventListener("submit", (e) => { e.preventDefault(); applyForm("replaceState"); });
  clearBtn.onclick = () => { D.sp = new URLSearchParams(); commit("pushState"); };
  sortSel.onchange = () => { D.sp.set("sort", sortSel.value); D.sp.delete("page"); commit("pushState"); };
  dirBtn.onclick = () => { D.sp.set("sort", sortOf()[0]); D.sp.set("dir", sortOf()[1] === "asc" ? "desc" : "asc"); D.sp.delete("page"); commit("pushState"); };
  const goPage = (n) => { if (n > 1) D.sp.set("page", n); else D.sp.delete("page"); commit("pushState"); window.scrollTo(0, 0); };
  const pageNo = () => Math.max(parseInt(D.sp.get("page"), 10) || 1, 1);
  prev.onclick = () => goPage(pageNo() - 1); next.onclick = () => goPage(pageNo() + 1);
  const sortBy = (key) => { const [s, d] = sortOf(); D.sp.set("sort", key); D.sp.set("dir", s === key ? (d === "asc" ? "desc" : "asc") : key === "name" || key === "email" ? "asc" : "desc"); D.sp.delete("page"); commit("pushState"); };

  async function loadDir() {
    if (D.stopped) return;
    if (D.ctl) D.ctl.abort(); const ctl = D.ctl = new AbortController();
    exportNote.hidden = true; list.setAttribute("aria-busy", "true"); count.textContent = "Loading…";
    try { D.data = await jget("/api/crm/customers?" + D.sp, ctl.signal); }
    catch (e) { if (aborted(e) || ctl !== D.ctl) return; count.textContent = ""; list.replaceChildren(errBox(e, loadDir)); pager.hidden = true; list.removeAttribute("aria-busy"); return; }
    list.removeAttribute("aria-busy"); renderRows();
  }
  const filtersOn = () => [...D.sp.keys()].some((k) => !["sort", "dir", "page"].includes(k));
  function renderBar() {
    const d = D.data, n = D.sel.size;
    selInfo.textContent = n ? `${n} selected` : "";
    bar.replaceChildren(
      S.perms.manage ? el("button", { class: "btn small", type: "button", ...(n ? {} : { disabled: "" }), onclick: bulkTag }, n ? `Tag ${n} selected` : "Tag selected") : "",
      n ? el("button", { class: "btn small", type: "button", onclick: () => { D.sel.clear(); renderRows(); } }, "Clear selection") : "",
      S.perms.manage ? el("button", { class: "btn small", type: "button", onclick: () => saveSeg(false) }, "Save as segment") : "",
      S.perms.send ? el("button", { class: "btn small", type: "button", onclick: () => saveSeg(true) }, "Create campaign") : "",
      S.perms.export ? el("button", { class: "btn small", type: "button", onclick: exportCsv }, "Export CSV") : "");
    selAll.checked = !!d && d.customers.length > 0 && d.customers.every((r) => D.sel.has(r.ckey));
  }
  const nameOf = (r) => r.name || "(no name)";
  const qualCell = (r) => (r.qualifying_spend_paise === null ? el("span", { class: "crm-tip", title: GUEST_TIP, tabindex: "0", "aria-label": "Not available. " + GUEST_TIP }, "—") : m(r.qualifying_spend_paise));
  const STATUS = { active: ["Active", "ok"], lapsed: ["Lapsed 90d+", "warn"], never_purchased: ["Never purchased", "mute"] };
  const statusPill = (r) => pill(...STATUS[r.status] || [r.status, "mute"]);
  const check = (r) => el("input", { type: "checkbox", "aria-label": "Select " + nameOf(r), ...(D.sel.has(r.ckey) ? { checked: "" } : {}), onchange: (e) => { if (e.target.checked) D.sel.set(r.ckey, r); else D.sel.delete(r.ckey); renderBar(); } });
  const open = (r) => (e) => { if (!e.target.closest("a, button, input, label, .crm-tip")) location.hash = profileHref(r.ckey); };
  const COLS = [["Name", "name", (r) => el("a", { class: "name", href: profileHref(r.ckey) }, nameOf(r))], ["Email", "email", (r) => r.email], ["Mobile", 0, (r) => r.phone || "—"],
    ["Type", 0, (r) => pill(r.type === "guest" ? "Guest" : "Registered", r.type === "guest" ? "mute" : "")], ["First seen", "recent", (r) => day(r.first_seen_at)], ["First order", "first_order", (r) => day(r.first_order_at)],
    ["Last order", "last_order", (r) => day(r.last_order_at)], ["Paid orders", "orders", (r) => String(r.paid_orders)], ["Qualifying spend", 0, qualCell], ["Net paid", "spend", (r) => m(r.net_paise)],
    ["AOV", 0, (r) => (r.paid_orders ? m(r.aov_paise) : "—")], ["Tier", 0, (r) => r.tier_name || "—"], ["Consent", 0, (r) => consentPill(r.consent)], ["Last activity", 0, (r) => day(r.last_activity_at)], ["Status", 0, statusPill]];
  function renderRows() {
    const d = D.data; if (!d) return;
    const [s, dir] = sortOf(), pg = d.page, pages = Math.max(Math.ceil(d.total / d.page_size), 1);
    count.textContent = `${d.total.toLocaleString("en-IN")} customer${d.total === 1 ? "" : "s"}${filtersOn() ? " match" : ""}`;
    pager.hidden = d.total <= d.page_size; pageInfo.textContent = `Page ${pg} of ${pages}`; prev.disabled = pg <= 1; next.disabled = !d.more;
    if (!d.customers.length) {
      list.replaceChildren(el("div", { class: "empty" }, p(filtersOn() ? "No customers match these filters." : "No customers yet. People appear here once they create an account or place an order."), filtersOn() ? el("button", { class: "btn", type: "button", onclick: () => clearBtn.click() }, "Clear filters") : ""));
    } else if (mq.matches) {
      const head = el("tr", {}, el("th", { class: "crm-chk" }, ""), COLS.map(([l, key]) => el("th", { scope: "col", ...(key && key === s ? { "aria-sort": dir === "asc" ? "ascending" : "descending" } : {}) },
        key ? el("button", { class: "crm-th", type: "button", onclick: () => sortBy(key) }, l, key === s ? (dir === "asc" ? " ↑" : " ↓") : "") : l)));
      const rows = d.customers.map((r) => el("tr", { onclick: open(r) }, el("td", { class: "crm-chk" }, check(r)), COLS.map(([, , f]) => el("td", {}, f(r)))));
      list.replaceChildren(el("div", { class: "crm-tablewrap" }, el("table", { class: "ptable crm-table" }, el("thead", {}, head), el("tbody", {}, rows))));
    } else {
      list.replaceChildren(el("div", { class: "plist" }, d.customers.map((r) => el("div", { class: "prow crm-card", onclick: open(r) },
        el("div", { class: "top" }, check(r), el("div", { class: "grow" }, el("a", { class: "name", href: profileHref(r.ckey) }, nameOf(r)), el("div", { class: "sub crm-wrap" }, r.email), r.phone ? el("div", { class: "sub" }, r.phone) : ""), statusPill(r)),
        el("div", { class: "crm-pills" }, pill(r.type === "guest" ? "Guest" : "Registered", r.type === "guest" ? "mute" : ""), consentPill(r.consent), r.tier_name ? pill(r.tier_name) : ""),
        el("div", { class: "sub" }, `${r.paid_orders} paid order${r.paid_orders === 1 ? "" : "s"} · Net ${m(r.net_paise)}${r.paid_orders ? " · AOV " + m(r.aov_paise) : ""}`),
        el("div", { class: "sub" }, `Last order ${day(r.last_order_at)} · Last activity ${day(r.last_activity_at)}`)))));
    }
    renderBar();
  }
  selAll.onchange = () => { for (const r of D.data.customers) { if (selAll.checked) D.sel.set(r.ckey, r); else D.sel.delete(r.ckey); } renderRows(); };
  mq.addEventListener("change", () => { if (!D.stopped) renderRows(); });

  async function bulkTag() {
    const keys = [...D.sel.keys()];
    const ok = await formDlg({ title: `Tag ${keys.length} customer${keys.length === 1 ? "" : "s"}`, intro: ["Tags are internal labels. Only the customers you ticked are changed."], ok: "Apply",
      fields: [{ name: "tag", label: "Tag", required: true, max: 30, hint: "Letters, numbers, spaces, - and _ (max 30). Saved in lower case.", check: (v) => (/^[a-z0-9][a-z0-9 _-]{0,29}$/i.test(v.tag) ? "" : "Use letters, numbers, spaces, - or _, starting with a letter or number.") },
        { name: "action", label: "Action", type: "select", options: [["add", "Add this tag"], ["remove", "Remove this tag"]] }],
      submit: (v) => api("/api/crm/customers/bulk-tag", { tag: v.tag, ckeys: keys, confirm: true, remove: v.action === "remove" }) });
    if (ok) { toast(`Tag ${(ok.count === 1 ? "applied to 1 customer" : "applied to " + ok.count + " customers")}`); D.sel.clear(); renderRows(); }
  }
  async function saveSeg(thenCampaign) {
    const { tree, bad } = filtersTree(D.sp);
    if (bad.length) { toast("These filters cannot be saved in a segment: " + bad.join(", ") + ". Remove them first.", true); return; }
    const total = D.data ? D.data.total : 0;
    const res = await formDlg({ title: thenCampaign ? "Create campaign for these customers" : "Save as segment", intro: [`Saves the current filters (${total.toLocaleString("en-IN")} customers now) as a segment. It re-evaluates whenever it is used; only opted-in customers are ever emailed.`],
      fields: [{ name: "name", label: "Segment name", required: true, min: 2, max: 80 }], ok: thenCampaign ? "Save and continue" : "Save segment", submit: (v) => api("/api/crm/segments", { name: v.name, rules: tree }) });
    if (!res) return;
    if (thenCampaign) CRM.go("customers/campaigns?segment=" + enc(res.id)); else toast("Segment saved. Find it under Segments.");
  }
  async function exportCsv() {
    const ok = await ask("Export customers to CSV", ["Exports up to 5,000 customers matching the current filters: name, email, phone, orders, spend, tier and marketing consent.",
      "Unsubscribed and non-opted-in people are still in the export. They are only excluded from marketing sends.", "The file contains personal data: store and share it carefully. The export is recorded in the audit log."], "Download CSV");
    if (!ok) return;
    const e = new URLSearchParams(D.sp); for (const k of ["page", "sort", "dir"]) e.delete(k);
    try {
      const r = await fetch("/api/crm/customers/export.csv?" + e);
      if (r.status === 401) { location.reload(); return; }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Export failed");
      const cut = r.headers.get("X-Export-Truncated");
      download(await r.blob(), `customers-${new Date().toISOString().slice(0, 10)}.csv`);
      toast("CSV downloaded");
      if (cut) { exportNote.textContent = "Only the first 5,000 matching customers were exported. Narrow the filters and export again to get the rest."; exportNote.hidden = false; }
    } catch (err) { toast(err.message, true); }
  }

  syncForm(); loadDir();
  getMeta().then((meta) => { if (!D.stopped) { fillMeta(meta); syncForm(); } }).catch(() => {});
  return { sync() { D.sp = cleanSp(parseHash(location.hash).q); D.sel.clear(); syncForm(); loadDir(); }, reload: loadDir, stop() { D.stopped = true; if (D.ctl) D.ctl.abort(); } };
}

// ── Profile ─────────────────────────────────────────────────────────
const dl = (rows) => el("dl", { class: "crm-dl" }, rows.filter((r) => r && r[1] !== null && r[1] !== undefined && r[1] !== false).flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
function tile(label, value, def) {
  const d = el("p", { class: "crm-def", hidden: "" }, def);
  const b = el("button", { class: "crm-info", type: "button", "aria-label": `What does "${label}" mean?`, "aria-expanded": "false", title: def, onclick: () => { d.hidden = !d.hidden; b.setAttribute("aria-expanded", String(!d.hidden)); } }, "ⓘ");
  return el("div", { class: "tile crm-tile" }, el("span", {}, label + " ", b), el("b", {}, value), d);
}
// A collapsible card whose body is fetched the first time it is opened.
function lazy(title, fill, openNow) {
  const body = el("div", { class: "crm-lazy" }); let loaded = false;
  const d = el("details", { class: "pcard crm-sec", ...(openNow ? { open: "" } : {}) }, el("summary", {}, el("h2", { class: "crm-h" }, title)), body);
  const go = () => { if (d.open && !loaded) { loaded = true; load(body, () => fill(body)); } };
  d.addEventListener("toggle", go); if (openNow) go();
  return d;
}
const card = (title, ...kids) => el("section", { class: "pcard" }, el("h2", { class: "crm-h" }, title), ...kids);
const SVG = "http://www.w3.org/2000/svg";
function sparkline(trend) {
  const t = new Date(Date.now() + 19800000); let y = t.getUTCFullYear(), mo = t.getUTCMonth(); const keys = [];
  for (let i = 0; i < 12; i++) { keys.unshift(`${y}-${String(mo + 1).padStart(2, "0")}`); if (--mo < 0) { mo = 11; y--; } }
  const by = new Map(trend.map((x) => [x.m, x])), max = Math.max(1, ...trend.map((x) => x.n)), lab = (k) => new Date(k + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" });
  const svg = document.createElementNS(SVG, "svg"); svg.setAttribute("viewBox", "0 0 240 84"); svg.setAttribute("class", "crm-spark"); svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Orders per month, ${lab(keys[0])} to ${lab(keys[11])}: ${trend.reduce((a, x) => a + x.n, 0)} counted orders`);
  const add = (tag, attrs, text) => { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text) n.textContent = text; svg.append(n); return n; };
  keys.forEach((k, i) => { const x = by.get(k), n = x ? x.n : 0, h = n ? Math.max(4, (n / max) * 56) : 1.5; const r = add("rect", { x: i * 20, y: 60 - h, width: 16, height: h, rx: 2, class: n ? "bar" : "bar0" }); const ti = document.createElementNS(SVG, "title"); ti.textContent = `${lab(k)}: ${n} order${n === 1 ? "" : "s"}${x ? ", " + inr(x.net) : ""}`; r.append(ti); });
  add("text", { x: 0, y: 78, class: "lbl" }, lab(keys[0])); add("text", { x: 236, y: 78, class: "lbl", "text-anchor": "end" }, lab(keys[11]));
  const table = el("table", { class: "hist" }, el("thead", {}, el("tr", {}, ["Month", "Orders", "Net paid"].map((h) => el("th", {}, h)))), el("tbody", {}, keys.filter((k) => by.has(k)).map((k) => el("tr", {}, el("td", {}, lab(k)), el("td", {}, String(by.get(k).n)), el("td", {}, m(by.get(k).net))))));
  return el("div", {}, el("h3", { class: "sec" }, "Orders per month (last 12 months)"), svg, el("details", { class: "crm-tbl" }, el("summary", {}, "View as table"), trend.length ? table : p("No counted orders in the last 12 months.")));
}
function orderCard(o) {
  const shipments = o.shipments.map((s) => { const link = s.tracking_url && safeHttps(s.tracking_url);
    return el("div", { class: "ship" }, el("div", { class: "ship-top" }, el("b", {}, s.courier || "Courier"), el("span", { class: "sub" }, [s.shipped_on && "Shipped " + s.shipped_on, s.est_delivery && "Est. delivery " + s.est_delivery].filter(Boolean).join(" · "))),
      s.awb ? el("div", { class: "awb" }, "AWB ", el("span", { class: "mono" }, s.awb)) : "", link ? el("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, "Track shipment") : ""); });
  const rows = [["Subtotal", m(o.subtotal_paise)], ["GST", m(o.gst_paise)], o.shipping_paise ? ["Shipping", m(o.shipping_paise)] : null, o.member_discount_paise ? ["Member discount", "− " + m(o.member_discount_paise)] : null,
    o.campaign_discount_paise ? ["Campaign discount", "− " + m(o.campaign_discount_paise)] : null, ["Total", el("b", {}, m(o.total_paise))], o.paid_paise ? ["Paid", m(o.paid_paise)] : null,
    o.refunded_paise ? ["Refunded", el("span", { class: "crm-neg" }, m(o.refunded_paise))] : null, o.counts ? ["Counted as revenue", m(o.net_paise)] : null];
  return el("article", { class: "prow crm-order" },
    el("div", { class: "top" }, el("div", { class: "grow" }, el("b", { class: "mono" }, "#" + o.id.slice(0, 8)), el("div", { class: "sub" }, dt(o.created_at) + (o.guest ? " · guest checkout" : "") + (o.payment_method ? " · " + o.payment_method : ""))),
      el("div", { class: "crm-pills" }, pill(cap(o.payment_status), o.payment_status === "paid" ? "paid" : "unpaid"), pill(cap(o.status), "st-" + o.status), o.counts ? "" : pill("Not counted", "mute"))),
    ["cancelled", "returned"].includes(o.status) ? el("p", { class: "note bad" }, `This order was ${o.status}. It does not count as revenue.`) : "",
    el("ul", { class: "crm-items" }, o.items.length ? o.items.map((i) => el("li", {}, `${i.name} × ${i.qty}`)) : el("li", { class: "sub" }, "No items recorded")),
    dl(rows), ...shipments, o.order_url && o.order_url.startsWith("#/orders") ? el("a", { class: "btn small", href: o.order_url }, "Open order page") : "");
}

function mountProfile(box, ckey) {
  const base = "/api/crm/customers/" + enc(ckey), content = el("div");
  box.append(el("a", { class: "btn link", href: S.dirHash || "#/customers" }, "← All customers"), content);
  const reload = async () => { const y = scrollY; try { draw(await jget(base)); scrollTo(0, y); } catch (e) { toast(e.message, true); } };
  load(content, async () => draw(await jget(base)), "Loading customer…");

  function draw(d) {
    const c = d.customer, s = d.summary, df = d.defs || {};
    const head = el("section", { class: "pcard" },
      el("div", { class: "pcard-head" }, el("h2", { class: "crm-h crm-name" }, c.name || "(no name)"), el("div", { class: "crm-pills" }, pill(c.type === "guest" ? "Guest" : "Registered", c.type === "guest" ? "mute" : ""), s.tier ? pill(s.tier.name + " tier", "ok") : "", consentPill(d.consent.status))),
      dl([["Customer ID", el("span", { class: "mono" }, c.ckey)], ["Email", el("span", {}, c.email + " ", c.email_verified ? pill("Verified", "ok") : pill("Not verified (guest)", "mute"))], ["Phone", c.phone || "—"],
        ["First seen", day(c.first_seen_at)], ["First order", day(s.first_order_at)], ["Last order", day(s.last_order_at)], ["Rewards tier", c.type === "guest" ? "None (guest)" : s.tier ? s.tier.name : "None yet"]]),
      c.linked_guest_orders > 0 ? el("p", { class: "note" }, `Includes ${c.linked_guest_orders} guest order${c.linked_guest_orders === 1 ? "" : "s"} placed with an identical email.`) : "");
    const strip = el("div", { class: "tiles crm-strip", "aria-label": "Value summary" },
      tile("Net paid", m(s.net_paise), df.net_paid), tile("Gross paid", m(s.gross_paise), df.gross_paid), tile("Refunds", m(s.refund_paise), df.refunds),
      tile("Refund rate", s.refund_rate_pct + "%", "Refunds ÷ gross paid, over all counted orders."), tile("Avg order value", s.paid_orders ? m(s.aov_paise) : "—", df.aov),
      tile("Days since last purchase", s.days_since_last_order === null ? "—" : String(s.days_since_last_order), "Whole days since the last paid order."), tile("Avg days between orders", s.avg_days_between_orders === null ? "—" : String(s.avg_days_between_orders), "(Last paid order − first paid order) ÷ (paid orders − 1). Needs 2 or more orders."),
      tile("Paid orders", String(s.paid_orders), df.paid_order), tile("Best category", s.best_category || "—", "Category with the most units across counted orders."),
      tile("Membership savings", m(s.membership_discount_savings_paise), "Sum of member discounts on counted orders. Campaign discounts are separate."));
    const spend = card("Spending & membership",
      el("div", { class: "crm-two" }, el("div", { class: "crm-box" }, el("span", { class: "sub" }, "Membership-qualifying spend"), el("b", {}, m(s.qualifying_spend_paise)), el("span", { class: "sub" }, c.type === "guest" ? "Guests are not in Rewards." : df.qualifying_spend || "")),
        el("div", { class: "crm-box" }, el("span", { class: "sub" }, "Accounting revenue (net paid)"), el("b", {}, m(s.net_paise)), el("span", { class: "sub" }, "Includes GST and shipping, after refunds."))),
      el("p", { class: "note" }, "These two numbers differ on purpose: qualifying spend only counts orders placed while signed in (plus audited manual adjustments) and excludes GST and shipping; accounting revenue counts every paid order."),
      dl([["Tier", s.tier ? s.tier.name : "None"], s.next_tier ? ["Next tier", `${s.next_tier.name}, ${m(s.next_tier.remaining_paise)} to go`] : null, ["Campaign discounts used", m(s.campaign_discount_paise)]]),
      d.membership.length ? el("ul", { class: "hlist" }, d.membership.map((x) => el("li", {}, pill(x.active ? "Active" : cap(x.status), x.active ? "ok" : "mute"), ` Membership bought ${day(x.purchased_at)}, expires ${day(x.expires_at)}`))) : p(c.type === "guest" ? "" : "No paid membership."),
      sparkline(d.trend));
    content.replaceChildren(head, strip, spend, ordersSection(d), timelineSection(), interestsSection(), consentSection(d), actionsSection(d, reload));
  }

  function ordersSection(d) {
    const out = el("div", { class: "plist crm-orders", "aria-live": "polite" }); let tok = 0;
    const F = { from: el("input", { type: "date", "aria-label": "Orders from date" }), to: el("input", { type: "date", "aria-label": "Orders to date" }),
      pay: el("select", { "aria-label": "Payment status" }, el("option", { value: "" }, "Any payment"), el("option", { value: "paid" }, "Paid"), el("option", { value: "unpaid" }, "Unpaid")),
      prod: el("select", { "aria-label": "Product" }, el("option", { value: "" }, "Any product")), min: el("input", { type: "number", min: "0", placeholder: "Min ₹", "aria-label": "Minimum order value in rupees", inputmode: "decimal" }), max: el("input", { type: "number", min: "0", placeholder: "Max ₹", "aria-label": "Maximum order value in rupees", inputmode: "decimal" }) };
    getMeta().then((mt) => F.prod.append(...mt.products.map((x) => el("option", { value: x.id }, x.name)))).catch(() => {});
    const show = (o, trunc) => out.replaceChildren(...(o.length ? o.map(orderCard) : [p("No orders match.")]), trunc ? p("Showing the latest 100 orders. Use the filters to narrow down.") : "");
    show(d.orders, d.orders_truncated);
    const run = async () => {
      const q = new URLSearchParams(), my = ++tok;
      for (const [k, v] of [["ofrom", F.from.value], ["oto", F.to.value], ["opay", F.pay.value], ["oproduct", F.prod.value], ["omin", F.min.value], ["omax", F.max.value]]) if (v) q.set(k, v);
      out.replaceChildren(p("Loading orders…"));
      try { const r = await jget(base + "?" + q); if (my === tok) show(r.orders, r.orders_truncated); } catch (e) { if (my === tok) out.replaceChildren(errBox(e, run)); }
    };
    const go = debounce(run, 300);
    const f = el("form", { class: "crm-ofilters", onsubmit: (e) => e.preventDefault() }, ...Object.values(F), el("button", { class: "btn link", type: "button", onclick: () => { for (const x of Object.values(F)) x.value = ""; run(); } }, "Clear"));
    f.addEventListener("input", go); f.addEventListener("change", go);
    return card("Order history", p("Line prices are not stored on orders; totals are authoritative."), f, out);
  }

  function timelineSection() {
    let before = null; const ol = el("ol", { class: "crm-tl" }), info = el("div"), moreBtn = el("button", { class: "btn", type: "button" }, "Load older");
    return lazy("Activity timeline", async (body) => {
      body.replaceChildren(info, ol, moreBtn);
      const page = async () => {
        moreBtn.disabled = true;
        try {
          const r = await jget(base + "/timeline" + (before ? "?before=" + before : ""));
          if (!before) { const t = r.tracking; info.replaceChildren(t.events_recorded === 0 ? el("p", { class: "note" }, "No tracked activity is stored for this customer, so browsing behaviour is unknown. Only order records are shown below. ") : "", p(t.note)); }
          if (!before && !r.events.length) ol.replaceChildren(el("li", { class: "sub" }, "No history yet."));
          else ol.append(...r.events.map(eventLi));
          before = r.next_before; moreBtn.hidden = !r.more; info.querySelector(".msg") && info.querySelector(".msg").remove();
        } catch (e) { info.append(el("p", { class: "msg", role: "alert" }, e.message)); }
        moreBtn.disabled = false;
      };
      moreBtn.onclick = page; await page();
    }, true);
  }
  const KIND = { account_created: "Account created", order_placed: "Order placed", payment_recorded: "Payment recorded", refund: "Refund recorded", membership_tier_changed: "Rewards tier changed", membership_purchased: "Membership purchased", transactional_email: "Order email sent",
    marketing_email_sent: "Marketing email sent", marketing_email_delivered: "Marketing email delivered", marketing_email_bounced: "Marketing email bounced", marketing_email_clicked: "Clicked a marketing email", consent_opt_in: "Opted in to marketing", consent_unsubscribe: "Unsubscribed from marketing",
    consent_suppress: "Blocked from marketing", consent_unsuppress: "Marketing block removed", page_view: "Viewed a page", product_view: "Viewed a product", search: "Searched the store", add_to_cart: "Added to cart", remove_from_cart: "Removed from cart", begin_checkout: "Started checkout", membership_view: "Viewed the membership page", email_click: "Clicked an email link" };
  const detailText = (dd) => (dd ? Object.entries(dd).filter(([, v]) => v !== null && v !== "" && v !== undefined).map(([k, v]) => `${cap(k.replace(/_(paise|at)$/, ""))}: ${/_paise$/.test(k) ? inr(v) : /_at$/.test(k) ? day(v) : typeof v === "boolean" ? (v ? "yes" : "no") : v}`).join(" · ") : "");
  function eventLi(e) {
    const tracked = e.source === "tracked", ref = e.order_url && e.order_url.startsWith("#/orders") ? el("a", { href: e.order_url }, "Order #" + String(e.ref).slice(0, 8)) : e.product ? "Product: " + e.product : e.kind.startsWith("marketing_email") && e.ref ? "Campaign " + String(e.ref).slice(0, 8) : "";
    return el("li", { class: "crm-ev" }, el("div", { class: "crm-ev-top" }, el("time", {}, dt(e.ts)), pill(tracked ? "Tracked activity" : "Order records", tracked ? "" : "mute")),
      el("div", { class: "crm-ev-title" }, KIND[e.kind] || cap(e.kind)), ref ? el("div", { class: "sub" }, ref) : "", detailText(e.detail) ? el("div", { class: "sub" }, detailText(e.detail)) : "");
  }

  function interestsSection() {
    return lazy("Product interests", async (body) => {
      const r = await jget(base + "/interests"), o = r.observed, inf = r.inferred, li = (t) => el("li", {}, t), none = (t) => p(t);
      const ul = (arr, f, empty) => (arr.length ? el("ul", { class: "hlist" }, arr.map((x) => li(f(x)))) : none(empty));
      body.replaceChildren(
        el("div", { class: "crm-obs" }, el("h3", { class: "sec" }, "Observed (from records)"),
          o.last_purchased ? p(`Last purchased: ${o.last_purchased.name} on ${day(o.last_purchased.at)}`, "") : none("No purchases yet."),
          el("h4", {}, "Most purchased"), ul(o.most_purchased, (x) => `${x.name}: ${x.qty} units in ${x.orders} order${x.orders === 1 ? "" : "s"} (usually ${x.typical_qty} at a time), last ${day(x.last_at)}`, "Nothing purchased yet."),
          el("h4", {}, "Favourite categories"), ul(o.favourite_categories, (x) => `${x.category}: ${x.units} units`, "No category data."),
          el("h4", {}, "Most viewed products"), o.viewed_available ? ul(o.most_viewed, (x) => `${x.name}: ${x.views} view${x.views === 1 ? "" : "s"}, last ${day(x.last_at)}`, "No tracked product views.") : none("Views are only recorded for signed-in customers who allowed tracking. Guests have none.")),
        el("div", { class: "crm-inf" }, el("h3", { class: "sec" }, "Inferred (suggestions, not facts)"), p(inf.note),
          el("h4", {}, "Possible repeat-buy timing"), ul(inf.repeat_cadence, (x) => `${x.name}: bought on ${x.purchases} separate days, about every ${x.median_days} days. Next around ${day(x.expected_next_at)}.`, "Needs a product bought on 3 or more separate days."),
          el("h4", {}, "Similar customers also bought"), ul(inf.also_bought_by_similar_customers, (x) => `${x.name}: bought by ${x.other_customers} similar customer${x.other_customers === 1 ? "" : "s"}`, "No suggestions yet.")));
    });
  }

  function consentSection(d) {
    const k = d.consent;
    return el("section", { class: "pcard" }, el("h2", { class: "crm-h" }, "Marketing consent & campaigns"),
      dl([["Status", consentPill(k.status)], ["Can receive marketing", k.eligible ? "Yes (explicit opt-in)" : "No"], k.source ? ["Source", k.source] : null, k.policy_version ? ["Policy version", k.policy_version] : null,
        k.consented_at ? ["Opted in", dt(k.consented_at)] : null, k.unsubscribed_at ? ["Unsubscribed", dt(k.unsubscribed_at)] : null, k.suppression_reason ? ["Block reason", k.suppression_reason] : null, k.updated_at ? ["Last changed", dt(k.updated_at)] : null]),
      k.status === "none" ? p("This person has never opted in. Placing an order does not make them eligible for marketing email.") : "",
      el("details", { class: "crm-tbl" }, el("summary", {}, `Consent log (${k.log.length})`), k.log.length ? el("table", { class: "hist" }, el("thead", {}, el("tr", {}, ["When", "Action", "Source", "Policy", "By"].map((h) => el("th", {}, h)))),
        el("tbody", {}, k.log.map((x) => el("tr", {}, el("td", {}, dt(x.created_at)), el("td", {}, cap(x.action)), el("td", {}, x.source || "—"), el("td", {}, x.policy_version || "—"), el("td", {}, x.actor || "—"))))) : p("No consent events.")),
      lazy("Campaign history", async (body) => {
        const r = await jget(base + "/campaigns");
        body.replaceChildren(r.campaigns.length ? el("table", { class: "hist" }, el("thead", {}, el("tr", {}, ["Campaign", "Status", "Sent", "Delivered", "Clicked"].map((h) => el("th", {}, h)))),
          el("tbody", {}, r.campaigns.map((x) => el("tr", {}, el("td", {}, x.name), el("td", {}, cap(x.status)), el("td", {}, day(x.sent_at)), el("td", {}, day(x.delivered_at)), el("td", {}, x.clicked_at ? `${day(x.clicked_at)} (${x.click_count})` : "—"))))) : p("No campaign emails sent to this customer."));
      }));
  }

  function actionsSection(d, reload) {
    const c = d.customer, mg = S.perms.manage, status = d.consent.status;
    const wrap = el("section", { class: "pcard" }, el("h2", { class: "crm-h" }, "Admin actions"));
    if (!mg) wrap.append(p("You can view this customer but not change them."));
    // tags
    let tags = d.tags.slice(); const tagBox = el("div", { class: "crm-tags" }), tagIn = el("input", { type: "text", maxlength: "30", placeholder: "Add a tag", "aria-label": "New tag", autocomplete: "off" });
    const drawTags = () => tagBox.replaceChildren(...(tags.length ? tags.map((t) => el("span", { class: "pill crm-tag" }, t, mg ? el("button", { type: "button", class: "crm-x", "aria-label": "Remove tag " + t, onclick: () => editTags({ remove: [t] }) }, "×") : "")) : [p("No tags.")]));
    async function editTags(body) { try { tags = (await api(base + "/tags", body)).tags; drawTags(); } catch (e) { toast(e.message, true); } }
    const addTag = async () => { const t = tagIn.value.trim(); if (!t) return; await editTags({ add: [t] }); tagIn.value = ""; };
    tagIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } });
    drawTags(); wrap.append(el("h3", { class: "sec" }, "Tags"), tagBox, mg ? el("div", { class: "crm-inline" }, tagIn, el("button", { class: "btn", type: "button", onclick: addTag }, "Add tag")) : "");
    // notes
    const notes = d.notes.slice(), noteBox = el("ul", { class: "hlist" }), noteIn = el("textarea", { rows: "2", maxlength: "1000", "aria-label": "New internal note", placeholder: "Internal note (never shown to the customer)" });
    const drawNotes = () => noteBox.replaceChildren(...(notes.length ? notes.map((n) => el("li", {}, el("div", {}, n.body), el("div", { class: "sub" }, `${n.actor} · ${dt(n.created_at)}`))) : [el("li", { class: "sub" }, "No notes.")]));
    drawNotes(); wrap.append(el("h3", { class: "sec" }, "Internal notes"), noteBox, mg ? el("div", { class: "crm-inline" }, noteIn, el("button", { class: "btn", type: "button", onclick: async () => {
      try { notes.unshift(await api(base + "/notes", { body: noteIn.value })); noteIn.value = ""; drawNotes(); } catch (e) { toast(e.message, true); } } }, "Add note")) : "");
    // edit details
    if (mg && c.type === "registered") wrap.append(el("h3", { class: "sec" }, "Account details"), el("button", { class: "btn", type: "button", onclick: async () => {
      const r = await formDlg({ title: "Edit name and phone", intro: ["The email is the sign-in identity and cannot be changed here."], fields: [{ name: "name", label: "Name", max: 100, value: c.name || "" }, { name: "phone", label: "Mobile (10 digits)", type: "text", max: 15, value: c.phone || "", autocomplete: "off" }],
        submit: (v) => api(base + "/meta", { name: v.name, phone: v.phone }) });
      if (r) { toast("Details saved"); reload(); } } }, "Edit name / phone"));
    // consent
    if (mg) {
      const act = async (action, title, intro, danger, needReason) => {
        if (!needReason) { if (!(await ask(title, intro, "Unsubscribe", true))) return; try { await api(base + "/consent", { action, confirm: true }); toast("Unsubscribed"); reload(); } catch (e) { toast(e.message, true); } return; }
        const r = await formDlg({ title, intro, danger, ok: title, fields: [{ name: "reason", label: "Reason", required: true, min: 3, max: 200 }], submit: (v) => api(base + "/consent", { action, confirm: true, reason: v.reason }) });
        if (r) { toast("Consent updated"); reload(); }
      };
      wrap.append(el("h3", { class: "sec" }, "Marketing consent"), p("You can withdraw or block marketing here. Only the customer can opt in."), el("div", { class: "rowact" },
        status === "subscribed" ? el("button", { class: "btn", type: "button", onclick: () => act("unsubscribe", "Unsubscribe from marketing", ["This stops all marketing email to this customer. Order emails are not affected. This cannot be undone by an admin: the customer must opt in again."], true, false) }, "Unsubscribe") : "",
        status !== "suppressed" ? el("button", { class: "btn danger", type: "button", onclick: () => act("suppress", "Block from marketing", ["Blocks (suppresses) this email address from every campaign and journey, even if they opt in again, until you unblock it."], true, true) }, "Block (suppress)") : "",
        status === "suppressed" ? el("button", { class: "btn", type: "button", onclick: () => act("unsuppress", "Unblock", ["Removes the block. The customer will be unsubscribed (not subscribed) until they opt in again."], false, true) }, "Unblock") : ""));
    }
    // campaigns / segments / exports
    const rows = el("div", { class: "rowact" });
    if (S.perms.send) rows.append(el("a", { class: "btn", href: "#/customers/campaigns?customer=" + enc(c.ckey) }, "Create email offer"));
    if (mg) rows.append(el("button", { class: "btn", type: "button", onclick: async () => {
      const r = await formDlg({ title: "Tag and build a segment", intro: ["Segments are rule-based, so there is no way to add one person directly. Tag this customer, then create a segment with the rule \"Has tag\"."], fields: [{ name: "tag", label: "Tag", required: true, max: 30, check: (v) => (/^[a-z0-9][a-z0-9 _-]{0,29}$/i.test(v.tag) ? "" : "Use letters, numbers, spaces, - or _.") }], ok: "Add tag",
        submit: async (v) => (await api(base + "/tags", { add: [v.tag] }), v.tag.toLowerCase()) });
      if (r) { toast("Tag added"); if (await ask("Create a segment from this tag?", [`Open the segment editor with the rule "Has tag: ${r}".`], "Open segment editor")) CRM.go("customers/segments?tag=" + enc(r)); else reload(); } } }, "Add to segment via tag"));
    if (S.perms.export) rows.append(el("button", { class: "btn", type: "button", onclick: async () => {
      if (!(await ask("Download this customer's data", ["Downloads everything held about this customer (profile, addresses, orders, activity, consent, notes) as a JSON file. It contains personal data. The download is recorded in the audit log."], "Download JSON"))) return;
      try { const r = await fetch(base + "/data.json"); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Download failed"); download(await r.blob(), "customer-data.json"); toast("Data downloaded"); } catch (e) { toast(e.message, true); } } }, "Export this customer's data"));
    if (rows.childNodes.length) wrap.append(el("h3", { class: "sec" }, "Campaigns, segments and data"), rows);
    // erasure
    if (S.perms.export) wrap.append(el("details", { class: "more crm-danger" }, el("summary", {}, "Danger zone: process erasure request"), p("Removes this customer's personal profile, consent, activity and notes. Orders, invoices and payments are retained for accounting and tax records and stay in your reports."),
      el("button", { class: "btn danger-solid", type: "button", onclick: async () => {
        const r = await formDlg({ title: "Process erasure request", danger: true, ok: "Erase personal data", intro: ["This is permanent. Personal profile, saved addresses, sign-in sessions, activity, consent history, tags and notes are deleted or anonymised.", "Orders and payment records are NOT deleted: they are kept for statutory accounting. Orders still in progress block erasure."],
          fields: [{ name: "request_ref", label: "Request reference (ticket or email showing how the request was verified)", required: true, min: 3, max: 120 },
            { name: "confirm_email", label: `Type the customer's email (${c.email}) to confirm`, required: true, autocomplete: "off", check: (v) => (v.confirm_email.toLowerCase() === c.email ? "" : "The email does not match.") }], submit: (v) => api(base + "/erase", v) });
        if (r) { toast("Personal data erased. Orders were retained."); CRM.go("customers"); } } }, "Process erasure request")));
    return wrap;
  }
}

// ── Segments ────────────────────────────────────────────────────────
const CMPW = { eq: "is", ne: "is not", gt: "is more than", gte: "is at least", lt: "is less than", lte: "is at most", has: "includes", not_has: "does not include", is: "is", contains: "contains" };
const LBL = { net_paise: "Net paid revenue", approaching_tier: "Spend still needed for next tier" };
const fieldOf = (meta, key) => (meta && meta.fields.find((f) => f.key === key)) || null;
const labelOf = (meta, key) => LBL[key] || (fieldOf(meta, key) ? fieldOf(meta, key).label : cap(key)).replace(/ \(paise\)/, "");
function valueText(meta, key, v) {
  const f = fieldOf(meta, key), kind = f && f.kind;
  if (v === null || v === undefined || v === "") return "(not set)";
  if (kind === "money") return inr(v);
  if (kind === "bool") return v ? "yes" : "no";
  if (kind === "product" && meta) { const x = meta.products.find((q) => q.id === v); return x ? x.name : String(v); }
  if (key === "tier" && meta) { const x = meta.tiers.find((q) => q.id === v); return x ? x.name : String(v); }
  return String(v);
}
function summarise(node, meta, depth = 0) {
  if (!node || (Array.isArray(node.rules) && !node.rules.length)) return "everyone";
  if (Array.isArray(node.rules)) { const s = node.rules.map((r) => summarise(r, meta, depth + 1)).join(node.op === "or" ? " OR " : " AND "); return depth ? `(${s})` : s; }
  const lab = labelOf(meta, node.field), f = fieldOf(meta, node.field);
  if (f && f.kind === "bool") return node.value === false ? `NOT ${lab}` : lab;
  if (node.cmp === "has" || node.cmp === "not_has") return `${lab}: ${node.cmp === "not_has" ? "not " : ""}${valueText(meta, node.field, node.value)}`;
  return `${lab} ${CMPW[node.cmp] || node.cmp} ${valueText(meta, node.field, node.value)}`;
}
let CAMPS;
const getCampaigns = () => CAMPS || (CAMPS = jget("/api/crm/campaigns").then((r) => (Array.isArray(r) ? r : r.campaigns || []).filter((c) => c && c.id).map((c) => ({ id: c.id, name: c.name || c.id }))).catch(() => []));

function mountSegments(box, q) {
  if (q.get("edit") || q.get("new") || q.get("tag")) return segEditor(box, q);
  let archived = false;
  const out = el("div", { "aria-live": "polite" });
  const toggle = el("button", { class: "btn", type: "button", "aria-pressed": "false", onclick: () => { archived = !archived; toggle.setAttribute("aria-pressed", String(archived)); toggle.textContent = archived ? "Showing archived" : "Show archived"; refresh(); } }, "Show archived");
  box.append(el("div", { class: "pv-head" }, el("div", {}, el("h2", { class: "pv-title crm-h2" }, "Segments"), el("p", { class: "sub" }, "Saved rules that pick customers. Counts re-evaluate on demand; only opted-in customers are ever emailed.")),
    el("div", { class: "pv-actions" }, toggle, S.perms.manage ? el("a", { class: "btn primary", href: "#/customers/segments?new=1" }, "New segment") : "")), out);
  const refresh = () => load(out, async () => {
    const [meta, r] = await Promise.all([getMeta(), jget("/api/crm/segments" + (archived ? "?archived=1" : ""))]);
    if (!r.segments.length) { out.replaceChildren(el("div", { class: "empty" }, p(archived ? "No archived segments." : "No segments yet. Create one, or start from a template.")));
      return; }
    out.replaceChildren(el("div", { class: "crm-segs" }, r.segments.map((s) => segCard(s, meta, refresh))));
  });
  refresh();
}
function segCard(s, meta, refresh) {
  const act = (label, fn, cls) => el("button", { class: "btn small " + (cls || ""), type: "button", onclick: async (e) => { e.currentTarget.disabled = true; try { await fn(); } catch (err) { toast(err.message, true); e.currentTarget.disabled = false; } } }, label);
  const post = (a) => api(`/api/crm/segments/${s.id}/${a}`, {});
  const mg = S.perms.manage;
  return el("article", { class: "pcard crm-seg" }, el("h3", { class: "crm-h" }, s.name), el("p", { class: "crm-rules" }, "Customers where: " + summarise(s.rules, meta)),
    el("p", { class: "crm-nums" }, s.last_count === null ? "Not evaluated yet." : el("span", {}, el("b", {}, s.last_count.toLocaleString("en-IN")), " matching · ", el("b", {}, (s.last_eligible || 0).toLocaleString("en-IN")), " can receive marketing"), el("span", { class: "sub" }, s.last_eval_at ? ` · evaluated ${dt(s.last_eval_at)}` : "")),
    el("div", { class: "rowact" }, el("a", { class: "btn small", href: "#/customers?rules=" + enc(JSON.stringify(s.rules)) }, "View customers"),
      S.perms.send && !s.archived ? el("a", { class: "btn small", href: "#/customers/campaigns?segment=" + enc(s.id) }, "Create campaign") : "",
      mg && !s.archived ? [act("Evaluate", async () => { await post("evaluate"); toast("Counts updated"); refresh(); }), el("a", { class: "btn small", href: "#/customers/segments?edit=" + enc(s.id) }, "Edit"), act("Duplicate", async () => { await post("duplicate"); toast("Segment duplicated"); refresh(); }),
        act("Archive", async () => { if (!(await ask("Archive segment?", [`"${s.name}" is hidden from lists and can no longer be used for new campaigns. You can restore it later.`], "Archive"))) throw new Error("Cancelled"); await post("archive"); toast("Segment archived"); refresh(); }, "danger")] : "",
      mg && s.archived ? act("Restore", async () => { await post("restore"); toast("Segment restored"); refresh(); }) : ""));
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const normTree = (t, meta) => ({ op: t && t.op === "or" ? "or" : "and", rules: ((t && t.rules) || []).map((r) => (Array.isArray(r.rules) ? normTree(r, meta) : { field: r.field, cmp: r.cmp || (fieldOf(meta, r.field) || { cmps: ["eq"] }).cmps[0], value: r.value === undefined ? null : r.value })) });
const leaves = (t) => t.rules.reduce((n, r) => n + (Array.isArray(r.rules) ? leaves(r) : 1), 0);
const incomplete = (t) => t.rules.some((r) => (Array.isArray(r.rules) ? incomplete(r) : r.value === null || r.value === "" || Number.isNaN(r.value)));

function segEditor(box, q) {
  const id = q.get("edit");
  load(box, async () => {
    const [meta, camps, cur] = await Promise.all([getMeta(), getCampaigns(), id ? Promise.all([jget("/api/crm/segments"), jget("/api/crm/segments?archived=1")]).then(([a, b]) => [...a.segments, ...b.segments].find((s) => s.id === id)) : null]);
    if (id && !cur) throw new Error("Segment not found");
    let tree = cur ? normTree(cur.rules, meta) : q.get("tag") ? { op: "and", rules: [{ field: "tag", cmp: "has", value: q.get("tag").toLowerCase() }] } : { op: "and", rules: [] };
    const FIELDS = meta.fields.filter((f) => f.key !== "search");
    const nameIn = el("input", { id: "crm-seg-name", type: "text", maxlength: "80", value: cur ? cur.name : "", autocomplete: "off" });
    const treeBox = el("div", { class: "crm-tree" }), preview = el("div", { class: "preview", "aria-live": "polite" }), msg = el("p", { class: "msg", role: "alert" }), tplNote = el("p", { class: "sub" });
    const tpl = el("select", { id: "crm-seg-tpl", "aria-label": "Start from a template" }, el("option", { value: "" }, "Choose a template…"), meta.templates.map((t) => el("option", { value: t.key }, t.name)));
    tpl.onchange = () => { const t = meta.templates.find((x) => x.key === tpl.value); if (!t) return; tree = normTree(clone(t.tree), meta); if (!nameIn.value.trim()) nameIn.value = t.name.slice(0, 80);
      tplNote.textContent = (t.note ? t.note + " " : "") + (incomplete(tree) ? "Fill in the highlighted rules before saving." : "Review the rules, then save."); draw(); };
    const defVal = (f) => (f.kind === "bool" ? true : f.kind === "enum" ? f.options[0] : null);
    let pv = 0;
    const doPreview = debounce(async () => {
      const my = ++pv;
      if (incomplete(tree)) { preview.textContent = "Fill in every highlighted rule to see how many customers match."; return; }
      preview.textContent = "Counting…";
      try { const r = await api("/api/crm/segments/preview", { rules: tree }); if (my === pv) preview.textContent = `${r.count.toLocaleString("en-IN")} customer${r.count === 1 ? "" : "s"} match now · ${r.eligible.toLocaleString("en-IN")} can receive marketing email (explicit opt-in).${tree.rules.length ? "" : " No rules: this matches every customer."}`; }
      catch (e) { if (my === pv) preview.textContent = e.message; }
    }, 400);
    const changed = () => { msg.textContent = ""; doPreview(); };
    const opt = (v, l) => el("option", { value: v }, l);
    function valueInput(r, f) {
      const bad = () => r.value === null || r.value === "" || Number.isNaN(r.value);
      const mark = (n) => { if (bad()) n.setAttribute("aria-invalid", "true"); else n.removeAttribute("aria-invalid"); return n; };
      const choose = (items, ph) => { const s = el("select", { "aria-label": f.label }, opt("", ph), items.map(([v, l]) => opt(v, l))); s.value = r.value ?? ""; s.onchange = () => { r.value = s.value || null; mark(s); changed(); }; return mark(s); };
      if (f.kind === "bool") { const s = el("select", { "aria-label": f.label }, opt("yes", "Yes"), opt("no", "No")); s.value = r.value === false ? "no" : "yes"; r.value = s.value === "yes"; s.onchange = () => { r.value = s.value === "yes"; changed(); }; return s; }
      if (f.kind === "enum") return choose(f.options.map((o) => [o, cap(o)]), "Choose…");
      if (f.kind === "product") return choose(meta.products.map((x) => [x.id, `${x.name} (${x.category})`]), "Choose a product…");
      if (f.kind === "category") return choose(meta.categories.map((c) => [c, c]), "Choose a category…");
      if (f.key === "tier") return choose(meta.tiers.map((t) => [t.id, t.name]), "Choose a tier…");
      if (f.kind === "campaign" && camps.length) return choose(camps.map((c) => [c.id, c.name]), "Choose a campaign…");
      const money = f.kind === "money", numeric = money || f.kind === "number";
      const i = el("input", { type: numeric ? "number" : "text", "aria-label": f.label + (money ? " in rupees" : ""), ...(numeric ? { min: "0", step: money ? "0.01" : "1", inputmode: "decimal" } : { maxlength: "64", autocomplete: "off" }) });
      i.value = r.value === null || r.value === undefined ? "" : money ? String(r.value / 100) : String(r.value);
      i.oninput = () => { const v = i.value.trim(); r.value = v === "" ? null : money ? Math.round(Number(v) * 100) : numeric ? Number(v) : v; mark(i); changed(); };
      mark(i); return money ? el("span", { class: "inl-wrap" }, el("span", {}, "₹"), i) : i;
    }
    function leaf(r, parent) {
      const f = fieldOf(meta, r.field) || FIELDS[0];
      const fs = el("select", { "aria-label": "Field" }, FIELDS.map((x) => opt(x.key, labelOf(meta, x.key)))); fs.value = f.key;
      fs.onchange = () => { const nf = fieldOf(meta, fs.value); r.field = nf.key; r.cmp = nf.cmps[0]; r.value = defVal(nf); draw(); };
      const cs = el("select", { "aria-label": "Condition" }, f.cmps.map((c) => opt(c, CMPW[c] || c))); cs.value = r.cmp; cs.onchange = () => { r.cmp = cs.value; changed(); };
      return el("div", { class: "crm-leaf" }, fs, f.cmps.length > 1 ? cs : el("span", { class: "sub" }, CMPW[f.cmps[0]] || ""), valueInput(r, f),
        el("button", { class: "btn small danger", type: "button", "aria-label": "Remove rule", onclick: () => { parent.rules.splice(parent.rules.indexOf(r), 1); draw(); } }, "Remove"));
    }
    function group(node, depth, parent) {
      const op = el("select", { "aria-label": "Match mode" }, opt("and", "Match ALL of these"), opt("or", "Match ANY of these")); op.value = node.op; op.onchange = () => { node.op = op.value; changed(); };
      const full = leaves(tree) >= 25;
      return el("div", { class: "crm-grp", role: "group", "aria-label": depth ? "Nested group" : "Rules" }, el("div", { class: "crm-grphead" }, op, parent ? el("button", { class: "btn small danger", type: "button", onclick: () => { parent.rules.splice(parent.rules.indexOf(node), 1); draw(); } }, "Remove group") : ""),
        ...node.rules.map((r) => (Array.isArray(r.rules) ? group(r, depth + 1, node) : leaf(r, node))),
        el("div", { class: "rowact" }, el("button", { class: "btn small", type: "button", ...(full ? { disabled: "" } : {}), onclick: () => { const f = FIELDS[0]; node.rules.push({ field: f.key, cmp: f.cmps[0], value: defVal(f) }); draw(); } }, "Add rule"),
          depth < 2 ? el("button", { class: "btn small", type: "button", onclick: () => { node.rules.push({ op: "and", rules: [] }); draw(); } }, "Add group") : "", full ? el("span", { class: "sub" }, "Maximum 25 rules") : ""));
    }
    function draw() { treeBox.replaceChildren(group(tree, 0, null)); changed(); }
    const save = el("button", { class: "btn primary", type: "button", ...(S.perms.manage ? {} : { disabled: "" }), onclick: async () => {
      if (nameIn.value.trim().length < 2) { msg.textContent = "Give the segment a name (2–80 characters)."; nameIn.focus(); return; }
      if (incomplete(tree)) { msg.textContent = "Fill in every highlighted rule first."; const bad = treeBox.querySelector("[aria-invalid]"); if (bad) bad.focus(); return; }
      save.disabled = true;
      try { await api(cur ? "/api/crm/segments/" + cur.id : "/api/crm/segments", { name: nameIn.value.trim(), rules: tree }); toast("Segment saved"); location.hash = "#/customers/segments"; }
      catch (e) { msg.textContent = e.message; save.disabled = false; }
    } }, cur ? "Save changes" : "Save segment");
    box.replaceChildren(el("a", { class: "btn link", href: "#/customers/segments" }, "← Segments"), el("section", { class: "pcard" }, el("h2", { class: "crm-h" }, cur ? "Edit segment" : "New segment"),
      el("div", { class: "form" }, el("div", { class: "field" }, el("label", { for: "crm-seg-name" }, "Name"), nameIn),
        cur ? "" : el("div", { class: "field" }, el("label", { for: "crm-seg-tpl" }, "Start from a template"), tpl, el("span", { class: "hint" }, "Templates are suggestions. You can change every rule."), tplNote),
        el("h3", { class: "sec" }, "Rules"), treeBox, preview, msg, S.perms.manage ? "" : p("You can build and preview rules but not save them."), el("div", { class: "actions" }, save, el("a", { class: "btn", href: "#/customers/segments" }, "Cancel")))));
    draw();
  });
}

// ── Settings ────────────────────────────────────────────────────────
const DEFN = { paid_order: "Paid order", gross_paid: "Gross paid", refunds: "Refunds", net_paid: "Net paid", net_product: "Net product revenue", qualifying_spend: "Qualifying spend", aov: "Average order value", orders_per_customer: "Orders per customer", new_customer: "New customer", returning_customer: "Returning customer",
  active_customer: "Active customer", inactive_customer: "Inactive customer", repeat_rate: "Repeat rate", ltv: "Lifetime value", period: "Date ranges", email_eligible: "Marketing eligible", attributed_revenue: "Attributed revenue" };
function mountSettings(box) {
  const out = el("div", { "aria-live": "polite" }); box.append(out);
  const draw = (s) => {
    const mg = S.perms.manage;
    const track = async () => {
      const on = !s.tracking_enabled;
      const ok = await ask(on ? "Turn on activity tracking?" : "Turn off activity tracking?", on
        ? [`Records on-site activity (${s.events_tracked.map((e) => e.replace(/_/g, " ")).join(", ")}) so you can see browsing history and build behaviour segments.`, "Only signed-in customers who accept the tracking choice on the storefront consent bar are recorded, against their account. Nothing is recorded for visitors who decline or have not chosen. Data is deleted after the retention period.", "Order, payment, refund, membership and consent history never depends on this switch."]
        : ["No new activity will be recorded. Activity already stored stays until the retention period ends. Order and consent history is not affected."], on ? "Turn on" : "Turn off");
      if (!ok) return;
      try { S.settings = Object.assign(S.settings, await api("/api/crm/settings", { tracking_enabled: on })); toast(on ? "Tracking is on" : "Tracking is off"); draw(S.settings); } catch (e) { toast(e.message, true); }
    };
    const ret = el("input", { id: "crm-ret", type: "number", min: "30", max: "730", step: "1", value: String(s.retention_days), inputmode: "numeric" }), rmsg = el("p", { class: "msg", role: "alert" });
    const saveRet = async () => { rmsg.textContent = ""; try { S.settings = Object.assign(S.settings, await api("/api/crm/settings", { retention_days: Number(ret.value) })); toast("Retention saved"); draw(S.settings); } catch (e) { rmsg.textContent = e.message; } };
    const P = S.perms, yes = (b) => pill(b ? "Allowed" : "Not allowed", b ? "ok" : "mute");
    const emailBox = el("div");
    out.replaceChildren(
      card("Activity tracking", el("p", {}, pill(s.tracking_enabled ? "On" : "Off", s.tracking_enabled ? "ok" : "mute"), " ", s.tracking_enabled ? "Recording activity for consenting, signed-in customers." : "Not recording any on-site activity. Order history still works."),
        mg ? el("button", { class: "btn", type: "button", onclick: track }, s.tracking_enabled ? "Turn off tracking" : "Turn on tracking") : p("You need manage permission to change this."),
        el("div", { class: "field crm-ret" }, el("label", { for: "crm-ret" }, "Keep activity for (days, 30–730)"), ret, rmsg, mg ? el("button", { class: "btn", type: "button", onclick: saveRet }, "Save retention") : ""),
        dl([["Policy version", s.policy_version], ["Activity events stored", s.events_stored.toLocaleString("en-IN")], ["Oldest event", s.first_event_at ? day(s.first_event_at) : "—"], ["Marketing contacts", Object.keys(s.contacts).length ? Object.entries(s.contacts).map(([k, v]) => `${cap(k)}: ${v}`).join(" · ") : "None yet"]])),
      card("What is recorded", el("h3", { class: "sec" }, "Tracked activity (needs tracking on)"), el("ul", { class: "rules" }, s.events_tracked.map((e) => el("li", {}, cap(e)))),
        el("h3", { class: "sec" }, "Derived from existing records (always available)"), el("ul", { class: "rules" }, s.events_from_records.map((e) => el("li", {}, e))),
        p("Limits: activity before tracking was turned on is not available. Guests are never tracked. A quiet timeline means nothing was recorded, not that the customer did nothing.")),
      card("Your permissions", dl([["View customers", yes(P.view)], ["Manage (tags, notes, consent, segments)", yes(P.manage)], ["Export data / erase", yes(P.export)], ["Send campaigns", yes(P.send)]]), p("Export and send are limited to the owner by default. The owner can list more people with the CRM_EXPORT_EMAILS and CRM_SEND_EMAILS settings.")),
      emailBox,
      card("Definitions", p("How every number in this section is calculated."), el("dl", { class: "crm-dl crm-gloss" }, Object.entries(s.defs).flatMap(([k, v]) => [el("dt", {}, DEFN[k] || cap(k)), el("dd", {}, v)]))));
    if (CRM.pages.email) callPage("email", emailBox, new URLSearchParams());
  };
  load(out, async () => draw(S.settings));
}
})();
