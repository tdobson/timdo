#!/usr/bin/env bash
set -euo pipefail

# Test suite for TimDo CLI Hierarchy features (categories, epics, goals, poster export)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_TIMDO="$ROOT_DIR/bin/timdo"

# Mock server or mock API test using a lightweight local mock server or curl interception
MOCK_PORT=9876
MOCK_PID=""
MOCK_DIR=$(mktemp -d)

cleanup() {
  if [[ -n "$MOCK_PID" ]]; then
    kill "$MOCK_PID" 2>/dev/null || true
  fi
  rm -rf "$MOCK_DIR"
}
trap cleanup EXIT

# Create a small python mock HTTP server
cat << 'PYEOF' > "$MOCK_DIR/server.py"
import http.server
import json
import urllib.parse
import sys

EPICS = [
    {
        "id": "epic-1234-abcd",
        "userId": "user-1",
        "title": "Acme Solar Installation",
        "description": "Install rooftop solar system",
        "category": "Acme Solar",
        "goalId": "goal-aim-1",
        "status": "active",
        "totalTasks": 2,
        "doneTasks": 1,
        "progressPercentage": 50,
        "createdAt": "2026-08-30T10:00:00Z",
        "updatedAt": "2026-08-30T10:00:00Z"
    }
]

GOALS = [
    {
        "id": "goal-aim-1",
        "userId": "user-1",
        "type": "aim",
        "title": "Workshop Planning",
        "description": "Prepare for the next workshop",
        "icon": "sun",
        "orderIndex": 1,
        "isActive": True,
        "createdAt": "2026-08-30T10:00:00Z",
        "updatedAt": "2026-08-30T10:00:00Z"
    },
    {
        "id": "goal-focus-1",
        "userId": "user-1",
        "type": "focus",
        "title": "Acme Solar Launch",
        "description": "Complete product launch",
        "icon": "rocket",
        "orderIndex": 2,
        "isActive": True,
        "createdAt": "2026-08-30T10:00:00Z",
        "updatedAt": "2026-08-30T10:00:00Z"
    },
    {
        "id": "goal-val-1",
        "userId": "user-1",
        "type": "value",
        "title": "Thoughtful Planning",
        "description": "Make clear decisions",
        "icon": "target",
        "orderIndex": 3,
        "isActive": True,
        "createdAt": "2026-08-30T10:00:00Z",
        "updatedAt": "2026-08-30T10:00:00Z"
    },
    {
        "id": "goal-house-1",
        "userId": "user-1",
        "type": "housekeeping",
        "title": "Weekly Task Review",
        "description": "Review open items once a week",
        "icon": "mail",
        "orderIndex": 4,
        "isActive": True,
        "createdAt": "2026-08-30T10:00:00Z",
        "updatedAt": "2026-08-30T10:00:00Z"
    }
]

