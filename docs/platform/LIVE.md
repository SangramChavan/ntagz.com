# What is live (updated 2026-11-08, leads deployed)

| Surface | State | Version / evidence |
|---|---|---|
| `ntagz.com` (store) | GitHub Pages, **unchanged** | cutover to Cloudflare not done (see CUTOVER-PLAN.md) |
| `ntagz.com/api/*` (`ntagz-payments`) | **unchanged** | last deployed 2026-11-02 |
| `admin.ntagz.com` (`ntagz-admin`) | **redeployed** from main `3e238c7`: Partners screen, **Leads tab**, document access (`KYC` binding), partner emails sender + cron flush. Also shipped the earlier-merged "required shipment email updates" (2026-11-06) in the first redeploy | version `c27c23e0-3b0a-4170-898e-e3e5c001ddf6`; previous `cf775972-bda6-4263-894b-e01eb2425fad` (before that `7cfb6ef2-0fb5-4fe3-a622-7ba45522a04d`) |
| `partner.ntagz.com` (`ntagz-partner`) | **live**: portal (now with **Leads**) + `/api/v1`. Both secrets set | version `34d91dbe-b1e6-4963-b6ac-a0f038b3c096`; previous `62d2ca15-a8f6-42e9-9c5f-dbd883b2ad25` |
| D1 `ntagz-db` | migrations **0021-0025 applied** (additive) | restore points taken before: 0021-0024 `00000ffb-00000000-0000511d-9719831917229bc604491415106a07a2`; 0025 `0000102b-0000000a-0000511d-bf00158086e0d399718caa269bbaea0e` |
| R2 `ntagz-kyc` | created, **private** (r2.dev disabled, no custom domain) | empty |

## Secrets on `ntagz-partner`
- `RESEND_API_KEY`: set by the owner (confirmed present 2026-11-08).
- `PAN_HASH_SECRET`: set (random, generated and uploaded directly; it cannot be read back). If it is ever replaced after real applications exist, duplicate-PAN detection stops matching older records. No real application existed when it was set.

## Optional settings
`HQ_NOTIFY_EMAILS` (inboxes for "new partner application"), `PARTNER_URL`, `ADMIN_URL`. Without `HQ_NOTIFY_EMAILS` HQ gets no email; they still see applications in admin > Partners.

## Rollback
- Admin: `cd admin && npx wrangler rollback cf775972-bda6-4263-894b-e01eb2425fad` (the new tables stay; older code ignores them). To go back to before the partner platform: `7cfb6ef2-0fb5-4fe3-a622-7ba45522a04d`.
- Partner portal back one step (without Leads): `npx wrangler rollback 62d2ca15-a8f6-42e9-9c5f-dbd883b2ad25 --name ntagz-partner`.
- Partner portal: `npx wrangler delete --name ntagz-partner` removes the Worker and its domain. Nothing else depends on it.
- Data: migrations are additive. Use a D1 restore point only for data loss (it would also discard orders placed after it, so avoid): `npx wrangler d1 time-travel restore ntagz-db --bookmark=<bookmark above>`.

## First-use checklist for the owner
1. Set `RESEND_API_KEY` on `ntagz-partner` (above), then sign in at https://partner.ntagz.com with your own email and complete a test application.
2. Sign in at https://admin.ntagz.com > Partners: review, approve, record the agreement and fee, activate. Check the emails arrive (delivery to a real inbox has not been tested yet).
3. Set `HQ_NOTIFY_EMAILS` if you want new-application notices.
4. Decide the open commercial points (GST wording for partner fees, refund policy, TDS) before inviting real partners; the portal shows fees as proposed and says taxes "as applicable".
