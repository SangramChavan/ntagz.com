import { partnerRouter } from '../../../packages/platform-core/src/http.js';

// partner.ntagz.com API. UI assets are added with the portal build; until then only /api/v1/* is served.
export default { fetch: (request, env) => partnerRouter(request, env) };
