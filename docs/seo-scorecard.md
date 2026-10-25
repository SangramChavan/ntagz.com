# Internal scorecard (not an official rating)

Only code-verifiable categories are scored; others are **not measured**.

| Category | Weight | Status |
|---|---:|---|
| Crawlability/indexability | 15 | Code OK (robots, sitemap, noindex). Live status codes unverified |
| Technical SEO/canonicals | 15 | Code OK. Redirects/headers unverified (host config not in repo) |
| Metadata/content | 15 | Present and unique; length warnings remain |
| Structured data | 10 | Valid JSON-LD syntax; prices match catalogue; Review authenticity unverified. No rich-result validator run |
| Internal linking | 10 | Not audited |
| AI discoverability | 10 | llms.txt corrected; otherwise unchanged |
| Performance/mobile | 10 | Not measured |
| Ecommerce/accessibility | 10 | Not audited |
| Testing/docs | 5 | `npm run test:seo` added |

No numeric total is given: most categories lack measurements.
