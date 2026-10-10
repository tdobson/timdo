import { describe, expect, it } from 'vitest';
import type { CompletedPosterData, CompletedPosterItem } from '../services/completedPosterService';
import {
  generateSignalMicroBarsSvg,
  generateTiledA4Svgs,
  generateWallOfDoneSvg,
  MASTER_BANNER_HEIGHT,
  MASTER_BANNER_VIEWBOX,
  MASTER_BANNER_WIDTH,
} from '../services/wallOfDoneSvgService';

function makeCompletedItem(
  id: string,
  category: string,
  overrides: Partial<CompletedPosterItem> = {}
): CompletedPosterItem {
  return {
    id,
    title: `Task ${id}`,
    reason: 'A brief reason',
    category,
    size: 3,
    completedAt: '2026-10-01T12:00:00Z',
    dateFormatted: "1st Oct '26",
    dateDay: '1',
    dateSuffix: 'st',
    dateMonthYear: "Oct '26",
    dateHtml: '1<sup>st</sup> Oct',
    ...overrides,
  };
}

function makePosterData(columnsByTier: CompletedPosterItem[][][]): CompletedPosterData {
  const totalCount = columnsByTier.reduce(
    (tierCount, columns) =>
      tierCount + columns.reduce((columnCount, items) => columnCount + items.length, 0),
    0
  );

  return {
    totalCount,
    generatedAt: '2026-10-10T12:00:00Z',
    tiers: columnsByTier.map((columns, tierIndex) => ({ tierIndex, columns })),
  };
}

function extractGroups(svg: string, openingTagPattern: RegExp): string[] {
  const groups: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = openingTagPattern.exec(svg)) !== null) {
    let depth = 1;
    let cursor = openingTagPattern.lastIndex;

    while (depth > 0) {
      const nextOpen = svg.indexOf('<g', cursor);
      const nextClose = svg.indexOf('</g>', cursor);
      if (nextClose === -1) {
        break;
      }
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        cursor = nextOpen + 2;
      } else {
        depth -= 1;
        cursor = nextClose + 4;
      }
    }

    groups.push(svg.slice(match.index, cursor));
    openingTagPattern.lastIndex = cursor;
  }

  return groups;
}

