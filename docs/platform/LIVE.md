# What is live (updated 2026-11-08, quotations and quote-to-payment deployed)

| Surface | State | Version / evidence |
|---|---|---|
| `ntagz.com` (store) | GitHub Pages, **unchanged** | cutover to Cloudflare not done (see CUTOVER-PLAN.md) |
| `ntagz.com/api/*` (`ntagz-payments`) | **unchanged** | last deployed 2026-11-02 |
| `admin.ntagz.com` (`ntagz-admin`) | **redeployed** from main `703d94b`: Partners screen, Leads tab, **Quotes tab (approval queue, payment link from an accepted quote)**, document access (`KYC` binding), partner emails sender + cron flush. Also shipped the earlier-merged "required shipment email updates" (2026-11-06) in the first redeploy | version `35943468-88b3-41d7-95ce-ed86c6cdeee3`; previous `c27c23e0-3b0a-4170-898e-e3e5c001ddf6`, then `cf775972-bda6-4263-894b-e01eb2425fad`, and before the partner platform `7cfb6ef2-0fb5-4fe3-a622-7ba45522a04d` |
| `partner.ntagz.com` (`ntagz-partner`) | **live**: portal (now with Leads and **Quotes**) + `/api/v1`. Both secrets set | version `79b1f28d-5c22-46f9-b020-706638abd4e3`; previous `34d91dbe-b1e6-4963-b6ac-a0f038b3c096`, then `62d2ca15-a8f6-42e9-9c5f-dbd883b2ad25` |
| D1 `ntagz-db` | migrations **0021-0027 applied** (additive) | restore points taken before: 0021-0024 `00000ffb-00000000-0000511d-9719831917229bc604491415106a07a2`; 0025 `0000102b-0000000a-0000511d-bf00158086e0d399718caa269bbaea0e`; 0026-0027 `0000103d-00000000-0000511d-fca29c602c56202edb4a221da6f83c6a` |
| R2 `ntagz-kyc` | created, **private** (r2.dev disabled, no custom domain) | empty |

## Secrets on `ntagz-partner`
- `RESEND_API_KEY`: set by the owner (confirmed present 2026-11-08).
- `PAN_HASH_SECRET`: set (random, generated and uploaded directly; it cannot be read back). If it is ever replaced after real applications exist, duplicate-PAN detection stops matching older records. No real application existed when it was set.

## Optional settings
`HQ_NOTIFY_EMAILS` (inboxes for "new partner application"), `PARTNER_URL`, `ADMIN_URL`. Without `HQ_NOTIFY_EMAILS` HQ gets no email; they still see applications in admin > Partners.

## Commissions (deployed 2026-11-08)
- Migration 0028 applied to production D1. Restore point taken before it: `00001043-00000000-0000511d-7d977d963601f3f86a4c3219477ae913`.
- `ntagz-admin` version `64408e48-d56c-49a0-aba7-dcb0d92ca8e2`; `ntagz-partner` version `7932f13e-f2d6-48e7-a58c-993fe993f064`.
- Smoke test signed out: partner and admin commission APIs answer 401, admin script is not served (404). Not yet exercised with a real signed-in session.
- No commission rules or TDS rate exist, so nothing is earned until HQ adds a rule in admin > Commissions > Terms.
- Rollback: admin `cd admin && npx wrangler rollback 35943468-88b3-41d7-95ce-ed86c6cdeee3`; partner `npx wrangler rollback 79b1f28d-5c22-46f9-b020-706638abd4e3 --name ntagz-partner`. The new tables stay and older code ignores them.

## Partner page and opening-stock-order wording (deployed 2026-11-08)
- Public page https://ntagz.com/partner/ is live on GitHub Pages (PR #61).
- `ntagz-admin` version `08af91ec-461c-4422-9419-b2099f235b9a`; `ntagz-partner` version `7bb5769e-797c-4e03-9d24-eecb84dc13fe`. No migration.
- Smoke test: the live portal bundle says "Opening stock order" and no longer contains "Joining fee"; the partner API and the admin both answer 200.
- Rollback to the commissions release: admin `cd admin && npx wrangler rollback 64408e48-d56c-49a0-aba7-dcb0d92ca8e2`; partner `npx wrangler rollback 7932f13e-f2d6-48e7-a58c-993fe993f064 --name ntagz-partner`.

