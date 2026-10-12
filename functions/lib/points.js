// Ntagz Rewards Membership: points wallet + spending milestones. Shared by the payments Worker (checkout, customer API) and the admin Worker.
//
// Source of truth: the append-only `points_ledger`. A balance is never stored, always derived:
//   available = settled rows (all but 'reserve') + a still-fresh checkout reservation - credits that have expired and were not spent.
// Earning is RECONCILED, not counted: reconcileOrder() works out what an order should have earned right now (paid, not cancelled/returned,
// delivered if so configured, net of refunds) and writes only the difference, so a retried callback, a double click or a late refund can
// never double-pay or lose points. All money is integer paise; points are integers; no floating-point money.
// Everything is inert while pts_live = 0 (checkout bases are 0, so nothing earns; redemption is refused).

const DAY = 86400;
const RESERVE_TTL = 3 * 3600; // an abandoned checkout holds points this long

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
function settingsFrom(cfg) {
  const c = cfg || {};
  const notice = String(c.renew_notice_days ?? "30,7").split(",").map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n) && n > 0 && n <= 365);
  return {
    live: c.pts_live === "1",
    earnPer100: Math.min(Math.max(Math.floor(num(c.pts_earn_per_100, 5)), 0), 100),
    valuePaise: Math.min(Math.max(Math.floor(num(c.pts_value_paise, 100)), 1), 1000),
    minRedeem: Math.min(Math.max(Math.floor(num(c.pts_min_redeem, 50)), 1), 100000),
    maxRedeemPct: Math.min(Math.max(num(c.pts_max_redeem_pct, 10), 0), 100),
    minOrderPaise: Math.max(Math.floor(num(c.pts_min_order_paise, 0)), 0),
    validDays: Math.min(Math.max(Math.floor(num(c.pts_valid_days, 365)), 1), 3650),
    earnOn: c.pts_earn_on === "paid" ? "paid" : "delivered",
    restoreOnCancel: c.pts_restore_on_cancel !== "0",
    clawback: c.pts_clawback !== "0",
    renewWindowDays: Math.min(Math.max(Math.floor(num(c.renew_window_days, 30)), 0), 365),
    noticeDays: [...new Set(notice)].sort((a, b) => b - a).slice(0, 4),
  };
}
async function loadSettings(db) {
  const { results } = await db.prepare("SELECT key,value FROM membership_config WHERE key LIKE 'pts_%' OR key LIKE 'renew_%'").all();
  return settingsFrom(Object.fromEntries(results.map((r) => [r.key, r.value])));
}

// Validates an admin submission (strings or numbers). Returns { errors, values } where values is the {key: string} map to store.
function validateSettings(s) {
  const errors = [], v = {};
  const int = (k, label, min, max) => { if (s[k] === undefined) return; const n = Number(s[k]); if (!Number.isInteger(n) || n < min || n > max) errors.push(`${label} must be a whole number from ${min} to ${max}`); else v[k] = String(n); };
  if (s.pts_live !== undefined) { if (typeof s.pts_live !== "boolean") errors.push("pts_live must be on or off"); else v.pts_live = s.pts_live ? "1" : "0"; }
  int("pts_earn_per_100", "Points per ₹100", 0, 100); int("pts_value_paise", "Point value (paise)", 1, 1000); int("pts_min_redeem", "Minimum redemption", 1, 100000);
  if (s.pts_max_redeem_pct !== undefined) { const n = Number(s.pts_max_redeem_pct); if (!Number.isFinite(n) || n < 0 || n > 50) errors.push("Maximum redemption must be 0–50%"); else v.pts_max_redeem_pct = String(n); }
  int("pts_min_order_paise", "Minimum qualifying order (paise)", 0, 100000000); int("pts_valid_days", "Point validity (days)", 1, 3650); int("renew_window_days", "Renewal window (days)", 0, 365);
  if (s.pts_earn_on !== undefined) { if (!["delivered", "paid"].includes(s.pts_earn_on)) errors.push("Points are earned on 'delivered' or 'paid'"); else v.pts_earn_on = s.pts_earn_on; }
  for (const k of ["pts_restore_on_cancel", "pts_clawback"]) if (s[k] !== undefined) { if (typeof s[k] !== "boolean") errors.push(`${k} must be on or off`); else v[k] = s[k] ? "1" : "0"; }
  if (s.renew_notice_days !== undefined) {
    const l = String(s.renew_notice_days).split(",").map((x) => x.trim()).filter(Boolean);
    if (l.length > 4 || !l.every((x) => /^\d{1,3}$/.test(x) && Number(x) >= 1 && Number(x) <= 365)) errors.push("Expiry notices: up to 4 day-counts from 1 to 365, e.g. 30,7"); else v.renew_notice_days = l.join(",");
  }
  return { errors, values: v };
}

