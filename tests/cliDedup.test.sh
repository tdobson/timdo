#!/usr/bin/env bash
# CLI tests for no duplicates on create: --on-duplicate error|return|report on add, the similar-task
# question on a terminal (forced with TIMDO_FORCE_TTY=1 and answered through stdin), the stderr
# hints for scripts, and `timdo similar`. Runs bin/timdo against a small stateful Python mock of
# the v2 API that logs every request, so the tests can check exactly what the CLI sent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_TIMDO="$ROOT_DIR/bin/timdo"

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
import re
import sys
import urllib.parse

LOG = sys.argv[2]
ME = "user-sam"
ROBIN = "user-robin"
PROJECTS = {
    "proj-acme": {"id": "proj-acme", "key": "ACME", "name": "Acme Solar", "orgId": "org-acme", "orgName": "Acme"},
    "proj-home": {"id": "proj-home", "key": "HOME", "name": "Home", "orgId": "org-personal", "orgName": "Personal"},
    "proj-other": {"id": "proj-other", "key": "OTH", "name": "Other", "orgId": "org-other", "orgName": "Other"},
}
STOP = set("the and for with from that this into about are was were will can not but our your all any some".split())

def task(tid, title, project="proj-acme", status="do", assignee=ROBIN, reason="Members cannot see offers"):
    p = PROJECTS[project]
    names = {ME: "Sam Example", ROBIN: "Robin Fairweather"}
    return {
        "id": tid, "userId": ME, "project": title, "reason": reason, "status": status, "priority": 7,
        "size": "**", "isDeleted": False, "notes": None, "awaitUntil": None, "gmailThreadId": None,
        "category": p["name"], "customer": None, "tags": None, "epicId": None, "goalId": None,
        "createdAt": "2026-10-01T09:00:00Z", "updatedAt": "2026-10-08T13:02:00Z",
        "projectId": p["id"], "projectKey": p["key"], "projectName": p["name"], "orgId": p["orgId"],
        "orgName": p["orgName"], "isShared": p["orgId"] == "org-acme", "myRole": "owner", "canEdit": True,
        "reporterId": ME, "reporterName": "Sam Example", "assigneeId": assignee,
        "assigneeName": names.get(assignee), "updatedById": ME, "updatedByName": "Sam Example",
        "isMine": assignee == ME,
    }

T1 = "aaaa1111-0000-4000-8000-000000000001"
T2 = "bbbb2222-0000-4000-8000-000000000002"
T3 = "cccc3333-0000-4000-8000-000000000003"
T4 = "dddd4444-0000-4000-8000-000000000004"
T5 = "eeee5555-0000-4000-8000-000000000005"
TASKS = {
    T1: task(T1, "Broken offer page"),
    T2: task(T2, "Offer page banner missing", status="delay", assignee=None),
    T3: task(T3, "Old offer page audit", status="done"),
    T4: task(T4, "Offer page wording at home", project="proj-home", assignee=ME),
    T5: task(T5, "Offer page \u001b[31mred\u001b[0m alert", project="proj-other", assignee=ME),
}
TASKS[T5]["canEdit"] = False
REFS = [{"taskId": T1, "role": "source", "kind": "forum.post", "ref": "4411"}]
NOTES = []

def parse_ref(text, kind=None):
    s = (text or "").strip()
    if kind:
        return (kind, s)
    m = re.match(r"^([a-z][a-z0-9_.]*):(.+)$", s)
    return (m.group(1), m.group(2)) if m else ("url", s)

def ref_view(r):
    return {"id": "f%07d-0000-4000-8000-000000000000" % (REFS.index(r) + 1), "taskId": r["taskId"], "role": r["role"],
            "kind": r["kind"], "ref": r["ref"], "canonical": "%s:%s" % (r["kind"], r["ref"]), "url": None,
            "label": None, "createdByName": "Sam Example"}

def view(tid):
    return dict(TASKS[tid], refs=[ref_view(r) for r in REFS if r["taskId"] == tid])

def org_for(body):
    if body.get("projectId"):
        return PROJECTS[body["projectId"]]
    for p in PROJECTS.values():
        if p["name"].lower() == (body.get("category") or "").lower():
            return p
    return PROJECTS["proj-home"]

def words(title):
    ws = [w for w in re.split(r"[^a-z0-9]+", title.lower()) if len(w) >= 3 and w not in STOP]
    return list(dict.fromkeys(ws))

