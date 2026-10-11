# Workspace bots and activity attribution

Use a bot for a watcher, importer or other integration that needs its own name in task history.
Each bot belongs to one non-personal workspace. A bot token cannot reach another workspace or inherit
the life goals of the person who created it.

## Create a bot

Open [Sharing](https://timdo.tdobson.net/sharing), choose the workspace and use its bot controls.
You must be a signed-in human owner or admin of that workspace.

Choose a name that explains the job, such as `Issue watcher`, and a role:

- `member` can create and edit workspace tasks, notes, refs and scoped epics under the normal
  permission rules. New tasks are unassigned unless the request names an eligible human assignee.
- `viewer` can read the workspace's visible data but cannot change its tasks.

The default role is `member`. Creation also issues a token named `initial`, unless you supply a
different token name. Copy the token when it appears. Later lists show its name, prefix and usage
times, but cannot recover the full value.

A bot cannot be a task assignee, create a workspace or project, join another workspace, manage
members or bots, own life goals, or call the AI endpoints. Changing a bot's role does not remove
these restrictions. Members and viewers can see active bots in the workspace roster without seeing
their credentials or internal email addresses.

## Keep and rotate tokens

Store a bot token in the integration's secret store. For CLI use, `bin/timdo login` prompts for the
token; do not put it in a command argument, task note or source file. Clipboard contents and an MCP
client's conversation history may outlive the copy-once display.

Closing the token display does not revoke the token. If the creation response is lost, check the
bot and its redacted token list before trying again. Revoke the uncertain token and issue a
replacement. Creating again can issue another working credential, so clients must not automatically
retry credential creation.

To rotate a working integration:

1. Issue a replacement token with a name that identifies its use.
2. Install it in the integration and check that the integration can authenticate.
3. Revoke the old token.

A bot can have at most 20 active tokens. A bot token can list its own redacted token metadata and
revoke the calling token, but it cannot mint a replacement or revoke a different token.

Disabling a bot revokes all its tokens and removes its workspace membership in the same transaction.
Its name and historical attribution remain. Disablement is permanent; create a new bot if the
integration needs to return. Requests authenticated after disablement commits are rejected. This
does not cancel work that was already authenticated and in progress.

## CLI and MCP management

The CLI has these operations:

```text
bin/timdo bot list <workspace>
bin/timdo bot create <workspace> "<name>" [--role member|viewer] [--token-name name]
bin/timdo bot rename <workspace> <bot> "<name>"
bin/timdo bot role <workspace> <bot> member|viewer
bin/timdo bot token <workspace> <bot> [--name name]
bin/timdo bot revoke-token <workspace> <bot> <token-id-or-prefix> [--yes]
bin/timdo bot disable <workspace> <bot> [--yes]
```

Revocation and disablement need an interactive confirmation or `--yes`. Piping output is not
confirmation. Ambiguous names or ID prefixes need a more specific identifier. A replacement token
issued through the CLI defaults to the name `CLI token`.

Personal access tokens deliberately cannot manage bots, even when their human owner has a workspace
admin role. Use the web controls. The installation owner can explicitly select an already configured
owner secret with `--owner-secret` on a bot-management command. Keep that secret private: it is not a
credential to give to workspace collaborators or integrations. The CLI keeps its token-first default
and never falls back to the owner secret after an access denial.

The CLI does not save a newly issued token to its login config. Its API response does pass through a
file in a private temporary directory, which normal exit removes. A crash or forced termination can
leave that file behind. Copy-once means the server cannot return the token again, not that a client
has never written it to disk.

The [standalone MCP server](../mcp/README.md) exposes the same management operations. Its
`ownerSecret: true` option makes the same explicit selection; there is no raw-secret tool parameter.
Credential-creation responses contain the full token once. An MCP client can pass that tool result
to its model and retain it in conversation history. Use the web controls if you want to avoid that
MCP-specific disclosure. Reconnect the client after updating the server to load new tools.

## Create duplicate-safe tasks

A bot can use the existing task API with a source ref and `onDuplicate: "report"`. For example,
a fictional forum watcher might submit this to `POST /api/v2/projects`:

```json
{
  "project": "Check the reported upload failure",
  "projectId": "<existing project ID>",
  "refs": [
    { "ref": "forum.post:421", "role": "source" },
    { "ref": "community.member:83", "role": "reported_by" }
  ],
  "onDuplicate": "report"
}
```

Authenticate with the bot's bearer token. Replace the example identifiers with IDs from your own
system. The source ref finds the existing task on a repeated report. The external reporter ref is
separate from the bot that created the task and from the person assigned to do it. Use external
member IDs for these refs, not names or email addresses.

See [Integrations](integrations.md) for ref and duplicate-report behaviour.

## Read activity

Task, note, epic and ref bylines identify bots separately from humans. Activity also records how
the caller authenticated:

| `via` | Meaning |
|---|---|
| `web` | A verified human JWT. This identifies the authentication path, not proof that a browser was used. |
| `token` | A personal or bot access token. `viaDetail` holds its name, never the credential. |
| `owner_secret` | The installation owner's internal secret, including explicit acting-as requests. |
| `system` | An explicit system operation, such as returning an awaiting task. |
| `null` | Historical or unbound activity with no established provenance. |

Owner-secret actions are labelled. Token names belong in activity detail or a tooltip, not the inline
byline. An old null value does not mean that the action came from the web.

Humans can ask voice questions about bot-created tasks today. The facts cover the current
Europe/London calendar day and only activity the caller can see. At most 50 bot/workspace rows are
supplied, with any omitted count stated. An unavailable activity query is not a zero count. Voice
cannot issue credentials, change bot permissions or assign a task to a bot.

## Management API

The base path is `/api/v2/organisations/:orgId/bots`. These routes require a human owner/admin
using a verified JWT or the installation owner's internal secret.

| Method and path | Request | Result |
|---|---|---|
| `GET` base path | None | Bot list, including disabled bots |
| `POST` base path | `{ name, role?, tokenName? }` | 201 `{ bot, token }` |
| `PUT /:botId` | `{ name?, role? }` | Updated bot |
| `DELETE /:botId` | None | 204; disable is idempotent |
| `POST /:botId/tokens` | `{ name }` | 201 token metadata plus its one-time `token` |
| `DELETE /:botId/tokens/:tokenId` | None | 204; revocation is idempotent |

A bot view contains `id`, `kind`, `name`, `role`, `createdByName`, `createdAt`, `disabledAt` and
redacted active `tokens`. A disabled bot has a null role and an empty active-token list. Neither the
synthetic internal email nor token hashes are part of the public view. Both credential-creation
responses carry `Cache-Control: no-store`.

A stale conflicting update returns 409 with `Bot was changed by another request`. Reload before
submitting another edit. Combined name/role changes do not silently apply just one requested field.
If an update commits before a concurrent disable, its successful response can show the subsequent
disabled state.

Personal or bot token calls to management routes return 403:
`Bots are managed on the web: https://timdo.tdobson.net/sharing`.
A known credential of a disabled bot returns 401 `This bot has been disabled`.
An individually revoked credential of an active account returns 401
`This token is invalid or has been revoked`.

## Deployment and rollback

Apply migration `0010_bots_and_via.sql` and deploy the compatible Worker before issuing bot tokens
or deploying a frontend that offers bot creation. The migration leaves existing accounts as humans
and existing activity provenance as null.

A pre-bot Worker does not enforce bot restrictions. Before reverting to one, use compatible code
to disable the bots, revoke their credentials and verify rejection. Leave the additive schema in
place. Correct schema problems with a forward migration, not a routine production-data restore.
