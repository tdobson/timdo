/**
 * organisationService (workspaces, members, invites, projects) against real SQL
 * (node:sqlite + the live D1 schema).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AccessError } from '../services/accessService';
import { getActivity } from '../services/activityService';
import * as epicService from '../services/epicService';
import * as orgService from '../services/organisationService';
import { createTestDb, ROBIN, seedCollaboration, STRANGER, TIM } from './helpers/testDb';

describe('Organisation Service', () => {
  let db: any;
  let raw: any;

  beforeEach(() => {
    ({ db, raw } = createTestDb());
    seedCollaboration(raw);
  });

  const roleOf = (userId: string, orgId: string) =>
    raw
      .prepare('SELECT role FROM OrganisationMembers WHERE user_id = ? AND org_id = ?')
      .get(userId, orgId)?.role ?? null;

  describe('getUserOrganisations', () => {
    it('returns workspaces the user belongs to, personal first, with role and counts', async () => {
      raw.exec(`UPDATE Projects SET is_archived = 1 WHERE id = 'proj-md'`);
      const orgs = await orgService.getUserOrganisations(db, TIM);
      expect(orgs.map((o) => [o.id, o.role, o.isPersonal, o.memberCount, o.projectCount])).toEqual([
        ['org-tim', 'owner', true, 1, 1],
        ['org-md', 'owner', false, 2, 1],
      ]);

      const robins = await orgService.getUserOrganisations(db, ROBIN);
      expect(robins.map((o) => [o.name, o.role])).toEqual([['Northstar Workshop', 'member']]);
    });

    it('gets one workspace only for members', async () => {
      expect(await orgService.getOrganisationById(db, ROBIN, 'org-md')).toMatchObject({
        name: 'Northstar Workshop',
        role: 'member',
      });
      expect(await orgService.getOrganisationById(db, STRANGER, 'org-md')).toBeNull();
    });
  });

  describe('createOrganisation', () => {
    it('creates a shared workspace with the creator as owner', async () => {
      const org = await orgService.createOrganisation(db, ROBIN, '  Acme Corp ');
      expect(org).toMatchObject({
        name: 'Acme Corp',
        createdBy: ROBIN,
        isPersonal: false,
        role: 'owner',
        memberCount: 1,
        projectCount: 0,
      });
      expect(org.slug).toMatch(/^acme-corp-[0-9a-f]{6}$/);
      expect(roleOf(ROBIN, org.id)).toBe('owner');

      const [entry] = await getActivity(db, ROBIN, { orgId: org.id });
      expect(entry).toMatchObject({
        action: 'created',
        summary: 'Created the Acme Corp workspace',
      });
    });

    it('uses an explicit slug when given', async () => {
      const org = await orgService.createOrganisation(db, TIM, 'Northstar Labs', 'northstar-labs');
      expect(org.slug).toBe('northstar-labs');
    });
  });

  describe('rename and delete', () => {
    it('lets admins rename, not members', async () => {
      const renamed = await orgService.renameOrganisation(db, TIM, 'org-md', 'Mountain Workshop Ltd');
      expect(renamed?.name).toBe('Mountain Workshop Ltd');
      await expect(
        orgService.renameOrganisation(db, ROBIN, 'org-md', 'Mine now')
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        orgService.renameOrganisation(db, STRANGER, 'org-md', 'x')
      ).rejects.toMatchObject({ status: 404 });
    });

    it('only deletes empty, non-personal workspaces, and only for owners', async () => {
      const empty = await orgService.createOrganisation(db, TIM, 'Empty');
      await orgService.inviteMember(db, TIM, empty.id, 'jordan@example.test', 'member');

      await expect(orgService.deleteOrganisation(db, ROBIN, empty.id)).rejects.toBeInstanceOf(
        AccessError
      );
      await expect(orgService.deleteOrganisation(db, TIM, 'org-tim')).rejects.toThrow(/personal/);
      await expect(orgService.deleteOrganisation(db, TIM, 'org-md')).rejects.toThrow(/projects/);

      expect(await orgService.deleteOrganisation(db, TIM, empty.id)).toBe(true);
      expect(await orgService.getOrganisationById(db, TIM, empty.id)).toBeNull();
      expect(roleOf(ROBIN, empty.id)).toBeNull();
    });
  });

  describe('members and search', () => {
    it('lists members with names and emails, sorted by name', async () => {
      const members = await orgService.getOrganisationMembers(db, 'org-md');
      expect(members.map((m) => [m.userName, m.userEmail, m.role])).toEqual([
        ['Casey Example', 'casey@example.test', 'owner'],
        ['Jordan Example', 'jordan@example.test', 'member'],
      ]);
    });

    it('finds people you already work with, with a membership indicator', async () => {
      const byName = await orgService.searchUsersForAutocomplete(db, TIM, 'jor', 'org-md');
      expect(byName).toEqual([
        {
          id: ROBIN,
          name: 'Jordan Example',
          email: 'jordan@example.test',
          isMember: true,
          role: 'member',
        },
      ]);
      const fromPersonal = await orgService.searchUsersForAutocomplete(
        db,
        TIM,
        'example.test',
        'org-tim'
      );
      expect(fromPersonal.map((u) => [u.id, u.isMember]).sort()).toEqual([
        [ROBIN, false],
        [TIM, true],
      ]);
    });

    it('never lets anyone browse the user list: strangers only by exact email', async () => {
      expect(await orgService.searchUsersForAutocomplete(db, TIM, 'stranger', 'org-md')).toEqual(
        []
      );
      const exact = await orgService.searchUsersForAutocomplete(
        db,
        TIM,
        'Stranger@Example.com',
        'org-md'
      );
      expect(exact.map((u) => u.id)).toEqual([STRANGER]);
      // Jordan is only a member of org-md: he cannot search from it at all
      await expect(
        orgService.searchUsersForAutocomplete(db, ROBIN, 'tim', 'org-md')
      ).rejects.toBeInstanceOf(AccessError);
    });

    it('needs at least two characters', async () => {
      expect(await orgService.searchUsersForAutocomplete(db, TIM, ' e ', 'org-md')).toEqual([]);
    });
  });

  describe('inviteMember', () => {
    it('adds an existing user straight away, case-insensitively', async () => {
      const result = await orgService.inviteMember(
        db,
        TIM,
        'org-tim',
        ' Stranger@Example.com ',
        'viewer'
      );
      expect(result).toEqual({
        status: 'added',
        userId: STRANGER,
        name: 'Stranger',
        email: 'stranger@example.com',
        role: 'viewer',
      });
      expect(roleOf(STRANGER, 'org-tim')).toBe('viewer');
      const [entry] = await getActivity(db, TIM, { orgId: 'org-tim' });
      expect(entry).toMatchObject({
        action: 'member_added',
        summary: 'Added Stranger to Casey Example as viewer',
      });
    });

    it('reports existing members without changing their role', async () => {
      const result = await orgService.inviteMember(
        db,
        TIM,
        'org-md',
        'jordan@example.test',
        'viewer'
      );
      expect(result).toEqual({
        status: 'already_member',
        userId: ROBIN,
        email: 'jordan@example.test',
        role: 'member',
      });
      expect(roleOf(ROBIN, 'org-md')).toBe('member');
    });

    it('creates a 30-day invite token for unknown emails and replaces earlier ones', async () => {
      const first = await orgService.inviteMember(db, TIM, 'org-md', 'New@Example.com');
      expect(first.status).toBe('invited');
      if (first.status !== 'invited') {
        throw new Error('expected an invite');
      }
      expect(first).toMatchObject({ email: 'new@example.com', role: 'member' });
      expect(first.token).toBeTruthy();
      const days = (new Date(first.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThanOrEqual(30);

      const second = await orgService.inviteMember(db, TIM, 'org-md', 'new@example.com', 'viewer');
      const invites = await orgService.getOrganisationInvites(db, TIM, 'org-md');
      expect(invites).toHaveLength(1);
      expect(invites[0]).toMatchObject({
        id: (second as any).id,
        role: 'viewer',
        invitedBy: TIM,
      });
    });

    it('rejects invites from members (403) and outsiders (404)', async () => {
      await expect(
        orgService.inviteMember(db, ROBIN, 'org-md', 'x@example.com')
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        orgService.inviteMember(db, STRANGER, 'org-md', 'x@example.com')
      ).rejects.toMatchObject({ status: 404 });
    });

    it('lets only owners add admins', async () => {
      await orgService.updateMemberRole(db, TIM, 'org-md', ROBIN, 'admin');
      await expect(
        orgService.inviteMember(db, ROBIN, 'org-md', 'x@example.com', 'admin')
      ).rejects.toThrow(/Only owners/);
      expect(
        (await orgService.inviteMember(db, ROBIN, 'org-md', 'x@example.com', 'viewer')).status
      ).toBe('invited');
      expect(
        (await orgService.inviteMember(db, TIM, 'org-md', 'y@example.com', 'admin')).status
      ).toBe('invited');
    });

    it('lets managers list and revoke invites', async () => {
      const invite = await orgService.inviteMember(db, TIM, 'org-md', 'new@example.com');
      await expect(orgService.getOrganisationInvites(db, ROBIN, 'org-md')).rejects.toBeInstanceOf(
        AccessError
      );
      await expect(
        orgService.revokeInvite(db, ROBIN, 'org-md', (invite as any).id)
      ).rejects.toBeInstanceOf(AccessError);
      expect(await orgService.revokeInvite(db, TIM, 'org-tim', (invite as any).id)).toBe(false);
      expect(await orgService.revokeInvite(db, TIM, 'org-md', (invite as any).id)).toBe(true);
      expect(await orgService.getOrganisationInvites(db, TIM, 'org-md')).toEqual([]);
    });
  });

  describe('acceptInvite', () => {
    async function inviteNewPerson(role: 'admin' | 'member' | 'viewer' = 'member') {
      const invite = await orgService.inviteMember(db, TIM, 'org-md', 'new@example.com', role);
      raw.exec(
        `INSERT INTO Users (id, email, name) VALUES ('user-new', 'new@example.com', 'New Person')`
      );
      return invite as Extract<orgService.InviteResult, { status: 'invited' }>;
    }

    it('adds the user with the invited role and marks the invite used', async () => {
      const invite = await inviteNewPerson('viewer');
      const result = await orgService.acceptInvite(db, 'user-new', invite.token);
      expect(result).toEqual({ success: true, orgId: 'org-md', role: 'viewer' });
      expect(roleOf('user-new', 'org-md')).toBe('viewer');
      expect(await orgService.getOrganisationInvites(db, TIM, 'org-md')).toEqual([]);

      const entry = (await getActivity(db, TIM, { orgId: 'org-md' })).find(
        (a) => a.action === 'member_joined'
      );
      expect(entry).toMatchObject({
        actorName: 'New Person',
        summary: 'Joined Northstar Workshop as viewer',
      });

      // Accepting again (e.g. the link opened after sign-in claimed it) is a harmless no-op
      await expect(orgService.acceptInvite(db, 'user-new', invite.token)).resolves.toEqual({
        success: true,
        orgId: 'org-md',
        role: 'viewer',
      });
      expect(
        (await getActivity(db, TIM, { orgId: 'org-md' })).filter(
          (a) => a.action === 'member_joined'
        )
      ).toHaveLength(1);
    });

    it("keeps an existing member's role and still consumes the invite", async () => {
      const invite = await orgService.inviteMember(
        db,
        TIM,
        'org-md',
        'someone@example.com',
        'viewer'
      );
      const result = await orgService.acceptInvite(db, ROBIN, (invite as any).token);
      expect(result).toEqual({ success: true, orgId: 'org-md', role: 'member' });
      expect(roleOf(ROBIN, 'org-md')).toBe('member');
      expect(await orgService.getOrganisationInvites(db, TIM, 'org-md')).toEqual([]);
    });

    it('throws if the token is expired or unknown', async () => {
      const invite = await inviteNewPerson();
      raw.exec(`UPDATE OrganisationInvites SET expires_at = '2020-01-01T00:00:00.000Z'`);
      await expect(orgService.acceptInvite(db, 'user-new', invite.token)).rejects.toThrow(
        /expired/
      );
      expect(roleOf('user-new', 'org-md')).toBeNull();
      await expect(orgService.acceptInvite(db, 'user-new', 'nope')).rejects.toThrow(/invalid/);
    });

    it('claims unexpired invites on sign-in and skips expired ones', async () => {
      const other = await orgService.createOrganisation(db, TIM, 'Old');
      await orgService.inviteMember(db, TIM, other.id, 'new@example.com');
      await inviteNewPerson();
      raw.exec(
        `UPDATE OrganisationInvites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE org_id = '${other.id}'`
      );

      expect(await orgService.claimPendingInvites(db, 'user-new', 'NEW@example.com')).toBe(2);
      const orgs = await orgService.getUserOrganisations(db, 'user-new');
      expect(orgs.map((o) => o.name)).toEqual(['Northstar Workshop']);
    });
  });

  describe('updateMemberRole', () => {
    it('lets owners promote and logs the change', async () => {
      const updated = await orgService.updateMemberRole(db, TIM, 'org-md', ROBIN, 'admin');
      expect(updated).toMatchObject({ userId: ROBIN, role: 'admin' });
      const [entry] = await getActivity(db, ROBIN, { orgId: 'org-md' });
      expect(entry).toMatchObject({
        action: 'role_changed',
        summary: "Changed Jordan Example's role from member to admin",
      });
    });

    it('lets admins change members and viewers but not owners or admins', async () => {
      await orgService.inviteMember(db, TIM, 'org-md', 'stranger@example.com', 'member');
      await orgService.updateMemberRole(db, TIM, 'org-md', ROBIN, 'admin');

      expect(
        (await orgService.updateMemberRole(db, ROBIN, 'org-md', STRANGER, 'viewer'))?.role
      ).toBe('viewer');
      await expect(
        orgService.updateMemberRole(db, ROBIN, 'org-md', STRANGER, 'admin')
      ).rejects.toThrow(/Only owners/);
      await expect(
        orgService.updateMemberRole(db, ROBIN, 'org-md', TIM, 'member')
      ).rejects.toThrow(/Only owners/);
    });

    it('stops members changing roles and protects the last owner', async () => {
      await expect(
        orgService.updateMemberRole(db, ROBIN, 'org-md', ROBIN, 'owner')
      ).rejects.toMatchObject({ status: 403 });
      await expect(orgService.updateMemberRole(db, TIM, 'org-md', TIM, 'admin')).rejects.toThrow(
        /at least one owner/
      );

      await orgService.updateMemberRole(db, TIM, 'org-md', ROBIN, 'owner');
      expect((await orgService.updateMemberRole(db, TIM, 'org-md', TIM, 'admin'))?.role).toBe(
        'admin'
      );
    });

    it('returns null for someone who is not in the workspace', async () => {
      expect(await orgService.updateMemberRole(db, TIM, 'org-md', STRANGER, 'viewer')).toBeNull();
    });
  });

  describe('removeMember', () => {
    it('lets owners remove members and logs it', async () => {
      expect(await orgService.removeMember(db, TIM, 'org-md', ROBIN)).toBe(true);
      expect(roleOf(ROBIN, 'org-md')).toBeNull();
      const [entry] = await getActivity(db, TIM, { orgId: 'org-md' });
      expect(entry).toMatchObject({
        action: 'member_removed',
        summary: 'Removed Jordan Example from Northstar Workshop',
      });
      expect(await orgService.removeMember(db, TIM, 'org-md', ROBIN)).toBe(false);
    });

    it('stops members removing others and admins removing owners', async () => {
      await orgService.inviteMember(db, TIM, 'org-md', 'stranger@example.com', 'member');
      await expect(orgService.removeMember(db, ROBIN, 'org-md', STRANGER)).rejects.toMatchObject({
        status: 403,
      });
      await orgService.updateMemberRole(db, TIM, 'org-md', ROBIN, 'admin');
      await expect(orgService.removeMember(db, ROBIN, 'org-md', TIM)).rejects.toThrow(
        /Only owners/
      );
      expect(await orgService.removeMember(db, ROBIN, 'org-md', STRANGER)).toBe(true);
    });

    it('lets people leave, except the last owner and personal-workspace owners', async () => {
      await expect(orgService.removeMember(db, TIM, 'org-md', TIM)).rejects.toThrow(
        /at least one owner/
      );
      await expect(orgService.removeMember(db, TIM, 'org-tim', TIM)).rejects.toThrow(/personal/);
      expect(await orgService.removeMember(db, ROBIN, 'org-md', ROBIN)).toBe(true);
      const [entry] = await getActivity(db, TIM, { orgId: 'org-md' });
      expect(entry).toMatchObject({ action: 'member_left', summary: 'Left Northstar Workshop' });
    });
  });

  describe('projects in workspaces', () => {
    it('lists projects with task and epic counts, for members only', async () => {
      raw.exec(`
        INSERT INTO Tasks (id, project_id, reporter_id, title, status, is_deleted) VALUES
          ('t1', 'proj-acme-solar', '${TIM}', 'Open', 'do', 0),
          ('t2', 'proj-acme-solar', '${TIM}', 'Done', 'done', 0),
          ('t3', 'proj-acme-solar', '${TIM}', 'Gone', 'do', 1);
      `);
      await epicService.createEpic(db, TIM, { title: 'E', category: 'Acme Solar' });
      const projects = await orgService.getOrganisationProjects(db, ROBIN, 'org-md');
      expect(
        projects.map((p) => [p.name, Number(p.openTasks), Number(p.doneTasks), Number(p.epicCount)])
      ).toEqual([
        ['Acme Solar', 1, 1, 1],
        ['Northstar Workshop', 0, 0, 0],
      ]);
      await expect(
        orgService.getOrganisationProjects(db, STRANGER, 'org-md')
      ).rejects.toMatchObject({
        status: 404,
      });
    });

    it('adds a project, refusing duplicate names in the same workspace', async () => {
      const project = await orgService.addProject(db, TIM, 'org-md', ' Northstar Labs ', 'Client work');
      expect(project).toMatchObject({
        orgId: 'org-md',
        name: 'Northstar Labs',
        description: 'Client work',
        leadUserId: TIM,
      });
      await expect(orgService.addProject(db, TIM, 'org-md', 'acme solar')).rejects.toThrow(
        /already a project/
      );
      // Same name in another workspace is fine
      expect((await orgService.addProject(db, TIM, 'org-tim', 'Acme Solar')).orgId).toBe('org-tim');
      const [entry] = await getActivity(db, ROBIN, { projectId: project.id });
      expect(entry).toMatchObject({ action: 'created', summary: 'Created the Northstar Labs project' });
    });

    it('does not let viewers add projects', async () => {
      await orgService.updateMemberRole(db, TIM, 'org-md', ROBIN, 'viewer');
      await expect(orgService.addProject(db, ROBIN, 'org-md', 'New')).rejects.toBeInstanceOf(
        AccessError
      );
    });

    // Membership is checked before the name clash, so outsiders learn nothing.
    it('tells outsiders nothing about project names in a workspace', async () => {
      await expect(orgService.addProject(db, STRANGER, 'org-md', 'Acme Solar')).rejects.toThrow(
        /cannot add projects|not found/i
      );
    });

    it('limits adding projects to owners and admins, as documented', async () => {
      await expect(orgService.addProject(db, ROBIN, 'org-md', 'New')).rejects.toBeInstanceOf(
        AccessError
      );
    });

    it("renames a project and keeps its epics' category in step", async () => {
      const epic = await epicService.createEpic(db, TIM, { title: 'E', category: 'Acme Solar' });
      const renamed = await orgService.updateProjectContainer(db, TIM, 'org-md', 'proj-acme-solar', {
        name: 'Acme Solar Ltd',
        description: 'Roofing',
      });
      expect(renamed).toMatchObject({ name: 'Acme Solar Ltd', description: 'Roofing' });
      const row = raw.prepare('SELECT category FROM Epics WHERE id = ?').get(epic!.id);
      expect(row.category).toBe('Acme Solar Ltd');
      const entry = (await getActivity(db, TIM, { projectId: 'proj-acme-solar' })).find(
        (a) => a.action === 'renamed'
      );
      expect(entry?.summary).toBe('Renamed the Acme Solar project to Acme Solar Ltd');
    });

    it('archives and unarchives, logging each change once', async () => {
      await orgService.updateProjectContainer(db, TIM, 'org-md', 'proj-acme-solar', {
        isArchived: true,
      });
      await orgService.updateProjectContainer(db, TIM, 'org-md', 'proj-acme-solar', {
        isArchived: true,
      });
      const archived = await orgService.updateProjectContainer(db, TIM, 'org-md', 'proj-acme-solar', {
        isArchived: false,
      });
      expect(archived?.isArchived).toBe(false);
      const actions = (await getActivity(db, TIM, { projectId: 'proj-acme-solar' })).map(
        (a) => a.action
      );
      expect(actions.sort()).toEqual(['archived', 'unarchived']);
    });

    it('refuses project changes from members and for projects in another workspace', async () => {
      await expect(
        orgService.updateProjectContainer(db, ROBIN, 'org-md', 'proj-acme-solar', { name: 'x' })
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        orgService.updateProjectContainer(db, TIM, 'org-md', 'proj-personal', { name: 'x' })
      ).rejects.toMatchObject({ status: 404 });
    });

    it('refuses to move a project into a workspace that already has that name', async () => {
      await orgService.addProject(db, TIM, 'org-tim', 'Acme Solar');
      await expect(
        orgService.updateProjectContainer(db, TIM, 'org-md', 'proj-acme-solar', { orgId: 'org-tim' })
      ).rejects.toThrow(/already has a project/);
    });

    it('refuses renaming a project to a name already used in its workspace', async () => {
      await expect(
        orgService.updateProjectContainer(db, TIM, 'org-md', 'proj-acme-solar', {
          name: 'northstar workshop',
        })
      ).rejects.toThrow(/already/);
    });
  });

  describe('getSharingOverview', () => {
    it('shows pending invites only to people who manage the workspace', async () => {
      await orgService.inviteMember(db, TIM, 'org-md', 'new@example.com');
      const tims = await orgService.getSharingOverview(db, TIM);
      expect(tims.map((o) => o.name)).toEqual(['Casey Example', 'Northstar Workshop']);
      expect(tims[1].invites.map((i) => i.email)).toEqual(['new@example.com']);
      expect(tims[1].projects.every((p) => typeof p.isArchived === 'boolean')).toBe(true);

      const robins = await orgService.getSharingOverview(db, ROBIN);
      expect(robins[0].invites).toEqual([]);
      expect(robins[0].members.find((m) => m.isMe)?.userId).toBe(ROBIN);
    });
  });
});
