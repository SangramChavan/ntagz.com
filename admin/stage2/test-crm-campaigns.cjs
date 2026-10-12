// CRM email campaigns + automated journeys: the real admin Worker and CRM modules on one in-memory D1, with Resend stubbed.
const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const root = path.join(__dirname, "..", "..");
const { makeDb } = require("./d1shim.cjs");
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const ADMIN = "https://admin.ntagz.com";
const WH = "whsec_" + Buffer.from("test-webhook-secret-0123456789").toString("base64");

// ── Resend stub: records every provider call; never talks to the network ──
const calls = []; let mode = "ok", ctr = 0;
global.fetch = async (url, opts) => {
  if (String(url) === "https://api.resend.com/emails/batch") {
    const body = JSON.parse(opts.body); calls.push({ headers: opts.headers, body });
    await new Promise((r) => setTimeout(r, 5));
    if (mode === "500") return new Response("boom", { status: 500 });
    return Response.json({ data: body.map(() => ({ id: "re_" + ++ctr })) });
  }
  throw new Error("unexpected network call: " + url);
};
const sentTo = () => calls.flatMap((c) => c.body.map((m) => m.to[0]));

(async () => {
  const admin = (await import(pathToFileURL(path.join(root, "admin", "src", "index.js")).href)).default;
  const campaigns = await import(pathToFileURL(path.join(root, "admin", "src", "crm", "campaigns.js")).href);
  const journeys = await import(pathToFileURL(path.join(root, "admin", "src", "crm", "journeys.js")).href);
  const db = makeDb(); const { sqlite, D1, q, one } = db;
  const env = { DB: D1, ADMIN_EMAILS: "admin@example.test,viewer@example.test", DEV_OTP_ECHO: "1", ASSETS: { fetch: () => new Response("x") },
    RESEND_API_KEY: "re_test", MARKETING_SEND_ENABLED: "1", MARKETING_FROM: "ntagz <offers@ntagz.com>", MARKETING_POSTAL_ADDRESS: "ntagz, 1 Test Street, Pune 411001", UNSUB_SECRET: "unsub-secret", RESEND_WEBHOOK_SECRET: WH };
  const jar = {};
  const A = async (who, p, body) => {
    const h = { Origin: ADMIN, "X-Requested-With": "ntagz-admin", "Content-Type": "application/json" }; if (jar[who]) h.Cookie = jar[who];
    const r = await admin.fetch(new Request(ADMIN + p, { method: body === undefined ? "GET" : "POST", headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: r.status, d: await r.clone().json().catch(() => ({})), headers: r.headers };
  };
  for (const who of ["admin", "viewer"]) {
    const email = `${who}@example.test`; let r = await A(who, "/api/auth/request", { email });
    r = await A(who, "/api/auth/verify", { email, otp: r.d.dev_otp }); jar[who] = r.headers.get("set-cookie").split(";")[0];
  }
  const T = () => Math.floor(Date.now() / 1000);
  const user = (email, name) => { const id = crypto.randomUUID(); sqlite.prepare("INSERT INTO users (id,email,name) VALUES (?,?,?)").run(id, email, name || null); return id; };
  const consent = (email, status, at = T() - 30 * 86400, reason = null) => sqlite.prepare("INSERT OR REPLACE INTO marketing_contacts (email,status,source,consented_at,suppression_reason) VALUES (?,?,?,?,?)").run(email, status, "test", at, reason);
  const ua = user("a@example.test", "Asha Rao"), ub = user("b@example.test"); user("c@example.test"); user("d@example.test"); user("e@example.test");
  consent("a@example.test", "subscribed"); consent("b@example.test", "subscribed"); consent("c@example.test", "unsubscribed"); consent("d@example.test", "suppressed", T(), "bounce");
  const seg = (await A("admin", "/api/crm/segments", { name: "Everyone", rules: { op: "and", rules: [] } })).d.id; assert.ok(seg);
  const mk = async (extra = {}) => { const r = await A("admin", "/api/crm/campaigns", { name: "Autumn news", subject: "Hello from ntagz", preview_text: "Preview", segment_id: seg, body: { heading: "Hi there", body: "A short note.", products: ["black-nfc-card"], cta: { label: "Shop", path: "/order.html" }, offer: { type: "new_product" } }, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.d)); return r.d.campaign; };
  const send = (id, key = "key-" + Math.random().toString(36).slice(2, 10)) => A("admin", `/api/crm/campaigns/${id}/send`, { confirm: true, idempotency_key: key });
  const rows = (id) => q("SELECT * FROM campaign_recipients WHERE campaign_id=? ORDER BY email", id);

  // ── audience: only current opt-ins ──
  const c1 = await mk();
  let r = await A("admin", `/api/crm/campaigns/${c1.id}/audience`, {});
  assert.equal(r.d.total, 5); assert.equal(r.d.eligible, 2); assert.deepEqual(r.d.excluded.no_consent, 1); assert.equal(r.d.excluded.unsubscribed, 1); assert.equal(r.d.excluded.suppressed, 1);
  assert.ok(r.d.sample.includes("a***@example.test")); assert.ok(!JSON.stringify(r.d).includes("a@example.test"));
  ok("audience counts only subscribed people; unsubscribed, suppressed and no-consent customers are excluded; samples are masked");

  // ── not configured: nothing frozen, nothing sent ──
  const saved = env.MARKETING_FROM; delete env.MARKETING_FROM;
  r = await send(c1.id); assert.equal(r.status, 409); assert.match(r.d.error, /Email sending is not configured: set MARKETING_FROM/);
  assert.equal((await A("admin", `/api/crm/campaigns/${c1.id}/test-send`, {})).status, 409);
  const st = await A("admin", "/api/crm/email-status"); assert.equal(st.d.configured, false); assert.deepEqual(st.d.missing, ["MARKETING_FROM"]);
  assert.equal(one("SELECT status s FROM campaigns WHERE id=?", c1.id).s, "draft"); assert.equal(rows(c1.id).length, 0); assert.equal(calls.length, 0);
  env.MARKETING_FROM = saved; ok("unconfigured provider: send and test-send return 409, nothing is frozen or sent, status lists only variable names");

  // ── preview ──
  r = await A("admin", `/api/crm/campaigns/${c1.id}/preview`, {});
  assert.equal(r.status, 200); assert.match(r.d.html, /Unsubscribe/); assert.match(r.d.html, /1 Test Street/); assert.match(r.d.html, /you opted in|opted in to marketing/); assert.match(r.d.html, /\/product\/black-nfc-card\//); assert.match(r.d.html, /\+ GST/); assert.ok(r.d.text.includes("Unsubscribe:"));
  ok("preview has the unsubscribe link, postal address, opt-in line, a real product URL and ex-GST price label");

  // ── permissions ──
  assert.equal((await A("viewer", `/api/crm/campaigns/${c1.id}/send`, { confirm: true, idempotency_key: "key-viewer-1" })).status, 403);
  assert.equal((await A("viewer", `/api/crm/campaigns/${c1.id}/test-send`, {})).status, 403);
  assert.equal((await A("viewer", `/api/crm/campaigns/${c1.id}/cancel`, {})).status, 403);
  assert.equal((await A("viewer", `/api/crm/campaigns`)).status, 200); ok("an admin without the send permission gets 403 on send, test-send and cancel");

  // ── test send goes only to the acting admin ──
  r = await A("admin", `/api/crm/campaigns/${c1.id}/test-send`, {}); assert.equal(r.status, 200);
  assert.deepEqual(sentTo(), ["admin@example.test"]); assert.match(calls[0].body[0].subject, /^\[TEST\] /); calls.length = 0; ok("test send reaches only the acting admin, subject prefixed [TEST]");

  // ── send twice => one frozen set ──
  assert.equal((await send(c1.id)).d.campaign.status, "sending");
  const again = await send(c1.id); assert.equal(again.status, 200); assert.equal(again.d.noop, true);
  assert.equal((await A("admin", `/api/crm/campaigns/${c1.id}/send`, { idempotency_key: "short" })).d.noop, true);
  assert.deepEqual(rows(c1.id).map((x) => [x.email, x.status]), [["a@example.test", "queued"], ["b@example.test", "queued"]]);
  assert.equal(one("SELECT eligible_at_send e FROM campaigns WHERE id=?", c1.id).e, 2); assert.equal(calls.length, 0);
  assert.throws(() => sqlite.prepare("INSERT INTO campaign_recipients (id,campaign_id,email) VALUES (?,?,?)").run(crypto.randomUUID(), c1.id, "a@example.test"), /UNIQUE/);
  ok("sending twice freezes one recipient row per email and makes no provider call; duplicates are impossible at the database level");

  // ── tick sends once; headers and body ──
  await campaigns.tick(env); await campaigns.tick(env);
  assert.equal(calls.length, 1); assert.deepEqual(sentTo().sort(), ["a@example.test", "b@example.test"]);
  const rs = rows(c1.id); assert.ok(rs.every((x) => x.status === "sent" && /^re_\d+$/.test(x.provider_id) && x.sent_at && x.attempts === 1));
  assert.equal(one("SELECT status s FROM campaigns WHERE id=?", c1.id).s, "sent");
  const m = calls[0].body.find((x) => x.to[0] === "a@example.test");
  assert.match(m.headers["List-Unsubscribe"], /^<https:\/\/ntagz\.com\/api\/unsubscribe\?e=a%40example\.test&t=[0-9a-f]{64}>, <mailto:offers@ntagz\.com/); assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.ok(m.text.includes("Hi Asha,") && m.text.includes("Unsubscribe:") && m.html.includes("Unsubscribe") && m.html.includes("1 Test Street")); assert.match(calls[0].headers["Idempotency-Key"], /^mk-[0-9a-f]{64}$/);
  assert.match(m.html, new RegExp(`/api/c/${rs.find((x) => x.email === "a@example.test").id}\\?p=`)); assert.match(m.html, /utm_campaign=c-/);
  ok("tick sends each frozen row once (second tick is a no-op), stores provider ids, and every message carries List-Unsubscribe, One-Click, footer and plain text");

  // ── concurrent ticks never double-send ──
  const c2 = await mk({ segment_id: null, recipients: ["a@example.test", "b@example.test"] }); await send(c2.id);
  calls.length = 0; await Promise.all([campaigns.tick(env), campaigns.tick(env), campaigns.tick(env)]);
  assert.deepEqual(sentTo().sort(), ["a@example.test", "b@example.test"]); ok("claimed rows are not double-sent when ticks overlap");

  // ── provider failure: retryable, then failed after 3 attempts ──
  const c3 = await mk({ segment_id: null, recipients: ["a@example.test"] }); await send(c3.id);
  calls.length = 0; mode = "500";
  await campaigns.tick(env); assert.deepEqual([rows(c3.id)[0].status, rows(c3.id)[0].attempts], ["queued", 1]);
  await campaigns.tick(env); assert.deepEqual([rows(c3.id)[0].status, rows(c3.id)[0].attempts], ["queued", 2]);
  await campaigns.tick(env); assert.deepEqual([rows(c3.id)[0].status, rows(c3.id)[0].attempts], ["failed", 3]); assert.equal(rows(c3.id)[0].sent_at, null);
  assert.equal(calls.length, 3); assert.equal(new Set(calls.map((x) => x.headers["Idempotency-Key"])).size, 1); mode = "ok";
  await campaigns.tick(env); assert.equal(calls.length, 3); ok("provider 500 keeps the row retryable, fails it after 3 attempts, never marks it sent; retries reuse the idempotency key");

  // ── stuck rows are recovered ──
  const c3b = await mk({ segment_id: null, recipients: ["b@example.test"] }); await send(c3b.id);
  sqlite.prepare("UPDATE campaign_recipients SET status='sending', attempts=1, sent_at=? WHERE campaign_id=?").run(T() - 1200, c3b.id);
  calls.length = 0; await campaigns.tick(env); assert.equal(rows(c3b.id)[0].status, "sent"); assert.equal(calls.length, 1); ok("rows stuck in 'sending' for over 10 minutes are recovered and sent");

  // ── eligibility is re-validated at send time ──
  const c4 = await mk({ segment_id: null, recipients: ["a@example.test", "b@example.test"] }); await send(c4.id);
  sqlite.prepare("UPDATE marketing_contacts SET status='unsubscribed' WHERE email='b@example.test'").run();
  calls.length = 0; await campaigns.tick(env);
  assert.deepEqual(sentTo(), ["a@example.test"]); const rb = rows(c4.id).find((x) => x.email === "b@example.test"); assert.equal(rb.status, "skipped"); assert.match(rb.detail, /no longer opted in/);
  sqlite.prepare("UPDATE marketing_contacts SET status='subscribed' WHERE email='b@example.test'").run(); ok("an unsubscribe between freezing and sending turns the row into 'skipped'");

  // ── unconfigured tick: queued rows stay queued ──
  const c5 = await mk({ segment_id: null, recipients: ["a@example.test"] }); await send(c5.id);
  delete env.RESEND_API_KEY; calls.length = 0; await campaigns.tick(env);
  assert.equal(rows(c5.id)[0].status, "queued"); assert.equal(rows(c5.id)[0].sent_at, null); assert.equal(calls.length, 0);
  env.RESEND_API_KEY = "re_test"; ok("tick with an unconfigured provider sends nothing and marks nothing");

  // ── cancel ──
  const c6 = await mk({ segment_id: null, recipients: ["a@example.test"] }); await send(c6.id);
  r = await A("admin", `/api/crm/campaigns/${c6.id}/cancel`, {}); assert.equal(r.d.campaign.status, "cancelled"); assert.equal(rows(c6.id)[0].status, "skipped");
  calls.length = 0; await campaigns.tick(env); assert.ok(!sentTo().includes("never")); ok("cancelling skips queued rows");
  await campaigns.tick(env); // c5 goes out now that the provider is back
  assert.equal(rows(c5.id)[0].status, "sent");

  // ── webhooks ──
  const hook = async (id, ts, event, secretOverride, omit) => {
    const raw = JSON.stringify(event), sig = nodeCrypto.createHmac("sha256", Buffer.from((secretOverride || WH).slice(6), "base64")).update(`${id}.${ts}.${raw}`).digest("base64");
    const h = { "Content-Type": "application/json" }; if (omit !== "id") h["svix-id"] = id; if (omit !== "ts") h["svix-timestamp"] = String(ts); if (omit !== "sig") h["svix-signature"] = "v1,AAAA v1," + sig;
    const res = await admin.fetch(new Request(ADMIN + "/webhooks/resend", { method: "POST", headers: h, body: raw }), env);
    return { status: res.status, d: await res.json().catch(() => ({})) };
  };
  const ra = rows(c1.id).find((x) => x.email === "a@example.test"), rbb = rows(c1.id).find((x) => x.email === "b@example.test");
  const ev = (type, pid, extra = {}) => ({ type, data: { email_id: pid, ...extra } });
  assert.equal((await hook("msg_1", T(), ev("email.delivered", ra.provider_id), null, "sig")).status, 401);
  assert.equal((await hook("msg_1", T(), ev("email.delivered", ra.provider_id), null, "id")).status, 401);
  assert.equal((await hook("msg_1", T(), ev("email.delivered", ra.provider_id), "whsec_" + Buffer.from("other-secret").toString("base64"))).status, 401);
  assert.equal((await hook("msg_1", T() - 400, ev("email.delivered", ra.provider_id))).status, 401);
  assert.equal(one("SELECT count(*) c FROM email_webhook_events").c, 0); assert.equal(one("SELECT status s FROM campaign_recipients WHERE id=?", ra.id).s, "sent");
  assert.equal((await hook("msg_1", T(), ev("email.delivered", ra.provider_id))).status, 200);
  assert.equal(one("SELECT status s FROM campaign_recipients WHERE id=?", ra.id).s, "delivered"); assert.ok(one("SELECT delivered_at d FROM campaign_recipients WHERE id=?", ra.id).d);
  r = await hook("msg_1", T(), ev("email.bounced", ra.provider_id, { bounce: { type: "Permanent" } })); assert.equal(r.status, 200); assert.equal(r.d.duplicate, true);
  assert.equal(one("SELECT status s FROM campaign_recipients WHERE id=?", ra.id).s, "delivered"); assert.equal(one("SELECT status s FROM marketing_contacts WHERE email='a@example.test'").s, "subscribed");
  ok("webhook needs a valid, fresh signature; a duplicate svix-id is ignored");
  assert.equal((await hook("msg_2", T(), ev("email.bounced", rbb.provider_id, { bounce: { type: "Transient" } }))).status, 200);
  assert.equal(one("SELECT status s FROM marketing_contacts WHERE email='b@example.test'").s, "subscribed");
  assert.equal((await hook("msg_3", T(), ev("email.opened", rbb.provider_id))).status, 200);
  assert.equal((await hook("msg_4", T(), ev("email.bounced", ra.provider_id, { bounce: { type: "Permanent" } }))).status, 200);
  const mcA = one("SELECT * FROM marketing_contacts WHERE email='a@example.test'"); assert.equal(mcA.status, "suppressed"); assert.equal(mcA.suppression_reason, "bounce");
  assert.equal(one("SELECT status s FROM campaign_recipients WHERE id=?", ra.id).s, "bounced"); assert.ok(one("SELECT count(*) c FROM consent_log WHERE email='a@example.test' AND action='suppress'").c >= 1);
  assert.equal((await hook("msg_5", T(), ev("email.complained", rbb.provider_id))).status, 200);
  assert.equal(one("SELECT suppression_reason r FROM marketing_contacts WHERE email='b@example.test'").r, "complaint"); assert.equal(one("SELECT status s FROM campaign_recipients WHERE id=?", rbb.id).s, "complained");
  const c7 = await mk({ segment_id: null, recipients: ["a@example.test"] });
  r = await send(c7.id); assert.equal(r.status, 400); assert.match(r.d.error, /No eligible recipients/);
  const c8 = await mk(); r = await A("admin", `/api/crm/campaigns/${c8.id}/audience`, {}); assert.equal(r.d.eligible, 0);
  ok("a permanent bounce or complaint suppresses the address (transient bounces and other events are ignored) and it can never be a recipient again");

  // ── offers ──
  for (const type of ["coupon", "product_discount", "category_discount", "bundle_discount", "bulk_discount", "free_shipping_code", "percent_off"]) {
    r = await A("admin", "/api/crm/campaigns", { name: "Bad offer", subject: "x", body: { heading: "h", offer: { type, code: "SAVE10" } } });
    assert.equal(r.status, 400, type); assert.match(r.d.error, /Needs checkout coupon support \(not built yet\)/);
  }
  ok("coupon and discount offer types are rejected with 400");
  sqlite.prepare("INSERT INTO cart_campaigns (id,name,active,threshold_paise,reward_type,reward_value,audience) VALUES ('cm1','Free ship',0,100000,'free_shipping',0,'all')").run();
  const c9 = await mk({ segment_id: null, recipients: ["b@example.test"], body: { heading: "Milestone", body: "Hello", offer: { type: "cart_milestone", cart_campaign_id: "cm1" } } });
  assert.equal((await A("admin", `/api/crm/campaigns/${c9.id}/preview`, {})).status, 400);
  sqlite.prepare("UPDATE cart_campaigns SET active=1").run();
  r = await A("admin", `/api/crm/campaigns/${c9.id}/preview`, {}); assert.equal(r.status, 200); assert.match(r.d.text, /free shipping when your cart's product value reaches ₹1,000/);
  sqlite.prepare("UPDATE cart_campaigns SET reward_type='percent_off', reward_value=7").run();
  assert.match((await A("admin", `/api/crm/campaigns/${c9.id}/preview`, {})).d.text, /7% off/);
  sqlite.prepare("UPDATE cart_campaigns SET ends_at=?").run(T() - 10); r = await A("admin", `/api/crm/campaigns/${c9.id}/preview`, {}); assert.equal(r.status, 400); assert.match(r.d.error, /expired/);
  r = await A("admin", "/api/crm/campaigns", { name: "Ghost", subject: "x", body: { heading: "h", offer: { type: "cart_milestone", cart_campaign_id: "nope" } } }); assert.equal(r.status, 400);
  ok("cart-milestone text comes from the live row; inactive, expired or missing milestones are refused");

  // ── report ──
  sqlite.prepare("UPDATE campaign_recipients SET clicked_at=?, click_count=2 WHERE id=?").run(T() - 3600, ra.id);
  const oid = crypto.randomUUID(); sqlite.prepare("INSERT INTO orders (id,user_id,txn_id,gateway,status,email,items_json,created_at) VALUES (?,?,?,?,?,?,?,?)").run(oid, ua, "txn-" + oid, "razorpay", "confirmed", "a@example.test", "[]", T());
  sqlite.prepare("UPDATE orders SET payment_status='paid', paid_paise=118000 WHERE id=?").run(oid);
  const before = crypto.randomUUID(); sqlite.prepare("INSERT INTO orders (id,user_id,txn_id,gateway,status,email,items_json,created_at) VALUES (?,?,?,?,?,?,?,?)").run(before, ua, "txn-" + before, "razorpay", "confirmed", "a@example.test", "[]", T() - 7200);
  sqlite.prepare("UPDATE orders SET payment_status='paid', paid_paise=50000 WHERE id=?").run(before);
  r = await A("admin", `/api/crm/campaigns/${c1.id}/report`);
  assert.equal(r.d.eligible_at_send, 2); assert.equal(r.d.sent, 2); assert.equal(r.d.unique_clicks, 1); assert.equal(r.d.click_count, 2); assert.equal(r.d.bounced, 1); assert.equal(r.d.complained, 1); assert.equal(r.d.delivered, 1);
  assert.equal(r.d.attributed_orders, 1); assert.equal(r.d.attributed_revenue_paise, 118000); assert.equal(r.d.unsubscribes, null); assert.equal(r.d.discount_cost_paise, null); assert.equal(r.d.estimated_profit_paise, null); assert.equal(r.d.opens, null); assert.match(r.d.attribution_label, /not incremental/i);
  ok("report: counts, unique clicks, last-click attributed revenue (orders before the click excluded), nulls for unavailable data");

  // ── journeys ──
  r = await A("admin", "/api/crm/journeys"); assert.equal(r.d.journeys.length, 6); assert.ok(r.d.journeys.every((j) => j.active === false && j.test_mode === true));
  assert.equal((await A("viewer", "/api/crm/journeys/welcome", { active: true })).status, 403);
  assert.equal((await A("admin", "/api/crm/journeys/welcome", { config: { delay_hours: 99999 } })).status, 400);
  assert.equal((await A("admin", "/api/crm/journeys/repeat_reminder", { active: true })).status, 400);
  const uf = user("f@example.test", "Farah"); void uf; consent("f@example.test", "subscribed", T() - 7200);
  r = await A("admin", "/api/crm/journeys/welcome/run-now", {}); assert.equal(r.d.count, 1); assert.deepEqual(r.d.would_receive.map((x) => x.email), ["f***@example.test"]); assert.equal(one("SELECT count(*) c FROM journey_runs").c, 0);
  assert.equal((await A("admin", "/api/crm/journeys/welcome", { active: true, test_mode: true })).status, 200);
  calls.length = 0; await journeys.tick(env);
  assert.equal(calls.length, 0); assert.deepEqual(q("SELECT email,status FROM journey_runs").map((x) => [x.email, x.status]), [["f@example.test", "would_send"]]);
  await journeys.tick(env); assert.equal(one("SELECT count(*) c FROM journey_runs").c, 1); ok("journey test mode records would_send and sends nothing; the dry run writes nothing");

  r = await A("admin", "/api/crm/journeys/welcome", { active: true, test_mode: false }); assert.equal(r.status, 400);
  r = await A("admin", "/api/crm/journeys/welcome", { active: true, test_mode: false, confirm_live: true }); assert.equal(r.status, 200);
  await journeys.tick(env); await journeys.tick(env);
  assert.deepEqual(sentTo(), ["f@example.test"]); assert.deepEqual(q("SELECT status,provider_id FROM journey_runs").map((x) => x.status), ["sent"]);
  const jm = calls[0].body[0]; assert.ok(jm.headers["List-Unsubscribe"] && jm.headers["List-Unsubscribe-Post"] && jm.text.includes("Unsubscribe:") && jm.html.includes("Hi Farah,"));
  ok("live journey sends once with unsubscribe headers; running again does not fire twice (dedupe)");

  // frequency cap: another marketing email within min_gap_days blocks the journey, the trigger fires later once the gap has passed
  user("g@example.test"); consent("g@example.test", "subscribed", T() - 7200);
  sqlite.prepare("INSERT INTO campaign_recipients (id,campaign_id,email,status,sent_at) VALUES (?,?,?,'sent',?)").run(crypto.randomUUID(), c1.id, "g@example.test", T() - 3600);
  calls.length = 0; await journeys.tick(env); assert.equal(calls.length, 0); assert.equal(one("SELECT count(*) c FROM journey_runs WHERE email='g@example.test'").c, 0);
  sqlite.prepare("UPDATE campaign_recipients SET sent_at=? WHERE email='g@example.test'").run(T() - 4 * 86400);
  await journeys.tick(env); assert.deepEqual(sentTo(), ["g@example.test"]); ok("frequency cap: no journey email within min_gap_days of another campaign or journey email to the same address");

  // abandoned cart: no cart contents; purchased-since exit condition
  const uh = user("h@example.test", "Hari"), ui = user("i@example.test"); consent("h@example.test", "subscribed"); consent("i@example.test", "subscribed");
  const ev2 = (u, ts) => sqlite.prepare("INSERT INTO crm_events (id,ts,sid,event,user_id,product_id) VALUES (?,?,?,?,?,?)").run("e" + Math.random().toString(36).slice(2, 12), ts, "sid-" + u.slice(0, 8), "add_to_cart", u, "black-nfc-card");
  ev2(uh, T() - 2 * 86400); ev2(ui, T() - 2 * 86400);
  const oi = crypto.randomUUID(); sqlite.prepare("INSERT INTO orders (id,user_id,txn_id,gateway,status,email,items_json,created_at) VALUES (?,?,?,?,?,?,?,?)").run(oi, ui, "txn-" + oi, "razorpay", "confirmed", "i@example.test", "[]", T() - 86400);
  r = await A("admin", "/api/crm/journeys/abandoned_cart/run-now", {}); assert.deepEqual(r.d.would_receive.map((x) => x.email), ["h***@example.test"]);
  assert.equal((await A("admin", "/api/crm/journeys/abandoned_cart", { active: true, test_mode: false, confirm_live: true })).status, 200);
  calls.length = 0; await journeys.tick(env);
  const hm = calls.flatMap((x) => x.body).find((x) => x.to[0] === "h@example.test"); assert.ok(hm); assert.deepEqual(sentTo(), ["h@example.test"]);
  assert.ok(/left something in your cart/i.test(hm.html)); assert.ok(!/black nfc|black-nfc-card/i.test(hm.html + hm.text + hm.subject));
  ok("abandoned-cart email has no product names or cart contents, and skips customers who ordered since");

  // an unsubscribe before the send stops the journey
  user("j@example.test"); consent("j@example.test", "subscribed", T() - 7200); sqlite.prepare("UPDATE marketing_contacts SET status='unsubscribed' WHERE email='j@example.test'").run();
  calls.length = 0; await journeys.tick(env); assert.equal(calls.length, 0); ok("unsubscribed people never receive journey emails");

  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