def similar(title, org=None, exclude=None, limit=3):
    q = words(title)
    if len(q) < 2:
        return []
    out = []
    for t in TASKS.values():
        if t["status"] == "done" or t["isDeleted"] or t["id"] == exclude or (org and t["orgId"] != org):
            continue
        tw = re.split(r"[^a-z0-9]+", t["project"].lower())
        hits = sum(1 for w in q if any(x.startswith(w) for x in tw))
        if hits >= 2 and hits * 2 >= len(q):
            out.append((hits / len(q), t))
    out.sort(key=lambda x: -x[0])
    return [{"id": t["id"], "shortId": t["id"][:8], "title": t["project"], "status": t["status"],
             "projectId": t["projectId"], "projectName": t["projectName"], "orgId": t["orgId"],
             "orgName": t["orgName"], "assigneeId": t["assigneeId"], "assigneeName": t["assigneeName"],
             "score": round(s, 2), "matchedRef": False, "canEdit": t.get("canEdit", True)} for s, t in out[:limit]]

SHARING = [
    {"id": "org-acme", "name": "Acme", "slug": "acme", "role": "owner", "isPersonal": False, "memberCount": 2,
     "members": [{"userId": ME, "userName": "Sam Example", "userEmail": "sam@example.com", "role": "owner", "isMe": True},
                 {"userId": ROBIN, "userName": "Robin Fairweather", "userEmail": "robin@example.com", "role": "member"}],
     "projects": [dict(PROJECTS["proj-acme"])], "invites": []},
    {"id": "org-personal", "name": "Personal", "slug": "personal", "role": "owner", "isPersonal": True, "memberCount": 1,
     "members": [{"userId": ME, "userName": "Sam Example", "userEmail": "sam@example.com", "role": "owner", "isMe": True}],
     "projects": [dict(PROJECTS["proj-home"])], "invites": []},
    {"id": "org-other", "name": "Other", "slug": "other", "role": "owner", "isPersonal": False, "memberCount": 1,
     "members": [{"userId": ME, "userName": "Sam Example", "userEmail": "sam@example.com", "role": "owner", "isMe": True}],
     "projects": [dict(PROJECTS["proj-other"])], "invites": []},
]

def add_note(tid, text, thread=None):
    n = {"id": "n%07d-0000-4000-8000-000000000000" % (len(NOTES) + 1), "projectId": tid, "note": text,
         "gmailThreadId": thread, "authorId": ME, "authorName": "Sam Example", "createdAt": "2026-10-09T10:00:00Z"}
    NOTES.append(n)
    return n

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, payload=None):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if payload is not None:
            self.wfile.write(json.dumps(payload).encode("utf-8"))

    def handle_any(self, method):
        parsed = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(parsed.query)
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length > 0 else b""
        body = json.loads(raw) if raw else None
        with open(LOG, "a") as f:
            f.write(json.dumps({"method": method, "path": parsed.path, "query": parsed.query, "body": body}) + "\n")
        p = parsed.path[len("/api/v2"):]
        one = lambda k: q.get(k, [None])[0]

        if method == "GET" and p == "/users/me":
            return self.send(200, {"id": ME, "email": "sam@example.com", "name": "Sam Example"})
        if method == "GET" and p == "/organisations/sharing":
            return self.send(200, SHARING)
        if method == "GET" and p == "/projects":
            return self.send(200, [view(t) for t in TASKS])
        if method == "GET" and p == "/tasks/similar":
            title = (one("title") or "").strip()
            if not title:
                return self.send(400, {"error": "Say what the task is called: ?title="})
            if "boom" in title:
                return self.send(500, {"error": "Something went wrong"})
            org = None
            if one("projectId"):
                org = PROJECTS[one("projectId")]["orgId"]
            elif one("orgId"):
                org = one("orgId")
            elif one("category"):
                org = org_for({"category": one("category")})["orgId"]
            return self.send(200, similar(title, org, one("excludeId"), min(int(one("limit") or 3), 10)))
        m = re.match(r"^/projects/([^/]+)/updates$", p)
        if m:
            if method == "POST":
                return self.send(201, add_note(m.group(1), body["note"], body.get("gmailThreadId")))
            return self.send(200, [n for n in NOTES if n["projectId"] == m.group(1)])
        m = re.match(r"^/projects/([^/]+)$", p)
        if m and method == "GET":
            return self.send(200, view(m.group(1))) if m.group(1) in TASKS else self.send(404, {"error": "Task not found or access denied"})
        if method == "POST" and p == "/projects":
            proj = org_for(body)
            refs = [(it.get("role") or "link", parse_ref(it["ref"], it.get("kind"))) for it in body.get("refs") or []]
            mode = body.get("onDuplicate") or "error"
            for role, (k, r) in refs:
                if role != "source":
                    continue
                holder = next((x["taskId"] for x in REFS if x["role"] == "source" and x["kind"] == k and x["ref"] == r
                               and TASKS[x["taskId"]]["orgId"] == proj["orgId"]), None)
                if not holder:
                    continue
                t = TASKS[holder]
                if mode == "error":
                    return self.send(409, {"error": '%s:%s is already the source of %s "%s"' % (k, r, holder[:8], t["project"]),
                                           "taskId": holder, "task": view(holder)})
                if mode == "return":
                    return self.send(200, dict(view(holder), created=False))
                added = 0
                for role2, (k2, r2) in refs:
                    if role2 == "source":
                        continue
                    if not any(x["taskId"] == holder and x["role"] == role2 and x["kind"] == k2 and x["ref"] == r2 for x in REFS):
                        REFS.append({"taskId": holder, "role": role2, "kind": k2, "ref": r2})
                        added += 1
                note = 'Reported again: "%s"' % body["project"] + ("\n" + body["notes"] if body.get("notes") else "")
                pure = body["project"].strip().lower() == t["project"].strip().lower() and not body.get("notes") and added == 0
                if not pure and not any(n["projectId"] == holder and n["note"] == note for n in NOTES):
                    add_note(holder, note)
                return self.send(200, dict(view(holder), created=False, reported=True))
            new_id = "9999%04d-0000-4000-8000-000000000000" % len(TASKS)
            TASKS[new_id] = dict(task(new_id, body["project"], proj["id"], body.get("status") or "do", ME), reason=body.get("reason"))
            for role, (k, r) in refs:
                REFS.append({"taskId": new_id, "role": role, "kind": k, "ref": r})
            return self.send(201, dict(view(new_id), created=True, similar=similar(body["project"], proj["orgId"], new_id)))
        m = re.match(r"^/tasks/([^/]+)/refs$", p)
        if m:
            tid = m.group(1)
            if method == "GET":
                return self.send(200, [ref_view(r) for r in REFS if r["taskId"] == tid])
            role = body.get("role") or "link"
            k, r = parse_ref(body["ref"], body.get("kind"))
            for x in REFS:
                if x["taskId"] == tid and x["role"] == role and x["kind"] == k and x["ref"] == r:
                    return self.send(200, dict(ref_view(x), existing=True))
            if role == "source":
                for x in REFS:
                    if x["role"] == "source" and x["kind"] == k and x["ref"] == r and x["taskId"] != tid:
                        return self.send(409, {"error": "%s:%s is already the source of %s \"%s\"" % (k, r, x["taskId"][:8], TASKS[x["taskId"]]["project"]),
                                               "taskId": x["taskId"]})
            row = {"taskId": tid, "role": role, "kind": k, "ref": r}
            REFS.append(row)
            return self.send(201, dict(ref_view(row), existing=False))
        self.send(404, {"error": "Not found"})

    def do_GET(self): self.handle_any("GET")
    def do_POST(self): self.handle_any("POST")
    def do_PUT(self): self.handle_any("PUT")
    def do_DELETE(self): self.handle_any("DELETE")

