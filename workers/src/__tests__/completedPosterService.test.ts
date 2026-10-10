import { describe, expect, it } from 'vitest';
import {
  formatOrdinalDate,
  formatOrdinalSuperscript,
  getCompletedPosterData,
  mapAndCleanTaskCategoryAndTitle,
  normalizeCategory,
  partitionCompletedTasks,
  sizeToNumeric,
} from '../services/completedPosterService';
import * as organisationService from '../services/organisationService';
import * as projectService from '../services/projectService';
import { createTestDb, seedCollaboration, TIM } from './helpers/testDb';

describe('completedPosterService', () => {
  describe('formatOrdinalDate and formatOrdinalSuperscript', () => {
    it('formats ordinal dates correctly with 11th, 12th, 13th edge cases handled', () => {
      expect(formatOrdinalDate(new Date('2025-11-11T12:00:00Z'))).toBe("11th Nov '25");
      expect(formatOrdinalDate(new Date('2025-11-12T12:00:00Z'))).toBe("12th Nov '25");
      expect(formatOrdinalDate(new Date('2025-11-13T12:00:00Z'))).toBe("13th Nov '25");

      expect(formatOrdinalDate(new Date('2026-09-01T12:00:00Z'))).toBe("1st Sep '26");
      expect(formatOrdinalDate(new Date('2026-09-02T12:00:00Z'))).toBe("2nd Sep '26");
      expect(formatOrdinalDate(new Date('2026-09-03T12:00:00Z'))).toBe("3rd Sep '26");
      expect(formatOrdinalDate(new Date('2026-09-04T12:00:00Z'))).toBe("4th Sep '26");

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
    it('matches actual project categories by trimmed case and strips only matching prefixes', () => {
      expect(
        mapAndCleanTaskCategoryAndTitle({
          project: '  atlas workshop : Review the plan',
          category: ' Atlas Workshop ',
        })
      ).toEqual({ title: 'Review the plan', category: 'Atlas Workshop' });

      expect(
        mapAndCleanTaskCategoryAndTitle({
          project: 'Another project: Keep this title',
          category: 'Atlas Workshop',
        })
      ).toEqual({ title: 'Another project: Keep this title', category: 'Atlas Workshop' });
    });

    it('preserves arbitrary colon titles and does not infer an unknown category', () => {
      expect(
        mapAndCleanTaskCategoryAndTitle({
          project: 'Workshop: Plan the visit',
          category: null,
        })
      ).toEqual({ title: 'Workshop: Plan the visit', category: 'Personal' });

      expect(normalizeCategory('  Field Team  ')).toBe('Field Team');
      expect(normalizeCategory('Field')).toBe('Field');
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
    it('partitions tasks into 3 tiers with 4 lanes each, in chronological order', () => {
      const mockTasks = Array.from({ length: 120 }, (_, i) => ({
        id: `task-${i}`,
        project: `Task ${i}`,
        reason: i % 2 === 0 ? `Reason ${i}` : null,
        category: i % 4 === 3 ? 'Northstar Workshop' : 'Home',
        orgId: i % 4 === 3 ? 'org-other' : 'org-personal',
        status: 'done' as const,
        size: '***' as const,
        statusLastChangedOn: new Date(2025, 0, i + 1).toISOString(),
        epicId: i % 10 === 0 ? 'epic-1' : null,
        goalId: i % 15 === 0 ? 'goal-1' : null,
      }));

      const mockEpics = {
        'epic-1': { id: 'epic-1', title: 'BUILD A BETTER WORKSHOP' },
      };
      const mockGoals = {
        'goal-1': { id: 'goal-1', title: 'Build something useful', icon: '★' },
      };
      const organisations = [
        { id: 'org-personal', isPersonal: true },
        { id: 'org-other', isPersonal: false },
      ];

      const partitioned = partitionCompletedTasks(
        mockTasks as any,
        mockEpics as any,
        mockGoals as any,
        undefined,
        'all',
        organisations
      );

      expect(partitioned.totalCount).toBe(120);
      expect(partitioned.tiers).toHaveLength(3);
      for (const tier of partitioned.tiers) {
        expect(tier.columns).toHaveLength(4);
      }

      const idsByColumn = partitioned.tiers.map((tier) =>
        tier.columns.map((column) => column.map((item) => Number(item.id.slice(5))))
      );
      for (const tier of idsByColumn) {
        for (const i of tier[3]) {
          expect(i % 4).toBe(3);
        }
        for (let colIdx = 0; colIdx < 3; colIdx++) {
          for (const i of tier[colIdx]) {
            expect(i % 4).not.toBe(3);
          }
        }
      }

      const itemWithEpic = partitioned.tiers[0].columns[0].find((it) => it.id === 'task-0');
      expect(itemWithEpic?.epicTitle).toBe('BUILD A BETTER WORKSHOP');
      expect(itemWithEpic?.goalTitle).toBe('Build something useful');
      expect(itemWithEpic?.goalIcon).toBe('★');
    });

    it('groups by personal metadata even when a non-personal workspace has one member', () => {
      const tasks = [
        {
          id: 'personal-custom-category',
          project: 'Plan a trip',
          category: 'Home Planning',
          orgId: 'org-personal',
          size: '*',
          statusLastChangedOn: '2025-01-01T00:00:00Z',
        },
        {
          id: 'personal-project-called-personal',
          project: 'Review the plan',
          category: 'Personal',
          orgId: 'org-personal',
          size: '*',
          statusLastChangedOn: '2025-01-02T00:00:00Z',
        },
        {
          id: 'shared-workspace-task',
          project: 'Prepare a launch',
          category: 'Acme Solar',
          orgId: 'org-shared',
          size: '*',
          statusLastChangedOn: '2025-01-03T00:00:00Z',
        },
        {
          id: 'single-member-other-workspace-task',
          project: 'Review records',
          category: 'Personal',
          orgId: 'org-single-member',
          size: '*',
          statusLastChangedOn: '2025-01-04T00:00:00Z',
        },
      ];
      const organisations = [
        { id: 'org-personal', isPersonal: true, memberCount: 1 },
        { id: 'org-shared', isPersonal: false, memberCount: 2 },
        { id: 'org-single-member', isPersonal: false, memberCount: 1 },
      ];

      const partitioned = partitionCompletedTasks(
        tasks as any,
        {},
        {},
        undefined,
        'all',
        organisations
      );
      const personalColumnIds = partitioned.tiers.flatMap((tier) =>
        tier.columns.slice(0, 3).flatMap((column) => column.map((item) => item.id))
      );
      const otherWorkspaceIds = partitioned.tiers.flatMap((tier) =>
        tier.columns[3].map((item) => item.id)
      );

      expect(personalColumnIds.sort()).toEqual([
        'personal-custom-category',
        'personal-project-called-personal',
      ]);
      expect(otherWorkspaceIds.sort()).toEqual([
        'shared-workspace-task',
        'single-member-other-workspace-task',
      ]);
    });

    it('orders other workspace tasks by actual category, then completion date', () => {
      const tasks = [
        {
          id: 'northstar',
          project: 'Workshop maintenance',
          category: 'Northstar Workshop',
          orgId: 'org-other',
          size: '**',
          statusLastChangedOn: '2025-01-01T00:00:00Z',
        },
        {
          id: 'acme',
          project: 'Solar review',
          category: 'Acme Solar',
          orgId: 'org-other',
          size: '***',
          statusLastChangedOn: '2025-01-03T00:00:00Z',
        },
        {
          id: 'atlas',
          project: 'Map update',
          category: 'Atlas Mapping',
          orgId: 'org-other',
          size: '*',
          statusLastChangedOn: '2025-01-02T00:00:00Z',
        },
      ];
      const partitioned = partitionCompletedTasks(
        tasks as any,
        {},
        {},
        undefined,
        'all',
        [{ id: 'org-other', isPersonal: false }]
      );

      expect(partitioned.tiers.flatMap((tier) => tier.columns[3].map((item) => item.id))).toEqual([
        'acme',
        'atlas',
        'northstar',
      ]);
    });

    it('filters completed tasks by actual category names, ignoring surrounding case and spaces', () => {
      const tasks = [
        {
          id: 'acme',
          project: 'Prepare launch',
          category: 'Acme Solar',
          size: '***',
          statusLastChangedOn: '2025-01-01T00:00:00Z',
        },
        {
          id: 'personal',
          project: 'Book an appointment',
          category: 'Home',
          size: '*',
          statusLastChangedOn: '2025-01-02T00:00:00Z',
        },
        {
          id: 'northstar',
          project: 'Review workshop',
          category: 'Northstar Workshop',
          size: '**',
          statusLastChangedOn: '2025-01-03T00:00:00Z',
        },
      ];
      const partitioned = partitionCompletedTasks(tasks as any, {}, {}, ['  aCMe solar  '], 'all');
      const allItems = partitioned.tiers.flatMap((tier) => tier.columns.flat());

      expect(partitioned.totalCount).toBe(1);
      expect(allItems.map((item) => item.id)).toEqual(['acme']);
      expect(allItems[0].category).toBe('Acme Solar');
    });

    it('uses a neutral personal grouping when pure helper inputs have no workspace metadata', () => {
      const partitioned = partitionCompletedTasks(
        [
          {
            id: 'metadata-missing',
            project: 'Colon: stays in title',
            category: 'Custom Project',
            size: '*',
            statusLastChangedOn: '2025-01-01T00:00:00Z',
          },
        ] as any,
        {},
        {},
        undefined,
        'all'
      );

      expect(partitioned.tiers.flatMap((tier) => tier.columns[3])).toEqual([]);
    });
  });

  describe('getCompletedPosterData', () => {
    it('passes scoped workspace metadata into poster grouping at runtime', async () => {
      const { db, raw } = createTestDb();
      seedCollaboration(raw);
      const oneMemberOrganisation = await organisationService.createOrganisation(
        db,
        TIM,
        'One Member Workshop'
      );
      await organisationService.addProject(db, TIM, oneMemberOrganisation.id, 'Custom Project');

      const tasks = [
        { id: '00000000-0000-4000-8000-000000000101', project: 'Personal task', category: 'Personal' },
        { id: '00000000-0000-4000-8000-000000000102', project: 'Shared task', category: 'Acme Solar' },
        { id: '00000000-0000-4000-8000-000000000103', project: 'One member task', category: 'Custom Project' },
      ];
      for (const task of tasks) {
        await projectService.createProject(db, TIM, {
          ...task,
          status: 'done',
          priority: 5,
          size: '***',
        });
      }

      const poster = await getCompletedPosterData(db, TIM, undefined, 'all');
      const personalIds = poster.tiers.flatMap((tier) =>
        tier.columns.slice(0, 3).flatMap((column) => column.map((item) => item.id))
      );
      const otherWorkspaceIds = poster.tiers.flatMap((tier) =>
        tier.columns[3].map((item) => item.id)
      );

      expect(personalIds).toEqual(['00000000-0000-4000-8000-000000000101']);
      expect(otherWorkspaceIds.sort()).toEqual([
        '00000000-0000-4000-8000-000000000102',
        '00000000-0000-4000-8000-000000000103',
      ]);
    });
  });
});
