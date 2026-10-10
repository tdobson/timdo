# Collaboration: workspaces, sharing and attribution

TimDo is multi-user. This is the model and the API every surface (web, CLI, MCP, voice) uses.

## Model

```
Workspace (Organisation)          e.g. "Alex Rowan" (personal), "Northstar Workshop" (shared)
  ├── Members (role: owner | admin | member | viewer)
  └── Projects                     e.g. "Northstar Workshop", "Acme Solar", "Example Works"
        ├── Epics                  (project-scoped, visible to everyone in the workspace)
        └── Tasks                  (assignee, reporter, last updated by, notes with authors)
Life goals                          personal to each user, never shared
Activity log                        who did what, when, for tasks, notes, epics, projects, members
```

- Everyone has one **personal workspace** (`isPersonal: true`), created on first sign-in.
- Being in a workspace means you can see **every project in it**, plus their epics, tasks, notes and activity.
- **Roles**: `owner` does everything, including changing owner/admin roles and deleting the workspace. `admin` adds and removes members and viewers, and adds, renames, archives and moves projects. `member` works on tasks, epics and notes. `viewer` is read-only. A workspace always keeps at least one owner.
- A project's tasks keep their history when the project is **moved** to another workspace. Moving needs owner/admin rights on the source and edit rights on the destination.
- A task's **category** in the API is just its project's name. Creating a task with a category nobody has yet creates that project in your personal workspace.
- New tasks are **assigned to their creator** unless `assigneeId` says otherwise (`null` = unassigned). Assignees must be members of the task's workspace.
- **Life goals** stay private: `goalId` on a task is the caller's own goal link, and an epic's `goalId` is only shown to the epic's creator.

## API (base `https://timdo-v2-api.tdobson.net/api/v2`)

Auth: `Authorization: Bearer <Auth0 JWT>` (web), or `X-Internal-Secret` (CLI/MCP), which acts as the account owner unless `X-Timdo-User: <email>` names another account.

Permission failures come back as `403 { error }` (not allowed) or `404 { error }` (not visible), with readable messages such as `You have view-only access to "Acme Solar"`.

