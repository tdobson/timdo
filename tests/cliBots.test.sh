#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_TIMDO="$ROOT_DIR/bin/timdo"

python3 - "$BIN_TIMDO" <<'PY'
import errno
import json
import os
import pty
import select
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

BIN = sys.argv[1]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(BIN)))
TEMP = tempfile.TemporaryDirectory(prefix='timdo-cli-bots-')
HOME = TEMP.name
CONFIG = os.path.join(HOME, '.config', 'timdo', 'config')
os.makedirs(os.path.dirname(CONFIG), exist_ok=True)

BOT1 = 'bot|11111111-1111-4111-8111-111111111111'
BOT2 = 'bot|22222222-2222-4222-8222-222222222222'
TASK_ID = 'task-11111111-1111-4111-8111-111111111111'
HUMAN_ID = 'user|taylor-example'
HUMAN_TOKEN = 'fictional-human-token'
VIEWER_BOT_TOKEN = 'fictional-viewer-bot-token'
HUMAN_GOAL_ID = 'goal-human-example'
PROJECT_ID = 'fixture-project-shared'
EPIC_ID = 'epic-22222222-2222-4222-8222-222222222222'
TOKEN1 = {'id': 'tok-aaaa1111', 'name': 'shared', 'prefix': 'tdo_aaa1', 'createdAt': '2026-10-10T10:00:00Z', 'lastUsedAt': None}
TOKEN2 = {'id': 'tok-aaaa2222', 'name': 'shared', 'prefix': 'tdo_aaa2', 'createdAt': '2026-10-10T11:00:00Z', 'lastUsedAt': None}
ORGS = [
    {'id': 'org-northstar', 'name': 'Northstar Workshop', 'slug': 'northstar-workshop', 'role': 'owner', 'isPersonal': False,
     'members': [{'userId': HUMAN_ID, 'userName': 'Taylor Example', 'userEmail': 'taylor@example.test', 'role': 'member'}],
     'projects': [{'id': PROJECT_ID, 'key': 'WST', 'name': 'Workshop tools'}]},
    {'id': 'org-twin-a', 'name': 'Twin Workshop', 'slug': 'twin-a', 'role': 'owner', 'isPersonal': False, 'members': [], 'projects': []},
    {'id': 'org-twin-b', 'name': 'Twin Workshop', 'slug': 'twin-b', 'role': 'owner', 'isPersonal': False, 'members': [], 'projects': []},
]


def make_bot(bot_id, name='Forum watcher', tokens=None):
    return {
        'id': bot_id, 'kind': 'bot', 'name': name, 'role': 'member', 'createdByName': 'Taylor Example',
        'createdAt': '2026-10-10T10:00:00Z', 'disabledAt': None,
        'tokens': list(tokens if tokens is not None else [TOKEN1.copy(), TOKEN2.copy()]),
    }

STATE = {
    'bots': {BOT1: make_bot(BOT1), BOT2: make_bot(BOT2)},
    'requests': [],
    'next_bot': 3,
    'fail_token': False,
    'note_author_name': 'Forum watcher',
    'note_author_kind': 'bot',
    'created_tasks': [],
    'created_epics': [],
    'epics': [{'id': EPIC_ID, 'title': 'Existing watcher epic', 'category': 'Workshop tools',
               'projectId': PROJECT_ID, 'orgId': 'org-northstar'}],
}
LOCK = threading.Lock()


def bearer_token(headers):
    bearer = headers.get('Authorization', '')
    return bearer.removeprefix('Bearer ')


def sharing_orgs(headers):
    orgs = json.loads(json.dumps(ORGS))
    token = bearer_token(headers)
    if token == 'fictional-bot-token':
        orgs[0]['role'] = 'member'
    elif token == VIEWER_BOT_TOKEN:
        orgs[0]['role'] = 'viewer'
    return orgs