// ── Balance ──────────────────────────────────────────────────────────────────────────────────────────────────
// Credits past their expiry that were not already consumed by spending (oldest credits are consumed first) are lost. The sweep records
// them as 'expire' rows; until it runs, balance() already subtracts them, so an expired point can never be spent.
async function balance(db, userId, now = Math.floor(Date.now() / 1000)) {
  const r = await db.prepare(`SELECT
      coalesce(sum(CASE WHEN kind <> 'reserve' THEN points END), 0) settled,
      coalesce(sum(CASE WHEN kind = 'reserve' AND created_at > ?2 AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.txn_id = points_ledger.ref) THEN points END), 0) held,
      coalesce(sum(CASE WHEN points > 0 AND expires_at IS NOT NULL AND expires_at <= ?3 THEN points END), 0) expired_credits,
      coalesce(-sum(CASE WHEN points < 0 AND kind NOT IN ('expire','reserve') THEN points END), 0) debits,
      coalesce(-sum(CASE WHEN kind = 'expire' THEN points END), 0) already_expired,
      coalesce(sum(CASE WHEN points > 0 AND expires_at IS NOT NULL AND expires_at > ?3 AND expires_at <= ?4 THEN points END), 0) soon
    FROM points_ledger WHERE user_id = ?1`).bind(userId, now - RESERVE_TTL, now, now + 30 * DAY).first();
  const due = Math.max(0, r.expired_credits - r.debits - r.already_expired);
  const settled = r.settled - due;
  return { available: Math.max(0, settled + r.held), settled, held: -r.held, owed: settled + r.held < 0 ? -(settled + r.held) : 0, expiryDue: due, expiring30: Math.min(r.soon, Math.max(0, settled + r.held)) };
}

async function sweepExpiry(db, now = Math.floor(Date.now() / 1000)) {
  const { results } = await db.prepare("SELECT DISTINCT user_id FROM points_ledger WHERE points > 0 AND expires_at IS NOT NULL AND expires_at <= ? LIMIT 500").bind(now).all();
  let n = 0;
  for (const { user_id } of results) {
    const b = await balance(db, user_id, now);
    if (b.expiryDue <= 0) continue;
    const prev = (await db.prepare("SELECT coalesce(-sum(points),0) x FROM points_ledger WHERE user_id=? AND kind='expire'").bind(user_id).first()).x;
    const r = await db.prepare("INSERT OR IGNORE INTO points_ledger (id,user_id,kind,points,idem_key,reason) VALUES (?,?,'expire',?,?,?)")
      .bind(crypto.randomUUID(), user_id, -b.expiryDue, `exp:${user_id}:${prev + b.expiryDue}`, "points expired").run();
    n += r.meta.changes;
  }
  return n;
}

