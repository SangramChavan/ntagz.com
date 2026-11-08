# Environment variables, secrets and bindings

Names only. **Values are never committed and never pasted into chat.** Secrets are set with `wrangler secret put <NAME> --name <worker>`; local development values live in gitignored `.dev.vars` files.

## Worker `ntagz-payments` (`ntagz.com/api/*`, existing)
| Name | Kind | Purpose |
|---|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | secret | Razorpay orders, signature checks, webhook |
| `PAYU_KEY`, `PAYU_SALT` | secret | PayU hashes and verification |
| `PAYU_ENV` | var | `production` (in `wrangler.payment.toml`) |
| `RESEND_API_KEY` | secret | Customer OTP and marketing email |
| `UNSUB_SECRET` | secret | Unsubscribe token signing |
| `MARKETING_FROM`, `MARKETING_SEND_ENABLED`, `MARKETING_POSTAL_ADDRESS`, `PAYU_FALLBACK_EMAIL` | optional | Marketing and fallbacks |
| `DB` | D1 binding | `ntagz-db` |

## Worker `ntagz-admin` (`admin.ntagz.com`, existing, extended)
| Name | Kind | Purpose |
|---|---|---|
| `ADMIN_EMAILS` | secret | Allowlist of admin emails (maps to `hq_admin` for the partner screens until staff roles move to the unified identity) |
| `RESEND_API_KEY` | secret | Admin OTP, order notifications, **partner emails (outbox sender)** |
| `RESEND_WEBHOOK_SECRET`, `UNSUB_SECRET`, `CRM_VIEW_EMAILS`, `CRM_MANAGE_EMAILS`, `CRM_EXPORT_EMAILS`, `CRM_SEND_EMAILS`, `MARKETING_*` | secret / optional | CRM |
| `HQ_NOTIFY_EMAILS` | var or secret, **new** | Comma-separated HQ inboxes that get "new partner application". Empty = no HQ notices |
| `PARTNER_URL`, `ADMIN_URL` | var, **new, optional** | Base URLs used in email links. Must be `https`; default `https://partner.ntagz.com` and `https://admin.ntagz.com`. Use for staging |
| `KYC` | R2 binding, **not yet added** | Private bucket `ntagz-kyc`; add together with the bucket (see TASKS) |
| `DEV_OTP_ECHO`, `DEV_NOTIFY_ECHO` | local only | Return OTP/notice in the response. **Never set in production** |
| `DB`, `ASSETS` | bindings | D1 and static assets |

## Worker `ntagz-partner` (`partner.ntagz.com`, not deployed)
| Name | Kind | Purpose |
|---|---|---|
| `PAN_HASH_SECRET` | secret, **required** | Keyed hash of PAN for duplicate detection. Losing or changing it breaks duplicate checks for existing records |
| `RESEND_API_KEY` | secret | Partner login codes, applicant emails |
| `HQ_NOTIFY_EMAILS`, `PARTNER_URL`, `ADMIN_URL` | var, optional | As above |
| `DEV_OTP_ECHO` | local only | **Never set in production** |
| `OTP_IP_LIMIT` | var, optional | Sign-in codes allowed per IP per 15 minutes. Default 10. Raised only on the local browser-test servers (they share one IP). Do not raise it in production |
| `DB` | D1 binding | `ntagz-db` (shared) |
| `KYC` | R2 binding | Private bucket `ntagz-kyc` (no public access, no custom domain) |
| `ASSETS` | binding | Built portal from `apps/partner-portal/dist` |

## Worker `ntagz-site` (static site, staging only)
No variables. Assets from `dist/` built by `npm run build:static`.

## CI / deploy (not set up)
A scoped Cloudflare API token (Workers edit for this account, zone-limited routes) as a GitHub secret. Created by the owner, never by the agent.

## Email behaviour to know before enabling
- Without `RESEND_API_KEY` the outbox marks messages `skipped` ("email not configured") and does not retry them. Messages queued before a key exists are **not** sent later.
- Retries: 1, 5, 30, 120 and 360 minutes after each failed attempt, then `failed`. Client errors (4xx except 408/429) fail at once.
- Delivery to a real inbox has **not** been tested yet: tests use a mocked provider. Verify with one real message after the key is set.
