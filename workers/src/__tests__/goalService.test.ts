import { describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { createGoal, deleteGoal, getGoalsForUser, updateGoal } from '../services/goalService';

describe('goalService', () => {
  const mockDb = () => {
    const goalsStore: any[] = [];

    const db: any = {
      _store: goalsStore,
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn((condition: any) => ({
            get: vi.fn(async () => undefined),
            orderBy: vi.fn(() => {
              // Simulated filtering logic
              return goalsStore.filter((g) => {
                if (condition?.userId && g.userId !== condition.userId) return false;
                if (condition?.type && g.type !== condition.type) return false;
                if (g.isActive === false) return false;
                return true;
              });
            }),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((val: any) => ({
          returning: vi.fn(async () => {
            const row = { ...val, createdAt: val.createdAt || new Date().toISOString() };
            goalsStore.push(row);
            return [row];
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((val: any) => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              // for mock simplicity, update last or matching
              const idx = goalsStore.findIndex((g) => g.id === 'goal-1');
              if (idx !== -1) {
                goalsStore[idx] = { ...goalsStore[idx], ...val };
                return [goalsStore[idx]];
              }
              return [];
            }),
          })),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            const idx = goalsStore.findIndex((g) => g.id === 'goal-1');
            if (idx !== -1) {
              const removed = goalsStore.splice(idx, 1);
              return [{ id: removed[0].id }];
            }
            return [];
          }),
        })),
      })),
    };

    return db;
  };

  it('creates a goal and assigns user scoping', async () => {
    const db = mockDb();
    const created = await createGoal(db, 'user-123', {
      type: 'aim',
      title: 'Family & Home',
      description: 'Spend quality time',
      orderIndex: 1,
      isActive: true,
    });

    expect(created).toBeDefined();
    expect(created.userId).toBe('user-123');
    expect(created.type).toBe('aim');
    expect(created.title).toBe('Family & Home');
    expect(db.insert).toHaveBeenCalled();
  });

  it('queries goals with user filtering and ordering', async () => {
    const db = mockDb();
    db._store.push(
      {
        id: 'g1',
        userId: 'user-123',
        type: 'aim',
        title: 'Aim 1',
        isActive: true,
        orderIndex: 0,
        createdAt: '2026-01-01',
      },
      {
        id: 'g2',
        userId: 'user-123',
        type: 'focus',
        title: 'Focus 1',
        isActive: true,
        orderIndex: 0,
        createdAt: '2026-01-01',
      }
    );

    const result = await getGoalsForUser(db, 'user-123', 'aim');
    expect(db.select).toHaveBeenCalled();
    expect(Array.isArray(result)).toBe(true);
  });

  it('updates a goal for a specific user', async () => {
    const db = mockDb();
    db._store.push({
      id: 'goal-1',
      userId: 'user-123',
      type: 'aim',
      title: 'Original Title',
      isActive: true,
    });

    const updated = await updateGoal(db, 'user-123', 'goal-1', {
      title: 'Updated Title',
    });

    expect(updated).toBeDefined();
    expect(updated?.title).toBe('Updated Title');
  });

  it('deletes a goal for a specific user', async () => {
    const db = mockDb();
    db._store.push({
      id: 'goal-1',
      userId: 'user-123',
      type: 'aim',
      title: 'Original Title',
      isActive: true,
    });

    const success = await deleteGoal(db, 'user-123', 'goal-1');
    expect(success).toBe(true);
    expect(db._store.length).toBe(0);
  });
});
