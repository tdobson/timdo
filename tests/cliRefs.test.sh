#!/usr/bin/env bash
# CLI tests for task refs (links to things outside TimDo): the flags on add/update, `ref list|add|rm`,
# `find`, `list --ref` and the Links block in `get`. Runs bin/timdo against a small Python mock of the
# v2 refs API that logs every request, so the tests can check exactly what the CLI sent.
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
ME = "user-tim"
ROBIN = "user-robin"
ORG = "org-acme"
PARSE_ERROR = "Can't tell what that is. Paste a URL, or write it as kind:id, e.g. acme.member:123456"
ROLE_ERROR = "Role must be link, source, reported_by or about"
ROLE_ORDER = {"source": 0, "about": 1, "reported_by": 2, "link": 3}

def task(tid, title, status="do", can_edit=True, gmail=None):
    return {
        "id": tid, "userId": ME, "project": title, "reason": "Members cannot see offers",
        "status": status, "priority": 7, "size": "**", "isDeleted": False, "notes": None,
        "awaitUntil": None, "gmailThreadId": gmail, "category": "Acme Solar", "customer": None,
        "tags": None, "epicId": None, "goalId": None,
        "createdAt": "2026-10-01T09:00:00Z", "updatedAt": "2026-10-08T13:02:00Z",
        "projectId": "proj-acme", "projectKey": "ACME", "projectName": "Acme Solar",
        "orgId": ORG, "orgName": "Acme", "isShared": True, "myRole": "owner" if can_edit else "viewer",
        "canEdit": can_edit, "reporterId": ME, "reporterName": "Sam Example",
        "assigneeId": ME, "assigneeName": "Sam Example", "updatedById": ROBIN,
        "updatedByName": "Robin Fairweather", "isMine": True,
    }

T1 = "aaaa1111-0000-4000-8000-000000000001"
T2 = "bbbb2222-0000-4000-8000-000000000002"
T3 = "cccc3333-0000-4000-8000-000000000003"
TASKS = {
    T1: task(T1, "Broken offer page", gmail="0000000000000001"),
    T2: task(T2, "Old widget report", status="done"),
    T3: task(T3, "Read-only task", can_edit=False),
}

def parse(text, kind=None):
    s = (text or "").strip()
    if not s:
        return None
    if kind:
        return (kind, s, None)
    m = re.match(r"^https?://(?:www\.)?github\.com/([^/?#\s]+)/([^/?#\s]+)/(issues|pull)/(\d+)", s, re.I)
    if m:
        k = "github.issue" if m.group(3) == "issues" else "github.pr"
        url = "https://github.com/%s/%s/%s/%s" % (m.group(1), m.group(2), m.group(3), m.group(4))
        return (k, "%s/%s#%s" % (m.group(1), m.group(2), m.group(4)), url)
    if re.match(r"^https?://", s, re.I):
        return ("url", s, s)
    m = re.match(r"^([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*):(.+)$", s)
    if m and m.group(1) not in ("http", "https", "mailto"):
        k, r = m.group(1), m.group(2)
        url = None
        gm = re.match(r"^([^/\s#]+)/([^/\s#]+)#(\d+)$", r)
        if k == "github.issue" and gm:
            url = "https://github.com/%s/%s/issues/%s" % gm.groups()
        return (k, r, url)
    return None

def norm_role(r):
    if r is None or str(r).strip() == "":
        return "link"
    r = re.sub(r"[\s-]+", "_", str(r).strip().lower())
    return r if r in ROLE_ORDER else None

counter = [0]
def ref_row(task_id, role, kind, ref, url=None, label=None, by="Sam Example"):
    counter[0] += 1
    rid = "e%07d-0000-4000-8000-%012d" % (counter[0], counter[0])
    return {"id": rid, "taskId": task_id, "role": role, "kind": kind, "ref": ref,
            "canonical": "%s:%s" % (kind, ref), "url": url, "label": label,
            "displayLabel": label or "%s:%s" % (kind, ref), "createdById": ME,
            "createdByName": by, "createdAt": "2026-10-0%dT10:00:00Z" % min(counter[0], 9),
            "canDelete": TASKS[task_id]["canEdit"]}

