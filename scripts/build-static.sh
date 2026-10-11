#!/usr/bin/env bash
# Builds dist/ from an allowlist of PUBLIC files only (never admin/, db/, functions/, .dev.vars, ...), so the static
# site can be deployed to Cloudflare Pages straight from this working tree, without GitHub. See RECOVERY.md.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir dist
cp *.html robots.txt sitemap.xml site.webmanifest browserconfig.xml llms.txt dist/
cp -R css js images assets components account order membership product dist/
if find dist \( -name '.dev.vars*' -o -name '*.sql' -o -name 'wrangler*' -o -path '*/admin/*' \) | grep -q .; then
  echo "refusing: private file in dist/" >&2; exit 1
fi
echo "dist/ ready: $(find dist -type f | wc -l | tr -d ' ') files"
