#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_TIMDO="$ROOT_DIR/bin/timdo"

echo "=== 1. Testing Mandatory -p / --project on add ==="
output=$(TIMDO_CONFIG=/dev/null TIMDO_SECRET=test-secret "$BIN_TIMDO" add "Task without project" 2>&1 || true)
if ! echo "$output" | grep -qi "error.*project"; then
  echo "FAIL: Expected error requiring -p/--project when running 'timdo add'" >&2
  echo "Got output: $output" >&2
  exit 1
fi
echo "PASS: timdo add requires -p/--project"

# Set up mock server for testing CLI commands against mock backend
MOCK_PORT=9879
MOCK_PID=""
MOCK_DIR=$(mktemp -d)

cleanup() {
  if [[ -n "$MOCK_PID" ]]; then
    kill "$MOCK_PID" 2>/dev/null || true
  fi
  rm -rf "$MOCK_DIR"
}
trap cleanup EXIT

cat << 'PYEOF' > "$MOCK_DIR/server.py"
import http.server
import json
import urllib.parse
import sys

CASEY = "user-casey"
JORDAN = "user-jordan"

def task(tid, title, priority, assignee_id, assignee_name):
    return {
        "id": tid, "userId": CASEY, "project": title, "category": "Acme Solar", "status": "do",
        "priority": priority, "size": "***", "isDeleted": False,
        "createdAt": "2026-09-15T10:00:00Z", "updatedAt": "2026-09-15T10:00:00Z",
        "projectId": "proj-acme-solar", "projectKey": "ACS", "projectName": "Acme Solar",
        "orgId": "org-northstar-workshop", "orgName": "Northstar Workshop", "isShared": True, "myRole": "owner", "canEdit": True,
        "reporterId": CASEY, "reporterName": "Casey Example",
        "assigneeId": assignee_id, "assigneeName": assignee_name,
        "updatedById": CASEY, "updatedByName": "Casey Example",
        "isMine": assignee_id == CASEY or (assignee_id is None),
    }

PROJECTS = [
    task("11111111-aaaa-bbbb-cccc-111111111111", "Acme Solar Core Schema", 10, CASEY, "Casey Example"),
    task("22222222-aaaa-bbbb-cccc-222222222222", "Review OAuth PR", 8, JORDAN, "Jordan Example"),
    task("33333333-aaaa-bbbb-cccc-333333333333", "DNS CNAME Configuration", 6, None, None),
]

ORGANISATIONS = [
    {"id": "org-northstar-workshop", "name": "Northstar Workshop", "slug": "northstar-workshop", "role": "owner", "isPersonal": False, "memberCount": 2, "projectCount": 1}
]

ORG_MEMBERS = [
    {"id": "member-1", "orgId": "org-northstar-workshop", "userId": CASEY, "userName": "Casey Example", "userEmail": "casey@example.test", "role": "owner"},
    {"id": "member-2", "orgId": "org-northstar-workshop", "userId": JORDAN, "userName": "Jordan Example", "userEmail": "jordan@example.test", "role": "admin"},
]

SHARING = [dict(ORGANISATIONS[0],
    members=[dict(m, isMe=(m["userId"] == CASEY)) for m in ORG_MEMBERS],
    projects=[{"id": "proj-acme-solar", "key": "ACS", "name": "Acme Solar", "openTasks": 3, "doneTasks": 0, "epicCount": 0}],
    invites=[])]

