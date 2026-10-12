// CRM router. Each module exports `routes`: [{ m, p, perm, h }]. `perm` is checked on the SERVER for every request (view | manage | export | send).
// Handlers receive ctx = { env, actor, request, url, method, body, json, fail, sec, perms } and the regex match as 2nd argument.
import { permsOf } from "./common.js";
import * as customers from "./customers.js";
import * as segments from "./segments.js";
import * as analytics from "./analytics.js";
import * as campaigns from "./campaigns.js";
import * as journeys from "./journeys.js";

const ROUTES = [...customers.routes, ...segments.routes, ...analytics.routes, ...campaigns.routes, ...journeys.routes];

export async function crmRoute(ctx) {
  if (!ctx.url.pathname.startsWith("/api/crm/")) return null;
  for (const r of ROUTES) {
    if (r.m !== ctx.method) continue;
    const match = ctx.url.pathname.match(r.p);
    if (!match) continue;
    const perms = permsOf(ctx.env, ctx.actor);
    if (!perms[r.perm]) return ctx.fail(403, "You do not have permission for this action");
    return await r.h({ ...ctx, perms }, match);
  }
  return ctx.fail(404, "Not found");
}

// Provider webhook (delivery / bounce / complaint). Public path; the handler verifies the provider signature itself.
export const crmWebhook = campaigns.handleWebhook;

// Cron: send due campaigns, run journeys, purge expired data. Each step is isolated so one failure never blocks the others.
export async function crmScheduled(env) {
  for (const [name, fn] of [["campaigns", campaigns.tick], ["journeys", journeys.tick], ["retention", customers.purgeExpired]]) {
    try { await fn(env); } catch (e) { console.error(`crm ${name} tick failed:`, e && e.message); }
  }
}
