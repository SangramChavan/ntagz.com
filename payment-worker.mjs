import { onRequest } from "./functions/api/[[path]].js";

export default {
  fetch(request, env) {
    return onRequest({ request, env });
  },
};
