# Collaboration: workspaces, sharing and attribution

TimDo is multi-user. This is the model and the API every surface (web, CLI, MCP, voice) uses.

## Model

```
Workspace (Organisation)          e.g. "Tim Dobson" (personal), "Migrating Dragons" (shared)
  ├── Members (role: owner | admin | member | viewer)
  └── Projects                     e.g. "Migrating Dragons", "Solfit", "Xebit Ltd"
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

Permission failures come back as `403 { error }` (not allowed) or `404 { error }` (not visible), with readable messages such as `You have view-only access to "Solfit"`.

### Personal access tokens (CLI and MCP)
- People sign in to the CLI with `bin/timdo login`. It takes a personal token (`tdo_...`) created on the web app's **CLI & MCP** page (`/settings/access`), and the MCP server in `mcp/` uses the same login.
- A token acts only as the person who made it. It sends `Authorization: Bearer tdo_...`, and asking to act as anyone else (`X-Timdo-User`) is refused with 403. Tokens are stored hashed, shown once, and can be revoked at any time.
- `GET /users/me/tokens`, `POST /users/me/tokens` `{ name }` (from a signed-in browser session only, so a token can't mint more), `DELETE /users/me/tokens/:id`.
- The owner's internal secret (`X-Internal-Secret`) is for the account owner's own tooling only, and is the only way to act as someone else.

### Who am I
- `GET /users/me` returns `{ id, email, name }`.

### Tasks (original shape, now shared)
- `GET /projects?category=&epicId=&goalId=&customer=&tag=&relatedTo=&assignee=&orgId=&projectId=`
  - `assignee`: `me` (assigned to me, or unassigned and created by me), `unassigned`, `mine_or_unassigned`, or a user id.
- `GET /projects/:id` returns one task.
- `POST /projects` takes `{ project, reason?, status, priority, size, notes?, awaitUntil?, gmailThreadId?, category?, projectId?, assigneeId?, customer?, tags?, epicId?, goalId? }`.
- `PUT /projects/:id` takes any of the above, plus `isDeleted`.
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
```

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
  - `{ status: 'invited', id, email, role, token, expiresAt }`: they join automatically when they first sign in with that email. The invite link is `<APP_URL>/invite/<token>` (the CLI prints it as `inviteUrl`).
- `DELETE /organisations/:id/invites/:inviteId` revokes an invite.
- `POST /organisations/invites/accept` takes `{ token }`.
- `PUT /organisations/:id/members/:userId` takes `{ role }`.
- `DELETE /organisations/:id/members/:userId` removes someone. Pass your own id to leave.
- `GET /organisations/:id/projects`, and `POST /organisations/:id/projects` with `{ name, description? }`.
- `PUT /organisations/:id/projects/:projectId` takes `{ name?, description?, isArchived?, orgId? }`. `orgId` moves the project to that workspace.

### Activity
- `GET /activity?taskId=&epicId=&projectId=&orgId=&limit=` returns newest first: `[{ id, actorId, actorName, orgId, projectId, projectName, entityType, entityId, taskId, epicId, action, summary, changes, createdAt }]`.
  - `actorName` is `TimDo` for system actions, such as an awaiting task coming back to Do.
  - Actions: `created, updated, status_changed, completed, assigned, moved, deleted, restored, merged, note_added, note_deleted, renamed, archived, unarchived, invited, member_added, member_joined, member_left, member_removed, role_changed`.
  - `summary` is a ready-to-show sentence without the actor, e.g. `Moved "Fix inverter" from Do to Done`. Show it as `Robin Fairweather · Moved "Fix inverter" from Do to Done · 2h ago`.

### Posters
The active poster and the Wall of Done are personal. They show the caller's own tasks (`assignee=me`) across all workspaces.

## CLI (`bin/timdo`) and MCP (`timdo_*`)

The CLI talks to this API with `X-Internal-Secret`, so it acts as the account owner (Tim). Everything below works the same through the MCP tools, which run `bin/timdo --json`.

- **Acting as someone else**: `--as <email>` (anywhere on the line) or `TIMDO_AS=<email>` sends `X-Timdo-User`. Use it to preview a collaborator's view, e.g. `timdo --as robin@example.com list do --mine`. Every MCP tool takes an optional `asUser`. Only write as someone else when Tim asks.
- **Config**: `TIMDO_SECRET`, `TIMDO_API` and `TIMDO_AS` in the environment override `~/.config/timdo/config`, so `TIMDO_API=http://127.0.0.1:8788/api/v2 TIMDO_SECRET=local-dev-secret bin/timdo ...` hits a local API (`workers/scripts/local-api.sh 8788`).
- **Output**: list-style commands print aligned text; shared tasks show `Workspace/Project` and the assignee's first name (`me`, `unassigned`). Colour only on a terminal, never with `NO_COLOR`. `--json` gives the raw API objects. `add`, `update`, `delete`, `add-note` and `epic add/update/delete` still print JSON when piped (scripts rely on it) and a readable confirmation on a terminal or with `--text`.
- **Errors** exit 1 with the API's message: `View only: you have view-only access to "Solfit"`, `Not found: ...`, `Not allowed: ...`. Short ID prefixes that match several tasks are refused, not guessed.
- **Assignment**: `add/update --assign <me|none|name|email>` resolves the person among the members of the task's workspace and sends `assigneeId`; `update --claim` and `--unassign` too. `list --mine` / `--unassigned` / `--assignee <who>` / `-w <workspace>` / `--project-id <KEY>` filter on the server.
- **Projects**: `-p <name>` is the category name. A name that exists in a shared workspace puts the task there (the first one you can edit); an unknown name creates a project in your personal workspace. `--project-id` takes an id, a key such as `SOL`, or `Workspace/Project`.
- **Audit**: `timdo audit` reports on your own editable tasks (assigned to you, or unassigned and created by you) and epics you created. Collaborators' tasks are theirs to tidy, and goal links are private, so their "missing goal" count means nothing to you. `--all` covers everything you can edit.
- **Search and customers**: the search endpoint has no sharing fields yet, so the CLI adds `orgName`, `projectName`, `assigneeName` and friends from `GET /projects`; `customers` adds a `workspaces` list the same way.
- **Workspaces**: `timdo workspace` (aliases `ws`, `org`): `list`, `show`, `members`, `create`, `rename`, `share <ws> <email> [--role member|viewer|admin]` (prints added, already a member, or the invite link), `role`, `remove`, `revoke`, `leave`, `add-project`, `move-project <project> <ws> --yes`, `accept <token>`. `remove`, `leave` and `move-project` ask on a terminal and need `--yes` otherwise.
- **Activity**: `timdo activity [--task] [--epic] [--project] [--workspace] [-n N]` prints `08 Oct 14:02  Robin Fairweather  Moved "Fix inverter" from Do to Done  [Solfit]`. `timdo get` and `timdo epic get` show recent activity too.
- **Who am I**: `timdo whoami` (MCP `timdo_whoami`).