server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
with open(sys.argv[1], "w") as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
PYEOF

LOG="$MOCK_DIR/requests.jsonl"
touch "$LOG"
python3 -I "$MOCK_DIR/server.py" "$MOCK_DIR/port" "$LOG" &
MOCK_PID=$!
# Wait for the mock to pick a free port and accept connections
for _ in $(seq 1 100); do
  if [[ -s "$MOCK_DIR/port" ]] && curl -s -o /dev/null "http://127.0.0.1:$(cat "$MOCK_DIR/port")/"; then break; fi
  sleep 0.1
done
[[ -s "$MOCK_DIR/port" ]] || { echo "FAIL: mock API did not start" >&2; exit 1; }

export TIMDO_API="http://127.0.0.1:$(cat "$MOCK_DIR/port")/api/v2"
export TIMDO_SECRET="test-secret"
export TIMDO_CONFIG=/dev/null
export NO_COLOR=1
unset TIMDO_TOKEN TIMDO_AS TIMDO_FORCE_TTY

T1="aaaa1111-0000-4000-8000-000000000001"
T2="bbbb2222-0000-4000-8000-000000000002"

fail() {
  echo "FAIL: $1" >&2
  [[ -n "${2:-}" ]] && echo "Got: $2" >&2
  exit 1
}
pass() { echo "PASS: $1"; }
# Read the entire pipe so an early-closing matcher cannot break the producer under pipefail.
has_text() { grep "$@" >/dev/null; }

reqs() { cat "$LOG"; }
clear_log() { : > "$LOG"; }
# writes: the non-GET requests, as a JSON array
writes() { jq -s '[.[] | select(.method != "GET")]' "$LOG"; }
# similar_gets: the GET /tasks/similar requests, as a JSON array
similar_gets() { jq -s '[.[] | select(.method == "GET" and .path == "/api/v2/tasks/similar")]' "$LOG"; }

