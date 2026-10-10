import { describe, expect, it, vi } from 'vitest';
import { parsePosterGoals, seedGoalsForUser } from '../scripts/seedGoalsFromPoster';

describe('Goals Seeder', () => {
  it('parses poster goals data correctly', () => {
    const goals = parsePosterGoals();
    expect(goals.aims.length).toBe(3);
    expect(goals.focuses.length).toBe(4);
    expect(goals.values.length).toBe(6);
    expect(goals.housekeeping.length).toBe(6);

    expect(goals.aims[0].title).toBe('Look after the people who matter');
    expect(goals.aims[0].icon).toBe('❤️');

    expect(goals.aims[1].title).toBe('Build something worthwhile');
    expect(goals.aims[1].icon).toBe('🚀');

    expect(goals.aims[2].title).toBe('Find moments of adventure');
    expect(goals.aims[2].icon).toBe('🏔️');
  });

  it('seeds default goals into DB for user idempotently', async () => {
    const goalsStore: any[] = [];
    const db: any = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => goalsStore.filter((g) => g.userId === 'user-1')),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((val: any) => {
          goalsStore.push(val);
          return Promise.resolve();
        }),
      })),
    };

    const res1 = await seedGoalsForUser(db, 'user-1');
    expect(res1.seededCount).toBe(19);
    expect(goalsStore.length).toBe(19);

    // Second run should be idempotent (skip existing)
    const res2 = await seedGoalsForUser(db, 'user-1');
    expect(res2.seededCount).toBe(0);
    expect(goalsStore.length).toBe(19);
  });
});
