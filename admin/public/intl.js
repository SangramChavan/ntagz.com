// International: order actions (destination, quotations, payment link, verified payments), settings, USD price list, enquiries.
// Uses the helpers from app.js / orders.js / products.js ($, el, api, when, toast, actionDialog, labeled, postForm, key, openOrder, load).
// Text is inserted with textContent only. Every action is validated, guarded and audited by the server; the buttons here only offer them.
(() => {
  const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const money = (o, minor) => (o && o.currency === "USD" ? usdFmt.format(minor / 100) : inr(minor));
  window.intlMoney = money;
  const dollars = (minor) => (minor / 100).toFixed(2);
  const QS = { required: "Quote required", sent: "Quote sent", accepted: "Quote accepted", declined: "Quote declined", expired: "Quote expired" };
  const DS = { pending: "Destination to review", approved: "Destination approved", rejected: "Destination rejected" };
  const ymd = (d) => d.toISOString().slice(0, 10);
  const field = (id, label, input, hint) => labeled(id, label, input, hint);

  window.intlPills = (o) => (o.market === "INTL" ? el("span", {}, el("span", { class: "pill pre" }, "International · " + (o.country || "")), o.quote_status ? el("span", { class: "pill " + (o.quote_status === "accepted" ? "paid" : "unpaid") }, QS[o.quote_status] || o.quote_status) : "") : "");

  async function refreshOrder(o, d) { toast("Saved"); if ($("adlg").open) $("adlg").close(); await openOrder(o.id, d); load(); }

  function destinationDialog(o, decision) {
    const note = el("textarea", { id: "dnote", rows: "2", maxlength: "300", placeholder: decision === "reject" ? "Reason shown to the customer (required)" : "Internal note (optional)" }), k = key();
    actionDialog(decision === "approve" ? "Approve destination?" : "Reject destination?", [el("p", { class: "sub" }, `${o.name} · ${o.country} · ${o.txn_id}`), field("dnote", decision === "reject" ? "Reason for the customer" : "Note", note),
      el("p", { class: "sub" }, decision === "reject" ? "The customer is told on their order page that we cannot ship there. You can approve it again later." : "Approving does not send a quotation. Send the quotation next.")], decision === "approve" ? "Approve" : "Reject destination", {
      danger: decision === "reject", onSubmit: async () => refreshOrder(o, await postForm(`/api/orders/${o.id}/intl/destination`, { decision, note: note.value, idempotency_key: k })),
    });
  }

  function quoteDialog(o) {
    const k = key(), valid = (o.intl && o.intl.quote_valid_days) || 7;
    const ship = el("input", { id: "qship", inputmode: "decimal", placeholder: "0.00" }), incl = el("input", { id: "qincl", type: "checkbox" });
    const tax = el("input", { id: "qtax", inputmode: "decimal", placeholder: "0.00" }), oth = el("input", { id: "qoth", inputmode: "decimal", placeholder: "0.00" });
    const car = el("input", { id: "qcar", maxlength: "60", placeholder: "e.g. DHL, FedEx, UPS" }), meth = el("input", { id: "qmeth", maxlength: "80", placeholder: "e.g. Express Worldwide, sea freight" });
    const f1 = el("input", { id: "qf", type: "date" }), f2 = el("input", { id: "qt", type: "date" }), exp = el("input", { id: "qexp", type: "date", value: ymd(new Date(Date.now() + valid * 86400000)) });
    const cn = el("textarea", { id: "qcn", rows: "2", maxlength: "400", placeholder: "Shown to the customer, e.g. what is NOT included (customs duties, import taxes)" }), note = el("textarea", { id: "qnote", rows: "2", maxlength: "400", placeholder: "Internal note (never shown to the customer)" });
    const sum = el("p", { class: "bp-sum" }), upd = () => { const n = (v) => Math.round((Number(String(v).replace(/,/g, "")) || 0) * 100); sum.textContent = `Products ${money(o, o.subtotal)} + shipping ${money(o, n(ship.value))} + taxes/charges ${money(o, n(tax.value) + n(oth.value))} = ${money(o, o.subtotal + n(ship.value) + n(tax.value) + n(oth.value))}`; };
    [ship, tax, oth].forEach((x) => x.addEventListener("input", upd)); upd();
    actionDialog("Send shipping quotation", [el("p", { class: "sub" }, `${o.name} · ${o.country} · ${o.txn_id}. Quoted in ${o.currency}. Product prices cannot be changed here.`),
      field("qship", `Shipping charge (${o.currency}) *`, ship), el("label", { class: "chk" }, incl, " Shipping is included (only if the shipping charge is 0)"),
      el("div", { class: "two" }, field("qtax", "Taxes (specified)", tax), field("qoth", "Other charges", oth)),
      el("div", { class: "two" }, field("qcar", "Carrier", car), field("qmeth", "Shipping method *", meth)),
      el("div", { class: "two" }, field("qf", "Delivery window from", f1), field("qt", "to", f2)), field("qexp", "Quotation valid until *", exp), field("qcn", "Note about these charges", cn), field("qnote", "Internal note", note), sum,
      el("p", { class: "sub" }, "The customer receives an email with a secure link to accept or decline. Nothing is final until they accept.")], "Send quotation", {
      onSubmit: async () => refreshOrder(o, await postForm(`/api/orders/${o.id}/intl/quote`, { shipping: ship.value, shipping_included: incl.checked, taxes: tax.value, other: oth.value, carrier: car.value, method: meth.value, est_from: f1.value, est_to: f2.value, expires: exp.value, charges_note: cn.value, note: note.value, confirm: true, idempotency_key: k })),
    });
  }

  function decisionDialog(o, q, decision) {
    const why = el("textarea", { id: "dwhy", rows: "2", maxlength: "300", placeholder: "How and when did the customer tell you? (e.g. email on 12 Oct)" }), k = key();
    actionDialog(`Record ${decision} on the customer's behalf?`, [el("p", { class: "sub" }, `Quotation v${q.version}: ${money(o, q.total_minor)}`), field("dwhy", "Evidence (required)", why), el("p", { class: "sub" }, "Only record this when the customer has clearly told you. It is attributed to you and cannot be undone.")], "Record " + decision, {
      danger: decision === "declined", onSubmit: async () => refreshOrder(o, await postForm(`/api/orders/${o.id}/intl/quote/${q.id}/decision`, { decision, reason: why.value, confirm: true, idempotency_key: k })),
    });
  }

  function linkDialog(o) {
    const k = key(), url = el("input", { id: "lurl", type: "url", placeholder: "https:// link from your payment provider" }), amt = el("input", { id: "lamt", inputmode: "decimal", value: dollars(o.outstanding_paise) });
    actionDialog("Send a payment link", [el("p", { class: "sub" }, `${o.name} · outstanding ${money(o, o.outstanding_paise)}`), field("lurl", "Payment link *", url, "Create it in your payment provider's dashboard with this order number as the reference, then paste it here. Only links from allowed providers are accepted."),
      field("lamt", `Amount (${o.currency})`, amt, "Cannot be more than the outstanding amount."), el("p", { class: "sub" }, `The customer sees it on their order page and is emailed. The order is marked paid only when the provider confirms the payment (webhook) or you record a verified payment.`)], "Send link", {
      onSubmit: async () => refreshOrder(o, await postForm(`/api/orders/${o.id}/intl/payment-link`, { url: url.value, amount: amt.value, confirm: true, idempotency_key: k })),
    });
  }

  function paymentDialogIntl(o) {
    const k = key(), amt = el("input", { id: "pamt", inputmode: "decimal", value: dollars(o.outstanding_paise) }), ref = el("input", { id: "pref2", maxlength: "80", placeholder: "Bank reference or provider payment ID" });
    const m = el("select", { id: "pmeth" }, [["bank_transfer", "Bank transfer (seen in your bank account)"], ["provider_dashboard", "Provider dashboard (payment shows as captured)"], ["other", "Other (explain in the reference)"]].map(([v, l]) => el("option", { value: v }, l)));
    const ok = el("input", { id: "pok", type: "checkbox" });
    actionDialog("Record verified payment", [el("p", { class: "sub" }, `${o.name} · outstanding ${money(o, o.outstanding_paise)}`), field("pamt", `Amount received (${o.currency}) *`, amt), field("pmeth", "How you verified it *", m), field("pref2", "Transaction reference *", ref),
      el("label", { class: "chk" }, ok, " I have verified this payment in my bank or provider account"), el("p", { class: "sub" }, "Do not record anything you have not seen. The order becomes paid only when the full accepted amount is recorded.")], "Record payment", {
      onSubmit: async () => { if (!ok.checked) throw new Error("Please confirm you have verified the payment"); return refreshOrder(o, await postForm(`/api/orders/${o.id}/intl/payment-received`, { amount: amt.value, method: m.value, reference: ref.value, confirm: true, idempotency_key: k })); },
    });
  }

  window.intlOrderSection = (o) => {
    if (o.market !== "INTL") return [];
    const x = o.intl || { quotes: [] }, live = !["cancelled", "returned"].includes(o.status), cur = x.quotes.find((q) => q.status === "sent");
    const acts = el("div", { class: "next" });
    if (live && o.destination_status !== "approved") acts.appendChild(el("button", { class: "btn small", type: "button", onclick: () => destinationDialog(o, "approve") }, "Approve destination"));
    if (live && o.destination_status !== "rejected") acts.appendChild(el("button", { class: "btn small danger", type: "button", onclick: () => destinationDialog(o, "reject") }, "Reject destination"));
    if (live && o.destination_status !== "rejected" && !(o.quote_status === "accepted" && o.paid_paise > 0)) acts.appendChild(el("button", { class: "btn primary", type: "button", onclick: () => quoteDialog(o) }, x.quotes.length ? "Send a new quotation" : "Send shipping quotation"));
    if (live && o.quote_status === "accepted" && o.outstanding_paise > 0) { acts.appendChild(el("button", { class: "btn", type: "button", onclick: () => linkDialog(o) }, o.pay_link_url ? "Replace payment link" : "Send payment link")); acts.appendChild(el("button", { class: "btn", type: "button", onclick: () => paymentDialogIntl(o) }, "Record verified payment")); }
    const quotes = x.quotes.map((q) => el("div", { class: "ship" },
      el("div", { class: "ship-top" }, el("b", {}, `v${q.version} · ${money(o, q.total_minor)}`), el("span", { class: "pill " + (q.status === "accepted" ? "paid" : "unpaid") }, q.status)),
      el("div", { class: "sub" }, `${q.type_label} · products ${money(o, q.products_minor)} + shipping ${money(o, q.shipping_minor)}${q.taxes_minor + q.other_minor ? ` + taxes/charges ${money(o, q.taxes_minor + q.other_minor)}` : ""}`),
      el("div", { class: "sub" }, `${[q.carrier, q.method].filter(Boolean).join(" · ") || "—"}${q.est_from || q.est_to ? ` · est. ${[q.est_from, q.est_to].filter(Boolean).join(" to ")}` : ""} · valid until ${when(q.expires_at)}`),
      q.decided_at ? el("div", { class: "sub" }, `${q.status} ${when(q.decided_at)} by ${q.decided_by}${q.decision_note ? " · " + q.decision_note : ""}`) : "",
      q.note ? el("div", { class: "sub" }, "Internal: " + q.note) : "",
      q.status === "sent" && live ? el("div", { class: "rowact" }, el("button", { class: "btn small", type: "button", onclick: () => decisionDialog(o, q, "accepted") }, "Record acceptance"), el("button", { class: "btn small danger", type: "button", onclick: () => decisionDialog(o, q, "declined") }, "Record decline")) : ""));
    return [
      el("h3", { class: "sec" }, "International order"),
      el("p", {}, el("span", { class: "pill pre" }, DS[o.destination_status] || "—"), el("span", { class: "pill " + (o.quote_status === "accepted" ? "paid" : "unpaid") }, QS[o.quote_status] || "—"), el("span", { class: "pill" }, `${o.currency} price list ${o.price_list || ""}`)),
      el("dl", {}, ...row("Country", o.country || "—"), ...row("Company", o.company || "—"), ...row("Tax ID", o.tax_id || "—"), ...row("Customer notes", o.order_notes || "—"),
        ...row("Terms accepted", o.terms_accepted_at ? `${when(o.terms_accepted_at)} (version ${o.terms_version || "?"})` : "Not recorded"), ...(o.dispatch_override_reason ? row("Dispatch override", o.dispatch_override_reason) : []), ...(o.pay_link_url ? row("Payment link", `${money(o, o.pay_link_minor || 0)} · ${o.pay_link_url}`) : [])),
      cur ? el("p", { class: "sub" }, "A quotation is waiting for the customer's answer.") : "",
      acts, el("h3", { class: "sec" }, "Quotations"), ...(quotes.length ? quotes : [el("p", { class: "sub" }, "No quotation sent yet.")]),
    ];
  };

  // ── International screen: settings, USD price list, enquiries ────────────────────────────
  const S = { data: null, products: null, enq: null, loaded: false };
  const card = (title, sub, ...kids) => el("section", { class: "pcard" }, el("div", { class: "pcard-head" }, el("h2", {}, title)), sub ? el("p", { class: "sub" }, sub) : "", ...kids);

  async function loadIntl() {
    $("intl").replaceChildren(el("p", { class: "sub" }, "Loading…"));
    try {
      const [s, p, e] = await Promise.all([api("/api/intl/settings"), api("/api/intl/products"), api("/api/intl/enquiries")]);
      S.data = s; S.enq = e.enquiries; S.products = p.products;
      render();
    } catch (e) { $("intl").replaceChildren(el("p", { class: "msg" }, "Could not load: " + e.message + " (apply migration 0019 first if this is new)", " ", el("button", { class: "btn small", type: "button", onclick: loadIntl }, "Retry"))); }
  }

  function settingsCard() {
    const s = S.data.settings, draft = { ...s }, countries = S.data.countries.map((c) => ({ code: c.code, enabled: c.enabled }));
    const sw = el("button", { class: "switch", type: "button", role: "switch", "aria-checked": String(draft.enabled) }, el("i", { class: "knob" }), el("span", {}, draft.enabled ? "International ordering ON" : "International ordering OFF"));
    sw.onclick = () => { draft.enabled = !draft.enabled; sw.setAttribute("aria-checked", String(draft.enabled)); sw.lastChild.textContent = draft.enabled ? "International ordering ON" : "International ordering OFF"; };
    const mode = el("select", { id: "imode" }, el("option", { value: "manual_link" }, "Payment link or verified payment (you send a link or record a payment)"), el("option", { value: "none" }, "No payment instructions yet (customers are told they will follow)")); mode.value = draft.payment_mode;
    const days = el("input", { id: "idays", inputmode: "numeric", value: String(draft.quote_valid_days) }), hosts = el("input", { id: "ihosts", value: draft.paylink_hosts }), tv = el("input", { id: "itv", value: draft.terms_version });
    const list = el("div", { class: "rw-two" }, ...S.data.countries.map((c, i) => { const cb = el("input", { type: "checkbox" }); cb.checked = c.enabled; cb.onchange = () => { countries[i].enabled = cb.checked; }; return el("label", { class: "chk" }, cb, ` ${c.name} (${c.code})`); }));
    const save = el("button", { class: "btn primary", type: "button" }, "Save settings");
    save.onclick = async () => {
      const lines = [draft.enabled ? "International ordering will be ON: customers can choose a destination, see USD prices and submit orders." : "International ordering will be OFF: the storefront shows India only.", `${countries.filter((c) => c.enabled).length} destinations enabled.`];
      if (!(await ask("Save international settings?", lines, "Save"))) return;
      try { S.data = await api("/api/intl/settings", { version: S.data.version, settings: { enabled: draft.enabled, payment_mode: mode.value, quote_valid_days: Number(days.value), paylink_hosts: hosts.value, terms_version: tv.value }, countries }); toast("Settings saved"); render(); } catch (e) { toast(e.message, true); }
    };
    return card("Settings", "International ordering ships OFF. Payment links are accepted only from the provider domains below. Check destinations, export rules and payment-provider support before switching on.",
      el("div", { class: "field" }, sw), field("imode", "Payment workflow", mode), field("idays", "Default quotation validity (days)", days), field("ihosts", "Allowed payment-link domains (comma separated)", hosts), field("itv", "Terms version recorded with each order", tv, "Update when the legal pages change."), el("h3", {}, "Destinations"), list, el("div", { class: "actions" }, save));
  }

  function priceCard() {
    const rows = S.products.filter((p) => p.intl).map((p) => {
      const i = p.intl, price = el("input", { value: i.price_usd_cents ? dollars(i.price_usd_cents) : "", inputmode: "decimal", placeholder: "USD", "aria-label": "USD price for " + p.name });
      const en = el("input", { type: "checkbox", "aria-label": "Sold internationally: " + p.name }); en.checked = i.intl_enabled;
      const moq = el("input", { value: i.intl_moq || "", inputmode: "numeric", placeholder: "MOQ", "aria-label": "Minimum order" }), lead = el("input", { value: i.intl_lead_days ?? "", inputmode: "numeric", placeholder: "Lead days", "aria-label": "Lead time days" });
      const cq = el("input", { type: "checkbox", "aria-label": "Custom quotation only: " + p.name }); cq.checked = i.intl_custom_quote;
      const tax = el("select", { "aria-label": "Tax treatment" }, [["excl", "Excl. taxes"], ["incl", "Incl. taxes"], ["quoted", "Taxes quoted"]].map(([v, l]) => el("option", { value: v }, l))); tax.value = i.intl_tax_treatment;
      const tiers = el("input", { value: (i.tiers || []).map((t) => `${t.min_qty}:${dollars(t.unit_cents)}`).join(", "), placeholder: "100:1.00, 500:0.85", "aria-label": "Quantity prices" });
      const wt = el("input", { value: i.weight_g || "", inputmode: "numeric", placeholder: "g", "aria-label": "Weight in grams" }), dm = el("input", { value: i.dims_mm || "", placeholder: "LxWxH mm", "aria-label": "Dimensions" });
      const save = el("button", { class: "btn small", type: "button" }, "Save");
      save.onclick = async () => {
        let t = []; try { t = tiers.value.split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const [q, u] = s.split(":"); if (!q || !u) throw new Error("Quantity prices look like 100:1.00, 500:0.85"); return { min_qty: Number(q), unit_usd: u.trim() }; }); } catch (e) { return toast(e.message, true); }
        try { await api("/api/products/" + p.id, { price_usd: price.value.trim() || null, intl_enabled: en.checked, intl_moq: moq.value.trim() || null, intl_lead_days: lead.value.trim() || null, intl_custom_quote: cq.checked, intl_tax_treatment: tax.value, intl_tiers: t, weight_g: wt.value.trim() || null, dims_mm: dm.value.trim() }); toast(p.name + " saved"); } catch (e) { toast(e.message, true); }
      };
      return el("div", { class: "prow rw-row" }, el("div", { class: "name" }, p.name, el("span", { class: "sub" }, `  ${p.sku} · India ${inr(p.price_paise)}`)),
        el("div", { class: "rw-two" }, el("label", {}, "USD price", price), el("label", { class: "chk" }, en, " Sold internationally")), el("div", { class: "rw-two" }, el("label", {}, "Minimum order", moq), el("label", {}, "Lead time (days)", lead)),
        el("label", {}, "Quantity prices (min qty:USD each)", tiers), el("div", { class: "rw-two" }, el("label", { class: "chk" }, cq, " Made to order (quotation only)"), el("label", {}, "Tax treatment", tax)), el("div", { class: "rw-two" }, el("label", {}, "Weight", wt), el("label", {}, "Dimensions", dm)), el("div", { class: "actions" }, save));
    });
    return card("International price list (USD)", "Set a USD price and tick Sold internationally for each product. A larger quantity must not cost more per unit. Indian prices are never changed here.", ...rows);
  }

  function enquiryCard() {
    const rows = S.enq.map((q) => {
      const note = el("input", { value: q.notes || "", maxlength: "1000", placeholder: "Internal notes", "aria-label": "Notes" });
      const set = (status) => async () => { try { S.enq = (await api("/api/intl/enquiries/" + q.id, { status, notes: note.value })).enquiries; toast("Updated"); render(); } catch (e) { toast(e.message, true); } };
      return el("div", { class: "prow rw-camp" }, el("div", { class: "name" }, `${q.name} · ${q.country}`, " ", el("span", { class: "pill " + (q.status === "closed" ? "paid" : "unpaid") }, q.status)),
        el("div", { class: "sub" }, `${when(q.created_at)} · `, el("a", { href: "mailto:" + q.email }, q.email), q.company ? " · " + q.company : ""),
        q.product || q.quantity ? el("div", {}, `${q.product || ""}${q.quantity ? " × " + q.quantity : ""}`) : "", q.customization ? el("div", { class: "sub" }, "Customization: " + q.customization) : "", q.shipping_pref ? el("div", { class: "sub" }, "Shipping: " + q.shipping_pref) : "", q.message ? el("div", {}, q.message) : "", note,
        el("div", { class: "rowact" }, el("button", { class: "btn small", type: "button", onclick: set("in_progress") }, "In progress"), el("button", { class: "btn small", type: "button", onclick: set("closed") }, "Close"), el("button", { class: "btn small", type: "button", onclick: set("new") }, "Reopen")));
    });
    return card("Enquiries", "Bulk, custom and shipping-quote enquiries from the international form. Reply by email; track progress here.", ...(rows.length ? rows : [el("p", { class: "sub" }, "No enquiries yet.")]));
  }

  function render() { $("intl").replaceChildren(settingsCard(), priceCard(), enquiryCard()); }
  window.intlVisible = (on) => { if (on && !S.loaded) { S.loaded = true; loadIntl(); } };
})();
