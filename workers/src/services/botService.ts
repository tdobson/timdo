import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '../db/schema';
import {
  hasControlCharacters,
  type BotCreateInput,
  type BotTokenCreateInput,
  type BotUpdateInput,
} from '../validators/botValidators';
import { AccessError, canManage, getOrgRole } from './accessService';
import { preparedSqlBatchItem } from './d1Batch';
import { getPeople } from './personService';
import { getActorContext } from './requestActorContext';
import { MAX_ACTIVE_TOKENS, prepareToken, type TokenSummary } from './tokenService';

type DB = DrizzleD1Database<typeof schema>;
type BotRole = 'member' | 'viewer';
type ActorVia = 'web' | 'token' | 'owner_secret' | 'system';

export interface BotView {
  id: string;
  kind: 'bot';
  name: string;
  role: BotRole | null;
  createdByName: string | null;
  createdAt: string | null;
  disabledAt: string | null;
  tokens: TokenSummary[];
}

export class BotError extends Error {
  status: 400 | 409;

  constructor(message: string, status: 400 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

function cleanName(value: string, label: string, maximum: number): string {
  const name = value.trim();
  if (hasControlCharacters(value) || !name || name.length > maximum) {
    throw new BotError(
      `${label} must be non-empty, at most ${maximum} characters, and contain no control characters`
    );
  }
  return name;
}

function lifecycleContext(db: DB) {
  const context = getActorContext(db);
  if (!context) {
    throw new AccessError('Bots are managed on the web: https://timdo.tdobson.net/sharing');
  }
  return context;
}

async function requireManager(db: DB, actorId: string, orgId: string) {
  const context = lifecycleContext(db);
  if (context.via === 'token' || context.via === 'system') {
    throw new AccessError('Bots are managed on the web: https://timdo.tdobson.net/sharing');
  }
  const actor = await db
    .select({ kind: schema.users.kind })
    .from(schema.users)
    .where(eq(schema.users.id, actorId))
    .get();
  if (actor?.kind !== 'human') {
    throw new AccessError('Bots are managed on the web: https://timdo.tdobson.net/sharing');
  }
  const role = await getOrgRole(db, actorId, orgId);
  if (!role) {
    throw new AccessError('Workspace not found or access denied', 404);
  }
  if (!canManage(role)) {
    throw new AccessError('Only workspace owners and admins can manage bots');
  }
  const org = await db
    .select({ id: schema.organisations.id, isPersonal: schema.organisations.isPersonal })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, orgId))
    .get();
  if (!org || org.isPersonal) {
    throw new AccessError('Workspace not found or access denied', 404);
  }
  return context;
}

function auditInsert(
  db: DB,
  params: {
    actorId: string;
    orgId: string;
    botId: string;
    action: string;
    summary: string;
    changes?: Record<string, { from: unknown; to: unknown }>;
    context: { via: ActorVia; viaDetail?: string };
    now: string;
  }
) {
  const columns = sql`(id, actor_id, org_id, project_id, entity_type, entity_id, task_id, epic_id, action, summary, changes, via, via_detail, created_at)`;
  const changes = params.changes ? JSON.stringify(params.changes) : null;
  return preparedSqlBatchItem(
    db,
    sql`INSERT INTO ActivityLog ${columns}
      SELECT ${uuidv4()}, ${params.actorId}, ${params.orgId}, NULL, 'member', ${params.botId}, NULL, NULL,
        ${params.action}, ${params.summary}, ${changes}, ${params.context.via}, ${params.context.viaDetail ?? null}, ${params.now}
      WHERE changes() = 1 RETURNING id`,
    'all'
  );
}

async function getBotRow(db: DB, orgId: string, botId: string) {
  return db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      createdBy: schema.users.createdBy,
      createdAt: schema.users.createdAt,
      disabledAt: schema.users.disabledAt,
    })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.id, botId),
        eq(schema.users.kind, 'bot'),
        eq(schema.users.botOrgId, orgId)
      )
    )
    .get();
}

