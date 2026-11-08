// Saved addresses: the account page (GET /api/accounts/addresses) and checkout prefill (GET /api/accounts/me) read the same list,
// default first, only the caller's own rows, and nothing when signed out.
const assert = require("node:assert/strict");
const path = require("node:path");
const worker = require(path.join(__dirname, "..", "..", "functions", "api", "[[path]].js"));
const { makeDb } = require("./d1shim.cjs");
const { sqlite, D1, one } = makeDb();
const env = { DB: D1 };
const ORIGIN = "https://www.ntagz.com";
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const req = (p, { method = "GET", body, cookie } = {}) => worker.onRequest({ request: new Request("https://x" + p, { method, headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }), env });
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");

async function signIn(email) { // plant a known code (stored hashed), as the hardening test does
  assert.equal((await req("/api/accounts/auth/send-otp", { method: "POST", body: { email } })).status, 200);
  const id = one("SELECT id FROM otp_tokens WHERE email=? AND used=0", email).id;
  sqlite.prepare("UPDATE otp_tokens SET otp=? WHERE id=?").run(await sha(`ntagz:otp:${email}:123456`), id);
  const r = await req("/api/accounts/auth/verify-otp", { method: "POST", body: { email, otp: "123456" } });
  assert.equal(r.status, 200);
  return r.headers.get("Set-Cookie").split(";")[0];
}

(async () => {
  assert.equal((await req("/api/accounts/addresses")).status, 401); ok("signed out: the address list is refused");

  const a = await signIn("a@example.test"), b = await signIn("b@example.test");
  const add = (cookie, x) => req("/api/accounts/addresses", { method: "POST", cookie, body: x });
  assert.equal((await add(a, { label: "Shop", name: "Asha", phone: "9876543210", line1: "1 MG Road", city: "Pune", state: "Maharashtra", pincode: "411001" })).status, 201);
  assert.equal((await add(a, { label: "Home", name: "Asha", phone: "9876543210", line1: "2 FC Road", city: "Pune", state: "Maharashtra", pincode: "411004", is_default: true })).status, 201);
  assert.equal((await add(b, { label: "Office", name: "Bina", line1: "9 Park St", city: "Kolkata", state: "West Bengal", pincode: "700016" })).status, 201);

  const list = await (await req("/api/accounts/addresses", { cookie: a })).json();
  assert.equal(list.addresses.length, 2); ok("the account page gets the caller's addresses");
  assert.equal(list.addresses[0].label, "Home"); assert.equal(list.addresses[0].is_default, 1); ok("default address comes first");
  assert.deepEqual(Object.keys(list.addresses[0]).sort(), ["city", "id", "is_default", "label", "line1", "name", "phone", "pincode", "state"]); ok("only the fields the page shows (no user_id)");
  assert.ok(!JSON.stringify(list).includes("Kolkata")); ok("another customer's addresses never appear");

  const me = await (await req("/api/accounts/me", { cookie: a })).json();
  assert.deepEqual(me.addresses, list.addresses); ok("checkout prefill (/accounts/me) returns the same list");

  assert.equal((await req(`/api/accounts/addresses/${list.addresses[1].id}`, { method: "DELETE", cookie: b })).status, 200);
  assert.equal((await (await req("/api/accounts/addresses", { cookie: a })).json()).addresses.length, 2); ok("another customer cannot delete your address");
  assert.equal((await req(`/api/accounts/addresses/${list.addresses[1].id}`, { method: "DELETE", cookie: a })).status, 200);
  assert.equal((await (await req("/api/accounts/addresses", { cookie: a })).json()).addresses.length, 1); ok("deleting your own address removes it from the list");

  console.log(`all ${n} account address checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
