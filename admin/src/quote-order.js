// Turns an ACCEPTED quotation into a payment link (the existing pay_links tool; the payments Worker prices and collects, so checkout stays the price
// authority). HQ supplies the delivery address; name, phone, email, state and the lines come from the quotation. The link's `quoted_paise` is set to the
// quotation total, so the customer's page says so if prices moved since the quote. Admin-only: platform-core (shared with the partner Worker) does not call this.
import { create as createPayLink } from "./paylinks.js";
import { accessForRoles, requirePermission, AppError, ok, fail } from "../../packages/platform-core/src/index.js";
import { payLinkState, PAY_BASE } from "../../packages/platform-core/src/quotes.js";
import { auditStmt } from "../../packages/platform-core/src/audit.js";

export async function quotePaymentLink(env, actor, quoteId, body) {
  const requestId = crypto.randomUUID();
  try {
    const access = await accessForRoles(env.DB, actor, ["hq_admin"]);
    if (requirePermission(access, "quotes.approve") !== "all") throw new AppError("NOT_FOUND", "Not found");
    const q = await env.DB.prepare("SELECT * FROM quotations WHERE id = ? AND status != 'draft'").bind(String(quoteId)).first();
    if (!q) throw new AppError("NOT_FOUND", "Not found");
    if (q.status !== "accepted") throw new AppError("CONFLICT", "A payment link can only be made for a quotation the customer accepted");
    if (q.pay_link_id) {
      const st = await payLinkState(env.DB, q.pay_link_id);
      if (st && !["cancelled", "expired"].includes(st.status)) throw new AppError("CONFLICT", st.status === "paid" ? "This quotation has already been paid" : "A payment link is already open for this quotation. Cancel it, or wait for it to expire, before making another");
    }
    const lines = (await env.DB.prepare("SELECT product_id, qty FROM quotation_items WHERE quotation_id = ? ORDER BY position").bind(q.id).all()).results.map((i) => ({ id: i.product_id, qty: i.qty }));
    const b = body && typeof body === "object" ? body : {};
    const res = await createPayLink({
      env, actor, fail: (status, error) => ({ status, data: { error } }), json: (data, status = 200) => ({ status, data }),
      body: { name: q.customer_name, phone: q.customer_phone, email: q.customer_email || "", address: b.address, pincode: b.pincode, state: b.state || q.ship_state, gstin: b.gstin, note: `Quotation ${q.number}`, expires_in_hours: b.expiresInHours, items: lines },
    });
    if (res.status !== 201) {
      if (res.status === 400) throw new AppError("VALIDATION_FAILED", res.data.error || "Please fix the highlighted fields", res.data.fields);
      throw new AppError(res.status === 409 ? "CONFLICT" : "INTERNAL", res.data && res.data.error);
    }
    const id = res.data.id;
    await env.DB.batch([
      env.DB.prepare("UPDATE pay_links SET quoted_paise = ? WHERE id = ?").bind(q.total_paise, id),
      env.DB.prepare("UPDATE quotations SET pay_link_id = ?, updated_at = unixepoch() WHERE id = ?").bind(id, q.id),
      env.DB.prepare("INSERT INTO lead_activities (id, lead_id, actor, actor_kind, kind, body) VALUES (?, ?, ?, 'hq', 'note', ?)").bind(crypto.randomUUID(), q.lead_id, actor, `Payment link created for quotation ${q.number}`),
      auditStmt(env.DB, { actor, action: "quote.paylink", entityType: "quotation", entityId: q.id, after: { payLink: id.slice(0, 8), quotedPaise: q.total_paise } }),
    ]);
    return ok({ id, url: PAY_BASE + id, expiresAt: res.data.expires_at, quotedPaise: q.total_paise, currentPaise: res.data.est_paise, priceMoved: res.data.est_paise !== q.total_paise }, {}, 201);
  } catch (e) {
    if (!(e instanceof AppError)) console.error("quote payment link error", requestId, e && e.message);
    return fail(e, requestId);
  }
}
