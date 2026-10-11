#!/usr/bin/env bash
# Runs the admin API suites against a LOCAL D1 (never production). The fulfilment suite changes the fixture orders that
# smoke.mjs expects, so each group gets a freshly built database.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8811}; export BASE="http://localhost:$PORT"
fresh() {
  pkill -f "wrangler.*dev" 2>/dev/null || true; pkill -f workerd 2>/dev/null || true; sleep 1
  rm -rf .wrangler/state
  npx -y wrangler@4 d1 execute ntagz-db --local --file ../db/schema.sql >/dev/null 2>&1
  npx -y wrangler@4 d1 migrations apply ntagz-db --local >/dev/null 2>&1
  npx -y wrangler@4 d1 execute ntagz-db --local --file test/fixtures.sql >/dev/null 2>&1
  (npx -y wrangler@4 dev --local --port $PORT >/tmp/ntagz-admin-dev.log 2>&1 &)
  for _ in $(seq 1 40); do curl -s http://localhost:$PORT/api/orders | grep -q "Not signed in" && break; sleep 2; done
}
printf 'ADMIN_EMAILS=admin@example.test\nDEV_OTP_ECHO=1\n' > .dev.vars
fresh; node test/smoke.mjs; node test/products.mjs; node test/payments-manual.mjs
fresh; node test/fulfilment.mjs
pkill -f "wrangler.*dev" 2>/dev/null || true; pkill -f workerd 2>/dev/null || true
