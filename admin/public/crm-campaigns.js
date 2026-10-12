// Customers > Campaigns and Journeys. Shares el/api (app.js), toast/ask (products.js) and the CRM shell (customers.js).
// All text is inserted with textContent; the email preview runs in <iframe sandbox="" src> so nothing in it can execute.
(() => {
const CRM = window.CRM;
if (!CRM) return;
const NA = "Not available";
const inr0 = (p) => "₹" + (p / 100).toLocaleString("en-IN");
const rnd = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
// own fetch so a 403 can be told apart from other failures
async function call(path, body) {
  try {
    const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" }, body: JSON.stringify(body) });
    if (r.status === 401) { location.reload(); return { status: 401, d: {} }; }
    return { status: r.status, d: await r.json().catch(() => ({})) };
  } catch { return { status: 0, d: { error: "Network problem. Try again." } }; }
}
const denied = (root) => root.replaceChildren(el("p", { class: "ca-state" }, "You do not have permission to view this."));
const fail = (r) => toast(r.status === 403 ? "You do not have permission for this action" : r.d.error || "Something went wrong", true);
const field = (label, input, hint) => el("div", { class: "field" }, el("label", {}, label), input, hint ? el("small", { class: "sub" }, hint) : "");
const when2 = (s) => (s ? when(s) : "—");
const dtLocal = (s) => { if (!s) return ""; const d = new Date(s * 1000), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

async function banner() {
  const r = await call("/api/crm/email-status");
  if (r.status === 200 && !r.d.configured) return el("div", { class: "ca-card", role: "status" }, el("b", {}, "Email sending is not configured"), el("p", { class: "ca-why" }, "You can draft, preview and save, but nothing will be sent. Missing: " + (r.d.missing || []).join(", ")));
  return "";
}

// ── Campaigns ──
CRM.register("campaigns", async (root, arg) => {
  root.replaceChildren(el("p", { class: "ca-state" }, "Loading…"));
  if (arg) return editor(root, arg === "new" ? null : arg);
  const [b, r] = await Promise.all([banner(), call("/api/crm/campaigns")]);
  if (r.status === 403) return denied(root);
  if (r.status !== 200) return root.replaceChildren(el("p", { class: "ca-state" }, r.d.error || "Could not load campaigns"));
  const list = r.d.campaigns;
  root.replaceChildren(b, el("div", { class: "ca-custom" }, el("h2", { class: "h0" }, "Campaigns"), el("button", { class: "btn primary small", type: "button", onclick: () => CRM.go("campaigns/new") }, "New campaign")),
    list.length ? el("div", { class: "ca-grid" }, list.map((c) => el("div", { class: "ca-card" }, el("h3", {}, c.name), el("p", { class: "ca-why" }, `${c.status} · ${c.recipients} recipients · ${c.sent} sent · ${c.queued} queued`),
      el("button", { class: "btn small", type: "button", onclick: () => CRM.go("campaigns/" + c.id) }, c.status === "draft" ? "Edit" : "Open")))) : el("p", { class: "ca-empty" }, "No campaigns yet."));
});

async function editor(root, id) {
  const [seg, meta, cart, cur] = await Promise.all([call("/api/crm/segments"), call("/api/crm/segments/meta"), call("/api/campaigns"), id ? call("/api/crm/campaigns/" + id) : { status: 200, d: {} }]);
  if (cur.status === 403 || seg.status === 403) return denied(root);
  if (cur.status !== 200) return root.replaceChildren(el("p", { class: "ca-state" }, cur.d.error || "Campaign not found"));
  const c = cur.d.campaign || { name: "", subject: "", preview_text: "", body: { template: "standard", offer: { type: "announcement" }, products: [] }, status: "draft" };
  const b = c.body || {}, locked = c.status !== "draft";
  const v = (x) => (x ?? "");
  const f = {
    name: el("input", { maxlength: "100", value: v(c.name) }), subject: el("input", { maxlength: "150", value: v(c.subject) }), preview: el("input", { maxlength: "200", value: v(c.preview_text) }),
    heading: el("input", { maxlength: "120", value: v(b.heading) }), text: el("textarea", { rows: "6", maxlength: "5000" }), ctaLabel: el("input", { maxlength: "40", value: v(b.cta && b.cta.label) }), ctaPath: el("input", { maxlength: "150", placeholder: "/order.html", value: v(b.cta && b.cta.path) }),
    limit: el("input", { type: "number", min: "1", max: "5000", value: v(c.send_limit) }), sched: el("input", { type: "datetime-local", value: dtLocal(c.scheduled_at) }),
    emails: el("textarea", { rows: "3", placeholder: "one address per line (they must still have opted in)" }),
  };
  f.text.value = v(b.body); f.emails.value = (b.recipients || []).join("\n");
  const segSel = el("select", {}, el("option", { value: "" }, "— none (individual addresses) —"), (seg.d.segments || []).map((s) => el("option", { value: s.id }, s.name)));
  segSel.value = v(c.segment_id);
  const tpl = el("select", {}, el("option", { value: "standard" }, "Standard (with images)"), el("option", { value: "minimal" }, "Minimal (text only)")); tpl.value = b.template || "standard";
  const prods = el("select", { multiple: "", size: "5", "aria-label": "Products" }, (meta.d.products || []).map((p) => el("option", { value: p.id }, p.name)));
  for (const o of prods.options) o.selected = (b.products || []).includes(o.value);
  const carts = (cart.d.campaigns || []).map((x) => el("option", { value: x.id }, x.name));
  const offerSel = el("select", {}, [["announcement", "Announcement only"], ["membership_upgrade", "Membership upgrade (links to the membership page)"], ["cart_milestone", "Cart milestone (an existing, active one)"], ["new_product", "New product (needs products)"], ["reorder_reminder", "Reorder reminder (needs products)"]].map(([k, l]) => el("option", { value: k }, l)),
    ...["Coupon code", "Product discount", "Category discount", "Bundle discount", "Bulk discount", "Free shipping by code"].map((l) => el("option", { value: "", disabled: "" }, `${l}: Needs checkout coupon support (not built yet)`)));
  offerSel.value = (b.offer && b.offer.type) || "announcement";
  const cartSel = el("select", {}, el("option", { value: "" }, "— choose —"), carts); cartSel.value = v(b.offer && b.offer.cart_campaign_id);
  const gather = () => {
    const sched = f.sched.value ? Math.floor(new Date(f.sched.value).getTime() / 1000) : null;
    const emails = f.emails.value.split(/[\s,;]+/).filter(Boolean);
    return { name: f.name.value, subject: f.subject.value, preview_text: f.preview.value, segment_id: segSel.value || null, send_limit: f.limit.value ? Number(f.limit.value) : null, scheduled_at: sched, recipients: segSel.value ? [] : emails,
      body: { template: tpl.value, heading: f.heading.value, body: f.text.value, products: [...prods.selectedOptions].map((o) => o.value), cta: f.ctaLabel.value || f.ctaPath.value ? { label: f.ctaLabel.value, path: f.ctaPath.value } : null, offer: { type: offerSel.value, ...(offerSel.value === "cart_milestone" ? { cart_campaign_id: cartSel.value } : {}) } } };
  };
  const out = el("div", { class: "ca-card", "aria-live": "polite" }), pv = el("div", { class: "ca-card" });
  let cid = id;
  const save = async () => {
    const r = await call(cid ? "/api/crm/campaigns/" + cid : "/api/crm/campaigns", gather());
    if (r.status >= 300) { fail(r); return false; }
    if (!cid) { cid = r.d.campaign.id; history.replaceState(null, "", "#campaigns/" + cid); }
    toast("Saved"); return true;
  };
  const audience = async () => {
    if (!locked && !(await save())) return;
    const r = await call(`/api/crm/campaigns/${cid}/audience`, {});
    if (r.status >= 300) return fail(r);
    const a = r.d, x = a.excluded;
    out.replaceChildren(el("h3", {}, "Audience (current data)"), el("p", {}, `${a.total} matched · ${a.eligible} opted in · ${a.will_send} will receive`),
      el("p", { class: "ca-why" }, `Excluded: ${x.no_consent} no marketing consent, ${x.unsubscribed} unsubscribed, ${x.suppressed} suppressed${x.invalid_email ? `, ${x.invalid_email} invalid address` : ""}`),
      el("p", { class: "ca-why" }, a.sample.length ? "Sample: " + a.sample.join(", ") : "No eligible recipients"), a.over_cap ? el("p", { class: "ca-why" }, "Too many recipients: set a send limit of 5000 or less.") : "");
    return a;
  };
  const preview = async () => {
    if (!locked && !(await save())) return;
    const r = await call(`/api/crm/campaigns/${cid}/preview`, {});
    if (r.status >= 300) return fail(r);
    const frame = el("iframe", { sandbox: "", title: "Email preview", class: "cc-frame" }); frame.src = `/api/crm/campaigns/${cid}/preview.html`;
    const mobile = el("button", { class: "btn small", type: "button", "aria-pressed": "false" }, "Mobile"), desk = el("button", { class: "btn small", type: "button", "aria-pressed": "true" }, "Desktop");
    const size = (m) => { frame.className = "cc-frame" + (m ? " cc-mobile" : ""); mobile.setAttribute("aria-pressed", String(m)); desk.setAttribute("aria-pressed", String(!m)); };
    mobile.onclick = () => size(true); desk.onclick = () => size(false);
    pv.replaceChildren(el("h3", {}, "Preview"), el("p", { class: "ca-why" }, `Subject: ${r.d.subject}. ${r.d.note}`), el("div", { class: "ca-custom" }, desk, mobile), frame);
  };
  const testSend = async () => { if (!locked && !(await save())) return; const r = await call(`/api/crm/campaigns/${cid}/test-send`, {}); r.status < 300 ? toast("Test sent to " + r.d.sent_to) : fail(r); };
  const sendNow = async () => {
    if (!(await save())) return;
    const a = await audience(); if (!a) return;
    if (!a.will_send) return toast("No eligible recipients", true);
    const when_ = f.sched.value ? "scheduled for " + new Date(f.sched.value).toLocaleString("en-IN") : "sent now";
    if (!(await ask("Send this campaign?", [`"${f.name.value}" will be ${when_} to ${a.will_send} people who have opted in.`, "The recipient list is frozen when you confirm. This cannot be undone."], "Send to " + a.will_send, true))) return;
    const r = await call(`/api/crm/campaigns/${cid}/send`, { confirm: true, idempotency_key: rnd() });
    if (r.status >= 300) return fail(r);
    toast(r.d.noop ? "Already sent or scheduled" : "Campaign " + r.d.campaign.status); CRM.go("campaigns/" + cid);
  };
  const cancel = async () => { if (!(await ask("Cancel this campaign?", ["Queued emails will not be sent."], "Cancel campaign", true))) return; const r = await call(`/api/crm/campaigns/${cid}/cancel`, {}); r.status < 300 ? (toast("Cancelled"), CRM.go("campaigns/" + cid)) : fail(r); };
  const btn = (label, fn, cls = "") => el("button", { class: "btn small " + cls, type: "button", onclick: fn }, label);
  const form = el("div", { class: "ca-card" }, el("h3", {}, c.name || "New campaign"), el("p", { class: "ca-why" }, "Status: " + c.status + (locked ? " (read-only)" : "")),
    field("Name", f.name), field("Subject", f.subject), field("Preview text", f.preview), field("Heading", f.heading), field("Text (blank line = new paragraph)", f.text), field("Template", tpl),
    field("Products (names, prices and links are read live; prices shown ex-GST)", prods), field("Button label", f.ctaLabel), field("Button path", f.ctaPath, "A page on ntagz.com, e.g. /order.html"),
    field("Offer", offerSel, "Only offers the store can honour are available."), field("Cart milestone", cartSel), field("Audience: saved segment", segSel), field("…or individual addresses", f.emails),
    field("Send limit (optional, max 5000)", f.limit), field("Schedule (optional, your local time)", f.sched));
  if (locked) form.querySelectorAll("input,select,textarea").forEach((n) => { n.disabled = true; });
  const actions = el("div", { class: "ca-custom" }, locked ? "" : btn("Save draft", save), btn("Review audience", audience), btn("Preview", preview), btn("Send test to me", testSend),
    locked ? "" : btn(f.sched.value ? "Schedule…" : "Send…", sendNow, "primary"), ["draft", "scheduled", "sending"].includes(c.status) && cid ? btn("Cancel campaign", cancel) : "", btn("Back", () => CRM.go("campaigns")));
  const rep = el("div", { class: "ca-card" }); if (locked) report(rep, cid);
  root.replaceChildren(await banner(), form, actions, out, pv, locked ? rep : "");
}

async function report(box, id) {
  const r = await call(`/api/crm/campaigns/${id}/report`);
  if (r.status >= 300) return box.replaceChildren(el("p", { class: "ca-state" }, r.status === 403 ? "You do not have permission to view this report." : r.d.error || "Could not load the report"));
  const d = r.d, num = (x) => (x === null || x === undefined ? NA : String(x));
  const rows = [["Audience when sending started", num(d.eligible_at_send)], ["Queued", d.queued], ["Sent", d.sent], ["Delivered", d.delivered], ["Bounced", d.bounced], ["Complained", d.complained], ["Failed", d.failed], ["Skipped (opted out before send)", d.skipped],
    ["People who clicked", d.unique_clicks], ["Total clicks", d.click_count], ["Unsubscribes", num(d.unsubscribes)], ["Opens", NA + " (not tracked)"],
    ["Orders after a click (attributed, not incremental)", d.attributed_orders], ["Revenue after a click (attributed, not incremental)", inr0(d.attributed_revenue_paise)],
    ["Discount cost", d.discount_cost_paise === null ? NA : inr0(d.discount_cost_paise)], ["Estimated profit", NA]];
  box.replaceChildren(el("h3", {}, "Report"), el("div", { class: "ca-tiles" }, rows.map(([k, x]) => el("div", { class: "ca-tile" }, el("span", { class: "ca-lab" }, k), el("b", { class: x === NA || String(x).startsWith(NA) ? "ca-na" : "" }, String(x))))),
    el("p", { class: "ca-why" }, d.attribution_definition), el("p", { class: "ca-why" }, d.estimated_profit_note));
}

// ── Journeys ──
const LABELS = { delay_hours: "Wait (hours)", window_days: "Window (days)", min_gap_days: "Minimum days between marketing emails", lookback_days: "Look back (days)", days_after: "Days after the order", inactive_days: "Inactive for (days)", within_paise: "Within this much of the next tier (paise)" };
CRM.register("journeys", async (root) => {
  root.replaceChildren(el("p", { class: "ca-state" }, "Loading…"));
  const [b, r, meta] = await Promise.all([banner(), call("/api/crm/journeys"), call("/api/crm/segments/meta")]);
  if (r.status === 403) return denied(root);
  if (r.status !== 200) return root.replaceChildren(el("p", { class: "ca-state" }, r.d.error || "Could not load journeys"));
  root.replaceChildren(b, el("h2", { class: "h0" }, "Automated journeys"), el("p", { class: "ca-why" }, "Every journey starts off and in test mode. Test mode records who would receive an email and sends nothing."),
    el("div", { class: "ca-grid" }, r.d.journeys.map((j) => card(j, meta.d.products || [], () => CRM.go("journeys")))));
});

function card(j, products, reload) {
  const act = el("input", { type: "checkbox", id: "ja-" + j.id }), test = el("input", { type: "checkbox", id: "jt-" + j.id });
  act.checked = j.active; test.checked = j.test_mode;
  const inputs = {}, extra = el("div", {}), runsBox = el("div", { class: "ca-why" }), dry = el("div", { class: "ca-why" });
  const num = (k) => (inputs[k] = el("input", { type: "number", value: j.config[k] ?? "" }), field(LABELS[k], inputs[k]));
  const keys = Object.keys(j.config).filter((k) => LABELS[k]);
  extra.append(...keys.map(num));
  let prod = null;
  if (j.kind === "repeat_reminder") { prod = el("select", { multiple: "", size: "5", "aria-label": "Products" }, products.map((p) => el("option", { value: p.id }, p.name))); for (const o of prod.options) o.selected = (j.config.product_ids || []).includes(o.value); extra.append(field("Only for customers who bought (required)", prod, "Not assumed: NFC products are not necessarily replenished.")); }
  const subj = el("input", { maxlength: "150", value: j.config.subject ?? j.defaults.subject });
  const gatherCfg = () => { const c = {}; for (const k of keys) c[k] = Number(inputs[k].value); if (prod) c.product_ids = [...prod.selectedOptions].map((o) => o.value); c.subject = subj.value; return c; };
  const save = async () => {
    const goingLive = act.checked && !test.checked;
    if (goingLive && !(await ask("Send real emails?", [`"${j.name}" will email real customers who have opted in, up to 25 per run.`, "You can turn it off at any time."], "Turn on", true))) return;
    const r = await call("/api/crm/journeys/" + j.id, { active: act.checked, test_mode: test.checked, config: gatherCfg(), confirm_live: goingLive });
    r.status < 300 ? (toast("Saved"), reload()) : fail(r);
  };
  const preview = async () => { const r = await call(`/api/crm/journeys/${j.id}/run-now`, {}); if (r.status >= 300) return fail(r); dry.textContent = `Would receive now (nothing is sent): ${r.d.count}` + (r.d.count ? " — " + r.d.would_receive.map((x) => x.email).join(", ") : ""); };
  const runs = async () => {
    const r = await call(`/api/crm/journeys/${j.id}/runs`); if (r.status >= 300) return fail(r);
    runsBox.replaceChildren(...(r.d.runs.length ? r.d.runs.slice(0, 10).map((x) => el("div", {}, `${when(x.created_at)} · ${x.email} · ${x.status}${x.detail ? " · " + x.detail : ""}`)) : [el("div", {}, "No runs yet")]));
  };
  const c = j.last_20_runs;
  return el("div", { class: "ca-card" }, el("h3", {}, j.name), el("p", { class: "ca-why" }, `Last 20 runs: ${c.sent} sent, ${c.would_send} would send, ${c.skipped} skipped, ${c.error} errors`),
    el("div", { class: "field" }, el("label", { for: act.id }, act, " Active")), el("div", { class: "field" }, el("label", { for: test.id }, test, " Test mode (send nothing)")),
    field("Subject", subj), extra, el("div", { class: "ca-custom" }, el("button", { class: "btn primary small", type: "button", onclick: save }, "Save"), el("button", { class: "btn small", type: "button", onclick: preview }, "Who would receive now?"), el("button", { class: "btn small", type: "button", onclick: runs }, "Show recent runs")), dry, runsBox);
}
})();
