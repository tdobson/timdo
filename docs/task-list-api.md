# Task list and count API

## Endpoints

`GET /api/v2/projects` returns the original project-shaped task array. With no list options it remains unlimited and includes each task's full `notes` body. Responses also include `noteCount` and `lastNoteAt`.

`GET /api/v2/projects/counts` returns aggregate counts for the matching tasks. It uses the same visibility and membership filters as the list route.

`GET /api/v2/tasks` remains an unlimited array of raw `Tasks` rows. It includes full task bodies and keeps its existing `mine=true` rule: the caller must be the assignee. On `/projects`, `assignee=me` also includes unassigned tasks reported by the caller.

## List options

All query parameters are optional. Filters that change list membership are applied in SQL before counting and paging.

| Parameter | Meaning |
| --- | --- |
| `category` | Exact project name, case-insensitive after trimming with Unicode lowercase mapping. |
| `orgId` | Restrict results to an accessible workspace. |
| `projectId` | Restrict results to an accessible project id. |
| `status` | One or more comma-separated values: `do`, `delay`, `awaiting`, `delegate`, `done`. |
| `epicId` | Restrict results to one epic. |
| `goalId` | Restrict results to tasks linked to this goal for the caller. Goal links are private to each user. |
| `customer` | Exact customer value, case-insensitive for ASCII letters. Non-ASCII case pairs remain distinct under SQLite `lower()`. |
| `tag` | Case-insensitive substring match in the task's tags. |
| `relatedTo` | A visible task id or prefix. Matches tasks linked to it in either direction. |
| `assignee` | `me`, `unassigned`, `mine_or_unassigned`, or a user id. `me` includes unassigned tasks reported by the caller. |
| `ref` | A URL or `kind:id`. Matches tasks carrying the ref in any role. |
| `role` or `refRole` | Restrict `ref` to `link`, `source`, `reported_by`, or `about`. |
| `shared` | `true` for workspaces with more than one member, `false` for workspaces with one member. |
| `noEpic` | `true` to select tasks without an epic. |
| `noGoal` | `true` to select tasks without a goal link for the caller. |
| `noCategory` | `true` to select tasks whose project name is blank. |
| `unlinked` | `any`, `epic`, `goal`, or `category`. `any` matches a missing epic, caller goal link, or category. |
| `doneSince` | Inclusive `YYYY-MM-DD` lower bound for Done tasks' effective completion date. |
| `doneBefore` | Exclusive `YYYY-MM-DD` upper bound for Done tasks' effective completion date. |
| `fields` | `summary` or `full`. Defaults to `full`. |
| `sort` | `default` or `completed`. `completed` selects Done tasks and orders them by completion date. If `status` is supplied with this sort, it must contain only `done`. |
| `limit` | Page size, an integer from 1 to 200. |
| `cursor` | Continue a page walk. Requires `limit`. |

When filters are combined, each filter is required. `unlinked=any` is one filter whose three missing-link tests are joined with OR. An unresolved `relatedTo` selects no rows and is distinct from omitting `relatedTo`. Date bounds constrain Done tasks; other statuses continue to match unless `status` narrows them.

The raw `/tasks` list also accepts the membership filters above, plus `assigneeId`, `mine=true`, and `unassigned=true`. It stays unlimited, returns raw task rows, and does not use the `/projects` projection, sort or paging options.

## Summary fields

`fields=summary` selects the task columns used by a collapsed row and omits `Tasks.notes` from the SQL projection. The `notes` property is absent from each result. Other TaskView fields remain, including `reason`, ids, attribution, refs, and personal goal overlay. `noteCount` and `lastNoteAt` come from grouped `TaskUpdates` queries.

`lastNoteAt` is the latest parseable update-note timestamp, normalised to UTC. A task with no update notes has `noteCount: 0` and `lastNoteAt: null`.

List visibility uses workspace membership SQL rather than a bound list of accessible project ids. Refs, note metadata, caller goal overlays and user names are enriched for selected task ids in chunks under D1's 100-bind limit. Unlimited full lists use the same chunking without truncating results.

## Paging and counts

A paged `GET /projects` response keeps the array body. It includes:

- `X-Total-Count`: count after all membership filters, before the cursor and limit.
- `X-Next-Cursor`: present when another page is available.

The CORS response exposes both headers to browser clients. No paging headers are added to an unlimited list response.

`GET /projects/counts` returns the same semantic filters as the list route. It ignores `fields`, `limit`, and `cursor` and returns:

```json
{
  "byStatus": {
    "do": 0,
    "delay": 0,
    "awaiting": 0,
    "delegate": 0,
    "done": 0
  },
  "total": 0
}
```

All five status keys are present, including zeroes. `sort=completed` and the completion-date filters affect counts because they change which tasks match.

## Ordering and dates

The default order is status ascending, priority descending, effective update time descending, then id ascending. Effective update time uses `updatedAt`, then `createdAt`, then the oldest sentinel.

