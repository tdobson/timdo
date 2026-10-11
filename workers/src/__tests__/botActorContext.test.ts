import { describe, expect, it } from 'vitest';
import { logActivity } from '../services/activityService';
import { withActorContext } from '../services/requestActorContext';
import { createTestDb, ROBIN, seedCollaboration, TIM } from './helpers/testDb';

async function record(db: any, actorId: string, action: string) {
  await logActivity(db, {
    actorId,
    entityType: 'member',
    entityId: actorId,
    action,
    summary: 'Fixture interleaved event',
  });
}

describe('request actor context isolation', () => {
  it('keeps interleaved request provenance separate and clears a reused handle after each request', async () => {
    const first = createTestDb();
    const second = createTestDb();
    seedCollaboration(first.raw);
    seedCollaboration(second.raw);

    await Promise.all([
      withActorContext(first.db, { via: 'token', viaDetail: 'fixture token label' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await record(first.db, ROBIN, 'first-request');
      }),
      withActorContext(second.db, { via: 'owner_secret' }, async () => {
        await record(second.db, TIM, 'second-request');
      }),
    ]);
    await record(first.db, ROBIN, 'unbound-after-request');

    expect(
      first.raw
        .prepare("SELECT via, via_detail FROM ActivityLog WHERE action = 'first-request'")
        .get()
    ).toEqual({
      via: 'token',
      via_detail: 'fixture token label',
    });
    expect(
      second.raw
        .prepare("SELECT via, via_detail FROM ActivityLog WHERE action = 'second-request'")
        .get()
    ).toEqual({
      via: 'owner_secret',
      via_detail: null,
    });
    expect(
      first.raw
        .prepare("SELECT via, via_detail FROM ActivityLog WHERE action = 'unbound-after-request'")
        .get()
    ).toEqual({
      via: null,
      via_detail: null,
    });
  });
});
