#!/usr/bin/env bash
# Focused local tests for recorded events CLI, follow output and explicit checkpoints.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_TIMDO="$ROOT_DIR/bin/timdo"
MOCK_DIR="$(mktemp -d)"
mkdir -p "$MOCK_DIR/bin" "$MOCK_DIR/private"
chmod 700 "$MOCK_DIR/private"
LOG="$MOCK_DIR/requests.jsonl"
export EVENTS_MOCK_LOG="$LOG"

cleanup() {
  if [[ -n "${BLOCK_RELEASE_FILE:-}" ]]; then
    : > "$BLOCK_RELEASE_FILE" 2>/dev/null || true
  fi
  if [[ -n "${FOLLOW_PID:-}" ]]; then
    kill -TERM "$FOLLOW_PID" 2>/dev/null || true
    for _ in $(seq 1 100); do
      kill -0 "$FOLLOW_PID" 2>/dev/null || break
      sleep 0.01
    done
    kill -KILL "$FOLLOW_PID" 2>/dev/null || true
    wait "$FOLLOW_PID" 2>/dev/null || true
  fi
  rm -rf "$MOCK_DIR"
}
trap cleanup EXIT

cat > "$MOCK_DIR/bin/curl" <<'PYEOF'
#!/usr/bin/env python3
import json
import os
import pathlib
import sys
import urllib.parse

args = sys.argv[1:]
_credential_config = sys.stdin.read()
method = "GET"
body_file = None
header_file = None
write_status = False
url = ""
i = 0
while i < len(args):
    arg = args[i]
    if arg == "-X":
        method = args[i + 1]
        i += 2
    elif arg == "-o":
        body_file = args[i + 1]
        i += 2
    elif arg == "-D":
        header_file = args[i + 1]
        i += 2
    elif arg == "-w":
        write_status = True
        i += 2
    elif arg in ("-H", "-d", "--data", "--data-raw", "-K"):
        i += 2
    elif arg.startswith("-"):
        i += 1
    else:
        url = arg
        i += 1

parsed = urllib.parse.urlparse(url)
query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
path = parsed.path
scenario = os.environ.get("EVENTS_MOCK_SCENARIO", "single")
one = lambda key, default=None: query.get(key, [default])[0]
status = 200
headers = "HTTP/1.1 200 OK\r\nCache-Control: no-store\r\n\r\n"

if path.endswith("/users/me"):
    if os.environ.get("EVENTS_MOCK_DENY_ME") == "1":
        status, payload = 401, {"error": "Not signed in"}
    else:
        payload = {"id": os.environ.get("EVENTS_MOCK_PRINCIPAL", "user-fictional-1"), "kind": "human", "name": "Riley Example"}
elif path.endswith("/organisations/sharing"):
    if os.environ.get("EVENTS_MOCK_NO_WORKSPACE") == "1":
        payload = []
    else:
        payload = [{"id": "ws-fictional-1", "name": "Fictional Workshop", "slug": "fictional-workspace", "role": "member"}]
        if os.environ.get("EVENTS_MOCK_SECOND_WORKSPACE") == "1":
            payload.append({"id": "ws-fictional-2", "name": "Another Fictional Workshop", "slug": "another-fictional-workspace", "role": "member"})