REFS = [
    ref_row(T1, "source", "forum.post", "4411", "https://forum.example.org/t/4411"),
    ref_row(T1, "reported_by", "acme.member", "123456", by="Robin Fairweather"),
    ref_row(T1, "reported_by", "acme.member", "200"),
    ref_row(T1, "reported_by", "acme.member", "300"),
    ref_row(T1, "reported_by", "acme.member", "400"),
    ref_row(T1, "link", "github.issue", "acme/widgets#12", "https://github.com/acme/widgets/issues/12", label="Widgets bug"),
    ref_row(T1, "link", "gmail.thread", "0000000000000001", "https://mail.google.com/mail/u/0/#all/0000000000000001"),
    ref_row(T2, "link", "github.issue", "acme/widgets#12", "https://github.com/acme/widgets/issues/12"),
]

def refs_of(tid):
    rows = [r for r in REFS if r["taskId"] == tid]
    return sorted(rows, key=lambda r: (ROLE_ORDER[r["role"]], r["createdAt"]))

def view(tid):
    return dict(TASKS[tid], refs=refs_of(tid))

def source_clash(org, kind, ref, not_task=None):
    for r in REFS:
        if r["role"] == "source" and r["kind"] == kind and r["ref"] == ref and r["taskId"] != not_task \
                and TASKS[r["taskId"]]["orgId"] == org:
            t = TASKS[r["taskId"]]
            return {"error": '%s:%s is already the source of %s "%s"' % (kind, ref, t["id"][:8], t["project"]),
                    "taskId": t["id"]}
    return None

SHARING = [{"id": ORG, "name": "Acme", "slug": "acme", "role": "owner", "isPersonal": False,
            "memberCount": 2, "projectCount": 1,
            "members": [{"userId": ME, "userName": "Sam Example", "userEmail": "sam@example.com", "role": "owner", "isMe": True},
                        {"userId": ROBIN, "userName": "Robin Fairweather", "userEmail": "robin@example.com", "role": "member"}],
            "projects": [{"id": "proj-acme", "key": "ACME", "name": "Acme Solar", "openTasks": 2, "doneTasks": 1, "epicCount": 0}],
            "invites": []}]

