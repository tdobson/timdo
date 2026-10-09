# timdo CLI

A bash command-line tool for managing TimDo projects. Designed for both human use and programmatic access from tools like Claude Code.

## Setup

```bash
cd bin/
npm run setup        # creates ~/.config/timdo/config
npm run install-cli  # symlinks to ~/.local/bin/timdo
```

Then edit `~/.config/timdo/config` and set your secret:

```
TIMDO_SECRET="your-actual-secret"
```

The secret must match the `INTERNAL_API_SECRET` stored in the Cloudflare Worker. Manage it with `npx wrangler secret put INTERNAL_API_SECRET` from the `workers/` directory.

Make sure `~/.local/bin` is on your PATH.

## Authentication

Most people sign in with a personal token: `timdo login` (see [collaboration.md](collaboration.md)). The account owner's tooling can instead use the static `INTERNAL_API_SECRET` as `TIMDO_SECRET`, which acts as the first account that signed up, or as anyone with `--as <email>`. To use another TimDo instance, run `timdo login --app https://tasks.example.org`.

## Commands

### list

```bash
timdo list              # all active projects, grouped by status
timdo list do           # only "do" status
timdo list delay        # only "delay" status
timdo list done         # only "done" status
timdo list delegate     # only "delegate" status
timdo list awaiting     # only "awaiting" status (sorted by return date)
```

### add

```bash
timdo add "Fix the roof" --reason "Leaking in rain" --priority 8
timdo add "Learn piano" -r "Always wanted to" -p 3 --status delay
timdo add "Review vendor pitch" -r "Evaluate options" --thread "18e47f2ab1234567"
timdo add "Quick thing" --notes "Call Bob about it"
```

Options:
- `--reason` / `-r` — why the project matters
- `--status` / `-s` — one of: do, delay, delegate, done, awaiting (default: do)
- `--priority` / `-p` — 1 to 10 (default: 5)
- `--size` — complexity: `*` to `*****` (default: `***`)
- `--notes` / `-n` — freeform notes
- `--await-until DATE` — return date in YYYY-MM-DD (use with `--status awaiting`)
- `--thread <threadId>` — attach Gmail thread ID

### update

```bash
timdo update ea9f --done              # mark done (short ID prefix)
timdo update ea9f --priority 9        # bump priority
timdo update ea9f --status delay -r "Waiting on parts"
timdo update ea9f --project "New name"
timdo update ea9f --thread "18e47f2ab1234567"
```

Short IDs work — provide enough characters of the UUID to be unique (4-8 is usually plenty).

Options: same as `add`, plus `--project` to rename, `--thread <threadId>` to set/update Gmail thread ID, and convenience flags `--done`, `--do`, `--delay`, `--awaiting`, `--delegate`. The `--done`, `--do`, `--delay`, and `--delegate` shorthands clear `awaitUntil`.

### add-note / log

```bash
timdo add-note ea9f "Sent email asking for discount" --thread "18e47f2ab1234567"
timdo log ea9f "Followed up with supplier via phone"
```

Options:
- `--thread <threadId>` — optional Gmail thread ID to attach to this note

### notes / updates

```bash
timdo notes ea9f       # formatted chronological history of notes
timdo updates ea9f     # alias for notes
timdo --json notes ea9f
```

### delete

```bash
timdo delete ea9f     # soft-delete by ID prefix
```

### poster

```bash
# Download default life goals poster
timdo poster --output ~/life_goals.svg

# Download Wall of Done poster (optionally filtered by categories)
timdo poster --type done --output ~/wall_of_done.svg
timdo poster --type done --category Solfit --output ~/solfit_done.svg

# Download Active Tasks Readout worksheet (optionally filtered by categories)
timdo poster --type active --output ~/active_tasks.svg
timdo poster --type active --category "Solfit,Migrating Dragons" --output ~/active_workstreams.svg
```

Options:
- `--output` / `-o` (required) — output destination file path.
- `--type` / `-t` — one of: `done` (Wall of Done), `active` (Active Tasks Readout), `goals` (Life Goals & Routines).
- `--category` / `-c` / `-p` — comma-separated category filter (e.g. `Solfit,Crew`).

### merge

```bash
timdo merge <source_id> <target_id> [--yes]
```
Merges a duplicate or secondary task into a primary target task. Preserves notes and progress history while soft-deleting the source.

### epic

```bash
timdo epic list [-p <category>]
timdo epic add "Launch Acme Solar" -p Solfit -d "Complete installer onboarding and first pilot"
```

### goal

```bash
timdo goal list
```

### get

```bash
timdo get ea9f        # full details and recent updates for a project
```

### search

```bash
timdo search "roof"   # case-insensitive name search
```

## Output formats

Default output is human-readable text. Pass `--json` before the command for structured JSON, or `--text` to be explicit about the default.

```bash
timdo --json list do          # JSON array of "do" projects
timdo --json get ea9f         # JSON array (matching projects)
timdo --json search "roof"    # JSON array of matches
```

`add`, `update`, and `delete` always return JSON (the API response).

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `TIMDO_CONFIG` | `~/.config/timdo/config` | Path to config file |
| `TIMDO_API` | `https://timdo-v2-api.tdobson.net/api/v2` | API base URL; `timdo login --app <url>` saves another instance's |
| `TIMDO_APP_URL` | `https://timdo.tdobson.net` | the web app, for invite links and help text |
| `TIMDO_FORMAT` | `text` | Default output format |
| `TIMDO_SECRET` | (required) | API secret, usually set in config file |

## Project data model

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Use short prefix for commands |
| project | string | Name (required) |
| reason | string | Why it matters |
| status | enum | do, delay, done, delegate, awaiting |
| priority | 1-10 | Higher = more important |
| size | * to ***** | Complexity estimate |
| notes | string | Freeform |
| awaitUntil | string | ISO date (YYYY-MM-DD), required when status is awaiting |

## Dependencies

- `bash`, `curl`, `jq` — all standard on Linux/macOS
- A running TimDo Workers API with `INTERNAL_API_SECRET` configured

## Source

The CLI lives at `bin/timdo` in the timdo.tdobson.net repo. Install via `cd bin && npm run install-cli`.
