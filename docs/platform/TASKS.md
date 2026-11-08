# TASKS (shared status board)

Rule: an item is "Done" only when implemented **and** tested. Update this file in the same PR as the work.

Legend: ☐ not started · ◐ in progress · ✔ done and tested · ⛔ blocked (see Blockers)

## Stage 0: Inspection and contracts

| Item | Owner | Status |
|---|---|---|
| Repo inspection (backend, frontend, infra) | CTO | ✔ |
| Phase 0 report, decisions, open items | CTO | ✔ (needs owner review) |
| CONTRACTS.md v0.1 (DB, auth, roles, API, errors, tokens) | CTO | ✔ (needs owner review) |
| ARCHITECTURE.md v0.1 | CTO | ✔ |
| Owner answers to O1-O6 | Owner | ☐ |

## Stage 1: Foundation (can start after owner review)

| Item | Owner | Depends on | Status |
|---|---|---|---|
| PR #40 merged (test baseline) | Integration/QA | owner | ✔ merged |
| Remove `pages_build_output_dir` from root `wrangler.toml` | DevOps | none | ✔ (PR #42) |
| Repair `admin/test/products.mjs` (expects 17 products; migration 0017 made it 18) so `admin/test/run-all.sh` passes on main | DevOps | none | ☐ |
| Widen CI: seo, schema, pricing, links, site, admin suite | DevOps | repair above | ☐ |
| `packages/platform-core`: errors, validators, audit, `loadAccess`/`requirePermission`/`scopeClause` | Backend + Auth | contracts | ✔ (47 tests, `admin/stage2/test-platform-rbac.cjs`) |
| Migration 0021: roles, permissions, role_permissions, user_roles, login_attempts, users status columns, audit_log entity columns + seed | Backend | contracts | ✔ applied on local D1 only; **not applied to remote** |
| Migration 0022: partner_types (5 seeded), partners, partner_applications, partner_documents, partner_agreements | Backend | 0021 | ✔ applied on local D1 only; **not applied to remote** |
| Design tokens + base components in `packages/ui` | Design | contracts | ☐ |
| `ntagz-site` Worker config and staging deploy | DevOps | owner O2 | ✔ staging live at workers.dev; cutover needs owner go (`CUTOVER-PLAN.md`) |
| Staging D1 + test keys | DevOps | owner O2 | ⛔ |

## Stage 2: P0 build

| Item | Owner | Depends on | Status |
|---|---|---|---|
| Unified sessions and OTP hardening (per-IP limit, hashed session IDs, purge cron) | Auth | platform-core | ☐ |
| Partner apply API (OTP login, draft, documents, submit) | Backend | 0022 | ✔ API only, tested (`test-partner-flow.cjs`); **no UI yet**, not deployed |
| Partner apply UI (multi-step form, document upload, status page) | Partner portal | API above, design tokens | ☐ |
| HQ approval API (list, review, approve, reject, request docs, agreement, fee, activate, suspend, reinstate) | Backend | 0022, 0023 | ✔ API only, wired into admin Worker under `/api/v1/admin/`, tested on real local D1; not deployed |
| HQ partner applications screen in admin UI | HQ admin | API above | ☐ |
| Partner ID issue, agreement and activation gates | Backend | above | ✔ (agreement and fee are recorded by HQ; e-sign and gateway fee payment are later) |
| Partner login (email OTP, hashed sessions, per-IP limit) | Auth | platform-core | ✔ API (`/api/v1/auth/*` in `workers/partner`) |
| Partner dashboard (five tier navigations, widgets) | Partner portal | auth, partners | ☐ (API returns profile and permissions only) |
| Wholesale catalogue and partner ordering via existing checkout | Backend + Partner portal | price_lists | ☐ |
| Customer account: invoices, order tracking inside account | Customer portal | invoices table | ☐ |
| Admin: `payment_alerts` screen | HQ admin | none | ☐ |
| Staff roles replace flat `ADMIN_EMAILS`; TOTP MFA | Auth + HQ admin | roles | ☐ |

## Follow-ups found while building the apply/approval API

| Item | Owner | Status |
|---|---|---|
| Emails: application received, documents requested, approved, rejected, activated (use existing `notifications` + Resend) | Backend | ☐ |
| Customer `getSession` should ignore `portal='partner'` sessions (one-line change on the live checkout path; ship with column feature-check) | Auth | ☐ |
| Remove orphan R2 objects when a DB insert fails after upload (rare); scheduled cleanup | Backend | ☐ |
| Per-IP limit on OTP *verify* (send is limited; verify is limited per code) | Auth | ☐ |
| Regional Manager `region` scope for applications (needs a PIN-to-region map) | Backend | ☐ |
| E-sign for the partner agreement and gateway payment of the joining fee (today HQ records both) | Backend | ☐ owner O5 |
| Create **private** R2 bucket `ntagz-kyc`; set secrets `PAN_HASH_SECRET`, `RESEND_API_KEY` on `ntagz-partner` | DevOps | ⛔ owner approval |

## Stage 3: P1

Leads, quotations, partner price lists, inventory per partner, commission engine, settlements, territories, service jobs, shipment tracking APIs.

## Stage 4: P2

WhatsApp automation, advanced analytics, training management, regional warehouses, financial reports, partner staff, automation.

## End-to-end acceptance (all must pass automatically before launch)

| Workflow | Status |
|---|---|
| A Customer: browse → pay → account → tracking → invoice | ☐ (invoice and in-account tracking missing) |
| B Partner: apply → HQ approve → agreement → login → catalogue → leads/orders → earnings | ☐ |
| C HQ: applications, customers, products/prices, orders, inventory, fulfilment, commissions, reports | ☐ |
| D Attribution: lead → order → verified payment → commission → approval → settlement | ☐ |

## Blockers and owner decisions

O1 hosting confirmation and DNS cutover go · O2 Cloudflare access and staging approval · O3 SMS and WhatsApp providers · O4 storefront restyle approval · O5 commercial and legal decisions · O6 trademark check. Details in `PHASE0-REPORT.md` section 6.

## Known limitations

Nothing in the new platform is built or deployed yet. No production changes have been made.