## Partner page v2 (released 2026-11-08, PR #62)
- https://ntagz.com/partner/ v2 is live on GitHub Pages. Plan amounts load live from `partner.ntagz.com/api/v1/partner/types`, which allows only `https://ntagz.com` and `https://www.ntagz.com` cross-origin, with a 5-minute cache.
- `ntagz-partner` version `f374688e-5819-40b0-834c-3d5c44281f5a` (CORS on the plan list, `?plan=` pre-selects the wizard); `ntagz-admin` version `1a0c0311-db92-4815-a297-310489961bbf`.
- `ntagz-payments` version `9074fef7-64be-4f91-acba-b75e21a26af2`, deployed from the **previously live commit `8749d3c` plus only the partner-event allowlist in `functions/lib/crm.js`**. Main's undeployed PR #35 change was deliberately **not** shipped: it removes `GET /api/accounts/addresses`, which `account/index.html` still calls. Fix that before the next payments deploy from main.
- Analytics: the seven `partner_*` events are accepted, but first-party tracking is switched **off** in settings (`/api/ev/config` answers `enabled:false`), so nothing is recorded until the owner turns it on and visitors consent.
- Rollback: partner `npx wrangler rollback 7bb5769e-797c-4e03-9d24-eecb84dc13fe --name ntagz-partner`; admin `cd admin && npx wrangler rollback 08af91ec-461c-4422-9419-b2099f235b9a`; payments `npx wrangler rollback f7d7c68c-0915-4ed8-ba7a-e08e072cb7ea -c wrangler.payment.toml`. Page: revert PR #62.

## Wholesale and stock credit (deployed 2026-11-08, PR #65)
- Migrations 0029 and 0030 applied to production D1. Restore point taken before: `00001061-00000000-0000511d-9c3a1421a92ceb6b3c981c60b2f9f4f9`.
- `ntagz-admin` `afa33e18-515e-4b46-aef2-dc5fd2f3bf38`; `ntagz-partner` `91a83274-229b-4196-a822-066a077b1616`; `ntagz-payments` `524c3298-f3ea-4e35-be72-f512658e7e05` (from main `db0198b`).
- Smoke test signed out: wholesale partner and admin APIs answer 401, admin script 404, portal bundle contains the Wholesale page. Not yet exercised signed in.
- Nothing is seeded: partners get no wholesale price until HQ sets a band per type, the minimum margin (admin > Wholesale) and product costs (admin > Products).
- Rollback: admin `cd admin && npx wrangler rollback 1a0c0311-db92-4815-a297-310489961bbf`; partner `npx wrangler rollback f374688e-5819-40b0-834c-3d5c44281f5a --name ntagz-partner`; payments `npx wrangler rollback 9074fef7-64be-4f91-acba-b75e21a26af2 -c wrangler.payment.toml`. New tables/columns stay; older code ignores them.

## Rollback
- Admin back one step (without Quotes): `cd admin && npx wrangler rollback c27c23e0-3b0a-4170-898e-e3e5c001ddf6` (the new tables stay; older code ignores them). Further back: `cf775972-bda6-4263-894b-e01eb2425fad` (without Leads), `7cfb6ef2-0fb5-4fe3-a622-7ba45522a04d` (before the partner platform).
- Partner portal back one step (without Quotes): `npx wrangler rollback 34d91dbe-b1e6-4963-b6ac-a0f038b3c096 --name ntagz-partner`. Further back: `62d2ca15-a8f6-42e9-9c5f-dbd883b2ad25` (without Leads).
- Partner portal: `npx wrangler delete --name ntagz-partner` removes the Worker and its domain. Nothing else depends on it.
- Data: migrations are additive. Use a D1 restore point only for data loss (it would also discard orders placed after it, so avoid): `npx wrangler d1 time-travel restore ntagz-db --bookmark=<bookmark above>`.

## First-use checklist for the owner
1. Set `RESEND_API_KEY` on `ntagz-partner` (above), then sign in at https://partner.ntagz.com with your own email and complete a test application.
2. Sign in at https://admin.ntagz.com > Partners: review, approve, record the agreement and fee, activate. Check the emails arrive (delivery to a real inbox has not been tested yet).
3. Set `HQ_NOTIFY_EMAILS` if you want new-application notices.
4. Decide the open commercial points (GST wording for partner fees, refund policy, TDS) before inviting real partners; the portal shows fees as proposed and says taxes "as applicable".