def find_task(tid):
    return TASKS.get(tid)

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, payload=None):
        self.send_response(code)
        if payload is None:
            self.end_headers()
            return
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode("utf-8"))

    def handle_any(self, method):
        parsed = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(parsed.query)
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length > 0 else b""
        body = json.loads(raw) if raw else None
        with open(LOG, "a") as f:
            f.write(json.dumps({"method": method, "path": parsed.path, "query": parsed.query, "body": body}) + "\n")
        p = parsed.path[len("/api/v2"):] if parsed.path.startswith("/api/v2") else parsed.path
        one = lambda k: q.get(k, [None])[0]

        if method == "GET" and p == "/users/me":
            return self.send(200, {"id": ME, "email": "sam@example.com", "name": "Sam Example"})
        if method == "GET" and p == "/organisations/sharing":
            return self.send(200, SHARING)
        if method == "GET" and p == "/projects":
            ids = list(TASKS)
            if one("ref"):
                parsed_ref = parse(one("ref"))
                if not parsed_ref:
                    return self.send(400, {"error": PARSE_ERROR})
                role_q = one("role") or one("refRole")
                role = norm_role(role_q) if role_q else None
                k, r, _ = parsed_ref
                ids = [t for t in ids if any(x["kind"] == k and x["ref"] == r and (role is None or x["role"] == role)
                                             for x in refs_of(t))]
            return self.send(200, [view(t) for t in ids])
        m = re.match(r"^/projects/([^/]+)(/updates)?$", p)
        if m and method == "GET":
            if m.group(2):
                return self.send(200, [])
            return self.send(200, view(m.group(1))) if m.group(1) in TASKS else self.send(404, {"error": "Task not found or access denied"})
        if method == "POST" and p == "/projects":
            new_id = "dddd%04d-0000-4000-8000-00000000000%d" % (len(TASKS), len(TASKS))
            parsed_refs = []
            for item in (body or {}).get("refs") or []:
                pr = parse(item.get("ref"), item.get("kind"))
                if not pr:
                    return self.send(400, {"error": PARSE_ERROR})
                role = norm_role(item.get("role"))
                if role is None:
                    return self.send(400, {"error": ROLE_ERROR})
                if role == "source":
                    clash = source_clash(ORG, pr[0], pr[1])
                    if clash:
                        return self.send(409, clash)
                parsed_refs.append((role, pr, item.get("label")))
            TASKS[new_id] = dict(task(new_id, body.get("project")), status=body.get("status") or "do")
            for role, pr, label in parsed_refs:
                REFS.append(ref_row(new_id, role, pr[0], pr[1], pr[2], label))
            return self.send(201, view(new_id))
        m = re.match(r"^/projects/([^/]+)$", p)
        if m and method == "PUT":
            TASKS[m.group(1)].update(body or {})
            return self.send(200, view(m.group(1)))
        if method == "GET" and p == "/tasks/search":
            pr = parse(one("q"))
            hits = [t for t in TASKS if pr and any(x["kind"] == pr[0] and x["ref"] == pr[1] for x in refs_of(t))]
            return self.send(200, [{"id": t, "shortId": t[:8], "title": TASKS[t]["project"], "status": TASKS[t]["status"],
                                    "priority": 7, "matchedRef": True} for t in hits])
        m = re.match(r"^/tasks/([^/]+)$", p)
        if m and method == "GET":
            return self.send(200, {"id": m.group(1), "linkedTasks": []})
        if method == "GET" and p == "/activity":
            return self.send(200, [])

        m = re.match(r"^/tasks/([^/]+)/refs(?:/([^/]+))?$", p)
        if m:
            tid, ref_id = m.group(1), m.group(2)
            t = find_task(tid)
            if not t:
                return self.send(404, {"error": "Task not found or access denied"})
            if method == "GET":
                return self.send(200, refs_of(tid))
            if not t["canEdit"]:
                return self.send(403, {"error": 'You have view-only access to "Acme Solar"'})
            if method == "POST":
                pr = parse(body.get("ref"), body.get("kind"))
                if not pr:
                    return self.send(400, {"error": PARSE_ERROR})
                role = norm_role(body.get("role"))
                if role is None:
                    return self.send(400, {"error": ROLE_ERROR})
                for r in refs_of(tid):
                    if r["role"] == role and r["kind"] == pr[0] and r["ref"] == pr[1]:
                        return self.send(200, dict(r, existing=True))
                if role == "source":
                    clash = source_clash(t["orgId"], pr[0], pr[1], tid)
                    if clash:
                        return self.send(409, clash)
                row = ref_row(tid, role, pr[0], pr[1], body.get("url") or pr[2], body.get("label"))
                REFS.append(row)
                return self.send(201, dict(row, existing=False))
            if method == "DELETE":
                if ref_id:
                    doomed = [r for r in refs_of(tid) if r["id"].startswith(ref_id)]
                else:
                    if not one("ref"):
                        return self.send(400, {"error": "Say which link to remove: ?ref=<url or kind:id>, or its id"})
                    pr = parse(one("ref"))
                    if not pr:
                        return self.send(400, {"error": PARSE_ERROR})
                    role = norm_role(one("role")) if one("role") else None
                    doomed = [r for r in refs_of(tid) if r["kind"] == pr[0] and r["ref"] == pr[1] and (role is None or r["role"] == role)]
                if not doomed:
                    return self.send(404, {"error": "That link isn't on this task"})
                for r in doomed:
                    REFS.remove(r)
                return self.send(204)
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
unset TIMDO_TOKEN TIMDO_AS

T1="aaaa1111-0000-4000-8000-000000000001"
T2="bbbb2222-0000-4000-8000-000000000002"

fail() {
  echo "FAIL: $1" >&2
  [[ -n "${2:-}" ]] && echo "Got: $2" >&2
  exit 1
}
pass() { echo "PASS: $1"; }

# Requests sent since the log was last cleared, one JSON object per line
reqs() { cat "$LOG"; }
clear_log() { : > "$LOG"; }
# writes: the non-GET requests, as a JSON array
writes() { jq -s '[.[] | select(.method != "GET")]' "$LOG"; }

