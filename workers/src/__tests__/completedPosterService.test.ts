import { describe, expect, it } from 'vitest';
import {
  formatOrdinalDate,
  formatOrdinalSuperscript,
  mapAndCleanTaskCategoryAndTitle,
  partitionCompletedTasks,
  sizeToNumeric,
} from '../services/completedPosterService';

describe('completedPosterService', () => {
  describe('formatOrdinalDate and formatOrdinalSuperscript', () => {
    it('formats ordinal dates correctly with 11th, 12th, 13th edge cases handled', () => {
      // 11th, 12th, 13th
      expect(formatOrdinalDate(new Date('2025-11-11T12:00:00Z'))).toBe("11th Nov '25");
      expect(formatOrdinalDate(new Date('2025-11-12T12:00:00Z'))).toBe("12th Nov '25");
      expect(formatOrdinalDate(new Date('2025-11-13T12:00:00Z'))).toBe("13th Nov '25");

      // 1st, 2nd, 3rd, 4th
      expect(formatOrdinalDate(new Date('2026-09-01T12:00:00Z'))).toBe("1st Sep '26");
      expect(formatOrdinalDate(new Date('2026-09-02T12:00:00Z'))).toBe("2nd Sep '26");
      expect(formatOrdinalDate(new Date('2026-09-03T12:00:00Z'))).toBe("3rd Sep '26");
      expect(formatOrdinalDate(new Date('2026-09-04T12:00:00Z'))).toBe("4th Sep '26");

      // 21st, 22nd, 23rd, 31st
      expect(formatOrdinalDate(new Date('2026-01-21T12:00:00Z'))).toBe("21st Jan '26");
      expect(formatOrdinalDate(new Date('2026-01-22T12:00:00Z'))).toBe("22nd Jan '26");
      expect(formatOrdinalDate(new Date('2026-01-23T12:00:00Z'))).toBe("23rd Jan '26");
      expect(formatOrdinalDate(new Date('2026-01-31T12:00:00Z'))).toBe("31st Jan '26");
    });

    it('formats ordinal superscript tags correctly for SVG text rendering', () => {
      const formatted = formatOrdinalSuperscript(new Date('2025-11-13T12:00:00Z'));
      expect(formatted).toEqual({
        day: '13',
        suffix: 'th',
        monthYear: "Nov '25",
        html: '13<sup>th</sup> Nov',
        fullText: "13th Nov '25",
      });

      const sepFormatted = formatOrdinalSuperscript(new Date('2026-09-02T12:00:00Z'));
      expect(sepFormatted).toEqual({
        day: '2',
        suffix: 'nd',
        monthYear: "Sep '26",
        html: '2<sup>nd</sup> Sep',
        fullText: "2nd Sep '26",
      });
    });
  });

  describe('mapAndCleanTaskCategoryAndTitle', () => {
    it('strips legacy prefixes and normalizes categories', () => {
      expect(
        mapAndCleanTaskCategoryAndTitle({ project: 'Solfit: Update tracker', category: null })
      ).toEqual({
        title: 'Update tracker',
        category: 'Solfit',
      });

      expect(
        mapAndCleanTaskCategoryAndTitle({ project: 'Crew: Tackle inspection', category: null })
      ).toEqual({
        title: 'Tackle inspection',
        category: 'Caving Crew',
      });

      expect(
        mapAndCleanTaskCategoryAndTitle({ project: 'MD: Fix DNS routing', category: null })
      ).toEqual({
        title: 'Fix DNS routing',
        category: 'Migrating Dragons',
      });

      expect(
        mapAndCleanTaskCategoryAndTitle({ project: 'Personal: Dentist booking', category: null })
      ).toEqual({
        title: 'Dentist booking',
        category: 'Personal',
      });

      expect(
        mapAndCleanTaskCategoryAndTitle({
          project: 'Already Cleaned Task',
          category: 'Caving Crew',
        })
      ).toEqual({
        title: 'Already Cleaned Task',
        category: 'Caving Crew',
      });

      // Normalizes "Crew" to "Caving Crew"
      expect(
        mapAndCleanTaskCategoryAndTitle({
          project: 'Check lights',
          category: 'Crew',
        })
      ).toEqual({
        title: 'Check lights',
        category: 'Caving Crew',
      });
    });
  });

  describe('sizeToNumeric', () => {
    it('converts star sizes to numeric 1-5 correctly', () => {
      expect(sizeToNumeric('*')).toBe(1);
      expect(sizeToNumeric('**')).toBe(2);
      expect(sizeToNumeric('***')).toBe(3);
      expect(sizeToNumeric('****')).toBe(4);
      expect(sizeToNumeric('*****')).toBe(5);
      expect(sizeToNumeric(null as any)).toBe(3);
      expect(sizeToNumeric(undefined as any)).toBe(3);
    });
  });

  describe('partitionCompletedTasks', () => {
    it('partitions tasks into 3 tiers with 4 lanes each, ascending chronological order', () => {
      const mockTasks = Array.from({ length: 120 }, (_, i) => ({
        id: `task-${i}`,
        project: `Task ${i}`,
        reason: i % 2 === 0 ? `Reason ${i}` : null,
        category: i % 4 === 3 ? 'Caving Crew' : 'Personal',
        status: 'done' as const,
        size: '***' as const,
        statusLastChangedOn: new Date(2025, 0, i + 1).toISOString(),
        epicId: i % 10 === 0 ? 'epic-1' : null,
        goalId: i % 15 === 0 ? 'goal-1' : null,
      }));

      const mockEpics = {
        'epic-1': { id: 'epic-1', title: 'GET ACME SOLAR LIVE' },
      };
      const mockGoals = {
        'goal-1': { id: 'goal-1', title: 'Build something big and lucrative', icon: '🚀' },
      };

      const partitioned = partitionCompletedTasks(
        mockTasks as any,
        mockEpics as any,
        mockGoals as any
      );

      expect(partitioned.totalCount).toBe(120);
      expect(partitioned.tiers).toHaveLength(3);

      for (const tier of partitioned.tiers) {
        expect(tier.columns).toHaveLength(4);
      }

      // Column 4 should only have Work/Ventures/Caving Crew items
      for (const tier of partitioned.tiers) {
        for (const item of tier.columns[3]) {
          expect(['Solfit', 'Migrating Dragons', 'Xebit', 'Mavala', 'Caving Crew']).toContain(
            item.category
          );
        }
      }

      // Columns 0, 1, 2 should only have Personal tasks
      for (const tier of partitioned.tiers) {
        for (let colIdx = 0; colIdx < 3; colIdx++) {
          for (const item of tier.columns[colIdx]) {
            expect(item.category).toBe('Personal');
          }
        }
      }

      // Linked epics and goals should be resolved
      const itemWithEpic = partitioned.tiers[0].columns[0].find((it) => it.id === 'task-0');
      expect(itemWithEpic?.epicTitle).toBe('GET ACME SOLAR LIVE');
      expect(itemWithEpic?.goalTitle).toBe('Build something big and lucrative');
      expect(itemWithEpic?.goalIcon).toBe('🚀');
    });

    it('orders Column 4 work tasks by specified category priority', () => {
      const mockTasks = [
        {
          id: 'task-caving',
          project: 'Rig cave',
          category: 'Caving Crew',
          status: 'done' as const,
          size: '**' as const,
          statusLastChangedOn: '2025-01-01T00:00:00Z',
        },
        {
          id: 'task-solfit',
          project: 'Solfit onboarding',
          category: 'Solfit',
          status: 'done' as const,
          size: '***' as const,
          statusLastChangedOn: '2025-01-02T00:00:00Z',
        },
        {
          id: 'task-md',
          project: 'Migrating dragons cloud',
          category: 'Migrating Dragons',
          status: 'done' as const,
          size: '*' as const,
          statusLastChangedOn: '2025-01-03T00:00:00Z',
        },
      ];

      const partitioned = partitionCompletedTasks(mockTasks as any, {}, {});
      // In Col 4 across tiers, overall order should be Solfit, Migrating Dragons, Caving Crew
      const col4ItemsAllTiers = partitioned.tiers.flatMap((t) => t.columns[3]);
      expect(col4ItemsAllTiers.map((it) => it.id)).toEqual([
        'task-solfit',
        'task-md',
        'task-caving',
      ]);
    });

    it('filters completed tasks by selected categories', () => {
      const mockTasks = [
        {
          id: 'task-solfit',
          project: 'Solfit onboarding',
          category: 'Solfit',
          status: 'done' as const,
          size: '***' as const,
          statusLastChangedOn: '2025-01-01T00:00:00Z',
        },
        {
          id: 'task-personal',
          project: 'Dentist appointment',
          category: 'Personal',
          status: 'done' as const,
          size: '*' as const,
          statusLastChangedOn: '2025-01-02T00:00:00Z',
        },
        {
          id: 'task-md',
          project: 'Cloud migration',
          category: 'Migrating Dragons',
          status: 'done' as const,
          size: '**' as const,
          statusLastChangedOn: '2025-01-03T00:00:00Z',
        },
      ];

      const partitioned = partitionCompletedTasks(mockTasks as any, {}, {}, ['Solfit']);
      expect(partitioned.totalCount).toBe(1);
      const allItems = partitioned.tiers.flatMap((t) => t.columns.flat());
      expect(allItems).toHaveLength(1);
      expect(allItems[0].id).toBe('task-solfit');
      expect(allItems[0].category).toBe('Solfit');

      // Filtering with "Crew" should match "Caving Crew" tasks
      const cavingTasks = [
        {
          id: 'task-caving-1',
          project: 'Rig cave',
          category: 'Crew',
          status: 'done' as const,
          size: '**' as const,
          statusLastChangedOn: '2025-01-01T00:00:00Z',
        },
      ];
      const crewPartitioned = partitionCompletedTasks(cavingTasks as any, {}, {}, ['Crew']);
      expect(crewPartitioned.totalCount).toBe(1);
      const crewItems = crewPartitioned.tiers.flatMap((t) => t.columns.flat());
      expect(crewItems).toHaveLength(1);
      expect(crewItems[0].category).toBe('Caving Crew');
    });
  });

  describe('which tasks count as work', () => {
    const done = (id: string, category: string, isShared?: boolean) => ({
      id,
      project: `${id} task`,
      category,
      status: 'done' as const,
      size: '*' as const,
      statusLastChangedOn: '2025-03-01T00:00:00Z',
      ...(isShared === undefined ? {} : { isShared }),
    });
    const workColumn = (data: ReturnType<typeof partitionCompletedTasks>) =>
      data.tiers.flatMap((t) => t.columns[3]).map((i) => i.id);
    const personalColumns = (data: ReturnType<typeof partitionCompletedTasks>) =>
      data.tiers.flatMap((t) => t.columns.slice(0, 3).flat()).map((i) => i.id);

    it('uses the listed projects, in their order, when the instance gives a list', () => {
      const data = partitionCompletedTasks(
        [done('a', 'Support'), done('b', 'Personal'), done('c', 'Fixes'), done('d', 'Solfit')],
        {},
        {},
        undefined,
        'all',
        { workProjects: ['Fixes', 'Support'] }
      );
      expect(workColumn(data)).toEqual(['c', 'a']);
      expect(personalColumns(data).sort()).toEqual(['b', 'd']);
    });

    it("uses each task's workspace when there is no list", () => {
      const data = partitionCompletedTasks(
        [done('a', 'Anything', true), done('b', 'Solfit', false), done('c', 'Personal', false)],
        {},
        {},
        undefined,
        'all'
      );
      expect(workColumn(data)).toEqual(['a']);
      expect(personalColumns(data).sort()).toEqual(['b', 'c']);
    });

    it('falls back to the original project names when it knows neither', () => {
      const data = partitionCompletedTasks([done('a', 'Solfit'), done('b', 'Personal')], {}, {});
      expect(workColumn(data)).toEqual(['a']);
      expect(personalColumns(data)).toEqual(['b']);
    });
  });
});