def auth_kind(headers):
    if headers.get('X-Internal-Secret') == 'fictional-owner-secret':
        return 'owner-secret'
    bearer = headers.get('Authorization', '')
    if bearer == 'Bearer denied-fictional-token':
        return 'denied-token'
    if bearer in ('Bearer fictional-bot-token', f'Bearer {VIEWER_BOT_TOKEN}'):
        return 'bot-token'
    if bearer.startswith('Bearer '):
        return 'personal-token'
    return 'none'


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def read_body(self):
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(length) if length else b''
        return json.loads(raw) if raw else {}

    def record(self, body=None):
        item = {
            'method': self.command,
            'path': urlparse(self.path).path,
            'auth': auth_kind(self.headers),
            'body': body,
        }
        with LOCK:
            STATE['requests'].append(item)

    def send_json(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_empty(self, status=204):
        self.send_response(status)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        self.record()
        if path == '/api/v2/organisations/sharing':
            return self.send_json(200, sharing_orgs(self.headers))
        if path == '/api/v2/organisations':
            return self.send_json(200, ORGS)
        if path == '/api/v2/users/me':
            return self.send_json(200, {
                'id': BOT1, 'name': 'Forum watcher', 'kind': 'bot',
                'email': 'bot+11111111@bots.timdo.invalid',
                'workspace': {'id': 'org-northstar', 'name': 'Northstar Workshop', 'role': 'member'},
            })
        if path == '/api/v2/goals':
            if auth_kind(self.headers) == 'bot-token':
                return self.send_json(403, {'error': 'Bots do not have life goals'})
            if bearer_token(self.headers) == HUMAN_TOKEN:
                return self.send_json(200, [{'id': HUMAN_GOAL_ID, 'title': 'Build better routines'}])
            return self.send_json(200, [])
        if path == '/api/v2/tasks/similar':
            return self.send_json(200, [{
                'id': TASK_ID, 'title': 'Check the release feed', 'projectName': 'Workshop tools',
                'category': 'Workshop tools', 'orgName': 'Northstar Workshop', 'assigneeId': None,
                'assigneeName': None, 'status': 'do', 'canEdit': True,
            }])
        if path == '/api/v2/epics':
            return self.send_json(200, STATE['epics'])
        if path == '/api/v2/projects':
            return self.send_json(200, [{
                'id': TASK_ID, 'project': 'Check the release feed', 'status': 'do', 'priority': 5, 'size': '**',
                'category': 'Workshop tools', 'projectName': 'Workshop tools', 'orgId': 'org-northstar',
                'orgName': 'Northstar Workshop', 'isShared': True, 'canEdit': True,
                'reporterName': 'Forum watcher', 'reporterKind': 'bot',
                'updatedByName': 'Forum watcher', 'updatedByKind': 'bot',
                'assigneeId': None, 'assigneeName': None, 'refs': [],
            }])
        if path == f'/api/v2/projects/{TASK_ID}/updates':
            return self.send_json(200, [{
                'id': 'note-1', 'note': 'Checked by the integration', 'authorName': 'Forum watcher',
                'authorKind': 'bot', 'createdAt': '2026-10-11T10:00:00Z',
            }])
        if path == f'/api/v2/tasks/{TASK_ID}':
            return self.send_json(200, {'linkedTasks': []})
        if path == '/api/v2/activity':
            return self.send_json(200, [
                {'actorName': 'Forum watcher', 'actorKind': 'bot', 'via': 'owner_secret',
                 'viaDetail': None, 'summary': 'Created a task', 'createdAt': '2026-10-11T10:00:00Z'},
                {'actorName': 'Taylor Example', 'actorKind': 'human', 'via': 'token',
                 'viaDetail': 'token-name-must-stay-hidden', 'summary': 'Updated a task', 'createdAt': '2026-10-11T09:00:00Z'},
            ])
        if path.startswith('/api/v2/organisations/') and path.endswith('/bots'):
            if auth_kind(self.headers) == 'denied-token':
                return self.send_json(403, {'error': 'Not allowed'})
            if auth_kind(self.headers) == 'bot-token':
                return self.send_json(403, {'error': 'Bots are managed on the web: https://timdo.tdobson.net/sharing'})
            return self.send_json(200, list(STATE['bots'].values()))
        return self.send_json(404, {'error': 'Not found'})

    def do_POST(self):
        body = self.read_body()
        self.record(body)
        path = urlparse(self.path).path
        if path == '/api/v2/epics':
            token = bearer_token(self.headers)
            if auth_kind(self.headers) == 'bot-token' and 'goalId' in body:
                return self.send_json(403, {'error': 'Bots do not have life goals'})
            if auth_kind(self.headers) == 'bot-token' and body.get('projectId') != PROJECT_ID:
                return self.send_json(403, {'error': 'Bots must use an existing project in their home workspace'})
            if token == VIEWER_BOT_TOKEN:
                return self.send_json(403, {'error': 'You have view-only access to "Workshop tools"'})
            with LOCK:
                epic = {
                    'id': f'epic-created-{len(STATE["created_epics"]) + 1}',
                    'title': body.get('title'),
                    'category': body.get('category'),
                    'goalId': body.get('goalId'),
                    'description': body.get('description'),
                    'status': body.get('status'),
                    'projectId': body.get('projectId'),
                }
                STATE['created_epics'].append(epic)
            return self.send_json(201, epic)
        if path == '/api/v2/projects':
            token = bearer_token(self.headers)
            if auth_kind(self.headers) == 'bot-token' and 'goalId' in body:
                return self.send_json(403, {'error': 'Bots do not have life goals'})
            if token == VIEWER_BOT_TOKEN:
                return self.send_json(403, {'error': 'You have view-only access to "Workshop tools"'})
            with LOCK:
                task = {
                    'id': f'task-created-{len(STATE["created_tasks"]) + 1}',
                    'project': body.get('project'),
                    'status': body.get('status'),
                    'priority': body.get('priority'),
                    'size': body.get('size'),
                    'category': 'Workshop tools',
                    'projectId': body.get('projectId'),
                    'projectName': 'Workshop tools',
                    'orgId': 'org-northstar',
                    'orgName': 'Northstar Workshop',
                    'isShared': True,
                    'canEdit': True,
                    'assigneeId': body.get('assigneeId'),
                    'assigneeName': 'Taylor Example' if body.get('assigneeId') == HUMAN_ID else None,
                    'goalId': body.get('goalId'),
                    'refs': [],
                    'created': True,
                    'similar': [],
                }
                STATE['created_tasks'].append(task)
            return self.send_json(201, task)
        if path == f'/api/v2/projects/{TASK_ID}/updates':
            return self.send_json(201, {
                'id': 'note-created', 'taskId': TASK_ID, 'authorName': STATE['note_author_name'],
                'authorKind': STATE['note_author_kind'], 'note': body.get('note'), 'createdAt': '2026-10-11T11:00:00Z',
            })
        if path == '/api/v2/organisations/org-northstar/bots':
            with LOCK:
                number = STATE['next_bot']
                STATE['next_bot'] += 1
                bot_id = f'bot|{number:08d}-3333-4333-8333-{number:012d}'
                token_name = body.get('tokenName', 'initial')
                bot = make_bot(bot_id, body['name'], [])
                bot['role'] = body.get('role', 'member')
                bot['tokens'] = [{'id': f'tok-new{number:04d}', 'name': token_name, 'prefix': 'tdo_new',
                                  'createdAt': '2026-10-11T10:00:00Z', 'lastUsedAt': None}]
                STATE['bots'][bot_id] = bot
            return self.send_json(201, {'bot': bot, 'token': f'tdo_fictional_new_token_{number}'})
        if path.endswith('/tokens'):
            parts = path.split('/')
            bot_id = unquote(parts[-2])
            with LOCK:
                bot = STATE['bots'][bot_id]
                name = body['name']
                token = {'id': f'tok-replacement-{len(bot["tokens"]) + 1}', 'name': name, 'prefix': 'tdo_repl',
                         'createdAt': '2026-10-11T10:01:00Z', 'lastUsedAt': None}
                bot['tokens'].append(token)
            return self.send_json(201, {**token, 'token': 'tdo_fictional_replacement_token'})
        return self.send_json(404, {'error': 'Not found'})

    def do_PUT(self):
        body = self.read_body()
        self.record(body)
        path = urlparse(self.path).path
        parts = path.split('/')
        if len(parts) == 6 and parts[3] == 'organisations' and parts[5] == 'bots':
            return self.send_json(404, {'error': 'Not found'})
        if len(parts) == 6 and parts[3] == 'organisations' and parts[5].startswith('bot'):
            return self.send_json(404, {'error': 'Not found'})
        if '/bots/' in path:
            bot_id = unquote(path.split('/bots/', 1)[1])
            with LOCK:
                bot = STATE['bots'][bot_id]
                bot.update(body)
                updated = dict(bot)
            return self.send_json(200, updated)
        return self.send_json(404, {'error': 'Not found'})

    def do_DELETE(self):
        self.record()
        path = urlparse(self.path).path
        if '/bots/' not in path:
            return self.send_json(404, {'error': 'Not found'})
        raw_id = path.split('/bots/', 1)[1]
        if '/tokens/' in raw_id:
            bot_raw, token_raw = raw_id.split('/tokens/', 1)
            bot_id, token_id = unquote(bot_raw), unquote(token_raw)
            with LOCK:
                bot = STATE['bots'][bot_id]
                bot['tokens'] = [token for token in bot['tokens'] if token['id'] != token_id]
            return self.send_empty()
        bot_id = unquote(raw_id)
        with LOCK:
            bot = STATE['bots'][bot_id]
            bot['disabledAt'] = '2026-10-11T10:02:00Z'
            bot['role'] = None
            bot['tokens'] = []
        return self.send_empty()


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
server_thread = threading.Thread(target=server.serve_forever, daemon=True)
server_thread.start()
API = f'http://127.0.0.1:{server.server_port}/api/v2'
BASE_ENV = {
    'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
    'HOME': HOME,
    'TIMDO_CONFIG': CONFIG,
    'TIMDO_API': API,
    'NO_COLOR': '1',
}


def run(args, *, token='fictional-personal-token', secret='fictional-owner-secret', input_text=None):
    env = dict(BASE_ENV)
    if token is not None:
        env['TIMDO_TOKEN'] = token
    if secret is not None:
        env['TIMDO_SECRET'] = secret
    result = subprocess.run([BIN, *args], input=input_text, text=True, capture_output=True, env=env, cwd=HOME)
    return result


def request_snapshot():
    with LOCK:
        return list(STATE['requests'])


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def expect_json(result, message):
    assert_true(result.returncode == 0, f'{message}: exit {result.returncode}, stderr={result.stderr!r}')
    try:
        return json.loads(result.stdout)
    except Exception as exc:
        raise AssertionError(f'{message}: stdout is not clean JSON: {result.stdout!r}; stderr={result.stderr!r}') from exc


def run_interactive(args, answer, trigger=b'[y/N]'):
    env = dict(BASE_ENV, TIMDO_TOKEN='fictional-personal-token', TIMDO_SECRET='fictional-owner-secret')
    master, slave = pty.openpty()
    child = subprocess.Popen([BIN, *args], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=HOME, close_fds=True)
    os.close(slave)
    output = bytearray()
    sent = False
    deadline = time.monotonic() + 8
    try:
        while child.poll() is None and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if not ready:
                continue
            try:
                data = os.read(master, 4096)
            except OSError as exc:
                if exc.errno != errno.EIO:
                    raise
                break
            if not data:
                break
            output.extend(data)
            if not sent and trigger in output:
                os.write(master, answer.encode() + b'\n')
                sent = True
        # PTY EOF can arrive before the child's exit status is observable.
        try:
            child.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired as exc:
            raise AssertionError(
                f'interactive bot command timed out: sent={sent}, output={output.decode(errors="replace")!r}'
            ) from exc
        while True:
            try:
                data = os.read(master, 4096)
                if not data:
                    break
                output.extend(data)
            except OSError as exc:
                if exc.errno != errno.EIO:
                    raise
                break
        return child.returncode, output.decode(errors='replace'), sent
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)


