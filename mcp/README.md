# TimDo MCP server

A small [MCP](https://modelcontextprotocol.io) server that lets Claude Code, or any other MCP client, work with your TimDo tasks, epics, life goals, workspaces and sharing, and with the links from tasks to things outside TimDo.

It doesn't talk to the API itself. Each tool call runs `bin/timdo --json` from this repo, so the server acts as whoever the CLI is signed in as, with the same permissions. It needs no Google or other credentials to start.

See [docs/collaboration.md](../docs/collaboration.md) for how workspaces, roles and sharing work.

## Install

Node 18 or newer, plus `bash`, `curl` and `jq` for the CLI.

```bash
cd mcp && npm install
```

## Log in first

The server uses the CLI's login, so sign in once:

```bash
bin/timdo login     # stores a personal or bot token in ~/.config/timdo/config
bin/timdo whoami    # check the acting account
```

## Add it to Claude Code

```bash
claude mcp add timdo -- node "/absolute/path/to/timdo/mcp/index.js"
```

## Other MCP clients

Most clients take a JSON block like this:

```json
{
  "mcpServers": {
    "timdo": {
      "command": "node",
      "args": ["/absolute/path/to/timdo/mcp/index.js"]
    }
  }
}
```

Add an `"env": { ... }` object to set any of the variables below.

## Environment variables

| Variable | What it does |
| --- | --- |
| `TIMDO_BIN` | Path to the `timdo` CLI. Defaults to this repo's `bin/timdo`, then `timdo` on your `PATH`. |
| `TIMDO_API` | API base URL. Defaults to production. For a local API: `http://127.0.0.1:8788/api/v2`. |
| `TIMDO_TOKEN` | Personal or bot token. Any configured token is used before `TIMDO_SECRET`, unless a bot-management command has `--owner-secret`. |
| `TIMDO_SECRET` | The owner's internal secret. Used when no token is set, or when a bot-management command explicitly selects it with `--owner-secret`. |
| `TIMDO_CONFIG` | Config file to read. Defaults to `~/.config/timdo/config`. |

The server passes its environment straight to the CLI, so anything the CLI reads works here too.

## Task lists and counts

`timdo_list_tasks` returns a page envelope with `items`, `nextCursor` and `total`. It defaults to 50 summary tasks per call. Set `limit` from 1 to 200, then pass the returned `nextCursor` to continue with the same membership filters. `total` is the count after those filters and before paging.

`fields` accepts `summary` or `full`; summary is the default and omits the task's full notes body. `groupBy` accepts `project`, `epic` or `assignee`. When set, the response adds `groupBy` and `groups`. Each group has a stable `key`, a display `label` and the `taskIds` from this page. The flat `items` array, server order, cursor and total stay unchanged.

`timdo_counts` accepts the same visibility and membership filters. It returns SQL totals for all five statuses, including zeroes. It does not count a page sample.

The list result now uses a page envelope. Existing clients that expect an array need updating. The standalone MCP server version is now 0.2.0.

## Tools

Every tool also takes an optional `asUser` (an email address, sent as `X-Timdo-User`). Only the account owner's secret can use it to act as someone else. With a personal token you can only name yourself, and the API refuses any other email with a 403.

Tasks and notes:
- `timdo_list_tasks`: list tasks by status, project, workspace, assignee, epic, goal, customer, tag, ref or missing links. It defaults to 50 summary rows; `limit` sets the page size and `fields` selects the body projection.
- `timdo_counts`: count matching tasks across all five statuses.
- `timdo_get_task`: one task with its refs, linked tasks, notes and recent activity.
- `timdo_add_task`: create a task, optionally assigned, linked to another task, and with refs. People can create a personal project when the category matches no accessible writable project; bots must use an existing writable project in their home workspace, default to unassigned, cannot be assignees, and cannot use life goals. The result says whether it was `created` and lists up to 3 `similar` open tasks.
- `timdo_find_similar`: open tasks whose title looks like one you are about to create. Use it before creating from free text.
- `timdo_update_task`: change status, details, project, epic or assignee, and add or remove refs.
- `timdo_delete_task`: soft-delete a task.
- `timdo_add_note`: add a dated note, signed with your name.
- `timdo_list_notes`: a task's notes, oldest first.
- `timdo_search_tasks`: full-text search across every workspace you can see. A pasted URL or `kind:id` puts tasks carrying that ref first.
- `timdo_merge_tasks`: move notes and history to the target, then archive the source. It acts immediately, so review both tasks and get explicit user confirmation of the exact source and target before calling it.
- `timdo_link_tasks` / `timdo_unlink_tasks`: add or remove a link between two tasks.
- `timdo_list_customers`: customers with open task counts.
- `timdo_audit`: tasks missing an epic, goal, project or reason, and epics with no tasks.

Refs (links to things outside TimDo):
- `timdo_add_ref`: link a task to a GitHub issue, forum post, email, Gmail thread, member id or any URL, with a role.
- `timdo_remove_ref`: take a ref off a task, by URL, `kind:id` or ref id.
- `timdo_find_by_ref`: tasks carrying a ref, any status.

A ref is a URL or `kind:id`, for example `github.issue:acme/widgets#12`, `forum.post:4411` or `acme.member:123456`. Kinds are lowercase and dotted, and a bot can make up its own. The role is one of:

- `link`: related material (the default)
- `source`: where the task came from. Only one task per workspace can have a given source. What a second create with the same source does depends on `onDuplicate` (see below).
- `reported_by`: an outside person or account who reported it (as many as you like)
- `about`: the outside person or thing the task concerns

Adding the same ref with the same role twice changes nothing, so retries are safe. Record people by their id in the other system, not by name or email.

Avoiding duplicates. A bot creating tasks from an outside system passes the item as a `source` ref and sets `onDuplicate` on `timdo_add_task`:

- `error` (the default): nothing is created, and the call fails with `Already tracked: ...`, naming the task that has the source.
- `return`: nothing is created or changed, and that task comes back with `created: false`.
- `report`: the call's other refs and a `Reported again: "<title>"` note go on that task, which comes back with `created: false, reported: true`. Sending the same report twice adds nothing the second time.

```json
{ "project": "Broken offer page", "category": "Acme Solar", "onDuplicate": "report",
  "refs": [{ "ref": "forum.post:4411", "role": "source" }, { "ref": "acme.member:123456", "role": "reported_by" }] }
```

This is safe to retry and safe when two callers race, unlike looking the item up with `timdo_find_by_ref` and then creating. For titles that come from people rather than systems, call `timdo_find_similar` first. Add a note only when a result has `canEdit: true`; a read-only match needs an editor in that workspace. The result also gives `projectId`, `limit` and `excludeId` scope options. Similar-task results are suggestions, not proof of a duplicate.

Epics and goals:
- `timdo_list_epics`, `timdo_get_epic`, `timdo_add_epic`, `timdo_update_epic`, `timdo_delete_epic`: manage epics and see their progress.
- `timdo_list_goals`: your life goals (private to you).

Workspaces and sharing:
- `timdo_whoami`: which account the tools act as, and which API.
- `timdo_list_workspaces`: your workspaces with your role in each.
- `timdo_get_workspace`: members, projects and pending invites for one workspace.
- `timdo_share_workspace`: share a workspace with someone by email.
- `timdo_update_member_role`: change a member's role.
- `timdo_remove_member`: take someone out of a workspace.
- `timdo_move_project`: move a project and its history to another workspace.
- `timdo_activity`: who did what, newest first.
- `timdo_events`: read one finite recorded-events page with `after`, `workspace`, `types`, `includeRefs`, `includeText` and `limit`. It returns the complete versioned page envelope, including empty pages. It has no follow loop, checkpoint file or credential argument. See the [events integration guide](../docs/integrations.md#recorded-events-feed) for cursor handling and the limits of the feed.

## Workspace bots

Workspace owners and admins can create bots with member or viewer access. Each bot belongs to one workspace. Its name and bot marker appear on tasks, notes and activity. The API does not expose its synthetic email.

Use these CLI commands to manage a bot:

```text
timdo bot list <workspace>
timdo bot create <workspace> "<name>" [--role member|viewer] [--token-name name]
timdo bot rename <workspace> <bot> "<name>"
timdo bot role <workspace> <bot> member|viewer
timdo bot token <workspace> <bot> [--name name]
timdo bot revoke-token <workspace> <bot> <token-id|prefix|name> [--yes]
timdo bot disable <workspace> <bot> [--yes]
```

The first token is named `initial` by default. Replacement tokens use `CLI token` unless you set `--name`. A token appears once in the create or issue response. If that response is lost, find the redacted token entry, revoke it and issue another. The CLI prints a copy-once warning to stderr.

Use a unique workspace name, slug or ID prefix, a unique bot name or ID prefix, and a unique token name or ID prefix. Ambiguous matches stop before a change. Revoke and disable prompt in a terminal. A pipe is not approval; use `--yes` only after confirming the target.

Bot-management tools are `timdo_list_bots`, `timdo_create_bot`, `timdo_rename_bot`, `timdo_set_bot_role`, `timdo_issue_bot_token`, `timdo_revoke_bot_token` and `timdo_disable_bot`. Confirm mutations with the user before calling them. Revoke and disable run with `--yes`, so they act immediately and do not prompt in a terminal. Create and issue-token return a one-time credential that cannot be recovered.

The CLI uses any configured token, personal or bot, before `TIMDO_SECRET`. Add `--owner-secret` to a bot command to deliberately select `TIMDO_SECRET` instead. The MCP tools provide the same choice as `ownerSecret: true`. A token denial never causes an automatic switch to the owner secret, and no MCP tool accepts a raw secret value. This option works only for bot management. The API still checks that the acting human is a workspace owner or admin.

Restart the MCP server and reconnect its client to load these new tools.

## Tests

```bash
cd mcp && npm test
```

The tests use local HTTP fixtures for CLI requests and check tool registration over stdio. They do not contact the TimDo service.

## Licence

AGPL-3.0-or-later, the same as the rest of TimDo.
