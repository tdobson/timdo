# Creating tasks from another system

This is the recipe for a watcher, bot or webhook that turns things it sees elsewhere (forum posts, issues, form submissions) into TimDo tasks. The short version: give every task the outside item as its `source`, and say `onDuplicate: "report"`. Then you can send the same item as often as you like and TimDo keeps one task for it.

The examples use a made-up forum for Acme Solar: post 4411 at `https://forum.example.org/t/4411`, reported by member 123456. The full API is in [collaboration.md](collaboration.md).

## 1. Get a token

For a workspace integration, ask a human owner/admin to create a `member` bot in **Sharing** (`/sharing`). Its token starts with `tdo_` and is shown once. The watcher then has its own name in task history, can only reach that workspace, and creates unassigned tasks unless it names an eligible human assignee. A `viewer` bot can read but cannot submit reports.

See [Workspace bots and activity attribution](bots-and-attribution.md) for setup, rotation and lost-response recovery. Never give an integration the installation owner's internal secret. A personal token from **CLI & MCP** (`/settings/access`) is still available for work that should act as you, but it has your visibility and attribution rather than a bot's workspace boundary.

Load the token from a secret store in an unattended watcher. For a one-off Bash session, this prompts without displaying it or putting it in shell history. The helper passes the header through curl's standard input, not its command arguments. Leave shell tracing off while handling credentials.

```bash
export TIMDO_API=https://timdo-v2-api.tdobson.net/api/v2   # or your own worker's /api/v2
read -r -s -p 'TimDo token: ' TIMDO_TOKEN
printf '\n'
export TIMDO_TOKEN

timdo_api() {
  curl --silent --show-error --fail-with-body --config - "$@" <<EOF
header = "Authorization: Bearer ${TIMDO_TOKEN:?Set TIMDO_TOKEN from a secret store}"
EOF
}
```

## 2. Find the project id

Tasks live in projects, and projects live in workspaces. Use an existing project's ID rather than its name. Bots cannot create projects or submit tasks outside their home workspace. With a human token, an unknown category can create a project in their personal workspace, which is not where a typo should send a customer's report.

```bash
timdo_api "$TIMDO_API/organisations"
timdo_api "$TIMDO_API/organisations/<workspace id>/projects"
```

## 3. Create with a source

```bash
timdo_api -X POST "$TIMDO_API/projects" \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "Broken offer page",
    "projectId": "<project id>",
    "reason": "Reported on the Acme Solar forum",
    "refs": [
      { "ref": "forum.post:4411", "role": "source", "url": "https://forum.example.org/t/4411" },
      { "ref": "acme.member:123456", "role": "reported_by" }
    ],
    "onDuplicate": "report"
  }'
```

`forum.post:4411` is the outside item written as `kind:id`. Pick a kind for your system (lowercase, dotted, like `forum.post` or `acme.member`) and stick to it: the same item must always produce the same `kind:id`, or TimDo can't tell it has seen it. Known URLs (GitHub issues, Gmail threads, Sentry issues) can be pasted as they are.

The same thing from the CLI and from an MCP client:

```bash
bin/timdo add "Broken offer page" --project-id "Acme Solar/Website" \
  --source forum.post:4411 --reported-by acme.member:123456 --on-duplicate report
```

```json
{
  "tool": "timdo_add_task",
  "arguments": {
    "project": "Broken offer page",
    "projectId": "Acme Solar/Website",
    "refs": [
      { "ref": "forum.post:4411", "role": "source" },
      { "ref": "acme.member:123456", "role": "reported_by" }
    ],
    "onDuplicate": "report"
  }
}
```

## 4. Read the answer

| Status | Means | Body |
|---|---|---|
| `201` | New task | the task, `created: true`, and `similar` (open tasks that look like it) |
| `200` | Already tracked (`return` or `report`) | the existing task, `created: false`; `reported: true` after a report |
| `409` | Already tracked, and you asked for `error` (the default) | `{ error, taskId, task }` |
| `400` | Something in the request is wrong | `{ error }`, a sentence saying what |
| `403` | The token can't write to that project | `{ error }`, e.g. `You have view-only access to "Website"` |

Store the task's `id` (or `taskId` from a 409) against your item if you want to link back to it. You don't have to: the source ref is the link, and you can always look the task up by it.