### Personal access tokens (CLI and MCP)
- People sign in to the CLI with `bin/timdo login`. It takes a personal token (`tdo_...`) created on the web app's **CLI & MCP** page (`/settings/access`), and the MCP server in `mcp/` uses the same login.
- A token acts only as the person who made it. It sends `Authorization: Bearer tdo_...`, and asking to act as anyone else (`X-Timdo-User`) is refused with 403. Tokens are stored hashed, shown once, and can be revoked at any time.
- `GET /users/me/tokens`, `POST /users/me/tokens` `{ name }` (from a signed-in browser session only, so a token can't mint more), `DELETE /users/me/tokens/:id`.
- The owner's internal secret (`X-Internal-Secret`) is for the account owner's own tooling only, and is the only way to act as someone else.

### Who am I
- `GET /users/me` returns `{ id, email, name }`.

### Tasks (original shape, now shared)
- `GET /projects?category=&epicId=&goalId=&customer=&tag=&relatedTo=&assignee=&orgId=&projectId=&ref=&role=`
  - `assignee`: `me` (assigned to me, or unassigned and created by me), `unassigned`, `mine_or_unassigned`, or a user id.
  - `ref`: a URL or `kind:id`; only tasks carrying it (see Refs below). `role` narrows it to one role, as on `DELETE /tasks/:id/refs` (`refRole` still works as an alias).
- `GET /projects/:id` returns one task.
- `POST /projects` takes `{ project, reason?, status, priority, size, notes?, awaitUntil?, gmailThreadId?, category?, projectId?, assigneeId?, customer?, tags?, epicId?, goalId?, refs?, onDuplicate? }`. `refs` is up to 20 `RefInput`s, added with the task (see Refs). A new task is `201` with `created: true` and `similar` (see No duplicates below); `onDuplicate` decides what happens when a `source` ref in `refs` is already tracked.
- `PUT /projects/:id` takes any of the above except `refs`, plus `isDeleted`. Sending `refs` or `removeRefs` on a PUT (here or on `PUT /tasks/:id`) is a 400 pointing at the refs endpoints, rather than a silent 200.
- `DELETE /projects/:id` soft-deletes.
- `POST /projects/batch-update` takes `[{ id, priority, status }]`. Rows you can't edit are skipped.
- `POST /projects/:id/merge` takes `{ sourceId }`.
- `GET /projects/:id/updates` returns notes: `[{ id, projectId, userId, authorName, note, gmailThreadId, createdAt, canDelete }]`.
- `POST /projects/:id/updates` takes `{ note, gmailThreadId? }`.
- `DELETE /projects/:id/updates/:updateId` works for the note's author or a workspace owner/admin.

Each task (`TaskView`) carries the original fields (`id, project, reason, status, priority, size, notes, statusLastChangedOn, awaitUntil, gmailThreadId, category, customer, tags, epicId, goalId, isDeleted, createdAt, updatedAt, userId`) plus:

```
projectId, projectKey, projectName, orgId, orgName,
isShared        workspace has more than one member
myRole          owner | admin | member | viewer
canEdit         false for viewers
reporterId, reporterName
assigneeId, assigneeName
updatedById, updatedByName
isMine          assigned to me, or unassigned and created by me
refs            [RefView], links to things outside TimDo, Source first ([] when none)
```

### Refs (links to things outside TimDo)
A task can point at any number of outside things: a GitHub issue, a forum post, a Gmail thread, a member of another system, any URL. Each ref is written `kind:id` (the canonical form), e.g. `github.issue:acme/widgets#12`, `forum.post:4411`, `acme.member:123456`. Kinds are lowercase dotted slugs; unknown kinds are fine, so a bot can name its own system. Record people by their id in the other system, not by name or email.

Roles: `link` (default, related material), `source` (where the task came from; one live task per workspace per `kind:id`, and a task has one at most), `reported_by` (an outside account that reported it; many allowed), `about` (the outside person or thing it concerns).

Input is parsed by `workers/src/lib/refs.ts` (shared with the web app): GitHub issue/PR URLs become `github.issue` / `github.pr`, Gmail thread URLs `gmail.thread`, Sentry issue URLs `sentry.issue`, email addresses `email`, any other web address `url`, and `kind:id` is taken as written (`http`, `https` and `mailto` are never kinds, even when passed as `kind`). GitHub owner/repo and Gmail hex thread ids are lowercased, so `https://github.com/Acme/Widgets/issues/12` and `github.issue:acme/widgets#12` are the same ref. Anything else is a 400 with a sentence: `Can't tell what that is. Paste a URL, or write it as kind:id, e.g. acme.member:123456`. Refs, labels and urls can't contain line breaks, tabs or other control characters (400 `Links can't contain line breaks, tabs or control characters`, or `Labels can't ...`).

```
RefInput = { ref, kind?, role?, label?, url? }     role also accepts "reported-by"
RefView  = { id, taskId, role, kind, ref, canonical, url, label, displayLabel,
             createdById, createdByName, createdAt, canDelete }
```

- `GET /tasks/:id/refs` returns `[RefView]` to anyone who can see the task.
- `POST /tasks/:id/refs` takes a `RefInput`. `201 RefView` (with `existing: false`), or `200` with `existing: true` when that role and ref are already on the task, so retries are safe. `409 { error, taskId, task }` when the ref is already the `source` of another task in the workspace: `forum.post:4411 is already the source of 3f2a91c0 "Broken offer page"`.
- `DELETE /tasks/:id/refs/:refId` (an id, or an unambiguous id prefix) or `DELETE /tasks/:id/refs?ref=<url|kind:id>&role=` returns `204`. Without `role`, every role of that ref goes. `404 That link isn't on this task` when there's nothing to remove.
- `POST /projects` and `POST /tasks` take `refs` (max 20). They are written in the same batch as the task, so a bad ref (400) or a source clash (409) creates nothing. When several refs come at once, the 400 names the bad one: `"hello": Can't tell what that is...`. Two different sources in one request are a 400 `A task can only have one source` (the same source twice is one). What a create does when its source is already tracked is under No duplicates below.
- A deleted task gives its source up. When a create, `POST /tasks/:id/refs` or a move to another workspace claims a source that only a deleted task holds, that task's source becomes a `link` (or goes, if it already links to the same thing) in the same write, so its history keeps the link. Restoring the deleted task does not take the source back.
- `GET /projects?ref=<url|kind:id>&role=` finds tasks carrying a ref across every workspace you can see, done ones included, deleted ones not.
- `GET /refs/parse?input=&kind=` previews a parse without saving: always `200`, `{ ok: true, value: { kind, ref, canonical, url, label } }` or `{ ok: false, error }`.
- `GET /tasks/search?q=`: a URL or `kind:id` puts tasks carrying it first, flagged `matchedRef: true`. Those exact matches include done tasks (each result has its `status`) even without `includeDone`; word matches still follow it.
- Adding and removing need edit rights (viewers get 403). `gmailThreadId` on a task mirrors its newest `gmail.thread` ref, on create (from `gmailThreadId` or a Gmail ref in `refs`) and on update. Setting it adds a `link` unless that thread is already on the task in any role; sending the value it already has changes nothing; clearing it removes that thread's refs in every role (a source, reporter or about removal is logged too). Merging moves refs to the target (a second source becomes a link); moving a task or project to another workspace moves its refs and is refused if a source would clash with a live task there.
- Labels may hold names, so they never appear in the activity log: summaries use the canonical form, e.g. `Linked "Fix inverter" to github.issue:acme/widgets#12`, `Added reporter acme.member:123456 to "Broken offer page"`, `Set source of "..." to forum.post:4411`, `Removed link ... from "..."`. Refs added with a new task appear in the `created` entry's `changes.refs`.

### No duplicates: tracked sources and similar tasks
Two kinds of duplicate get two answers. A machine duplicate (a watcher seeing the same forum post twice, a retried webhook, two workers racing) is caught exactly, by the task's `source` ref. A human duplicate ("Fix offer page" when "Broken offer page" exists) is caught by words, and shown as suggestions.

**Creating with a source.** `POST /projects` and `POST /tasks` take `onDuplicate: "error" | "return" | "report"`. It only matters when `refs` has a `source` and a live (not deleted) task in the target workspace already holds it; otherwise it is ignored.

| `onDuplicate` | Status | Body | Writes |
|---|---|---|---|
| none or `error` | `409` | `{ error, taskId, task }` | nothing |
| `return` | `200` | the existing task, `created: false` | nothing |
| `report` | `200` | the existing task, `created: false, reported: true` | see below |
| (no clash) | `201` | the new task, `created: true, similar: [...]` | the task |

- The `409` message reads `forum.post:4411 is already the source of 3f2a91c0 "Broken offer page"`, and `task` is that task's `TaskView`, so a client can show it without another request. The holder is in the same workspace by definition, so this never reveals another workspace.
- `report` adds to the existing task through the normal paths, so it is all in the activity log under the caller's name: each non-source ref in the request (`reported_by`, `about`, `link`; ones already there are skipped), then a note `Reported again: "<request title>"`, with the request's `notes` on the next line when given. There is no note when the title matches the task's, there are no notes and no ref was new (a pure retry adds nothing), or when the task already has that exact note (a retry with notes adds it once). It needs edit rights: viewers get `403` and nothing is added.
- Done tasks are returned or reported to as they are. They are not reopened.
- Races are safe. The source index is the lock: if two creates race, one gets `201` and the other gets its `onDuplicate` answer for the winner. A retried request under `return` or `report` gets the same task id back.
- `POST /projects` answers in the `TaskView` shape; `POST /tasks` answers in its own shape (the Tasks row plus `refs`), with the same `created`, `reported` and `similar` fields. The `409` `task` is a `TaskView` on both.
- To check without creating: `GET /projects?ref=forum.post:4411&role=source`. Only create-with-source is race-safe, so a watcher should create with `onDuplicate` rather than check first.

**Similar open tasks.** `GET /tasks/similar?title=&projectId=&orgId=&category=&excludeId=&limit=` returns up to `limit` (default 3, at most 10) open tasks you can see that look like `title`, best first:

```
SimilarTask = { id, shortId, title, status, projectId, projectName, orgId, orgName,
                assigneeId, assigneeName, score, canEdit, matchedRef: false }
```

- Scope: the workspace of `projectId`, or `orgId`, or the workspace a create with `category` (a project name) would land in; all your workspaces when none is given. A project or workspace you can't see is a `404`. Done, deleted and invisible tasks are never suggested.
- Matching: the title is lowercased and split into words; common English words and words under 3 letters are dropped. Fewer than 2 words left gives `[]`. The service searches a bounded sample of prefix terms, then scores each candidate against every significant query word in its title, reason and notes. A word in the title counts 1 and a word only in the reason or notes counts 0.5; `score` is that total over the number of words (0.5 to 1). A task needs at least 2 matching words and a score of 0.5, so "Call Robin" suggests tasks about calling Robin, not every task with "call" in it.
- `canEdit` says whether you can add a note or otherwise edit the result. Do not offer an edit action for a read-only match.
- `excludeId` leaves one task out (the one being edited). `title` is required (`400 Say what the task is called: ?title=`) and limited to 500 characters. `limit` must be a whole number (larger values are capped at 10).
- A new task's `201` carries `similar` too: the top 3 in its workspace, never itself. A client that did not check first can still say "this looks like 3f2a91c0" and offer to add a note there instead.

The recipe for an outside system creating tasks (tokens, the request in curl, CLI and MCP form, what to store) is in [integrations.md](integrations.md).

### Epics
- `GET /epics?category=` lists every epic you can see. `GET /epics/:id` returns one.
- `POST /epics` takes `{ title, description?, category?, projectId?, goalId?, status? }`. `PUT /epics/:id` and `DELETE /epics/:id` work as you'd expect.
- Each epic carries `projectId, projectKey, orgId, orgName, isShared, myRole, canEdit, createdById, createdByName, updatedById, updatedByName`, plus stats (`totalTasks, doneTasks, progressPercentage`).

### Workspaces and sharing
- `GET /organisations` lists `[{ id, name, slug, isPersonal, role, memberCount, projectCount, createdBy }]`, personal first.
- `GET /organisations/sharing` returns, per workspace: `{ ...org, members: [{ userId, userName, userEmail, role, isMe }], projects: [{ id, key, name, description, isArchived, openTasks, doneTasks, epicCount }], invites: [{ id, email, role, token, expiresAt }] }`.
- `POST /organisations` takes `{ name }` and creates a shared workspace. `PUT /organisations/:id` takes `{ name }`. `DELETE /organisations/:id` removes an empty, non-personal workspace (owner only).
- `GET /organisations/:id/members`, and `GET /organisations/:id/users/search?q=` (needs 2+ characters).
- `POST /organisations/:id/invites` takes `{ email, role: admin|member|viewer }` and returns one of:
  - `{ status: 'added', userId, name, email, role }`: they already had an account and are in now.
  - `{ status: 'already_member', ... }`
  - `{ status: 'invited', id, email, role, token, expiresAt }`: they join automatically when they first sign in with that email. The invite link is `https://timdo.tdobson.net/invite/<token>`.
- `DELETE /organisations/:id/invites/:inviteId` revokes an invite.
- `POST /organisations/invites/accept` takes `{ token }`.
- `PUT /organisations/:id/members/:userId` takes `{ role }`.
- `DELETE /organisations/:id/members/:userId` removes someone. Pass your own id to leave.
- `GET /organisations/:id/projects`, and `POST /organisations/:id/projects` with `{ name, description? }`.
- `PUT /organisations/:id/projects/:projectId` takes `{ name?, description?, isArchived?, orgId? }`. `orgId` moves the project to that workspace.

### Activity
- `GET /activity?taskId=&epicId=&projectId=&orgId=&limit=` returns newest first: `[{ id, actorId, actorName, orgId, projectId, projectName, entityType, entityId, taskId, epicId, action, summary, changes, createdAt }]`.
  - `actorName` is `TimDo` for system actions, such as an awaiting task coming back to Do.
  - Actions: `created, updated, status_changed, completed, assigned, moved, deleted, restored, merged, note_added, note_deleted, ref_added, ref_removed, renamed, archived, unarchived, invited, member_added, member_joined, member_left, member_removed, role_changed`.
  - `summary` is a ready-to-show sentence without the actor, e.g. `Moved "Fix inverter" from Do to Done`. Show it as `Robin Fairweather · Moved "Fix inverter" from Do to Done · 2h ago`.

### Posters
The active poster and the Wall of Done are personal. They show the caller's own tasks (`assignee=me`) across all workspaces.

## CLI (`bin/timdo`) and MCP (`timdo_*`)

The CLI talks to this API with `X-Internal-Secret`, so it acts as the account owner (Tim). Everything below works the same through the MCP tools, which run `bin/timdo --json`.

- **Acting as someone else**: `--as <email>` (anywhere on the line) or `TIMDO_AS=<email>` sends `X-Timdo-User`. Use it to preview a collaborator's view, e.g. `timdo --as robin@example.com list do --mine`. Every MCP tool takes an optional `asUser`. Only write as someone else when Tim asks.
- **Config**: `TIMDO_SECRET`, `TIMDO_API` and `TIMDO_AS` in the environment override `~/.config/timdo/config`, so `TIMDO_API=http://127.0.0.1:8788/api/v2 TIMDO_SECRET=local-dev-secret bin/timdo ...` hits a local API (`workers/scripts/local-api.sh 8788`).
- **Output**: list-style commands print aligned text; shared tasks show `Workspace/Project` and the assignee's first name (`me`, `unassigned`). Colour only on a terminal, never with `NO_COLOR`. `--json` gives the raw API objects. `add`, `update`, `delete`, `add-note` and `epic add/update/delete` still print JSON when piped (scripts rely on it) and a readable confirmation on a terminal or with `--text`.
- **Errors** exit 1 with the API's message: `View only: you have view-only access to "Acme Solar"`, `Not found: ...`, `Not allowed: ...`. Short ID prefixes that match several tasks are refused, not guessed.
- **Assignment**: `add/update --assign <me|none|name|email>` resolves the person among the members of the task's workspace and sends `assigneeId`; `update --claim` and `--unassign` too. `list --mine` / `--unassigned` / `--assignee <who>` / `-w <workspace>` / `--project-id <KEY>` filter on the server.
- **Projects**: `-p <name>` is the category name. A name that exists in a shared workspace puts the task there (the first one you can edit); an unknown name creates a project in your personal workspace. `--project-id` takes an id, a key such as `SOL`, or `Workspace/Project`.
- **Audit**: `timdo audit` reports on your own editable tasks (assigned to you, or unassigned and created by you) and epics you created. Collaborators' tasks are theirs to tidy, and goal links are private, so their "missing goal" count means nothing to you. `--all` covers everything you can edit.
- **Search and customers**: the search endpoint has no sharing fields yet, so the CLI adds `orgName`, `projectName`, `assigneeName` and friends from `GET /projects`; `customers` adds a `workspaces` list the same way.
- **Workspaces**: `timdo workspace` (aliases `ws`, `org`): `list`, `show`, `members`, `create`, `rename`, `share <ws> <email> [--role member|viewer|admin]` (prints added, already a member, or the invite link), `role`, `remove`, `revoke`, `leave`, `add-project`, `move-project <project> <ws> --yes`, `accept <token>`. `remove`, `leave` and `move-project` ask on a terminal and need `--yes` otherwise.
- **Activity**: `timdo activity [--task] [--epic] [--project] [--workspace] [-n N]` prints `08 Oct 14:02  Robin Fairweather  Moved "Fix inverter" from Do to Done  [Acme Solar]`. `timdo get` and `timdo epic get` show recent activity too.
- **Who am I**: `timdo whoami` (MCP `timdo_whoami`).
- **No duplicates**: `add --on-duplicate error|return|report` maps to `onDuplicate` and handles exact `source` ref clashes only. It does not skip the fuzzy prompt. With `return` or `report`, text output says `Already tracked as 3f2a91c0 "..."` and exits 0. A default `error` response exits 1 with `Already tracked: ... Open it with: timdo get <short id>. To add this report to that task instead: --on-duplicate report`.
  - On a terminal, `add` checks for similar open tasks and asks `Create anyway? [y]es / [n]o / [1-3] add as a note to that task:`. Enter defaults to no. `--yes`, `--json` and non-terminal calls skip the prompt; they show any matches on stderr as `Similar open task: 3f2a91c0 "Broken offer page" (Acme Solar)`. Answering with a number adds the title, reason, notes and any ref flags to that task as a note; y creates, n cancels.
  - `timdo similar "<title>" [-p project]` checks without creating. It also takes `--project-id`, `-w`, `--limit`, `--exclude` and `--title` (use `--title` when the title starts with a dash). Results mark read-only tasks with `canEdit: false`; do not recommend an edit the caller cannot make.
  - MCP: `onDuplicate` on `timdo_add_task` (its result carries `created` and `similar`); `timdo_find_similar({ title, project?, projectId?, workspace?, limit?, excludeId? })` takes the same scopes and limits. Check `canEdit` before adding a note.
  - Voice: a proposed new task that looks like an open one shows "Looks like an existing task" on the review screen, with a switch to add it as a note there instead.
- **Refs**: `add`/`update` take `--ref`, `--source`, `--reported-by` and `--about` (each a URL or `kind:id`, repeatable), plus `--refs-json '[{"ref":"123456","kind":"acme.member","role":"reported_by"}]'` for scripts, and `update --unref <x>` (update's ref changes go through the refs endpoint after the task change). A source clash prints `Already tracked: ... Open it with: timdo get <short id>` and exits 1. Removals print the activity log's words (`Removed reporter acme.member:123456 ...`). `--link` and `--unlink` are not ref flags: they mean task links (`timdo link`). `timdo ref list|add|rm <task> ...` (`ref rm <ref id> --role r` fails if that ref has another role), `timdo find <url|kind:id> [--role r]` (any status; list options can go before or after the ref) and `list ... --ref <x> [--ref-role r]`. `timdo get` prints a Links block grouped by role. MCP: `refs` and `removeRefs` on `timdo_add_task` / `timdo_update_task`, `ref` on `timdo_list_tasks`, and `timdo_add_ref`, `timdo_remove_ref`, `timdo_find_by_ref`. The MCP runs `timdo --json -- <command> ...`, so a value that looks like a global flag (`--as=...`) cannot switch the acting user, and it refuses refs that start with `-`.
