/**
 * Personal access tokens for the CLI and MCP.
 *
 * A token acts only as the person who created it (it can never act as someone else), is shown
 * once at creation, and is stored as a SHA-256 hash. Tokens are created from a signed-in web
 * session, so a leaked token can't mint more tokens.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '../db/schema';

type DB = DrizzleD1Database<typeof schema>;

export const TOKEN_PREFIX = 'tdo_';
export const MAX_ACTIVE_TOKENS = 20;
// Only record "last used" this often, to keep D1 writes down
const LAST_USED_GRANULARITY_MS = 60 * 60 * 1000;

export interface TokenSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export const isPersonalToken = (value: string) => value.startsWith(TOKEN_PREFIX);

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(30));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export interface PreparedToken {
  row: typeof schema.apiTokens.$inferInsert;
  token: string;
  summary: TokenSummary;
}

/** Prepare a one-time credential and its hash without persisting the plaintext. */
export async function prepareToken(userId: string, name: string): Promise<PreparedToken> {
  const token = `${TOKEN_PREFIX}${randomSecret()}`;
  const row = {
    id: uuidv4(),
    userId,
    name: name.trim(),
    tokenHash: await hashToken(token),
    prefix: token.slice(0, TOKEN_PREFIX.length + 6),
    createdAt: new Date().toISOString(),
  };
  return {
    row,
    token,
    summary: {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      createdAt: row.createdAt ?? null,
      lastUsedAt: null,
    },
  };
}

export async function createToken(db: DB, userId: string, name: string) {
  const user = await db
    .select({ kind: schema.users.kind })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  if (user?.kind === 'bot') {
    throw new Error('Bots cannot create personal tokens');
  }
  const active = await listTokens(db, userId);
  if (active.length >= MAX_ACTIVE_TOKENS) {
    throw new Error(`You already have ${MAX_ACTIVE_TOKENS} tokens. Revoke one you no longer use.`);
  }
  const prepared = await prepareToken(userId, name);
  await db.insert(schema.apiTokens).values(prepared.row);
  return { ...prepared.summary, token: prepared.token };
}

export async function listTokens(db: DB, userId: string): Promise<TokenSummary[]> {
  return db
    .select({
      id: schema.apiTokens.id,
      name: schema.apiTokens.name,
      prefix: schema.apiTokens.prefix,
      createdAt: schema.apiTokens.createdAt,
      lastUsedAt: schema.apiTokens.lastUsedAt,
    })
    .from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)))
    .orderBy(desc(schema.apiTokens.createdAt));
}

export async function revokeToken(db: DB, userId: string, tokenId: string) {
  const result = await db
    .update(schema.apiTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.apiTokens.id, tokenId),
        eq(schema.apiTokens.userId, userId),
        isNull(schema.apiTokens.revokedAt)
      )
    )
    .returning({ id: schema.apiTokens.id });
  return result.length > 0;
}

/** The user (and token id) a token belongs to, or null if it's unknown or revoked. */
export async function resolveToken(
  db: DB,
  token: string
): Promise<{
  userId: string;
  tokenId: string;
  name: string;
  kind: 'human' | 'bot';
  disabled: boolean;
} | null> {
  if (!isPersonalToken(token)) {
    return null;
  }
  const row = await db
    .select({
      id: schema.apiTokens.id,
      userId: schema.apiTokens.userId,
      name: schema.apiTokens.name,
      lastUsedAt: schema.apiTokens.lastUsedAt,
      revokedAt: schema.apiTokens.revokedAt,
      kind: schema.users.kind,
      botOrgId: schema.users.botOrgId,
      disabledAt: schema.users.disabledAt,
    })
    .from(schema.apiTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
    .where(eq(schema.apiTokens.tokenHash, await hashToken(token)))
    .get();
  if (!row) {
    return null;
  }
  const kind = row.kind === 'bot' ? 'bot' : 'human';
  const disabled = kind === 'bot' && row.disabledAt !== null;
  if (disabled) {
    return { userId: row.userId, tokenId: row.id, name: row.name, kind, disabled: true };
  }
  if (row.revokedAt !== null) {
    return null;
  }
  if (kind === 'bot') {
    const member = await db
      .select({ role: schema.organisationMembers.role })
      .from(schema.organisationMembers)
      .where(
        and(
          eq(schema.organisationMembers.userId, row.userId),
          eq(schema.organisationMembers.orgId, row.botOrgId ?? '')
        )
      )
      .get();
    if (!member || (member.role !== 'member' && member.role !== 'viewer')) {
      return null;
    }
  }

  const last = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
  if (Date.now() - last > LAST_USED_GRANULARITY_MS) {
    try {
      await db
        .update(schema.apiTokens)
        .set({ lastUsedAt: new Date().toISOString() })
        .where(eq(schema.apiTokens.id, row.id));
    } catch (err) {
      console.warn('[tokens] could not record last use', err);
    }
  }
  return { userId: row.userId, tokenId: row.id, name: row.name, kind, disabled: false };
}