describe('wallOfDoneSvgService', () => {
  const mockPosterData: CompletedPosterData = {
    totalCount: 4,
    generatedAt: '2026-09-14T10:00:00Z',
    tiers: [
      {
        tierIndex: 0,
        columns: [
          [
            {
              id: '1',
              title: 'Family trip booking & coordination',
              reason: 'Keep kids active',
              category: 'Personal',
              size: 3,
              completedAt: '2025-11-13T12:00:00Z',
              dateFormatted: "13th Nov '25",
              dateDay: '13',
              dateSuffix: 'th',
              dateMonthYear: "Nov '25",
              dateHtml: '13<sup>th</sup> Nov',
              epicTitle: 'FAMILY HOLIDAYS',
              goalTitle: 'Be great to family',
              goalIcon: '👨‍👩‍👦',
            },
          ],
          [],
          [],
          [
            {
              id: '2',
              title: 'Tackle bag overhaul',
              category: 'Northstar Workshop',
              size: 4,
              completedAt: '2025-11-14T12:00:00Z',
              dateFormatted: "14th Nov '25",
              dateDay: '14',
              dateSuffix: 'th',
              dateMonthYear: "Nov '25",
              dateHtml: '14<sup>th</sup> Nov',
            },
          ],
        ],
      },
      {
        tierIndex: 1,
        columns: [
          [
            {
              id: '3',
              title: 'Dentist follow up',
              category: 'Personal',
              size: 2,
              completedAt: '2026-03-01T12:00:00Z',
              dateFormatted: "1st Mar '26",
              dateDay: '1',
              dateSuffix: 'st',
              dateMonthYear: "Mar '26",
              dateHtml: '1<sup>st</sup> Mar',
            },
          ],
          [],
          [],
          [
            {
              id: '4',
              title: 'Workshop records review',
              category: 'Atlas Mapping',
              size: 1,
              completedAt: '2026-03-02T12:00:00Z',
              dateFormatted: "2nd Mar '26",
              dateDay: '2',
              dateSuffix: 'nd',
              dateMonthYear: "Mar '26",
              dateHtml: '2<sup>nd</sup> Mar',
            },
          ],
        ],
      },
      {
        tierIndex: 2,
        columns: [[], [], [], []],
      },
    ],
  };

  describe('generateSignalMicroBarsSvg', () => {
    it('generates solid black filled micro-bars corresponding to size 1 to 5', () => {
      // Size 1 -> 1 bar
      const bar1 = generateSignalMicroBarsSvg(10, 20, 1);
      const rectCount1 = (bar1.match(/<rect/g) || []).length;
      expect(rectCount1).toBe(1);
      expect(bar1).toContain('fill="#000000"');
      expect(bar1).toContain('rx="0.5"');

      // Size 3 -> 3 bars
      const bar3 = generateSignalMicroBarsSvg(10, 20, 3);
      const rectCount3 = (bar3.match(/<rect/g) || []).length;
      expect(rectCount3).toBe(3);

      // Size 5 -> 5 bars
      const bar5 = generateSignalMicroBarsSvg(10, 20, 5);
      const rectCount5 = (bar5.match(/<rect/g) || []).length;
      expect(rectCount5).toBe(5);
    });
  });

  describe('generateWallOfDoneSvg', () => {
    it('generates valid full-banner monochrome vector SVG with exact dimensions and viewbox', () => {
      const svg = generateWallOfDoneSvg(mockPosterData);

      expect(svg).toContain('<svg');
      expect(svg).toContain(`viewBox="${MASTER_BANNER_VIEWBOX}"`);
      expect(svg).toContain(`width="${MASTER_BANNER_WIDTH}"`);
      expect(svg).toContain(`height="${MASTER_BANNER_HEIGHT}"`);
      expect(svg).toContain('Family trip booking');
      expect(svg).toContain('FAMILY HOLIDAYS');
      expect(svg).toContain('Tackle bag overhaul');
      expect(svg).toContain('OTHER WORKSPACES (CONT.)');
      expect(svg).toContain('PERSONAL WORKSPACE');
      expect(svg).toContain('OTHER WORKSPACES');
      expect(svg).not.toContain('PRIVATE');
      expect(svg).not.toContain('SHARED');
      expect(svg).toContain('</svg>');
    });

    it('escapes XML special characters in titles, reasons and tags', () => {
      const dangerousData: CompletedPosterData = {
        totalCount: 1,
        generatedAt: '2026-09-14T10:00:00Z',
        tiers: [
          {
            tierIndex: 0,
            columns: [
              [
                {
                  id: 'xss',
                  title: 'Task <script>alert("hack")</script> & "quotes"',
                  reason: 'Reason with <evil> & tags',
                  category: 'Personal',
                  size: 5,
                  completedAt: '2025-11-13T12:00:00Z',
                  dateFormatted: "13th Nov '25",
                  dateDay: '13',
                  dateSuffix: 'th',
                  dateMonthYear: "Nov '25",
                  dateHtml: '13<sup>th</sup> Nov',
                  epicTitle: 'EPIC <A>',
                  goalTitle: 'GOAL <B>',
                  goalIcon: '⚠️',
                },
              ],
              [],
              [],
              [],
            ],
          },
          { tierIndex: 1, columns: [[], [], [], []] },
          { tierIndex: 2, columns: [[], [], [], []] },
        ],
      };

      const svg = generateWallOfDoneSvg(dangerousData);
      expect(svg).not.toContain('<script>');
      expect(svg).toContain('&lt;script&gt;');
      expect(svg).toContain('EPIC &lt;A&gt;');
      expect(svg).toContain('GOAL &lt;B&gt;');
    });

    it('uses neutral continuation headers when other-workspace categories change or a tier is empty', () => {
      const svg = generateWallOfDoneSvg(mockPosterData);
      expect(svg).toContain('PERSONAL WORKSPACE (CONT.)');
      expect((svg.match(/OTHER WORKSPACES \(CONT\.\)/g) || [])).toHaveLength(2);
      expect(svg).not.toContain('NORTHSTAR WORKSHOP (CONT.)');
      expect(svg).not.toContain('ATLAS MAPPING (CONT.)');
    });

    it('keeps the complete task data and reports per-column overflow within each fixed tier', () => {
      const columnsByTier: CompletedPosterItem[][][] = [];
      for (let tierIndex = 0; tierIndex < 3; tierIndex++) {
        const items = Array.from({ length: 30 }, (_, itemIndex) =>
          makeCompletedItem(`workspace-${tierIndex}-${itemIndex + 1}`, 'Birch Workshop', {
            title: `Report ${String(itemIndex + 1).padStart(2, '0')}`,
            reason: 'Keep the project moving',
          })
        );
        columnsByTier.push([[], [], [], items]);
      }

      const data = makePosterData(columnsByTier);
      const originalData = JSON.stringify(data);
      const sourceIds = data.tiers.flatMap((tier) =>
        tier.columns.flatMap((column) => column.map((item) => item.id))
      );
      const svg = generateWallOfDoneSvg(data);
      const taskGroups = extractGroups(
        svg,
        /<g data-task-id="[^"]+" data-tier-index="\d+">/g
      );

      expect(taskGroups).toHaveLength(63);
      expect(
        [0, 1, 2].map(
          (tierIndex) =>
            taskGroups.filter((group) => group.includes(`data-tier-index="${tierIndex}"`)).length
        )
      ).toEqual([21, 21, 21]);

      const visibleIds = taskGroups.map((group) => group.match(/data-task-id="([^"]+)"/)?.[1]);
      expect(new Set(visibleIds).size).toBe(63);
      expect(sourceIds).toHaveLength(90);
      expect(data.totalCount).toBe(90);
      expect(JSON.stringify(data)).toBe(originalData);

      const notices = [...svg.matchAll(
        /<g data-overflow-notice="true" data-tier-index="(\d+)" data-column-index="3" data-shown-count="(\d+)" data-omitted-count="(\d+)">/g
      )].map((match) => [match[1], match[2], match[3]]);
      expect(notices).toEqual([
        ['0', '21', '9'],
        ['1', '21', '9'],
        ['2', '21', '9'],
      ]);
      expect(svg).toContain('Showing 21 of 30 tasks (9 omitted)');
      expect(svg).toContain('See Done in TimDo for the full list.');

      for (const group of taskGroups) {
        const tierIndex = Number(group.match(/data-tier-index="(\d+)"/)?.[1]);
        const separatorY = Number(group.match(/<line\b[^>]*y1="([\d.]+)"/)?.[1]);
        const tierContentBottom = (tierIndex + 1) * (MASTER_BANNER_HEIGHT / 3) - 40;
        expect(separatorY + 8).toBeLessThanOrEqual(tierContentBottom);
      }

      const noticeGroups = extractGroups(
        svg,
        /<g data-overflow-notice="true"[^>]*>/g
      );
      for (const group of noticeGroups) {
        const tierIndex = Number(group.match(/data-tier-index="(\d+)"/)?.[1]);
        const textYValues = [...group.matchAll(/<text\b[^>]*y="([\d.]+)"/g)].map((match) =>
          Number(match[1])
        );
        const tierContentBottom = (tierIndex + 1) * (MASTER_BANNER_HEIGHT / 3) - 40;
        expect(Math.max(...textYValues)).toBeLessThanOrEqual(tierContentBottom);
      }
    });

    it('uses measured heights for multi-line rows with hierarchy badges', () => {
      const rows = Array.from({ length: 17 }, (_, index) =>
        makeCompletedItem(`hierarchy-${index + 1}`, 'Cedar Workshop', {
          title: 'Review the migration plan before the next release',
          reason: null,
          epicTitle: 'DELIVERY PLAN',
          goalTitle: 'Keep services reliable',
        })
      );
      const data = makePosterData([
        [[], [], [], rows],
        [[], [], [], []],
        [[], [], [], []],
      ]);
      const svg = generateWallOfDoneSvg(data);
      const taskGroups = extractGroups(
        svg,
        /<g data-task-id="[^"]+" data-tier-index="\d+">/g
      );

      expect(taskGroups).toHaveLength(15);
      for (const group of taskGroups) {
        expect(group.match(/font-size="14" font-weight="700"/g)).toHaveLength(2);
        expect(group).toContain('DELIVERY PLAN');
        expect(group).toContain('Keep services reliable');
        const separatorY = Number(group.match(/<line\b[^>]*y1="([\d.]+)"/)?.[1]);
        expect(separatorY + 8).toBeLessThanOrEqual(MASTER_BANNER_HEIGHT / 3 - 40);
      }
      expect(svg).toMatch(
        /data-overflow-notice="true" data-tier-index="0" data-column-index="3" data-shown-count="15" data-omitted-count="2"/
      );
    });

    it('does not add an overflow notice when all rows fit', () => {
      const svg = generateWallOfDoneSvg(mockPosterData);

      expect(extractGroups(svg, /<g data-task-id="[^"]+" data-tier-index="\d+">/g)).toHaveLength(
        4
      );
      expect(svg).not.toContain('data-overflow-notice="true"');
      expect(svg).not.toContain('Showing ');
    });

    it('labels continuation only when adjacent rendered rows share a category', () => {
      const data = makePosterData([
        [[], [], [], [makeCompletedItem('previous', 'Birch Cave')]],
        [[], [], [], [makeCompletedItem('current', '  BIRCH CAVE  ')]],
        [[], [], [], []],
      ]);
      const svg = generateWallOfDoneSvg(data);

      expect(svg).toContain('OTHER WORKSPACES: BIRCH CAVE (CONT.)');
      expect(svg).toContain('OTHER WORKSPACES (CONT.)');
    });

    it('uses a neutral continuation when the preceding tier has no visible row', () => {
      const data = makePosterData([
        [[], [], [], []],
        [[], [], [], [makeCompletedItem('current', 'Cedar Workshop')]],
        [[], [], [], []],
      ]);
      const svg = generateWallOfDoneSvg(data);

      expect(svg).toContain('OTHER WORKSPACES (CONT.)');
      expect(svg).not.toContain('OTHER WORKSPACES: CEDAR WORKSHOP (CONT.)');
    });

    it('does not use an overflow-hidden data tail for the continuation category', () => {
      const previousItems = Array.from({ length: 30 }, (_, index) =>
        makeCompletedItem(
          `previous-${index + 1}`,
          index >= 24 ? 'Hidden Tail' : 'Visible Category',
          { title: 'A short task', reason: 'A brief reason' }
        )
      );
      const data = makePosterData([
        [[], [], [], previousItems],
        [[], [], [], [makeCompletedItem('current', 'Hidden Tail')]],
        [[], [], [], []],
      ]);
      const svg = generateWallOfDoneSvg(data);

      expect(svg).toContain('OTHER WORKSPACES (CONT.)');
      expect(svg).not.toContain('OTHER WORKSPACES: HIDDEN TAIL (CONT.)');
      expect(svg).not.toContain('data-task-id="previous-25"');
      expect(svg).toMatch(
        /data-overflow-notice="true" data-tier-index="0" data-column-index="3" data-shown-count="21" data-omitted-count="9"/
      );
    });
  });

  describe('generateTiledA4Svgs', () => {
    it('generates 6 distinct A4 SVG tiles with registration marks and cut guides', () => {
      const tiles = generateTiledA4Svgs(mockPosterData);
      expect(tiles).toHaveLength(6);

      // Tile 1 to 6
      expect(tiles[0].sheetIndex).toBe(1);
      expect(tiles[0].label).toBe('Sheet 1 of 6 (Tier 1 - Left)');
      expect(tiles[0].svg).toContain('+ P1');
      expect(tiles[0].svg).toContain('<svg');

      expect(tiles[5].sheetIndex).toBe(6);
      expect(tiles[5].label).toBe('Sheet 6 of 6 (Tier 3 - Right)');
      expect(tiles[5].svg).toContain('+ P6');
    });
  });
});
