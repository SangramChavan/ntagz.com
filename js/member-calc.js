/* ntagz membership savings estimate. Pure (no DOM), shared by /membership/ and the tests, which compare it with the real pricing engine
   (functions/lib/pricing.js) and the points rules (functions/lib/points.js). Inputs/outputs are rupees; points are whole numbers.
   c = { pct, fee, pts: { earnPer100, value, maxRedeemPct, minOrder, tiers: [{ minSpend, pointsPer100 }] ascending } | null }
   Points accrue at the flat rate until qualifying spend reaches the first tier, then at each tier's rate (qualifying spend counts from the
   first order, so a returning customer already sits higher; this estimate starts from zero and is therefore cautious). */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NTAGZ_CALC = api.calc;
})(this, function () {
  function earnedRaw(spend, pts) {
    var tiers = pts.tiers || [], rate = pts.earnPer100, from = 0, total = 0, top = rate;
    for (var i = 0; i <= tiers.length; i++) {
      var to = i < tiers.length ? tiers[i].minSpend : Infinity;
      if (spend > from) total += (Math.min(spend, to) - from) * rate / 100;
      if (i < tiers.length) { from = tiers[i].minSpend; rate = tiers[i].pointsPer100; if (spend >= from) top = rate; }
    }
    return { points: total, topRate: top };
  }
  function calc(i, c) {
    var cl = function (v, lo, hi) { v = Number(v); if (!isFinite(v)) v = 0; return Math.min(Math.max(v, lo), hi); };
    var V = cl(i.order, 0, 1e7), N = Math.floor(cl(i.count, 0, 365)), share = cl(i.share, 0, 100), use = cl(i.use, 0, 100);
    var annual = V * N, eligible = annual * share / 100, savings = eligible * c.pct / 100;
    var perOrder = V - V * share / 100 * c.pct / 100;                       // what an order costs at member prices (basis for points)
    var r = { annual: annual, eligible: eligible, savings: savings, earned: 0, used: 0, usedValue: 0, unused: 0, fee: c.fee, rate: null, perRupee: share / 100 * c.pct / 100 };
    if (c.pts && perOrder > 0 && perOrder >= c.pts.minOrder) {
      var e = earnedRaw(perOrder * N, c.pts);
      r.earned = Math.floor(e.points); r.rate = e.topRate;
      var cap = Math.floor(perOrder * N * c.pts.maxRedeemPct / 100 / c.pts.value);   // per-order redemption ceiling, summed over the year
      r.used = Math.min(Math.floor(r.earned * use / 100), cap);
      r.usedValue = r.used * c.pts.value; r.unused = r.earned - r.used;
      if (annual > 0) r.perRupee += (e.points / annual) * (use / 100) * c.pts.value;   // rewards value per rupee of gross spend at these habits
    }
    r.net = r.savings + r.usedValue - c.fee;
    r.breakEven = r.perRupee > 0 ? c.fee / r.perRupee : null;
    return r;
  }
  return { calc: calc, earnedRaw: earnedRaw };
});