async function getBotState(db: DB, orgId: string, botId: string) {
  return db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      createdBy: schema.users.createdBy,
      createdAt: schema.users.createdAt,
      disabledAt: schema.users.disabledAt,
      role: schema.organisationMembers.role,
    })
    .from(schema.users)
    .leftJoin(
      schema.organisationMembers,
      and(
        eq(schema.organisationMembers.orgId, orgId),
        eq(schema.organisationMembers.userId, schema.users.id)
      )
    )
    .where(
      and(
        eq(schema.users.id, botId),
        eq(schema.users.kind, 'bot'),
        eq(schema.users.botOrgId, orgId)
      )
    )
    .get();
}

async function getBotView(db: DB, orgId: string, botId: string): Promise<BotView | null> {
  const row = await getBotRow(db, orgId, botId);
  if (!row) {
    return null;
  }
  const [people, membershipRows, tokenRows] = await Promise.all([
    getPeople(db, [row.createdBy]),
    db
      .select({ userId: schema.organisationMembers.userId, role: schema.organisationMembers.role })
      .from(schema.organisationMembers)
      .where(
        and(
          eq(schema.organisationMembers.orgId, orgId),
          eq(schema.organisationMembers.userId, botId)
        )
      ),
    row.disabledAt
      ? Promise.resolve([] as TokenSummary[])
      : db
          .select({
            id: schema.apiTokens.id,
            name: schema.apiTokens.name,
            prefix: schema.apiTokens.prefix,
            createdAt: schema.apiTokens.createdAt,
            lastUsedAt: schema.apiTokens.lastUsedAt,
          })
          .from(schema.apiTokens)
          .where(and(eq(schema.apiTokens.userId, botId), isNull(schema.apiTokens.revokedAt)))
          .orderBy(asc(schema.apiTokens.createdAt)),
  ]);
  return {
    id: row.id,
    kind: 'bot',
    name: row.name || 'Bot',
    role: row.disabledAt ? null : ((membershipRows[0]?.role as BotRole | undefined) ?? null),
    createdByName: row.createdBy ? (people.get(row.createdBy)?.name ?? null) : null,
    createdAt: row.createdAt,
    disabledAt: row.disabledAt,
    tokens: tokenRows,
  };
}

export async function listBots(db: DB, actorId: string, orgId: string): Promise<BotView[]> {
  await requireManager(db, actorId, orgId);
  const rows = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      createdBy: schema.users.createdBy,
      createdAt: schema.users.createdAt,
      disabledAt: schema.users.disabledAt,
    })
    .from(schema.users)
    .where(and(eq(schema.users.kind, 'bot'), eq(schema.users.botOrgId, orgId)))
    .orderBy(asc(schema.users.name), asc(schema.users.id));
  if (!rows.length) {
    return [];
  }
  const botIds = rows.map((row) => row.id);
  const creatorIds = rows.map((row) => row.createdBy);
  const people = await getPeople(db, creatorIds);
  const memberships: Array<{ userId: string; role: string }> = [];
  for (let index = 0; index < botIds.length; index += 90) {
    const chunk = botIds.slice(index, index + 90);
    memberships.push(
      ...(await db
        .select({
          userId: schema.organisationMembers.userId,
          role: schema.organisationMembers.role,
        })
        .from(schema.organisationMembers)
        .where(
          and(
            eq(schema.organisationMembers.orgId, orgId),
            inArray(schema.organisationMembers.userId, chunk)
          )
        ))
    );
  }
  const roleByBot = new Map(memberships.map((member) => [member.userId, member.role as BotRole]));
  const tokensByBot = new Map<string, TokenSummary[]>();
  for (let index = 0; index < botIds.length; index += 90) {
    const chunk = botIds.slice(index, index + 90);
    const tokens = await db
      .select({
        id: schema.apiTokens.id,
        userId: schema.apiTokens.userId,
        name: schema.apiTokens.name,
        prefix: schema.apiTokens.prefix,
        createdAt: schema.apiTokens.createdAt,
        lastUsedAt: schema.apiTokens.lastUsedAt,
      })
      .from(schema.apiTokens)
      .where(and(inArray(schema.apiTokens.userId, chunk), isNull(schema.apiTokens.revokedAt)))
      .orderBy(asc(schema.apiTokens.createdAt));
    for (const token of tokens) {
      if (!tokensByBot.has(token.userId)) {
        tokensByBot.set(token.userId, []);
      }
      tokensByBot.get(token.userId)!.push({
        id: token.id,
        name: token.name,
        prefix: token.prefix,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
      });
    }
  }
  return rows.map((row) => ({
    id: row.id,
    kind: 'bot',
    name: row.name || 'Bot',
    role: row.disabledAt ? null : (roleByBot.get(row.id) ?? null),
    createdByName: row.createdBy ? (people.get(row.createdBy)?.name ?? null) : null,
    createdAt: row.createdAt,
    disabledAt: row.disabledAt,
    tokens: row.disabledAt ? [] : (tokensByBot.get(row.id) ?? []),
  }));
}

