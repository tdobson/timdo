import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import epicsApp from '../routes/epics';
import * as epicService from '../services/epicService';

vi.mock('../services/epicService');

describe('Epics API Routes', () => {
  let app: Hono<any>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    // Simulate auth & db middleware
    app.use('*', async (c, next) => {
      c.set('userId', 'test-user-id');
      c.set('db', {} as any);
      await next();
    });
    app.route('/api/v2/epics', epicsApp);
  });

  describe('GET /api/v2/epics', () => {
    it('returns epics list with task stats for user', async () => {
      const mockEpics = [
        {
          id: 'epic-1',
          userId: 'test-user-id',
          title: 'Acme Solar Implementation',
          category: 'Acme Solar',
          status: 'active',
          totalTasks: 5,
          doneTasks: 3,
          progressPercentage: 60,
        },
      ];
      vi.mocked(epicService.getEpicsForUser).mockResolvedValueOnce(mockEpics as any);

      const res = await app.request('/api/v2/epics');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual(mockEpics);
      expect(epicService.getEpicsForUser).toHaveBeenCalledWith(
        expect.anything(),
        'test-user-id',
        undefined
      );
    });

    it('passes category filter query param', async () => {
      vi.mocked(epicService.getEpicsForUser).mockResolvedValueOnce([]);

      const res = await app.request('/api/v2/epics?category=Acme Solar');
      expect(res.status).toBe(200);
      expect(epicService.getEpicsForUser).toHaveBeenCalledWith(
        expect.anything(),
        'test-user-id',
        'Acme Solar'
      );
    });
  });

  describe('POST /api/v2/epics', () => {
    it('creates epic and returns 201', async () => {
      const newEpic = {
        id: 'epic-new',
        userId: 'test-user-id',
        title: 'New Epic Project',
        category: 'Acme Solar',
        status: 'active',
      };
      vi.mocked(epicService.createEpic).mockResolvedValueOnce(newEpic as any);

      const res = await app.request('/api/v2/epics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'New Epic Project',
          category: 'Acme Solar',
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data).toEqual(newEpic);
      expect(epicService.createEpic).toHaveBeenCalled();
    });

    it('returns 400 when validation fails', async () => {
      const res = await app.request('/api/v2/epics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // missing title
          category: 'Acme Solar',
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/v2/epics/:id', () => {
    it('updates epic and returns updated record', async () => {
      const updated = {
        id: 'epic-1',
        userId: 'test-user-id',
        title: 'Updated Epic Title',
        category: 'Acme Solar',
        status: 'completed' as const,
      };
      vi.mocked(epicService.updateEpic).mockResolvedValueOnce(updated as any);

      const res = await app.request('/api/v2/epics/epic-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Updated Epic Title',
          status: 'completed',
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual(updated);
      expect(epicService.updateEpic).toHaveBeenCalledWith(
        expect.anything(),
        'test-user-id',
        'epic-1',
        { title: 'Updated Epic Title', status: 'completed' }
      );
    });

    it('returns 404 if epic not found', async () => {
      vi.mocked(epicService.updateEpic).mockResolvedValueOnce(null as any);

      const res = await app.request('/api/v2/epics/non-existent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Updated Epic Title',
        }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/v2/epics/:id', () => {
    it('deletes epic and returns success message', async () => {
      vi.mocked(epicService.deleteEpic).mockResolvedValueOnce(true);

      const res = await app.request('/api/v2/epics/epic-1', {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ message: 'Epic deleted successfully' });
      expect(epicService.deleteEpic).toHaveBeenCalledWith(
        expect.anything(),
        'test-user-id',
        'epic-1'
      );
    });

    it('returns 404 if epic to delete was not found', async () => {
      vi.mocked(epicService.deleteEpic).mockResolvedValueOnce(false);

      const res = await app.request('/api/v2/epics/non-existent', {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
    });
  });
});
