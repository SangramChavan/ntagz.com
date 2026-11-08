# Partner portal (partner.ntagz.com)

Preact + TypeScript (Vite). Talks only to `/api/v1/*` on the same origin (Worker `ntagz-partner`, `workers/partner`).

Screens: sign in (email code), apply wizard (category, business, about you, capacity, documents, review), status timeline, active-partner dashboard.
The portal shows only what the API says; permissions are enforced on the server, never in this UI.

## Run locally (local D1 only)
1. `npm ci` in this folder, then `npm run build`.
2. Apply migrations to a local D1 (see `admin/README.md`), then from `workers/partner`:
   `printf 'DEV_OTP_ECHO=1\nPAN_HASH_SECRET=local-only\n' > .dev.vars` and
   `npx wrangler dev --local --port 8815 --persist-to ../../admin/.wrangler/state`.
   `DEV_OTP_ECHO=1` returns the sign-in code in the API response (never set it in production; the UI does not display it).
3. Open http://localhost:8815. For hot reload use `npm run dev` (proxies `/api` to port 8815).

## Checks
`npm test` (unit), `npm run typecheck`, `npm run build`. CI runs these plus `npm audit` in the `portal` job.

## Security notes
Strict CSP (`public/_headers`): scripts and styles only from the same origin, no inline code, so do not add inline `<script>`/`style=`.
The whole app is `noindex`. A public, indexable landing page for `/apply` is a separate task.

## Not deployed
No route or domain exists. Deploy needs owner approval, a private R2 bucket `ntagz-kyc`, secrets `PAN_HASH_SECRET` and `RESEND_API_KEY`, and migrations 0021-0023 applied to the remote D1.
