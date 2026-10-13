#!/usr/bin/env bash
# Local TimDo API on a fresh database with fictional demo data. No Cloudflare account,
# Auth0 or production data needed.
#
#   workers/scripts/dev-api.sh [port]        (default 8787; RESET=1 rebuilds the database)
#
# Then, from the repo root:
#   TIMDO_API=http://127.0.0.1:8787/api/v2 TIMDO_SECRET=local-dev-secret bin/timdo list
#   ... --as robin@example.com list        (see what Robin, a member, sees)
#   ... --as sam@example.com list          (Sam is a viewer: writes are refused)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-8787}"
PERSIST=".wrangler/dev-$PORT"

[[ -f .dev.vars ]] || printf 'INTERNAL_API_SECRET=local-dev-secret\nGROQ_API_KEY=\n' > .dev.vars

if [[ ! -d "$PERSIST" || "${RESET:-}" == "1" ]]; then
  rm -rf "$PERSIST"
  npx wrangler d1 execute timdo-v2-db --local --persist-to "$PERSIST" --file schema/current-schema.sql >/dev/null
  npx wrangler d1 execute timdo-v2-db --local --persist-to "$PERSIST" --file scripts/sql/demo-seed.sql >/dev/null
  npx wrangler d1 execute timdo-v2-db --local --persist-to "$PERSIST" --file migrations/0011_activity_sequence.sql >/dev/null
  echo "Built a fresh local database with demo data in $PERSIST"
fi

LOCAL_DB=$(find "$PERSIST" -name '*.sqlite' -print -quit)
if [[ -z "$LOCAL_DB" ]]; then
  echo "Could not find the local D1 database under $PERSIST" >&2
  exit 1
fi
node --experimental-sqlite scripts/upgrade-local-dedupe.mjs "$LOCAL_DB"

exec npx wrangler dev --local --persist-to "$PERSIST" --port "$PORT"
