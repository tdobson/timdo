# TimDo system primer

TimDo is a task manager with web, voice, CLI and MCP interfaces. Workspaces contain projects,
epics and tasks. Each person can link tasks to private life goals and print active or completed
task posters.

See [collaboration](collaboration.md) for permissions and the API contract, and
[integrations](integrations.md) for duplicate-safe task creation from outside systems.

---

## 2. Core Architecture & Tech Stack

```
                        ┌─────────────────────────────────────────────────────────┐
                        │                       Clients                           │
                        │  ┌─────────────────┐ ┌───────────────┐ ┌──────────────┐ │
                        │  │ Next.js Web App │ │ Voice/Whisper │ │  bin/timdo   │ │
                        │  │ (Mantine UI 7)  │ │ (MediaRecord) │ │ (Bash / curl)│ │
                        │  └────────┬────────┘ └───────┬───────┘ └──────┬───────┘ │
                        └───────────┼──────────────────┼────────────────┼─────────┘
                                    │                  │                │
                                    │ Auth0 JWT        │ Auth0 JWT      │ Personal token
                                    ▼                  ▼                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           Cloudflare Edge Infrastructure                        │
│                                                                                 │
│   ┌────────────────────────────────┐        ┌───────────────────────────────┐   │
│   │   Cloudflare Pages Frontend    │        │    Cloudflare Workers API     │   │
│   │   (@cloudflare/next-on-pages)  │───────>│         (Hono V4)             │   │
│   └────────────────────────────────┘        └───────────────┬───────────────┘   │
│                                                             │                   │
│                                                             ▼                   │
│                                             ┌───────────────────────────────┐   │
│                                             │    Cloudflare D1 Database     │   │
│                                             │   (SQLite / Drizzle ORM)      │   │
│                                             └───────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Technical Stack:
- **Frontend:** Next.js 15 (App Router), React 19, Mantine UI 7, `@tanstack/react-query`, Tabler Icons.
- **Edge Deployment:** `@cloudflare/next-on-pages` running on Cloudflare Pages (`timdo.tdobson.net`).
- **Backend API:** Cloudflare Workers running Hono v4, Drizzle ORM and Zod validation (`https://timdo-v2-api.tdobson.net/api/v2`).
- **Database:** Cloudflare D1 SQLite database (`timdo-v2-db`).
- **Authentication:**
  - Web UI: Auth0 JWT via NextAuth.js.
  - CLI and standalone MCP: each person signs in with `bin/timdo login` and uses their own personal token.
  - `X-Internal-Secret` is the instance owner's administrative credential. Never share it with collaborators or bots.
- **Integrations:**
  - Groq Whisper transcribes voice commands; users review proposed changes before applying them.
  - The standalone MCP exposes TimDo operations. A separate Gmail MCP can provide inbox access, but is not required to use TimDo.

---

## 3. Data model and hierarchy

```
Workspace (Organisation)
  Project
    Epic (optional)
      Task
        Dated notes
        External refs
```

Workspace members can see its projects, epics, tasks, notes and activity. Roles control who can
edit or administer them. Life goals are private to each person; `TaskUserGoals` links a person's
goals to tasks without sharing those goals with the workspace.

`Tasks` stores tasks and `TaskUpdates` stores their dated notes. `Projects` contains the project
containers. `Projects_Legacy` and `ProjectUpdates` are frozen archives, not live write targets.
For compatibility, the older `/projects` API and a task's `project` field still mean tasks and
task titles. The task's `category` is its containing project's name.

### Task fields and status

- `id`: UUID; the CLI also accepts unambiguous prefixes.
- `project`: task title in the legacy API response. Poster rendering can omit a redundant prefix
  that matches the task's category; this does not rewrite the stored title.
- `reason`: why the task matters.
- `status`: `do`, `awaiting`, `delay`, `delegate` or `done`.
- `priority`: 1 to 10.
- `size`: `*` to `*****`.
- `projectId` and `category`: the project container's id and name.
- `epicId`: optional epic.
- `goalId`: the caller's private goal link.
- `notes`: task details; dated updates are separate records.
- `awaitUntil`: return date for an awaiting task, in `YYYY-MM-DD` format. An hourly Worker cron
  returns due tasks to `do`.
- `gmailThreadId`: compatibility field mirrored from Gmail refs.

Refs have the roles `link`, `source`, `reported_by` and `about`. A canonical source identifies
one task in a workspace. A create request can return or report against that task instead of
creating a duplicate. Similar-title suggestions are advisory, not permission to merge tasks.

---

## 4. Poster Studio & Vector Printing Engine (`/poster`)

TimDo features an integrated **Poster Studio** designed for physical awareness via monochrome laser printing:

### 4.1 Wall of Done (6× A4 Tiled Master Banner)
- **Dimensions:** ~420mm × ~891mm (`viewBox="0 0 1587 3368"`).
- **Structure:**
  - Chronological flow: Oldest items at the top, latest achievements and momentum at the bottom.
  - **3 Horizontal Tiers** aligning with the physical 2×3 A4 paper grid.
  - **4 columns:** columns 1 to 3 contain tasks from the caller's personal workspace; column 4 contains tasks from their other workspaces. The headings are "Personal workspace" and "Other workspaces". A non-personal workspace can still have only one member.
  - **Continuation headers:** a category is named only when the last visible task in the previous tier and the first visible task in the current tier have that category. Other headers use the workspace-group name.
- **Capacity:** the six-sheet layout has a fixed size. A full column shows how many tasks did not fit and points to the Done view for the full list. The JSON response keeps all selected tasks and its total count; the poster is not a full data export.
- **Printing:** monochrome text, rules and micro-bar size markers, with no colour dependency.
- **Tiled Multi-Sheet Engine:** Produces 6 individual A4 SVGs (`viewBox="0 0 793.7 1122.5"`) with corner crosshairs (`+ P1` to `+ P6`), crop guidelines, and overlap margins for easy wall assembly.

### 4.2 Active Tasks Readout / Worksheet (A2)
- **Dimensions:** 420mm × 594mm portrait (`viewBox="0 0 420 594"`).
- **Behaviour:**
  - Includes `do`, `awaiting` and `delay` tasks in separate status sections.
  - Category filters use actual project names and appear in the heading.
  - Do rows show the title, reason, size and notes. Awaiting rows show return dates; Delay rows show reasons.
  - Long text wraps within the print layout and can be shortened to fit. This is a worksheet, not a full data export.
  - The default heading is `ACTIVE TASKS`; callers can supply a display name.

### 4.3 Life Goals & Routines (A2)
- **Dimensions:** 420mm × 594mm portrait (`viewBox="0 0 420 594"`).
- **Content:**
  - **Top 3 Aims:** 118mm × 60mm cards with multi-line `<tspan>` wrapping. Long aims render completely without string clipping or ellipses.
  - **Focuses:** 4 wide focus slots with emojis and wrapped titles.
  - **Core Values:** 6 numbered principles with titles and wrapped descriptive sentences.
  - **Regular Tasks / Housekeeping:** 6 schedule boxes (Weekly, Monthly, Every Few Months, Daily Personal, Daily Shared, Child Care) with clean bulleted items.

### 4.4 Multi-Category Filtering
Poster Studio features a reactive filter toolbar:
- Filter chips come from the caller's project categories, alongside `All Categories`.
- Category names are matched after trimming whitespace and ignoring case; no customer aliases are built in.
- Scopes both **Active Tasks Readout** and **Wall of Done** in real time.
- Dynamic download filenames (e.g. `timdo-active-tasks-Acme-Solar-2026-09-15.svg`).

---

## 5. CLI & Automation Tooling (`bin/timdo`)

The CLI manages tasks, notes, epics, goals and workspace membership:

```bash
# Task operations
bin/timdo list [all|do|delay|delegate|done|awaiting] [-p <category>]
bin/timdo add "Title" -r "Reason" --status do --priority 8 --size "***" -p "Acme Solar"
bin/timdo update <id> --done
bin/timdo update <id> --awaiting --await-until 2026-09-30
bin/timdo add-note <id> "Sent revised calculation sheet"
bin/timdo merge <source_id> <target_id> --yes

# Epics & Goals
bin/timdo epic list [-p <category>]
bin/timdo epic add "Acme Solar Rollout" -p "Acme Solar"
bin/timdo goal list

# Vector Poster Generation & Export
bin/timdo poster --type done --category "Acme Solar" --output ~/acme_solar_done.svg
bin/timdo poster --type active --category "Acme Solar,Northstar Workshop" --output ~/active.svg
bin/timdo poster --type goals --output ~/life_goals.svg
```

---

## 6. Daily Workflows & Inbox Triage Protocol

1. **Morning Triage:** Review Gmail inbox via MCP (`search_threads`), synthesize thread history against existing TimDo tasks, and triage one-at-a-time (reply, log update, or park with return date).
2. **Day Execution:** Work from `bin/timdo list do` or the board view (`/board`). Append dated notes via `bin/timdo add-note` as progress occurs.
3. **Weekly Review & Poster Print:**
   - Review `/poster` in the browser.
   - Filter by current focus categories or inspect the overall portfolio.
   - Print out an updated A2 Active Worksheet or 6× A4 Wall of Done onto the monochrome laser printer for physical review.