export async function createBot(
  db: DB,
  actorId: string,
  orgId: string,
  input: BotCreateInput
): Promise<{ bot: BotView; token: string }> {
  const context = await requireManager(db, actorId, orgId);
  const name = cleanName(input.name, 'Bot name', 80);
  const tokenName = cleanName(input.tokenName ?? 'initial', 'Token name', 60);
  const role: BotRole = input.role ?? 'member';
  if (role !== 'member' && role !== 'viewer') {
    throw new BotError('Bot role must be member or viewer');
  }
  const botId = `bot|${uuidv4()}`;
  const email = `bot+${botId.slice(4)}@bots.timdo.invalid`;
  const now = new Date().toISOString();
  const token = await prepareToken(botId, tokenName);
  const writes: BatchItem<'sqlite'>[] = [
    preparedSqlBatchItem(
      db,
      sql`INSERT INTO Users (id, email, name, kind, bot_org_id, created_by, created_at, updated_at)
        SELECT ${botId}, ${email}, ${name}, 'bot', ${orgId}, ${actorId}, ${now}, ${now}
        WHERE EXISTS (
          SELECT 1 FROM OrganisationMembers m JOIN Users u ON u.id = m.user_id
          JOIN Organisations o ON o.id = m.org_id
          WHERE m.org_id = ${orgId} AND m.user_id = ${actorId}
            AND m.role IN ('owner', 'admin') AND u.kind = 'human' AND o.is_personal = 0
        ) RETURNING id`,
      'all'
    ),
    preparedSqlBatchItem(
      db,
      sql`UPDATE OrganisationMembers SET role = ${role}, updated_at = ${now}
        WHERE org_id = ${orgId} AND user_id = ${botId} AND role != ${role}
          AND EXISTS (SELECT 1 FROM Users WHERE id = ${botId} AND kind = 'bot' AND disabled_at IS NULL)
          AND EXISTS (SELECT 1 FROM OrganisationMembers WHERE org_id = ${orgId} AND user_id = ${actorId} AND role IN ('owner', 'admin'))
        RETURNING id`,
      'all'
    ),
    preparedSqlBatchItem(
      db,
      sql`INSERT INTO ApiTokens (id, user_id, name, token_hash, prefix, created_at, last_used_at, revoked_at)
        SELECT ${token.row.id}, ${botId}, ${tokenName}, ${token.row.tokenHash}, ${token.row.prefix}, ${token.row.createdAt}, NULL, NULL
        WHERE EXISTS (SELECT 1 FROM Users WHERE id = ${botId} AND kind = 'bot' AND disabled_at IS NULL)
          AND EXISTS (SELECT 1 FROM OrganisationMembers WHERE org_id = ${orgId} AND user_id = ${botId} AND role IN ('member', 'viewer'))
        RETURNING id`,
      'all'
    ),
    preparedSqlBatchItem(
      db,
      sql`INSERT INTO ActivityLog (id, actor_id, org_id, project_id, entity_type, entity_id, task_id, epic_id, action, summary, changes, via, via_detail, created_at)
        SELECT ${uuidv4()}, ${actorId}, ${orgId}, NULL, 'member', ${botId}, NULL, NULL, 'bot_created', ${`Created bot "${name}"`},
          ${JSON.stringify({ name: { from: null, to: name }, role: { from: null, to: role } })}, ${context.via}, ${context.viaDetail ?? null}, ${now}
        WHERE EXISTS (SELECT 1 FROM Users WHERE id = ${botId} AND kind = 'bot')
          AND EXISTS (SELECT 1 FROM ApiTokens WHERE id = ${token.row.id} AND user_id = ${botId})
        RETURNING id`,
      'all'
    ),
  ];
  const results = await db.batch(writes as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  if (!(results[0] as unknown[][]).length) {
    throw new AccessError('Only workspace owners and admins can manage bots');
  }
  const bot = await getBotView(db, orgId, botId);
  if (!bot) {
    throw new Error('Bot creation did not produce a bot');
  }
  return { bot, token: token.token };
}

export async function updateBot(
  db: DB,
  actorId: string,
  orgId: string,
  botId: string,
  input: BotUpdateInput
): Promise<BotView> {
  const context = await requireManager(db, actorId, orgId);
  const current = await getBotState(db, orgId, botId);
  if (!current) {
    throw new AccessError('Bot not found', 404);
  }
  if (current.disabledAt) {
    throw new AccessError('Disabled bots cannot be changed');
  }
  if (current.role === null) {
    throw new AccessError('Bot membership is not active');
  }
  const name = input.name === undefined ? current.name : cleanName(input.name, 'Bot name', 80);
  const role = input.role;
  if (role !== undefined && role !== 'member' && role !== 'viewer') {
    throw new BotError('Bot role must be member or viewer');
  }
  const existingRole = current.role;
  const nameChanged = name !== current.name;
  const roleChanged = role !== undefined && role !== existingRole;
  if (!nameChanged && !roleChanged) {
    const view = await getBotView(db, orgId, botId);
    if (!view) {
      throw new AccessError('Bot not found', 404);
    }
    return view;
  }
  const now = new Date().toISOString();
  const writes: BatchItem<'sqlite'>[] = [];
  let nameWriteIndex: number | undefined;
  let roleWriteIndex: number | undefined;
  if (nameChanged) {
    nameWriteIndex = writes.length;
    writes.push(
      preparedSqlBatchItem(
        db,
        sql`UPDATE Users SET name = ${name}, updated_at = ${now}
          WHERE id = ${botId} AND bot_org_id = ${orgId} AND kind = 'bot' AND disabled_at IS NULL
            AND name IS ${current.name}
            AND EXISTS (
              SELECT 1 FROM OrganisationMembers
              WHERE org_id = ${orgId} AND user_id = ${botId} AND role IS ${existingRole}
            )
          RETURNING id`,
        'all'
      ),
      auditInsert(db, {
        actorId,
        orgId,
        botId,
        action: 'bot_renamed',
        summary: `Renamed bot to "${name}"`,
        changes: { name: { from: current.name, to: name } },
        context,
        now,
      })
    );
  }
  if (roleChanged) {
    roleWriteIndex = writes.length;
    writes.push(
      preparedSqlBatchItem(
        db,
        sql`UPDATE OrganisationMembers SET role = ${role}, updated_at = ${now}
          WHERE user_id = ${botId} AND org_id = ${orgId}
            AND role IS ${existingRole} AND role != ${role}
            AND EXISTS (
              SELECT 1 FROM Users
              WHERE id = ${botId} AND bot_org_id = ${orgId} AND kind = 'bot' AND disabled_at IS NULL
                AND (name IS ${current.name} OR name IS ${name})
            )
          RETURNING id`,
        'all'
      ),
      auditInsert(db, {
        actorId,
        orgId,
        botId,
        action: 'bot_role_changed',
        summary: `Changed bot role to ${role}`,
        changes: { role: { from: existingRole, to: role } },
        context,
        now,
      })
    );
  }
  const results = await db.batch(writes as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  const wasApplied = (index: number | undefined) =>
    index === undefined || ((results[index] as unknown[][] | undefined)?.length ?? 0) > 0;
  if (!wasApplied(nameWriteIndex) || !wasApplied(roleWriteIndex)) {
    const latest = await getBotState(db, orgId, botId);
    if (!latest) {
      throw new AccessError('Bot not found', 404);
    }
    if (latest.disabledAt) {
      throw new AccessError('Disabled bots cannot be changed');
    }
    if (latest.role === null) {
      throw new AccessError('Bot membership is not active');
    }
    const requestedNameHolds = input.name === undefined || latest.name === name;
    const requestedRoleHolds = input.role === undefined || latest.role === role;
    if (requestedNameHolds && requestedRoleHolds) {
      const view = await getBotView(db, orgId, botId);
      if (!view) {
        throw new AccessError('Bot not found', 404);
      }
      return view;
    }
    throw new BotError('Bot was changed by another request', 409);
  }
  const view = await getBotView(db, orgId, botId);
  if (!view) {
    throw new AccessError('Bot not found', 404);
  }
  return view;
}

export async function disableBot(
  db: DB,
  actorId: string,
  orgId: string,
  botId: string
): Promise<void> {
  const context = await requireManager(db, actorId, orgId);
  const current = await getBotRow(db, orgId, botId);
  if (!current) {
    throw new AccessError('Bot not found', 404);
  }
  if (current.disabledAt) {
    return;
  }
  const now = new Date().toISOString();
  const writes: BatchItem<'sqlite'>[] = [
    preparedSqlBatchItem(
      db,
      sql`UPDATE Users SET disabled_at = ${now}, updated_at = ${now}
        WHERE id = ${botId} AND bot_org_id = ${orgId} AND kind = 'bot' AND disabled_at IS NULL RETURNING id`,
      'all'
    ),
    auditInsert(db, {
      actorId,
      orgId,
      botId,
      action: 'bot_disabled',
      summary: `Disabled bot "${current.name || 'Bot'}"`,
      changes: { disabledAt: { from: null, to: now } },
      context,
      now,
    }),
    preparedSqlBatchItem(
      db,
      sql`UPDATE ApiTokens SET revoked_at = ${now}
        WHERE user_id = ${botId} AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM Users WHERE id = ${botId} AND disabled_at = ${now})`,
      'run'
    ),
    preparedSqlBatchItem(
      db,
      sql`DELETE FROM OrganisationMembers WHERE user_id = ${botId} AND org_id = ${orgId}
        AND EXISTS (SELECT 1 FROM Users WHERE id = ${botId} AND disabled_at = ${now})`,
      'run'
    ),
  ];
  await db.batch(writes as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}

export async function createBotToken(
  db: DB,
  actorId: string,
  orgId: string,
  botId: string,
  input: BotTokenCreateInput
) {
  const context = await requireManager(db, actorId, orgId);
  const bot = await getBotRow(db, orgId, botId);
  if (!bot) {
    throw new AccessError('Bot not found', 404);
  }
  if (bot.disabledAt) {
    throw new AccessError('Disabled bots cannot issue tokens');
  }
  const name = cleanName(input.name, 'Token name', 60);
  const prepared = await prepareToken(botId, name);
  const activeTokens = await db
    .select({ id: schema.apiTokens.id })
    .from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.userId, botId), isNull(schema.apiTokens.revokedAt)))
    .limit(MAX_ACTIVE_TOKENS + 1);
  if (activeTokens.length >= MAX_ACTIVE_TOKENS) {
    throw new BotError(
      `You already have ${MAX_ACTIVE_TOKENS} tokens. Revoke one you no longer use.`
    );
  }
  const now = prepared.row.createdAt ?? new Date().toISOString();
  const writes: BatchItem<'sqlite'>[] = [
    preparedSqlBatchItem(
      db,
      sql`INSERT INTO ApiTokens (id, user_id, name, token_hash, prefix, created_at, last_used_at, revoked_at)
        SELECT ${prepared.row.id}, ${botId}, ${name}, ${prepared.row.tokenHash}, ${prepared.row.prefix}, ${now}, NULL, NULL
        WHERE (SELECT count(*) FROM ApiTokens WHERE user_id = ${botId} AND revoked_at IS NULL) < ${MAX_ACTIVE_TOKENS}
          AND EXISTS (SELECT 1 FROM Users WHERE id = ${botId} AND bot_org_id = ${orgId} AND kind = 'bot' AND disabled_at IS NULL)
          AND EXISTS (SELECT 1 FROM OrganisationMembers WHERE user_id = ${botId} AND org_id = ${orgId} AND role IN ('member', 'viewer'))
          AND EXISTS (SELECT 1 FROM OrganisationMembers WHERE user_id = ${actorId} AND org_id = ${orgId} AND role IN ('owner', 'admin'))
        RETURNING id`,
      'all'
    ),
    auditInsert(db, {
      actorId,
      orgId,
      botId,
      action: 'bot_token_created',
      summary: `Issued token "${name}" to bot "${bot.name || 'Bot'}"`,
      changes: { tokenName: { from: null, to: name } },
      context,
      now,
    }),
  ];
  const results = await db.batch(writes as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  if (!(results[0] as unknown[][]).length) {
    await requireManager(db, actorId, orgId);
    const after = await getBotRow(db, orgId, botId);
    if (!after) {
      throw new AccessError('Bot not found', 404);
    }
    if (after.disabledAt) {
      throw new AccessError('Disabled bots cannot issue tokens');
    }
    const currentTokens = await db
      .select({ id: schema.apiTokens.id })
      .from(schema.apiTokens)
      .where(and(eq(schema.apiTokens.userId, botId), isNull(schema.apiTokens.revokedAt)))
      .limit(MAX_ACTIVE_TOKENS + 1);
    if (currentTokens.length >= MAX_ACTIVE_TOKENS) {
      throw new BotError(
        `You already have ${MAX_ACTIVE_TOKENS} tokens. Revoke one you no longer use.`
      );
    }
    const membership = await db
      .select({ role: schema.organisationMembers.role })
      .from(schema.organisationMembers)
      .where(
        and(
          eq(schema.organisationMembers.userId, botId),
          eq(schema.organisationMembers.orgId, orgId)
        )
      )
      .get();
    if (!membership || (membership.role !== 'member' && membership.role !== 'viewer')) {
      throw new AccessError('Bot is not active');
    }
    throw new BotError('Could not issue a bot token');
  }
  return { ...prepared.summary, token: prepared.token };
}

export async function revokeBotToken(
  db: DB,
  actorId: string,
  orgId: string,
  botId: string,
  tokenId: string
): Promise<void> {
  const context = await requireManager(db, actorId, orgId);
  const bot = await getBotRow(db, orgId, botId);
  if (!bot) {
    throw new AccessError('Bot not found', 404);
  }
  const token = await db
    .select({ id: schema.apiTokens.id, revokedAt: schema.apiTokens.revokedAt })
    .from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.id, tokenId), eq(schema.apiTokens.userId, botId)))
    .get();
  if (!token) {
    throw new AccessError('Bot token not found', 404);
  }
  if (token.revokedAt) {
    return;
  }
  if (bot.disabledAt) {
    throw new AccessError('Disabled bots cannot change tokens');
  }
  const now = new Date().toISOString();
  const writes: BatchItem<'sqlite'>[] = [
    preparedSqlBatchItem(
      db,
      sql`UPDATE ApiTokens SET revoked_at = ${now}
        WHERE id = ${tokenId} AND user_id = ${botId} AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM Users WHERE id = ${botId} AND bot_org_id = ${orgId} AND kind = 'bot' AND disabled_at IS NULL)
        RETURNING id`,
      'all'
    ),
    auditInsert(db, {
      actorId,
      orgId,
      botId,
      action: 'bot_token_revoked',
      summary: `Revoked token "${tokenId}" from bot "${bot.name || 'Bot'}"`,
      changes: { tokenId: { from: tokenId, to: null } },
      context,
      now,
    }),
  ];
  await db.batch(writes as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}

