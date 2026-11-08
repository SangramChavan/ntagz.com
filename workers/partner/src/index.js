import { partnerRouter } from '../../../packages/platform-core/src/http.js';

// partner.ntagz.com: /api/* goes to the API router; everything else is the portal (static assets, SPA fallback, strict CSP via _headers).
export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith('/api/')) return partnerRouter(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