PROJECTS = [
    {
        "id": "proj-1111-aaaa",
        "userId": "user-1",
        "project": "Order solar panels",
        "reason": "Required for setup",
        "status": "do",
        "priority": 8,
        "size": "***",
        "category": "Acme Solar",
        "epicId": "epic-1234-abcd",
        "goalId": "goal-aim-1",
        "isDeleted": False,
        "createdAt": "2026-08-30T10:00:00Z",
        "updatedAt": "2026-08-30T10:00:00Z"
    },
    {
        "id": "proj-2222-bbbb",
        "userId": "user-1",
        "project": "Personal workshop notes",
        "reason": "Prepare before the next workshop",
        "status": "do",
        "priority": 6,
        "size": "**",
        "category": "Personal",
        "epicId": None,
        "goalId": None,
        "isDeleted": False,
        "createdAt": "2026-08-30T10:00:00Z",
        "updatedAt": "2026-08-30T10:00:00Z"
    }
]

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass # Quiet

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/api/v2/goals/poster.svg":
            svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text>Life Goals Poster</text></svg>'
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml; charset=utf-8")
            self.end_headers()
            self.wfile.write(svg.encode("utf-8"))
            return

        if path == "/api/v2/poster/wall-of-done":
            cat = query.get("categories", [None])[0]
            svg = f'<svg xmlns="http://www.w3.org/2000/svg"><text>Wall of Done Poster {cat or "all"}</text></svg>'
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml; charset=utf-8")
            self.end_headers()
            self.wfile.write(svg.encode("utf-8"))
            return

        if path == "/api/v2/poster/active":
            cat = query.get("categories", [None])[0]
            svg = f'<svg xmlns="http://www.w3.org/2000/svg"><text>Active Tasks Poster {cat or "all"}</text></svg>'
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml; charset=utf-8")
            self.end_headers()
            self.wfile.write(svg.encode("utf-8"))
            return

        if path == "/api/v2/epics":
            cat = query.get("category", [None])[0]
            result = EPICS
            if cat:
                result = [e for e in EPICS if e.get("category") == cat]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode("utf-8"))
            return

        if path == "/api/v2/goals":
            g_type = query.get("type", [None])[0]
            result = GOALS
            if g_type:
                result = [g for g in GOALS if g.get("type") == g_type]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode("utf-8"))
            return

        if path == "/api/v2/projects":
            cat = query.get("category", [None])[0]
            epic = query.get("epicId", [None])[0]
            goal = query.get("goalId", [None])[0]
            result = [p for p in PROJECTS if not p.get("isDeleted")]
            if cat:
                result = [p for p in result if p.get("category") == cat]
            if epic:
                result = [p for p in result if p.get("epicId") == epic]
            if goal:
                result = [p for p in result if p.get("goalId") == goal]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length > 0 else {}

        if path == "/api/v2/epics":
            new_epic = {
                "id": "epic-" + str(len(EPICS) + 1),
                "userId": "user-1",
                "title": body.get("title"),
                "description": body.get("description"),
                "category": body.get("category"),
                "goalId": body.get("goalId"),
                "status": body.get("status", "active"),
                "totalTasks": 0,
                "doneTasks": 0,
                "progressPercentage": 0,
                "createdAt": "2026-08-31T10:00:00Z",
                "updatedAt": "2026-08-31T10:00:00Z"
            }
            EPICS.append(new_epic)
            self.send_response(201)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(new_epic).encode("utf-8"))
            return

        if path == "/api/v2/projects":
            new_proj = {
                "id": "proj-" + str(len(PROJECTS) + 1),
                "userId": "user-1",
                "project": body.get("project"),
                "reason": body.get("reason"),
                "status": body.get("status", "do"),
                "priority": body.get("priority", 5),
                "size": body.get("size", "***"),
                "notes": body.get("notes"),
                "category": body.get("category"),
                "epicId": body.get("epicId"),
                "goalId": body.get("goalId"),
                "isDeleted": False,
                "createdAt": "2026-08-31T10:00:00Z",
                "updatedAt": "2026-08-31T10:00:00Z"
            }
            PROJECTS.append(new_proj)
            self.send_response(201)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(new_proj).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()

server = http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler)
server.serve_forever()
PYEOF

python3 "$MOCK_DIR/server.py" "$MOCK_PORT" &
MOCK_PID=$!
sleep 0.5

# Test Environment
export TIMDO_API="http://127.0.0.1:$MOCK_PORT/api/v2"
export TIMDO_SECRET="test-secret"
export TIMDO_FORMAT="text"

echo "=== 1. Testing 'bin/timdo epic list' ==="
EPIC_LIST_OUTPUT=$("$BIN_TIMDO" epic list)
echo "$EPIC_LIST_OUTPUT"
if [[ "$EPIC_LIST_OUTPUT" != *"Acme Solar"* || "$EPIC_LIST_OUTPUT" != *"50%"* ]]; then
  echo "FAIL: Expected 'Acme Solar' with 50% in epic list" >&2
  exit 1
fi
echo "PASS: epic list"

echo "=== 2. Testing 'bin/timdo epic add' ==="
EPIC_ADD_JSON=$("$BIN_TIMDO" epic add "Launch Mobile App" -p "Acme Solar" -g "Workshop Planning")
echo "$EPIC_ADD_JSON"
if [[ "$EPIC_ADD_JSON" != *"Launch Mobile App"* || "$EPIC_ADD_JSON" != *"Acme Solar"* ]]; then
  echo "FAIL: Expected created epic with title and category" >&2
  exit 1