// ── Redemption ───────────────────────────────────────────────────────────────────────────────────────────────
// How many points may be spent on a cart whose eligible merchandise value (ex GST/shipping, after other discounts) is `basisPaise`.
function planRedemption(s, available, requested, basisPaise) {
  if (!s.live) return { points: 0, discountPaise: 0, reason: "Rewards are not active" };
  const want = Math.floor(Number(requested));
  if (!Number.isInteger(want) || want <= 0) return { points: 0, discountPaise: 0, reason: null };
  const byCap = Math.floor((basisPaise * s.maxRedeemPct) / 100 / s.valuePaise);
  const points = Math.min(want, available, byCap);
  if (points < s.minRedeem) {
    return { points: 0, discountPaise: 0, reason: available < s.minRedeem ? `You need at least ${s.minRedeem} points to redeem` : byCap < s.minRedeem ? `This order allows at most ${byCap} points (${s.maxRedeemPct}% of eligible value)` : `Redeem at least ${s.minRedeem} points` };
  }
  return { points, discountPaise: points * s.valuePaise, reason: points < want ? (points === byCap ? `Limited to ${s.maxRedeemPct}% of eligible value` : "Limited to your available points") : null };
}
// Holds points for an open checkout (D1 statements for the caller's batch). Only the newest checkout holds points, so abandoning a payment
// window and trying again never locks a customer out of their own balance; a reserve is working state, not an audit fact (redeem rows are).
// Idempotent per checkout (txn id).
const reserve = (db, userId, txnId, points) => [
  db.prepare("DELETE FROM points_ledger WHERE user_id=? AND kind='reserve' AND ref<>? AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.txn_id = points_ledger.ref)").bind(userId, txnId),
  db.prepare("INSERT OR IGNORE INTO points_ledger (id,user_id,kind,points,ref,idem_key,reason) VALUES (?,?,'reserve',?,?,?,?)").bind(crypto.randomUUID(), userId, -points, txnId, `rsv:${txnId}`, "held at checkout"),
];