# run_cli <expected exit> args...: sets OUT (stdout), ERR (stderr) and checks the exit code.
# stdin comes from $ANSWERS (empty by default), so a forced prompt reads the test's answers.
ANSWERS=""
run_cli() {
  local want="$1"; shift
  local code=0
  OUT=$(printf '%s' "$ANSWERS" | "$BIN_TIMDO" "$@" 2>"$MOCK_DIR/stderr") || code=$?
  ERR=$(cat "$MOCK_DIR/stderr")
  if [[ "$code" != "$want" ]]; then
    fail "timdo $* exited $code, expected $want" "stdout: $OUT / stderr: $ERR"
  fi
}
# ask <answers> <expected exit> args...: run as if at a terminal, answering the prompt with <answers>
ask() {
  local answers="$1"; shift
  ANSWERS="$answers"
  TIMDO_FORCE_TTY=1 run_cli "$@"
  ANSWERS=""
}

echo "=== 1. Help texts explain duplicates, with fictional examples and no em-dashes ==="
run_cli 0 add --help
for want in "--on-duplicate <mode>" "error   (default)" "return  create nothing" "report  add this request's links" \
            "-y, --yes" "Create anyway? [y]es / [n]o / [1-3] add as a note to that task:" \
            'Similar open task: 3f2a91c0 "Broken offer page" (Acme Solar)' 'timdo similar "Title" -p <project>'; do
  echo "$OUT" | has_text -F -- "$want" || fail "timdo add --help lacks: $want" "$OUT"
done
run_cli 0 similar --help
for want in 'timdo similar "Task title"' "--project-id" "--limit <n>" "--exclude <task id>" "timdo add-note 3f2a91c0"; do
  echo "$OUT" | has_text -F -- "$want" || fail "timdo similar --help lacks: $want" "$OUT"
done
run_cli 0 help
echo "$OUT" | has_text -F 'similar "title" [-p project]' || fail "timdo help lacks similar" "$OUT"
echo "$OUT" | has_text -F -- "--on-duplicate error|return|report" || fail "timdo help lacks --on-duplicate" "$OUT"
if "$BIN_TIMDO" help add --help similar --help 2>&1 | has_text $'\xe2\x80\x94'; then fail "help text contains an em-dash"; fi
pass "help texts"

echo "=== 2. --on-duplicate is checked before any request and sent as onDuplicate ==="
clear_log
run_cli 1 add "Broken offer page" -p "Acme Solar" --source forum.post:4411 --on-duplicate ignore
echo "$ERR" | has_text -F 'Error: --on-duplicate must be error, return or report, not "ignore"' || fail "bad mode message" "$ERR"
[[ "$(reqs | wc -l)" -eq 0 ]] || fail "a bad mode still sent requests" "$(reqs)"
run_cli 1 add "Broken offer page" -p "Acme Solar" --on-duplicate
echo "$ERR" | has_text -F -- "--on-duplicate needs a mode: error, return or report" || fail "missing mode message" "$ERR"
clear_log
run_cli 0 --json add "Gearbox noise on unit seven" -p "Acme Solar" --on-duplicate=Return
jq -s -e '[.[] | select(.method == "POST")][0].body.onDuplicate == "return"' "$LOG" >/dev/null || fail "onDuplicate not sent" "$(reqs)"
echo "$ERR" | has_text -F "Note: --on-duplicate only applies with --source" || fail "no note that the mode was ignored" "$ERR"
clear_log
run_cli 0 --json add "Plain new thing to do" -p "Acme Solar"
jq -s -e '[.[] | select(.method == "POST")][0].body | has("onDuplicate") | not' "$LOG" >/dev/null || fail "onDuplicate sent when not asked" "$(reqs)"
pass "--on-duplicate parsing"

# MCP uses this explicit option so a title beginning with a dash cannot become a CLI flag.
clear_log
run_cli 0 --json add --title --reason -p "Acme Solar" -r "Broken offer page"
jq -s -e '[.[] | select(.method == "POST")][0].body | .project == "--reason" and .reason == "Broken offer page"' "$LOG" >/dev/null \
  || fail "dash-prefixed title was parsed as a flag" "$(reqs)"
pass "dash-prefixed title"

echo "=== 3. A source clash by default fails, names the task and suggests report ==="
clear_log
run_cli 1 --text add "Offer page down" -p "Acme Solar" --source forum.post:4411
echo "$ERR" | has_text -F 'Already tracked: forum.post:4411 is already the source of aaaa1111 "Broken offer page". Open it with: timdo get aaaa1111. To add this report to that task instead: --on-duplicate report' \
  || fail "clash message" "$ERR"
