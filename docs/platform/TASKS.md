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
| Partner apply flow (draft, save, documents, submit) | Partner portal + Backend | 0022 | ☐ |
| HQ partner applications screen (review, approve, reject, request docs) | HQ admin | 0022, API | ☐ |
| Partner ID issue, agreement and activation gates | Backend | above | ☐ |
| Partner login and dashboard (five tier navigations) | Partner portal | auth, partners | ☐ |
| Wholesale catalogue and partner ordering via existing checkout | Backend + Partner portal | price_lists | ☐ |
| Customer account: invoices, order tracking inside account | Customer portal | invoices table | ☐ |
| Admin: `payment_alerts` screen | HQ admin | none | ☐ |
| Staff roles replace flat `ADMIN_EMAILS`; TOTP MFA | Auth + HQ admin | roles | ☐ |

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