What `report` adds to the existing task: any `reported_by`, `about` or `link` refs it doesn't have yet, and a note `Reported again: "<your title>"` with your `notes` underneath. A request that adds nothing new (same title, no notes, no new refs) writes nothing, and the same note is never added twice. Done tasks stay done; a new report doesn't reopen them.

`onDuplicate` choices:

- `report` for watchers: a second sighting with a new reporter gets recorded on the task.
- `return` when you only want the id and never want to change anything.
- `error` (the default) when a duplicate means something went wrong on your side.

## 5. Look things up

Find the task for an item, any status:

```bash
timdo_api "$TIMDO_API/projects?ref=forum.post:4411&role=source"
bin/timdo find forum.post:4411 --role source
```

MCP: `timdo_find_by_ref({ "ref": "forum.post:4411", "role": "source" })`.

Checking first and then creating leaves a gap another worker can slip through. Creating with a source and `onDuplicate` has no gap: the source is unique per workspace in the database, so two racing creates end with one task.

When a person (or an agent) creates from free text there is no source to go on. Ask for similar open tasks before creating, and offer to add a note to one of them instead:

```bash
timdo_api -G "$TIMDO_API/tasks/similar" --data-urlencode "title=Fix the offer page" \
  --data-urlencode "projectId=<project id>"
bin/timdo similar "Fix the offer page" -p Website
```

MCP: `timdo_find_similar({ "title": "Fix the offer page", "project": "Website", "limit": 5 })`. You can scope it with `project`, `projectId` or `workspace`, and use `excludeId` when editing an existing task. Each result has `id`, `shortId`, `title`, `status`, `projectName`, `orgName`, `assigneeName`, `score` and `canEdit`. Add a note only when `canEdit` is true. Titles need at least two meaningful words and can be up to 500 characters.

## Rules of thumb

- One source per outside item, and one source per task. If two posts describe the same problem, add the second post as a `link` on the first task and its reporter as a `reported_by` ref, not another source.
- Record people by their id in the other system (`acme.member:123456`), not by name or email.
- Keep contact details out of titles, reasons and notes. Everyone in the workspace reads them, and the activity log keeps titles.
- Retries are safe with `return` or `report` while the task still holds that source in the requested workspace. If the source is removed or the holder is deleted or moved, TimDo resolves the current claim before writing; it may create a replacement task.
- Labels on refs are display text. Use descriptions such as `Forum thread` rather than names or contact details.

## Paged activity

`GET /api/v2/activity?paged=1` opts into cursor pagination while keeping the existing array response body. The first request may include `limit` (1 to 500, default 100) and the existing filters: `taskId`, `epicId`, `projectId` and `orgId`. When another page exists, read its opaque token from the `X-Next-Cursor` response header and send it as `before` on the next request, keeping `paged=1` and the same filters. There is no cursor field in the body. If the response has no `X-Next-Cursor`, the walk is complete.

Paged requests and their errors use `Cache-Control: no-store`. The cursor is bound to the caller, visible workspace memberships and filters. A changed membership or a sequence that moved backwards returns 409; start again with a fresh first-page request. `paged` must be exactly `1`. Without `paged=1`, the legacy endpoint is unchanged: it returns the existing array with `Cache-Control: private, max-age=15`, with no continuation header. Other `paged` values return 400 rather than falling back to that legacy response.

## Recorded events feed

The events feed lets an integration read recorded activity without polling every task. It reports activity that TimDo has recorded; it does not guarantee an event for every successful mutation. Ordinary activity logging is fail-soft, so a mutation can succeed while its log write fails. The feed is not a transactional outbox and cannot promise complete mutation delivery or exactly-once actions in another system.

Each successful read returns one version 1 page envelope, even when the page has no events:

```json
{
  "version": 1,
  "events": [],
  "next": "<opaque cursor>",
  "hasMore": false
}
```

Use `after=0` to start at recorded history or `after=latest` to skip to the current high-water mark. For later pages, send the previous response's `next` value as `after`. A catch-up walk holds one high-water mark until `hasMore` is false. The next request after that starts a new walk. Sequence numbers are internal and are not returned.