# run_cli <expected exit> args...: sets OUT (stdout), ERR (stderr) and checks the exit code
run_cli() {
  local want="$1"; shift
  local code=0
  OUT=$("$BIN_TIMDO" "$@" 2>"$MOCK_DIR/stderr") || code=$?
  ERR=$(cat "$MOCK_DIR/stderr")
  if [[ "$code" != "$want" ]]; then
    fail "timdo $* exited $code, expected $want" "stdout: $OUT / stderr: $ERR"
  fi
}

echo "=== 1. Help texts explain refs with fictional examples ==="
# A grep -q pipeline can give its producer SIGPIPE after an early match under pipefail.
# Here-strings test the match without a concurrent producer changing the exit status.
run_cli 0 help
grep -qF "Record people by their id in the other system, not by name or email." <<< "$OUT" || fail "timdo help lacks the privacy line" "$OUT"
grep -qF "github.issue:acme/widgets#12" <<< "$OUT" || fail "timdo help lacks a canonical example" "$OUT"
run_cli 0 ref --help
for want in "github.issue:acme/widgets#12" "forum.post:4411" "acme.member:123456" "Record people by their id" "reported_by"; do
  grep -qF "$want" <<< "$OUT" || fail "timdo ref --help lacks: $want" "$OUT"
done
run_cli 0 add --help
grep -qF -- "--reported-by" <<< "$OUT" || fail "timdo add --help lacks --reported-by" "$OUT"
run_cli 0 update --help
grep -qF -- "--unref" <<< "$OUT" || fail "timdo update --help lacks --unref" "$OUT"
run_cli 0 find --help
run_cli 0 help ref --help find --help
if grep -q $'\xe2\x80\x94' <<< "$OUT"; then fail "help text contains an em-dash"; fi
pass "help texts"

echo "=== 2. add sends every ref flag in the create body, in order ==="
clear_log
run_cli 0 --json add "New widget bug" -p "Acme Solar" --source forum.post:9001 --reported-by acme.member:123456 \
  --ref https://github.com/acme/widgets/issues/88 --about acme.thing:1
body=$(jq -s '[.[] | select(.method == "POST" and .path == "/api/v2/projects")][0].body' "$LOG")
expected='[{"ref":"forum.post:9001","role":"source"},{"ref":"acme.member:123456","role":"reported_by"},{"ref":"https://github.com/acme/widgets/issues/88","role":"link"},{"ref":"acme.thing:1","role":"about"}]'
[[ "$(echo "$body" | jq -c '.refs')" == "$expected" ]] || fail "add sent the wrong refs" "$body"
echo "$OUT" | jq -e '(.refs | length) == 4 and .refs[0].role == "source"' >/dev/null || fail "add --json did not pass the API task through" "$OUT"
NEW_ID=$(echo "$OUT" | jq -r '.id')
pass "add --source/--reported-by/--ref/--about"

echo "=== 3. add without ref flags sends no refs key; --text names what was linked ==="
clear_log
run_cli 0 --json add "Plain task" -p "Acme Solar"
jq -s -e '[.[] | select(.method == "POST")][0].body | has("refs") | not' "$LOG" >/dev/null || fail "add without refs sent a refs key" "$(reqs)"
run_cli 0 --text add "Linked task" -p "Acme Solar" --ref github.issue:acme/widgets#77 --source forum.post:9002
echo "$OUT" | grep -q "^Added " || fail "add --text has no Added line" "$OUT"
echo "$OUT" | grep -q "  Linked forum.post:9002 (source)" || fail "add --text does not name the source" "$OUT"
echo "$OUT" | grep -q "  Linked github.issue:acme/widgets#77$" || fail "add --text does not name the link" "$OUT"
pass "add output"

echo "=== 4. A source clash on add fails with the other task's id, and creates nothing ==="
clear_log
run_cli 1 add "Duplicate report" -p "Acme Solar" --source forum.post:4411
echo "$ERR" | grep -qF "Already tracked: forum.post:4411 is already the source of aaaa1111 \"Broken offer page\". Open it with: timdo get aaaa1111" \
  || fail "clash message is not actionable" "$ERR"