try:
    # Workspace and bot lookups are unique. A repeated workspace name must not select the first row.
    ambiguous_workspace = run(['--json', 'bot', 'list', 'Twin Workshop'])
    assert_true(ambiguous_workspace.returncode != 0 and 'Ambiguous workspace' in ambiguous_workspace.stderr,
                'duplicate workspace names are rejected explicitly')
    assert_true(not any(r['path'].endswith('/bots') for r in request_snapshot()),
                'ambiguous workspace must not call a bot endpoint')
    print('PASS: workspace ambiguity')

    listed = expect_json(run(['--json', 'bot', 'list', 'Northstar Workshop']), 'bot list')
    assert_true(len(listed) == 2, 'bot list returns API items')
    assert_true('tdo_fictional' not in json.dumps(listed), 'bot list contains no plaintext token')
    assert_true(any(r['auth'] == 'personal-token' for r in request_snapshot()), 'token is the default auth')
    print('PASS: list and token-first authentication')

    before = len(request_snapshot())
    ambiguous_bot = run(['--json', 'bot', 'rename', 'Northstar Workshop', 'Forum watcher', 'New name'])
    assert_true(ambiguous_bot.returncode != 0 and 'Ambiguous bot' in ambiguous_bot.stderr,
                'duplicate bot names are rejected explicitly')
    assert_true(not any(r['method'] == 'PUT' for r in request_snapshot()[before:]), 'ambiguous bot must not be changed')
    print('PASS: bot name ambiguity')

    # An API denial under a personal token must not retry with the configured owner secret.
    STATE['fail_token'] = True
    before = len(request_snapshot())
    denied = run(['--json', 'bot', 'list', 'Northstar Workshop'], token='denied-fictional-token')
    denied_requests = request_snapshot()[before:]
    assert_true(denied.returncode != 0 and 'Not allowed' in denied.stderr, 'token denial is reported')
    assert_true(denied_requests and all(r['auth'] != 'owner-secret' for r in denied_requests),
                'a token denial is never retried with the owner secret')
    STATE['fail_token'] = False
    print('PASS: no implicit privilege retry')

    # Explicit owner-secret selection overrides a present personal token.
    before = len(request_snapshot())
    explicit = expect_json(run(['--json', 'bot', 'list', 'Northstar Workshop', '--owner-secret']), 'owner-secret list')
    owner_requests = request_snapshot()[before:]
    assert_true(len(explicit) == 2 and owner_requests, 'owner-secret list returns bots')
    assert_true(all(r['auth'] == 'owner-secret' for r in owner_requests), 'explicit owner secret is used for every lookup')
    print('PASS: explicit owner-secret selection')

    before = len(request_snapshot())
    missing_secret = run(['--json', 'bot', 'list', 'Northstar Workshop', '--owner-secret'], secret=None)
    assert_true(missing_secret.returncode != 0 and 'TIMDO_SECRET' in missing_secret.stderr,
                'selected owner secret must fail clearly when missing')
    assert_true(request_snapshot()[before:] == [], 'missing selected secret must not use the token or make a request')
    print('PASS: missing owner secret')

    # Initial creation defaults to initial, emits a one-time warning only on stderr, and keeps stdout JSON.
    before = len(request_snapshot())
    created = run(['--json', 'bot', 'create', 'Northstar Workshop', 'Release monitor'])
    created_json = expect_json(created, 'bot create')
    assert_true(created_json['bot']['name'] == 'Release monitor' and created_json['bot']['tokens'][0]['name'] == 'initial',
                'initial token uses the initial default')
    assert_true(created_json['token'].startswith('tdo_'), 'creation returns the one-time credential in JSON')
    assert_true('one-time' in created.stderr.lower() and 'recover' in created.stderr.lower(), 'creation warns on stderr')
    assert_true(created.stdout.strip().startswith('{') and created.stdout.strip().endswith('}'), 'JSON stdout contains only a JSON object')
    create_request = next(r for r in request_snapshot()[before:] if r['method'] == 'POST' and r['path'].endswith('/bots'))
    assert_true(create_request['body']['name'] == 'Release monitor', 'create body contains the exact name')
    assert_true('tokenName' not in create_request['body'], 'API default is left intact for the first token')
    print('PASS: create, copy-once warning and JSON output')

    # Text output includes the credential once, while the warning stays on stderr.
    text_created = run(['--text', 'bot', 'create', 'Northstar Workshop', '--', '--owner-secret'])
    assert_true(text_created.returncode == 0 and 'tdo_fictional_new_token_' in text_created.stdout,
                f'text creation prints the one-time token: rc={text_created.returncode}, stdout={text_created.stdout!r}, stderr={text_created.stderr!r}')
    assert_true('one-time' in text_created.stderr.lower(), 'text creation warning is on stderr')
    text_body = next(r['body'] for r in request_snapshot() if r['method'] == 'POST' and r['body'] and r['body'].get('name') == '--owner-secret')
    assert_true(text_body['name'] == '--owner-secret', 'separator protects a dash-leading bot name')
    print('PASS: text output and leading-dash CLI data')

    created_id = created_json['bot']['id']
    renamed = expect_json(run(['--json', 'bot', 'rename', 'Northstar Workshop', created_id[:12], 'Feed monitor']), 'bot rename by id prefix')
    assert_true(renamed['name'] == 'Feed monitor', 'rename resolves an ID prefix')
    changed_role = expect_json(run(['--json', 'bot', 'role', 'Northstar Workshop', 'Feed monitor', 'viewer']), 'bot role by name')
    assert_true(changed_role['role'] == 'viewer', 'role change resolves a unique bot name')
    renamed_text = run(['--text', 'bot', 'rename', 'Northstar Workshop', created_id[:12], 'Public monitor'])
    assert_true(renamed_text.returncode == 0 and 'Public monitor' in renamed_text.stdout,
                f'text rename output: {renamed_text.stdout!r} {renamed_text.stderr!r}')
    role_text = run(['--text', 'bot', 'role', 'Northstar Workshop', 'Public monitor', 'member'])
    assert_true(role_text.returncode == 0 and 'member' in role_text.stdout,
                f'text role output: {role_text.stdout!r} {role_text.stderr!r}')
    print('PASS: rename and role change')

    replacement = run(['--json', 'bot', 'token', 'Northstar Workshop', created_id[:12]])
    replacement_json = expect_json(replacement, 'replacement bot token')
    assert_true(replacement_json['name'] == 'CLI token' and replacement_json['token'].startswith('tdo_'),
                'replacement token defaults to CLI token and is returned once')
    assert_true('one-time' in replacement.stderr.lower(), 'replacement token warns on stderr')
    revoked_by_name = expect_json(run(['--json', 'bot', 'revoke-token', 'Northstar Workshop', created_id[:12], 'CLI token', '--yes']),
                                  'revoke a token by unique name')
    assert_true(revoked_by_name == {'success': True}, 'unique token name resolves for revocation')
    print('PASS: replacement token default and name lookup')

    before = len(request_snapshot())
    ambiguous_token_name = run(['--json', 'bot', 'revoke-token', 'Northstar Workshop', BOT1, 'shared'])
    assert_true(ambiguous_token_name.returncode != 0 and 'Ambiguous token' in ambiguous_token_name.stderr,
                'duplicate token names are rejected explicitly')
    assert_true(not any(r['method'] == 'DELETE' for r in request_snapshot()[before:]), 'ambiguous token name is not revoked')

    before = len(request_snapshot())
    ambiguous_token = run(['--json', 'bot', 'revoke-token', 'Northstar Workshop', BOT1, 'tok-aaaa'])
    assert_true(ambiguous_token.returncode != 0 and 'Ambiguous token' in ambiguous_token.stderr,
                'ambiguous token prefixes are rejected explicitly')
    assert_true(not any(r['method'] == 'DELETE' for r in request_snapshot()[before:]), 'ambiguous token is not revoked')
    print('PASS: token prefix ambiguity')

    # A pipe is not approval, even when it contains "y" and even for JSON output.
    before = len(request_snapshot())
    piped = run(['--json', 'bot', 'disable', 'Northstar Workshop', BOT1], input_text='y\n')
    assert_true(piped.returncode != 0 and '--yes' in piped.stderr, 'piped confirmation is rejected')
    assert_true(not any(r['method'] == 'DELETE' for r in request_snapshot()[before:]), 'pipe did not disable the bot')
    print('PASS: non-interactive confirmation is required')

    before = len(request_snapshot())
    rc, output, sent = run_interactive(['--json', 'bot', 'disable', 'Northstar Workshop', BOT1], 'n')
    assert_true(rc == 0 and sent and '{"cancelled":true,"changed":false}' in output,
                f'interactive negative confirmation returns clean JSON: rc={rc}, sent={sent}, output={output!r}')
    assert_true(not any(r['method'] == 'DELETE' for r in request_snapshot()[before:]), 'cancel did not disable the bot')

    before = len(request_snapshot())
    rc, output, sent = run_interactive(['--json', 'bot', 'revoke-token', 'Northstar Workshop', BOT1, 'tok-aaaa1111'], 'y')
    assert_true(rc == 0 and sent and 'Revoke token' in output, 'interactive positive confirmation permits revocation')
    assert_true(any(r['method'] == 'DELETE' and '/tokens/' in r['path'] for r in request_snapshot()[before:]),
                'approved revoke calls the token endpoint')
    print('PASS: interactive destructive confirmations')

    disabled = expect_json(run(['--json', 'bot', 'disable', 'Northstar Workshop', BOT2, '--yes']), 'bot disable with --yes')
    assert_true(disabled == {'success': True}, '204 disable returns clean JSON')
    assert_true(STATE['bots'][BOT2]['disabledAt'] is not None and not STATE['bots'][BOT2]['tokens'],
                'disable clears role and active tokens')
    print('PASS: disable with --yes and JSON output')

    # Identity and bylines must use safe names, kind markers and owner-secret provenance.
    who_json = expect_json(run(['--json', 'whoami'], token='fictional-bot-token'), 'bot whoami JSON')
    assert_true('email' not in who_json and who_json['workspace']['name'] == 'Northstar Workshop',
                'bot whoami exposes workspace identity, never synthetic email')
    who_text = run(['--text', 'whoami'], token='fictional-bot-token')
    assert_true('bot in Northstar Workshop, member' in who_text.stdout and 'bots.timdo.invalid' not in who_text.stdout,
                'bot whoami text uses safe workspace identity')

    login_config = os.path.join(HOME, 'login-config')
    login_env = dict(BASE_ENV, TIMDO_CONFIG=login_config)
    login = subprocess.run([BIN, 'login', '--token-stdin'], input='tdo_' + 'x' * 40 + '\n', text=True,
                           capture_output=True, env=login_env, cwd=HOME)
    assert_true(login.returncode == 0 and 'Forum watcher' in login.stdout and 'bots.timdo.invalid' not in login.stdout,
                'bot login output omits synthetic email')

    detail = run(['--text', 'get', TASK_ID], token='fictional-personal-token')
    assert_true(detail.returncode == 0, f'task detail works: {detail.stderr}')
    for marker in ['Forum watcher [bot]', 'via owner secret']:
        assert_true(marker in detail.stdout, f'task detail shows {marker}')
    assert_true('token-name-must-stay-hidden' not in detail.stdout, 'token names stay out of inline activity text')

    notes = run(['--text', 'notes', TASK_ID], token='fictional-personal-token')
    assert_true(notes.returncode == 0 and 'Forum watcher [bot]' in notes.stdout, 'note output marks bot authors')
    activity = run(['--text', 'activity'], token='fictional-personal-token')
    assert_true(activity.returncode == 0 and 'Forum watcher [bot]' in activity.stdout and 'via owner secret' in activity.stdout,
                'activity output marks bot actor and owner-secret provenance')
    assert_true('token-name-must-stay-hidden' not in activity.stdout, 'activity omits token names inline')
    print('PASS: bot identity and attributed CLI text')

    # No command outside bot management accepts the explicit elevation option.
    outside = run(['--json', 'whoami', '--owner-secret'])
    assert_true(outside.returncode != 0 and not any(r['auth'] == 'owner-secret' for r in request_snapshot()[-1:]),
                '--owner-secret is not a general CLI flag')
    print('PASS: owner-secret option is bot-management-only')

    general_help = run(['help'])
    login_help = run(['login', '--help'])
    add_help = run(['add', '--help'])
    update_help = run(['update', '--help'])
    assert_true(general_help.returncode == 0 and login_help.returncode == 0
                and add_help.returncode == 0 and update_help.returncode == 0, 'CLI help commands succeed')
    general_help_text = ' '.join(general_help.stdout.split())
    login_help_text = ' '.join(login_help.stdout.split())
    add_help_text = ' '.join(add_help.stdout.split())
    update_help_text = ' '.join(update_help.stdout.split())
    assert_true(
        'Human-created tasks default to their creator; bot-created tasks default to unassigned.' in general_help_text,
        'general help describes human and bot task assignee defaults',
    )
    assert_true(
        'Bots must use existing projects in their home workspace and cannot be assigned or have life goals.' in general_help_text,
        'general help describes bot workspace, assignee, and goal limits',
    )
    assert_true('TIMDO_TOKEN (personal or bot token)' in general_help_text, 'general help describes both token types')
    assert_true(
        'login Save a personal or bot token' in general_help_text
        and 'Issue bot tokens with: timdo bot token <workspace> <bot>' in general_help_text,
        'general help describes login for personal and bot tokens',
    )
    assert_true(
        'Saves a personal or bot access token' in login_help_text
        and 'Issue a bot token with: timdo bot token <workspace> <bot>' in login_help_text,
        'login help describes personal and bot token setup',
    )
    with open(os.path.join(ROOT, 'mcp', 'README.md'), encoding='utf-8') as readme_file:
        readme_text = ' '.join(readme_file.read().split())
    assert_true(
        'Any configured token is used before `TIMDO_SECRET`' in readme_text
        and 'Used when no token is set' in readme_text
        and 'The CLI uses any configured token, personal or bot, before `TIMDO_SECRET`.' in readme_text,
        'MCP README documents token-first precedence for human and bot tokens',
    )
    assert_true(
        'People can create a personal project when the category matches no accessible writable project' in readme_text
        and 'bots must use an existing writable project in their home workspace, default to unassigned, cannot be assignees, and cannot use life goals.' in readme_text,
        'MCP README documents human and bot task creation rules',
    )
    assert_true(
        'new name to create a project in their personal workspace' in add_help_text
        and 'Bots must use an existing writable project in their home workspace' in add_help_text,
        'add help describes human personal-project creation and bot project scope',
    )
    assert_true(
        'bots default to unassigned' in add_help_text
        and 'bots cannot be assigned' in add_help_text
        and 'bots cannot have life goals' in add_help_text,
        'add help describes bot assignment and goal restrictions',
    )
    assert_true(
        'bots cannot be assignees' in update_help_text
        and 'bots cannot have life goals' in update_help_text,
        'update help describes bot assignment and goal restrictions',
    )
    print('PASS: CLI help matches bot task API rules')

    # The fixture enforces production's create rule: bots cannot send any goalId, even null.
    member_add_before = len(request_snapshot())
    member_add = expect_json(
        run(['--json', 'add', 'Bot default assignment', '--project-id', PROJECT_ID], token='fictional-bot-token'),
        'member bot task create',
    )
    member_add_post = next(
        r for r in request_snapshot()[member_add_before:]
        if r['method'] == 'POST' and r['path'] == '/api/v2/projects'
    )
    assert_true(member_add['assigneeId'] is None, 'member bot task defaults to unassigned')
    assert_true('assigneeId' not in member_add_post['body'], 'default bot create omits assigneeId')
    assert_true('goalId' not in member_add_post['body'], 'default bot create omits goalId')

    assigned_add_before = len(request_snapshot())
    assigned_add = expect_json(
        run(['--json', 'add', 'Bot assigned to human', '--project-id', PROJECT_ID, '--assign', 'Taylor Example'],
            token='fictional-bot-token'),
        'bot task assigned to human',
    )
    assigned_add_post = next(
        r for r in request_snapshot()[assigned_add_before:]
        if r['method'] == 'POST' and r['path'] == '/api/v2/projects'
    )
    assert_true(assigned_add['assigneeId'] == HUMAN_ID, 'bot can assign a task to a human member')
    assert_true(assigned_add_post['body'].get('assigneeId') == HUMAN_ID, 'human assignment is sent to the API')
    assert_true('goalId' not in assigned_add_post['body'], 'assigned bot create still omits goalId')

    created_before_viewer = len(STATE['created_tasks'])
    viewer_before = len(request_snapshot())
    viewer_denied = run(
        ['--json', 'add', 'Viewer cannot create', '--project-id', PROJECT_ID],
        token=VIEWER_BOT_TOKEN,
    )
    viewer_requests = request_snapshot()[viewer_before:]
    viewer_posts = [r for r in viewer_requests if r['method'] == 'POST' and r['path'] == '/api/v2/projects']
    assert_true(viewer_denied.returncode != 0 and 'view-only access' in viewer_denied.stderr.lower(),
                f'viewer bot reaches the project permission denial: {viewer_denied.stderr!r}')
    assert_true(viewer_posts and 'goalId' not in viewer_posts[-1]['body'], 'viewer request omits goalId before denial')
    assert_true(len(STATE['created_tasks']) == created_before_viewer, 'viewer denial creates no task')

    human_goal_before = len(request_snapshot())
    human_task = expect_json(
        run(['--json', 'add', 'Human goal task', '--project-id', PROJECT_ID, '--goal', 'Build better routines'],
            token=HUMAN_TOKEN),
        'human task with life goal',
    )
    human_posts = [r for r in request_snapshot()[human_goal_before:]
                   if r['method'] == 'POST' and r['path'] == '/api/v2/projects']
    assert_true(human_task['goalId'] == HUMAN_GOAL_ID, 'human task retains its explicit goal')
    assert_true(human_posts and human_posts[-1]['body'].get('goalId') == HUMAN_GOAL_ID,
                'resolved human goal is sent to the API')

    bot_goal_before = len(request_snapshot())
    bot_goal = run(
        ['--json', 'add', 'Bot goal attempt', '--project-id', PROJECT_ID, '--goal', 'Build better routines'],
        token='fictional-bot-token',
    )
    bot_goal_requests = request_snapshot()[bot_goal_before:]
    assert_true(bot_goal.returncode != 0 and 'do not have life goals' in bot_goal.stderr.lower(),
                f'explicit bot goal is rejected: rc={bot_goal.returncode}, stderr={bot_goal.stderr!r}, requests={bot_goal_requests!r}')
    assert_true(any(r['method'] == 'GET' and r['path'] == '/api/v2/goals' for r in bot_goal_requests),
                'explicit bot goal uses the rejecting goals API')
    assert_true(not any(r['method'] == 'POST' and r['path'] == '/api/v2/projects' for r in bot_goal_requests),
                'rejected bot goal creates no task')

    member_epic_before = len(request_snapshot())
    member_epic = expect_json(
        run(['--json', 'epic', 'add', 'Watcher epic', '--project-id', PROJECT_ID], token='fictional-bot-token'),
        'member bot epic create',
    )
    member_epic_posts = [r for r in request_snapshot()[member_epic_before:]
                         if r['method'] == 'POST' and r['path'] == '/api/v2/epics']
    assert_true(member_epic_posts and member_epic_posts[-1]['body'].get('projectId') == PROJECT_ID,
                'member bot epic is scoped to its existing home-workspace project')
    assert_true('goalId' not in member_epic_posts[-1]['body'], 'default bot epic create omits goalId')
    assert_true(member_epic['projectId'] == PROJECT_ID, 'created bot epic retains its project scope')

    created_before_viewer_epic = len(STATE['created_epics'])
    viewer_epic_before = len(request_snapshot())
    viewer_epic = run(
        ['--json', 'epic', 'add', 'Viewer cannot create epic', '--project-id', PROJECT_ID],
        token=VIEWER_BOT_TOKEN,
    )
    viewer_epic_requests = request_snapshot()[viewer_epic_before:]
    viewer_epic_posts = [r for r in viewer_epic_requests if r['method'] == 'POST' and r['path'] == '/api/v2/epics']
    assert_true(viewer_epic.returncode != 0 and 'view-only access' in viewer_epic.stderr.lower(),
                f'viewer bot epic reaches the project permission denial: {viewer_epic.stderr!r}')
    assert_true(viewer_epic_posts and 'goalId' not in viewer_epic_posts[-1]['body'],
                'viewer bot epic request omits goalId before denial')
    assert_true(len(STATE['created_epics']) == created_before_viewer_epic, 'viewer denial creates no epic')

    human_epic_before = len(request_snapshot())
    human_epic = expect_json(
        run(['--json', 'epic', 'add', 'Human goal epic', '--project-id', PROJECT_ID,
             '--goal', 'Build better routines'], token=HUMAN_TOKEN),
        'human epic with life goal',
    )
    human_epic_posts = [r for r in request_snapshot()[human_epic_before:]
                        if r['method'] == 'POST' and r['path'] == '/api/v2/epics']
    assert_true(human_epic['goalId'] == HUMAN_GOAL_ID, 'human epic retains its explicit goal')
    assert_true(human_epic_posts and human_epic_posts[-1]['body'].get('goalId') == HUMAN_GOAL_ID,
                'resolved human epic goal is sent to the API')

    bot_epic_goal_before = len(request_snapshot())
    bot_epic_goal = run(
        ['--json', 'epic', 'add', 'Bot goal epic', '--project-id', PROJECT_ID,
         '--goal', 'Build better routines'],
        token='fictional-bot-token',
    )
    bot_epic_goal_requests = request_snapshot()[bot_epic_goal_before:]
    assert_true(bot_epic_goal.returncode != 0 and 'do not have life goals' in bot_epic_goal.stderr.lower(),
                f'explicit bot epic goal is rejected: rc={bot_epic_goal.returncode}, stderr={bot_epic_goal.stderr!r}')
    assert_true(any(r['method'] == 'GET' and r['path'] == '/api/v2/goals' for r in bot_epic_goal_requests),
                'explicit bot epic goal uses the rejecting goals API')
    assert_true(not any(r['method'] == 'POST' and r['path'] == '/api/v2/epics' for r in bot_epic_goal_requests),
                'rejected bot goal creates no epic')
    print('PASS: bot epic goal, project scope, and permission rules')

    task_update_before = len(request_snapshot())
    bot_task_update = run(
        ['--json', 'update', TASK_ID, '--goal', 'Build better routines'],
        token='fictional-bot-token',
    )
    task_update_requests = request_snapshot()[task_update_before:]
    assert_true(bot_task_update.returncode != 0 and 'do not have life goals' in bot_task_update.stderr.lower(),
                'bot task update propagates the failed goal lookup')
    assert_true(any(r['method'] == 'GET' and r['path'] == '/api/v2/goals' for r in task_update_requests),
                'bot task update attempted the goal lookup')
    assert_true(not any(r['method'] == 'PUT' and r['path'] == f'/api/v2/projects/{TASK_ID}'
                        for r in task_update_requests),
                'failed task goal lookup sends no update')

    epic_update_before = len(request_snapshot())
    bot_epic_update = run(
        ['--json', 'epic', 'update', 'Existing watcher epic', '--goal', 'Build better routines'],
        token='fictional-bot-token',
    )
    epic_update_requests = request_snapshot()[epic_update_before:]
    assert_true(bot_epic_update.returncode != 0 and 'do not have life goals' in bot_epic_update.stderr.lower(),
                'bot epic update propagates the failed goal lookup')
    assert_true(any(r['method'] == 'GET' and r['path'] == '/api/v2/goals' for r in epic_update_requests),
                'bot epic update attempted the goal lookup')
    assert_true(not any(r['method'] == 'PUT' and r['path'] == f'/api/v2/epics/{EPIC_ID}'
                        for r in epic_update_requests),
                'failed epic goal lookup sends no update')
    print('PASS: task and epic updates propagate failed bot goal lookups')
    print('PASS: bot task goal, assignee, and project permission rules')

    direct_note = run(['--text', 'add-note', TASK_ID, 'A direct bot-authored note'])
    direct_json_note = expect_json(run(['--json', 'add-note', TASK_ID, 'A JSON bot-authored note']), 'JSON add-note')
    STATE['note_author_name'] = 'Taylor Example'
    STATE['note_author_kind'] = 'human'
    human_note = run(['--text', 'add-note', TASK_ID, 'A direct human-authored note'])
    STATE['note_author_name'] = 'Forum watcher'
    STATE['note_author_kind'] = 'bot'
    duplicate_rc, duplicate_output, duplicate_answered = run_interactive(
        ['--text', 'add', 'Check the release feed', '-p', 'Workshop tools'],
        '1',
        b'add as a note to that task:',
    )
    assert_true(
        direct_note.returncode == 0 and 'as Forum watcher [bot].' in direct_note.stdout,
        f'add-note confirmation identifies bot author: {direct_note.stdout!r} {direct_note.stderr!r}',
    )
    assert_true(
        direct_json_note['authorName'] == 'Forum watcher' and direct_json_note['authorKind'] == 'bot',
        'JSON add-note preserves bot author metadata',
    )
    assert_true(
        human_note.returncode == 0 and 'as Taylor Example.' in human_note.stdout and 'Taylor Example [bot]' not in human_note.stdout,
        f'add-note confirmation leaves human author unmarked: {human_note.stdout!r} {human_note.stderr!r}',
    )
    assert_true(
        duplicate_rc == 0 and duplicate_answered and 'as Forum watcher [bot].' in duplicate_output,
        f'duplicate-note confirmation identifies bot author: {duplicate_output!r}',
    )
    print('PASS: bot authors are marked in note-write confirmations')
finally:
    server.shutdown()
    server.server_close()
    server_thread.join(timeout=2)
    TEMP.cleanup()
PY

echo "ALL CLI BOT TESTS PASSED!"
