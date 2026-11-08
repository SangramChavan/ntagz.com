# What is live (updated 2026-11-08)

| Surface | State | Version / evidence |
|---|---|---|
| `ntagz.com` (store) | GitHub Pages, **unchanged** | cutover to Cloudflare not done (see CUTOVER-PLAN.md) |
| `ntagz.com/api/*` (`ntagz-payments`) | **unchanged** | last deployed 2026-11-02 |
| `admin.ntagz.com` (`ntagz-admin`) | **redeployed** from main `3bb977a`: Partners screen, document access (`KYC` binding), partner emails sender + cron flush. Also ships the earlier-merged "required shipment email updates" (2026-11-06) | version `cf775972-bda6-4263-894b-e01eb2425fad`; previous `7cfb6ef2-0fb5-4fe3-a622-7ba45522a04d` |
| `partner.ntagz.com` (`ntagz-partner`) | **new, live**: portal + `/api/v1`. **Sign-in does not work until `RESEND_API_KEY` is set** (codes are emailed) | version `0c4a2ff3-26e3-4245-a0a8-c0e229c85d16` |
| D1 `ntagz-db` | migrations **0021-0024 applied** (additive) | restore point taken before: `00000ffb-00000000-0000511d-9719831917229bc604491415106a07a2` |
| R2 `ntagz-kyc` | created, **private** (r2.dev disabled, no custom domain) | empty |

## Secrets on `ntagz-partner`
- `PAN_HASH_SECRET`: set (random, generated and uploaded directly; it cannot be read back). If it is ever replaced after real applications exist, duplicate-PAN detection stops matching older records. No real application existed when it was set.
- `RESEND_API_KEY`: **not set yet (owner)**. Command, run in your own terminal (paste the key when prompted; never in chat):
  `npx wrangler secret put RESEND_API_KEY --name ntagz-partner`

## Optional settings
`HQ_NOTIFY_EMAILS` (inboxes for "new partner application"), `PARTNER_URL`, `ADMIN_URL`. Without `HQ_NOTIFY_EMAILS` HQ gets no email; they still see applications in admin > Partners.

## Rollback
- Admin: `cd admin && npx wrangler rollback 7cfb6ef2-0fb5-4fe3-a622-7ba45522a04d` (the 0021-0024 tables stay; the old code ignores them).
- Partner portal: `npx wrangler delete --name ntagz-partner` removes the Worker and its domain. Nothing else depends on it.
- Data: migrations are additive. Use the D1 restore point only for data loss: `npx wrangler d1 time-travel restore ntagz-db --bookmark=00000ffb-00000000-0000511d-9719831917229bc604491415106a07a2` (this would also discard orders placed after it, so avoid).

## First-use checklist for the owner
1. Set `RESEND_API_KEY` on `ntagz-partner` (above), then sign in at https://partner.ntagz.com with your own email and complete a test application.
2. Sign in at https://admin.ntagz.com > Partners: review, approve, record the agreement and fee, activate. Check the emails arrive (delivery to a real inbox has not been tested yet).
3. Set `HQ_NOTIFY_EMAILS` if you want new-application notices.
4. Decide the open commercial points (GST wording for partner fees, refund policy, TDS) before inviting real partners; the portal shows fees as proposed and says taxes "as applicable".