[[ -z "$OUT" ]] || fail "a failed add printed to stdout" "$OUT"
pass "source clash on add"

echo "=== 5. --refs-json carries kind and label; bad JSON is refused before any request ==="
clear_log
run_cli 0 --json add "From a bot" -p "Acme Solar" --refs-json '[{"ref":"555","kind":"acme.member","role":"reported_by","label":"Forum account"}]' --ref forum.post:9003
body=$(jq -s '[.[] | select(.method == "POST" and .path == "/api/v2/projects")][0].body' "$LOG")
echo "$body" | jq -e '.refs == [{"ref":"555","kind":"acme.member","role":"reported_by","label":"Forum account"},{"ref":"forum.post:9003","role":"link"}]' >/dev/null \
  || fail "--refs-json was not merged into refs" "$body"
clear_log
run_cli 1 add "Bad json" -p "Acme Solar" --refs-json '{"ref":"x"}'
echo "$ERR" | grep -q "needs a JSON array" || fail "bad --refs-json message" "$ERR"
[[ "$(writes | jq 'length')" == "0" ]] || fail "bad --refs-json still wrote" "$(reqs)"
pass "--refs-json"

echo "=== 6. get prints a Links block grouped by role ==="
run_cli 0 --text get aaaa1111
echo "$OUT" | grep -q "^Links (7)" || fail "get has no Links heading" "$OUT"
echo "$OUT" | grep -qE "^  Source +forum\.post:4411 +https://forum\.example\.org/t/4411$" || fail "get Source line" "$OUT"
echo "$OUT" | grep -qE "^  Reported by +acme\.member:123456$" || fail "get Reported by line" "$OUT"
echo "$OUT" | grep -qF "... and 2 more: timdo ref list aaaa1111" || fail "get does not collapse a long group" "$OUT"
echo "$OUT" | grep -qE "^  Link +github\.issue:acme/widgets#12 +Widgets bug  https://github\.com/acme/widgets/issues/12$" || fail "get Link line with label" "$OUT"
echo "$OUT" | grep -q "Gmail thread:" && fail "get repeats the Gmail thread that is already a link" "$OUT"
# Source comes before Reported by, which comes before Link
order=$(echo "$OUT" | grep -nE "^  (Source|Reported by|Link) " | cut -d: -f2 | awk '{print $1}' | uniq | tr '\n' ' ')
[[ "$order" == "Source Reported Link " ]] || fail "get groups are out of order: $order" "$OUT"
run_cli 0 --json get aaaa1111
echo "$OUT" | jq -e '(.refs | length) == 7' >/dev/null || fail "get --json lacks refs" "$OUT"
pass "get Links block"

echo "=== 7. update with only ref flags skips the PUT, removes first, then adds ==="
clear_log
run_cli 0 --json update aaaa1111 --ref https://github.com/acme/widgets/pull/7 --about acme.member:998 --unref github.issue:acme/widgets#12
writes_json=$(writes)
echo "$writes_json" | jq -e 'all(.[]; .method != "PUT")' >/dev/null || fail "update with only refs sent a PUT" "$writes_json"
echo "$writes_json" | jq -e '.[0].method == "DELETE" and .[0].query == "ref=github.issue%3Aacme%2Fwidgets%2312"' >/dev/null \
  || fail "--unref was not sent URL-encoded as ?ref=" "$writes_json"
echo "$writes_json" | jq -e '.[1].body == {"ref":"https://github.com/acme/widgets/pull/7","role":"link"} and .[2].body == {"ref":"acme.member:998","role":"about"}' >/dev/null \
  || fail "update ref POST bodies" "$writes_json"
echo "$OUT" | jq -e '[.refs[].canonical] | (index("github.pr:acme/widgets#7") != null) and (index("github.issue:acme/widgets#12") == null)' >/dev/null \
  || fail "update --json does not show the refs as they are now" "$OUT"
pass "update ref flags"

