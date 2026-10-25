# SEO fix log

| File | Defect | Reason | Validation |
|------|--------|--------|------------|
| `sitemap.xml` | Missing `/product/`, `/membership/` | Index valuable canonical pages | `xmllint` OK; `test:seo` 0 errors |
| `llms.txt` | Stale coin/mini-tag prices | Match `js/catalog.js` | Manual diff vs catalogue |
| `product/google-review-nfc-card-with-qr/index.html` | Thin stub indexable | Avoid thin-content index | `test:seo` skips noindex page |
| `scripts/seo-check.js`, `package.json` | No automated SEO check | Regression guard (`npm run test:seo`) | Exits 0 / 1 as expected |

`dist/` rebuilt with `npm run build:static` (142 files). Nothing committed or deployed.

## Checkout / pricing / CTA pass
| File | Defect | Reason | Validation |
|------|--------|--------|------------|
| `index.html`, `order.html`, `llms.txt` | "Bulk discounts up to 60%" but the highest tier in both `js/catalog.js` and `functions/lib/pricing.js` is 25% (10,000+ is a custom quote) | Misleading offer; changed to "up to 25%" | `scripts/test-pricing-consistency.js` fails on any claim above the max tier |
| `index.html`, `site.webmanifest` | `/favicon.ico`, `/apple-touch-icon.png`, `/favicon-*.png` 404 (files live in `/images/`) | Broken icon links | `scripts/test-links.js` |
| `sitemap.xml` | noindex stub `google-review-nfc-card-with-qr` was listed | Sitemap must not list noindex pages | `test:seo` 0 errors |
| `scripts/test-pricing-consistency.js` (new) | No guard for price drift | Compares client catalogue, server engine, product-page JSON-LD, tiers, shipping | 0 errors |
| `scripts/test-links.js` (new) | No CTA/link guard | Checks internal links, `?add=` product ids, single WhatsApp number (+919960160016) | 0 errors |

Also run: `npm run test:payment` passes (the test worker reports "no database" by design). Payment, cart and checkout code were **not modified**.
Not done: live end-to-end checkout in a browser, GST/shipping edge cases, analytics events. Consider adding "Rewards members" pricing to schema only if shown on page.

## Skill-guided pass (seo-audit, schema, ai-seo)
| File | Defect / gap | Validation |
|------|--------------|------------|
| `product/uhf-rfid-label/index.html` | Product JSON-LD had no `image` (required for product rich results); added the existing product photo | `npm run test:schema` |
| `scripts/test-schema.js` (new) | Checks Product name/image/offers/price/currency/availability | Run: remaining errors listed below |
| `scripts/build-pricing-md.js`, `pricing.md`, `llms.txt`, `build-static.sh` | No machine-readable price list for AI agents (ai-seo guidance); generated from `js/catalog.js`, linked from llms.txt, shipped in `dist/` | Output reviewed against catalogue |

AI crawler access: `robots.txt` uses `User-agent: *` / `Allow: /`, so GPTBot, PerplexityBot, ClaudeBot, Google-Extended and Bingbot are not blocked. No change made; blocking training-only crawlers (e.g. CCBot) is a business decision.

Open schema findings (`npm run test:schema`): `product/sample-kit` has no image because the page shows only a placeholder and the catalogue image is a single black card, which would misrepresent the kit; add a real kit photo, then add it to the JSON-LD. Homepage has category-level `Product` nodes (NFC Business Cards, RFID Tags & Labels, NFC Coins & Mini Tags) with no image/offers; review whether they should be `OfferCatalog`/`ItemList` entries. Schema was checked from source JSON only, not with Google's Rich Results Test (needs a live URL).
