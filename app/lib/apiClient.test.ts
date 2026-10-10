import {
  addProjectUpdate,
  apiCall,
  ApiError,
  assignTask,
  claimTask,
  createEpic,
  createGoal,
  createOrganisation,
  deleteEpic,
  deleteGoal,
  deleteProjectUpdate,
  fetchCurrentUser,
  fetchOrganisationMembers,
  fetchOrganisations,
  findSimilarTasks,
  getActiveTasksPoster,
  getEpics,
  getGoals,
  getPosterSvgUrl,
  getProjectById,
  getProjects,
  getProjectUpdates,
  getWallOfDonePoster,
  inviteUser,
  mergeProjects,
  searchUsers,
  updateEpic,
  updateGoal,
} from './apiClient';

// Mock next-auth/react
jest.mock('next-auth/react', () => ({
  signIn: jest.fn(),
}));

describe('apiClient', () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.NEXT_PUBLIC_WORKER_API_BASE_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = 'http://example.com/api/v2';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = originalEnv;
  });

  describe('apiFetch and apiCall', () => {
    it('handles successful API calls with JSON output', async () => {
      const mockData = { id: '123', title: 'Test' };
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockData,
      } as any);

      const result = await apiCall<{ id: string; title: string }>('http://example.com/api');
      expect(result).toEqual(mockData);
    });

    it('throws when response is not ok', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      } as any);

      await expect(apiCall('http://example.com/api')).rejects.toThrow(
        'API error (400): Bad Request'
      );
    });

    it('surfaces the readable { error } message from a 403 response', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: 'You have view-only access to "Acme"' }),
      } as any);

      const promise = apiCall('http://example.com/api');
      await expect(promise).rejects.toThrow('You have view-only access to "Acme"');
      await expect(promise).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe('collaboration helpers', () => {
    it('fetchCurrentUser calls GET /users/me', async () => {
      const me = { id: 'u1', email: 'alex@example.com', name: 'Alex Morgan' };
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => me,
      } as any);

      await expect(fetchCurrentUser('test-token')).resolves.toEqual(me);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://example.com/api/v2/users/me',
        expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } })
      );
    });

    it('getProjectById resolves to null on 404', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: 'Not found' }),
      } as any);

      await expect(getProjectById('missing', 'test-token')).resolves.toBeNull();
    });
  });

  describe('similar-task lookup', () => {
    it('forwards a zero limit so the API can reject it rather than using the default', async () => {
      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        const invalid = new URL(url).searchParams.get('limit') === '0';
        return {
          ok: !invalid,
          status: invalid ? 400 : 200,
          text: async () => JSON.stringify({ error: 'limit must be between 1 and 10' }),
          json: async () => [],
        };
      });
      await expect(
        findSimilarTasks({ title: 'Fix the offer page', limit: 0 })
      ).rejects.toMatchObject({
        status: 400,
        message: 'limit must be between 1 and 10',
      });
    });

    it('omits an unspecified limit and preserves authentication and cancellation', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] });
      const controller = new AbortController();
      await findSimilarTasks(
        { title: '  Fix the offer page  ', projectId: 'acme-project' },
        'test-token',
        controller.signal
      );
      const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
      expect(new URL(url).searchParams.has('limit')).toBe(false);
      expect(new URL(url).searchParams.get('title')).toBe('Fix the offer page');
      expect(new URL(url).searchParams.get('projectId')).toBe('acme-project');
      expect(options.headers).toEqual({ Authorization: 'Bearer test-token' });
      expect(options.signal).toBe(controller.signal);
    });
  });

  describe('Goal API methods', () => {
    it('getGoals sends GET request with auth and optional type', async () => {
      const mockGoals = [{ id: 'g1', title: 'Aim 1', type: 'aim' }];
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockGoals,
      } as any);

      const res = await getGoals('aim', 'test-token');
      expect(res).toEqual(mockGoals);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/goals?type=aim'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });

    it('createGoal sends POST request', async () => {
      const newGoal = { id: 'g1', title: 'Aim 1', type: 'aim' as const };
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => newGoal,
      } as any);

      const res = await createGoal({ title: 'Aim 1', type: 'aim' }, 'test-token');
      expect(res).toEqual(newGoal);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/goals'),
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          },
          body: JSON.stringify({ title: 'Aim 1', type: 'aim' }),
        })
      );
    });

    it('updateGoal sends PUT request', async () => {
      const updated = { id: 'g1', title: 'Updated', type: 'aim' as const };
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => updated,
      } as any);

      const res = await updateGoal('g1', { title: 'Updated' }, 'test-token');
      expect(res).toEqual(updated);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/goals/g1'),
        expect.objectContaining({
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          },
          body: JSON.stringify({ title: 'Updated' }),
        })
      );
    });

    it('deleteGoal sends DELETE request', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ message: 'Deleted' }),
      } as any);

      const res = await deleteGoal('g1', 'test-token');
      expect(res).toEqual({ message: 'Deleted' });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/goals/g1'),
        expect.objectContaining({
          method: 'DELETE',
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });

    it('getPosterSvgUrl returns correct URL endpoint', () => {
      const url = getPosterSvgUrl();
      expect(url).toContain('/goals/poster.svg');
    });
  });

  describe('Epic API methods', () => {
    it('getEpics sends GET request with optional category', async () => {
      const mockEpics = [{ id: 'e1', title: 'Epic 1', category: 'Acme' }];
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockEpics,
      } as any);

      const res = await getEpics('Acme', 'test-token');
      expect(res).toEqual(mockEpics);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/epics?category=Acme'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });

    it('createEpic sends POST request', async () => {
      const newEpic = { id: 'e1', title: 'Epic 1', status: 'active' as const };
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => newEpic,
      } as any);

      const res = await createEpic({ title: 'Epic 1' }, 'test-token');
      expect(res).toEqual(newEpic);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/epics'),
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          },
          body: JSON.stringify({ title: 'Epic 1' }),
        })
      );
    });

    it('updateEpic sends PUT request', async () => {
      const updated = { id: 'e1', title: 'Epic Updated', status: 'completed' as const };
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => updated,
      } as any);

      const res = await updateEpic(
        'e1',
        { title: 'Epic Updated', status: 'completed' },
        'test-token'
      );
      expect(res).toEqual(updated);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/epics/e1'),
        expect.objectContaining({
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          },
          body: JSON.stringify({ title: 'Epic Updated', status: 'completed' }),
        })
      );
    });

    it('deleteEpic sends DELETE request', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ message: 'Deleted' }),
      } as any);

      const res = await deleteEpic('e1', 'test-token');
      expect(res).toEqual({ message: 'Deleted' });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/epics/e1'),
        expect.objectContaining({
          method: 'DELETE',
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });
  });

  describe('Project Update methods', () => {
    it('getProjectUpdates calls updates endpoint', async () => {
      const mockUpdates = [{ id: 'u1', note: 'test' }];
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockUpdates,
      } as any);

      const res = await getProjectUpdates('p1', 'token');
      expect(res).toEqual(mockUpdates);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/projects/p1/updates'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer token' },
        })
      );
    });

    it('addProjectUpdate sends POST request', async () => {
      const mockUpdate = { id: 'u1', note: 'new note' };
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockUpdate,
      } as any);

      const res = await addProjectUpdate('p1', { note: 'new note' }, 'token');
      expect(res).toEqual(mockUpdate);
    });

    it('deleteProjectUpdate sends DELETE request', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ message: 'Deleted' }),
      } as any);

      const res = await deleteProjectUpdate('p1', 'u1', 'token');
      expect(res).toEqual({ message: 'Deleted' });
    });

    it('getProjects sends GET request to /projects', async () => {
      const mockProjects = [{ id: 'p1', project: 'Project 1' }];
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockProjects,
      } as any);

      const res = await getProjects('token');
      expect(res).toEqual(mockProjects);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/projects'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer token' },
        })
      );
    });
  });

  describe('mergeProjects', () => {
    it('sends POST request to merge endpoint with auth token and sourceId', async () => {
      const mockMerged = { id: 'target-1', project: 'Target Task' };
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockMerged,
      } as any);

      const res = await mergeProjects('target-1', 'source-2', 'test-token');
      expect(res).toEqual(mockMerged);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/projects/target-1/merge'),
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          },
          body: JSON.stringify({ sourceId: 'source-2' }),
        })
      );
    });

    it('throws error when merge request fails', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Cannot merge a task into itself' }),
      } as any);

      await expect(mergeProjects('target-1', 'target-1')).rejects.toThrow(
        'Cannot merge a task into itself'
      );
    });
  });

  describe('Wall of Done Poster API methods', () => {
    it('getWallOfDonePoster fetches raw SVG text by default', async () => {
      const mockSvg = '<svg>Wall of Done</svg>';
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => mockSvg,
      } as any);

      const res = await getWallOfDonePoster({}, 'test-token');
      expect(res).toBe(mockSvg);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/poster/wall-of-done'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });

    it('getWallOfDonePoster fetches JSON when format is json', async () => {
      const mockData = { data: { totalCount: 10 }, svg: '<svg></svg>' };
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockData,
      } as any);

      const res = await getWallOfDonePoster({ format: 'json' }, 'test-token');
      expect(res).toEqual(mockData);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/poster/wall-of-done?format=json'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });

    it('getWallOfDonePoster fetches tiled A4 packages when tiled is true', async () => {
      const mockTiled = { totalCount: 10, tiles: [{ sheetIndex: 1, svg: '<svg></svg>' }] };
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockTiled,
      } as any);

      const res = await getWallOfDonePoster({ tiled: true }, 'test-token');
      expect(res).toEqual(mockTiled);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/poster/wall-of-done?tiled=true'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });

    it('getWallOfDonePoster passes categories in query param', async () => {
      const mockSvg = '<svg>Wall of Done Filtered</svg>';
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => mockSvg,
      } as any);

      const res = await getWallOfDonePoster(
        { categories: ['Acme', 'Workshop'], format: 'svg' },
        'test-token'
      );
      expect(res).toBe(mockSvg);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/poster/wall-of-done?format=svg&categories=Acme%2CWorkshop'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });

    it('throws error when getWallOfDonePoster fails', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      } as any);

      await expect(getWallOfDonePoster({}, 'test-token')).rejects.toThrow(
        'API error (500): Internal Server Error'
      );
    });
  });

  describe('Active Tasks Poster API methods', () => {
    it('getActiveTasksPoster fetches raw SVG text by default', async () => {
      const mockSvg = '<svg>Active Tasks</svg>';
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => mockSvg,
      } as any);

      const res = await getActiveTasksPoster({}, 'test-token');
      expect(res).toBe(mockSvg);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/poster/active'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });

    it('getActiveTasksPoster fetches JSON when format is json', async () => {
      const mockData = { categories: ['Acme'], tasks: [], svg: '<svg></svg>' };
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockData,
      } as any);

      const res = await getActiveTasksPoster(
        { categories: ['Acme'], format: 'json' },
        'test-token'
      );
      expect(res).toEqual(mockData);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/poster/active?format=json&categories=Acme'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });

    it('throws error when getActiveTasksPoster fails', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      } as any);

      await expect(getActiveTasksPoster({}, 'test-token')).rejects.toThrow(
        'API error (500): Internal Server Error'
      );
    });
  });

  describe('Organisations API methods', () => {
    it('fetchOrganisations sends GET request with auth header', async () => {
      const mockOrgs = [{ id: 'org-1', name: 'Acme', slug: 'acme', role: 'owner' }];
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockOrgs,
      } as any);

      const res = await fetchOrganisations('test-token');
      expect(res).toEqual(mockOrgs);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/organisations'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });

    it('createOrganisation sends POST request with name and slug', async () => {
      const mockOrg = { id: 'org-2', name: 'New Org', slug: 'new-org' };
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => mockOrg,
      } as any);

      const res = await createOrganisation({ name: 'New Org', slug: 'new-org' }, 'test-token');
      expect(res).toEqual(mockOrg);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/organisations'),
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          },
          body: JSON.stringify({ name: 'New Org', slug: 'new-org' }),
        })
      );
    });

    it('fetchOrganisationMembers sends GET request to /organisations/:id/members', async () => {
      const mockMembers = [
        { id: 'm-1', userId: 'u-1', userEmail: 'test@example.com', role: 'owner' },
      ];
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockMembers,
      } as any);

      const res = await fetchOrganisationMembers('org-1', 'test-token');
      expect(res).toEqual(mockMembers);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/organisations/org-1/members'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });

    it('searchUsers sends GET request with encoded query', async () => {
      const mockUsers = [{ id: 'u-1', name: 'Sarah', email: 'sarah@example.com', isMember: false }];
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockUsers,
      } as any);

      const res = await searchUsers('org-1', 'sar', 'test-token');
      expect(res).toEqual(mockUsers);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/organisations/org-1/users/search?q=sar'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });

    it('inviteUser sends POST request to /organisations/:id/invites', async () => {
      const mockInvite = {
        id: 'inv-1',
        email: 'sarah@example.com',
        role: 'member',
        token: 'tok-123',
      };
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => mockInvite,
      } as any);

      const res = await inviteUser(
        'org-1',
        { email: 'sarah@example.com', role: 'member' },
        'test-token'
      );
      expect(res).toEqual(mockInvite);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/organisations/org-1/invites'),
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          },
          body: JSON.stringify({ email: 'sarah@example.com', role: 'member' }),
        })
      );
    });

    it('claimTask sends POST request to /tasks/:id/claim', async () => {
      const mockTask = { id: 'task-1', title: 'Test Task', assigneeId: 'user-1' };
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockTask,
      } as any);

      const res = await claimTask('task-1', 'test-token');
      expect(res).toEqual(mockTask);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/tasks/task-1/claim'),
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          },
        })
      );
    });

    it('assignTask sends PUT request to /projects/:id with the assignee', async () => {
      const mockTask = { id: 'task-1', title: 'Test Task', assigneeId: 'user-2' };
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockTask,
      } as any);

      const res = await assignTask('task-1', 'user-2', 'test-token');
      expect(res).toEqual(mockTask);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/projects/task-1'),
        expect.objectContaining({
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          },
          body: JSON.stringify({ assigneeId: 'user-2' }),
        })
      );
    });
  });
});