export interface BotTaskCreationCount {
  botId: string;
  botName: string;
  orgId: string;
  orgName: string;
  tasksCreated: number;
}

/** Aggregated task-creation activity visible to this user, without event text or token metadata. */
export async function getBotTaskCreationCounts(
  db: DB,
  userId: string,
  options: { from: string; to: string; limit?: number }
): Promise<{ items: BotTaskCreationCount[]; total: number }> {
  const requestedLimit = options.limit ?? 50;
  const finiteLimit = Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 50;
  const limit = Math.max(0, Math.min(50, finiteLimit));
  const rows = (await db.values(sql`
    WITH bot_counts AS (
      SELECT u.id AS botId, COALESCE(u.name, 'Bot') AS botName,
        o.id AS orgId, o.name AS orgName,
        SUM(CASE WHEN a.id IS NULL THEN 0 ELSE 1 END) AS tasksCreated,
        u.disabled_at AS disabledAt
      FROM Users u
      INNER JOIN Organisations o ON o.id = u.bot_org_id
      INNER JOIN OrganisationMembers visible_bot_member
        ON visible_bot_member.org_id = u.bot_org_id AND visible_bot_member.user_id = ${userId}
      LEFT JOIN ActivityLog a
        ON a.actor_id = u.id
        AND a.entity_type = 'task'
        AND a.action = 'created'
        AND a.created_at >= ${options.from}
        AND a.created_at < ${options.to}
        AND (
          (a.project_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM Projects visible_project
            INNER JOIN OrganisationMembers visible_project_member
              ON visible_project_member.org_id = visible_project.org_id
            WHERE visible_project.id = a.project_id AND visible_project_member.user_id = ${userId}
          ))
          OR (a.project_id IS NULL AND a.org_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM OrganisationMembers visible_org_member
            WHERE visible_org_member.org_id = a.org_id AND visible_org_member.user_id = ${userId}
          ))
          OR (a.project_id IS NULL AND a.org_id IS NULL AND a.actor_id = ${userId})
        )
      WHERE u.kind = 'bot' AND u.bot_org_id IS NOT NULL
      GROUP BY u.id, u.name, o.id, o.name, u.disabled_at
      HAVING u.disabled_at IS NULL OR tasksCreated > 0
    )
    SELECT botId, botName, orgId, orgName, tasksCreated, COUNT(*) OVER () AS total
    FROM bot_counts
    ORDER BY tasksCreated DESC, botName COLLATE NOCASE ASC, botId ASC
    LIMIT ${Math.max(limit, 1)}
  `)) as unknown[][];
  const total = rows.length ? Number(rows[0][5]) : 0;
  return {
    items: rows.slice(0, limit).map((row) => ({
      botId: String(row[0]),
      botName: String(row[1]),
      orgId: String(row[2]),
      orgName: String(row[3]),
      tasksCreated: Number(row[4] || 0),
    })),
    total,
  };
}