Task state and refs are read from their current values on each request. The high-water mark does not freeze those records or the caller's workspace memberships. Read current task state when an integration needs to reconcile its own record.

### Event types

The registry is explicit. Unknown stored actions are skipped while the cursor continues to advance. New public types are added deliberately; consumers should ignore types they do not recognise.

| Stored activity | Public event type |
|---|---|
| Task: `created`, `updated`, `status_changed`, `completed`, `assigned`, `moved`, `deleted`, `restored`, `merged`, `linked` | `task.<action>` |
| Task moved out of a workspace | `task.moved_out` |
| Task ref added or removed | `ref.added`, `ref.removed` |
| Note added or deleted | `note.added`, `note.deleted` |
| Epic: `created`, `updated`, `status_changed`, `completed`, `moved`, `deleted` | `epic.<action>` |
| Project: `created`, `renamed`, `archived`, `unarchived` | `project.<action>` |
| Project move source row or destination row | `project.moved_out`, `project.moved` |
| Organisation created or renamed | `organisation.created`, `organisation.renamed` |
| Member added, invited, joined, role changed, left or removed | `member.added`, `member.invited`, `member.joined`, `member.role_changed`, `member.left`, `member.removed` |
| Bot created, renamed, role changed, disabled, token created or token revoked | `bot.created`, `bot.renamed`, `bot.role_changed`, `bot.disabled`, `bot.token_created`, `bot.token_revoked` |

The feed uses `task.completed` for a change to `done`. That request can also create a separate update, assignment or move event. Awaiting tasks returning to Do use `task.status_changed` with system attribution.

A cross-workspace task move records a generic `task.moved_out` in the source and a `task.moved` in the destination. The source event contains no destination details. A project move has a redacted source `project.moved_out` and a destination `project.moved`. Treat these as invalidation hints, not instructions to erase an outside record. A merge records `task.merged` against the surviving target; no source-task merge event is emitted. No separate `task.unlinked` event is recorded. A whole-project move creates project move markers but no extra source-task move-out events. Reconcile current state when those distinctions matter.

### API access and cursors

`GET /api/v2/events` accepts `after`, `workspace`, `types`, `include` and `limit`. Omit `after` or set it to `0` to start at recorded history; use `latest` to skip to the current high-water mark. Omit `workspace` to read all workspaces the current credential can access. An explicit workspace may be its ID or slug. Omit `types` for all registered event types; it also accepts registered values or prefixes such as `task.*`. Filters are normalised. `limit` is an integer from 1 to 500, default 100. `include` accepts `refs`, `text` or both. Responses and errors are marked `Cache-Control: no-store`.

Using the `timdo_api` helper from the token section, a first request looks like this:

```bash
timdo_api "$TIMDO_API/events?after=0&limit=100"
```

Every request checks current permissions. Bots stay within their home workspace. An explicit workspace that is unknown or inaccessible returns 404. Cursors for all-workspace reads bind to the caller's current memberships and roles. An add, removal, rejoin or role change makes an all-workspace cursor stale and returns 409; restart from `0` and deduplicate by event ID. A cursor scoped to one workspace is not invalidated by an unrelated membership change. A membership or role change in that workspace makes its cursor stale; losing access returns 404. A principal or filter mismatch also returns 409. Malformed, tampered or wrong-key cursors return 400.

The Worker uses a separate 32-byte base64url `EVENT_CURSOR_KEY`; it is not the owner's internal secret. A missing or invalid key returns 503 for cursor requests. Rotating the key invalidates existing cursors. After rotation, restart from `0` and deduplicate by event ID, or choose `latest` if old activity should be skipped. After restoring the database, rotate the key before reading events because the sequence high-water mark may have moved backwards. Cursor keys belong in the Worker secret store, never in a CLI state file or command line.

The default event projection contains identifiers, time, public type, actor ID and kind, the fixed `via` value, safe status changes and minimal current task state. It omits titles, summaries, actor display names, full notes and raw change data. `via` describes the authentication path and does not prove which user interface made the request.

Use `--include-refs` only when the consumer needs refs. It returns canonical `role` and `kind:id` values, without labels or URLs. A canonical ref can still contain an email address, URL or user text. `--include-text` adds the current task title, event summary and an explicit actor display name. Summaries can contain user prose or personal information. Text opt-in never returns full note bodies, email fallbacks, token names or IDs, private goals, or `viaDetail`. Token lifecycle summaries stay generic.

