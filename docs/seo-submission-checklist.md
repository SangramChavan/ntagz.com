# Manual steps (need account access)
1. Search Console: verify `ntagz.com` (domain property), submit `https://ntagz.com/sitemap.xml`, inspect `/`, `/product/`, `/membership/` and request indexing; review Pages and Core Web Vitals reports.
2. Bing Webmaster Tools: import from Search Console, submit the sitemap.
3. Confirm homepage reviews are genuine (or remove them from JSON-LD).
4. Deploy `dist/` (Cloudflare Pages, see RECOVERY.md) and re-check sitemap/robots on the live host.
5. Run PageSpeed Insights on home + top 3 product pages for a real baseline.