// ── Reconcile ────────────────────────────────────────────────────────────────────────────────────────────────
const nowS = () => Math.floor(Date.now() / 1000);
async function reconcileOrder(db, orderId, s) {
  const o = await db.prepare("SELECT id,user_id,status,payment_status,paid_paise,refunded_paise,points_basis_paise,points_redeemed FROM orders WHERE id=?").bind(orderId).first();
  if (!o || !o.user_id) return { changed: 0 };
  const st = s || (await loadSettings(db));
  const paid = o.payment_status === "paid" && o.paid_paise > 0, dead = ["cancelled", "returned"].includes(o.status);
  let changed = 0;
  const ins = async (kind, points, key, extra = {}) => {
    const r = await db.prepare("INSERT OR IGNORE INTO points_ledger (id,user_id,kind,points,order_id,expires_at,idem_key,reason) VALUES (?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), o.user_id, kind, points, o.id, extra.expires || null, key, extra.reason || null).run();
    changed += r.meta.changes;
  };
  // 1. points spent on this order (the order exists only after verified payment, so this is final)
  if (o.points_redeemed > 0 && paid) await ins("redeem", -o.points_redeemed, `redeem:${o.id}`, { reason: "redeemed at checkout" });
  // 2. points earned: exactly what the order is worth now
  const credited = st.earnOn === "paid" || o.status === "delivered";
  const desired = paid && !dead && credited && o.points_basis_paise > 0
    ? Math.floor((o.points_basis_paise * (o.paid_paise - Math.min(o.refunded_paise, o.paid_paise)) * st.earnPer100) / (o.paid_paise * 10000)) : 0;
  const cur = await db.prepare("SELECT coalesce(sum(points),0) s, count(*) n FROM points_ledger WHERE order_id=? AND kind IN ('earn','reverse')").bind(o.id).first();
  if (desired !== cur.s) {
    const d = desired - cur.s;
    await ins(d > 0 ? "earn" : "reverse", d, `ord:${o.id}:${cur.n}`, { expires: d > 0 ? nowS() + st.validDays * DAY : null, reason: d > 0 ? "purchase" : "refund / cancellation / return" });
  }
  // 3. a cancelled or returned order gives the points it spent back (policy: pts_restore_on_cancel)
  if (dead && st.restoreOnCancel && o.points_redeemed > 0 && paid) await ins("restore", o.points_redeemed, `restore:${o.id}`, { expires: nowS() + st.validDays * DAY, reason: "order cancelled / returned" });
  await reconcileUser(db, o.user_id, st);
  return { changed };
}

// Eligible spend in the current membership year = the earning basis of that member's delivered/paid orders, net of refunds.
async function milestoneSpend(db, userId, mem, st) {
  const doneSql = st.earnOn === "paid" ? "1=1" : "status = 'delivered'";
  const r = await db.prepare(`SELECT coalesce(sum(points_basis_paise * (paid_paise - min(refunded_paise, paid_paise)) / paid_paise), 0) s FROM orders
    WHERE user_id = ? AND payment_status = 'paid' AND paid_paise > 0 AND points_basis_paise > 0 AND status NOT IN ('cancelled','returned') AND ${doneSql} AND created_at >= ? AND created_at < ?`)
    .bind(userId, mem.purchased_at, mem.expires_at).first();
  return Math.floor(Number(r.s) || 0);
}
// The term in force now (a renewal bought early starts when the current term ends, so it is not 'current' yet).
async function currentMembership(db, userId, now = nowS()) {
  return db.prepare("SELECT id,purchased_at,expires_at,price_paid,status FROM memberships WHERE user_id=? AND status='active' AND expires_at>? ORDER BY expires_at ASC LIMIT 1").bind(userId, now).first();
}
// Awards each milestone once per membership year; with clawback on, takes it back (never below a zero balance) if refunds drop the spend under it.
async function reconcileUser(db, userId, s) {
  const st = s || (await loadSettings(db));
  if (!st.live) return;
  const mem = await currentMembership(db, userId);
  if (!mem) return;
  const spend = await milestoneSpend(db, userId, mem, st);
  const { results: ms } = await db.prepare("SELECT id,label,threshold_paise,bonus_points FROM reward_milestones WHERE active=1 ORDER BY threshold_paise").all();
  for (const m of ms) {
    const key = `ms:${m.id}:${mem.id}`, had = await db.prepare("SELECT points FROM points_ledger WHERE idem_key=?").bind(key).first();
    if (spend >= m.threshold_paise && !had) {
      await db.prepare("INSERT OR IGNORE INTO points_ledger (id,user_id,kind,points,ref,expires_at,idem_key,reason) VALUES (?,?,'bonus',?,?,?,?,?)")
        .bind(crypto.randomUUID(), userId, m.bonus_points, m.id, nowS() + st.validDays * DAY, key, `milestone ${m.label || m.id}`).run();
    } else if (spend < m.threshold_paise && had && st.clawback) {
      const take = Math.min(had.points, (await balance(db, userId)).available);
      if (take > 0) await db.prepare("INSERT OR IGNORE INTO points_ledger (id,user_id,kind,points,ref,idem_key,reason) VALUES (?,?,'bonus_reverse',?,?,?,?)")
        .bind(crypto.randomUUID(), userId, -take, m.id, `msrev:${m.id}:${mem.id}`, "refund reduced eligible spend below milestone").run();
    }
  }
}

// ── Customer summary (dashboard) ─────────────────────────────────────────────────────────────────────────────
async function summary(db, userId, s) {
  const st = s || (await loadSettings(db)), now = nowS();
  const [bal, mem, tot, pend, sav, fee, last] = await Promise.all([
    balance(db, userId, now), currentMembership(db, userId, now),
    db.prepare(`SELECT coalesce(sum(CASE WHEN kind IN ('earn','restore') THEN points END),0) earned, coalesce(sum(CASE WHEN kind='bonus' THEN points END),0) bonus,
        coalesce(-sum(CASE WHEN kind='redeem' THEN points END),0) redeemed, coalesce(-sum(CASE WHEN kind='expire' THEN points END),0) expired,
        coalesce(-sum(CASE WHEN kind IN ('reverse','bonus_reverse') THEN points END),0) reversed FROM points_ledger WHERE user_id=?`).bind(userId).first(),
    db.prepare(`SELECT points_basis_paise b, paid_paise p, refunded_paise r FROM orders WHERE user_id=? AND points_basis_paise>0 AND payment_status='paid' AND paid_paise>0
        AND status NOT IN ('cancelled','returned','delivered')`).bind(userId).all(),
    db.prepare(`SELECT coalesce(sum(member_saving_paise * (paid_paise - min(refunded_paise, paid_paise)) / paid_paise),0) member_savings, coalesce(sum(points_discount_paise * (paid_paise - min(refunded_paise, paid_paise)) / paid_paise),0) redeemed_value,
        coalesce(sum(CASE WHEN points_basis_paise>0 THEN points_basis_paise * (paid_paise - min(refunded_paise, paid_paise)) / paid_paise END),0) eligible_spend, count(*) orders
        FROM orders WHERE user_id=? AND payment_status='paid' AND paid_paise>0 AND status NOT IN ('cancelled','returned')`).bind(userId).first(),
    db.prepare("SELECT coalesce(sum(price_paid),0) fee FROM memberships WHERE user_id=? AND status IN ('active','expired')").bind(userId).first(),
    db.prepare("SELECT max(expires_at) expires_at FROM memberships WHERE user_id=? AND status IN ('active','expired')").bind(userId).first(),
  ]);
  const pending = st.earnOn === "paid" ? 0 : pend.results.reduce((a, o) => a + Math.floor((o.b * (o.p - Math.min(o.r, o.p)) * st.earnPer100) / (o.p * 10000)), 0);
  const memberSavings = Math.round(sav.member_savings), redeemedValue = Math.round(sav.redeemed_value);
  let spend = 0, ladder = [];
  if (mem) {
    spend = await milestoneSpend(db, userId, mem, st);
    const { results } = await db.prepare("SELECT id,label,threshold_paise,bonus_points FROM reward_milestones WHERE active=1 ORDER BY threshold_paise").all();
    const got = new Set((await db.prepare("SELECT idem_key k FROM points_ledger WHERE user_id=? AND kind='bonus' AND idem_key LIKE ?").bind(userId, `ms:%:${mem.id}`).all()).results.map((r) => r.k));
    ladder = results.map((m) => ({ id: m.id, label: m.label, thresholdPaise: m.threshold_paise, bonusPoints: m.bonus_points, reached: spend >= m.threshold_paise, awarded: got.has(`ms:${m.id}:${mem.id}`) }));
  }
  const next = ladder.find((m) => !m.reached) || null;
  return {
    live: st.live, membership: mem ? { active: true, since: mem.purchased_at, expiresAt: Math.max(mem.expires_at, last ? last.expires_at : 0), termEndsAt: mem.expires_at, feePaid: mem.price_paid } : { active: false, lastExpiry: last ? last.expires_at : null },
    wallet: { availablePoints: bal.available, pendingPoints: pending, expiringSoon: bal.expiring30, owedPoints: bal.owed, valuePaise: st.valuePaise, earnedPoints: tot.earned, bonusPoints: tot.bonus, redeemedPoints: tot.redeemed, expiredPoints: tot.expired, reversedPoints: tot.reversed },
    value: { memberPriceSavingsPaise: memberSavings, redeemedValuePaise: redeemedValue, feePaidPaise: fee.fee, netRealizedPaise: memberSavings + redeemedValue - fee.fee, pendingPointsValuePaise: pending * st.valuePaise, eligibleSpendPaise: Math.round(sav.eligible_spend) },
    milestones: { spendPaise: spend, ladder, next: next ? { ...next, remainingPaise: next.thresholdPaise - spend } : null },
  };
}

async function activity(db, userId, before, limit = 30) {
  const { results } = await db.prepare(`SELECT l.id,l.kind,l.points,l.order_id,l.expires_at,l.reason,l.created_at FROM points_ledger l
    WHERE l.user_id=? AND l.kind <> 'reserve' AND l.created_at < ? ORDER BY l.created_at DESC, l.rowid DESC LIMIT ?`).bind(userId, before || nowS() + 1, Math.min(limit, 100) + 1).all();
  const more = results.length > limit;
  return { entries: results.slice(0, limit).map((r) => ({ ...r, order_ref: r.order_id ? r.order_id.slice(0, 8) : null })), more };
}

module.exports = { RESERVE_TTL, settingsFrom, loadSettings, validateSettings, balance, sweepExpiry, planRedemption, reserve, reconcileOrder, reconcileUser, currentMembership, milestoneSpend, summary, activity };
