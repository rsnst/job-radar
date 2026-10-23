#!/usr/bin/env bash
# Starts the worker with settings from worker/.env. Run from anywhere: ./start.sh
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "Missing worker/.env. Copy .env.example to .env and fill it in." >&2; exit 1; }
set -a; . ./.env; set +a
for v in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY CREDENTIAL_KEY INBOX_DOMAIN INBOUND_SECRET; do
  [ -n "${!v:-}" ] || { echo "$v is empty in worker/.env" >&2; exit 1; }
done
[ -d node_modules ] || npm ci
npx playwright install chromium >/dev/null 2>&1 || true
exec node src/index.js
