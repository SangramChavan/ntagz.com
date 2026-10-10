// Run against `wrangler dev --local` with the local fixtures loaded (see README). Never point at production.
import assert from "node:assert/strict";
const BASE = process.env.BASE || "http://localhost:8799";
const H = { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin" };
let cookie = "";
const call = (path, body, extra = {}) => fetch(BASE + path, {
  method: body === undefined ? "GET" : "POST",
  headers: { ...(body === undefined ? {} : H), ...(cookie ? { Cookie: cookie } : {}), ...extra },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const ids = { online: "11111111-aaaa-bbbb-cccc-000000000001", cash: "22222222-aaaa-bbbb-cccc-000000000002", cod: "33333333-aaaa-bbbb-cccc-000000000003" };
let n = 0; const ok = (name) => console.log(`ok ${++n} ${name}`);

// unauthenticated
assert.equal((await call("/api/orders")).status, 401); ok("API requires login");
assert.equal((await call("/app.js")).status, 404); ok("app bundle hidden before login");
const login = await (await call("/")).text(); assert.match(login, /Sign in|Send code/); ok("root serves login page when signed out");
assert.equal((await fetch(BASE + "/api/auth/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403); ok("POST without CSRF header rejected");

// non-allowlisted email never gets a code or session
let r = await call("/api/auth/request", { email: "intruder@example.test" });
assert.equal(r.status, 200); assert.equal((await r.json()).dev_otp, undefined); ok("unknown email gets generic reply, no code");
assert.equal((await call("/api/auth/verify", { email: "intruder@example.test", otp: "123456" })).status, 401); ok("unknown email cannot verify");

// wrong then right code
r = await call("/api/auth/request", { email: "admin@example.test" }); const { dev_otp } = await r.json(); assert.match(dev_otp, /^\d{6}$/);
assert.equal((await call("/api/auth/verify", { email: "admin@example.test", otp: dev_otp === "000000" ? "111111" : "000000" })).status, 401); ok("wrong code rejected");
r = await call("/api/auth/verify", { email: "admin@example.test", otp: dev_otp }); assert.equal(r.status, 200);
cookie = r.headers.get("set-cookie").split(";")[0]; assert.match(r.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Strict/); ok("login sets HttpOnly Secure SameSite=Strict cookie");
assert.equal((await call("/api/auth/verify", { email: "admin@example.test", otp: dev_otp })).status, 401); ok("code is single-use");
assert.match(await (await call("/app.js")).text(), /confirmCash/); ok("app bundle served after login");

// listing, search, filters
let d = await (await call("/api/orders")).json(); assert.equal(d.total, 6); ok("lists all orders");
d = await (await call("/api/orders?q=9000000002")).json(); assert.equal(d.total, 1); assert.equal(d.orders[0].id, ids.cash); ok("search by phone");
d = await (await call("/api/orders?q=ravi@example")).json(); assert.equal(d.total, 1); ok("search by email");
d = await (await call("/api/orders?q=" + encodeURIComponent("100%"))).json(); assert.equal(d.total, 0); ok("LIKE wildcards are escaped");
d = await (await call("/api/orders?payment_status=unpaid")).json(); assert.equal(d.total, 4); ok("payment status filter");
d = await (await call("/api/orders?payment_method=payu&fulfilment=delivered")).json(); assert.equal(d.total, 1); ok("method + fulfilment filters");
d = await (await call("/api/orders?from=2020-01-01&to=2020-01-02")).json(); assert.equal(d.total, 0); ok("date filter");
d = await (await call("/api/orders?sort=total&dir=asc")).json(); assert.equal(d.orders[0].total, 11800); ok("sort whitelist works");
d = await (await call("/api/orders?sort=name;DROP TABLE orders")).json(); assert.equal(d.total, 6); ok("unsafe sort value ignored");
d = await (await call("/api/orders/" + ids.cash)).json(); assert.equal(d.address, "2 Lake Rd"); assert.equal(d.items[0].qty, 20); ok("order detail with address + items");

// cash confirmation rules
const key = () => crypto.randomUUID();
const cash = (id, amt, k = key()) => call(`/api/orders/${id}/cash-received`, { confirm_amount_paise: amt, idempotency_key: k });
assert.equal((await cash(ids.online, 35400)).status, 409); ok("online payment cannot be marked as cash");
assert.equal((await cash(ids.cod, 23600)).status, 409); ok("COD cannot be marked paid before delivery");
assert.equal((await cash(ids.cash, 100)).status, 409); ok("wrong confirmation amount rejected");
r = await cash(ids.cash, 47200); assert.equal(r.status, 200); d = await r.json();
assert.equal(d.payment_status, "paid"); assert.equal(d.paid_paise, 47200); assert.equal(d.outstanding_paise, 0); assert.equal(d.payments[0].recorded_by, "admin@example.test"); ok("cash recorded with amount, admin identity, fully paid");
assert.equal((await cash(ids.cash, 47200)).status, 409); ok("duplicate confirmation rejected");

// concurrency on COD after delivery
r = await call(`/api/orders/${ids.cod}/fulfilment`, { status: "delivered", tracking_id: "T1", courier: "DTDC" }); assert.equal(r.status, 200); ok("fulfilment update (separate from payment)");
assert.equal((await (await call("/api/orders/" + ids.cod)).json()).payment_status, "unpaid"); ok("delivery does not change payment status");
const rs = await Promise.all(Array.from({ length: 6 }, () => cash(ids.cod, 23600)));
assert.equal(rs.filter((x) => x.status === 200).length, 1); ok("6 concurrent confirmations record exactly one payment");
d = await (await call("/api/orders/" + ids.cod)).json(); assert.equal(d.payments.length, 1); assert.equal(d.paid_paise, 23600); ok("single payment row, correct paid amount");
assert.equal((await call(`/api/orders/${ids.online}/fulfilment`, { status: "bogus" })).status, 400); ok("invalid fulfilment status rejected");

// CSV
const csv = await (await call("/api/orders.csv")).text(); assert.match(csv, /'=cmd\|evil/); assert.ok(!/,=cmd/.test(csv)); ok("CSV neutralises formula injection");

// logout
assert.equal((await call("/api/auth/logout", {})).status, 200);
assert.equal((await call("/api/orders")).status, 401); ok("logout revokes session");
console.log(`\nall ${n} checks passed`);
