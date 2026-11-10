// Admin order edit: the recompute must reproduce what checkout stored, and the gate must refuse anything that has money on it.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  const { recompute, whyNotEditable } = await import(pathToFileURL(path.join(__dirname, "../src/order-edit.js")).href);
  const none = new Set();
  // Real orders (see production): 10 x NFC ring at Rs 399 -> 399000 / 71800 / 470800; one sample kit at Rs 2328 -> 232800 / 41900 / 274700.
  let r = recompute({ shipping_paise: 0 }, [{ id: "nfc-ring-black-10", qty: 10 }], [{ qty: 10, unit_paise: 39900 }], none, 18);
  assert.deepEqual([r.subtotal, r.gst, r.total], [399000, 71800, 470800]);
  r = recompute({ shipping_paise: 0 }, [{ id: "sample-kit", qty: 1 }], [{ qty: 1, unit_paise: 232800 }], none, 18);
  assert.deepEqual([r.subtotal, r.gst, r.total], [232800, 41900, 274700]);
  assert.equal(r.items[0].unit_paise, 232800); // the override is kept on the line

  // Shipping is kept and included in subtotal (subtotal = total - gst); a cheaper price lowers the total.
  r = recompute({ shipping_paise: 8000 }, [{ id: "a", qty: 10 }], [{ qty: 10, unit_paise: 3000 }], none, 18);
  assert.deepEqual([r.gst, r.total, r.subtotal], [5400, 43400, 38000]);

  // All-inclusive lines carry their own GST: no GST added, qualifying value strips it.
  r = recompute({ shipping_paise: 0 }, [{ id: "k", qty: 1 }], [{ qty: 1, unit_paise: 11800 }], new Set(["k"]), 18);
  assert.deepEqual([r.gst, r.total, r.qualifying], [0, 11800, 10000]);

  // Reward-point basis scales with the net value; the new total is bounded.
  r = recompute({ shipping_paise: 0, points_basis_paise: 1000, qualifying_paise: 2000 }, [{ id: "a", qty: 1 }], [{ qty: 1, unit_paise: 4000 }], none, 18);
  assert.equal(r.pointsBasis, 2000);
  assert.ok(recompute({ shipping_paise: 0 }, [{ id: "a", qty: 1 }], [{ qty: 1, unit_paise: 1 }], none, 18).error);

  // Gate: only an unpaid, unshipped, offline domestic order with nothing attached.
  const ok = { payment_method: "whatsapp", payment_status: "unpaid", paid_paise: 0, refunded_paise: 0, status: "confirmed", market: "IN" };
  assert.equal(whyNotEditable(ok), null);
  for (const bad of [{ market: "INTL" }, { partner_id: "p1" }, { payment_method: "razorpay" }, { payment_status: "paid" }, { paid_paise: 100 }, { refunded_paise: 1 },
    { points_redeemed: 5 }, { pay_link_url: "https://x" }, { status: "packed" }, { status: "shipped" }, { status: "cancelled" }]) {
    assert.ok(whyNotEditable({ ...ok, ...bad }), JSON.stringify(bad));
  }
  console.log("ok order edit: recompute matches stored orders, gate refuses paid/shipped/intl/partner");
})().catch((e) => { console.error(e); process.exit(1); });