`sort=completed` orders by effective completion time descending, priority descending, effective update time descending, then id ascending. Effective completion time uses `statusLastChangedOn`, then `createdAt`, then the oldest sentinel. It never falls back to `updatedAt`, so a later note cannot make an old Done task appear recently completed.

SQLite timestamps and ISO timestamps are compared through SQLite date conversion. Date filters use UTC midnight boundaries. Invalid calendar dates, including impossible dates such as `2026-02-30`, return HTTP 400.

## Cursor rules

Cursors are versioned, opaque continuation values. They carry validated sort keys and a fingerprint of the authenticated user, endpoint scope, sort and semantic filters. Changing a membership filter or sort requires starting again without the cursor. The page size and projection can change between requests.

Each page checks workspace membership again. Keyset comparisons include the final task id, so equal timestamps and priorities have a stable order. The cursor stores its last sort key, so deleting that task after receiving a page does not break the next request. Pages do not provide snapshot isolation; concurrent edits can change later results.

An invalid, expired, mismatched or malformed cursor returns HTTP 400:

```json
{ "error": "That page link has expired, start again without a cursor" }
```

Cursor strings are limited to 4096 URL-safe characters. Task ids have no separate length limit, but if a next-page key cannot fit within that cursor limit, the request returns HTTP 400 with `The next page cursor would exceed the 4096-character limit` rather than returning a continuation the server would reject.

A cursor without `limit` returns HTTP 400. Invalid statuses list the allowed status values in the error response. Limits outside 1 to 200 return HTTP 400.

## Bounded backend helpers

The Worker exports these helpers from `workers/src/services/taskListService.ts` for other backend surfaces:

```ts
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '../db/schema';

type DB = DrizzleD1Database<typeof schema>;
type TaskRow = typeof schema.tasks.$inferSelect;
export type TaskStatus = 'do' | 'delay' | 'awaiting' | 'delegate' | 'done';
export type TaskListFields = 'summary' | 'full';
export interface TaskListFilters {
  category?: string;
  orgId?: string;
  projectId?: string;
  status?: string | string[];
  epicId?: string;
  goalId?: string;
  customer?: string;
  tag?: string;
  relatedTo?: string;
  assignee?: string;
  assigneeId?: string | null;
  mineOnly?: boolean;
  unassignedOnly?: boolean;
  ref?: { kind: string; ref: string };
  refRole?: 'link' | 'source' | 'reported_by' | 'about';
  shared?: boolean;
  noEpic?: boolean;
  noGoal?: boolean;
  noCategory?: boolean;
  unlinked?: 'any' | 'epic' | 'goal' | 'category';
  doneSince?: string;
  doneBefore?: string;
  sort?: 'default' | 'completed';
}
export interface TaskCounts {
  byStatus: Record<TaskStatus, number>;
  total: number;
}
export interface TaskAggregateCounts extends TaskCounts {
  byAssignee: Array<{ assigneeId: string | null; count: number }>;
}
export type TaskListRecord = Omit<TaskRow, 'notes'> & Partial<Pick<TaskRow, 'notes'>>;
export interface TaskListResult<T = TaskListRecord> {
  items: T[];
  total?: number;
  nextCursor?: string;
}

export function getTaskListForUser(
  db: DB,
  userId: string,
  filters?: TaskListFilters,
  options?: {
    fields?: TaskListFields;
    limit?: number;
    cursor?: string;
    scope?: 'projects' | 'tasks';
  }
): Promise<TaskListResult>;

export function getTaskCountsForUser(
  db: DB,
  userId: string,
  filters?: TaskListFilters,
  scope?: 'projects' | 'tasks'
): Promise<TaskCounts>;

export function getTaskAggregateCountsForUser(
  db: DB,
  userId: string,
  filters?: TaskListFilters
): Promise<TaskAggregateCounts>;

export function getSelectedTaskRows(
  db: DB,
  userId: string,
  taskIds: string[],
  options?: { fields?: TaskListFields }
): Promise<TaskListRecord[]>;

export function getTaskNoteMetadata(
  db: DB,
  taskIds: string[]
): Promise<Map<string, { noteCount: number; lastNoteAt: string | null }>>;
```

`getSelectedTaskRows` accepts at most 150 distinct ids, checks visibility, and reads them in bind-safe chunks. It preserves the first-seen order of the requested ids, including across chunks, while omitting unknown, deleted and inaccessible tasks. It defaults to a summary projection. Use `{ fields: 'full' }` only when the caller needs task bodies.

`getTaskAggregateCountsForUser` returns aggregate status totals and `{ assigneeId, count }` rows from SQL. The counts cover all matching visible tasks, not a selected sample.

`projectService.getSelectedTaskSummariesForUser(db: DB, userId: string, taskIds: string[]): Promise<TaskSummaryView[]>` applies the same 150-id bound and preserves the same caller order after enrichment with refs, the caller's goal overlay, names and note metadata. `TaskSummaryView` omits the `TaskView.notes` body.