fi
echo "PASS: epic add"

echo "=== 3. Testing 'bin/timdo goal list' ==="
GOAL_LIST_OUTPUT=$("$BIN_TIMDO" goal list)
echo "$GOAL_LIST_OUTPUT"
if [[ "$GOAL_LIST_OUTPUT" != *"Workshop Planning"* || "$GOAL_LIST_OUTPUT" != *"AIM"* || "$GOAL_LIST_OUTPUT" != *"FOCUS"* ]]; then
  echo "FAIL: Expected grouped goals list" >&2
  exit 1
fi
echo "PASS: goal list"

echo "=== 4. Testing 'bin/timdo add' with -p (category), -e (epic), and -g (goal) ==="
ADD_TASK_JSON=$("$BIN_TIMDO" add "Prepare installation plan" -p "Acme Solar" -e "Acme Solar Installation" -g "Workshop Planning")
echo "$ADD_TASK_JSON"
if [[ "$ADD_TASK_JSON" != *"Prepare installation plan"* || "$ADD_TASK_JSON" != *"Acme Solar"* || "$ADD_TASK_JSON" != *"epic-1234-abcd"* ]]; then
  echo "FAIL: Expected task with category and resolved epicId" >&2
  exit 1
fi
echo "PASS: add task with hierarchy"

echo "=== 5. Testing 'bin/timdo list -p <Category>' ==="
LIST_CAT_OUTPUT=$("$BIN_TIMDO" list do -p "Acme Solar")
echo "$LIST_CAT_OUTPUT"
if [[ "$LIST_CAT_OUTPUT" != *"Order solar panels"* || "$LIST_CAT_OUTPUT" == *"Personal workshop notes"* ]]; then
  echo "FAIL: Expected category filtered list containing only Acme Solar tasks" >&2
  exit 1
fi
echo "PASS: list with category filter -p"

echo "=== 6. Testing 'bin/timdo list --epic <Epic>' ==="
LIST_EPIC_OUTPUT=$("$BIN_TIMDO" list --epic "Acme Solar Installation")
echo "$LIST_EPIC_OUTPUT"
if [[ "$LIST_EPIC_OUTPUT" != *"Order solar panels"* || "$LIST_EPIC_OUTPUT" == *"Personal workshop notes"* ]]; then
  echo "FAIL: Expected epic filtered list" >&2
  exit 1
fi
echo "PASS: list with epic filter"

echo "=== 7. Testing 'bin/timdo poster --output <path>' ==="
POSTER_FILE="$MOCK_DIR/poster.svg"
"$BIN_TIMDO" poster --output "$POSTER_FILE"
if [[ ! -f "$POSTER_FILE" || "$(< "$POSTER_FILE")" != *"Life Goals Poster"* ]]; then
  echo "FAIL: Expected poster SVG file to be downloaded" >&2
  exit 1
fi
echo "PASS: poster export"

echo "=== 8. Testing 'bin/timdo poster' with --type and -c/--category ==="
POSTER_DONE_FILE="$MOCK_DIR/done.svg"
"$BIN_TIMDO" poster --type done -c "Acme Solar" --output "$POSTER_DONE_FILE"
if [[ ! -f "$POSTER_DONE_FILE" || "$(< "$POSTER_DONE_FILE")" != *"Wall of Done Poster Acme Solar"* ]]; then
  echo "FAIL: Expected wall of done poster SVG file with Acme Solar category" >&2
  exit 1
fi
echo "PASS: poster done with category"

POSTER_ACTIVE_FILE="$MOCK_DIR/active.svg"
"$BIN_TIMDO" poster --type active --category "Acme Solar,Northstar Workshop" --output "$POSTER_ACTIVE_FILE"
if [[ ! -f "$POSTER_ACTIVE_FILE" || "$(< "$POSTER_ACTIVE_FILE")" != *"Active Tasks Poster Acme Solar,Northstar Workshop"* ]]; then
  echo "FAIL: Expected active poster SVG file with Acme Solar,Northstar Workshop categories" >&2
  exit 1
fi
echo "PASS: poster active with multiple categories"

echo "ALL TESTS PASSED!"