[[ -z "$OUT" ]] || fail "a failed add printed to stdout" "$OUT"
[[ "$(writes | jq 'length')" == "1" ]] || fail "clash sent more than the create" "$(reqs)"
pass "clash under error"

echo "=== 4. --on-duplicate return prints the existing task, exits 0 and changes nothing ==="
clear_log
run_cli 0 --text add "Offer page down" -p "Acme Solar" --source forum.post:4411 --on-duplicate return
echo "$OUT" | has_text -F 'Already tracked as aaaa1111 "Broken offer page"' || fail "return text" "$OUT"
echo "$OUT" | has_text -F "Nothing was created or changed." || fail "return says nothing changed" "$OUT"
[[ -z "$ERR" ]] || fail "return printed to stderr" "$ERR"
run_cli 0 --json add "Offer page down" -p "Acme Solar" --source forum.post:4411 --on-duplicate return
echo "$OUT" | jq -e '.id == "'"$T1"'" and .created == false' >/dev/null || fail "return --json" "$OUT"
pass "return"

echo "=== 5. --on-duplicate report adds to the existing task once; a retry adds nothing ==="
clear_log
run_cli 0 --text add "Offer page down again" -p "Acme Solar" --source forum.post:4411 --reported-by acme.member:123456 \
  --on-duplicate report -n "Seen on the checkout too"
body=$(jq -s '[.[] | select(.method == "POST")][0].body' "$LOG")
echo "$body" | jq -e '.onDuplicate == "report" and (.refs | length) == 2 and .notes == "Seen on the checkout too"' >/dev/null || fail "report body" "$body"
echo "$OUT" | has_text -F 'Already tracked as aaaa1111 "Broken offer page"' || fail "report text" "$OUT"
echo "$OUT" | has_text -F "Your report is on that task now (sending the same one again adds nothing)." || fail "report wording" "$OUT"
run_cli 0 --json add "Offer page down again" -p "Acme Solar" --source forum.post:4411 --reported-by acme.member:123456 \
  --on-duplicate report -n "Seen on the checkout too"
echo "$OUT" | jq -e '.created == false and .reported == true and ([.refs[] | select(.role == "reported_by")] | length) == 1' >/dev/null \
  || fail "report --json, or the retry added the reporter twice" "$OUT"
run_cli 0 --json notes aaaa1111
[[ "$(echo "$OUT" | jq '[.[] | select(.note | startswith("Reported again"))] | length')" == "1" ]] || fail "the retry added a second note" "$OUT"
pass "report"

echo "=== 6. Scripts are never asked: the create goes ahead and similar tasks go to stderr ==="
clear_log
run_cli 0 --json add "Offer page banner broken" -p "Acme Solar"
[[ "$(similar_gets | jq 'length')" == "0" ]] || fail "a piped add checked first" "$(reqs)"
echo "$OUT" | jq -e '.created == true and (.similar | length) == 2' >/dev/null || fail "add --json lost created/similar" "$OUT"
NEW_ID=$(echo "$OUT" | jq -r '.id')
echo "$ERR" | has_text -xF 'Similar open task: bbbb2222 "Offer page banner missing" (Acme Solar)' || fail "stderr hint line" "$ERR"
echo "$ERR" | has_text -xF 'Similar open task: aaaa1111 "Broken offer page" (Acme Solar)' || fail "second hint line" "$ERR"
echo "$ERR" | has_text -F "Similarity is a suggestion, not proof of a duplicate. Review both tasks and get the user's explicit confirmation of the exact source and target before merging." \
  || fail "merge hint lacks review and confirmation guidance" "$ERR"
echo "$ERR" | has_text -F "After that, run: timdo merge ${NEW_ID:0:8} <target-id>" || fail "merge command hint" "$ERR"
if echo "$ERR" | grep -F "After that, run: timdo merge ${NEW_ID:0:8} <target-id> --yes" >/dev/null; then
  fail "merge hint bypasses confirmation" "$ERR"
fi
echo "$OUT" | jq -e '.' >/dev/null || fail "stdout is not pure JSON" "$OUT"
run_cli 0 --text add "Kettle descaling rota" -p "Acme Solar"
[[ -z "$ERR" ]] || fail "hints printed with no similar tasks" "$ERR"
pass "non-interactive hints"