echo "=== 8. update with field changes PUTs first, then posts refs; --text lists both ==="
clear_log
run_cli 0 --text update aaaa1111 --priority 3 --ref forum.post:9100
writes_json=$(writes)
echo "$writes_json" | jq -e '.[0].method == "PUT" and .[0].body == {"priority":3} and .[1].method == "POST" and .[1].body.ref == "forum.post:9100"' >/dev/null \
  || fail "update did not PUT then POST" "$writes_json"
echo "$OUT" | grep -q "  Priority: 7 -> 3" || fail "update --text lost the field change" "$OUT"
echo "$OUT" | grep -q "  Linked forum.post:9100" || fail "update --text does not name the link" "$OUT"
run_cli 0 --text update aaaa1111 --ref forum.post:9100
echo "$OUT" | grep -q "  Already linked forum.post:9100, nothing changed" || fail "re-adding is not reported as a no-op" "$OUT"
pass "update PUT then refs"

echo "=== 9. One bad ref in update does not stop the others, and exits 1 ==="
clear_log
run_cli 1 --text update aaaa1111 --ref "not a ref" --ref forum.post:9101
echo "$ERR" | grep -q "Invalid request: can't tell what that is" || fail "parse error not shown" "$ERR"
echo "$ERR" | grep -q "1 of 2 link changes failed" || fail "partial failure not summarised" "$ERR"
echo "$OUT" | grep -q "  Linked forum.post:9101" || fail "the good ref was not added" "$OUT"
pass "partial ref failure"

echo "=== 10. ref list shows ids, roles and who added each, in columns ==="
run_cli 0 --text ref list aaaa1111
echo "$OUT" | grep -q '^Links on "Broken offer page"' || fail "ref list heading" "$OUT"
echo "$OUT" | grep -qE "^  e0000001  Source +forum\.post:4411" || fail "ref list shows no ids" "$OUT"
echo "$OUT" | grep -qE "^  ID +ROLE +REF +ADDED BY +LABEL AND URL$" || fail "ref list has no column header" "$OUT"
echo "$OUT" | grep -qE "^  e0000002  Reported by  acme\.member:123456 +Robin$" || fail "ref list does not say who added it" "$OUT"
run_cli 0 --json ref list aaaa1111
echo "$OUT" | jq -e 'type == "array" and .[0].canonical == "forum.post:4411"' >/dev/null || fail "ref list --json" "$OUT"
run_cli 0 --text ref list bbbb2222
pass "ref list"

echo "=== 11. ref add: role spellings, label, kind; re-adding is safe ==="
clear_log
run_cli 0 --text ref add aaaa1111 777 --kind acme.member --role reported-by --label "Forum account"
jq -s -e '[.[] | select(.method == "POST")][0].body == {"ref":"777","role":"reported_by","label":"Forum account","kind":"acme.member"}' "$LOG" >/dev/null \
  || fail "ref add body" "$(reqs)"
[[ "$OUT" == 'Linked acme.member:777 (reported by) to aaaa1111 "Broken offer page"' ]] || fail "ref add text" "$OUT"
run_cli 0 --text ref add aaaa1111 777 --kind acme.member --role reported_by
[[ "$OUT" == 'Already linked acme.member:777 (reported by) on aaaa1111 "Broken offer page". Nothing changed.' ]] || fail "ref add again text" "$OUT"
run_cli 0 --json ref add aaaa1111 777 --kind acme.member --role reported_by
echo "$OUT" | jq -e '.existing == true and .canonical == "acme.member:777"' >/dev/null || fail "ref add --json existing" "$OUT"
pass "ref add"

echo "=== 12. ref add errors: bad role (no request), clash, viewer, missing ref ==="
clear_log
run_cli 1 ref add aaaa1111 forum.post:1 --role owner
echo "$ERR" | grep -q "Role must be link, source, reported_by or about" || fail "bad role message" "$ERR"
[[ "$(writes | jq 'length')" == "0" ]] || fail "a bad role still wrote" "$(reqs)"
run_cli 1 ref add bbbb2222 forum.post:4411 --role source
echo "$ERR" | grep -qF "Already tracked: forum.post:4411 is already the source of aaaa1111" || fail "ref add clash" "$ERR"
echo "$ERR" | grep -qE "timdo get aaaa1111$" || fail "ref add clash hint should use the short id" "$ERR"
run_cli 1 ref add cccc3333 forum.post:1
echo "$ERR" | grep -q "^View only: " || fail "viewer add message" "$ERR"
run_cli 1 ref add aaaa1111
echo "$ERR" | grep -q "say which ref" || fail "missing ref message" "$ERR"
run_cli 1 ref frob aaaa1111
echo "$ERR" | grep -q "Unknown ref subcommand" || fail "unknown subcommand message" "$ERR"
pass "ref add errors"

