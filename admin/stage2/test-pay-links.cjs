// Payment links end to end. Both Workers run against ONE in-memory D1 (like production): the payments Worker serves the customer's
// /api/pay/<token> calls, the admin Worker creates and manages links. Razorpay is mocked.
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");
const worker = require(path.join(root, "functions", "api", "[[path]].js"));
const { makeDb } = require("./d1shim.cjs");
const { sqlite, D1, one, q } = makeDb();
const env = { DB: D1, RAZORPAY_KEY_ID: "rzp_test_abc123", RAZORPAY_KEY_SECRET: "rzp_secret" };
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const run = (sql, ...a) => sqlite.prepare(sql).run(...a);
const hmac = async (secret, msg) => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(msg))), (b) => b.toString(16).padStart(2, "0")).join("");

let rzpCalls = 0, rzpSeq = 0;
global.fetch = async (url, opts) => {
  if (String(url).includes("api.razorpay.com/v1/orders")) { rzpCalls++; return Response.json({ id: "order_PL" + String(++rzpSeq).padStart(6, "0"), amount: JSON.parse(opts.body).amount, currency: "INR" }); }
  throw new Error("unexpected fetch " + url);
};

const now = () => Math.floor(Date.now() / 1000);
const call = (p, body, headers = {}) => { worker.resetPricingCache && worker.resetPricingCache(); return worker.onRequest({ request: new Request("https://ntagz.com" + p, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env }); };
const jget = async (p, h) => { const r = await call(p, undefined, h); return { status: r.status, body: await r.json() }; };
const jpost = async (p, b, h) => { const r = await call(p, b, h); return { status: r.status, body: await r.json() }; };
let seq = 0;
function mkLink(o = {}) {
  const id = (o.id || (++seq).toString(16).padStart(32, "a"));
  const items = JSON.stringify(o.items || [{ id: "black-nfc-card", qty: 10 }]);
  run(`INSERT INTO pay_links (id,source,created_by,items_json,orig_items_json,name,phone,email,address,pincode,state,gstin,quoted_paise,created_at,expires_at,txn_id,txn_ids,started_amount_paise)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, o.source || "admin", "boss@example.test", items, o.origItems || items, "Asha Test", "9876543210", o.email === undefined ? "asha@example.test" : o.email,
    "1 Main Street, Pune", "411001", o.state || "Maharashtra", null, o.quoted === undefined ? null : o.quoted, now(), o.expires || now() + 86400, o.txn || null, JSON.stringify(o.txn ? [o.txn] : []), o.started || null);
  return id;
}

(async () => {
  const guest394 = 394;

  // ── viewing a link ──
  let t = mkLink();
  let r = await jget("/api/pay/" + t);
  assert.equal(r.status, 200); assert.equal(r.body.status, "active"); assert.equal(r.body.totals.amount, guest394);
  assert.equal(r.body.lines[0].qty, 10); assert.equal(r.body.lines[0].name.length > 3, true); assert.deepEqual(r.body.nudges, []);
  ok("opening a link shows today's priced order (items, GST, shipping, total) from the checkout engine");
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes("9876543210") && !raw.includes("Main Street") && !raw.includes("asha@example.test")); assert.equal(r.body.name, "Asha"); assert.deepEqual(r.body.deliverTo, { pincode: "411001", state: "Maharashtra" });
  ok("the public view shows first name and delivery area only: no phone, street address or email");
  let row = one("SELECT * FROM pay_links WHERE id=?", t);
  assert.equal(row.open_count, 1); assert.ok(row.first_opened_at > 0);
  await jget("/api/pay/" + t); assert.equal(one("SELECT open_count c FROM pay_links WHERE id=?", t).c, 1); ok("opens are counted, but a reload within 30 seconds is not counted twice");
  run("UPDATE pay_links SET last_opened_at=last_opened_at-60 WHERE id=?", t); await jget("/api/pay/" + t); assert.equal(one("SELECT open_count c FROM pay_links WHERE id=?", t).c, 2); ok("a later visit counts as a new open");

  assert.equal((await jget("/api/pay/" + "f".repeat(32))).status, 404); ok("unknown token: generic 404");
  assert.equal((await call("/api/pay/" + t, undefined, { Origin: "https://evil.example" })).status, 403); ok("foreign Origin is rejected");
  assert.equal((await call("/api/pay/" + t + "/start")).status, 405); assert.equal((await call("/api/pay/" + t, {})).status, 405); ok("start/adjust are POST only, the view is GET only");

  // ── the price is never stored: it follows the catalogue ──
  t = mkLink({ quoted: 39400 });
  assert.equal((await jget("/api/pay/" + t)).body.priceChanged, null); ok("price unchanged since it was quoted: no notice");
  run("UPDATE products SET price_paise=4000 WHERE id='black-nfc-card'");
  r = await jget("/api/pay/" + t);
  assert.ok(r.body.totals.amount > guest394); assert.deepEqual(r.body.priceChanged, { was: 394, now: r.body.totals.amount }); ok("a price change after the quote is picked up, and the page says what it was and what it is now");
  run("UPDATE products SET price_paise=3090 WHERE id='black-nfc-card'");
  const baseNow = (await jget("/api/pay/" + t)).body.totals.amount;

  // ── member prices apply only to a verified, signed-in member ──
  run("UPDATE membership_config SET value='1' WHERE key='discounts_live'"); run("UPDATE products SET member_discount_pct=10 WHERE id='black-nfc-card'");
  run("INSERT INTO users (id,email) VALUES ('u-mem','m@example.test'),('u-reg','r@example.test')");
  run("INSERT INTO sessions (id,user_id,expires_at) VALUES ('sess-member-000000000001','u-mem',unixepoch()+3600),('sess-regular-00000000001','u-reg',unixepoch()+3600)");
  run("INSERT INTO memberships (id,user_id,status,expires_at) VALUES ('mm1','u-mem','active',unixepoch()+86400)");
  const asMember = { Cookie: "ntagz_session=sess-member-000000000001" }, asReg = { Cookie: "ntagz_session=sess-regular-00000000001" };
  const gm = (await jget("/api/pay/" + t, asMember)).body, gr = (await jget("/api/pay/" + t, asReg)).body, gg = (await jget("/api/pay/" + t)).body;
  assert.ok(gm.totals.amount < gg.totals.amount); assert.equal(gm.memberPricing, true); assert.equal(gr.totals.amount, gg.totals.amount); assert.equal(gg.memberPricing, false);
  ok("a signed-in active member sees member prices; guests and non-members see regular prices");

  // ── suggestions (nudges) and acting on them ──
  const big = mkLink({ items: [{ id: "black-nfc-card", qty: 400 }] });
  r = await jget("/api/pay/" + big);
  const tier = r.body.nudges.find((x) => x.type === "tier");
  assert.ok(tier); assert.equal(tier.addQty, 100); assert.equal(tier.tierPct, 10); assert.ok(tier.unitNext < tier.unitNow); assert.ok(tier.savingOnCurrent > 0); assert.deepEqual(tier.action, { id: "black-nfc-card", qty: 500 });
  ok("400 cards: suggests +100 to reach the 500-piece tier, with the new unit price and what is saved on the 400");
  const before = r.body.totals.amount;
  r = await jpost("/api/pay/" + big + "/adjust", tier.action);
  assert.equal(r.status, 200); assert.equal(r.body.lines[0].qty, 500); assert.equal(r.body.adjusted, true); assert.equal(r.body.lines[0].origQty, 400); assert.ok(r.body.totals.amount > before);
  const row2 = one("SELECT * FROM pay_links WHERE id=?", big); assert.equal(JSON.parse(row2.items_json)[0].qty, 500); assert.equal(JSON.parse(row2.orig_items_json)[0].qty, 400); assert.equal(row2.adjust_count, 1);
  ok("tapping the suggestion updates the link (re-priced by the server) and remembers the original quantity");
  r = await jpost("/api/pay/" + big + "/adjust", { id: "black-nfc-card", qty: 400 });
  assert.equal(r.status, 200); assert.equal(r.body.lines[0].qty, 400); assert.equal(r.body.adjusted, false); ok("undo: back to the original quantity is allowed");
  for (const bad of [{ id: "black-nfc-card", qty: 399 }, { id: "black-nfc-card", qty: 1.5 }, { id: "black-nfc-card", qty: "500" }, { id: "black-nfc-card", qty: 100001 }, { id: "white-nfc-card", qty: 500 }, { qty: 500 }, null])
    assert.equal((await jpost("/api/pay/" + big + "/adjust", bad)).status, 400);
  ok("quantities below the original, fractional, text, absurd, or for a product not on the link are refused");
  assert.equal(JSON.parse(one("SELECT items_json FROM pay_links WHERE id=?", big).items_json)[0].qty, 400); ok("a refused adjustment changes nothing");

  const ship = mkLink({ items: [{ id: "black-nfc-card", qty: 60 }] });
  const sn = (await jget("/api/pay/" + ship)).body.nudges.find((x) => x.type === "shipping");
  assert.ok(sn); assert.equal(sn.shippingSaved, 40); assert.ok(sn.addQty >= 1 && sn.addQty < 20);
  const after = (await jpost("/api/pay/" + ship + "/adjust", sn.action)).body;
  assert.equal(after.totals.shipping, 0); ok("60 cards: suggests the few more that make shipping free, and taking it does make shipping free");
  assert.deepEqual((await jget("/api/pay/" + mkLink({ items: [{ id: "sample-kit", qty: 1 }] }))).body.nudges, []); ok("fixed-price kits get no suggestions");

  // ── paying: the Razorpay order is made when Pay is tapped, for the amount shown ──
  t = mkLink();
  let calls = rzpCalls;
  r = await jpost("/api/pay/" + t + "/start", {});
  assert.equal(r.status, 200); assert.equal(rzpCalls, calls + 1); assert.equal(r.body.amountPaise, baseNow * 100); // the amount the customer was shown
  assert.equal(r.body.keyId, "rzp_test_abc123"); assert.deepEqual(r.body.prefill, { name: "Asha Test", email: "asha@example.test", contact: "9876543210" });
  const intent = one("SELECT amount_paise, name, phone, pincode FROM checkout_intents WHERE txn_id=?", r.body.orderId);
  assert.equal(intent.amount_paise, r.body.amountPaise); assert.equal(intent.name, "Asha Test"); assert.equal(intent.pincode, "411001");
  ok("Pay creates the Razorpay order and a checkout intent for exactly the amount shown, carrying the customer's details");
  const first = r.body.orderId;
  r = await jpost("/api/pay/" + t + "/start", {}); assert.equal(r.body.orderId, first); assert.equal(rzpCalls, calls + 1); ok("tapping Pay again reuses the same order (no duplicate Razorpay orders)");
  run("UPDATE products SET price_paise=3500 WHERE id='black-nfc-card'");
  r = await jpost("/api/pay/" + t + "/start", {});
  assert.notEqual(r.body.orderId, first); assert.equal(rzpCalls, calls + 2); assert.equal(one("SELECT amount_paise a FROM checkout_intents WHERE txn_id=?", r.body.orderId).a, r.body.amountPaise);
  assert.deepEqual(JSON.parse(one("SELECT txn_ids x FROM pay_links WHERE id=?", t).x), [first, r.body.orderId]); assert.equal(one("SELECT start_count c FROM pay_links WHERE id=?", t).c, 3);
  ok("if the price moved since the last attempt, a fresh order is made for the new amount; every order is remembered on the link");
  run("UPDATE products SET price_paise=3090 WHERE id='black-nfc-card'");

  // paying the OLD (stale tab) order still records an order: no payment is ever lost
  const stale = first;
  const sig = await hmac("rzp_secret", `${stale}|pay_stale1`);
  const vr = await jpost("/api/verify-payment", { razorpay_order_id: stale, razorpay_payment_id: "pay_stale1", razorpay_signature: sig }, { Origin: "https://www.ntagz.com" });
  assert.equal(vr.status, 200); assert.equal(one("SELECT count(*) c FROM orders WHERE txn_id=?", stale).c, 1);
  r = await jget("/api/pay/" + t); assert.equal(r.body.status, "paid");
  ok("a payment on any of the link's orders is recorded, and the link then reads as paid");
  r = await jpost("/api/pay/" + t + "/start", {}); assert.equal(r.status, 409); assert.equal((await jpost("/api/pay/" + t + "/adjust", { id: "black-nfc-card", qty: 20 })).status, 409); ok("a paid link cannot be paid or changed again");

  // ── expiry, cancelling, stock ──
  t = mkLink({ expires: now() - 5 });
  r = await jget("/api/pay/" + t); assert.equal(r.body.status, "expired"); assert.equal(r.body.whatsapp, "919960160016"); assert.ok(!r.body.lines);
  assert.equal((await jpost("/api/pay/" + t + "/start", {})).status, 409); ok("an expired link shows no order, points to WhatsApp, and cannot be paid");
  t = mkLink(); run("UPDATE pay_links SET status='cancelled' WHERE id=?", t);
  assert.equal((await jget("/api/pay/" + t)).body.status, "cancelled"); assert.equal((await jpost("/api/pay/" + t + "/start", {})).status, 409); ok("a cancelled link cannot be paid");
  t = mkLink({ items: [{ id: "white-nfc-card", qty: 10 }] }); run("UPDATE products SET active=0 WHERE id='white-nfc-card'");
  r = await jget("/api/pay/" + t); assert.equal(r.body.status, "unavailable"); assert.match(r.body.message, /unavailable/i); assert.equal((await jpost("/api/pay/" + t + "/start", {})).status, 409);
  run("UPDATE products SET active=1 WHERE id='white-nfc-card'"); ok("a product that became unavailable blocks the link with a clear message");
  run("UPDATE products SET track_stock=1, stock_qty=3, preorder_enabled=0 WHERE id='white-nfc-card'");
  r = await jget("/api/pay/" + t); assert.equal(r.body.status, "unavailable"); assert.match(r.body.message, /Only 3/); run("UPDATE products SET track_stock=0 WHERE id='white-nfc-card'"); ok("tracked stock below the quantity blocks the link (same rule as checkout)");

  // ── abuse limits ──
  const ip = { "CF-Connecting-IP": "203.0.113.50" };
  let codes = [];
  for (let i = 0; i < 13; i++) codes.push((await jpost("/api/pay/" + mkLink() + "/start", {}, ip)).status);
  assert.deepEqual(codes.slice(0, 12), Array(12).fill(200)); assert.equal(codes[12], 429); ok("creating Razorpay orders through links is limited to 12 per 10 minutes per IP");
  assert.equal((await jpost("/api/pay/" + mkLink() + "/start", {}, { "CF-Connecting-IP": "198.51.100.8" })).status, 200); ok("other customers are unaffected by the limit");

  // ═══ admin side (same database) ═══
  const admin = (await import(path.join(root, "admin", "src", "index.js"))).default;
  const adminEnv = { DB: D1, ADMIN_EMAILS: "boss@example.test", DEV_OTP_ECHO: "1" };
  let aEnv = adminEnv; // the admin caches "is migration 0020 applied" per DB handle for 30 s; a copy of the handle sidesteps that where a test drops the table
  const A = async (p, body, headers = {}) => { const r = await admin.fetch(new Request("https://admin.ntagz.com" + p, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ntagz-admin", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), aEnv); return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }; };
  assert.equal((await A("/api/paylinks")).status, 401); assert.equal((await A("/api/paylinks", { items: [] })).status, 401); ok("payment-link admin API needs an admin session");
  const otp = (await A("/api/auth/request", { email: "boss@example.test" })).body.dev_otp;
  const C = { Cookie: (await A("/api/auth/verify", { email: "boss@example.test", otp })).headers.get("Set-Cookie").split(";")[0] };
  assert.equal((await A("/api/paylinks", { items: [] }, { ...C, "X-Requested-With": "" })).status, 403); ok("creating a link needs the admin CSRF header");

  const good = { name: "Ravi Kumar", phone: "98765 43210", address: "Plot 4, MIDC Bhosari, Pune", pincode: "411026", state: "Maharashtra", items: [{ id: "black-nfc-card", qty: 200 }, { id: "anti-metal-tag", qty: 100 }] };
  r = await A("/api/paylinks", { ...good, name: "", phone: "123", address: "short", pincode: "41", state: "", gstin: "BADGST", email: "nope", expires_in_hours: 5, items: [] }, C);
  assert.equal(r.status, 400); for (const f of ["name", "phone", "address", "pincode", "state", "gstin", "email", "expires_in_hours", "items"]) assert.ok(r.body.fields[f], f);
  ok("creation validates every field server-side and names each problem");
  assert.match((await A("/api/paylinks", { ...good, items: [{ id: "made-up", qty: 10 }] }, C)).body.fields.items, /cannot be sold/);
  assert.match((await A("/api/paylinks", { ...good, items: [{ id: "black-nfc-card", qty: 5 }] }, C)).body.fields.items, /minimum/i);
  run("UPDATE products SET active=0 WHERE id='nfc-coin'"); assert.match((await A("/api/paylinks", { ...good, items: [{ id: "nfc-coin", qty: 10 }] }, C)).body.fields.items, /cannot be sold/); run("UPDATE products SET active=1 WHERE id='nfc-coin'");
  assert.equal((await A("/api/paylinks", { ...good, source_order_id: "00000000-0000-0000-0000-000000000000" }, C)).status, 400); ok("unknown products, quantities below the minimum, inactive products and unknown source orders are refused");

  r = await A("/api/paylinks", good, C);
  assert.equal(r.status, 201); assert.match(r.body.id, /^[0-9a-f]{32}$/); assert.equal(r.body.url, "https://ntagz.com/pay.html?t=" + r.body.id);
  const made = r.body, mrow = one("SELECT * FROM pay_links WHERE id=?", made.id);
  assert.equal(mrow.created_by, "boss@example.test"); assert.equal(mrow.phone, "9876543210"); assert.equal(mrow.source, "admin"); assert.equal(mrow.txn_id, null); assert.ok(Math.abs(mrow.expires_at - now() - 86400) < 5);
  assert.ok(one("SELECT count(*) c FROM audit_log WHERE action='paylink_create'").c >= 1); ok("a link is created for 24 hours by default, the phone is normalised, the creator and an audit entry are recorded");
  assert.equal(one("SELECT count(*) c FROM pay_links WHERE id=? AND (items_json LIKE '%price%')", made.id).c, 0); ok("no price is stored on the link: it is only items and quantities");

  r = await jget("/api/pay/" + made.id);
  assert.equal(r.body.totals.amount * 100, made.est_paise); assert.equal(r.body.priceChanged, null); ok("the total the admin saw when creating equals the total on the customer's page");

  // dry run: an estimate while typing, nothing saved; and the product list for the form
  const nBefore = one("SELECT count(*) c FROM pay_links").c;
  r = await A("/api/paylinks", { dry_run: true, state: "Maharashtra", items: good.items }, C);
  assert.equal(r.status, 200); assert.equal(r.body.est_paise, made.est_paise); assert.equal(one("SELECT count(*) c FROM pay_links").c, nBefore);
  assert.equal((await A("/api/paylinks", { dry_run: true, items: [{ id: "black-nfc-card", qty: 3 }] }, C)).status, 400);
  const cat = (await A("/api/paylinks", undefined, C)).body.catalog;
  assert.ok(cat.find((x) => x.id === "black-nfc-card" && x.min === 10)); assert.ok(cat.find((x) => x.id === "sample-kit" && x.fixed && x.min === 1)); assert.ok(cat.find((x) => x.id === "uhf-rfid-label" && x.min === 1)); assert.ok(!cat.find((x) => x.id === "made-up"));
  ok("a dry run returns the same estimate without saving, and the form's product list carries each product's minimum quantity");

  // list, funnel stats, filters
  r = await A("/api/paylinks", undefined, C);
  const mine = r.body.links.find((l) => l.id === made.id);
  assert.equal(r.status, 200); assert.equal(mine.status, "opened"); assert.equal(mine.open_count, 1); assert.equal(mine.items.length, 2); assert.equal(mine.items[0].name.length > 3, true); assert.equal(mine.url, made.url);
  ok("the list shows each link with its status, opens and items (opened after the customer viewed it)");
  const fresh = (await A("/api/paylinks", { ...good, name: "Meera Shah", phone: "9000000011" }, C)).body;
  assert.equal((await A("/api/paylinks?status=awaiting", undefined, C)).body.links.find((l) => l.id === fresh.id).status, "new");
  assert.ok((await A("/api/paylinks?status=opened", undefined, C)).body.links.every((l) => l.status === "opened"));
  assert.equal((await A("/api/paylinks?q=9000000011", undefined, C)).body.links.length, 1); assert.equal((await A("/api/paylinks?q=%25", undefined, C)).body.links.length, 0); ok("filters (awaiting, opened) and phone search work, and wildcards in the search are not interpreted");

  // sent / remind
  assert.equal((await A(`/api/paylinks/${fresh.id}/sent`, { kind: "send" }, C)).status, 200);
  let fl = (await A("/api/paylinks", undefined, C)).body.links.find((l) => l.id === fresh.id); assert.equal(fl.status, "sent"); assert.ok(fl.sent_at);
  await A(`/api/paylinks/${fresh.id}/sent`, { kind: "remind" }, C); await A(`/api/paylinks/${fresh.id}/sent`, { kind: "remind" }, C);
  fl = (await A("/api/paylinks", undefined, C)).body.links.find((l) => l.id === fresh.id); assert.equal(fl.reminder_count, 2); assert.ok(fl.last_reminded_at); ok("sending and reminding are recorded: when it was sent and how many reminders went out");

  // extend / cancel
  run("UPDATE pay_links SET expires_at=? WHERE id=?", now() - 10, fresh.id);
  assert.equal((await A("/api/paylinks", undefined, C)).body.links.find((l) => l.id === fresh.id).status, "expired");
  assert.equal((await A(`/api/paylinks/${fresh.id}/sent`, { kind: "remind" }, C)).status, 409); ok("an expired link shows as expired and cannot be reminded");
  assert.equal((await A(`/api/paylinks/${fresh.id}/extend`, { hours: 7 }, C)).status, 400);
  assert.equal((await A(`/api/paylinks/${fresh.id}/extend`, { hours: 48 }, C)).status, 200);
  assert.equal((await jget("/api/pay/" + fresh.id)).body.status, "active"); ok("extending revives an expired link (only by allowed durations) and the customer can pay again");
  assert.equal((await A(`/api/paylinks/${fresh.id}/cancel`, {}, C)).status, 200); assert.equal((await jget("/api/pay/" + fresh.id)).body.status, "cancelled");
  assert.equal((await A(`/api/paylinks/${fresh.id}/extend`, { hours: 24 }, C)).status, 409); ok("cancelling stops the customer's page at once, and a cancelled link cannot be extended");
  assert.equal((await A(`/api/paylinks/${"0".repeat(32)}/cancel`, {}, C)).status, 404); assert.equal((await A(`/api/paylinks/not-a-token/cancel`, {}, C)).status, 404); ok("unknown or malformed link ids are 404");

  // returning customer + replacing an unpaid WhatsApp order
  const mkOrder = (id, txn, o = {}) => run(`INSERT INTO orders (id,txn_id,gateway,items_json,name,phone,email,address,pincode,state,gstin,subtotal,gst,total,payment_method,payment_status,paid_paise,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, txn, o.gateway || "whatsapp", JSON.stringify(o.items || [{ id: "black-nfc-card", qty: 100 }]), "Ravi Kumar", "9876501234", "ravi@example.test", "Plot 4, MIDC Bhosari, Pune", "411026", "Maharashtra", o.gstin || "27ABCDE1234F1Z5",
      30000, 5400, 35400, o.method || "whatsapp", o.pay || "unpaid", o.pay === "paid" ? 35400 : 0, o.status || "placed", o.at || now() - 3600);
  mkOrder("11111111-aaaa-bbbb-cccc-000000000001", "OFF-QT-1-9876543210", { pay: "paid", gateway: "razorpay", method: "razorpay", status: "delivered", at: now() - 86400 * 40, items: [{ id: "anti-metal-tag", qty: 50 }] });
  mkOrder("22222222-aaaa-bbbb-cccc-000000000002", "OFF-QT-2-9876543210", { items: [{ id: "black-nfc-card", qty: 100 }] });
  r = await A("/api/paylinks/prefill?phone=%2B91+98765-01234", undefined, C);
  assert.equal(r.body.found, true); assert.equal(r.body.customer.pincode, "411026"); assert.equal(r.body.customer.gstin, "27ABCDE1234F1Z5"); assert.equal(r.body.orders, 2);
  assert.deepEqual(r.body.last_paid_items.map((i) => [i.id, i.qty]), [["anti-metal-tag", 50]]); assert.equal(r.body.unpaid_orders.length, 1); assert.equal(r.body.unpaid_orders[0].ref, "22222222");
  assert.equal((await A("/api/paylinks/prefill?phone=9111111111", undefined, C)).body.found, false); assert.equal((await A("/api/paylinks/prefill?phone=12", undefined, C)).body.found, false);
  ok("a returning customer's saved address, GST number, last paid basket and open unpaid orders are found by phone number");
  r = await A("/api/paylinks/prefill?order=22222222-aaaa-bbbb-cccc-000000000002", undefined, C); assert.equal(r.body.order.items[0].qty, 100); assert.equal(r.body.customer.name, "Ravi Kumar"); ok("an unpaid order can be turned into a link (items and details prefilled)");

  const rep = (await A("/api/paylinks", { ...good, items: [{ id: "black-nfc-card", qty: 400 }], source_order_id: "22222222-aaaa-bbbb-cccc-000000000002" }, C)).body;
  assert.ok(rep.id); assert.equal((await A("/api/paylinks", { ...good, source_order_id: "11111111-aaaa-bbbb-cccc-000000000001" }, C)).status, 400); ok("only an open unpaid order can be replaced by a link (a paid order is refused)");
  // The list shows 25 per page, newest first; links made in the same second sort by random id, so make this one newest to keep it on page 1.
  await D1.prepare("UPDATE pay_links SET created_at=created_at+5 WHERE id=?").bind(rep.id).run();
  // the customer takes the suggestion (+100 to reach 500), pays through the link
  const sg = (await jget("/api/pay/" + rep.id)).body.nudges.find((x) => x.type === "tier");
  await jpost("/api/pay/" + rep.id + "/adjust", sg.action);
  const st = await jpost("/api/pay/" + rep.id + "/start", {});
  await jpost("/api/verify-payment", { razorpay_order_id: st.body.orderId, razorpay_payment_id: "pay_rep1", razorpay_signature: await hmac("rzp_secret", `${st.body.orderId}|pay_rep1`) }, { Origin: "https://www.ntagz.com" });
  let rl = (await A("/api/paylinks", undefined, C)).body.links.find((l) => l.id === rep.id);
  assert.equal(rl.status, "paid"); assert.ok(rl.paid_order_ref); assert.equal(rl.adjusted, true); assert.equal(rl.items[0].orig_qty, 400); assert.equal(rl.items[0].qty, 500); assert.ok(rl.paid_total_paise > 0); assert.equal(rl.dup_order_open, true);
  ok("paid through the link: shown as paid with the order, that the customer took the suggestion, and a warning that the unpaid order it replaced is still open");
  assert.equal((await A("/api/orders/22222222-aaaa-bbbb-cccc-000000000002/status", { to: "cancelled", confirm: true }, C)).status, 200);
  rl = (await A("/api/paylinks", undefined, C)).body.links.find((l) => l.id === rep.id); assert.equal(rl.dup_order_open, false); ok("cancelling the old unpaid order (existing order action) clears the warning");
  assert.equal((await A(`/api/paylinks/${rep.id}/cancel`, {}, C)).status, 409); assert.equal((await A(`/api/paylinks/${rep.id}/extend`, { hours: 24 }, C)).status, 409); ok("a paid link cannot be cancelled or extended");

  const stats = (await A("/api/paylinks", undefined, C)).body.stats;
  assert.ok(stats.created >= 3); assert.ok(stats.opened >= 2); assert.ok(stats.paid >= 1); assert.ok(stats.revenue_paise > 0); assert.ok(stats.paid_after_suggestion >= 1); assert.ok(stats.awaiting >= 1); ok("funnel numbers: links made, opened, paid, revenue through links, and how many paid after taking a suggestion");

  // ── before migration 0020 ──
  const keep = q("SELECT sql FROM sqlite_master WHERE name='pay_links'")[0].sql;
  sqlite.exec("DROP TABLE pay_links");
  assert.equal((await jget("/api/pay/" + "a".repeat(32))).status, 503);
  aEnv = { ...adminEnv, DB: { ...D1 } };
  const off = await A("/api/paylinks", undefined, C); assert.equal(off.status, 200); assert.equal(off.body.available, false);
  assert.equal((await A("/api/paylinks", good, C)).status, 409); sqlite.exec(keep); aEnv = adminEnv; ok("without the pay_links table: the customer API answers 503, the admin says the migration is needed (nothing else is affected)");

  console.log(`\nall ${n} pay-link checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
