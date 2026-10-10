#!/usr/bin/env bash
# Local TimDo API on a copy of production data (from the latest backup), with the
# collaboration migration and legacy sync applied, plus a demo "Northstar Workshop"
# workspace shared with Jordan Example. Never touches production.
#
#   scripts/local-api.sh [port]     default port 8787
# CLI against it:  TIMDO_API=http://127.0.0.1:8787/api/v2 TIMDO_SECRET=local-dev-secret bin/timdo list
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-8787}"
PERSIST=".wrangler/local-$PORT"
BACKUP="${TIMDO_BACKUP_DIR:-$HOME/timdo-backups/latest}"

[[ -f .dev.vars ]] || printf 'INTERNAL_API_SECRET=local-dev-secret\nGROQ_API_KEY=\n' > .dev.vars

if [[ ! -d "$PERSIST" || "${RESET:-}" == "1" ]]; then
  rm -rf "$PERSIST"
  npx wrangler d1 execute timdo-v2-db --local --persist-to "$PERSIST" --command "select 1" >/dev/null
  SQLITE=$(find "$PERSIST" -name '*.sqlite' | head -1)
  node scripts/build-local-db.mjs "$BACKUP" "$SQLITE"
fi

exec npx wrangler dev --local --persist-to "$PERSIST" --port "$PORT"
