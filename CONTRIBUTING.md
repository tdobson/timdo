# Contributing to TimDo

Thanks for having a go. TimDo is a small, opinionated tool, so a quick issue or chat before a big change saves everyone time. Small fixes can go straight to a pull request.

## How this repo works

This GitHub repo is a published copy of the code. Its history is short on purpose: the working repo also holds private client material that never leaves it. Open pull requests here as normal. They get applied to the working repo with your authorship kept, and land here again in the next published snapshot. Your PR may show as closed rather than merged, but your commit will be in the history.

## Getting set up

You need Node 22 (see `.nvmrc`), plus bash, curl and jq for the CLI.

```bash
npm install
(cd workers && npm install)
(cd mcp && npm install)          # only if you're working on the MCP server
```

## Running the tests

```bash
(cd workers && npx vitest run)   # API: real SQL against an in-memory copy of the schema, no cloud account needed
npx jest --forceExit             # web app
npx tsc --noEmit && (cd workers && npx tsc --noEmit -p .)
npx eslint app components --ext .ts,.tsx
(cd mcp && npm test)
```

The API tests use `workers/src/__tests__/helpers/testDb.ts`, which loads the real schema into `node:sqlite`, so the services run their actual queries. Prefer that over mocking Drizzle. `collaboration.integration.test.ts` is a good example to copy.

## Running the API locally

```bash
workers/scripts/dev-api.sh            # fresh local database with fictional demo data, on port 8787
```

Then use the CLI against it:

```bash
export TIMDO_API=http://127.0.0.1:8787/api/v2 TIMDO_SECRET=local-dev-secret
bin/timdo list do                     # you're Alex, who owns the "Acme Solar" workspace
bin/timdo --as robin@example.com list do --mine    # Robin is a member
bin/timdo --as sam@example.com list               # Sam is a viewer, so writes are refused
```

The web front end needs an Auth0 application to sign in, so most API and CLI work is easier through the tests and the local API. If you want to run the full web app, ask and we'll sort out a development login.

`workers/schema/current-schema.sql` is the current database schema in one file. The early migrations don't replay cleanly from an empty database, so new environments start from the snapshot. Schema changes go in a new numbered file under `workers/migrations/`, and the snapshot gets refreshed after it's applied.

## Things that matter here

- **Access control is the main thing to get right.** Everything is scoped to the workspaces a person belongs to. Reads go through `getAccessibleProjects` in `workers/src/services/accessService.ts`, writes check `canEdit`/`canManage`, and permission failures throw `AccessError` (403/404). If you add an endpoint, add a test showing that someone outside the workspace can't see or change anything through it, and that a viewer can't write.
- **Attribute changes.** Writes that people would want to know about call `logActivity` with a short sentence ("Moved X from Do to Done").
- **Life goals are private** to each person and never go in the shared activity log.
- **No real people, clients or personal data** in tests, defaults, examples or docs. Use made-up names like Robin Fairweather and Acme Solar.
- **Copy** is UK English, short and plain, with no em-dashes.
- **The docs to keep in step:** `docs/collaboration.md` (the model and API), `docs/integrations.md` (creating tasks from other systems), `bin/timdo help`, and `mcp/README.md`.

## Reporting a security problem

Please don't open a public issue. Use GitHub's private vulnerability reporting (the Security tab, then "Report a vulnerability").

## Licence

TimDo is released under the GNU AGPL v3.0 or later. By contributing, you agree your contribution is released under the same licence.