elif path.endswith("/events"):
    after = one("after", "0")
    if scenario == "transport":
        raise OSError("fixture transport failure")
    if scenario == "stale":
        status, payload = 409, {"error": "stale_cursor", "message": "restart from 0"}
    elif scenario == "loop":
        payload = {"version": 1, "events": [{"id": "evt-fictional-loop", "type": "task.updated", "occurredAt": "2026-10-11T10:00:00.000Z", "workspaceId": "ws-fictional-1", "projectId": "project-fictional-1", "taskId": "task-fictional-1", "epicId": None, "actor": {"id": "user-fictional-1", "kind": "human"}, "via": "web", "task": {"id": "task-fictional-1", "status": "do", "deleted": False}}], "next": after if after != "0" else "c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "hasMore": True}
    elif scenario == "bad-events":
        payload = {"version": 1, "events": [{"id": "evt-fictional-duplicate"}, {"id": "evt-fictional-duplicate"}], "next": "c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "hasMore": False}
    elif scenario == "error":
        status, payload = 503, {"error": "cursor_unavailable", "message": "fixture failure"}
    elif scenario == "blocked":
        started = os.environ.get("EVENTS_MOCK_STARTED")
        release = os.environ.get("EVENTS_MOCK_RELEASE")
        if started:
            pathlib.Path(started).write_text(str(os.getpid()), encoding="ascii")
        if not release:
            raise RuntimeError("blocked fixture needs a release file")
        import time
        while not pathlib.Path(release).exists():
            time.sleep(0.01)
        payload = {"version": 1, "events": [], "next": "c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "hasMore": False}
    elif scenario == "bad-cursor":
        payload = {"version": 1, "events": [], "next": "c1.short", "hasMore": False}
    elif scenario == "empty":
        payload = {"version": 1, "events": [], "next": "c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "hasMore": False}
    elif scenario == "latest":
        payload = {"version": 1, "events": [], "next": "c1.AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "hasMore": False}
    elif scenario == "follow":
        if after == "0":
            payload = {"version": 1, "events": [{"id": "evt-fictional-1", "type": "task.updated", "occurredAt": "2026-10-11T10:00:00.000Z", "workspaceId": "ws-fictional-1", "projectId": "project-fictional-1", "taskId": "task-fictional-1", "epicId": None, "actor": {"id": "user-fictional-1", "kind": "human"}, "via": "web", "task": {"id": "task-fictional-1", "status": "do", "deleted": False}}], "next": "c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "hasMore": True}
        elif after == "c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA":
            payload = {"version": 1, "events": [{"id": "evt-fictional-2", "type": "task.completed", "occurredAt": "2026-10-11T10:01:00.000Z", "workspaceId": "ws-fictional-1", "projectId": "project-fictional-1", "taskId": "task-fictional-2", "epicId": None, "actor": {"id": "user-fictional-1", "kind": "human"}, "via": "token", "task": {"id": "task-fictional-2", "status": "done", "deleted": False}}], "next": "c1.AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "hasMore": False}
        else:
            payload = {"version": 1, "events": [], "next": "c1.AwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "hasMore": False}
    else:
        payload = {"version": 1, "events": [{"id": "evt-fictional-1", "type": "task.updated", "occurredAt": "2026-10-11T10:00:00.000Z", "workspaceId": "ws-fictional-1", "projectId": "project-fictional-1", "taskId": "task-fictional-1", "epicId": None, "actor": {"id": "user-fictional-1", "kind": "human"}, "via": "web", "task": {"id": "task-fictional-1", "status": "do", "deleted": False}}], "next": "c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "hasMore": False}
else:
    status, payload = 404, {"error": "not_found", "message": "mock route not found"}

record = {
    "method": method,
    "path": path,
    "query": parsed.query,
    "authKind": "Authorization" if "Authorization:" in _credential_config else ("X-Internal-Secret" if "X-Internal-Secret:" in _credential_config else "none"),
    "argsContainCredential": any("fixture-secret" in arg or "tdo_fixture" in arg for arg in args),
}
with open(os.environ["EVENTS_MOCK_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps(record) + "\n")

if body_file:
    pathlib.Path(body_file).write_text(json.dumps(payload), encoding="utf-8")
if header_file:
    pathlib.Path(header_file).write_text(headers, encoding="ascii")
if write_status:
    sys.stdout.write(str(status))
PYEOF
chmod 700 "$MOCK_DIR/bin/curl"

export PATH="$MOCK_DIR/bin:$PATH"
export TIMDO_CONFIG=/dev/null
export TIMDO_API=http://events-fixture.invalid/api/v2
export TIMDO_SECRET=fixture-secret
export NO_COLOR=1
unset TIMDO_TOKEN TIMDO_AS || true

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "expected output to contain: $2"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "output unexpectedly contained: $2"; }
reset_log() { : > "$LOG"; }
run_cli() { "$BIN_TIMDO" "$@"; }

LINKED_BIN="$MOCK_DIR/timdo-link"
ln -s "$BIN_TIMDO" "$LINKED_BIN"
LINK_STATE="$MOCK_DIR/private/symlink-state.json"
"$LINKED_BIN" events init --state-file "$LINK_STATE" --after 0 >/dev/null
[[ -f "$LINK_STATE" ]] || fail 'symlinked CLI could not find its checkpoint helper'

help_output=$(run_cli events --help)
assert_contains "$help_output" 'timdo events'
assert_contains "$help_output" '--include-text'
assert_contains "$help_output" '--state-file'

reset_log
finite=$(EVENTS_MOCK_SCENARIO=single run_cli --json events --after 0 --workspace fictional-workspace --types 'task.updated,task.created,task.updated' --include-text --include-refs -n 2)
[[ "$(jq -r '.version' <<< "$finite")" == 1 ]] || fail 'finite JSON lost the page version'
[[ "$(jq -r '.events[0].id' <<< "$finite")" == evt-fictional-1 ]] || fail 'finite JSON lost its event'
[[ "$(jq -r '.hasMore' <<< "$finite")" == false ]] || fail 'finite JSON lost hasMore'
event_request=$(jq -c 'select(.path == "/api/v2/events")' "$LOG")
[[ -n "$event_request" ]] || fail 'finite call did not request /events'
event_query=$(jq -r '.query' <<< "$event_request")
assert_contains "$event_query" 'workspace=ws-fictional-1'
assert_contains "$event_query" 'types=task.created%2Ctask.updated'
assert_contains "$event_query" 'include=refs%2Ctext'
assert_contains "$event_query" 'limit=2'

reset_log
empty=$(EVENTS_MOCK_SCENARIO=empty run_cli --json events)
[[ "$(jq -c '{version,events,next,hasMore}' <<< "$empty")" == '{"version":1,"events":[],"next":"c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","hasMore":false}' ]] || fail 'empty JSON page was not returned as an envelope'
reset_log
if output=$(EVENTS_MOCK_SCENARIO=bad-cursor run_cli --json events 2>&1); then fail 'accepted a short cursor in the response page'; fi
assert_contains "$output" 'cursor'
reset_log
if output=$(EVENTS_MOCK_SCENARIO=bad-events run_cli --json events 2>&1); then fail 'accepted duplicate event IDs in a response page'; fi
assert_contains "$output" 'stable event ID'

reset_log
if output=$(run_cli --json events --after c1.short 2>&1); then fail 'accepted a short input cursor'; fi
assert_contains "$output" 'cursor'
[[ ! -s "$LOG" ]] || fail 'invalid input cursor made an API request'

reset_log
text=$(EVENTS_MOCK_SCENARIO=single run_cli --text events -n 1)
assert_contains "$text" 'evt-fictional-1'
assert_contains "$text" 'task.updated'
assert_contains "$text" 'human:user-fictional-1'
assert_contains "$text" 'web'
assert_not_contains "$text" 'event body'

for bad_interval in 0 3601 1.5 -1 nope 00000; do
  reset_log
  if output=$(run_cli events --follow --interval "$bad_interval" 2>&1); then fail "accepted invalid interval $bad_interval"; fi
  assert_contains "$output" 'interval'
  [[ ! -s "$LOG" ]] || fail "invalid interval $bad_interval made an API request"
done
reset_log
if output=$(run_cli events --interval 5 2>&1); then fail 'accepted --interval without --follow'; fi
assert_contains "$output" '--interval requires --follow'
[[ ! -s "$LOG" ]] || fail '--interval without --follow made an API request'

reset_log
if output=$(EVENTS_MOCK_SCENARIO=single run_cli events --follow --state-file "$MOCK_DIR/private/state.json" 2>&1); then
  fail 'accepted --follow with --state-file'
fi
assert_contains "$output" 'cannot be combined'

# Follow must emit each full compact page before using its next cursor, then wait for polling.
reset_log
EVENTS_MOCK_SCENARIO=follow "$BIN_TIMDO" --json events --follow --interval 3600 > "$MOCK_DIR/follow.jsonl" 2> "$MOCK_DIR/follow.err" &
FOLLOW_PID=$!
for _ in $(seq 1 200); do
  count=$(jq -s '[.[] | select(.path == "/api/v2/events")] | length' "$LOG" 2>/dev/null || printf '0')
  output_lines=$(wc -l < "$MOCK_DIR/follow.jsonl" | tr -d ' ')
  [[ "$count" -ge 2 && "$output_lines" -ge 2 ]] && break
  kill -0 "$FOLLOW_PID" 2>/dev/null || break
  sleep 0.025
done
count=$(jq -s '[.[] | select(.path == "/api/v2/events")] | length' "$LOG" 2>/dev/null || printf '0')
[[ "$count" -eq 2 ]] || fail "follow did not drain exactly two pages before polling (got $count)"
kill -TERM "$FOLLOW_PID"
if wait "$FOLLOW_PID"; then follow_status=0; else follow_status=$?; fi
FOLLOW_PID=""
[[ "$follow_status" -eq 0 ]] || fail "SIGTERM did not stop follow cleanly (status $follow_status)"
[[ "$(wc -l < "$MOCK_DIR/follow.jsonl" | tr -d ' ')" -eq 2 ]] || fail 'follow did not emit one complete envelope per page'
jq -e -s 'length == 2 and .[0].hasMore == true and .[1].hasMore == false and .[0].events[0].id == "evt-fictional-1" and .[1].events[0].id == "evt-fictional-2"' "$MOCK_DIR/follow.jsonl" >/dev/null || fail 'follow JSON Lines lost page envelope metadata'
first_after=$(jq -r 'select(.path == "/api/v2/events") | .query' "$LOG" | head -n 1)
second_after=$(jq -r 'select(.path == "/api/v2/events") | .query' "$LOG" | sed -n '2p')
assert_contains "$first_after" 'after=0'
assert_contains "$second_after" 'after=c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

# SIGTERM must terminate a curl request that is blocked inside follow.
reset_log
BLOCK_STARTED_FILE="$MOCK_DIR/request-started"
BLOCK_RELEASE_FILE="$MOCK_DIR/request-release"
EVENTS_MOCK_SCENARIO=blocked EVENTS_MOCK_STARTED="$BLOCK_STARTED_FILE" EVENTS_MOCK_RELEASE="$BLOCK_RELEASE_FILE" \
  "$BIN_TIMDO" --json events --follow --interval 3600 > "$MOCK_DIR/blocked-follow.jsonl" 2> "$MOCK_DIR/blocked-follow.err" &
FOLLOW_PID=$!
for _ in $(seq 1 200); do
  [[ -s "$BLOCK_STARTED_FILE" ]] && break
  kill -0 "$FOLLOW_PID" 2>/dev/null || break
  sleep 0.01
done
[[ -s "$BLOCK_STARTED_FILE" ]] || fail 'follow did not start the blocked fake API request'
BLOCK_CURL_PID=$(<"$BLOCK_STARTED_FILE")
kill -TERM "$FOLLOW_PID"
for _ in $(seq 1 50); do
  blocked_follow_state=$(ps -o stat= -p "$FOLLOW_PID" 2>/dev/null | tr -d ' ' || true)
  [[ -z "$blocked_follow_state" || "$blocked_follow_state" == Z* ]] && break
  sleep 0.01
done
if [[ -n "$blocked_follow_state" && "$blocked_follow_state" != Z* ]]; then
  : > "$BLOCK_RELEASE_FILE"
  for _ in $(seq 1 100); do
    blocked_follow_state=$(ps -o stat= -p "$FOLLOW_PID" 2>/dev/null | tr -d ' ' || true)
    [[ -z "$blocked_follow_state" || "$blocked_follow_state" == Z* ]] && break
    sleep 0.01
  done
  wait "$FOLLOW_PID" 2>/dev/null || true
  FOLLOW_PID=""
  fail 'SIGTERM did not stop follow while its API request was blocked'
fi
if wait "$FOLLOW_PID"; then blocked_follow_status=0; else blocked_follow_status=$?; fi
FOLLOW_PID=""
[[ "$blocked_follow_status" -eq 0 ]] || fail "blocked follow did not stop cleanly (status $blocked_follow_status)"
blocked_curl_state=$(ps -o stat= -p "$BLOCK_CURL_PID" 2>/dev/null | tr -d ' ' || true)
[[ -z "$blocked_curl_state" || "$blocked_curl_state" == Z* ]] || fail 'SIGTERM left the blocked API process alive'
: > "$BLOCK_RELEASE_FILE"

# init at zero records only the consumer context and never overwrites a file.
STATE="$MOCK_DIR/private/checkpoint.json"
reset_log
init_output=$(EVENTS_MOCK_SCENARIO=single run_cli --json events init --state-file "$STATE" --after 0 --workspace fictional-workspace --types 'task.updated,task.created,task.updated' --include-text)
[[ "$(jq -r '.initialized' <<< "$init_output")" == true ]] || fail 'init did not report success'
[[ "$(stat -c '%a' "$STATE")" == 600 ]] || fail 'checkpoint mode is not 0600'
UMASK_STATE="$MOCK_DIR/private/restrictive-umask.json"
UMASK_PAYLOAD=$(jq -c '.' "$STATE")
( umask 0777; printf '%s' "$UMASK_PAYLOAD" | node "$ROOT_DIR/bin/timdo-events-state.js" init "$UMASK_STATE" >/dev/null ) || fail 'restrictive-umask init failed'
[[ "$(stat -c '%a' "$UMASK_STATE")" == 600 ]] || fail 'restrictive-umask checkpoint mode is not 0600'
[[ "$(jq -r '.version' "$STATE")" == 1 ]] || fail 'checkpoint version is wrong'
[[ "$(jq -r '.api' "$STATE")" == 'http://events-fixture.invalid/api/v2' ]] || fail 'checkpoint API base was not normalised'
[[ "$(jq -r '.principal' "$STATE")" == 'user-fictional-1' ]] || fail 'checkpoint principal was not recorded'
[[ "$(jq -r '.workspace' "$STATE")" == 'ws-fictional-1' ]] || fail 'checkpoint workspace was not canonicalised'
[[ "$(jq -c '.types' "$STATE")" == '["task.created","task.updated"]' ]] || fail 'checkpoint types were not normalised'
[[ "$(jq -c '.include' "$STATE")" == '["text"]' ]] || fail 'checkpoint include was not normalised'
[[ "$(jq -r '.cursor' "$STATE")" == '0' ]] || fail 'zero bootstrap cursor was changed'
assert_not_contains "$(<"$STATE")" 'fixture-secret'
assert_not_contains "$(<"$STATE")" 'tdo_fixture'
before_state=$(sha256sum "$STATE" | cut -d' ' -f1)
if output=$(run_cli events init --state-file "$STATE" --after latest 2>&1); then fail 'init replaced an existing checkpoint'; fi
assert_contains "$output" 'already exists'
after_state=$(sha256sum "$STATE" | cut -d' ' -f1)
[[ "$before_state" == "$after_state" ]] || fail 'failed init changed the checkpoint'

# Reading fetches a finite page without modifying the checkpoint and honours its saved filters.
reset_log
read_page=$(EVENTS_MOCK_SCENARIO=single run_cli --json events --state-file "$STATE" -n 1)
[[ "$(jq -r '.events[0].id' <<< "$read_page")" == evt-fictional-1 ]] || fail 'state read lost page data'
[[ "$(jq -r '.cursor' "$STATE")" == '0' ]] || fail 'state read advanced the checkpoint'
state_query=$(jq -r 'select(.path == "/api/v2/events") | .query' "$LOG")
assert_contains "$state_query" 'after=0'
assert_contains "$state_query" 'workspace=ws-fictional-1'
assert_contains "$state_query" 'types=task.created%2Ctask.updated'
assert_contains "$state_query" 'include=text'
before_output_failure=$(sha256sum "$STATE" | cut -d' ' -f1)
reset_log
if "$BIN_TIMDO" --json events --state-file "$STATE" | head -c 0 >/dev/null; then
  fail 'state read ignored a closed output pipe'
fi
[[ "$(sha256sum "$STATE" | cut -d' ' -f1)" == "$before_output_failure" ]] || fail 'failed output advanced the checkpoint'
[[ "$(jq -s '[.[] | select(.path == "/api/v2/events")] | length' "$LOG")" -eq 1 ]] || fail 'failed state output fetched an unexpected number of pages'

# Explicit flags are compared only when supplied; a conflict fails before fetching events.
reset_log
if output=$(run_cli events --state-file "$STATE" --include-refs 2>&1); then fail 'accepted conflicting include option'; fi
assert_contains "$output" 'conflict'
[[ "$(jq -s '[.[] | select(.path == "/api/v2/events")] | length' "$LOG")" -eq 0 ]] || fail 'conflicting state read fetched events'
if output=$(run_cli events --state-file "$STATE" --after latest 2>&1); then fail 'accepted conflicting after cursor'; fi
assert_contains "$output" 'conflict'
if output=$(run_cli events --state-file "$STATE" --types task.completed 2>&1); then fail 'accepted conflicting type filter'; fi
assert_contains "$output" 'conflict'
if output=$(EVENTS_MOCK_SECOND_WORKSPACE=1 run_cli events --state-file "$STATE" --workspace another-fictional-workspace 2>&1); then
  fail 'accepted conflicting workspace scope'
fi
assert_contains "$output" 'conflict'
[[ "$(jq -s '[.[] | select(.path == "/api/v2/events")] | length' "$LOG")" -eq 0 ]] || fail 'a conflicting state read fetched events'

# A different API or principal fails closed. The API mismatch does not send credentials to that base.
reset_log
if output=$(TIMDO_API=http://other-fixture.invalid/api/v2 run_cli events --state-file "$STATE" 2>&1); then fail 'accepted a checkpoint from another API'; fi
assert_contains "$output" 'API'
[[ ! -s "$LOG" ]] || fail 'API mismatch sent a request'
if output=$(EVENTS_MOCK_PRINCIPAL=user-fictional-2 run_cli events --state-file "$STATE" 2>&1); then fail 'accepted a different principal'; fi
assert_contains "$output" 'principal'

# A personal token stays selected; denial does not retry with the configured owner secret.
reset_log
if output=$(TIMDO_TOKEN=tdo_fixture_abcdefghijklmnopqrstuvwxyz123456 TIMDO_SECRET=fixture-secret EVENTS_MOCK_DENY_ME=1 run_cli events --state-file "$STATE" 2>&1); then
  fail 'accepted a denied token read'
fi
assert_contains "$output" 'Not signed in'
[[ "$(jq -s '[.[] | select(.path == "/api/v2/events" or .path == "/api/v2/users/me")] | length' "$LOG")" -eq 1 ]] || fail 'CLI retried the denied token using another credential'
[[ "$(jq -r '.authKind' "$LOG")" == Authorization ]] || fail 'state authentication did not use the selected token'
[[ "$(jq -r '.argsContainCredential' "$LOG")" == false ]] || fail 'a test credential appeared in curl argv'

# latest bootstrapping captures the server cursor and does not emit event bodies.
LATEST_STATE="$MOCK_DIR/private/latest.json"
reset_log
latest_init=$(EVENTS_MOCK_SCENARIO=latest run_cli --json events init --state-file "$LATEST_STATE" --after latest)
[[ "$(jq -r '.cursor' "$LATEST_STATE")" == 'c1.AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' ]] || fail 'latest init did not save the returned cursor'
[[ "$(jq -s '[.[] | select(.path == "/api/v2/events")] | length' "$LOG")" -eq 1 ]] || fail 'latest init did not fetch a boundary cursor'
assert_not_contains "$latest_init" 'evt-fictional'
BAD_LATEST_STATE="$MOCK_DIR/private/bad-latest.json"
jq '.cursor = "latest"' "$LATEST_STATE" > "$BAD_LATEST_STATE"
chmod 600 "$BAD_LATEST_STATE"
if output=$(run_cli events --state-file "$BAD_LATEST_STATE" 2>&1); then fail 'accepted latest as a persisted checkpoint cursor'; fi
assert_contains "$output" 'cursor'

# An omitted workspace is stored as the all-current-memberships scope.
ALL_STATE="$MOCK_DIR/private/all-scope.json"
reset_log
run_cli --json events init --state-file "$ALL_STATE" --after 0 >/dev/null
[[ "$(jq -r '.workspace' "$ALL_STATE")" == null ]] || fail 'all-workspace scope was not stored as null'
reset_log
all_scope_page=$(EVENTS_MOCK_SCENARIO=single run_cli --json events --state-file "$ALL_STATE")
[[ "$(jq -r '.events[0].id' <<< "$all_scope_page")" == evt-fictional-1 ]] || fail 'all-scope read lost page data'
all_scope_query=$(jq -r 'select(.path == "/api/v2/events") | .query' "$LOG")
assert_not_contains "$all_scope_query" 'workspace='

if output=$(run_cli events ack --state-file "$LATEST_STATE" --from latest --to 'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' 2>&1); then
  fail 'accepted latest as an acknowledgement source cursor'
fi
assert_contains "$output" 'cursor'

# Acknowledgement uses expected-old CAS, supports an already-next retry and refuses stale writes.
reset_log
ack_output=$(run_cli --json events ack --state-file "$LATEST_STATE" --from 'c1.AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' --to 'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
[[ "$(jq -r '.acknowledged' <<< "$ack_output")" == true ]] || fail 'ack did not report success'
[[ "$(jq -r '.cursor' "$LATEST_STATE")" == 'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' ]] || fail 'ack did not atomically advance cursor'
[[ "$(stat -c '%a' "$LATEST_STATE")" == 600 ]] || fail 'ack changed checkpoint mode'
run_cli events ack --state-file "$LATEST_STATE" --from 'c1.AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' --to 'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' >/dev/null
if output=$(run_cli events ack --state-file "$LATEST_STATE" --from 'c1.AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' --to 'c1.AwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' 2>&1); then fail 'accepted stale acknowledgement'; fi
assert_contains "$output" 'conflict'
[[ "$(jq -r '.cursor' "$LATEST_STATE")" == 'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' ]] || fail 'stale ack changed checkpoint'

# Corruption, symlinks and an existing lock are rejected without removing anyone else's files.
printf '{broken' > "$MOCK_DIR/private/corrupt.json"
if output=$(run_cli events --state-file "$MOCK_DIR/private/corrupt.json" 2>&1); then fail 'accepted corrupt checkpoint'; fi
assert_contains "$output" 'checkpoint'
BAD_UTF8="$MOCK_DIR/private/bad-utf8.json"
cp "$STATE" "$BAD_UTF8"
node -e 'const fs = require("node:fs"); const p = process.argv[1]; const b = fs.readFileSync(p); const marker = Buffer.from("user-fictional-1"); const index = b.indexOf(marker); if (index < 0) process.exit(2); b[index] = 0xff; fs.writeFileSync(p, b);' "$BAD_UTF8"
chmod 600 "$BAD_UTF8"
if output=$(run_cli events --state-file "$BAD_UTF8" 2>&1); then fail 'accepted invalid UTF-8 checkpoint'; fi
assert_contains "$output" 'corrupt'
cp "$STATE" "$MOCK_DIR/private/open-mode.json"
chmod 644 "$MOCK_DIR/private/open-mode.json"
if output=$(run_cli events --state-file "$MOCK_DIR/private/open-mode.json" 2>&1); then fail 'accepted a checkpoint readable by other users'; fi
assert_contains "$output" '0600'
OPEN_PARENT="$MOCK_DIR/open-parent"
mkdir "$OPEN_PARENT"
chmod 777 "$OPEN_PARENT"
cp "$STATE" "$OPEN_PARENT/state.json"
chmod 600 "$OPEN_PARENT/state.json"
if output=$(run_cli events --state-file "$OPEN_PARENT/state.json" 2>&1); then fail 'accepted a checkpoint in a non-private directory'; fi
assert_contains "$output" 'writable'
ln -s "$STATE" "$MOCK_DIR/private/state-link.json"
if output=$(run_cli events --state-file "$MOCK_DIR/private/state-link.json" 2>&1); then fail 'accepted a symlink checkpoint'; fi
assert_contains "$output" 'symlink'
LOCK="$LATEST_STATE.lock"
printf 'owned by another process\n' > "$LOCK"
if output=$(run_cli events ack --state-file "$LATEST_STATE" --from 'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' --to 'c1.AwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' 2>&1); then fail 'ack proceeded through an existing lock'; fi
[[ "$output" == *lock* ]] || fail "lock conflict returned: $output"
[[ -f "$LOCK" ]] || fail 'failed ack removed another operation lock'
rm "$LOCK"

# Two concurrent acknowledgements serialize on the owned lock; the loser must retry from the new cursor.
cat > "$MOCK_DIR/state-hook.cjs" <<'NODEEOF'
const fs = require('node:fs');
const rename = fs.renameSync;
fs.renameSync = function (...args) {
  if (process.env.EVENTS_TEST_FAIL_RENAME === '1') throw new Error('simulated interrupted replacement');
  if (process.env.EVENTS_TEST_BLOCK_RENAME === '1') {
    fs.writeFileSync(process.env.EVENTS_TEST_READY_FILE, 'ready');
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !fs.existsSync(process.env.EVENTS_TEST_RELEASE_FILE)) {
      Atomics.wait(waitCell, 0, 0, 20);
    }
  }
  return rename.apply(this, args);
};
const unlink = fs.unlinkSync;
let failedTempUnlink = false;
fs.unlinkSync = function (...args) {
  if (process.env.EVENTS_TEST_FAIL_INIT_UNLINK === '1' && !failedTempUnlink && String(args[0]).endsWith('.tmp')) {
    failedTempUnlink = true;
    throw new Error('simulated one-time temp unlink failure');
  }
  return unlink.apply(this, args);
};
const link = fs.linkSync;
fs.linkSync = function (...args) {
  const result = link.apply(this, args);
  if (process.env.EVENTS_TEST_KILL_AFTER_LINK === '1') {
    fs.writeFileSync(process.env.EVENTS_TEST_LINK_READY_FILE, JSON.stringify({ source: args[0], target: args[1] }));
    process.kill(process.pid, 'SIGKILL');
  }
  return result;
};
NODEEOF
INTERRUPT_STATE="$MOCK_DIR/private/interrupted.json"
run_cli events init --state-file "$INTERRUPT_STATE" --after 0 >/dev/null
interrupt_before=$(sha256sum "$INTERRUPT_STATE" | cut -d' ' -f1)
if output=$(EVENTS_TEST_FAIL_RENAME=1 NODE_OPTIONS="--require=$MOCK_DIR/state-hook.cjs" run_cli events ack --state-file "$INTERRUPT_STATE" --from 0 --to 'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' 2>&1); then
  fail 'accepted a failed atomic checkpoint replacement'
fi
assert_contains "$output" 'simulated interrupted replacement'
[[ "$(sha256sum "$INTERRUPT_STATE" | cut -d' ' -f1)" == "$interrupt_before" ]] || fail 'interrupted ack changed the prior checkpoint'
[[ ! -e "$INTERRUPT_STATE.lock" ]] || fail 'interrupted ack left its owned lock behind'
interrupted_temps=$(find "$MOCK_DIR/private" -maxdepth 1 -type f -name '.interrupted.json.timdo-*.tmp' | wc -l | tr -d ' ')
[[ "$interrupted_temps" == 0 ]] || fail 'interrupted ack left its owned temporary file behind'

# A one-time unlink error after init links the file is repaired under the owned lock.
RECOVERED_INIT_STATE="$MOCK_DIR/private/recovered-init.json"
if ! EVENTS_TEST_FAIL_INIT_UNLINK=1 NODE_OPTIONS="--require=$MOCK_DIR/state-hook.cjs" timeout 10s \
  "$BIN_TIMDO" events init --state-file "$RECOVERED_INIT_STATE" --after 0 > "$MOCK_DIR/recovered-init.out" 2> "$MOCK_DIR/recovered-init.err"; then
  fail 'init did not recover from a transient temporary-link cleanup failure'
fi
[[ "$(stat -c '%h' "$RECOVERED_INIT_STATE")" == 1 ]] || fail 'recovered init left a hard-linked checkpoint'
[[ ! -e "$RECOVERED_INIT_STATE.lock" ]] || fail 'recovered init left its owned lock behind'
RECOVERED_INIT=$(timeout 5s node "$ROOT_DIR/bin/timdo-events-state.js" read "$RECOVERED_INIT_STATE")
[[ "$(jq -r '.cursor' <<< "$RECOVERED_INIT")" == 0 ]] || fail 'recovered init checkpoint could not be read'
recovered_init_temps=$(find "$MOCK_DIR/private" -maxdepth 1 -type f -name '.recovered-init.json.timdo-*.tmp' | wc -l | tr -d ' ')
[[ "$recovered_init_temps" == 0 ]] || fail 'recovered init left its owned temporary file behind'

# A killed init leaves a verified pair that a later read repairs after explicit stale-lock removal.
CRASH_STATE="$MOCK_DIR/private/crash-init.json"
CRASH_LINK_MARKER="$MOCK_DIR/init-linked.json"
if EVENTS_TEST_KILL_AFTER_LINK=1 EVENTS_TEST_LINK_READY_FILE="$CRASH_LINK_MARKER" \
  NODE_OPTIONS="--require=$MOCK_DIR/state-hook.cjs" timeout 10s \
  "$BIN_TIMDO" events init --state-file "$CRASH_STATE" --after 0 > "$MOCK_DIR/crash-init.out" 2> "$MOCK_DIR/crash-init.err"; then
  fail 'init unexpectedly survived the simulated post-link crash'
fi
[[ -s "$CRASH_LINK_MARKER" ]] || fail 'crash fixture did not record the linked temp path'
CRASH_TEMP=$(jq -r '.source' "$CRASH_LINK_MARKER")
[[ -f "$CRASH_STATE" && -f "$CRASH_TEMP" && -f "$CRASH_STATE.lock" ]] || fail 'post-link crash did not leave its expected recovery files'
[[ "$(stat -c '%h' "$CRASH_STATE")" == 2 ]] || fail 'post-link crash did not reproduce the hard-linked target'
CRASH_LOCK_HASH=$(sha256sum "$CRASH_STATE.lock" | cut -d' ' -f1)
if output=$(timeout 5s node "$ROOT_DIR/bin/timdo-events-state.js" read "$CRASH_STATE" 2>&1); then
  fail 'read automatically removed the stale checkpoint lock'
fi
assert_contains "$output" 'lock'
[[ -f "$CRASH_STATE.lock" && "$(sha256sum "$CRASH_STATE.lock" | cut -d' ' -f1)" == "$CRASH_LOCK_HASH" ]] \
  || fail 'failed recovery changed the existing lock'
[[ "$(stat -c '%h' "$CRASH_STATE")" == 2 ]] || fail 'failed recovery changed the linked target'
UNKNOWN_TEMP="$MOCK_DIR/private/.crash-init.json.timdo-999-0123456789abcdef.tmp"
printf 'unrelated fictional file\n' > "$UNKNOWN_TEMP"
chmod 600 "$UNKNOWN_TEMP"
rm -- "$CRASH_STATE.lock"
RECOVERED_CRASH=$(timeout 5s node "$ROOT_DIR/bin/timdo-events-state.js" read "$CRASH_STATE")
[[ "$(jq -r '.cursor' <<< "$RECOVERED_CRASH")" == 0 ]] || fail 'read did not recover the checkpoint after stale-lock removal'
[[ "$(stat -c '%h' "$CRASH_STATE")" == 1 ]] || fail 'crash recovery did not leave one checkpoint link'
[[ ! -e "$CRASH_TEMP" ]] || fail 'crash recovery left its verified temporary hard link'
[[ -f "$UNKNOWN_TEMP" ]] || fail 'crash recovery removed an unrelated similarly named file'

CONCURRENT_STATE="$MOCK_DIR/private/concurrent.json"
READY_FILE="$MOCK_DIR/rename-ready"
RELEASE_FILE="$MOCK_DIR/rename-release"
run_cli events init --state-file "$CONCURRENT_STATE" --after 0 >/dev/null
EVENTS_TEST_BLOCK_RENAME=1 EVENTS_TEST_READY_FILE="$READY_FILE" EVENTS_TEST_RELEASE_FILE="$RELEASE_FILE" \
  NODE_OPTIONS="--require=$MOCK_DIR/state-hook.cjs" "$BIN_TIMDO" events ack --state-file "$CONCURRENT_STATE" --from 0 --to 'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' > "$MOCK_DIR/ack-a.out" 2> "$MOCK_DIR/ack-a.err" &
ACK_A_PID=$!
for _ in $(seq 1 500); do
  [[ -e "$READY_FILE" && -e "$CONCURRENT_STATE.lock" ]] && break
  kill -0 "$ACK_A_PID" 2>/dev/null || break
  sleep 0.01
done
if [[ ! -e "$READY_FILE" || ! -e "$CONCURRENT_STATE.lock" ]]; then
  : > "$RELEASE_FILE"
  wait "$ACK_A_PID" 2>/dev/null || true
  fail 'first concurrent acknowledgement did not reach the held rename'
fi
if output=$(NODE_OPTIONS="--require=$MOCK_DIR/state-hook.cjs" run_cli events ack --state-file "$CONCURRENT_STATE" --from 0 --to 'c1.AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' 2>&1); then
  second_status=0
else
  second_status=$?
fi
: > "$RELEASE_FILE"
wait "$ACK_A_PID" || fail 'first concurrent acknowledgement failed'
[[ "$second_status" -ne 0 ]] || fail 'second concurrent acknowledgement unexpectedly succeeded'
[[ "$output" == *lock* ]] || fail "concurrent lock conflict returned: $output"
[[ ! -e "$CONCURRENT_STATE.lock" ]] || fail 'successful ack left its owned lock behind'
final_cursor=$(jq -r '.cursor' "$CONCURRENT_STATE")
[[ "$final_cursor" == 'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' ]] || fail 'concurrent acknowledgement did not leave one complete cursor'
if output=$(run_cli events ack --state-file "$CONCURRENT_STATE" --from 0 --to 'c1.AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' 2>&1); then
  fail 'stale concurrent acknowledgement was accepted'
fi
assert_contains "$output" 'conflict'

# Output failure stops follow before another page is fetched; fetch failure returns an error.
reset_log
if EVENTS_MOCK_SCENARIO=follow "$BIN_TIMDO" --json events --follow --interval 3600 2>"$MOCK_DIR/output.err" | head -c 0 >/dev/null; then
  fail 'follow ignored a closed output pipe'
fi
[[ "$(jq -s '[.[] | select(.path == "/api/v2/events")] | length' "$LOG")" -eq 1 ]] || fail 'follow fetched another page after output failed'
reset_log
if output=$(EVENTS_MOCK_SCENARIO=transport run_cli --json events --follow --interval 3600 2>&1); then fail 'accepted failed follow transport'; fi
assert_contains "$output" 'could not reach the TimDo API'
assert_contains "$output" 'fixture transport failure'
reset_log
if output=$(EVENTS_MOCK_SCENARIO=error run_cli --json events --follow --interval 3600 2>&1); then fail 'accepted a failed follow HTTP response'; fi
assert_contains "$output" 'cursor_unavailable'
assert_contains "$output" 'fixture failure'
reset_log
if output=$(EVENTS_MOCK_SCENARIO=stale run_cli --json events --after 'c1.AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' 2>&1); then fail 'accepted stale cursor'; fi
assert_contains "$output" 'stale_cursor'
assert_not_contains "$output" 'Already tracked'
reset_log
if output=$(EVENTS_MOCK_SCENARIO=loop run_cli --json events --after 'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' --follow --interval 3600 2>&1); then fail 'accepted a non-progressing follow cursor'; fi
assert_contains "$output" 'cursor did not advance'
[[ "$(jq -s '[.[] | select(.path == "/api/v2/events")] | length' "$LOG")" -eq 1 ]] || fail 'non-progressing follow cursor spun on repeated requests'
reset_log
if output=$(TIMDO_API="${TIMDO_API}/" EVENTS_MOCK_SCENARIO=single run_cli --json events 2>&1); then :; else fail "trailing-slash API base failed: $output"; fi
trailing_query=$(jq -r 'select(.path == "/api/v2/events") | .query' "$LOG")
assert_not_contains "$trailing_query" '/api/v2//'

printf 'ALL CLI EVENTS TESTS PASSED!\n'