echo "=== 7. --json and --yes skip the check, but --on-duplicate does not ==="
clear_log
ask "n" 0 --json add "Offer page banner gone" -p "Acme Solar"
ask "n" 0 --text add "Offer page banner hidden" -p "Acme Solar" --yes
[[ "$(similar_gets | jq 'length')" == "0" ]] || fail "checked despite --json/--yes" "$(reqs)"
clear_log
ask $'n\n' 0 --text add "Offer page banner faded" -p "Acme Solar" --source forum.post:9001 --on-duplicate report
[[ "$(similar_gets | jq 'length')" == "1" ]] || fail "--on-duplicate suppressed the similar-task check" "$(reqs)"
[[ "$(jq -s '[.[] | select(.method == "POST" and .path == "/api/v2/projects")] | length' "$LOG")" == "0" ]] || fail "the declined duplicate was created" "$(reqs)"
echo "$ERR" | has_text "Create anyway" || fail "--on-duplicate did not show the prompt" "$ERR"
clear_log
ask $'n\n' 0 --text add "Offer page banner almost gone" -p "Acme Solar" --on-duplicate return
echo "$ERR" | has_text -F "Note: --on-duplicate only applies with --source" || fail "no note that the mode was ignored" "$ERR"
echo "$ERR" | has_text "Create anyway" || fail "ignored --on-duplicate suppressed the prompt" "$ERR"
[[ "$(similar_gets | jq 'length')" == "1" ]] || fail "no-source --on-duplicate skipped lookup" "$(reqs)"
pass "prompt behaviour"

echo "=== 8. At a terminal, matches are listed and the default answer creates nothing ==="
clear_log
ask $'\n' 0 --text add "Fix the broken offer page" -p "Acme Solar"
sq=$(similar_gets | jq -r '.[0].query')
[[ "$sq" == "title=Fix%20the%20broken%20offer%20page&category=Acme%20Solar&limit=3" ]] || fail "pre-check query" "$sq"
echo "$ERR" | has_text -F "These look like open tasks:" || fail "prompt heading" "$ERR"
echo "$ERR" | has_text -E '^  1  aaaa1111  Broken offer page +Acme Solar  Robin$' || fail "numbered row for Robin's task" "$ERR"
echo "$ERR" | has_text -E '^  [23]  bbbb2222  Offer page banner missing +Acme Solar  unassigned  delay$' || fail "numbered row for an unassigned task" "$ERR"
echo "$ERR" | has_text -E '^  [23]  9999[0-9]{4}  Offer page banner broken +Acme Solar  me$' || fail "numbered row for my own task" "$ERR"
echo "$ERR" | has_text -F "Create anyway? [y]es / [n]o / [1-3] add as a note to that task: " || fail "prompt line" "$ERR"
echo "$ERR" | has_text "Offer page wording at home" && fail "a task from another workspace was suggested" "$ERR"
[[ "$OUT" == "Cancelled. Nothing was created." ]] || fail "cancel text" "$OUT"
[[ "$(writes | jq 'length')" == "0" ]] || fail "cancel still wrote" "$(reqs)"
ask "" 0 --text add "Fix the broken offer page" -p "Acme Solar"
[[ "$OUT" == "Cancelled. Nothing was created." ]] || fail "end of input does not cancel" "$OUT"
[[ "$(writes | jq 'length')" == "0" ]] || fail "end of input still wrote" "$(reqs)"
pass "prompt and cancel"

echo "=== 9. y creates it, without repeating the matches that were just shown ==="
clear_log
ask $'y\n' 0 --text add "Offer page broken on mobile" -p "Acme Solar"
echo "$OUT" | has_text '^Added 9999' || fail "y did not create" "$OUT"
echo "$ERR" | has_text "Similar open task:" && fail "the shown matches were repeated as hints" "$ERR"
[[ "$(jq -s '[.[] | select(.method == "POST")] | length' "$LOG")" == "1" ]] || fail "y sent more than one write" "$(reqs)"
pass "create anyway"

echo "=== 10. A number adds what was typed as a note on that task, with any links, and creates nothing ==="
# Which number bbbb2222 gets depends on the tasks made above, so look first, then answer
ask $'n\n' 0 --text add "Offer page banner not showing" -p "Acme Solar"
pick=$(echo "$ERR" | sed -nE 's/^  ([0-9]+)  bbbb2222  .*/\1/p')
[[ -n "$pick" ]] || fail "bbbb2222 was not offered" "$ERR"
clear_log
ask "$pick"$'\n' 0 --text add "Offer page banner not showing" -p "Acme Solar" -r "Spotted by the support team" \
  -n "Only on Firefox" --reported-by acme.member:777 --thread 1a11f9b5ec8c2b2f
[[ "$(jq -s '[.[] | select(.method == "POST" and .path == "/api/v2/projects")] | length' "$LOG")" == "0" ]] || fail "a note answer still created a task" "$(reqs)"
note_req=$(jq -s -c '[.[] | select(.method == "POST" and .path == "/api/v2/projects/'"$T2"'/updates")][0].body' "$LOG")
[[ "$note_req" == '{"note":"Offer page banner not showing\nSpotted by the support team\nOnly on Firefox","gmailThreadId":"1a11f9b5ec8c2b2f"}' ]] \
  || fail "note body" "$note_req"
