# Running your own instance

TimDo is one Next.js site and one Cloudflare Worker with a D1 database. Running your own copy means three accounts, a domain, and about an hour. This page says what you need, what it costs, and which settings make the copy yours. Development without any accounts is covered in `CONTRIBUTING.md`.

## What you need

| Service | For | Plan |
|---|---|---|
| [Cloudflare](https://dash.cloudflare.com/) | Workers (the API), D1 (the database), Pages (the web app) | Workers Free |
| [Auth0](https://manage.auth0.com/) | signing people in to the web app | Free |
| An AI provider | voice commands only; skip it and the microphone is hidden | see `docs/ai-providers.md` |
| A domain you control | `app.example.org` and `api.example.org`, or one domain with the API on a path | your registrar |

Node 22 and `npm`, plus `bash`, `curl` and `jq` for the CLI.

## What it costs

Nothing for a small team, if you stay inside the free plans. The limits that matter, as published in 2026 (check the providers' own pricing pages before relying on them):

| | Free allowance | What that means for TimDo |
|---|---|---|
| Workers | 100,000 requests a day, 10 ms CPU each | the board makes a handful of requests per page view; a team of ten will not notice |
| D1 | 5 GB, 5 million rows read and 100,000 rows written a day | the write limit is the one to watch; every task edit and note is a few rows |
| Pages | 500 builds a month, one at a time | each deploy is a build |
| Auth0 | 25,000 monthly active users, one tenant, one custom domain | more than enough; the paid plans start at $35 a month and actually include fewer users |
| Groq | about 1,000 LLM requests and 2,000 transcriptions a day | one person's voice commands; limits are per organisation |
| Workers AI | 10,000 neurons a day | a few hours of transcription or a few hundred commands |

Beyond the free plans, Workers Paid is $5 a month with 10 million requests, and D1 bills per million rows. An Anthropic API key is pay-as-you-go: a voice command is roughly 10,000 tokens in and a few hundred out, so tens of commands cost cents on Claude Haiku and tens of cents on Claude Opus.

Where your data lives: D1 places the database near where you create it, and `wrangler d1 create <name> --jurisdiction eu` pins it to the EU if that matters to you. Auth0 asks for a region when you create the tenant. Workers run at the edge, so the code runs near each visitor while the data stays put.

## Set up

1. **Fork and clone** this repository, and run `npm install` in the root, `workers/` and `mcp/`.
2. **Auth0.** Create a tenant. Add an API (its identifier becomes `AUTH0_AUDIENCE`) and a Regular Web Application. Allow `https://app.example.org/api/auth/callback/auth0` as a callback URL and `https://app.example.org` as a logout URL, plus the `http://localhost:3000` equivalents for development. Note the domain, client id and client secret.
3. **Database.** `cd workers && npx wrangler d1 create timdo-v2-db` (add `--jurisdiction eu` if you want). Put the returned `database_id` in `wrangler.toml`, then apply the schema: `npx wrangler d1 execute timdo-v2-db --remote --file schema/current-schema.sql`.
4. **Worker settings.** In `wrangler.toml` set `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `INSTANCE_NAME`, `APP_URL` and, if you use the Wall of Done, `POSTER_WORK_PROJECTS`. Add secrets with `npx wrangler secret put`: `INTERNAL_API_SECRET` (make one with `openssl rand -base64 32`) and whichever AI keys you chose. Deploy with `npx wrangler deploy`, and give the Worker a custom domain such as `api.example.org` in the Cloudflare dashboard.
5. **Web app.** Create a Pages project from your fork with the build command `npx @cloudflare/next-on-pages` and output directory `.vercel/output/static`. Set the variables from `.env.example`: the Auth0 values, `NEXTAUTH_URL` (your app address), `NEXTAUTH_SECRET`, `INTERNAL_API_SECRET` (the same value as the Worker's), `NEXT_PUBLIC_WORKER_API_BASE_URL` (`https://api.example.org/api/v2`), and the `NEXT_PUBLIC_*` branding variables below. Add your domain to the project.
6. **Sign in.** The first person to sign in becomes the account owner, whose `INTERNAL_API_SECRET` can act as anyone (see "Who can do what" below). Everyone else creates personal tokens on the CLI & MCP page.
7. **CLI.** `bin/timdo login --app https://app.example.org` saves the instance address alongside the token, so the same CLI and MCP server work against your copy.

## Settings that make it yours

Worker (`wrangler.toml` `[vars]`):

| Variable | Default | Purpose |
|---|---|---|
| `INSTANCE_NAME` | `TimDo` | returned by `GET /api/v2/config` |
| `APP_URL` | `https://timdo.tdobson.net` | public web address; allowed for CORS and used in invite links |
| `CORS_ORIGINS` | `http://localhost:3000` and `APP_URL` | comma-separated origins that may call the API from a browser |
| `POSTER_WORK_PROJECTS` | unset | project names for the Wall of Done's work column, in order; unset means "projects in shared workspaces" |
| `FEATURES` | all on | comma-separated list of the optional features to keep: `goals`, `poster`, `voice`, `gmail`. Anything left out disappears from the web app, and its API routes answer 404 with a plain message |
| `AI_*` | Groq | see `docs/ai-providers.md` |

Web app (`NEXT_PUBLIC_*`, set at build time):

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_APP_NAME` | `TimDo` | the product name |
| `NEXT_PUBLIC_SITE_TITLE`, `NEXT_PUBLIC_SITE_DESCRIPTION` | Tim's | browser title and meta description |
| `NEXT_PUBLIC_CONTACT_EMAIL` | `tim@example.com` | the footer's Contact link |
| `NEXT_PUBLIC_REPO_URL` | this repository | where the CLI setup page says to clone from |
| `NEXT_PUBLIC_COPYRIGHT` | `© 2025 Tim Dobson` | the footer line |
| `NEXT_PUBLIC_CREATOR_NAME`, `_BIO`, `_TAGLINE`, `_LINKS` | Tim's | the "Made by" card on the landing page; an empty name hides it |

Everything left unset keeps the original value, so the published instance is unchanged by these settings.

### Switching parts off

TimDo started as one person's life planner, and a team running it for work may not want all of it. `FEATURES` names what to keep:

- `goals`: the Life Goals page, the goal pickers on tasks and epics, and the goals poster.
- `poster`: the Poster Studio and the Wall of Done and Active Tasks posters.
- `voice`: the microphone, voice onboarding and the AI routes (see `docs/ai-providers.md`; with no provider configured the microphone is hidden anyway).
- `gmail`: the Gmail thread fields and links on tasks and notes.

For example `FEATURES = "voice"` leaves a plain shared task board with voice commands. The CLI and MCP server still list every command; one that belongs to a switched-off feature gets the API's "switched off on this instance" answer.

## Who can do what

- **Web sign-in** goes through Auth0; the Worker checks the JWT against your tenant.
- **Personal tokens** (`tdo_...`) act only as the person who made them, are stored hashed, and cannot mint more tokens or act as anyone else.
- **The internal secret** (`INTERNAL_API_SECRET`) is for the account owner's own tooling. It acts as the first account that signed up, and with `X-Timdo-User` it can act as anyone. Treat it like a root password: keep it in `wrangler secret`, never in a browser.

## Keeping it running

- **Backups.** D1 has no automatic export. `npx wrangler d1 export timdo-v2-db --remote --output backup.sql` writes a full SQL dump; run it from a scheduled job and keep the files somewhere else. D1's Time Travel can restore the last 30 days from the dashboard.
- **Logs.** Worker logs are in the Cloudflare dashboard, or stream them with `npx wrangler tail`. They include request paths and the signed-in user's id; keep that in mind if you forward them anywhere.
- **Updates.** Pull from upstream, run the tests (`CONTRIBUTING.md`), apply any new file under `workers/migrations/` with `wrangler d1 execute --remote --file`, then `wrangler deploy` and let Pages rebuild.

## Licence

TimDo is AGPL-3.0-or-later. If you change it and run it as a service, offer your changes to the people using it; the simplest way is to keep your fork public and point `NEXT_PUBLIC_REPO_URL` at it.
