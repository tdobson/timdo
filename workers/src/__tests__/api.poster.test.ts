import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import posterApp from '../routes/poster';
import * as activePosterService from '../services/activePosterService';
import * as completedPosterService from '../services/completedPosterService';
import * as projectService from '../services/projectService';
import * as wallOfDoneSvgService from '../services/wallOfDoneSvgService';

vi.mock('../services/activePosterService');
vi.mock('../services/completedPosterService');
vi.mock('../services/projectService');
vi.mock('../services/wallOfDoneSvgService');

describe('Poster API Routes (/api/v2/poster)', () => {
  let app: Hono<any>;

  const mockPosterData = {
    totalCount: 42,
    tiers: [],
    generatedAt: '2026-09-14T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    // Simulate auth & db middleware
    app.use('*', async (c, next) => {
      c.set('userId', 'test-user-id');
      c.set('db', {} as any);
      await next();
    });
    app.route('/api/v2/poster', posterApp);
  });

  describe('GET /api/v2/poster/wall-of-done', () => {
    it('returns raw SVG by default with image/svg+xml header', async () => {
      const mockSvg = '<svg viewBox="0 0 1587 3368"><text>Wall of Done</text></svg>';
      vi.mocked(completedPosterService.getCompletedPosterData).mockResolvedValueOnce(
        mockPosterData as any
      );
      vi.mocked(wallOfDoneSvgService.generateWallOfDoneSvg).mockReturnValueOnce(mockSvg);

      const res = await app.request('/api/v2/poster/wall-of-done');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('image/svg+xml');
      const text = await res.text();
      expect(text).toBe(mockSvg);
      expect(completedPosterService.getCompletedPosterData).toHaveBeenCalledWith(
        expect.anything(),
        'test-user-id',
        undefined,
        '6m',
        { workProjects: null }
      );
      expect(wallOfDoneSvgService.generateWallOfDoneSvg).toHaveBeenCalledWith(mockPosterData);
    });

    it('parses categories query parameter and passes to getCompletedPosterData', async () => {
      const mockSvg = '<svg viewBox="0 0 1587 3368"><text>Wall of Done</text></svg>';
      vi.mocked(completedPosterService.getCompletedPosterData).mockResolvedValueOnce(
        mockPosterData as any
      );
      vi.mocked(wallOfDoneSvgService.generateWallOfDoneSvg).mockReturnValueOnce(mockSvg);

      const res = await app.request('/api/v2/poster/wall-of-done?categories=Solfit,Crew');
      expect(res.status).toBe(200);
      expect(completedPosterService.getCompletedPosterData).toHaveBeenCalledWith(
        expect.anything(),
        'test-user-id',
        ['Solfit', 'Crew'],
        '6m',
        { workProjects: null }
      );
    });

    it('returns JSON with structured data and SVG when ?format=json', async () => {
      const mockSvg = '<svg>Wall of Done</svg>';
      vi.mocked(completedPosterService.getCompletedPosterData).mockResolvedValueOnce(
        mockPosterData as any
      );
      vi.mocked(wallOfDoneSvgService.generateWallOfDoneSvg).mockReturnValueOnce(mockSvg);

      const res = await app.request('/api/v2/poster/wall-of-done?format=json');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      const json = await res.json();
      expect(json).toEqual({
        data: mockPosterData,
        svg: mockSvg,
      });
    });

    it('returns 6 tiled A4 SVGs when ?tiled=true', async () => {
      const mockTiles = [
        { sheetIndex: 1, label: 'Sheet 1', tier: 1, colOffset: 0, svg: '<svg>Tile 1</svg>' },
        { sheetIndex: 2, label: 'Sheet 2', tier: 1, colOffset: 1, svg: '<svg>Tile 2</svg>' },
      ];
      vi.mocked(completedPosterService.getCompletedPosterData).mockResolvedValueOnce(
        mockPosterData as any
      );
      vi.mocked(wallOfDoneSvgService.generateTiledA4Svgs).mockReturnValueOnce(mockTiles as any);

      const res = await app.request('/api/v2/poster/wall-of-done?tiled=true');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      const json = await res.json();
      expect(json).toEqual({
        totalCount: 42,
        generatedAt: '2026-09-14T00:00:00.000Z',
        tiles: mockTiles,
      });
      expect(wallOfDoneSvgService.generateTiledA4Svgs).toHaveBeenCalledWith(mockPosterData);
    });
  });

  describe('GET /api/v2/poster/active', () => {
    const mockTasks = [
      { id: '1', project: 'Solar quote', reason: 'Review', status: 'do', category: 'Solfit' },
      { id: '2', project: 'Done item', status: 'done', category: 'Solfit' },
    ];
    const mockSvg = '<svg viewBox="0 0 420 594"><text>TimDo • Active Tasks</text></svg>';

    it('returns raw SVG by default with image/svg+xml header', async () => {
      vi.mocked(projectService.getProjectsForUser).mockResolvedValueOnce(mockTasks as any);
      vi.mocked(activePosterService.generateActiveTasksPosterSvg).mockReturnValueOnce(mockSvg);

      const res = await app.request('/api/v2/poster/active');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('image/svg+xml');
      const text = await res.text();
      expect(text).toBe(mockSvg);
      // The active poster is personal: only the caller's own tasks, across every workspace
      expect(projectService.getProjectsForUser).toHaveBeenCalledWith(
        expect.anything(),
        'test-user-id',
        { assignee: 'me' }
      );
      expect(activePosterService.generateActiveTasksPosterSvg).toHaveBeenCalledWith({
        tasks: mockTasks,
        categories: undefined,
      });
    });

    it('parses categories query parameter and passes to generator', async () => {
      vi.mocked(projectService.getProjectsForUser).mockResolvedValueOnce(mockTasks as any);
      vi.mocked(activePosterService.generateActiveTasksPosterSvg).mockReturnValueOnce(mockSvg);

      const res = await app.request('/api/v2/poster/active?categories=Solfit,Crew');
      expect(res.status).toBe(200);
      expect(activePosterService.generateActiveTasksPosterSvg).toHaveBeenCalledWith({
        tasks: mockTasks,
        categories: ['Solfit', 'Crew'],
      });
    });

    it('returns tiled A4 sheets counting only unfinished tasks when ?tiled=true', async () => {
      vi.mocked(projectService.getProjectsForUser).mockResolvedValueOnce(mockTasks as any);
      vi.mocked(activePosterService.generateActiveTasksPosterSvg).mockReturnValueOnce(mockSvg);

      const res = await app.request('/api/v2/poster/active?tiled=true');
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.totalCount).toBe(1);
      expect(Array.isArray(json.tiles)).toBe(true);
      expect(json.tiles.length).toBeGreaterThan(0);
    });

    it('returns JSON with tasks and SVG when ?format=json', async () => {
      vi.mocked(projectService.getProjectsForUser).mockResolvedValueOnce(mockTasks as any);
      vi.mocked(activePosterService.generateActiveTasksPosterSvg).mockReturnValueOnce(mockSvg);

      const res = await app.request('/api/v2/poster/active?format=json&categories=Solfit');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      const json = await res.json();
      expect(json).toEqual({
        categories: ['Solfit'],
        tasks: [mockTasks[0]],
        svg: mockSvg,
      });
    });
  });
});
