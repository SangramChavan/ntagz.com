# SEO audit (code-level, 2026-10-25)

Scope: static inspection of the repo plus `scripts/seo-check.js`. **No live-site, Lighthouse, Search Console or field-data measurements were taken**, so no baseline score is claimed.

| # | Sev | Finding | Evidence | Status |
|---|-----|---------|----------|--------|
| 1 | High | Sitemap omitted `/product/` catalogue and `/membership/` | `sitemap.xml` had 23 URLs; both pages are indexable with canonicals | Fixed (added) |
| 2 | High | `llms.txt` prices contradicted catalogue (coin ₹15 vs ₹20, mini tag ₹11 vs ₹16) | `js/catalog.js` price 20 / 16; product-page JSON-LD 20 / 16 | Fixed |
| 3 | Medium | `/product/google-review-nfc-card-with-qr/` is a stub (one sentence, no schema, no catalogue entry) | file contents | Set `noindex, follow`; kept out of sitemap. Needs real content/product decision before indexing |
| 4 | Medium | Meta descriptions over ~170 chars on 11 pages; titles over 65 chars on 6 | `npm run test:seo` warnings | Open (truncation only, not an error) |
| 5 | Medium | Homepage JSON-LD contains `Review` entries (Rahul Khandelwal, Priya Menon) | `index.html` ~L327 | **Unverified**: owner must confirm these are genuine, attributable reviews; otherwise remove |
| 6 | Low | `tools/bulk-quote.html` indexable, not in sitemap, and not copied by `build-static.sh` | build script | Open: decide whether it is deployed |
| 7 | Low | `robots.txt` has `Crawl-delay` (ignored by Google) | file | Harmless; left |

Verified OK: all indexable pages have title, description, canonical, one `<h1>`, `lang`; no duplicate titles/descriptions; JSON-LD parses on every page; sitemap XML valid and every URL maps to a file; robots.txt declares the sitemap.

Not inspected: checkout/payment flow, analytics, redirects/headers on live host, Core Web Vitals, accessibility.
