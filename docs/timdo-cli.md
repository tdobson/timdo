# TimDo CLI

`bin/timdo` manages tasks, projects and workspaces from a terminal or script. It uses the same
permissions as the web app. See [collaboration](collaboration.md) for the data model and
[integrations](integrations.md) for the API and watcher recipes.

## Setup and authentication

```bash
cd bin/
npm run install-cli  # symlinks to ~/.local/bin/timdo
```

Make sure `~/.local/bin` is on your `PATH`. Create a personal token in the web app at
`/settings/access`, then run:

```bash
timdo login
```

Paste the token at the hidden prompt. The CLI checks it and stores it in
`~/.config/timdo/config`, readable only by you. Avoid passing tokens on the command line,
where they can appear in shell history. Scripts can use the saved token or provide
`TIMDO_TOKEN` through their environment.

Each person uses their own token. `TIMDO_SECRET` is the instance owner's administrative
credential, not a collaborator login. Never share it with people or bots. Only that owner
credential can use `--as` to preview another account; a personal token cannot impersonate
another person.

## Find and inspect tasks

```bash
timdo list do --mine
timdo list awaiting
timdo list all -p "Acme Solar"
timdo list do -w "Northstar Workshop" --unassigned
timdo get ea9f
timdo search "roof"
timdo --json list do
```

Lists include the tasks you can see across your workspaces. Use an unambiguous id prefix for
a particular task. `search` searches task text; a URL or `kind:id` also finds exact external refs.

## Create tasks

A project name is required unless you give `--project-id`. A name matching a project you can
edit uses that project; a new name creates a project in your personal workspace. Use an
exact id, key or `Workspace/Project` path when names are ambiguous.

```bash
timdo add "Fix the roof" -p "Personal" -r "Leaking in rain" --priority 8
timdo add "Learn piano" -p "Personal" --priority 3 --status delay
timdo add "Review supplier proposal" --project-id "Northstar Workshop/Acme Solar" \
  --reason "Choose an installer" --size "**"
```

Common options:

- `-p`, `--project`: project name, not priority.
- `--project-id`: exact project id, key or path.
- `-r`, `--reason`: why the task matters.
- `-s`, `--status`: `do`, `delay`, `delegate`, `awaiting` or `done`; defaults to `do`.
- `--priority`: 1 to 10; defaults to 5.
- `--size`: `*` to `*****`; defaults to `***`.
- `-n`, `--notes`: task details or next step.
- `--await-until`: return date in `YYYY-MM-DD` format for an awaiting task.
- `--assign`: `me`, `none`, or a member of the project's workspace.
- `-e`, `--epic`: epic title or id.
- `-g`, `--goal`: one of your private life goals.

### Avoid duplicates

```bash
timdo similar "Broken offer page" -p "Acme Solar"
timdo add "Broken offer page" -p "Acme Solar" \
  --source forum.post:4411 --reported-by forum.member:123456 --on-duplicate report
```

A task can have one canonical source. A source identifies one task per workspace.
`--on-duplicate error` is the default: it creates nothing and names the existing task.
`return` returns that task without adding a report. `report` adds the request's new links and
a deduplicated report note. Retries are safe while the same task holds that source in the
requested workspace. See [the full contract](integrations.md) for source changes and deletion.

On a terminal, `add` checks for similar open tasks and offers to add a note to one instead.
With `--yes`, `--json` or piped output, it does not prompt. Similarity is a suggestion, not
proof that two tasks should be merged.

## Update tasks and notes

```bash
timdo update ea9f --done
timdo update ea9f --project "Check the replacement roof"
timdo update ea9f --awaiting --await-until 2026-11-01
timdo update ea9f --claim
timdo add-note ea9f "Supplier confirmed the replacement date"
timdo notes ea9f
timdo activity --task ea9f
timdo delete ea9f
```

`delete` soft-deletes the task. Notes are dated and attributed to the caller. Workspace members
can read them. Use `timdo update --help` for the full option list; create-only duplicate modes
are not update options.

## External refs

```bash
timdo ref add ea9f https://github.com/acme/widgets/issues/88
timdo ref add ea9f forum.member:123456 --role reported_by
timdo ref list ea9f
timdo find forum.post:4411 --role source
timdo list all --ref https://github.com/acme/widgets/issues/88
```

The roles are `link`, `source`, `reported_by` and `about`. Record outside people by their id in
the other system, not their name or email. `--thread` remains a shortcut for a Gmail thread ref.

## Workspaces, epics and goals

```bash
timdo ws list
timdo ws show "Northstar Workshop"
timdo epic list -p "Acme Solar"
timdo epic add "Installer pilot" -p "Acme Solar" -d "Complete onboarding and the first pilot"
timdo goal list
timdo audit
```

Workspace members see its projects, epics, tasks and activity. Roles determine who can edit.
Life goals stay private to each person. Sharing a workspace or moving a project between
workspaces changes who can see the work; check the destination and intended members first.

## Merge

```bash
timdo merge <source_id> <target_id>
```

Check both tasks and the direction before confirming. The target survives; notes and history
move to it, and the source is archived. `--yes` skips the prompt, so use it only after the exact
source and target have been approved. A similar-title result is not enough.

## Posters

```bash
timdo poster --type goals --output ~/life_goals.svg
timdo poster --type done --output ~/wall_of_done.svg
timdo poster --type done --category "Acme Solar" --output ~/acme_solar_done.svg
timdo poster --type active --category "Acme Solar,Northstar Workshop" --output ~/active.svg
```

Task posters show your own tasks across your workspaces. Active posters have Do, Awaiting and
Delay sections, with optional category filtering. The Wall of Done uses three columns for the
personal workspace and one for other workspaces; another workspace need not be shared.
Category filters use actual project names. The fixed six-sheet Wall of Done shows an overflow
count when a column is full, rather than silently dropping rows. Use the Done view or the
poster's JSON API response for the full selected task list.

## Output and configuration

Use `--json` before a command for structured output, or `--text` for readable output.
Write commands such as `add`, `update`, `delete` and `add-note` return JSON when piped and a
readable summary on a terminal. `add` can print similar-task hints to stderr without corrupting
its JSON stdout.

| Variable | Purpose |
|----------|---------|
| `TIMDO_CONFIG` | Config file; defaults to `~/.config/timdo/config` |
| `TIMDO_API` | API base URL; defaults to `https://timdo-v2-api.tdobson.net/api/v2` |
| `TIMDO_TOKEN` | Your personal token; usually loaded from the config file |
| `TIMDO_FORMAT` | Output format |
| `TIMDO_SECRET` | Owner-only administrative credential |
| `TIMDO_AS` | Account preview identity; only usable for another person with the owner credential |

The CLI requires Bash, curl and jq. Run `timdo help` or `timdo <command> --help` for command
options. The implementation is `bin/timdo`.