echo "=== 13. ref rm by id prefix, by kind:id with a role, and a missing ref ==="
clear_log
run_cli 0 --json ref rm aaaa1111 e0000003
jq -s -e '[.[] | select(.method == "DELETE")][0].path == "/api/v2/tasks/'"$T1"'/refs/e0000003"' "$LOG" >/dev/null || fail "rm by id path" "$(reqs)"
echo "$OUT" | jq -e '.taskId == "'"$T1"'" and .removed[0].canonical == "acme.member:200"' >/dev/null || fail "rm --json" "$OUT"
clear_log
run_cli 0 --text ref rm aaaa1111 forum.post:4411 --role source
jq -s -e '[.[] | select(.method == "DELETE")][0].query == "ref=forum.post%3A4411&role=source"' "$LOG" >/dev/null || fail "rm by ref query" "$(reqs)"
[[ "$OUT" == 'Removed source forum.post:4411 from aaaa1111 "Broken offer page"' ]] || fail "rm text" "$OUT"
clear_log
run_cli 1 --text ref rm aaaa1111 e0000004 --role about
echo "$ERR" | grep -qF "Error: ref e0000004 is reported_by, not about. Leave out --role to remove it." || fail "rm by id ignored --role" "$ERR"
[[ "$(writes | jq 'length')" == "0" ]] || fail "rm by id with the wrong role still deleted" "$(reqs)"
run_cli 0 --text ref rm aaaa1111 e0000004 --role reported-by
[[ "$OUT" == 'Removed reporter acme.member:300 from aaaa1111 "Broken offer page"' ]] || fail "rm text should match the activity log wording" "$OUT"
run_cli 1 ref rm aaaa1111 forum.post:4411
echo "$ERR" | grep -qF "Not found: that link isn't on this task. See the task's links with: timdo ref list aaaa1111" || fail "rm missing message" "$ERR"
pass "ref rm"

echo "=== 14. find and list --ref look tasks up by URL or kind:id, any status ==="
clear_log
run_cli 0 --json find https://github.com/acme/widgets/issues/12
jq -s -e '[.[] | select(.path == "/api/v2/projects" and .query != "")][0].query == "ref=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fissues%2F12"' "$LOG" >/dev/null \
  || fail "find query" "$(reqs)"
echo "$OUT" | jq -e '[.[].id] == ["'"$T2"'"]' >/dev/null || fail "find should return the done task only (aaaa1111 lost #12 in test 7)" "$OUT"
run_cli 0 --text find forum.post:9001 --role source
echo "$OUT" | grep -q "New widget bug" || fail "find --role source text" "$OUT"
jq -s -e 'any(.[]; .query == "ref=forum.post%3A9001&role=source")' "$LOG" >/dev/null || fail "find --role sends role" "$(reqs)"
# List options before the ref keep their value, so the ref is still found
clear_log
run_cli 0 --text find -w Acme forum.post:9001 --mine
echo "$OUT" | grep -q "New widget bug" || fail "find with -w before the ref" "$OUT"
jq -s -e 'any(.[]; .path == "/api/v2/projects" and (.query | test("^orgId=org-acme&assignee=.*&ref=forum.post%3A9001$")))' "$LOG" >/dev/null \
  || fail "find -w did not send the workspace and the ref" "$(reqs)"
run_cli 0 --text find forum.post:1
[[ "$OUT" == "No task you can see carries forum.post:1." ]] || fail "find with no match" "$OUT"
run_cli 0 --json list do --ref github.issue:acme/widgets#12
[[ "$(echo "$OUT" | jq 'length')" == "0" ]] || fail "list do --ref should skip the done task" "$OUT"
run_cli 1 list do --ref-role source
echo "$ERR" | grep -q "only works with --ref" || fail "--ref-role without --ref" "$ERR"
pass "find and list --ref"