### CLI pages and checkpoints

The CLI needs Bash, curl and jq. Persistent checkpoints also use Node.js built-ins through `bin/timdo-events-state.js`; no package install is needed. The standalone MCP server needs Node.js 18 or newer. Credentials follow the existing CLI login/config convention. For a direct curl call, the `timdo_api` helper above gives curl its auth header through `--config -` on standard input. Do not put credentials in command arguments or logs.

A finite CLI read prints one page. `--json` returns the complete envelope, including an empty page. `--text` is the global output-format option; it does not request sensitive text. `--include-text` and `--include-refs` control disclosure. The `-n` page limit accepts 1 to 500.

```bash
bin/timdo --json events --after 0 --workspace <workspace-id> --types 'task.completed,ref.added' --include-refs -n 100
```

`--follow` drains every `hasMore` page immediately, then waits 30 seconds before polling again. Set `--interval` to an integer from 1 to 3600 seconds to change the wait. JSON output is one compact page envelope per line, including the page metadata. The cursor exists only in memory and advances after a page is written successfully. Fetch and output errors stop the command. SIGINT and SIGTERM stop it cleanly. Follow cannot be combined with a state file.

A checkpoint is an explicit consumer decision. One consumer should own each file. Create a private directory first; the state file must be a regular owner-only `0600` file and symlink paths are refused. `init` never replaces an existing file. `--after 0` starts a replay, while `--after latest` deliberately skips activity already recorded at initialisation. The file stores version, normalised API base, current principal ID, canonical workspace ID or all-workspace scope, normalised type and include filters, and cursor. If `--types` is omitted, the checkpoint freezes the registered type list that existed at initialisation; it does not silently subscribe to types added later. Create a new checkpoint to adopt a changed type list. The file contains no credential or event body.

```bash
install -d -m 700 ./private
STATE=./private/events.json
PAGE=./private/events-page.json
bin/timdo events init --state-file "$STATE" --after 0 --workspace <workspace-id> --types task.completed --include-refs
OLD=$(jq -r '.cursor' "$STATE")
bin/timdo --json events --state-file "$STATE" > "$PAGE"
NEXT=$(jq -r '.next' "$PAGE")
# Process every event in "$PAGE" and fail if any intended action fails.
bin/timdo events ack --state-file "$STATE" --from "$OLD" --to "$NEXT"
```

A state-file read does not advance the cursor. Explicit filters or scope must match the values saved by `init`; `--limit` may change between reads. A different API base or principal fails closed. The CLI uses the selected credential and does not retry a denial with the owner's secret. `ack` is a compare-and-swap from the expected old cursor. Repeating an acknowledgement that already reached `NEXT` succeeds; a stale or concurrent update fails. Ack means the consumer says its work is complete. It is not proof that a receiver acted, and stdout never acknowledges a page. Store each immutable event ID as the receiver's idempotency key. If an action succeeds and the process stops before ack, the page will be read again. The state-file lock serialises checkpoint writes; it does not make a remote action and the checkpoint atomic. An existing lock is left untouched.

The local example at [`examples/events-replay-consumer.mjs`](../examples/events-replay-consumer.mjs) uses only fictional event IDs and a local receiver. Run it with `node examples/events-replay-consumer.mjs`; test it with `node --test tests/eventsReplayConsumer.test.mjs`. The first attempt applies one local action and then fails. The retry skips the action already recorded by event ID, applies the remaining action and returns a cursor candidate for the caller to acknowledge. No network request or real outside action is made. A real receiver still needs its own idempotency handling; TimDo cannot guarantee exactly-once effects in an arbitrary system.

### Standalone MCP

`timdo_events({ after, workspace, types, includeRefs, includeText, limit })` returns one page object with the same versioned envelope. It has no follow loop, state-file argument or raw credential input. Like other MCP tools it may take `asUser`, which only selects the alternate identity when the CLI's owner secret is already in use. A personal or bot token cannot switch identity, and a denied request is not retried with a more privileged credential. See [the MCP guide](../mcp/README.md) for setup.
