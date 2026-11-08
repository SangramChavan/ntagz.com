#!/usr/bin/env bash
# Usage: scripts/cutover-check.sh <base-url> [--skip-api]
# Checks a deployment of the static site: every sitemap URL is 200, private paths are 404, key pages match the
# repo's dist/ build byte-for-byte, and /api/catalog returns JSON (unless --skip-api).
set -uo pipefail
cd "$(dirname "$0")/.."
BASE="${1:?base url, e.g. https://ntagz.com}"; SKIP_API="${2:-}"
fail=0; bad() { echo "FAIL $*"; fail=1; }
for u in $(grep -o '<loc>[^<]*</loc>' sitemap.xml | sed 's/<[^>]*>//g;s|https://ntagz.com||'); do
  c=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$u"); [ "$c" = 200 ] || bad "$c $u"
done
for u in /docs/platform/CONTRACTS.md /admin/README.md /wrangler.toml /.dev.vars /db/schema.sql /RECOVERY.md /package.json /test/site-worker.test.js /packages/platform-core/src/auth.js /apps/partner-portal/package.json /apps/partner-portal/src/main.tsx /workers/partner/wrangler.jsonc /admin/migrations/0023_partner_sessions_fees.sql; do
  c=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$u"); [ "$c" = 404 ] && continue; bad "private path exposed: $c $u"
done
# Always rebuild: a leftover dist/ from another branch gives false failures (or hides real differences).
# This compares against THIS checkout, so run it from the commit that is deployed (normally main).
npm run -s build:static >/dev/null || { echo "FAIL build:static"; exit 1; }
for f in index.html order.html track.html tools/bulk-quote.html js/catalog.js js/order.js css/tokens.css robots.txt sitemap.xml llms.txt; do
  u="/$f"; [ "$f" = index.html ] && u=/
  a=$(curl -s "$BASE$u" | shasum | cut -c1-16); b=$(shasum < "dist/$f" | cut -c1-16); [ "$a" = "$b" ] || bad "content differs from dist: $u"
done
if [ "$SKIP_API" != "--skip-api" ]; then
  curl -s "$BASE/api/catalog" | head -c 1 | grep -q '\[' || bad "/api/catalog is not JSON array"
  t=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/quote" -H 'content-type: application/json' -d '{"items":[]}'); case "$t" in 2*|4*) ;; *) bad "/api/quote returned $t";; esac
fi
[ $fail = 0 ] && echo "ALL CHECKS PASSED for $BASE" || { echo "CHECKS FAILED for $BASE"; exit 1; }
