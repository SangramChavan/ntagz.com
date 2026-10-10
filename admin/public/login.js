const $ = (id) => document.getElementById(id);
let stage = "email";
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" }, body: JSON.stringify(body) });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}
$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("msg").textContent = ""; $("go").disabled = true;
  if (stage === "email") {
    const r = await post("/api/auth/request", { email: $("email").value });
    if (r.ok) { stage = "otp"; $("otpWrap").hidden = false; $("otp").focus(); $("go").textContent = "Sign in"; $("msg").textContent = "If that email is authorised, a code was sent."; }
    else $("msg").textContent = r.data.error || "Could not send code";
  } else {
    const r = await post("/api/auth/verify", { email: $("email").value, otp: $("otp").value });
    if (r.ok) location.reload(); else $("msg").textContent = r.data.error || "Invalid code";
  }
  $("go").disabled = false;
});
