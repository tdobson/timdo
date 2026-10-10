import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import organisationsApp from '../routes/organisations';
import { AccessError } from '../services/accessService';
import * as organisationService from '../services/organisationService';

vi.mock('../services/organisationService');

describe('Organisations API Routes', () => {
  let app: Hono<any>;
  const testUserId = 'test-user-id';

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    // Simulate auth & db middleware
    app.use('*', async (c, next) => {
      c.set('userId', testUserId);
      c.set('db', {} as any);
      await next();
    });
    app.route('/api/v2/organisations', organisationsApp);
    // Same mapping as the app-level onError in src/index.ts
    app.onError((err, c) => {
      if (err instanceof AccessError) {
        return c.json({ error: err.message }, err.status);
      }
      return c.json({ error: 'Internal Server Error' }, 500);
    });
  });

  const json = (body: unknown, method = 'POST') => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  describe('GET /api/v2/organisations', () => {
    it('returns organisations list for user', async () => {
      const mockOrgs = [
        {
          id: 'org-1',
          name: 'Personal Org',
          slug: 'personal-org',
          createdBy: testUserId,
          role: 'owner',
        },
      ];
      vi.mocked(organisationService.getUserOrganisations).mockResolvedValueOnce(mockOrgs as any);

      const res = await app.request('/api/v2/organisations');
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toEqual(mockOrgs);
      expect(organisationService.getUserOrganisations).toHaveBeenCalledWith(
        expect.anything(),
        testUserId
      );
    });
  });

  describe('POST /api/v2/organisations', () => {
    it('creates organisation and returns 201', async () => {
      const newOrg = {
        id: 'org-2',
        name: 'Northstar Workshop',
        slug: 'northstar-workshop',
        createdBy: testUserId,
        role: 'owner',
      };
      vi.mocked(organisationService.createOrganisation).mockResolvedValueOnce(newOrg as any);

      const res = await app.request('/api/v2/organisations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Northstar Workshop',
          slug: 'northstar-workshop',
        }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data).toEqual(newOrg);
      expect(organisationService.createOrganisation).toHaveBeenCalledWith(
        expect.anything(),
        testUserId,
        'Northstar Workshop',
        'northstar-workshop'
      );
    });

    it('returns 400 when organisation name is missing', async () => {
      const res = await app.request('/api/v2/organisations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'northstar-workshop',
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v2/organisations/:id', () => {
    it('returns organisation by ID if user has access', async () => {
      const mockOrg = {
        id: 'org-1',
        name: 'Northstar Workshop',
        slug: 'northstar-workshop',
        createdBy: testUserId,
        role: 'owner',
      };
      vi.mocked(organisationService.getOrganisationById).mockResolvedValueOnce(mockOrg as any);

      const res = await app.request('/api/v2/organisations/org-1');
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toEqual(mockOrg);
    });

    it('returns 404 if organisation not found or user is not a member', async () => {
      vi.mocked(organisationService.getOrganisationById).mockResolvedValueOnce(null);

      const res = await app.request('/api/v2/organisations/nonexistent-org');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v2/organisations/:id/members', () => {
    it('returns members list if user has access', async () => {
      vi.mocked(organisationService.getOrganisationById).mockResolvedValueOnce({
        id: 'org-1',
      } as any);
      const mockMembers = [
        {
          id: 'mem-1',
          orgId: 'org-1',
          userId: testUserId,
          role: 'owner',
          userName: 'Casey Example',
          userEmail: 'casey@example.test',
        },
      ];
      vi.mocked(organisationService.getOrganisationMembers).mockResolvedValueOnce(
        mockMembers as any
      );

      const res = await app.request('/api/v2/organisations/org-1/members');
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toEqual(mockMembers);
    });
  });

  describe('GET /api/v2/organisations/:id/users/search', () => {
    it('returns autocomplete user results', async () => {
      vi.mocked(organisationService.getOrganisationById).mockResolvedValueOnce({
        id: 'org-1',
      } as any);
      const searchResults = [
        {
          id: 'user-2',
          name: 'Taylor Example',
          email: 'taylor@example.test',
          isMember: false,
        },
      ];
      vi.mocked(organisationService.searchUsersForAutocomplete).mockResolvedValueOnce(
        searchResults as any
      );

      const res = await app.request('/api/v2/organisations/org-1/users/search?q=taylor');
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toEqual(searchResults);
      expect(organisationService.searchUsersForAutocomplete).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        'taylor',
        'org-1'
      );
    });
  });

  describe('POST /api/v2/organisations/:id/invites', () => {
    it('creates an invite for a new email and returns 201', async () => {
      const mockInvite = {
        status: 'invited' as const,
        id: 'invite-1',
        email: 'taylor@example.test',
        role: 'member' as const,
        token: 'invite-token-abc',
        expiresAt: new Date().toISOString(),
      };
      vi.mocked(organisationService.inviteMember).mockResolvedValueOnce(mockInvite);

      const res = await app.request(
        '/api/v2/organisations/org-1/invites',
        json({ email: 'taylor@example.test', role: 'member' })
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockInvite);
      expect(organisationService.inviteMember).toHaveBeenCalledWith(
        expect.anything(),
        testUserId,
        'org-1',
        'taylor@example.test',
        'member'
      );
    });

    it('returns 201 when an existing user is added straight away', async () => {
      const added = {
        status: 'added' as const,
        userId: 'user-2',
        name: 'Taylor Example',
        email: 'taylor@example.test',
        role: 'viewer' as const,
      };
      vi.mocked(organisationService.inviteMember).mockResolvedValueOnce(added);

      const res = await app.request(
        '/api/v2/organisations/org-1/invites',
        json({ email: 'taylor@example.test', role: 'viewer' })
      );
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(added);
    });

    it('returns 200 when they are already a member', async () => {
      const already = {
        status: 'already_member' as const,
        userId: 'user-2',
        email: 'taylor@example.test',
        role: 'member' as const,
      };
      vi.mocked(organisationService.inviteMember).mockResolvedValueOnce(already);

      const res = await app.request(
        '/api/v2/organisations/org-1/invites',
        json({ email: 'taylor@example.test' })
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(already);
      // role defaults to member
      expect(organisationService.inviteMember).toHaveBeenCalledWith(
        expect.anything(),
        testUserId,
        'org-1',
        'taylor@example.test',
        'member'
      );
    });

    it('returns 403 when user is not authorized to invite', async () => {
      vi.mocked(organisationService.inviteMember).mockRejectedValueOnce(
        new AccessError('You do not have permission to do that here')
      );

      const res = await app.request(
        '/api/v2/organisations/org-1/invites',
        json({ email: 'taylor@example.test', role: 'member' })
      );

      expect(res.status).toBe(403);
      const data = (await res.json()) as any;
      expect(data.error).toBe('You do not have permission to do that here');
    });

    it('returns 404 when the workspace is not visible', async () => {
      vi.mocked(organisationService.inviteMember).mockRejectedValueOnce(
        new AccessError('Workspace not found', 404)
      );
      const res = await app.request(
        '/api/v2/organisations/org-x/invites',
        json({ email: 'taylor@example.test' })
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Workspace not found' });
    });

    it('returns 400 for an invalid email or an owner role', async () => {
      expect(
        (await app.request('/api/v2/organisations/org-1/invites', json({ email: 'nope' }))).status
      ).toBe(400);
      expect(
        (
          await app.request(
            '/api/v2/organisations/org-1/invites',
            json({ email: 'taylor@example.test', role: 'owner' })
          )
        ).status
      ).toBe(400);
      expect(organisationService.inviteMember).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/v2/organisations/:id/invites/:inviteId', () => {
    it('revokes an invite, or 404s when it does not exist', async () => {
      vi.mocked(organisationService.revokeInvite).mockResolvedValueOnce(true);
      const ok = await app.request('/api/v2/organisations/org-1/invites/inv-1', {
        method: 'DELETE',
      });
      expect(ok.status).toBe(200);
      expect(organisationService.revokeInvite).toHaveBeenCalledWith(
        expect.anything(),
        testUserId,
        'org-1',
        'inv-1'
      );

      vi.mocked(organisationService.revokeInvite).mockResolvedValueOnce(false);
      const missing = await app.request('/api/v2/organisations/org-1/invites/inv-2', {
        method: 'DELETE',
      });
      expect(missing.status).toBe(404);
    });
  });

  describe('POST /api/v2/organisations/invites/accept', () => {
    it('accepts invite token and returns success', async () => {
      vi.mocked(organisationService.acceptInvite).mockResolvedValueOnce({
        success: true,
        orgId: 'org-1',
        role: 'member',
      } as any);

      const res = await app.request('/api/v2/organisations/invites/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'valid-token-123',
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.orgId).toBe('org-1');
      expect(organisationService.acceptInvite).toHaveBeenCalledWith(
        expect.anything(),
        testUserId,
        'valid-token-123'
      );
    });

    it('returns 400 when token is invalid or expired', async () => {
      vi.mocked(organisationService.acceptInvite).mockRejectedValueOnce(
        new Error('Invite has expired')
      );

      const res = await app.request('/api/v2/organisations/invites/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'expired-token',
        }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toBe('Invite has expired');
    });
  });

  describe('GET /api/v2/organisations/sharing', () => {
    it('returns the sharing overview for the caller', async () => {
      const overview = [{ id: 'org-1', members: [], projects: [], invites: [] }];
      vi.mocked(organisationService.getSharingOverview).mockResolvedValueOnce(overview as any);
      const res = await app.request('/api/v2/organisations/sharing');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(overview);
      expect(organisationService.getSharingOverview).toHaveBeenCalledWith(
        expect.anything(),
        testUserId
      );
      // Not routed to GET /:id
      expect(organisationService.getOrganisationById).not.toHaveBeenCalled();
    });
  });

  describe('members', () => {
    it('blocks member listing and user search for non-members', async () => {
      vi.mocked(organisationService.getOrganisationById)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      expect((await app.request('/api/v2/organisations/org-1/members')).status).toBe(404);
      expect((await app.request('/api/v2/organisations/org-1/users/search?q=sa')).status).toBe(404);
      expect(organisationService.getOrganisationMembers).not.toHaveBeenCalled();
      expect(organisationService.searchUsersForAutocomplete).not.toHaveBeenCalled();
    });

    it('changes a role', async () => {
      vi.mocked(organisationService.updateMemberRole).mockResolvedValueOnce({
        userId: 'user-2',
        role: 'viewer',
      } as any);
      const res = await app.request(
        '/api/v2/organisations/org-1/members/user-2',
        json({ role: 'viewer' }, 'PUT')
      );
      expect(res.status).toBe(200);
      expect(organisationService.updateMemberRole).toHaveBeenCalledWith(
        expect.anything(),
        testUserId,
        'org-1',
        'user-2',
        'viewer'
      );
    });

    it('maps role-change failures to 404 and 403', async () => {
      vi.mocked(organisationService.updateMemberRole).mockResolvedValueOnce(null);
      expect(
        (
          await app.request(
            '/api/v2/organisations/org-1/members/user-x',
            json({ role: 'member' }, 'PUT')
          )
        ).status
      ).toBe(404);

      vi.mocked(organisationService.updateMemberRole).mockRejectedValueOnce(
        new AccessError('A workspace needs at least one owner')
      );
      const res = await app.request(
        '/api/v2/organisations/org-1/members/user-1',
        json({ role: 'member' }, 'PUT')
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'A workspace needs at least one owner' });
    });

    it('removes a member, or 404s when they are not in the workspace', async () => {
      vi.mocked(organisationService.removeMember).mockResolvedValueOnce(true);
      expect(
        (await app.request('/api/v2/organisations/org-1/members/user-2', { method: 'DELETE' }))
          .status
      ).toBe(200);
      vi.mocked(organisationService.removeMember).mockResolvedValueOnce(false);
      expect(
        (await app.request('/api/v2/organisations/org-1/members/user-9', { method: 'DELETE' }))
          .status
      ).toBe(404);
    });
  });

  describe('workspace management', () => {
    it('renames and deletes, surfacing permission errors', async () => {
      vi.mocked(organisationService.renameOrganisation).mockResolvedValueOnce({
        id: 'org-1',
        name: 'New',
      } as any);
      const renamed = await app.request(
        '/api/v2/organisations/org-1',
        json({ name: 'New' }, 'PUT')
      );
      expect(renamed.status).toBe(200);

      vi.mocked(organisationService.deleteOrganisation).mockRejectedValueOnce(
        new AccessError('Your personal workspace cannot be deleted')
      );
      const del = await app.request('/api/v2/organisations/org-1', { method: 'DELETE' });
      expect(del.status).toBe(403);
    });

    it('turns unexpected errors into a 500', async () => {
      vi.mocked(organisationService.getUserOrganisations).mockRejectedValueOnce(new Error('boom'));
      const res = await app.request('/api/v2/organisations');
      expect(res.status).toBe(500);
    });
  });

  describe('projects', () => {
    it('adds a project and returns 201', async () => {
      vi.mocked(organisationService.addProject).mockResolvedValueOnce({ id: 'p-1' } as any);
      const res = await app.request(
        '/api/v2/organisations/org-1/projects',
        json({ name: 'Acme Solar', description: 'Roofing' })
      );
      expect(res.status).toBe(201);
      expect(organisationService.addProject).toHaveBeenCalledWith(
        expect.anything(),
        testUserId,
        'org-1',
        'Acme Solar',
        'Roofing'
      );
    });

    it('moves a project to another workspace', async () => {
      vi.mocked(organisationService.updateProjectContainer).mockResolvedValueOnce({
        id: 'p-1',
        orgId: 'org-2',
      } as any);
      const res = await app.request(
        '/api/v2/organisations/org-1/projects/p-1',
        json({ orgId: 'org-2' }, 'PUT')
      );
      expect(res.status).toBe(200);
      expect(organisationService.updateProjectContainer).toHaveBeenCalledWith(
        expect.anything(),
        testUserId,
        'org-1',
        'p-1',
        { orgId: 'org-2' }
      );
    });
  });
});