def send(handler, code, payload):
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.end_headers()
    handler.wfile.write(json.dumps(payload).encode("utf-8"))

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length > 0 else {}

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/api/v2/projects":
            rows = PROJECTS
            a = q.get("assignee", [None])[0]
            if a == "me":
                rows = [t for t in rows if t["isMine"]]
            elif a == "unassigned":
                rows = [t for t in rows if t["assigneeId"] is None]
            elif a:
                rows = [t for t in rows if t["assigneeId"] == a]
            return send(self, 200, rows)
        if parsed.path == "/api/v2/users/me":
            return send(self, 200, {"id": CASEY, "email": "casey@example.test", "name": "Casey Example"})
        if parsed.path == "/api/v2/organisations":
            return send(self, 200, ORGANISATIONS)
        if parsed.path == "/api/v2/organisations/sharing":
            return send(self, 200, SHARING)
        if parsed.path.startswith("/api/v2/organisations/") and parsed.path.endswith("/members"):
            return send(self, 200, ORG_MEMBERS)
        send(self, 404, {"error": "Not found"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        body = self.body()
        if parsed.path == "/api/v2/projects":
            created = dict(body)
            created["id"] = "new-project-id-12345678"
            return send(self, 201, created)
        if parsed.path.startswith("/api/v2/organisations/") and parsed.path.endswith("/invites"):
            return send(self, 201, {"status": "invited", "id": "inv-1", "email": body.get("email"), "role": body.get("role"), "token": "tok-123", "expiresAt": "2026-11-07T00:00:00Z"})
        send(self, 404, {"error": "Not found"})

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        body = self.body()
        if parsed.path.startswith("/api/v2/projects/"):
            task_id = parsed.path.split("/")[-1]
            return send(self, 200, {"id": task_id, **body})
        send(self, 404, {"error": "Not found"})

server = http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler)
server.serve_forever()
PYEOF

python3 "$MOCK_DIR/server.py" "$MOCK_PORT" &
MOCK_PID=$!
# Wait for the mock to accept connections (a fixed sleep is flaky on a busy machine)
for _ in $(seq 1 100); do
  curl -s -o /dev/null "http://127.0.0.1:$MOCK_PORT/" && break
  sleep 0.1
done

export TIMDO_API="http://127.0.0.1:$MOCK_PORT/api/v2"
export TIMDO_SECRET="test-secret"
export TIMDO_CONFIG=/dev/null

echo "=== 2. Testing timdo add with -p and --assignee ==="
add_output=$("$BIN_TIMDO" add "Setup Grafana monitoring" -p "Acme Solar" --assignee "Jordan" --json)
if ! echo "$add_output" | jq -e '.category == "Acme Solar" and .assigneeId == "user-jordan"' > /dev/null; then
  echo "FAIL: timdo add did not correctly send project and assignee" >&2
  echo "Got output: $add_output" >&2
  exit 1
fi
echo "PASS: timdo add with -p and --assignee"

echo "=== 3. Testing timdo list filters (--mine, --unassigned, --assignee) ==="
mine_output=$("$BIN_TIMDO" list --mine --json)
mine_count=$(echo "$mine_output" | jq 'length')
# assignee=me means assigned to me, or unassigned and created by me
if [[ "$mine_count" -ne 2 ]]; then
  echo "FAIL: Expected 2 tasks for --mine, got $mine_count" >&2
  exit 1
fi

unassigned_output=$("$BIN_TIMDO" list --unassigned --json)
unassigned_count=$(echo "$unassigned_output" | jq 'length')
if [[ "$unassigned_count" -ne 1 ]]; then
  echo "FAIL: Expected 1 task for --unassigned, got $unassigned_count" >&2
  exit 1
fi

assignee_output=$("$BIN_TIMDO" list --assignee "Jordan" --json)
assignee_count=$(echo "$assignee_output" | jq 'length')
if [[ "$assignee_count" -ne 1 ]]; then
  echo "FAIL: Expected 1 task for --assignee Jordan, got $assignee_count" >&2
  exit 1
fi
echo "PASS: timdo list filters (--mine, --unassigned, --assignee)"

echo "=== 4. Testing timdo update assignment flags (--claim, --assign, --unassign) ==="
claim_output=$("$BIN_TIMDO" update 33333333 --claim)
if ! echo "$claim_output" | jq -e '.assigneeId == "user-casey"' > /dev/null; then
  echo "FAIL: timdo update --claim did not assign the task to the current user" >&2
  echo "Got output: $claim_output" >&2
  exit 1
fi

assign_output=$("$BIN_TIMDO" update 33333333 --assign "jordan@example.test")
if ! echo "$assign_output" | jq -e '.assigneeId == "user-jordan"' > /dev/null; then
  echo "FAIL: timdo update --assign did not resolve jordan@example.test to Jordan Example's user id" >&2
  echo "Got output: $assign_output" >&2
  exit 1
fi

unassign_output=$("$BIN_TIMDO" update 33333333 --unassign)
if ! echo "$unassign_output" | jq -e 'has("assigneeId") and .assigneeId == null' > /dev/null; then
  echo "FAIL: timdo update --unassign did not clear assignee" >&2
  echo "Got output: $unassign_output" >&2
  exit 1
fi
echo "PASS: timdo update assignment flags"

echo "=== 5. Testing timdo org subcommands (list, members, invite) ==="
org_list_output=$("$BIN_TIMDO" org list)
if ! echo "$org_list_output" | grep -q "Northstar Workshop"; then
  echo "FAIL: timdo org list did not return Northstar Workshop" >&2
  echo "Got output: $org_list_output" >&2
  exit 1
fi

org_members_output=$("$BIN_TIMDO" org members "Northstar Workshop")
if ! echo "$org_members_output" | grep -q "Jordan Example"; then
  echo "FAIL: timdo org members did not return Jordan Example" >&2
  echo "Got output: $org_members_output" >&2
  exit 1
fi

org_invite_output=$("$BIN_TIMDO" org invite "Northstar Workshop" "newuser@example.test" --role admin)
if ! echo "$org_invite_output" | grep -q "Invited newuser@example.test" || ! echo "$org_invite_output" | grep -q "/invite/tok-123"; then
  echo "FAIL: timdo org invite did not confirm invitation" >&2
  echo "Got output: $org_invite_output" >&2
  exit 1
fi
echo "PASS: timdo org subcommands (list, members, invite)"

echo "ALL CLI MULTI-USER TESTS PASSED!"