jq -s -e '[.[] | select(.method == "POST" and .path == "/api/v2/tasks/'"$T2"'/refs")][0].body == {"ref":"acme.member:777","role":"reported_by"}' "$LOG" >/dev/null \
  || fail "the link was not added to the chosen task" "$(reqs)"
echo "$OUT" | has_text -F 'Noted on bbbb2222 "Offer page banner missing" as Sam Example. Nothing new was created.' || fail "note text" "$OUT"
echo "$OUT" | has_text -F "  Linked acme.member:777 (reported by)" || fail "note path link line" "$OUT"

# A failed ref leaves the note saved, so the caller must retry only that ref.
ask $'n\n' 0 --text add "Offer page banner missing" -p "Acme Solar"
pick=$(echo "$ERR" | sed -nE 's/^  ([0-9]+)  bbbb2222  .*/\1/p')
[[ -n "$pick" ]] || fail "bbbb2222 was not offered for the partial-ref case" "$ERR"
clear_log
ask "$pick"$'\n' 1 --text add "Offer page banner missing" -p "Acme Solar" --source forum.post:4411
echo "$OUT" | has_text -F 'Noted on bbbb2222 "Offer page banner missing" as Sam Example. Nothing new was created.' \
  || fail "partial failure lost the saved-note acknowledgement" "$OUT"
echo "$ERR" | has_text -F 'The note was saved. Do not repeat the add or note request; retry only failed refs with: timdo ref add bbbb2222 <url-or-kind:id> [--role <role>].' \
  || fail "partial failure lacks safe ref-only recovery guidance" "$ERR"
[[ "$(jq -s '[.[] | select(.method == "POST" and .path == "/api/v2/projects/'"$T2"'/updates")] | length' "$LOG")" == "1" ]] \
  || fail "note was not saved exactly once" "$(reqs)"
[[ "$(jq -s '[.[] | select(.method == "POST" and .path == "/api/v2/projects")] | length' "$LOG")" == "0" ]] \
  || fail "partial ref failure created a task" "$(reqs)"
[[ "$(jq -s '[.[] | select(.method == "POST" and .path == "/api/v2/tasks/'"$T2"'/refs")] | length' "$LOG")" == "1" ]] \
  || fail "failed ref was not isolated" "$(reqs)"
ask $'1\n' 0 --json add "Offer page broken in Safari" -p "Acme Solar" --yes
echo "$OUT" | jq -e '.created == true' >/dev/null || fail "--yes should create without asking" "$OUT"
pass "add as a note"

echo "=== 11. An answer it cannot read is asked again; three of them cancel ==="
clear_log
ask $'9\nmaybe\ny\n' 0 --text add "Offer page totally broken" -p "Acme Solar"
[[ "$(echo "$ERR" | grep -c "Create anyway?")" == "3" ]] || fail "not asked again" "$ERR"
echo "$ERR" | has_text -F "Answer y to create it, n to stop, or 1-3 to add a note to that task instead." || fail "re-ask hint" "$ERR"
echo "$OUT" | has_text "^Added " || fail "the third answer was not used" "$OUT"
ask $'9\n9\n9\ny\n' 0 --text add "Offer page totally broken" -p "Acme Solar"
[[ "$OUT" == "Cancelled. Nothing was created." ]] || fail "three bad answers do not cancel" "$OUT"
pass "bad answers"

echo "=== 12. No matches create normally; a failed preflight stops an interactive add ==="
clear_log
ask "" 0 --text add "Renew the van insurance" -p "Acme Solar"
echo "$OUT" | has_text "^Added " || fail "no matches did not create" "$OUT"
echo "$ERR" | has_text "Create anyway" && fail "asked with no matches" "$ERR"
clear_log
ask "" 1 --text add "Offer page boom" -p "Acme Solar"
echo "$ERR" | has_text -F "Could not check for similar tasks. Nothing was created. Re-run with --yes to create anyway." \
  || fail "a failing preflight was silently ignored" "$ERR"
[[ "$(jq -s '[.[] | select(.method == "POST" and .path == "/api/v2/projects")] | length' "$LOG")" == "0" ]] \
  || fail "create happened after a failed preflight" "$(reqs)"
clear_log
ask $'n\n' 0 --text add "Offer page footer missing" --project-id ACME
[[ "$(similar_gets | jq -r '.[0].query')" == "title=Offer%20page%20footer%20missing&projectId=proj-acme&limit=3" ]] || fail "--project-id pre-check" "$(reqs)"
pass "preflight"

