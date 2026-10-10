# Creating tasks from another system

This is the recipe for a watcher, bot or webhook that turns things it sees elsewhere (forum posts, issues, form submissions) into TimDo tasks. The short version: give every task the outside item as its `source`, and say `onDuplicate: "report"`. Then you can send the same item as often as you like and TimDo keeps one task for it.

The examples use a made-up forum for Acme Solar: post 4411 at `https://forum.example.org/t/4411`, reported by member 123456. The full API is in [collaboration.md](collaboration.md).

## 1. Get a token

Sign in to the web app, open **CLI & MCP** (`/settings/access`) and create a personal token. It starts with `tdo_` and is shown once. Send it as `Authorization: Bearer tdo_...`.

A token acts as the person who made it, so every task and note the watcher writes is attributed to them. Make the token on the account that should own the watcher's work, and revoke it from the same page if it leaks. Separate bot accounts are planned; until then a personal token is the way in.

```bash
export TIMDO_API=https://timdo-v2-api.tdobson.net/api/v2   # or your own worker's /api/v2
export TIMDO_TOKEN=tdo_...
```

## 2. Find the project id

Tasks live in projects, and projects live in workspaces. Use the project's id rather than its name: a name nobody has yet creates a new project in your personal workspace, which is not where a typo should send a customer's report.

```bash
curl -sS "$TIMDO_API/organisations" -H "Authorization: Bearer $TIMDO_TOKEN"
curl -sS "$TIMDO_API/organisations/<workspace id>/projects" -H "Authorization: Bearer $TIMDO_TOKEN"
```

## 3. Create with a source

```bash
curl -sS -X POST "$TIMDO_API/projects" \
  -H "Authorization: Bearer $TIMDO_TOKEN" \
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
curl -sS "$TIMDO_API/projects?ref=forum.post:4411&role=source" -H "Authorization: Bearer $TIMDO_TOKEN"
bin/timdo find forum.post:4411 --role source
```

MCP: `timdo_find_by_ref({ "ref": "forum.post:4411", "role": "source" })`.

Checking first and then creating leaves a gap another worker can slip through. Creating with a source and `onDuplicate` has no gap: the source is unique per workspace in the database, so two racing creates end with one task.

When a person (or an agent) creates from free text there is no source to go on. Ask for similar open tasks before creating, and offer to add a note to one of them instead:

```bash
curl -sS -G "$TIMDO_API/tasks/similar" --data-urlencode "title=Fix the offer page" \
  --data-urlencode "projectId=<project id>" -H "Authorization: Bearer $TIMDO_TOKEN"
bin/timdo similar "Fix the offer page" -p Website
```

MCP: `timdo_find_similar({ "title": "Fix the offer page", "project": "Website", "limit": 5 })`. You can scope it with `project`, `projectId` or `workspace`, and use `excludeId` when editing an existing task. Each result has `id`, `shortId`, `title`, `status`, `projectName`, `orgName`, `assigneeName`, `score` and `canEdit`. Add a note only when `canEdit` is true. Titles need at least two meaningful words and can be up to 500 characters.

## Rules of thumb

- One source per outside item, and one source per task. If two posts describe the same problem, add the second post as a `link` on the first task and its reporter as a `reported_by` ref, not another source.
- Record people by their id in the other system (`acme.member:123456`), not by name or email.
- Keep contact details out of titles, reasons and notes. Everyone in the workspace reads them, and the activity log keeps titles.
- Retries are safe with `return` or `report` while the task still holds that source in the requested workspace. If the source is removed or the holder is deleted or moved, TimDo resolves the current claim before writing; it may create a replacement task.
- Labels on refs are display text. Use descriptions such as `Forum thread` rather than names or contact details.
