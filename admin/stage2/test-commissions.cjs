// Commission engine: rules, accrual on won leads, one commission per order, approval, release gating (hold + payment cleared + no refund),
// refund adjustments, disputes, atomic settlements with TDS, permissions, isolation, and the money invariants.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeDb, root } = require("./d1shim.cjs");

let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const rej = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);
const DAY = 86400;

(async () => {
  const imp = (f) => import(pathToFileURL(path.join(root, "packages/platform-core/src", f)).href);
  const core = await imp("index.js"), C = await imp("commissions.js"), L = await imp("leads.js");
  const { loadAccess, accessForRoles, partnerRouter, adminV1 } = core;
  const t = makeDb(); const { D1, sqlite, q, one } = t;
  const now = () => Math.floor(Date.now() / 1000);

  // ---- fixtures ----
  const mk = (i, type, role, code) => {
    sqlite.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run("u" + i, `u${i}@example.test`);
    sqlite.prepare("INSERT INTO user_roles (id, user_id, role_key, granted_by) VALUES (?, ?, ?, 'test')").run(crypto.randomUUID(), "u" + i, role);
    sqlite.prepare("INSERT INTO partners (id, partner_code, user_id, type_key, status, business_name) VALUES (?, ?, ?, ?, 'active', ?)").run("p" + i, code, "u" + i, type, `Biz ${code}`);
  };
  mk(1, "flex", "partner_flex", "NTZ-FLX-0001"); mk(2, "enterprise", "partner_enterprise", "NTZ-ENT-0001"); mk(3, "360", "partner_360", "NTZ-360-0001");
  const A = {}; for (const i of [1, 2, 3]) A[i] = await loadAccess(D1, "u" + i);
  const hq = await accessForRoles(D1, "hq@example.test", ["hq_admin"]);
  const fin = await accessForRoles(D1, "fin@example.test", ["finance"]);
  const ops = await accessForRoles(D1, "ops@example.test", ["operations"]);
  let ph = 9830000000, oid = 0;
  const mkLead = async (acc) => (await L.createLead(D1, acc, { businessName: "Cafe " + ++ph, contactName: "Ravi", phone: String(ph) })).lead.id;
  // qualifying = value ex-GST after discounts (the commission base); paid defaults to qualifying x 1.18
  const mkOrder = (o = {}) => { const id = "order-" + ++oid; const qual = o.qual ?? 300000; const paid = o.paid ?? Math.round(qual * 1.18);
    sqlite.prepare("INSERT INTO orders (id, txn_id, gateway, status, total, payment_status, paid_paise, refunded_paise, qualifying_paise, subtotal, created_at) VALUES (?, ?, 'razorpay', 'confirmed', ?, ?, ?, ?, ?, ?, ?)")
      .run(id, "txn-" + oid, paid, o.unpaid ? "unpaid" : "paid", o.unpaid ? 0 : paid, o.refunded ?? 0, qual, qual, o.created ?? now()); return id; };
  const win = async (acc, order, who = hq) => { const lead = await mkLead(acc); return { lead, res: await L.setStatusHq(D1, who, lead, { status: "won", orderId: order }) }; };
  const com = (id) => one("SELECT * FROM commissions WHERE id = ?", id);
  const cid = (orderId) => one("SELECT id FROM commissions WHERE order_id = ?", orderId)?.id;

  // ---- nothing is invented ----
  let { res } = await win(A[1], mkOrder());
  assert.equal(res.lead.status, "won"); assert.equal(res.commission, null); assert.equal(one("SELECT COUNT(*) c FROM commissions").c, 0); ok("with no rule defined, winning a lead creates no commission (no terms are seeded)");
  assert.deepEqual(await C.getSettings(D1), { defaultHoldDays: 30, defaultHoldDaysIsSet: false, tdsRateBp: null }); ok("defaults: 30-day hold, and NO TDS rate until the owner sets one");
  assert.throws(() => sqlite.prepare("INSERT INTO commission_rules (id, name, earning_type, pct_bp, created_by) VALUES ('x', 'MLM', 'recruitment', 500, 'a')").run(), /CHECK/); ok("there is no recruitment/referral-of-partners earning type: the database refuses one");

  // ---- settings and rules: HQ only ----
  await rej(C.setSettings(D1, fin, { defaultHoldDays: 7 }), "FORBIDDEN"); await rej(C.listRules(D1, fin), "FORBIDDEN"); await rej(C.createRule(D1, A[1], { name: "x", pctBp: 100 }), "FORBIDDEN"); await rej(C.listRules(D1, ops), "FORBIDDEN"); ok("only HQ can change commission terms (Finance, Operations and partners cannot)");
  for (const bad of [{ defaultHoldDays: -1 }, { defaultHoldDays: 400 }, { defaultHoldDays: 1.5 }, { tdsRateBp: 5000 }, { tdsRateBp: -1 }]) await rej(C.setSettings(D1, hq, bad), "VALIDATION_FAILED"); ok("hold days (0-365) and TDS (0-30%) are validated");
  let st = await C.setSettings(D1, hq, { defaultHoldDays: 10 }); assert.equal(st.defaultHoldDays, 10); assert.equal(st.tdsRateBp, null); ok("the default hold can be set; TDS stays unset");
  for (const bad of [{ name: "x", pctBp: 500 }, { name: "Rule" }, { name: "Rule", pctBp: 20000 }, { name: "Rule", pctBp: 500, partnerType: "nope" }, { name: "Rule", pctBp: 500, earningType: "installation" }, { name: "Rule", pctBp: 500, refundPolicy: "keep" }, { name: "Rule", pctBp: 500, holdDays: -2 }, { name: "Rule", pctBp: 500, maxPaise: 0 }]) await rej(C.createRule(D1, hq, bad), "VALIDATION_FAILED"); ok("a rule must pay something and its fields are validated (only lead conversion is generated today)");
  await C.createRule(D1, hq, { name: "Standard lead conversion", pctBp: 500 }); // 5% for everyone
  await C.createRule(D1, hq, { name: "Enterprise lead conversion", partnerType: "enterprise", pctBp: 1000, maxPaise: 50000, holdDays: 0, refundPolicy: "reverse_all", minOrderPaise: 100000 });
  assert.equal((await C.listRules(D1, hq)).rules.length, 2); ok("HQ defines rules (general and per partner type)");

  // ---- accrual ----
  const o1 = mkOrder({ qual: 300000, created: now() - 40 * DAY });
  ({ res } = await win(A[1], o1)); const c1 = cid(o1);
  assert.deepEqual(res.commission, { amountPaise: 15000, status: "pending" }); assert.equal(com(c1).status, "pending"); assert.equal(com(c1).base_paise, 300000); assert.equal(com(c1).original_amount_paise, 15000); ok("a won lead earns 5% of the order's ex-GST value (₹3,000 -> ₹150), pending approval");
  assert.equal(one("SELECT COUNT(*) c FROM audit_log WHERE action = 'commission.create' AND entity_id = ?", c1).c, 1); assert.ok(one("SELECT COUNT(*) c FROM lead_activities WHERE lead_id = ? AND body LIKE 'Commission of%'", com(c1).lead_id).c === 1); ok("creation is audited and noted on the lead");
  const snap = JSON.parse(com(c1).rule_snapshot_json); assert.equal(snap.pctBp, 500); assert.equal(snap.holdDays, 10); assert.equal(snap.refundPolicy, "proportional"); ok("the rule's terms are frozen onto the commission (hold taken from the default setting)");
  const o2 = mkOrder({ qual: 1000000 }); ({ res } = await win(A[2], o2));
  assert.equal(res.commission.amountPaise, 50000); assert.equal(JSON.parse(com(cid(o2)).rule_snapshot_json).ruleName, "Enterprise lead conversion"); ok("the most specific rule wins (Enterprise 10%), capped at its maximum (₹10,000 -> ₹500 cap)");
  const o3 = mkOrder({ qual: 50000 }); ({ res } = await win(A[2], o3)); assert.equal(res.commission.amountPaise, 2500); assert.equal(JSON.parse(com(cid(o3)).rule_snapshot_json).ruleName, "Standard lead conversion"); ok("an order under the Enterprise rule's minimum falls through to the general 5% rule (₹500 -> ₹25)");
  const o4 = mkOrder({ qual: 80000 }); ({ res } = await win(A[3], o4)); assert.equal(res.commission.amountPaise, 4000); ok("a 360 partner gets the general 5% (₹800 -> ₹40)");
  await C.updateRule(D1, hq, (await C.listRules(D1, hq)).rules.find((r) => r.name === "Standard lead conversion").id, { pctBp: 900 });
  assert.equal(com(c1).amount_paise, 15000); assert.equal(JSON.parse(com(c1).rule_snapshot_json).pctBp, 500); ok("editing a rule later never changes an existing commission");
  const o5 = mkOrder({ qual: 100000 }); ({ res } = await win(A[1], o5)); assert.equal(res.commission.amountPaise, 9000); ok("new commissions use the edited rule (9%)");
  const rid = (await C.listRules(D1, hq)).rules.find((r) => r.name === "Standard lead conversion").id; await C.updateRule(D1, hq, rid, { active: false });
  const o6 = mkOrder({ qual: 100000 }); ({ res } = await win(A[1], o6)); assert.equal(res.commission, null); await C.updateRule(D1, hq, rid, { active: true }); ok("an inactive rule creates nothing");

  // ---- one commission per order: no duplicate attribution ----
  assert.throws(() => sqlite.prepare("INSERT INTO commissions (id, partner_id, order_id, rule_snapshot_json, earning_type, base_paise, original_amount_paise, amount_paise) VALUES ('dup', 'p2', ?, '{}', 'lead_conversion', 1, 1, 1)").run(o1), /UNIQUE/); ok("an order can never earn the same commission twice, for anyone (database constraint)");
  const lead2 = await mkLead(A[2]); await rej(L.setStatusHq(D1, hq, lead2, { status: "won", orderId: o1 }), "CONFLICT"); assert.equal(one("SELECT COUNT(*) c FROM commissions WHERE order_id = ?", o1).c, 1); ok("crediting an already-credited order to another lead is refused and creates nothing");

  // ---- approval ----
  await rej(C.approve(D1, A[1], c1), "FORBIDDEN"); await rej(C.approve(D1, ops, c1), "FORBIDDEN"); ok("partners and Operations cannot approve commissions");
  let r = await C.approve(D1, fin, c1);
  assert.equal(r.commission.status, "payable"); assert.equal(r.commission.approvedBy, "fin@example.test"); const orderDate = one("SELECT created_at c FROM orders WHERE id = ?", o1).c; assert.ok(r.commission.holdUntil >= now() - 1); ok("Finance approves; the order is 40 days old and its 10-day hold has passed, so it is payable at once (hold date never in the past)");
  await rej(C.approve(D1, fin, c1), "CONFLICT"); ok("approving twice is refused");
  r = await C.approve(D1, hq, cid(o2)); assert.equal(r.commission.holdUntil <= now() + 2, true); ok("a rule with a zero-day hold is releasable immediately (the order is already paid)");

  // ---- release gating ----
  assert.equal(com(cid(o2)).status, "payable"); ok("approved + hold passed + payment cleared + no refund -> payable");
  const fut = mkOrder({ qual: 200000, created: now() }); await win(A[1], fut); const cf = cid(fut); await C.approve(D1, hq, cf);
  assert.equal(com(cf).status, "approved"); assert.ok(com(cf).hold_until > now() + 5 * DAY); await C.processDue(D1); assert.equal(com(cf).status, "approved"); ok("a commission is NOT payable while its hold period runs (10 days from the order)");
  sqlite.prepare("UPDATE commissions SET hold_until = unixepoch() - 5 WHERE id = ?").run(cf); await C.processDue(D1); assert.equal(com(cf).status, "payable"); ok("it releases once the hold has passed");
  const unp = mkOrder({ qual: 200000, unpaid: true, created: now() - 60 * DAY }); await win(A[1], unp); const cu = cid(unp); await C.approve(D1, hq, cu);
  await C.processDue(D1); assert.equal(com(cu).status, "approved"); ok("it is NOT payable while the customer's payment has not cleared");
  sqlite.prepare("UPDATE orders SET payment_status = 'paid', paid_paise = 236000 WHERE id = ?").run(unp); await C.processDue(D1); assert.equal(com(cu).status, "payable"); ok("it becomes payable once the payment clears");
  const again = await C.processDue(D1); assert.equal(again.released + again.reduced + again.reversed + again.flagged, 0); ok("running the release pass again changes nothing (idempotent)");

  // ---- refunds ----
  const rf = mkOrder({ qual: 300000 }); await win(A[1], rf); const cr = cid(rf); await C.approve(D1, hq, cr);
  assert.equal(com(cr).status, "approved");
  sqlite.prepare("UPDATE orders SET refunded_paise = 177000 WHERE id = ?").run(rf); await C.processDue(D1); // half of the 354,000 paid
  assert.equal(com(cr).amount_paise, 13500); assert.equal(com(cr).status, "approved"); assert.equal(q("SELECT * FROM commission_adjustments WHERE commission_id = ?", cr)[0].delta_paise, -13500); ok("a half refund halves the commission (proportional policy), recorded in the ledger");
  await C.processDue(D1); assert.equal(q("SELECT COUNT(*) c FROM commission_adjustments WHERE commission_id = ?", cr)[0].c, 1); ok("the refund adjustment is applied once");
  assert.equal(com(cr).status, "approved"); await C.processDue(D1); assert.equal(com(cr).status, "approved"); ok("a refunded order is never released while a refund stands (approved stays approved)");
  await C.adjust(D1, hq, cr, { deltaPaise: 500, reason: "Goodwill correction" }); await C.processDue(D1); assert.equal(com(cr).amount_paise, 14000); ok("a manual correction made after a refund is not undone by the next pass");
  sqlite.prepare("UPDATE orders SET refunded_paise = 354000 WHERE id = ?").run(rf); await C.processDue(D1);
  assert.equal(com(cr).status, "reversed"); assert.equal(com(cr).amount_paise, 0); assert.equal(com(cr).reversed_reason, "Order refunded"); ok("a full refund reverses the commission");
  const rr = mkOrder({ qual: 500000, created: now() - 40 * DAY }); await win(A[2], rr); const crr = cid(rr); await C.approve(D1, hq, crr); sqlite.prepare("UPDATE commissions SET status = 'approved', hold_until = unixepoch() + 999 WHERE id = ?").run(crr);
  sqlite.prepare("UPDATE orders SET refunded_paise = 1000 WHERE id = ?").run(rr); await C.processDue(D1); assert.equal(com(crr).status, "reversed"); ok("under a 'reverse_all' rule even a small refund reverses the commission");

  // ---- manual adjust / reverse ----
  const o7 = mkOrder({ qual: 200000 }); await win(A[1], o7); const c7 = cid(o7);
  await rej(C.adjust(D1, hq, c7, { deltaPaise: 0, reason: "x" }), "VALIDATION_FAILED"); await rej(C.adjust(D1, hq, c7, { deltaPaise: -5, reason: "" }), "VALIDATION_FAILED"); await rej(C.adjust(D1, hq, c7, { deltaPaise: -999999, reason: "too much" }), "VALIDATION_FAILED"); await rej(C.adjust(D1, ops, c7, { deltaPaise: 5, reason: "nope" }), "FORBIDDEN"); ok("adjustments need a reason, a non-zero amount, cannot drive it to zero, and are Finance/HQ only");
  r = await C.adjust(D1, fin, c7, { deltaPaise: -1000, reason: "Agreed discount on the commission" }); assert.equal(r.commission.amountPaise, 17000); assert.equal(r.ledger.at(-1).deltaPaise, -1000); ok("an adjustment changes the amount and is recorded with who and why");
  await rej(C.reverse(D1, hq, c7, "x"), "VALIDATION_FAILED"); r = await C.reverse(D1, hq, c7, "Customer cancelled the project"); assert.equal(r.commission.status, "reversed"); assert.equal(r.commission.amountPaise, 0); await rej(C.reverse(D1, hq, c7, "again please"), "CONFLICT"); await rej(C.adjust(D1, hq, c7, { deltaPaise: 5, reason: "after reversal" }), "CONFLICT"); ok("a reversal needs a reason, zeroes the amount, and a reversed commission is final");

  // ---- disputes ----
  const o8 = mkOrder({ qual: 400000 }); await win(A[1], o8); const c8 = cid(o8);
  await rej(C.disputeMine(D1, A[2], c8, "not mine"), "NOT_FOUND"); await rej(C.disputeMine(D1, A[1], c8, "x"), "VALIDATION_FAILED"); ok("only the owner can dispute, and needs a reason");
  r = await C.disputeMine(D1, A[1], c8, "The order was bigger than shown"); assert.equal(r.commission.status, "disputed"); assert.equal(com(c8).prior_status, "pending"); ok("a partner can dispute their own commission");
  await rej(C.disputeMine(D1, A[1], c8, "again please"), "CONFLICT"); await rej(C.approve(D1, hq, c8), "CONFLICT"); ok("a disputed commission cannot be approved or disputed again until resolved");
  r = await C.resolve(D1, hq, c8, { action: "restore", note: "Checked the order: the amount is right" }); assert.equal(r.commission.status, "pending"); ok("HQ can resolve a dispute by letting the commission stand (it goes back where it was)");
  await C.disputeMine(D1, A[1], c8, "Still looks wrong"); await rej(C.resolve(D1, hq, c8, { action: "reverse", note: "" }), "VALIDATION_FAILED"); r = await C.resolve(D1, hq, c8, { action: "reverse", note: "Partner agreed it was a duplicate" }); assert.equal(r.commission.status, "reversed"); ok("or by reversing it");
  await rej(C.disputeMine(D1, A[1], c8, "too late now"), "CONFLICT"); ok("a reversed commission cannot be disputed");

  // ---- settlements ----
  // p1 has payable: cu (₹... of 200000 -> 5%/9% rule) and cf ; p2 has payable o2's 50000
  const payable = (pid) => q("SELECT * FROM commissions WHERE partner_id = ? AND status = 'payable' AND settlement_id IS NULL", pid);
  assert.equal(payable("p1").length, 3); const sum1 = payable("p1").reduce((s, c) => s + c.amount_paise, 0); assert.ok(sum1 > 0);
  const pays = await C.payables(D1, fin); assert.equal(pays.items.find((i) => i.partnerId === "p1").totalPaise, sum1); assert.equal(pays.items.find((i) => i.partnerId === "p2").totalPaise, 50000); ok("Finance sees what is payable per partner");
  await rej(C.payables(D1, ops), "FORBIDDEN"); await rej(C.createSettlement(D1, A[1], { partnerId: "p1", method: "upi", reference: "UPI-1234" }), "FORBIDDEN"); await rej(C.createSettlement(D1, ops, { partnerId: "p1", method: "upi", reference: "UPI-1234" }), "FORBIDDEN"); ok("only HQ and Finance can record payouts");
  await rej(C.createSettlement(D1, fin, { partnerId: "p1", method: "cash", reference: "UPI-1234" }), "VALIDATION_FAILED"); await rej(C.createSettlement(D1, fin, { partnerId: "p1", method: "upi", reference: "ab" }), "VALIDATION_FAILED"); await rej(C.createSettlement(D1, fin, { partnerId: "nope", method: "upi", reference: "UPI-1234" }), "NOT_FOUND"); ok("method and reference are validated");
  await rej(C.createSettlement(D1, fin, { partnerId: "p3", method: "upi", reference: "UPI-NOTHING" }), "CONFLICT"); assert.equal(one("SELECT COUNT(*) c FROM settlements").c, 0); ok("a partner with nothing payable gets no settlement (and none is created)");
  let s1 = await C.createSettlement(D1, fin, { partnerId: "p1", method: "bank_transfer", reference: "UTR-0001-ABC" });
  assert.match(s1.settlement.number, /^S-\d{4}-0001$/); assert.equal(s1.settlement.totalPaise, sum1); assert.equal(s1.settlement.tdsPaise, 0); assert.equal(s1.settlement.netPaise, sum1); assert.equal(s1.settlement.commissions, 3); ok("settlement pays every payable commission of the partner; with no TDS rate configured none is withheld");
  assert.ok(q("SELECT * FROM commissions WHERE settlement_id = ?", s1.settlement.id).every((c) => c.status === "paid")); assert.equal(payable("p1").length, 0); assert.equal(payable("p2").length, 1); ok("those commissions are now paid and linked; other partners are untouched");
  await rej(C.createSettlement(D1, fin, { partnerId: "p1", method: "upi", reference: "UTR-0002-DEF" }), "CONFLICT"); ok("settling again pays nothing twice");
  const oN = mkOrder({ qual: 200000, created: now() - 60 * DAY }); await win(A[2], oN); await C.approve(D1, hq, cid(oN)); await C.processDue(D1);
  await rej(C.createSettlement(D1, fin, { partnerId: "p2", method: "upi", reference: "UTR-0001-ABC" }), "CONFLICT"); ok("one bank reference cannot be recorded twice");
  await C.setSettings(D1, hq, { tdsRateBp: 500 });
  const tot2 = payable("p2").reduce((s, c) => s + c.amount_paise, 0); const s2 = await C.createSettlement(D1, fin, { partnerId: "p2", method: "upi", reference: "UPI-7777-XYZ" });
  assert.equal(s2.settlement.totalPaise, tot2); assert.equal(s2.settlement.tdsPaise, Math.floor(tot2 * 500 / 10000)); assert.equal(s2.settlement.netPaise, tot2 - Math.floor(tot2 * 500 / 10000)); assert.equal(s2.settlement.tdsRateBp, 500); ok("with a TDS rate set, TDS is floored and net = gross - TDS");
  // two payouts attempted at the same moment: exactly one wins
  const oC = mkOrder({ qual: 200000, created: now() - 60 * DAY }); await win(A[3], oC); await C.approve(D1, hq, cid(oC)); await C.processDue(D1);
  const both = await Promise.allSettled([C.createSettlement(D1, fin, { partnerId: "p3", method: "upi", reference: "RACE-AAAA" }), C.createSettlement(D1, fin, { partnerId: "p3", method: "upi", reference: "RACE-BBBB" })]);
  assert.equal(both.filter((x) => x.status === "fulfilled").length, 1); assert.equal(one("SELECT COUNT(*) c FROM settlements WHERE partner_id = 'p3'").c, 1); ok("two simultaneous payouts for one partner: exactly one is recorded (no double payment)");

  // ---- disputes after payout / refund after payout ----
  const paidC = com(q("SELECT id FROM commissions WHERE settlement_id = ?", s1.settlement.id)[0].id); sqlite.prepare("UPDATE orders SET refunded_paise = 1000 WHERE id = ?").run(paidC.order_id);
  await C.processDue(D1); const flagged = com(paidC.id); assert.equal(flagged.status, "disputed"); assert.equal(flagged.prior_status, "paid"); assert.equal(flagged.amount_paise, paidC.amount_paise); ok("a refund AFTER payout flags the commission for Finance instead of silently changing a paid amount");
  await C.processDue(D1); assert.equal(q("SELECT COUNT(*) c FROM commission_adjustments WHERE commission_id = ? AND kind = 'refund_after_payment'", paidC.id)[0].c, 1); ok("...once");
  await rej(C.resolve(D1, hq, paidC.id, { action: "reverse", note: "refunded order" }), "CONFLICT"); r = await C.resolve(D1, hq, paidC.id, { action: "restore", note: "Refund was a goodwill gesture; commission stands" }); assert.equal(r.commission.status, "paid"); ok("a paid commission in dispute can only be restored here; clawbacks are a Finance decision outside the engine");

  // ---- partner views ----
  const mine = await C.listMine(D1, A[1]); assert.ok(mine.items.length >= 4); assert.ok(mine.items.every((i) => !("partnerId" in i))); assert.equal((await C.listMine(D1, A[2])).items.every((i) => i.orderRef && true), true); ok("a partner sees only their own commissions");
  assert.equal(mine.totals.paid.n >= 1, true); assert.equal(mine.totals.reversed.n >= 2, true); ok("totals are grouped by status");
  const myPaid = mine.items.find((i) => i.status === "paid"); assert.match(myPaid.settlementNumber, /^S-/); ok("a paid commission shows its settlement number");
  await rej(C.getMine(D1, A[2], c1), "NOT_FOUND"); await rej(C.listMine(D1, hq), "FORBIDDEN"); ok("another partner's commission is 'not found'; HQ staff have no partner earnings view");
  const det = await C.getMine(D1, A[1], cr); assert.equal(det.commission.terms.refundPolicy, "proportional"); assert.deepEqual(det.ledger.map((l) => l.by).filter((b) => b === "Ntagz" || b === "System").length > 0, true); assert.ok(!JSON.stringify(det).includes("hq@example.test") && !JSON.stringify(det).includes("fin@example.test")); ok("the ledger explains each change; admin emails are not exposed to partners");
  const stm = await C.listSettlementsMine(D1, A[1]); assert.equal(stm.items.length, 1); assert.equal(stm.items[0].totalPaise, sum1); assert.equal((await C.listSettlementsMine(D1, A[2])).items.length, 1); ok("partners see their own settlement statements");

  // ---- HQ views ----
  let all = await C.listAll(D1, fin); assert.ok(all.items.length >= 8); assert.ok(all.items.every((i) => i.partnerCode)); assert.equal(all.totals.paid.n >= 3, true); ok("Finance sees every commission with the partner named, and totals by status");
  assert.ok((await C.listAll(D1, hq, { status: "reversed" })).items.every((i) => i.status === "reversed")); assert.ok((await C.listAll(D1, hq, { partnerId: "p3" })).items.every((i) => i.partnerCode === "NTZ-360-0001")); assert.ok((await C.listAll(D1, hq, { q: "ntz-ent" })).items.length >= 1); assert.equal((await C.listAll(D1, hq, { q: "%" })).items.length, 0); ok("filters by status and partner; search is literal for wildcards");
  await rej(C.listAll(D1, ops), "FORBIDDEN"); await rej(C.listAll(D1, A[1]), "FORBIDDEN"); ok("Operations and partners cannot use the HQ commission views");
  const d = await C.getAny(D1, hq, cr); assert.equal(d.commission.order.id, rf); assert.equal(d.commission.order.refundedPaise, 354000); assert.ok(d.ledger.length >= 2); assert.equal(d.commission.terms.pctBp, 900); ok("HQ detail shows the order, the frozen terms and the full ledger");
  assert.equal((await C.listSettlements(D1, fin)).items.length, 3); ok("Finance lists settlements");

  // ---- the money invariants, over everything above ----
  for (const c of q("SELECT * FROM commissions")) {
    const sum = one("SELECT COALESCE(SUM(delta_paise), 0) s FROM commission_adjustments WHERE commission_id = ?", c.id).s;
    assert.equal(c.amount_paise, c.original_amount_paise + sum, `ledger for ${c.id}`);
    assert.ok(c.amount_paise >= 0); assert.ok(c.status !== "reversed" || c.amount_paise === 0); assert.ok((c.status === "paid") === !!c.settlement_id || c.status === "disputed", `paid <-> settled for ${c.id}`);
  }
  ok("every commission's amount equals its original amount plus its ledger");
  for (const s of q("SELECT * FROM settlements")) {
    const paid = one("SELECT COALESCE(SUM(amount_paise), 0) s, COUNT(*) n FROM commissions WHERE settlement_id = ?", s.id);
    assert.equal(paid.s, s.total_paise); assert.equal(s.net_paise, s.total_paise - s.tds_paise); assert.ok(s.net_paise > 0 && paid.n > 0);
  }
  ok("every settlement's total equals the commissions it paid, and net = gross - TDS");
  assert.equal(one("SELECT COUNT(*) c FROM (SELECT order_id, earning_type FROM commissions GROUP BY 1, 2 HAVING COUNT(*) > 1)").c, 0); ok("no order is credited twice");
  assert.equal(one("SELECT COUNT(*) c FROM commissions WHERE status IN ('payable','paid') AND order_id IN (SELECT id FROM orders WHERE payment_status != 'paid')").c, 0); ok("nothing payable or paid belongs to an unpaid order");

  // ---- HTTP ----
  const env = { DB: D1 }; const ORIGIN = "https://partner.test";
  const sid = async (uid) => { const tok = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""); const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tok))), (b) => b.toString(16).padStart(2, "0")).join(""); sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at, portal) VALUES (?, ?, unixepoch() + 3600, 'partner')").run(h, uid); return tok; };
  const http = async (p, { method = "GET", body, who } = {}) => { const headers = { origin: ORIGIN, "x-requested-with": "ntagz" }; if (who) headers.cookie = `__Host-ntagz_partner=${who}`; if (body) headers["content-type"] = "application/json"; const res = await partnerRouter(new Request(ORIGIN + p, { method, headers, body: body ? JSON.stringify(body) : undefined }), env); return { status: res.status, json: await res.json() }; };
  const t1 = await sid("u1"), t2 = await sid("u2");
  assert.equal((await http("/api/v1/partner/commissions")).status, 401); let h = await http("/api/v1/partner/commissions", { who: t1 }); assert.ok(h.json.data.items.length >= 4 && h.json.data.totals); ok("the earnings API needs a session and returns the partner's own data");
  const pend = q("SELECT id FROM commissions WHERE partner_id = 'p1' AND status = 'pending'")[0]; assert.equal((await http(`/api/v1/partner/commissions/${pend.id}`, { who: t2 })).status, 404); h = await http(`/api/v1/partner/commissions/${pend.id}/dispute`, { method: "POST", who: t1, body: { reason: "Please check the amount" } }); assert.equal(h.json.data.commission.status, "disputed"); ok("another partner's commission is 404; dispute works over HTTP");
  assert.equal((await http("/api/v1/partner/settlements", { who: t1 })).json.data.items.length, 1); ok("settlement statements over HTTP");
  const noCsrf = await partnerRouter(new Request(ORIGIN + `/api/v1/partner/commissions/${pend.id}/dispute`, { method: "POST", headers: { origin: ORIGIN, cookie: `__Host-ntagz_partner=${t1}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "no csrf" }) }), env); assert.equal(noCsrf.status, 403); ok("disputing without the CSRF header is blocked");
  const adm = async (p, method = "GET", body = {}) => { const res = await adminV1(new Request("https://admin.test" + p, { method }), env, "hq@example.test", body); return { status: res.status, json: await res.json() }; };
  h = await adm("/api/v1/admin/commissions?status=disputed"); assert.ok(h.json.data.items.some((i) => i.id === pend.id)); h = await adm(`/api/v1/admin/commissions/${pend.id}`); assert.equal(h.json.data.commission.status, "disputed");
  h = await adm(`/api/v1/admin/commissions/${pend.id}/resolve`, "POST", { action: "restore", note: "Checked, amount stands" }); assert.equal(h.json.data.commission.status, "pending"); h = await adm(`/api/v1/admin/commissions/${pend.id}/approve`, "POST"); assert.equal(h.json.data.commission.status, "approved"); ok("HQ routes: list, open, resolve, approve");
  h = await adm("/api/v1/admin/commission-rules"); assert.equal(h.json.data.rules.length, 2); h = await adm("/api/v1/admin/commission-rules", "POST", { name: "Smile+ conversion", partnerType: "smile_plus", fixedPaise: 5000 }); assert.equal(h.status, 201); h = await adm("/api/v1/admin/commission-settings", "POST", { defaultHoldDays: 21 }); assert.equal(h.json.data.defaultHoldDays, 21); h = await adm("/api/v1/admin/payables"); assert.ok(Array.isArray(h.json.data.items)); h = await adm("/api/v1/admin/settlements"); assert.equal(h.json.data.items.length, 3); ok("HQ routes: rules, settings, payables, settlements");

  console.log(`all ${n} commission checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
