// `home` as a function = the carrier accepts a prefilled tracking ID in the URL.
// As a plain string = it does not (OTP / captcha / POST-only); we copy the ID instead.
const CARRIERS = {
  delhivery: { name: "Delhivery", home: "https://www.delhivery.com/tracking" },
  bluedart:  { name: "Blue Dart", home: "https://www.bluedart.com/track-trace" },
  trackon:   { name: "Trackon", home: "https://www.trackon.in/courier-tracking" },
  ekart:     { name: "Ekart Logistics", home: (id) => `https://ekartlogistics.com/shipmenttrack/${id}` }
};

function trackingUrl(carrier, id) {
  const c = CARRIERS[carrier] || CARRIERS.delhivery;
  return typeof c.home === "function" ? c.home(encodeURIComponent(id)) : c.home;
}

function handleTracking(e) {
  e.preventDefault();
  const input = document.getElementById("trackingId");
  const trackingId = input.value.trim();
  if (!trackingId) return;

  const hint = document.getElementById("trackCopied");
  hint.hidden = true;

  const carrier = document.getElementById("carrier").value;
  const c = CARRIERS[carrier];

  if (typeof c.home !== "function") {
    navigator.clipboard?.writeText(trackingId).then(() => {
      hint.textContent = `Tracking ID copied — paste it on the ${c.name} site.`;
      hint.hidden = false;
    }, () => {});
  }

  window.open(trackingUrl(carrier, trackingId), "_blank", "noopener,noreferrer");
}

document.getElementById("carrier").addEventListener("change", (e) => {
  document.getElementById("trackCopied").hidden = true;
  document.getElementById("trackBtn").textContent =
    `Track via ${CARRIERS[e.target.value].name} →`;
});

/* ── Secure order journey (?o=<orderId>&t=<token>) ── */
(function () {
  const qs = new URLSearchParams(location.search);
  const oid = qs.get("o"), tok = qs.get("t");
  if (!oid || !tok) return;

  const root = document.getElementById("orderView");
  const m = document.createElement("meta");
  m.name = "robots"; m.content = "noindex";
  document.head.appendChild(m);

  const STAGES = [
    ["placed", "Order placed"], ["paid", "Payment confirmed"], ["processing", "Processing"],
    ["packed", "Packed"], ["shipped", "Shipped"], ["out_for_delivery", "Out for delivery"],
    ["delivered", "Delivered"]
  ];
  const ALIAS = { pending: "placed", created: "placed", confirmed: "placed", payment: "paid", payment_confirmed: "paid",
    in_transit: "shipped", dispatched: "shipped" };
  const EXC = ["on_hold", "delivery_failed", "cancelled", "returned"];
  const norm = (k) => ALIAS[k] || k;
  const idx = (k) => STAGES.findIndex((s) => s[0] === norm(k));

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const when = (secs) => new Date(secs * 1000).toLocaleString("en-IN",
    { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
  const day = (secs) => new Date(secs * 1000).toLocaleDateString("en-IN",
    { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
  const inr = (p) => "₹" + (p / 100).toLocaleString("en-IN", { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 });
  const row = (k, v) => { const r = el("div", "ov-row"); r.append(el("span", "ov-k", k), el("span", "ov-v", v)); return r; };
  const card = (title) => { const c = el("div", "ov-card"); if (title) c.append(el("h2", null, title)); return c; };

  function show(...nodes) { root.hidden = false; root.replaceChildren(...nodes); }

  function message(text, retry) {
    const c = card();
    c.append(el("p", "ov-msg", text));
    if (retry) {
      const b = el("button", "btn btn-tagz", "Try again");
      b.type = "button"; b.addEventListener("click", load);
      c.append(b);
    }
    show(c);
  }

  function copyBtn(text) {
    const b = el("button", "ov-copy", "Copy");
    b.type = "button";
    b.addEventListener("click", async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
        const t = document.createElement("textarea");
        t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
        document.body.appendChild(t); t.select();
        try { ok = document.execCommand("copy"); } catch (_) {}
        t.remove();
      }
      b.textContent = ok ? "Copied" : "Press and hold to copy";
      setTimeout(() => (b.textContent = "Copy"), 2000);
    });
    return b;
  }

  function timeline(d) {
    const ev = {};
    for (const j of d.journey || []) ev[norm(j.status || j.kind)] = j;
    let cur = Math.max(idx(d.status), -1);
    for (const k in ev) cur = Math.max(cur, idx(k));
    if (cur < 0) cur = 0;
    const exc = EXC.includes(d.status) ? d.status : null;
    const ol = el("ol", "tl");
    const add = (cls, label, e, state) => {
      const li = el("li", "tl-item " + cls);
      li.append(el("span", "tl-dot", state));
      const b = el("div", "tl-body");
      b.append(el("div", "tl-label", label));
      b.append(el("div", "tl-when", e ? when(e.at) : "Pending"));
      if (e && e.note) b.append(el("div", "tl-note", e.note));
      li.append(b); ol.append(li);
    };
    STAGES.forEach(([k, label], i) => {
      const done = i < cur || (i === cur && !exc && k === "delivered");
      add(done ? "done" : i === cur && !exc ? "current" : i === cur ? "done" : "future", label, ev[k], done || (i === cur && exc) ? "✓" : "");
      if (i === cur && exc) {
        const e = ev[exc];
        add("exception", (d.status_label || exc.replace(/_/g, " ")), e || null, "!");
      }
    });
    return ol;
  }

  function render(d) {
    const sum = card();
    sum.append(el("h2", null, "Order " + d.ref));
    sum.append(row("Placed on", day(d.placed_at)));
    sum.append(row("Payment", d.payment_status === "paid" ? "Paid" : "Unpaid"));
    sum.append(row("Status", (d.status_label || d.status) + (d.is_preorder ? " (pre-order)" : "")));
    if (d.ship_to) sum.append(row("Ship to", [d.ship_to.state, d.ship_to.pincode].filter(Boolean).join(" - ")));
    const ul = el("ul", "ov-items");
    for (const i of d.items || []) ul.append(el("li", null, i.name + " × " + i.qty));
    sum.append(ul, row("Total", inr(d.total_paise)));
    const nodes = [sum];

    for (const s of d.shipments || []) {
      const c = card("Shipment · " + s.courier);
      const a = el("div", "ov-awb");
      a.append(el("span", "ov-k", "AWB"), el("code", null, s.awb), copyBtn(s.awb));
      c.append(a, row("Shipped on", day(s.shipped_on)));
      if (s.est_delivery) c.append(row("Estimated delivery", day(s.est_delivery)));
      if (typeof s.tracking_url === "string" && /^https:\/\//i.test(s.tracking_url)) {
        const l = el("a", "btn btn-tagz btn-block", "Track shipment");
        l.href = s.tracking_url; l.target = "_blank"; l.rel = "noopener noreferrer";
        c.append(l);
      }
      nodes.push(c);
    }
    const t = card("Order journey");
    t.append(timeline(d));
    nodes.push(t);
    show(...nodes);
  }

  async function load() {
    show(el("p", "ov-msg", "Loading your order…"));
    let r;
    try {
      r = await fetch("/api/track?o=" + encodeURIComponent(oid) + "&t=" + encodeURIComponent(tok), { headers: { Accept: "application/json" } });
    } catch (_) { return message("We couldn't reach the server. Please check your connection.", true); }
    if (r.status === 404) return message("We couldn't find that order. Check your link.");
    if (!r.ok) return message("Something went wrong on our side. Please try again.", true);
    try { render(await r.json()); } catch (_) { message("Something went wrong on our side. Please try again.", true); }
  }
  load();
})();
