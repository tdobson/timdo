import { describe, expect, it } from 'vitest';
import { generateActiveTasksPosterSvg } from '../services/activePosterService';

describe('activePosterService', () => {
  describe('generateActiveTasksPosterSvg', () => {
    it('renders tasks from custom project categories in the A2 portrait SVG', () => {
      const mockTasks = [
        {
          id: '1',
          project: 'Solar quote',
          reason: 'Review proposal',
          status: 'do',
          size: '***',
          priority: 10,
          category: 'Acme Solar',
        },
        {
          id: '2',
          project: 'App setup',
          reason: 'Prepare the workspace',
          status: 'do',
          size: '***',
          priority: 9,
          category: 'Northstar Workshop',
        },
      ];
      const svg = generateActiveTasksPosterSvg({ tasks: mockTasks as any });
      expect(svg).toContain('DO');
      expect(svg).toContain('Solar quote');
      expect(svg).toContain('Review proposal');
      expect(svg).toContain('viewBox="0 0 420 594"');
    });

    it('filters out done tasks (only includes do, awaiting, delay)', () => {
      const mockTasks = [
        { id: '1', project: 'Active task 1', status: 'do', category: 'Acme Solar' },
        { id: '2', project: 'Done task', status: 'done', category: 'Acme Solar' },
        {
          id: '3',
          project: 'Awaiting task',
          status: 'awaiting',
          awaitUntil: '2026-10-01',
          category: 'Acme Solar',
        },
        { id: '4', project: 'Delayed task', status: 'delay', category: 'Home Planning' },
      ];
      const svg = generateActiveTasksPosterSvg({ tasks: mockTasks as any });
      expect(svg).toContain('Active task 1');
      expect(svg).toContain('Awaiting task');
      expect(svg).toContain('Delayed task');
      expect(svg).not.toContain('Done task');
    });

    it('filters by exact actual category names, ignoring surrounding case and spaces', () => {
      const mockTasks = [
        { id: '1', project: 'Solar quote', status: 'do', category: 'Acme Solar' },
        { id: '2', project: 'Workshop setup', status: 'do', category: 'Northstar Workshop' },
        { id: '3', project: 'Dentist', status: 'do', category: 'Home Planning' },
        { id: '4', project: 'Tackle bag check', status: 'do', category: 'Field Team' },
      ];
      const svg = generateActiveTasksPosterSvg({
        tasks: mockTasks as any,
        categories: ['  field team  '],
      });
      expect(svg).toContain('FIELD TEAM');
      expect(svg).toContain('Tackle bag check');
      expect(svg).not.toContain('Solar quote');
      expect(svg).not.toContain('Workshop setup');
    });

    it('does not treat a partial category name as an alias', () => {
      const svg = generateActiveTasksPosterSvg({
        tasks: [{ id: '1', project: 'Tackle bag check', status: 'do', category: 'Field Team' }],
        categories: ['Field'],
      });
      expect(svg).not.toContain('Tackle bag check');
    });

    it('renders classic layout with DO, AWAITING, and DELAY sections', () => {
      const mockTasks = [
        { id: '1', project: 'Do task', status: 'do', category: 'Acme Solar' },
        {
          id: '2',
          project: 'Wait task',
          status: 'awaiting',
          awaitUntil: '2026-10-15',
          category: 'Acme Solar',
        },
        { id: '3', project: 'Pause task', status: 'delay', category: 'Acme Solar' },
      ];
      const svg = generateActiveTasksPosterSvg({ tasks: mockTasks as any });
      expect(svg).toContain('DO');
      expect(svg).toContain('AWAITING');
      expect(svg).toContain('DELAY');
      expect(svg).toContain('15 Oct');
    });

    it('strips a title prefix only when it matches the actual category', () => {
      const svg = generateActiveTasksPosterSvg({
        tasks: [
          {
            id: '1',
            project: 'Atlas Mapping: Cleaned task name',
            status: 'do',
            size: '****',
            category: 'Atlas Mapping',
          },
          {
            id: '2',
            project: 'Northstar Workshop: Keep this title',
            status: 'do',
            category: 'Atlas Mapping',
          },
          {
            id: '3',
            project: 'Workshop: Keep the unknown prefix',
            status: 'do',
            category: null,
          },
        ],
      });
      expect(svg).toContain('Cleaned task name');
      expect(svg).toContain('Northstar Workshop: Keep this');
      expect(svg).toContain('title</tspan>');
      expect(svg).toContain('Workshop: Keep the unknown prefix');
      expect(svg).not.toContain('Atlas Mapping: Cleaned task name');
    });

    it('escapes XML special characters in task titles and reasons', () => {
      const mockTasks = [
        {
          id: '1',
          project: 'Fix <script> & "bugs"',
          reason: 'Why: a > b & c < d',
          status: 'do',
          category: 'Home Planning',
        },
      ];
      const svg = generateActiveTasksPosterSvg({ tasks: mockTasks as any });
      expect(svg).not.toContain('<script>');
      expect(svg).toContain('&lt;script&gt;');
      expect(svg).toContain('&amp;');
    });

    it.each([undefined, '', '   '])('uses a neutral heading when the name is %j', (user) => {
      const svg = generateActiveTasksPosterSvg({ tasks: [], user });
      expect(svg).toContain('<title>ACTIVE TASKS</title>');
    });

    it('uses an explicitly supplied name in the heading', () => {
      const svg = generateActiveTasksPosterSvg({ tasks: [], user: '  Casey Example  ' });
      expect(svg).toContain('CASEY EXAMPLE');
      expect(svg).toContain('S PROJECTS');
    });

    it('handles empty task list gracefully', () => {
      const svg = generateActiveTasksPosterSvg({ tasks: [] });
      expect(svg).toContain('viewBox="0 0 420 594"');
      expect(svg).toContain('ACTIVE TASKS');
    });
  });
});