echo "=== 15. Shell characters in refs are sent literally, never run ==="
clear_log
run_cli 0 --json ref add "$NEW_ID" 'acme.note:$(touch '"$MOCK_DIR"'/pwned) "quoted" `id`'
[[ ! -e "$MOCK_DIR/pwned" ]] || fail "a ref was executed by the shell"
jq -s -e '[.[] | select(.method == "POST")][0].body.ref == "acme.note:$(touch '"$MOCK_DIR"'/pwned) \"quoted\" `id`"' "$LOG" >/dev/null \
  || fail "ref was not sent literally" "$(reqs)"
pass "no shell injection"

echo "=== 16. search marks tasks that carry the pasted ref ==="
run_cli 0 --text search https://forum.example.org/nothing
run_cli 0 --text search acme.member:123456
echo "$OUT" | grep -qE "aaaa1111 .*Broken offer page.*carries this ref" || fail "search does not mark the ref match" "$OUT"
run_cli 0 --json search acme.member:123456
echo "$OUT" | jq -e '.[0].matchedRef == true and .[0].orgName == "Acme"' >/dev/null || fail "search --json lost matchedRef" "$OUT"
pass "search ref matches"

echo "=== 17. update --unref uses the activity log's wording, never Unlinked ==="
run_cli 0 --text update aaaa1111 --unref acme.member:400
echo "$OUT" | grep -qx "  Removed reporter acme.member:400" || fail "update --unref wording" "$OUT"
echo "$OUT" | grep -q "Unlinked" && fail "update --unref says Unlinked" "$OUT"
pass "update --unref wording"

echo "=== 18. Link changes that all fail, with nothing else to save, change nothing ==="
clear_log
run_cli 1 --text update cccc3333 --ref forum.post:77
[[ -z "$OUT" ]] || fail "a failed ref-only update printed an Updated line" "$OUT"
echo "$ERR" | grep -q "^View only: " || fail "viewer message missing" "$ERR"
echo "$ERR" | grep -qF "Error: 1 of 1 link changes failed (see above). Nothing was changed." || fail "all-failed summary" "$ERR"
echo "$ERR" | grep -q "Everything else was saved" && fail "claims something else was saved" "$ERR"
run_cli 1 --json update cccc3333 --ref forum.post:77
[[ -z "$OUT" ]] || fail "a failed ref-only update printed JSON" "$OUT"
pass "all link changes failed"

echo "=== 19. --link and --unlink are not ref flags (they mean task links) ==="
for flag in --link --unlink; do
  clear_log
  run_cli 1 update aaaa1111 "$flag" bbbb2222
  echo "$ERR" | grep -qF "To link two tasks use: timdo ${flag#--} <task> <task>" || fail "$flag on update" "$ERR"
  [[ "$(writes | jq 'length')" == "0" ]] || fail "$flag on update still wrote" "$(reqs)"
done
run_cli 1 add "Linked by mistake" -p "Acme Solar" --link bbbb2222
echo "$ERR" | grep -qF "timdo link <task> <task>" || fail "--link on add" "$ERR"
pass "no --link/--unlink aliases"

echo "=== 20. Control characters in a ref or label never reach the terminal ==="
run_cli 0 --text ref add bbbb2222 $'forum.post:55\e[2J' --label $'Robin\e[31m'
[[ "$OUT" != *$'\e'* ]] || fail "ref add printed an escape character" "$(printf '%q' "$OUT")"
run_cli 0 --text ref list bbbb2222
[[ "$OUT" != *$'\e'* ]] || fail "ref list printed an escape character" "$(printf '%q' "$OUT")"
echo "$OUT" | grep -qF "forum.post:55 [2J" || fail "ref list lost the cleaned ref" "$OUT"
echo "$OUT" | grep -qF "Robin [31m" || fail "ref list lost the cleaned label" "$OUT"
pass "control characters"

echo "ALL CLI REFS TESTS PASSED!"
