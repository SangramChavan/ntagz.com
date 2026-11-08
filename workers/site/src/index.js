// URL handling that matches the GitHub Pages behaviour the live site relies on (sitemap/canonicals use these URLs):
//   /order.html -> 200 (exact file, served by assets)     /order        -> serves order.html (200)
//   /product/x/ -> serves product/x/index.html (200)      /product/x    -> 301 /product/x/
//   www.ntagz.com/anything -> 301 https://ntagz.com/anything  (GitHub Pages did this because of the CNAME file)
// Runs only when no static asset matches the path exactly (html_handling = "none").
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (url.hostname === 'www.ntagz.com') return Response.redirect('https://ntagz.com' + p + url.search, 301);
    const get = (path) => env.ASSETS.fetch(new Request(new URL(path, url), request));
    if (p.endsWith('/')) {
      const r = await get(p + 'index.html');
      if (r.status === 200) return r;
    } else {
      const page = await get(p + '.html');
      if (page.status === 200) return page;
      const dir = await get(p + '/index.html');
      if (dir.status === 200) return Response.redirect(url.origin + p + '/' + url.search, 301);
    }
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};
