const $ = (id) => document.getElementById(id);
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
$("out").onclick = async () => { await api("/api/auth/logout", {}); location.reload(); };
api("/api/me").then((m) => { $("who").textContent = m.email; }).catch(() => {});
