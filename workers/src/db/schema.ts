import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('Users', {
  id: text('id').primaryKey(), // Auth0 User ID (sub claim), or bot|<uuid>
  email: text('email').notNull().unique(),
  name: text('name'),
  kind: text('kind', { enum: ['human', 'bot'] })
    .notNull()
    .default('human'),
  botOrgId: text('bot_org_id').references((): AnySQLiteColumn => organisations.id, {
    onDelete: 'cascade',
  }),
  createdBy: text('created_by').references((): AnySQLiteColumn => users.id, {
    onDelete: 'set null',
  }),
  disabledAt: text('disabled_at'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
});

export const organisations = sqliteTable('Organisations', {
  id: text('id').primaryKey(), // UUID or 'org_' prefix
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  isPersonal: integer('is_personal', { mode: 'boolean' }).notNull().default(false),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
});

export const organisationMembers = sqliteTable('OrganisationMembers', {
  id: text('id').primaryKey(), // UUID
  orgId: text('org_id')
    .notNull()
    .references(() => organisations.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['owner', 'admin', 'member', 'viewer'] })
    .notNull()
    .default('member'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
});

export const organisationInvites = sqliteTable('OrganisationInvites', {
  id: text('id').primaryKey(), // UUID
  orgId: text('org_id')
    .notNull()
    .references(() => organisations.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role', { enum: ['admin', 'member', 'viewer'] })
    .notNull()
    .default('member'),
  token: text('token').notNull().unique(),
  invitedBy: text('invited_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
  acceptedBy: text('accepted_by').references(() => users.id, { onDelete: 'set null' }),
  acceptedAt: text('accepted_at'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

export const projects = sqliteTable('Projects', {
  id: text('id').primaryKey(), // UUID
  orgId: text('org_id')
    .notNull()
    .references(() => organisations.id, { onDelete: 'cascade' }),
  key: text('key').notNull(), // 'XEB', 'SOL', etc.
  name: text('name').notNull(),
  description: text('description'),
  leadUserId: text('lead_user_id').references(() => users.id, { onDelete: 'set null' }),
  isArchived: integer('is_archived', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
});

export const goals = sqliteTable('Goals', {
  id: text('id').primaryKey(), // UUID
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  type: text('type', { enum: ['aim', 'focus', 'value', 'housekeeping'] }).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  icon: text('icon'),
  orderIndex: integer('order_index').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
});

export const epics = sqliteTable('Epics', {
  id: text('id').primaryKey(), // UUID
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  category: text('category'),
  goalId: text('goal_id').references(() => goals.id, { onDelete: 'set null' }),
  status: text('status', { enum: ['active', 'completed', 'on_hold'] })
    .notNull()
    .default('active'),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
});

export const tasks = sqliteTable('Tasks', {
  id: text('id').primaryKey(), // UUID
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  epicId: text('epic_id').references(() => epics.id, { onDelete: 'set null' }),
  reporterId: text('reporter_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  assigneeId: text('assignee_id').references(() => users.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  reason: text('reason'),
  status: text('status', { enum: ['do', 'delay', 'done', 'delegate', 'awaiting'] })
    .notNull()
    .default('do'),
  priority: integer('priority').notNull().default(5),
  size: text('size', { enum: ['*', '**', '***', '****', '*****'] })
    .notNull()
    .default('***'),
  notes: text('notes'),
  statusLastChangedOn: text('status_last_changed_on'),
  awaitUntil: text('await_until'),
  gmailThreadId: text('gmail_thread_id'),
  customer: text('customer'),
  tags: text('tags'),
  isDeleted: integer('is_deleted', { mode: 'boolean' }).default(false),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
});

export const taskUserGoals = sqliteTable('TaskUserGoals', {
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  goalId: text('goal_id')
    .notNull()
    .references(() => goals.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

export const taskUpdates = sqliteTable('TaskUpdates', {
  id: text('id').primaryKey(), // UUID
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  authorId: text('author_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  note: text('note').notNull(),
  gmailThreadId: text('gmail_thread_id'),
  dedupeKey: text('dedupe_key'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
});

// Legacy backward-compatibility aliases
export const legacyProjects = sqliteTable('Projects_Legacy', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  project: text('project').notNull(),
  reason: text('reason'),
  status: text('status', { enum: ['do', 'delay', 'done', 'delegate', 'awaiting'] })
    .notNull()
    .default('do'),
  priority: integer('priority').notNull().default(5),
  size: text('size', { enum: ['*', '**', '***', '****', '*****'] })
    .notNull()
    .default('***'),
  notes: text('notes'),
  statusLastChangedOn: text('status_last_changed_on'),
  awaitUntil: text('await_until'),
  gmailThreadId: text('gmail_thread_id'),
  customer: text('customer'),
  tags: text('tags'),
  category: text('category'),
  epicId: text('epic_id').references(() => epics.id, { onDelete: 'set null' }),
  goalId: text('goal_id').references(() => goals.id, { onDelete: 'set null' }),
  isDeleted: integer('is_deleted', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
});

export const projectUpdates = sqliteTable('ProjectUpdates', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => legacyProjects.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  note: text('note').notNull(),
  gmailThreadId: text('gmail_thread_id'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
});

export const taskRelations = sqliteTable('TaskRelations', {
  id: text('id').primaryKey(),
  sourceTaskId: text('source_task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  targetTaskId: text('target_task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  relationType: text('relation_type', {
    enum: ['relates_to', 'blocks', 'blocked_by', 'duplicates'],
  })
    .notNull()
    .default('relates_to'),
  reason: text('reason'),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

// Pointers from a task to things outside TimDo; org_id copies the task's workspace (migration 0008)
export const taskRefs = sqliteTable('TaskRefs', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  orgId: text('org_id')
    .notNull()
    .references(() => organisations.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['link', 'source', 'reported_by', 'about'] })
    .notNull()
    .default('link'),
  kind: text('kind').notNull(),
  ref: text('ref').notNull(),
  url: text('url'),
  label: text('label'), // display only, never written to the activity log
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

export const activityLog = sqliteTable('ActivityLog', {
  id: text('id').primaryKey(),
  actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }), // null = system
  orgId: text('org_id').references(() => organisations.id, { onDelete: 'cascade' }),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
  entityType: text('entity_type', {
    enum: ['task', 'epic', 'note', 'project', 'organisation', 'member'],
  }).notNull(),
  entityId: text('entity_id').notNull(),
  taskId: text('task_id'),
  epicId: text('epic_id'),
  action: text('action').notNull(),
  summary: text('summary').notNull(),
  changes: text('changes'), // JSON { field: { from, to } }
  via: text('via', { enum: ['web', 'token', 'owner_secret', 'system'] }),
  viaDetail: text('via_detail'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

// FTS5 virtual table (created by migration 0005, kept in sync by triggers). Read-only here.
export const tasksFts = sqliteTable('Tasks_FTS', {
  taskId: text('task_id'),
  title: text('title'),
  reason: text('reason'),
  notes: text('notes'),
  customer: text('customer'),
  tags: text('tags'),
  updateNotes: text('update_notes'),
});

// Personal access tokens for the CLI/MCP; only the SHA-256 hash is stored
export const apiTokens = sqliteTable('ApiTokens', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
});
