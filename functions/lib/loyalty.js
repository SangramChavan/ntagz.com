// ntagz spending tiers (loyalty). Shared by the payments Worker and the admin Worker.
//
// Source of truth: a customer's qualifying spend is DERIVED from the orders table, never kept as a running counter, so it cannot
// drift or count an order twice:
//   spend = sum over the customer's orders that are paid and not cancelled/returned of
//             qualifying_paise x (paid - refunded) / paid        (qualifying = net of discounts, without GST and shipping,
//                                                                 frozen on the order when it was created)
//         + audited manual adjustments (loyalty_adjustments).
// The tier is the highest active tier whose threshold the spend reaches. users.loyalty_tier_id and loyalty_tier_log are a persisted
// record of tier changes (for history); prices always use the freshly derived tier, so a stale cache can never grant a discount.

const SPEND_SQL = `SELECT coalesce(sum(qualifying_paise * (paid_paise - min(refunded_paise, paid_paise)) / paid_paise), 0) AS s
  FROM orders WHERE user_id = ?1 AND payment_status = 'paid' AND paid_paise > 0 AND status NOT IN ('cancelled', 'returned')`;
const ADJ_SQL = "SELECT coalesce(sum(delta_paise), 0) AS s FROM loyalty_adjustments WHERE user_id = ?1";

let tiersCache = { db: null, at: 0, tiers: null };
const resetTiersCache = () => { tiersCache = { db: null, at: 0, tiers: null }; };

// Active tiers by ascending threshold. Cached 30s per isolate; an admin change shows up within that window.
async function loadTiers(db) {
  const now = Date.now();
  if (tiersCache.db === db && now - tiersCache.at < 30000 && tiersCache.tiers) return tiersCache.tiers;
  const { results } = await db.prepare("SELECT id,name,min_spend_paise,discount_pct,sort_order,perks FROM loyalty_tiers WHERE active=1 ORDER BY min_spend_paise, sort_order").all();
  tiersCache = { db, at: now, tiers: results };
  return results;
}

const tierFor = (spend, tiers) => { let t = null; for (const x of tiers) if (spend >= x.min_spend_paise) t = x; return t; };
const nextTierFor = (spend, tiers) => tiers.find((x) => x.min_spend_paise > spend) || null;

async function spendOf(db, userId) {
  const [o, a] = await Promise.all([db.prepare(SPEND_SQL).bind(userId).first(), db.prepare(ADJ_SQL).bind(userId).first()]);
  return Math.max(0, Math.round(Number(o && o.s) || 0) + (Number(a && a.s) || 0));
}

// {spend, tier, next, remaining, pct}: pct is the discount this customer's tier currently earns (0 when loyalty is off).
async function loyaltyContext(db, userId, settings) {
  const [spend, tiers] = await Promise.all([spendOf(db, userId), loadTiers(db)]);
  const tier = tierFor(spend, tiers), next = nextTierFor(spend, tiers);
  const live = !!(settings && settings.loyaltyLive);
  return { spend, tier, next, remaining: next ? next.min_spend_paise - spend : 0, live, pct: live && tier ? Number(tier.discount_pct) || 0 : 0 };
}

// Persist a tier change (and why). Safe to call any time; writes only when the derived tier differs from the stored one.
async function syncTier(db, userId, reason) {
  const ctx = await loyaltyContext(db, userId, { loyaltyLive: false });
  const cur = await db.prepare("SELECT loyalty_tier_id t FROM users WHERE id=?").bind(userId).first();
  if (!cur) return { changed: false, ctx };
  const was = cur.t || null, now = ctx.tier ? ctx.tier.id : null;
  if (was === now) return { changed: false, ctx };
  await db.batch([
    db.prepare("UPDATE users SET loyalty_tier_id=? WHERE id=? AND coalesce(loyalty_tier_id,'')=?").bind(now, userId, was || ""),
    db.prepare("INSERT INTO loyalty_tier_log (id,user_id,from_tier,to_tier,spend_paise,reason) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(), userId, was, now, ctx.spend, String(reason || "recalculated").slice(0, 200)),
  ]);
  return { changed: true, from: was, to: now, ctx };
}

// Validates an admin tier list. Returns {errors, tiers}. Thresholds must start at 0 and strictly increase; discounts must not fall.
function validateTiers(list) {
  const errors = [];
  if (!Array.isArray(list) || list.length < 1 || list.length > 12) return { errors: ["Provide between 1 and 12 tiers"], tiers: [] };
  const tiers = list.map((t, i) => ({
    id: typeof t.id === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(t.id) ? t.id : null,
    name: typeof t.name === "string" ? t.name.trim() : "",
    min_spend_paise: Number.isSafeInteger(t.min_spend_paise) ? t.min_spend_paise : null,
    discount_pct: typeof t.discount_pct === "number" && Number.isFinite(t.discount_pct) ? Math.round(t.discount_pct * 100) / 100 : null,
    active: t.active === false || t.active === 0 ? 0 : 1,
    perks: typeof t.perks === "string" ? t.perks.trim().slice(0, 300) : "",
    sort_order: i,
  }));
  const seen = new Set();
  tiers.forEach((t, i) => {
    const at = `Tier ${i + 1}`;
    if (!t.id) errors.push(`${at}: invalid id`); else if (seen.has(t.id)) errors.push(`${at}: duplicate id`); else seen.add(t.id);
    if (t.name.length < 2 || t.name.length > 30) errors.push(`${at}: name must be 2–30 characters`);
    if (t.min_spend_paise === null || t.min_spend_paise < 0 || t.min_spend_paise > 100_000_000_00) errors.push(`${at}: threshold must be a whole number of paise, 0 or more`);
    if (t.discount_pct === null || t.discount_pct < 0 || t.discount_pct > 50) errors.push(`${at}: discount must be 0–50%`);
  });
  const act = tiers.filter((t) => t.active);
  if (!act.length || act[0].min_spend_paise !== 0) errors.push("The lowest active tier must start at ₹0 so every customer has a tier");
  for (let i = 1; i < act.length; i++) {
    if (act[i].min_spend_paise <= act[i - 1].min_spend_paise) errors.push(`${act[i].name}: threshold must be higher than ${act[i - 1].name}`);
    if (act[i].discount_pct < act[i - 1].discount_pct) errors.push(`${act[i].name}: discount must not be lower than ${act[i - 1].name}`);
  }
  return { errors, tiers };
}

module.exports = { SPEND_SQL, ADJ_SQL, loadTiers, resetTiersCache, tierFor, nextTierFor, spendOf, loyaltyContext, syncTier, validateTiers };