echo "=== 13. similar lists matches without creating, scoped as asked ==="
clear_log
run_cli 0 --text similar "Fix the offer page" -p "Acme Solar"
[[ "$(similar_gets | jq -r '.[0].query')" == "title=Fix%20the%20offer%20page&category=Acme%20Solar" ]] || fail "similar -p query" "$(reqs)"
has_text -E '^[0-9]+ open tasks look like "Fix the offer page"$' <<< "${OUT%%$'\n'*}" || fail "similar heading" "$OUT"
echo "$OUT" | has_text -E '^  aaaa1111  Broken offer page +Acme Solar  Robin$' || fail "similar row" "$OUT"
echo "$OUT" | has_text -F 'For an editable match, add to it: timdo add-note <id> "..."' || fail "similar next step" "$OUT"
[[ "$(writes | jq 'length')" == "0" ]] || fail "similar wrote something" "$(reqs)"
clear_log
run_cli 0 --json similar offer page --project-id HOME --limit 5 --exclude dddd4444
[[ "$(similar_gets | jq -r '.[0].query')" == "title=offer%20page&projectId=proj-home&limit=5&excludeId=dddd4444-0000-4000-8000-000000000004" ]] \
  || fail "similar --project-id/--limit/--exclude query" "$(reqs)"
[[ "$OUT" == "[]" ]] || fail "similar --json with no matches" "$OUT"
clear_log
run_cli 0 --json similar "Offer page" -w Other
[[ "$(similar_gets | jq -r '.[0].query')" == "title=Offer%20page&orgId=org-other" ]] || fail "similar -w query" "$(reqs)"
echo "$OUT" | jq -e 'length == 1 and .[0].shortId == "eeee5555"' >/dev/null || fail "similar --json" "$OUT"
run_cli 0 --text similar "Offer page" -w Other
[[ "$OUT" != *$'\e'* ]] || fail "similar printed an escape character" "$(printf '%q' "$OUT")"
echo "$OUT" | has_text -F "eeee5555  Offer page  [31mred [0m alert" || fail "similar lost the cleaned title" "$OUT"
run_cli 0 --text similar "Offer page" -w Other
echo "$OUT" | has_text -F "eeee5555  Offer page  [31mred [0m alert  Other  me  view only" || fail "similar did not mark a read-only match" "$OUT"
echo "$OUT" | has_text -F 'A match marked "view only" cannot take a note or be merged by you.' || fail "similar recommended an unavailable action" "$OUT"
[[ "$OUT" != *'If one is the same thing, add to it:'* ]] || fail "read-only task still got note guidance" "$OUT"
run_cli 0 --text similar "VAT"
[[ "$OUT" == $'No open tasks look like "VAT".\n  A title needs at least two distinctive words to compare, e.g. "offer page".' ]] || fail "short title text" "$OUT"
run_cli 0 --text similar --title "-5 degrees freezer alarm"
echo "$OUT" | has_text -F 'No open tasks look like "-5 degrees freezer alarm".' || fail "--title with a dash" "$OUT"
run_cli 0 --text similar -- -- "-5 degrees freezer alarm"
echo "$OUT" | has_text -F 'No open tasks look like "-5 degrees freezer alarm".' || fail "title after a second --" "$OUT"
run_cli 1 similar
echo "$ERR" | has_text -F 'Usage: timdo similar "Task title"' || fail "similar with no title" "$ERR"
run_cli 1 similar "Offer page" --limit 0
echo "$ERR" | has_text -F -- "--limit needs a whole number from 1 to 10" || fail "bad limit" "$ERR"
run_cli 1 similar "Offer page" --frob
echo "$ERR" | has_text -F "Unknown option for similar: --frob" || fail "unknown option" "$ERR"
pass "similar"

echo "=== 14. A read-only match cannot be chosen for a note ==="
clear_log
ask $'1\nn\n' 0 --text add "Offer page red alert issue" -p Other
echo "$ERR" | has_text -F "view only" || fail "the read-only suggestion was not marked" "$ERR"
echo "$ERR" | has_text -F "You can view that task but cannot add a note there." || fail "the CLI accepted a note on a read-only task" "$ERR"
[[ "$(jq -s '[.[] | select(.method == "POST" and .path == "/api/v2/projects")] | length' "$LOG")" == "0" ]] || fail "the declined read-only match created a task" "$(reqs)"
pass "read-only prompt"

echo "=== 15. Shell characters in a title are sent literally, never run ==="
clear_log
ask $'n\n' 0 --text add 'Offer page $(touch '"$MOCK_DIR"'/pwned) `id`' -p "Acme Solar"
run_cli 0 --text similar 'Offer page $(touch '"$MOCK_DIR"'/pwned)'
[[ ! -e "$MOCK_DIR/pwned" ]] || fail "a title was executed by the shell"
pass "no shell injection"

echo "ALL CLI DEDUP TESTS PASSED!"
